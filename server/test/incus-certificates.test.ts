import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('developer-managed Incus certificate files', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let certs: typeof import('../src/incus/certs.ts');
  let incus: typeof import('../src/incus/index.ts');
  let gateway: typeof import('../src/services/gateway.ts');
  let directory: string;
  let certificatePath: string;
  let privateKeyPath: string;
  let adminCookie: string;
  let userCookie: string;
  let httpd: Server;
  let endpoint: string;
  let node: import('../src/lib/prisma.ts').Node;
  let first: { cert: string; key: string };
  let second: { cert: string; key: string };
  let expired: { cert: string; key: string };
  let future: { cert: string; key: string };
  let serverOnly: { cert: string; key: string };
  const seen: Array<{ path: string; cn: string }> = [];
  const legacy = { cert: 'legacy-database-certificate-must-not-be-used', key: 'legacy-key-must-not-be-used' };
  const request = (method: 'GET' | 'POST', url: string, cookie = adminCookie, payload?: object) => app.inject({ method, url, payload, headers: { cookie, 'x-requested-with': 'XMLHttpRequest' } });
  const deploy = async (pair = first) => {
    await writeFile(certificatePath, pair.cert);
    await writeFile(privateKeyPath, pair.key, { mode: 0o600 });
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-certificate-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://',
      APP_SECRET: 'test-certificate-files-secret-12345', LOG_LEVEL: 'error', COOKIE_SECURE: 'false',
      INCUS_CERT_DIR: resolve(directory, 'certificates'),
    });
    await mkdir(process.env.INCUS_CERT_DIR!, { recursive: true });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    await db.setting.create({ data: { key: 'incus.clientCertificate', value: legacy } });
    const password = 'certificate-test-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const role of ['ADMIN', 'USER'] as const) await db.user.create({ data: { username: role.toLowerCase(), email: `${role.toLowerCase()}@example.test`, role, passwordHash: hash, emailVerifiedAt: new Date() } });
    app = await (await import('../src/app.ts')).buildApp();
    for (const role of ['ADMIN', 'USER']) {
      const login = await request('POST', '/api/auth/login', '', { account: role, password });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
      if (role === 'ADMIN') adminCookie = cookie;
      else userCookie = cookie;
    }
    certs = await import('../src/incus/certs.ts');
    incus = await import('../src/incus/index.ts');
    gateway = await import('../src/services/gateway.ts');
    ({ certificatePath, privateKeyPath } = certs.getClientCertificatePaths());
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const issue = (cn: string, options: { future?: boolean; expired?: boolean; serverOnly?: boolean } = {}) => {
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = '01';
      cert.validity.notBefore = new Date(Date.now() + (options.future ? 60_000 : -3600_000));
      cert.validity.notAfter = new Date(Date.now() + (options.expired ? -60_000 : 86400_000));
      cert.setSubject([{ name: 'commonName', value: cn }]);
      cert.setIssuer([{ name: 'commonName', value: cn }]);
      cert.setExtensions([{ name: 'extKeyUsage', clientAuth: !options.serverOnly, serverAuth: true }]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
    };
    first = issue('developer-panel-one');
    second = issue('developer-panel-two');
    expired = issue('expired', { expired: true });
    future = issue('future', { future: true });
    serverOnly = issue('server-only', { serverOnly: true });
    const serverPair = issue('local-incus-test');
    httpd = createServer({ cert: serverPair.cert, key: serverPair.key, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
      seen.push({ path: req.url!, cn: String(peer.subject?.CN ?? '') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/1.0' ? JSON.stringify({ type: 'sync', status: 'Success', status_code: 200, metadata: { auth: 'trusted', api_extensions: [] } }) : '{}');
    });
    await new Promise<void>((resolve) => httpd.listen(0, '127.0.0.1', resolve));
    const port = (httpd.address() as AddressInfo).port;
    endpoint = `https://127.0.0.1:${port}`;
    node = await db.node.create({ data: {
      name: 'Local certificate test', region: 'Test', endpoint, publicIp: '127.0.0.1',
      serverFingerprint: new X509Certificate(serverPair.cert).fingerprint256.replace(/:/g, '').toLowerCase(),
      caddyCaCert: serverPair.cert, caddyAdminPort: port,
    } });
  }, 90_000);

  beforeEach(async () => {
    for (const path of [certificatePath, privateKeyPath]) {
      try { await unlink(path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    incus?.invalidateAllIncus();
    gateway?.resetCaddyClients();
    if (httpd) { httpd.closeAllConnections(); await new Promise<void>((resolve) => httpd.close(() => resolve())); }
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-certificate-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('reports missing local files without generating files or falling back to the database', async () => {
    await expect(certs.getClientCertificate()).rejects.toMatchObject({ statusCode: 503, code: 'INCUS_CERTIFICATE_UNAVAILABLE' });
    const result = await request('GET', '/api/admin/certificate');
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.json()).toMatchObject({ certificatePath, privateKeyPath, certificate: null });
    expect(result.json().error).toContain(process.env.INCUS_CERT_DIR);
    expect(await readdir(process.env.INCUS_CERT_DIR!)).toEqual([]);
    expect((await db.setting.findUniqueOrThrow({ where: { key: 'incus.clientCertificate' } })).value).toEqual(legacy);
    expect(await db.setting.count({ where: { key: { startsWith: 'incus.' } } })).toBe(1);
  });

  it('loads developer files without rewriting them or exposing the private key', async () => {
    await deploy();
    const loaded = await certs.getClientCertificate();
    expect(loaded.fingerprint).toBe(new X509Certificate(first.cert).fingerprint256.replace(/:/g, '').toLowerCase());
    const result = await request('GET', '/api/admin/certificate');
    expect(result.json()).toMatchObject({ certificatePath, privateKeyPath, error: null, certificate: { fingerprint: loaded.fingerprint, subject: 'CN=developer-panel-one' } });
    expect(result.body).not.toMatch(/BEGIN (?:RSA )?PRIVATE KEY|legacy-key/);
    expect(await readFile(certificatePath, 'utf8')).toBe(first.cert);
    expect((await readFile(privateKeyPath, 'utf8')) === first.key).toBe(true);
    expect((await db.setting.findUniqueOrThrow({ where: { key: 'incus.clientCertificate' } })).value).toEqual(legacy);
  });

  it('rejects invalid certificates and invalid or mismatched private keys', async () => {
    await deploy({ cert: 'invalid certificate', key: first.key });
    await expect(certs.getClientCertificate()).rejects.toThrow(/无法解析证书/);
    await deploy({ cert: first.cert, key: 'invalid private key' });
    await expect(certs.getClientCertificate()).rejects.toThrow(/无法解析私钥/);
    const differentKeys = forge.pki.rsa.generateKeyPair(2048);
    await deploy({ cert: first.cert, key: forge.pki.privateKeyToPem(differentKeys.privateKey) });
    await expect(certs.getClientCertificate()).rejects.toThrow(/不匹配/);
  });

  it('rejects expired, future and server-only certificates', async () => {
    for (const [pair, message] of [[expired, /已过期/], [future, /尚未生效/], [serverOnly, /clientAuth/]] as const) {
      await deploy(pair);
      await expect(certs.getClientCertificate()).rejects.toThrow(message);
    }
  });

  it('rechecks cached validity and never keeps using a removed private key', async () => {
    await deploy();
    await certs.getClientCertificate();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(new Date(new X509Certificate(first.cert).validTo).getTime() + 1);
    try { await expect(certs.getClientCertificate()).rejects.toThrow(/已过期/); } finally { clock.mockRestore(); }
    await unlink(privateKeyPath);
    await expect(certs.getClientCertificate()).rejects.toMatchObject({ code: 'INCUS_CERTIFICATE_UNAVAILABLE' });
    const status = await request('GET', '/api/admin/certificate');
    expect(status.json()).toMatchObject({ certificate: null, error: expect.stringContaining(privateKeyPath) });
  });

  it('rebuilds cached Incus and Caddy connections when files are replaced', async () => {
    await deploy();
    const initial = await incus.getIncus(node);
    await initial.getServer();
    await gateway.testCaddy(node);
    expect(seen.slice(-2)).toEqual([{ path: '/1.0', cn: 'developer-panel-one' }, { path: '/config/', cn: 'developer-panel-one' }]);
    expect(await incus.getIncus(node)).toBe(initial);
    await deploy(second);
    const replacement = await incus.getIncus(node);
    expect(replacement).not.toBe(initial);
    await replacement.getServer();
    await gateway.testCaddy(node);
    expect(seen.slice(-2)).toEqual([{ path: '/1.0', cn: 'developer-panel-two' }, { path: '/config/', cn: 'developer-panel-two' }]);
    await unlink(privateKeyPath);
    await expect(incus.getIncus(node)).rejects.toMatchObject({ code: 'INCUS_CERTIFICATE_UNAVAILABLE' });
  });

  it('requires admin access and removes certificate upload and private-key export endpoints', async () => {
    expect((await request('GET', '/api/admin/certificate', '')).statusCode).toBe(401);
    expect((await request('GET', '/api/admin/certificate', userCookie)).statusCode).toBe(403);
    expect((await request('POST', '/api/admin/certificate', adminCookie, { certificate: 'test', privateKey: 'test' })).statusCode).toBe(404);
    expect((await request('POST', '/api/admin/certificate/export', adminCookie, { password: 'test' })).statusCode).toBe(404);
    expect(await readdir(process.env.INCUS_CERT_DIR!)).toEqual([]);
  });

  it('keeps mock nodes usable without local certificate files', async () => {
    const client = await incus.getIncus({ id: 999999, endpoint: 'mock://certificate-test', project: 'default', serverFingerprint: null });
    expect((await client.getServer()).auth).toBe('trusted');
    expect(await readdir(process.env.INCUS_CERT_DIR!)).toEqual([]);
  });
});

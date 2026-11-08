import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import forge from 'node-forge';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('Caddy admin TLS verification and registration retries', () => {
  let directory: string;
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let gateway: typeof import('../src/services/gateway.ts');
  let httpd: Server;
  let port: number;
  let serial = 0;
  let node: import('../src/lib/prisma.ts').Node;
  let token: string;
  let panelCa: string;
  let failLoad = false;
  let loads: unknown[] = [];
  const pairs: Record<string, { cert: string; key: string; root: string }> = {};
  let active: (typeof pairs)[string];

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-caddy-tls-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://',
      APP_SECRET: 'isolated-caddy-tls-test-secret', LOG_LEVEL: 'error', INCUS_CERT_DIR: resolve(directory, 'certificates'),
    });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    gateway = await import('../src/services/gateway.ts');
    app = await (await import('../src/app.ts')).buildApp();

    const keys = forge.pki.rsa.generateKeyPair(2048);
    let certificateSerial = 0;
    const issue = (cn: string, options: { issuer?: forge.pki.Certificate; ca?: boolean; expired?: boolean; future?: boolean } = {}) => {
      const certificate = forge.pki.createCertificate();
      certificate.publicKey = keys.publicKey;
      certificate.serialNumber = (++certificateSerial).toString(16).padStart(2, '0');
      certificate.validity.notBefore = new Date(Date.now() + (options.future ? 3600_000 : -7200_000));
      certificate.validity.notAfter = new Date(Date.now() + (options.expired ? -3600_000 : 86400_000));
      certificate.setSubject([{ name: 'commonName', value: cn }]);
      certificate.setIssuer(options.issuer?.subject.attributes ?? certificate.subject.attributes);
      certificate.setExtensions([
        { name: 'basicConstraints', cA: !!options.ca },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: !!options.ca },
        { name: 'extKeyUsage', clientAuth: true, serverAuth: true },
      ]);
      certificate.sign(keys.privateKey, forge.md.sha256.create());
      return certificate;
    };
    const panel = forge.pki.certificateToPem(issue('developer-panel', { ca: true }));
    panelCa = panel;
    const key = forge.pki.privateKeyToPem(keys.privateKey);
    await mkdir(process.env.INCUS_CERT_DIR!, { recursive: true });
    await writeFile(resolve(process.env.INCUS_CERT_DIR!, 'client.crt'), panel);
    await writeFile(resolve(process.env.INCUS_CERT_DIR!, 'client.key'), key, { mode: 0o600 });
    for (const name of ['valid', 'renewed', 'expired', 'future', 'expired-root']) {
      const root = issue(`root-${name}`, { ca: true, expired: name === 'expired-root' });
      const leaf = issue(`server-${name}`, { issuer: root, expired: name === 'expired', future: name === 'future' });
      pairs[name] = { cert: forge.pki.certificateToPem(leaf), root: forge.pki.certificateToPem(root), key };
    }
    active = pairs.valid;
    httpd = createServer({ ...active, ca: panel, requestCert: true, rejectUnauthorized: true }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (req.url === '/load') loads.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(req.url === '/load' && failLoad ? 500 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/pki/ca/local' ? { root_certificate: active.root } : failLoad ? { error: 'simulated load failure' } : {}));
      });
    });
    await new Promise<void>((resolve) => httpd.listen(0, '127.0.0.1', resolve));
    port = (httpd.address() as AddressInfo).port;
  }, 90_000);

  const use = (name: string) => {
    gateway.resetCaddyClients();
    httpd.closeAllConnections();
    active = pairs[name];
    httpd.setSecureContext({ ...active, ca: panelCa });
  };

  beforeEach(async () => {
    loads = [];
    failLoad = false;
    use('valid');
    node = await db.node.create({ data: {
      name: `caddy-tls-${++serial}`, region: 'Test', endpoint: `https://127.0.0.1:${port}`,
      publicIp: '127.0.0.1', caddyCaCert: active.root, caddyAdminPort: port,
    } });
    ({ token } = await gateway.issueCaddyToken(node.id));
  });

  afterAll(async () => {
    gateway?.resetCaddyClients();
    if (httpd) { httpd.closeAllConnections(); await new Promise<void>((resolve) => httpd.close(() => resolve())); }
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-caddy-tls-test-')) rmSync(directory, { recursive: true, force: true });
  });

  const register = () => app.inject({
    method: 'POST', url: '/api/agent/caddy/register', payload: { token, rootCert: active.root, port, version: 'v2.test' },
  });
  const stored = () => db.node.findUniqueOrThrow({ where: { id: node.id } });

  it.each(['expired', 'expired-root'])('rejects %s certificates with a recovery message and retains the installation token', async (name) => {
    use(name);
    const result = await register();
    expect(result.json()).toMatchObject({ ok: false, message: expect.stringContaining('服务端证书链已过期') });
    expect(result.json().message).toContain('系统时间');
    expect(await stored()).toMatchObject({ caddyStatus: 'ERROR', caddyTokenHash: expect.any(String) });
    expect((await gateway.nodeByCaddyToken(token)).id).toBe(node.id);
    expect(loads).toHaveLength(0);
  });

  it('reports a server certificate that is not valid yet without accepting it', async () => {
    use('future');
    expect((await register()).json()).toMatchObject({ ok: false, message: expect.stringContaining('尚未生效') });
    expect(loads).toHaveLength(0);
  });

  it('still rejects a server signed by an untrusted CA', async () => {
    use('renewed');
    await expect(gateway.testCaddy(node)).rejects.toThrow(/无法连接 Caddy/);
    expect(await stored()).toMatchObject({ caddyStatus: 'ERROR' });
  });

  it('retries the same token after certificate renewal, synchronizes sites, and then consumes it', async () => {
    use('expired');
    expect((await register()).json().ok).toBe(false);
    use('renewed');
    expect((await register()).json()).toMatchObject({ ok: true });
    expect(await stored()).toMatchObject({ caddyStatus: 'READY', caddyError: null, caddyCaCert: active.root.trim(), caddyTokenHash: null });
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ admin: { remote: { listen: `:${port}` } }, apps: {} });
    await expect(gateway.nodeByCaddyToken(token)).rejects.toThrow();
  });

  it('retains the token until the initial site configuration is successfully loaded', async () => {
    failLoad = true;
    expect((await register()).json()).toMatchObject({ ok: false, message: expect.stringContaining('simulated load failure') });
    expect((await gateway.nodeByCaddyToken(token)).id).toBe(node.id);
    failLoad = false;
    expect((await register()).json().ok).toBe(true);
    expect((await stored()).caddyTokenHash).toBeNull();
    expect(loads).toHaveLength(2);
  });

  it('validates expiry even when discovering the CA on a first connection', async () => {
    use('expired');
    await expect(gateway.testCaddy({ ...node, caddyCaCert: null })).rejects.toThrow(/服务端证书链已过期/);
    expect((await gateway.nodeByCaddyToken(token)).id).toBe(node.id);
    expect(loads).toHaveLength(0);
  });
});

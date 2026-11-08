import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

describe('instance access and host-side accounting', () => {
  let directory: string;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let redis: typeof import('../src/lib/redis.ts').redis;
  let traffic: typeof import('../src/services/agent/host-traffic.ts');
  let guest: typeof import('../src/services/agent/guest-exec.ts');
  let crypto: typeof import('../src/lib/crypto.ts');
  let app: FastifyInstance;
  let node: import('../src/lib/prisma.ts').Node;
  let other: import('../src/lib/prisma.ts').Node;
  let instance: import('../src/lib/prisma.ts').Instance;
  let userCookie: string;

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-instance-access-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'isolated-instance-access-secret', COOKIE_SECURE: 'false', LOG_LEVEL: 'error' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    ({ redis } = await import('../src/lib/redis.ts'));
    traffic = await import('../src/services/agent/host-traffic.ts');
    guest = await import('../src/services/agent/guest-exec.ts');
    crypto = await import('../src/lib/crypto.ts');
    const user = await db.user.create({ data: { username: 'access-user', email: 'access@example.com', passwordHash: await crypto.hashPassword('access-test-password'), emailVerifiedAt: new Date() } });
    node = await db.node.create({ data: { name: 'access-node', region: 'Test', endpoint: 'mock://access', status: 'ONLINE', natCidr: '10.20.0.1/24', publicIp: '203.0.113.1', networkMode: 'NAT_IPV6', ipv6Subnet: '2001:db8::/48', ipv6PrefixLength: 64 } });
    other = await db.node.create({ data: { name: 'other-node', region: 'Test', endpoint: 'mock://other', status: 'ONLINE', natCidr: '10.30.0.1/24', networkMode: 'NAT_IPV6', ipv6Subnet: '2001:db8:1::/48', ipv6PrefixLength: 64 } });
    instance = await db.instance.create({ data: {
      name: 'pd-access', hostname: 'access', userId: user.id, nodeId: node.id, type: 'KVM_NAT', status: 'RUNNING', privateIp: '10.20.0.2', macAddress: '00:16:3e:00:00:10', rootPassword: crypto.encrypt('old-root-password'),
      cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 0, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 1, portLimit: 5, siteLimit: 5, snapshotLimit: 5, trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY', price: 10, expiresAt: new Date(Date.now() + 86400_000),
    } });
    const incus = await (await import('../src/incus/index.ts')).getIncus(node);
    await incus.createInstance({ name: instance.name, type: 'virtual-machine', source: { type: 'image', alias: 'debian/12', server: 'mock', protocol: 'simplestreams', mode: 'pull' }, config: {}, devices: { eth0: { type: 'nic', network: 'incusbr0', hwaddr: instance.macAddress! } }, profiles: ['default'], start: true });
    app = await (await import('../src/app.ts')).buildApp();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: 'access-user', password: 'access-test-password' }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(login.statusCode).toBe(200);
    userCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }, 60_000);

  afterAll(async () => {
    await app?.close(); await db?.$disconnect(); redis?.disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-instance-access-')) rmSync(directory, { recursive: true, force: true });
  });

  const sample = (rx: number, tx: number, generation = 'boot:uuid:1') => [{ name: instance.name, interfaces: { eth0: { generation, rx, tx } } }];

  it('preserves traffic baselines across reporting retries, missing interfaces and billing resets', async () => {
    await traffic.saveHostTraffic(node.id, sample(1000, 2000), 100);
    expect((await db.instance.findUniqueOrThrow({ where: { id: instance.id } })).trafficIn).toBe(0n);
    await traffic.saveHostTraffic(node.id, sample(1100, 2250), 110);
    await traffic.saveHostTraffic(node.id, sample(1100, 2250), 110);
    await traffic.saveHostTraffic(node.id, sample(1, 2), 105);
    await traffic.saveHostTraffic(other.id, sample(5000, 6000), 120);
    await traffic.saveHostTraffic(node.id, [{ name: instance.name, interfaces: {} }], 120);
    let row = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect([row.trafficIn, row.trafficOut]).toEqual([100n, 250n]);
    await (await import('../src/services/metrics.ts')).collectNode(node);
    row = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect([row.trafficIn, row.trafficOut]).toEqual([100n, 250n]);
    await db.instance.update({ where: { id: instance.id }, data: { trafficIn: 0n, trafficOut: 0n } });
    await traffic.saveHostTraffic(node.id, sample(1120, 2300), 130);
    row = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect([row.trafficIn, row.trafficOut]).toEqual([20n, 50n]);
    await traffic.saveHostTraffic(node.id, sample(10, 30, 'boot:uuid:2'), 140);
    row = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect([row.trafficIn, row.trafficOut]).toEqual([30n, 80n]);
    const daily = await db.trafficDaily.aggregate({ where: { instanceId: instance.id }, _sum: { rx: true, tx: true } });
    expect(daily._sum).toEqual({ rx: 130n, tx: 330n });
  });

  it('allocates independent IPv6 prefixes and restores them on placement rollback', async () => {
    const { allocateIpv6Resources } = await import('../src/services/allocation.ts');
    const original = await allocateIpv6Resources(db, node, 2);
    expect(original.ipv6Prefixes?.split(',')).toEqual(['2001:db8:0:1::/64', '2001:db8:0:2::/64']);
    instance = await db.instance.update({ where: { id: instance.id }, data: original });
    const next = await allocateIpv6Resources(db, node, 1);
    expect(next.ipv6Prefixes).toBe('2001:db8:0:3::/64');
    const { place } = await import('../src/services/migration.ts');
    await place(instance, other, {}, false);
    let row = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(row.ipv6Prefixes?.split(',')).toHaveLength(2);
    expect(row.ipv6Prefixes).toContain('2001:db8:1:');
    await place(row, node, original, false);
    row = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(row.ipv6Prefixes).toBe(original.ipv6Prefixes);
    expect(row.publicIpv6).toBe(original.publicIpv6);
    expect(row.trafficCounters).toBeNull();
    const samePool = await db.node.create({ data: { name: 'same-pool-node', region: 'Test', endpoint: 'mock://same-pool', status: 'ONLINE', natCidr: '10.40.0.1/24', networkMode: 'NAT_IPV6', ipv6Subnet: node.ipv6Subnet, ipv6PrefixLength: 64 } });
    await place(row, samePool, {}, false);
    const samePoolRow = await db.instance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(samePoolRow.ipv6Prefixes).toBe(original.ipv6Prefixes);
    expect(samePoolRow.publicIpv6).toBe(original.publicIpv6);
    await place(samePoolRow, node, original, false);
  });

  it('encrypts SSH jobs and binds results to the assigned host and request', async () => {
    await (await import('../src/services/agent/agent.ts')).saveHostReport(node.id, { cpu: 0, load: [0, 0, 0], uptime: 1, capabilities: ['guest-exec'] });
    const promise = guest.execViaHost(node.id, instance.name, ['sh', '-c', 'echo hello'], { env: { SECRET: 'sensitive-value' } });
    let jobs: Awaited<ReturnType<typeof guest.guestJobs>> = [];
    for (let i = 0; i < 20 && !jobs.length; i++) { await new Promise((r) => setTimeout(r, 25)); jobs = await guest.guestJobs(node.id); }
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job.password).toBe('old-root-password');
    const stored = JSON.stringify(await redis.hgetall(`agent:guest-jobs:${node.id}`));
    expect(stored).not.toContain('old-root-password');
    expect(stored).not.toContain('sensitive-value');
    expect(await guest.guestJobs(other.id)).toEqual([]);
    expect(await guest.saveGuestResult(other.id, job.requestId, { exitCode: 0, stdout: 'bad', stderr: '' })).toBe(false);
    expect(await guest.saveGuestResult(node.id, job.requestId, { exitCode: 0, stdout: 'hello', stderr: '' })).toBe(true);
    expect(await promise).toEqual({ exitCode: 0, stdout: 'hello', stderr: '' });
    expect(await guest.saveGuestResult(node.id, job.requestId, { exitCode: 0, stdout: 'late', stderr: '' })).toBe(false);
    expect(guest.guestAgentUnavailable(new Error("VM agent isn't currently running"))).toBe(true);
    expect(guest.guestAgentUnavailable(new Error('certificate fingerprint mismatch'))).toBe(false);
  });

  it('accepts signed host traffic reports without requiring both network devices', async () => {
    const { issueAgentToken, signingPayload, bodyHash, hmacHex } = await import('../src/services/agent/agent.ts');
    const secret = await issueAgentToken(node.id);
    const path = '/api/agent/nodes/report';
    const timestamp = String(Date.now());
    const nonce = 'instance-access-test-report';
    const body = JSON.stringify({ cpu: 0, load: [0, 0, 0], uptime: 1, release: '0.8.0', capabilities: ['host-traffic', 'guest-exec'], traffic: sample(5000, 6000) });
    const res = await app.inject({ method: 'POST', url: path, payload: body, headers: {
      'content-type': 'application/json', 'x-paledove-node': String(node.id), 'x-paledove-timestamp': timestamp,
      'x-paledove-nonce': nonce, 'x-paledove-signature': hmacHex(secret, signingPayload('POST', path, timestamp, nonce, bodyHash(body))),
    } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['x-paledove-signature']).toBeTruthy();
    expect(res.json().traffic).toEqual({ project: 'default', names: [instance.name] });
    expect(res.json().guestJobs).toEqual([]);
    expect((await db.instance.findUniqueOrThrow({ where: { id: instance.id } })).trafficCounters).toMatchObject({ source: 'host', at: Number(timestamp) });
  });

  it('proxies serial console data and rejects cross-site console connections', async () => {
    const socket = await app.injectWS(`/api/instances/${instance.id}/console`, { headers: { host: 'localhost', origin: 'http://localhost', cookie: userCookie } });
    const data = await new Promise<string>((resolve) => socket.once('message', (value) => resolve(value.toString())));
    expect(data).toContain('mock shell');
    socket.close();
    const denied = await app.injectWS(`/api/instances/${instance.id}/console?type=vga`, { headers: { host: 'localhost', origin: 'https://other.example', cookie: userCookie } });
    const code = await new Promise<number>((resolve) => denied.once('close', resolve));
    expect(code).toBe(1008);
  });
});

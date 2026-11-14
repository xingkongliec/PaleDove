import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { PING_TARGETS, pingTargetsHash, summarizePing } from '../src/shared/index.ts';

describe('managed probe settings', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let settings: typeof import('../src/lib/settings.ts');
  let probes: typeof import('../src/services/agent/ping.ts');
  let redis: typeof import('../src/lib/redis.ts').redis;
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let nodeId: number;
  let otherId: number;
  let productId: number;
  const target = (overrides: Record<string, unknown> = {}) => ({ name: 'Custom Beijing', province: '北京', isp: 'CT', host: 'ping.example.test', port: 443, enabled: true, ...overrides });
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: object, cookie = adminCookie) => app.inject({ method, url, payload: body, headers: { 'x-requested-with': 'XMLHttpRequest', ...(cookie ? { cookie } : {}) } });
  const node = () => db.node.findUniqueOrThrow({ where: { id: nodeId } });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-probes-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-probes-secret-1234567890', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    settings = await import('../src/lib/settings.ts');
    probes = await import('../src/services/agent/ping.ts');
    redis = (await import('../src/lib/redis.ts')).redis;
    const password = 'test-probe-password-123';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const [username, role] of [['probe-admin', 'ADMIN'], ['probe-member', 'USER']] as const) await db.user.create({ data: { username, email: `${username}@example.test`, role, passwordHash: hash, emailVerifiedAt: new Date() } });
    nodeId = (await db.node.create({ data: { name: 'Probe host', region: 'Tokyo', endpoint: 'mock://probe-1', pingEnabled: true } })).id;
    otherId = (await db.node.create({ data: { name: 'Other host', region: 'Tokyo', endpoint: 'mock://probe-2', pingEnabled: false } })).id;
    productId = (await db.product.create({ data: { name: 'Probe product', nodes: { connect: [{ id: nodeId }, { id: otherId }] } } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await request('POST', '/api/auth/login', { account, password }, '');
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('probe-admin'); userCookie = await login('probe-member');
  }, 60_000);

  beforeEach(async () => {
    await settings.setSetting('ping', structuredClone(settings.settingDefaults.ping));
    await db.node.update({ where: { id: nodeId }, data: { pingEnabled: true, enabled: true } });
    await db.node.update({ where: { id: otherId }, data: { pingEnabled: false, enabled: true } });
    for (const id of [nodeId, otherId]) await redis.del(`node:ping:${id}`, `node:ping:targets:${id}`, `node:ping:run:${id}`);
  });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-probes-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('restricts all management endpoints to admins and keeps legacy defaults', async () => {
    const response = await request('GET', '/api/admin/ping');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, interval: 3600, count: 4, nodeIds: null, objects: [{ id: nodeId, enabled: true }], available: [{ id: otherId }] });
    expect(response.json().targets).toHaveLength(93);
    for (const [method, url, body] of [
      ['GET', '/api/admin/ping', undefined], ['PATCH', '/api/admin/ping', { enabled: false }],
      ['POST', '/api/admin/ping/targets', target()], ['PATCH', '/api/admin/ping/targets/bj-ct', target()], ['DELETE', '/api/admin/ping/targets/bj-ct', undefined],
      ['POST', '/api/admin/ping/objects', { nodeId: otherId }], ['PATCH', `/api/admin/ping/objects/${nodeId}`, { enabled: false }], ['DELETE', `/api/admin/ping/objects/${nodeId}`, undefined],
    ] as const) {
      expect((await request(method, url, body, '')).statusCode).toBe(401);
      expect((await request(method, url, body, userCookie)).statusCode).toBe(403);
    }
  });

  it('creates, edits, disables and deletes custom targets and updates Agent configuration', async () => {
    const initial = await probes.pingConfig(await node());
    const added = await request('POST', '/api/admin/ping/targets', target({ host: ' PING.EXAMPLE.TEST ' }));
    expect(added.statusCode, added.body).toBe(200);
    const custom = added.json();
    expect(custom).toMatchObject({ host: 'ping.example.test', provinceEn: 'Beijing' });
    expect((await probes.pingConfig(await node()))?.hash).not.toBe(initial?.hash);
    const beforeRename = (await probes.pingConfig(await node()))?.hash;
    await request('PATCH', `/api/admin/ping/targets/${custom.id}`, target({ name: 'Renamed target' }));
    expect((await probes.pingConfig(await node()))?.hash).not.toBe(beforeRename);
    expect((await probes.pingTargets(nodeId)).targets).toContainEqual({ id: custom.id, host: custom.host, port: 443 });
    await request('PATCH', `/api/admin/ping/targets/${custom.id}`, target({ port: 8443 }));
    expect((await probes.pingTargets(nodeId)).targets.find(item => item.id === custom.id)?.port).toBe(8443);
    await request('PATCH', `/api/admin/ping/targets/${custom.id}`, target({ enabled: false }));
    expect((await probes.pingTargets(nodeId)).targets.some(item => item.id === custom.id)).toBe(false);
    expect((await request('DELETE', `/api/admin/ping/targets/${custom.id}`)).statusCode).toBe(200);
    expect((await request('DELETE', `/api/admin/ping/targets/${custom.id}`)).statusCode).toBe(404);
  });

  it.each([
    ['香港', 'Hong Kong', 'hk'],
    ['澳门', 'Macau', 'mo'],
    ['台湾', 'Taiwan', 'tw'],
  ])('saves and dispatches custom targets in %s', async (province, provinceEn, code) => {
    const input = { province, name: `${provinceEn} probe`, host: `${code}-probe.example.test`, port: 443, enabled: true };
    const added = await request('POST', '/api/admin/ping/targets', input);
    expect(added.statusCode, added.body).toBe(200);
    const custom = added.json();
    expect(custom).toMatchObject({ province, provinceEn, host: input.host, isp: null });
    const edited = await request('PATCH', `/api/admin/ping/targets/${custom.id}`, { ...input, port: 8443, isp: null });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ province, provinceEn, port: 8443, isp: null });
    expect((await request('GET', '/api/admin/ping')).json().targets).toContainEqual(edited.json());
    expect((await probes.pingTargets(nodeId)).targets).toContainEqual({ id: custom.id, host: input.host, port: 8443 });
    expect(await probes.savePingResults(nodeId, { method: 'icmp', results: [{ id: custom.id, latency: 12, loss: 0 }] })).toBe(true);
    const stored = (await probes.getPingResults(nodeId))!;
    expect(stored.targets).toContainEqual(customWithoutEnabled(edited.json()));
    expect(summarizePing(stored.results, stored.targets).provinces.get(province)).toMatchObject({ best: 12, reachable: 1 });
    expect(summarizePing(stored.results, stored.targets).isps.CT).toMatchObject({ total: 0, reachable: 0, fastest: null });
  });

  it('clears the carrier when switching to a regional target and requires it again for mainland provinces', async () => {
    const added = await request('POST', '/api/admin/ping/targets', target());
    expect(added.statusCode, added.body).toBe(200);
    const url = `/api/admin/ping/targets/${added.json().id}`;
    const edited = await request('PATCH', url, target({ province: '台湾' }));
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ province: '台湾', isp: null });
    for (const isp of [null, undefined]) {
      expect((await request('PATCH', url, target({ isp }))).statusCode).toBe(400);
    }
    const mainland = await request('PATCH', url, target({ isp: 'CM' }));
    expect(mainland.statusCode, mainland.body).toBe(200);
    expect(mainland.json()).toMatchObject({ province: '北京', isp: 'CM' });
  });

  it('normalizes legacy regional carriers without mixing them into mainland network statistics', async () => {
    const mainland = settings.settingDefaults.ping.targets[0]!;
    const legacy = { ...mainland, id: 'legacy-hk', province: '香港', provinceEn: 'Hong Kong', host: 'hk-probe.example.test' };
    await settings.setSetting('ping', { targets: [mainland, legacy] });
    const data = (await request('GET', '/api/admin/ping')).json();
    expect(data.targets.find((item: { id: string }) => item.id === legacy.id)).toMatchObject({ isp: null });
    await probes.pingTargets(nodeId);
    await probes.savePingResults(nodeId, { method: 'icmp', results: [{ id: legacy.id, latency: 5, loss: 0 }, { id: mainland.id, latency: 50, loss: 0 }] });
    const stored = (await probes.getPingResults(nodeId))!;
    expect(stored.targets?.find(item => item.id === legacy.id)).toMatchObject({ isp: null });
    const summary = summarizePing(stored.results, [mainland, legacy]);
    expect(summary).toMatchObject({ total: 2, reachable: 2 });
    expect(summary.provinces.get('香港')).toMatchObject({ best: 5, reachable: 1, byIsp: {}, regional: { id: legacy.id, latency: 5 } });
    expect(summary.isps.CT).toMatchObject({ total: 1, reachable: 1, fastest: { target: { id: mainland.id }, latency: 50 } });
    expect(pingTargetsHash([legacy])).toBe(pingTargetsHash([{ ...legacy, isp: null }]));
  });

  it('validates addresses, duplicates, schedules and target limits', async () => {
    for (const host of ['https://example.test', 'example.test/path', 'example.test:443', '999.999.999.999', '::1', '-bad.test', '']) expect((await request('POST', '/api/admin/ping/targets', target({ host }))).statusCode, host).toBe(400);
    expect((await request('POST', '/api/admin/ping/targets', target({ host: '192.0.2.10' }))).statusCode).toBe(200);
    expect((await request('POST', '/api/admin/ping/targets', target({ host: '192.0.2.10' }))).statusCode).toBe(400);
    expect((await request('POST', '/api/admin/ping/targets', target({ province: 'invalid' }))).statusCode).toBe(400);
    for (const body of [{ interval: 599 }, { interval: 86401 }, { count: 0 }, { count: 11 }, { nodeIds: [] }]) expect((await request('PATCH', '/api/admin/ping', body)).statusCode).toBe(400);
    const defaults = settings.settingDefaults.ping.targets;
    await settings.setSetting('ping', { targets: Array.from({ length: 200 }, (_, i) => ({ ...defaults[0]!, id: `target-${i}`, host: `target-${i}.test` })) });
    expect((await request('POST', '/api/admin/ping/targets', target())).statusCode).toBe(400);
  });

  it('stops dispatch, result ingestion, manual runs and public results when disabled', async () => {
    await probes.savePingResults(nodeId, { method: 'icmp', results: [{ id: 'bj-ct', latency: 10, loss: 0 }] });
    expect((await probes.productPing(productId)).nodes).toHaveLength(1);
    expect((await request('PATCH', '/api/admin/ping', { enabled: false })).statusCode).toBe(200);
    expect(await probes.pingConfig(await node())).toBeUndefined();
    expect(await probes.savePingResults(nodeId, { method: 'icmp', results: [{ id: 'bj-ct', latency: 999, loss: 0 }] })).toBe(false);
    expect(await probes.productPing(productId)).toEqual({ enabled: false, nodes: [] });
    expect((await request('POST', `/api/admin/nodes/${nodeId}/ping-run`)).statusCode).toBe(400);
    expect((await request('GET', `/api/admin/nodes/${nodeId}/ping`)).json()).toMatchObject({ enabled: false, result: { results: [{ latency: 10 }] } });
    await request('PATCH', '/api/admin/ping', { enabled: true, interval: 1200, count: 6 });
    expect(await probes.pingConfig(await node())).toMatchObject({ enabled: true, interval: 1200, hash: pingTargetsHash(PING_TARGETS, 6), runNow: true });
    expect((await probes.pingConfig(await node()))?.runNow).toBe(false);
    expect((await probes.pingTargets(nodeId)).count).toBe(6);
  });

  it('keeps inactive objects in the list, removes without deleting hosts and supports re-adding', async () => {
    expect((await request('POST', '/api/admin/ping/objects', { nodeId: otherId })).statusCode).toBe(200);
    await request('PATCH', `/api/admin/ping/objects/${nodeId}`, { enabled: false });
    let data = (await request('GET', '/api/admin/ping')).json();
    expect(data.objects).toHaveLength(2);
    expect(data.objects.find((item: { id: number }) => item.id === nodeId).enabled).toBe(false);
    expect(await probes.pingConfig(await node())).toBeUndefined();
    await request('PATCH', `/api/admin/ping/objects/${nodeId}`, { enabled: true });
    expect((await probes.pingConfig(await node()))?.runNow).toBe(true);
    await request('DELETE', `/api/admin/ping/objects/${nodeId}`);
    expect(await node()).toMatchObject({ name: 'Probe host', endpoint: 'mock://probe-1', pingEnabled: false });
    data = (await request('GET', '/api/admin/ping')).json();
    expect(data.objects.map((item: { id: number }) => item.id)).not.toContain(nodeId);
    expect(data.available.map((item: { id: number }) => item.id)).toContain(nodeId);
    expect((await request('POST', '/api/admin/ping/objects', { nodeId })).statusCode).toBe(200);
    expect((await request('POST', '/api/admin/ping/objects', { nodeId: 999999 })).statusCode).toBe(404);
  });

  it('syncs the existing host editor switch into the managed object list', async () => {
    await request('DELETE', `/api/admin/ping/objects/${nodeId}`);
    expect((await request('PATCH', `/api/admin/nodes/${nodeId}`, { pingEnabled: true })).statusCode).toBe(200);
    expect((await request('GET', '/api/admin/ping')).json().objects).toMatchObject([{ id: nodeId, enabled: true }]);
    expect(await probes.pingConfig(await node())).toBeDefined();
    await request('PATCH', `/api/admin/nodes/${nodeId}`, { pingEnabled: false });
    expect((await request('GET', '/api/admin/ping')).json().objects).toMatchObject([{ id: nodeId, enabled: false }]);
    await db.node.update({ where: { id: nodeId }, data: { enabled: false, pingEnabled: true } });
    expect(await probes.pingConfig(await node())).toBeUndefined();
  });

  it('preserves custom target metadata in results after deletion and ignores unknown and duplicate IDs', async () => {
    const custom = (await request('POST', '/api/admin/ping/targets', target())).json();
    await probes.pingTargets(nodeId);
    await request('DELETE', `/api/admin/ping/targets/${custom.id}`);
    expect(await probes.savePingResults(nodeId, { method: 'icmp', results: [{ id: custom.id, latency: 12.345, loss: 0.1 }, { id: custom.id, latency: 50, loss: 0 }, { id: 'unknown', latency: 1, loss: 0 }] })).toBe(true);
    const stored = (await probes.getPingResults(nodeId))!;
    expect(stored.results).toEqual([{ id: custom.id, latency: 12.3, loss: 0 }]);
    expect(summarizePing(stored.results, stored.targets).isps.CT.fastest?.target).toMatchObject({ name: 'Custom Beijing', host: custom.host });
    expect((await probes.productPing(productId)).nodes[0]?.targets).toContainEqual(customWithoutEnabled(custom));
    expect(await probes.savePingResults(nodeId, { method: 'tcp', results: [{ id: 'unknown', latency: null, loss: 100 }] })).toBe(false);
    expect((await probes.getPingResults(nodeId))?.testedAt).toBe(stored.testedAt);
  });

  it('requires an enabled target to activate a schedule', async () => {
    await settings.setSetting('ping', { targets: [structuredClone(settings.settingDefaults.ping.targets[0]!)] });
    expect((await request('DELETE', '/api/admin/ping/targets/bj-ct')).statusCode).toBe(400);
    await request('PATCH', '/api/admin/ping', { enabled: false });
    expect((await request('DELETE', '/api/admin/ping/targets/bj-ct')).statusCode).toBe(200);
    expect((await request('PATCH', '/api/admin/ping', { enabled: true })).statusCode).toBe(400);
    await request('POST', '/api/admin/ping/targets', target());
    expect((await request('PATCH', '/api/admin/ping', { enabled: true })).statusCode).toBe(200);
  });
});

function customWithoutEnabled(target: Record<string, unknown>) {
  const { enabled: _enabled, ...rest } = target;
  return rest;
}

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

describe('admin site management', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let nodeA: number;
  let nodeB: number;
  let siteId: number;
  let requestNumber = 0;
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.4.0.${(++requestNumber % 250) + 1}`, headers: { 'x-requested-with': 'XMLHttpRequest', cookie } });
  const list = async (query = '') => {
    const res = await request('GET', `/api/admin/site-bindings${query}`, adminCookie);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: Array<{ id: number; domain: string; status: string; targetPort: number; https: boolean; upstream: string; user: { username: string }; node: { id: number } }>; total: number };
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-admin-sites-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-admin-sites-secret-12345678', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    const password = 'test-admin-sites-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'sites-admin', email: 'sites-admin@example.com', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
    const alice = await db.user.create({ data: { username: 'alice', email: 'alice@example.com', passwordHash: hash, emailVerifiedAt: new Date() } });
    const bob = await db.user.create({ data: { username: 'bob', email: 'bob@example.com', passwordHash: hash, emailVerifiedAt: new Date() } });
    nodeA = (await db.node.create({ data: { name: 'Node A', region: 'Test', endpoint: 'mock://sites-a', publicIp: '203.0.113.50', status: 'ONLINE', caddyStatus: 'READY' } })).id;
    nodeB = (await db.node.create({ data: { name: 'Node B', region: 'Test', endpoint: 'mock://sites-b', publicIp: '203.0.113.51', status: 'ONLINE', caddyStatus: 'NONE' } })).id;
    const instance = (userId: number, nodeId: number, name: string, privateIp: string) =>
      db.instance.create({
        data: {
          name, hostname: name, userId, nodeId, type: 'LXC_NAT', status: 'RUNNING', privateIp, cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 100, trafficMode: 'BOTH',
          overLimitAction: 'THROTTLE', throttleRate: 1, portLimit: 5, siteLimit: 5, snapshotLimit: 1, trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY', price: 1, expiresAt: new Date(Date.now() + 86400_000),
        },
      });
    const a = await instance(alice.id, nodeA, 'alice-web', '10.10.0.10');
    const b = await instance(bob.id, nodeB, 'bob-api', '10.20.0.10');
    siteId = (await db.siteBinding.create({ data: { instanceId: a.id, domain: 'blog.alice.test', targetPort: 8080 } })).id;
    await db.siteBinding.create({ data: { instanceId: a.id, domain: 'shop.alice.test' } });
    await db.siteBinding.create({ data: { instanceId: b.id, domain: 'api.bob.test', https: false } });
    await db.proxySite.create({ data: { nodeId: nodeA, domain: 'panel.example.test', upstream: '127.0.0.1:3000' } });
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(res.statusCode, res.body).toBe(200);
      return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    };
    adminCookie = await login('sites-admin');
    userCookie = await login('alice');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-admin-sites-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('pages, searches and filters user site bindings', async () => {
    const all = await list();
    expect(all.total).toBe(3);
    expect(all.items.map((s) => s.domain)).toEqual(['api.bob.test', 'shop.alice.test', 'blog.alice.test']);
    expect(all.items[2]).toMatchObject({ upstream: '10.10.0.10:8080', user: { username: 'alice' }, node: { id: nodeA } });
    expect((await list('?q=alice')).total).toBe(2);
    expect((await list('?q=bob-api')).items.map((s) => s.domain)).toEqual(['api.bob.test']);
    expect((await list(`?nodeId=${nodeB}`)).total).toBe(1);
    expect((await list('?status=PENDING')).total).toBe(3);
    const page2 = await list('?pageSize=2&page=2');
    expect(page2).toMatchObject({ total: 3 });
    expect(page2.items).toHaveLength(1);
    expect((await request('GET', '/api/admin/site-bindings', userCookie)).statusCode).toBe(403);
  });

  it('edits a binding and syncs the node', async () => {
    const res = await request('PATCH', `/api/admin/site-bindings/${siteId}`, adminCookie, { domain: 'Blog2.Alice.Test', targetPort: 3000, https: false });
    expect(res.statusCode, res.body).toBe(200);
    // Node A 的 Caddy 已就绪，修改后立即同步成功
    expect(res.json()).toMatchObject({ domain: 'blog2.alice.test', targetPort: 3000, https: false, status: 'ACTIVE', upstream: '10.10.0.10:3000' });
    expect((await request('PATCH', `/api/admin/site-bindings/${siteId}`, adminCookie, { domain: 'panel.example.test' })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/admin/site-bindings/${siteId}`, adminCookie, { targetPort: 70000 })).statusCode).toBe(400);
    expect((await request('PATCH', '/api/admin/site-bindings/9999', adminCookie, { https: true })).statusCode).toBe(404);
  });

  it('syncs one node or every node with Caddy installed', async () => {
    const one = await request('POST', '/api/admin/proxy-sites/sync', adminCookie, { nodeId: nodeA });
    expect(one.json()).toEqual({ ok: 1, failed: [] });
    expect((await db.proxySite.findFirstOrThrow({ where: { domain: 'panel.example.test' } })).status).toBe('ACTIVE');
    // 没装 Caddy 的宿主机不在「全部」里
    const all = await request('POST', '/api/admin/proxy-sites/sync', adminCookie, {});
    expect(all.json()).toEqual({ ok: 1, failed: [] });
    expect((await request('POST', '/api/admin/proxy-sites/sync', adminCookie, { nodeId: 9999 })).statusCode).toBe(404);
  });

  it('unbinds a user site', async () => {
    expect((await request('DELETE', `/api/admin/site-bindings/${siteId}`, adminCookie)).statusCode).toBe(200);
    expect((await list()).total).toBe(2);
    expect((await request('DELETE', `/api/admin/site-bindings/${siteId}`, adminCookie)).statusCode).toBe(404);
  });
});

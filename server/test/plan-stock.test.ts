import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { PLAN_STOCK_MAX } from '../src/shared/index.ts';

describe('quick plan stock adjustments', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let planId: number;
  let instanceId: number;
  const request = (payload: object, cookie = adminCookie, id = planId) => app.inject({ method: 'POST', url: `/api/admin/plans/${id}/stock`, payload, headers: { cookie, 'x-requested-with': 'XMLHttpRequest' } });
  const stock = async () => (await db.plan.findUniqueOrThrow({ where: { id: planId } })).stock;

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-plan-stock-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-plan-stock-secret-123456789', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    const password = 'plan-stock-test-password-123';
    const passwordHash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'stock-admin', email: 'stock-admin@example.test', role: 'ADMIN', passwordHash, emailVerifiedAt: new Date() } });
    const user = await db.user.create({ data: { username: 'stock-user', email: 'stock-user@example.test', passwordHash, emailVerifiedAt: new Date() } });
    const node = await db.node.create({ data: { name: 'Stock test node', endpoint: 'mock://stock-test', region: 'Test', status: 'ONLINE', arch: 'x86_64' } });
    const product = await db.product.create({ data: { name: 'Stock test product', nodes: { connect: { id: node.id } } } });
    planId = (await db.plan.create({ data: { productId: product.id, name: 'Stock test plan', type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, priceMonthly: 8, stock: 3 } })).id;
    const instance = {
      userId: user.id, planId, nodeId: node.id, type: 'LXC_NAT' as const, cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100,
      traffic: 1000, trafficMode: 'OUT' as const, overLimitAction: 'STOP' as const, throttleRate: 1, portLimit: 5, siteLimit: 0, snapshotLimit: 1,
      trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY' as const, price: 8, expiresAt: new Date(Date.now() + 30 * 86400_000),
    };
    instanceId = (await db.instance.create({ data: { ...instance, name: 'stock-existing', hostname: 'existing', status: 'RUNNING' } })).id;
    await db.instance.create({ data: { ...instance, name: 'stock-deleted', hostname: 'deleted', status: 'DELETED' } });
    app = await (await import('../src/app.ts')).buildApp();
    for (const account of ['stock-admin', 'stock-user']) {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(response.statusCode, response.body).toBe(200);
      const cookie = response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      if (account === 'stock-admin') adminCookie = cookie; else userCookie = cookie;
    }
  }, 60_000);

  beforeEach(async () => {
    await db.plan.update({ where: { id: planId }, data: { stock: 3 } });
    await (await import('../src/lib/cache.ts')).invalidateCache('catalog');
  });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-plan-stock-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('requires an administrator and does not modify stock for other callers', async () => {
    expect((await request({ operation: 'adjust', delta: 1 }, '')).statusCode).toBe(401);
    expect((await request({ operation: 'adjust', delta: 1 }, userCookie)).statusCode).toBe(403);
    expect(await stock()).toBe(3);
  });

  it('increases and decreases capacity, reports remaining stock, and preserves existing instances and plan specs', async () => {
    const original = await db.instance.findUniqueOrThrow({ where: { id: instanceId } });
    const increase = await request({ operation: 'adjust', delta: 5 });
    expect(increase.statusCode, increase.body).toBe(200);
    expect(increase.json()).toMatchObject({ stock: 8, activeInstances: 1, stockLeft: 7, cpu: 1, memory: 512, disk: 10, prices: { MONTHLY: '8.00' } });
    const decrease = await request({ operation: 'adjust', delta: -3 });
    expect(decrease.statusCode, decrease.body).toBe(200);
    expect(decrease.json()).toMatchObject({ stock: 5, activeInstances: 1, stockLeft: 4 });
    expect(await db.instance.findUniqueOrThrow({ where: { id: instanceId } })).toEqual(original);
  });

  it('applies concurrent increments without overwriting one another', async () => {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request({ operation: 'adjust', delta: 1 })));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect(await stock()).toBe(11);
  });

  it('prevents concurrent decreases from taking stock below zero', async () => {
    const responses = await Promise.all([request({ operation: 'adjust', delta: -2 }), request({ operation: 'adjust', delta: -2 })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect(await stock()).toBe(1);
  });

  it('rejects underflow and overflow without modifying stock', async () => {
    expect((await request({ operation: 'adjust', delta: -4 })).statusCode).toBe(409);
    expect(await stock()).toBe(3);
    await db.plan.update({ where: { id: planId }, data: { stock: PLAN_STOCK_MAX } });
    expect((await request({ operation: 'adjust', delta: 1 })).statusCode).toBe(409);
    expect(await stock()).toBe(PLAN_STOCK_MAX);
  });

  it('handles unlimited stock explicitly and rejects stale absolute updates', async () => {
    await db.plan.update({ where: { id: planId }, data: { stock: null } });
    expect((await request({ operation: 'adjust', delta: 1 })).statusCode).toBe(409);
    expect((await request({ operation: 'adjust', delta: -1 })).statusCode).toBe(409);
    const limited = await request({ operation: 'set', stock: 5, expectedStock: null });
    expect(limited.statusCode, limited.body).toBe(200);
    expect(limited.json()).toMatchObject({ stock: 5, stockLeft: 4 });
    expect((await request({ operation: 'set', stock: 10, expectedStock: null })).statusCode).toBe(409);
    expect(await stock()).toBe(5);
    const unlimited = await request({ operation: 'set', stock: null, expectedStock: 5 });
    expect(unlimited.statusCode, unlimited.body).toBe(200);
    expect(unlimited.json()).toMatchObject({ stock: null, stockLeft: null });
  });

  it('allows zero capacity without changing sold instances', async () => {
    const response = await request({ operation: 'set', stock: 0, expectedStock: 3 });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ stock: 0, activeInstances: 1, stockLeft: 0 });
    expect((await db.instance.findUniqueOrThrow({ where: { id: instanceId } })).status).toBe('RUNNING');
  });

  it('invalidates public catalog stock and records the administrator adjustment', async () => {
    const publicPlans = () => app.inject({ method: 'GET', url: '/api/public/plans' });
    expect((await publicPlans()).json().find((plan: { id: number }) => plan.id === planId).stockLeft).toBe(2);
    const response = await request({ operation: 'adjust', delta: 5 });
    expect(response.statusCode, response.body).toBe(200);
    expect((await publicPlans()).json().find((plan: { id: number }) => plan.id === planId).stockLeft).toBe(7);
    const log = await db.activityLog.findFirstOrThrow({ where: { action: 'admin.plan_update' }, orderBy: { id: 'desc' } });
    expect(log.detail).toContain('Stock test plan');
    expect(log.detail).toContain('+5');
  });

  it('validates quantities and expected stock, and returns not found for unknown plans', async () => {
    for (const payload of [
      { operation: 'adjust', delta: 0 }, { operation: 'adjust', delta: 1.5 }, { operation: 'adjust', delta: '5' }, { operation: 'adjust', delta: PLAN_STOCK_MAX + 1 },
      { operation: 'set', stock: -1, expectedStock: 3 }, { operation: 'set', stock: PLAN_STOCK_MAX + 1, expectedStock: 3 }, { operation: 'set', stock: 5 },
    ]) expect((await request(payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect(await stock()).toBe(3);
    expect((await request({ operation: 'adjust', delta: 1 }, adminCookie, 999999)).statusCode).toBe(404);
  });
});

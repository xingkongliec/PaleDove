import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

describe('admin user overview', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let adminCookie: string;
  let memberCookie: string;
  let memberId: number;
  let emptyId: number;
  const request = (url: string, cookie?: string) => app.inject({ url, headers: { 'x-requested-with': 'XMLHttpRequest', ...(cookie ? { cookie } : {}) } });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-user-detail-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-user-detail-secret-123456789', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    const password = 'test-user-detail-password-123';
    const passwordHash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'detail-admin', email: 'detail-admin@example.com', role: 'ADMIN', passwordHash, emailVerifiedAt: new Date() } });
    memberId = (await db.user.create({ data: { username: 'detail-member', email: 'detail-member@example.com', passwordHash, emailVerifiedAt: new Date(), balance: '12.34', locale: 'zh-TW', country: 'TW', remark: '<img src=x onerror=alert(1)>' } })).id;
    emptyId = (await db.user.create({ data: { username: 'detail-empty', email: 'detail-empty@example.com', passwordHash, emailVerifiedAt: new Date() } })).id;
    await db.balanceLog.createMany({ data: [
      { userId: memberId, type: 'RECHARGE', amount: '100.25', balanceAfter: 0 },
      { userId: memberId, type: 'REDEEM', amount: '20.50', balanceAfter: 0 },
      { userId: memberId, type: 'PURCHASE', amount: '-35.50', balanceAfter: 0 },
      { userId: memberId, type: 'RENEW', amount: '-12.30', balanceAfter: 0 },
      { userId: memberId, type: 'REFUND', amount: '5.20', balanceAfter: 0 },
      { userId: memberId, type: 'MARKET', amount: '-8.10', balanceAfter: 0 },
      { userId: memberId, type: 'SWITCH', amount: '-2.20', balanceAfter: 0 },
      { userId: memberId, type: 'ADJUST', amount: '-999', balanceAfter: 0 },
      { userId: memberId, type: 'AFF', amount: '999', balanceAfter: 0 },
      { userId: emptyId, type: 'PURCHASE', amount: '-999', balanceAfter: 0 },
    ] });
    await db.activityLog.createMany({ data: [
      { userId: memberId, action: 'auth.register', ip: '198.51.100.42', createdAt: new Date('2026-01-02') },
      { userId: memberId, action: 'auth.register', ip: '198.51.100.99', createdAt: new Date('2026-01-03') },
      { userId: memberId, action: 'auth.login', ip: '198.51.100.88', createdAt: new Date('2026-01-01') },
    ] });
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('detail-admin');
    memberCookie = await login('detail-member');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-user-detail-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('matches the member billing totals including refunds and isolates other users', async () => {
    const overview = await request(`/api/admin/users/${memberId}`, adminCookie);
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json().billing).toEqual({ totalSpend: '52.90', totalRecharge: '120.75' });
    const summary = await request('/api/billing/summary', memberCookie);
    expect(summary.statusCode, summary.body).toBe(200);
    expect(overview.json().billing).toEqual({ totalSpend: summary.json().totalSpend, totalRecharge: summary.json().totalRecharge });
    expect(overview.json().user.balance).toBe('12.34');
    expect((await db.user.findUniqueOrThrow({ where: { id: memberId } })).balance.toFixed(2)).toBe('12.34');
  });

  it('uses the earliest registration record and returns profile text as data', async () => {
    const overview = (await request(`/api/admin/users/${memberId}`, adminCookie)).json();
    expect(overview.profile).toEqual({ registrationIp: '198.51.100.42', locale: 'zh-TW', country: 'TW' });
    expect(overview.user.remark).toBe('<img src=x onerror=alert(1)>');
    expect(overview.user).not.toHaveProperty('passwordHash');
  });

  it('handles missing profile data and accounts without transactions', async () => {
    const admin = await db.user.findUniqueOrThrow({ where: { username: 'detail-admin' } });
    const overview = (await request(`/api/admin/users/${admin.id}`, adminCookie)).json();
    expect(overview.billing).toEqual({ totalSpend: '0.00', totalRecharge: '0.00' });
    expect(overview.profile).toEqual({ registrationIp: null, locale: null, country: null });
    expect((await request('/api/admin/users/999999', adminCookie)).statusCode).toBe(404);
  });

  it('keeps user financial and profile information restricted to administrators', async () => {
    expect((await request(`/api/admin/users/${memberId}`)).statusCode).toBe(401);
    expect((await request(`/api/admin/users/${memberId}`, memberCookie)).statusCode).toBe(403);
    expect((await request(`/api/admin/users/${emptyId}`, memberCookie)).statusCode).toBe(403);
  });
});

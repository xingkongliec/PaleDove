import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AdminAffLogDTO, Paginated } from '../src/shared/index.ts';

describe('admin referral records', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let adminCookie: string;
  let memberCookie: string;
  let referrerId: number;
  let pendingId: number;
  const request = (query = '', cookie?: string) => app.inject({ url: `/api/admin/aff/logs${query}`, headers: { 'x-requested-with': 'XMLHttpRequest', ...(cookie ? { cookie } : {}) } });
  const records = async (query = '') => {
    const response = await request(query, adminCookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Paginated<AdminAffLogDTO>>();
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-admin-aff-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-admin-aff-secret-123456789', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    const password = 'test-admin-aff-password-123';
    const passwordHash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'aff-admin', email: 'aff-admin@example.com', role: 'ADMIN', passwordHash, emailVerifiedAt: new Date() } });
    const referrer = await db.user.create({ data: { username: 'PromoterAlpha', email: 'promoter@example.com', passwordHash, emailVerifiedAt: new Date(), affBalance: '9.87' } });
    referrerId = referrer.id;
    const buyer = await db.user.create({ data: { username: 'BuyerBeta', email: 'buyer@example.com', passwordHash, emailVerifiedAt: new Date(), referrerId } });
    const other = await db.user.create({ data: { username: 'OtherPromoter', email: 'other@example.com', passwordHash, emailVerifiedAt: new Date() } });
    const purchase = await db.order.create({ data: { no: 'AFF-NEW-001', userId: buyer.id, type: 'NEW', cycle: 'MONTHLY', amount: '100.00', status: 'REFUNDED' } });
    const renewal = await db.order.create({ data: { no: 'AFF-RENEW-002', userId: buyer.id, type: 'RENEW', cycle: 'MONTHLY', amount: '125.75' } });
    await db.affLog.createMany({ data: [
      { userId: referrerId, inviteeId: buyer.id, orderId: purchase.id, type: 'EARN', amount: '7.77', orderAmount: '100.00', rate: '7.77', balanceAfter: '7.77', effectiveAt: new Date('2026-01-01T16:00:00Z'), createdAt: new Date('2026-01-01T16:00:00Z') },
      { userId: referrerId, inviteeId: buyer.id, orderId: purchase.id, type: 'REVOKE', amount: '-7.77', orderAmount: '100.00', rate: '7.77', balanceAfter: 0, createdAt: new Date('2026-01-03T00:00:00Z') },
      { userId: referrerId, type: 'WITHDRAW', amount: '-1.23', balanceAfter: '6.54', createdAt: new Date('2026-02-03T00:00:00Z') },
      { userId: other.id, type: 'EARN', status: 'CANCELED', amount: '2.10', balanceAfter: 0, createdAt: new Date('2026-02-02T00:00:00Z') },
      { userId: other.id, type: 'EARN', amount: '0.13', balanceAfter: '0.13', createdAt: new Date('2026-02-03T00:00:00Z') },
    ] });
    pendingId = (await db.affLog.create({ data: { userId: referrerId, inviteeId: buyer.id, orderId: renewal.id, type: 'EARN', status: 'PENDING', amount: '4.19', orderAmount: '41.90', rate: '10.00', balanceAfter: '9.87', createdAt: new Date('2026-02-01T00:00:00Z'), effectiveAt: new Date('2026-02-05T00:00:00Z') } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('aff-admin');
    memberCookie = await login('promoter@example.com');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-admin-aff-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('restricts financial records to administrators', async () => {
    expect((await request()).statusCode).toBe(401);
    expect((await request('', memberCookie)).statusCode).toBe(403);
  });

  it('returns complete identities, exact amounts and original order context', async () => {
    const result = await records();
    expect(result).toMatchObject({ total: 6, page: 1, pageSize: 20 });
    const earned = result.items.find(row => row.type === 'EARN' && row.order?.type === 'NEW')!;
    expect(earned).toMatchObject({ user: { id: referrerId, username: 'PromoterAlpha' }, invitee: { username: 'BuyerBeta' }, amount: '7.77', orderAmount: '100.00', rate: '7.77', balanceAfter: '7.77', order: { no: 'AFF-NEW-001', amount: '100.00', status: 'REFUNDED' } });
    expect(earned.user).not.toHaveProperty('passwordHash');
    expect(Object.keys(earned.user).sort()).toEqual(['id', 'username']);
    expect(result.items.find(row => row.type === 'REVOKE')).toMatchObject({ amount: '-7.77', balanceAfter: '0.00' });
    expect(result.items.find(row => row.type === 'WITHDRAW')).toMatchObject({ amount: '-1.23', invitee: null, order: null, rate: null, orderAmount: null });
  });

  it('keeps pending and canceled amounts out of balance changes', async () => {
    const pending = await records('?type=EARN&status=PENDING');
    expect(pending.total).toBe(1);
    expect(pending.items[0]).toMatchObject({ id: pendingId, amount: '4.19', orderAmount: '41.90', balanceAfter: null, order: { type: 'RENEW', amount: '125.75' } });
    const canceled = await records('?status=CANCELED');
    expect(canceled.total).toBe(1);
    expect(canceled.items[0]).toMatchObject({ balanceAfter: null, invitee: null, order: null });
  });

  it('paginates in stable creation-time and ID order, across all promoters', async () => {
    const all = (await records()).items.map(row => row.id);
    const paged: number[] = [];
    for (let page = 1; page <= 3; page++) {
      const result = await records(`?page=${page}&pageSize=2`);
      expect(result).toMatchObject({ total: 6, page, pageSize: 2 });
      paged.push(...result.items.map(row => row.id));
    }
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(6);
    expect((await records('?page=9')).items).toEqual([]);
  });

  it('searches referrers, buyers, email and order numbers without case sensitivity', async () => {
    expect((await records('?q=promoteralpha')).total).toBe(4);
    expect((await records('?q=buyerbeta')).total).toBe(3);
    expect((await records('?q=BUYER%40example.com')).total).toBe(3);
    expect((await records('?q=aff-new-001')).items.map(row => row.type).sort()).toEqual(['EARN', 'REVOKE']);
    expect((await records('?q=missing-user')).total).toBe(0);
    expect((await records('?type=WITHDRAW&status=PENDING')).total).toBe(0);
  });

  it('honors inclusive start and exclusive end instants with timezone offsets', async () => {
    const range = new URLSearchParams({ startAt: '2026-01-02T00:00:00+08:00', endAt: '2026-01-03T08:00:00+08:00' });
    const result = await records(`?${range}`);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ type: 'EARN', createdAt: '2026-01-01T16:00:00.000Z' });
    expect((await records('?startAt=2026-03-01T00:00:00Z')).total).toBe(0);
  });

  it('validates filters and pagination', async () => {
    for (const query of ['?type=BAD', '?status=REVOKED', '?page=0', '?pageSize=501', '?startAt=not-a-date', '?startAt=2026-02-02T00:00:00Z&endAt=2026-02-01T00:00:00Z', `?q=${'x'.repeat(101)}`]) {
      const response = await request(query, adminCookie);
      expect(response.statusCode, response.body).toBe(400);
    }
  });

  it('works when referrals are disabled without settling overdue earnings or changing balances', async () => {
    expect((await (await import('../src/lib/settings.ts')).getSettings()).affEnabled).toBe(false);
    const before = await db.user.findUniqueOrThrow({ where: { id: referrerId } });
    await records();
    const after = await db.user.findUniqueOrThrow({ where: { id: referrerId } });
    expect(after.affBalance.toFixed(2)).toBe(before.affBalance.toFixed(2));
    expect(after.affCode).toBe(before.affCode);
    expect((await db.affLog.findUniqueOrThrow({ where: { id: pendingId } })).status).toBe('PENDING');
    expect(await db.affLog.count()).toBe(6);
  });
});

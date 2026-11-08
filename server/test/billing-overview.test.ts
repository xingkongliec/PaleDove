import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

describe('admin billing overview and records', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let adminCookie: string;
  const users: number[] = [];
  const products: number[] = [];
  const createUser = async (name: string) => {
    const user = await db.user.create({ data: { username: name, email: `${name}@example.com`, passwordHash: 'unused-in-isolated-test' } });
    users.push(user.id);
    return user;
  };
  const get = (url: string) => app.inject({ method: 'GET', url, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-billing-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: `file:${resolve(directory, 'test.db')}`,
      REDIS_URL: 'memory://',
      APP_SECRET: 'test-billing-overview-secret-1234',
      LOG_LEVEL: 'error',
      COOKIE_SECURE: 'false',
    });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    const password = 'test-billing-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'bill-admin', email: 'bill-admin@example.com', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
    const user = await db.user.create({ data: { username: 'bill-user', email: 'bill-user@example.com', passwordHash: hash, emailVerifiedAt: new Date(), balance: 37 } });
    const lastMonth = new Date();
    // 先回到 1 号再减月份：在 29~31 号直接 setMonth 会溢出到本月
    lastMonth.setDate(1);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    const log = (type: string, amount: number, createdAt = new Date()) =>
      db.balanceLog.create({ data: { userId: user.id, type: type as never, amount, balanceAfter: 0, createdAt } });
    // 本月：充值 100 + 兑换 10，新购 −50、续费 −20、退款 +5、人工 +2；上月：充值 30、新购 −40
    await log('RECHARGE', 100);
    await log('REDEEM', 10);
    await log('PURCHASE', -50);
    await log('RENEW', -20);
    await log('REFUND', 5);
    await log('ADJUST', 2);
    await log('RECHARGE', 30, lastMonth);
    await log('PURCHASE', -40, lastMonth);
    app = await (await import('../src/app.ts')).buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: 'bill-admin', password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    adminCookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-billing-test-')) rmSync(directory, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.user.deleteMany({ where: { id: { in: users.splice(0) } } });
    if (products.length) {
      await db.plan.deleteMany({ where: { productId: { in: products } } });
      await db.product.deleteMany({ where: { id: { in: products.splice(0) } } });
    }
  });

  it('sums income, refunds and recharges by period', async () => {
    const res = await get('/api/admin/billing/overview');
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.income).toMatchObject({ total: '105.00', gross: '110.00', refund: '5.00', today: '65.00', month: '65.00' });
    expect(o.recharge.total).toEqual({ amount: '140.00', count: 3 });
    expect(o.recharge.month).toEqual({ amount: '110.00', count: 2 });
    expect(o.income.monthCharges).toEqual({ amount: '70.00', count: 2 });
    expect(o.income.monthRefunds).toEqual({ amount: '5.00', count: 1 });
    expect(o.monthIncomeByType).toEqual({ purchase: '50.00', renew: '20.00', other: '0.00' });
    expect(o.recharge.monthOnline).toEqual({ amount: '100.00', count: 1 });
    expect(o.recharge.monthRedeem).toEqual({ amount: '10.00', count: 1 });
    expect(o.recharge).toMatchObject({ online: '130.00', redeem: '10.00' });
    expect(o.incomeByType).toEqual({ purchase: '90.00', renew: '20.00', other: '0.00', refund: '5.00' });
    expect(o.adjust).toBe('2.00');
    expect(o.balance).toEqual({ total: '37.00', users: 1 });
  });

  it('separates the previous same period from the full month and excludes future records from all financial totals', async () => {
    const report = await import('../src/services/billing-report.ts');
    const asOf = new Date(2030, 10, 15, 12);
    const periods = report.billingPeriods(asOf);
    vi.spyOn(report, 'billingPeriods').mockReturnValue(periods);
    const before = (await get('/api/admin/billing/overview')).json();
    const user = await createUser('month-comparison');
    const data = [
      { type: 'PURCHASE', amount: -40, createdAt: new Date(2030, 9, 1) },
      { type: 'RECHARGE', amount: 30, createdAt: new Date(2030, 9, 1) },
      { type: 'RENEW', amount: -10, createdAt: new Date(2030, 9, 15, 11, 59, 59, 999) },
      { type: 'REDEEM', amount: 5, createdAt: new Date(2030, 9, 15, 11, 59, 59, 999) },
      { type: 'PURCHASE', amount: -20, createdAt: new Date(2030, 9, 15, 12) },
      { type: 'RECHARGE', amount: 10, createdAt: new Date(2030, 9, 15, 12) },
      { type: 'SWITCH', amount: -3, createdAt: new Date(2030, 9, 31, 23, 59, 59, 999) },
      { type: 'SWITCH', amount: 1, createdAt: new Date(2030, 9, 31, 23, 59, 59, 999) },
      { type: 'PURCHASE', amount: -60, createdAt: new Date(2030, 10, 1) },
      { type: 'RECHARGE', amount: 200, createdAt: new Date(2030, 10, 1) },
      { type: 'RENEW', amount: -15, createdAt: new Date(2030, 10, 15, 11, 59, 59, 999) },
      { type: 'REDEEM', amount: 20, createdAt: new Date(2030, 10, 15, 11, 59, 59, 999) },
      { type: 'REFUND', amount: 5, createdAt: new Date(2030, 10, 15, 11, 59, 59, 999) },
      { type: 'PURCHASE', amount: -999, createdAt: asOf },
      { type: 'RECHARGE', amount: 999, createdAt: asOf },
      { type: 'PURCHASE', amount: -100, createdAt: new Date(2030, 8, 30, 23, 59, 59, 999) },
      { type: 'RECHARGE', amount: 100, createdAt: new Date(2030, 8, 30, 23, 59, 59, 999) },
      { type: 'MARKET', amount: -1000, createdAt: new Date(2030, 10, 1) },
      { type: 'ADJUST', amount: 1000, createdAt: new Date(2030, 10, 1) },
    ];
    await db.balanceLog.createMany({ data: data.map((row) => ({ ...row, type: row.type as never, userId: user.id, balanceAfter: 0 })) });
    await db.order.createMany({
      data: [
        { no: 'MONTH-NEW', userId: user.id, type: 'NEW', cycle: 'MONTHLY', amount: 60, discount: 15, createdAt: new Date(2030, 10, 1) },
        { no: 'MONTH-RENEW', userId: user.id, type: 'RENEW', cycle: 'MONTHLY', amount: 15, createdAt: new Date(2030, 10, 15, 11, 59, 59, 999) },
        { no: 'MONTH-REFUNDED', userId: user.id, type: 'NEW', cycle: 'MONTHLY', amount: 9, discount: 3, status: 'REFUNDED', createdAt: new Date(2030, 10, 1) },
        { no: 'PREVIOUS-ORDER', userId: user.id, type: 'NEW', cycle: 'MONTHLY', amount: 20, discount: 5, createdAt: new Date(2030, 9, 31, 23, 59, 59, 999) },
        { no: 'FUTURE-ORDER', userId: user.id, type: 'NEW', cycle: 'MONTHLY', amount: 999, discount: 99, createdAt: asOf },
      ],
    });
    const res = await get('/api/admin/billing/overview');
    expect(res.statusCode, res.body).toBe(200);
    const o = res.json();
    expect(o.period).toMatchObject({ asOf: asOf.toISOString(), lastMonthToDateEnd: periods.lastMonthToDate.lt.toISOString() });
    expect(o.income).toMatchObject({
      month: '70.00', today: '10.00', lastMonthToDate: '50.00', lastMonth: '72.00',
      change: { difference: '20.00', percent: 40 },
      monthCharges: { amount: '75.00', count: 2 }, monthRefunds: { amount: '5.00', count: 1 },
    });
    expect(o.monthIncomeByType).toEqual({ purchase: '60.00', renew: '15.00', other: '0.00' });
    expect(o.recharge).toMatchObject({
      month: { amount: '220.00', count: 2 }, today: { amount: '20.00', count: 1 },
      lastMonthToDate: { amount: '35.00', count: 2 }, lastMonth: { amount: '45.00', count: 3 },
      change: { difference: '185.00', percent: 528.6 },
      monthOnline: { amount: '200.00', count: 1 }, monthRedeem: { amount: '20.00', count: 1 },
    });
    expect(Number(o.income.total) - Number(before.income.total)).toBe(242);
    expect(Number(o.recharge.total.amount) - Number(before.recharge.total.amount)).toBe(365);
    expect(o.monthOrders).toEqual({ amount: '75.00', count: 2, newCount: 1, renewCount: 1, discount: '15.00', discountedCount: 1 });
    expect(o.coupons).toEqual({ amount: '20.00', count: 2 });
  });

  it('reports an empty comparison baseline and negative monthly income without inventing a percentage', async () => {
    const report = await import('../src/services/billing-report.ts');
    vi.spyOn(report, 'billingPeriods').mockReturnValue(report.billingPeriods(new Date(2031, 0, 15, 12)));
    const user = await createUser('negative-month');
    await db.balanceLog.createMany({
      data: [
        { userId: user.id, type: 'PURCHASE', amount: '-10', balanceAfter: 0, createdAt: new Date(2031, 0, 1) },
        { userId: user.id, type: 'REFUND', amount: '25', balanceAfter: 0, createdAt: new Date(2031, 0, 1) },
      ],
    });
    const o = (await get('/api/admin/billing/overview')).json();
    expect(o.income).toMatchObject({ month: '-15.00', lastMonthToDate: '0.00', change: { difference: '-15.00', percent: null } });
    expect(o.recharge.change).toEqual({ difference: '0.00', percent: null });
    expect(o.monthOrders).toEqual({ amount: '0.00', count: 0, newCount: 0, renewCount: 0, discount: '0.00', discountedCount: 0 });
  });

  it('lists recharge and charge records separately', async () => {
    const recharge = (await get('/api/admin/billing/records?kind=recharge')).json();
    expect(recharge.items.map((l: { type: string }) => l.type).sort()).toEqual(['ADJUST', 'RECHARGE', 'RECHARGE', 'REDEEM']);
    expect(recharge.sum).toBe('142.00');
    const charge = (await get('/api/admin/billing/records?kind=charge')).json();
    expect(charge.total).toBe(4);
    expect(charge.sum).toBe('-105.00');
    const renew = (await get('/api/admin/billing/records?kind=charge&type=RENEW')).json();
    expect(renew.items).toHaveLength(1);
    // 充值类型不会出现在扣费记录里
    expect((await get('/api/admin/billing/records?kind=charge&type=RECHARGE')).json().total).toBe(0);
    expect((await get('/api/admin/billing/records?kind=recharge&q=bill-user')).json().total).toBe(4);
  });

  it('separates debits and credits across all filtered pages, including returns exceeding charges', async () => {
    const user = await createUser('ledger-refund');
    await db.balanceLog.createMany({
      data: [
        { userId: user.id, type: 'PURCHASE', amount: '-0.10', balanceAfter: 0 },
        { userId: user.id, type: 'SWITCH', amount: '-0.20', balanceAfter: 0 },
        { userId: user.id, type: 'SWITCH', amount: '0.20', balanceAfter: 0 },
        { userId: user.id, type: 'REFUND', amount: '5.00', balanceAfter: 0 },
        { userId: user.id, type: 'MARKET', amount: '-2.00', balanceAfter: 0 },
        { userId: user.id, type: 'MARKET', amount: '3.00', balanceAfter: 0 },
        { userId: user.id, type: 'ADJUST', amount: '-0.30', balanceAfter: 0 },
        { userId: user.id, type: 'AFF', amount: '1.00', balanceAfter: 0 },
      ],
    });
    for (const page of [1, 2]) {
      const res = await get(`/api/admin/billing/records?kind=charge&q=ledger-refund&pageSize=2&page=${page}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ total: 7, debitTotal: '2.60', creditTotal: '8.20', sum: '5.60' });
      expect(res.json().items).toHaveLength(2);
    }
    const all = (await get('/api/admin/billing/records?kind=all&q=ledger-refund')).json();
    expect(all).toMatchObject({ total: 8, debitTotal: '2.60', creditTotal: '9.20', sum: '6.60' });
    const switched = (await get('/api/admin/billing/records?kind=charge&type=SWITCH&q=ledger-refund')).json();
    expect(switched).toMatchObject({ total: 2, debitTotal: '0.20', creditTotal: '0.20', sum: '0.00' });
    const empty = (await get('/api/admin/billing/records?kind=recharge&q=ledger-refund')).json();
    expect(empty).toMatchObject({ total: 0, debitTotal: '0.00', creditTotal: '0.00', sum: '0.00' });
  });

  it('reconciles service income including extra fees and switch refunds without market pass-through', async () => {
    const before = (await get('/api/admin/billing/overview')).json();
    const user = await createUser('service-fees');
    await db.balanceLog.createMany({
      data: [
        { userId: user.id, type: 'TRANSFER', amount: '-1.25', balanceAfter: 0 },
        { userId: user.id, type: 'TRAFFIC', amount: '-2.50', balanceAfter: 0 },
        { userId: user.id, type: 'SWITCH', amount: '-3.00', balanceAfter: 0 },
        { userId: user.id, type: 'SWITCH', amount: '1.00', balanceAfter: 0 },
        { userId: user.id, type: 'MARKET', amount: '-100', balanceAfter: 0 },
        { userId: user.id, type: 'ADJUST', amount: '100', balanceAfter: 0 },
      ],
    });
    const after = (await get('/api/admin/billing/overview')).json();
    expect(Number(after.income.gross) - Number(before.income.gross)).toBe(6.75);
    expect(Number(after.income.refund) - Number(before.income.refund)).toBe(1);
    expect(Number(after.income.total) - Number(before.income.total)).toBe(5.75);
    expect(Number(after.incomeByType.other) - Number(before.incomeByType.other)).toBe(6.75);
    expect(Number(after.income.gross) - Number(after.income.refund)).toBe(Number(after.income.total));
  });

  it('keeps plan, original price, coupon and refunded-order totals consistent with filters and pagination', async () => {
    const user = await createUser('order-summary');
    const product = await db.product.create({ data: { name: 'Billing product' } });
    products.push(product.id);
    const plan = await db.plan.create({
      data: { productId: product.id, name: 'Annual mini', type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100 },
    });
    const order = await db.order.create({
      data: { no: 'BILL-PAID-001', userId: user.id, planId: plan.id, type: 'NEW', cycle: 'ANNUAL', amount: '30.10', discount: '9.90', couponCode: 'SAVE10' },
    });
    await db.order.create({
      data: { no: 'BILL-REFUND-001', userId: user.id, planId: plan.id, type: 'RENEW', cycle: 'MONTHLY', amount: '5.00', discount: '2.00', couponCode: 'OLD', status: 'REFUNDED' },
    });
    await db.balanceLog.create({ data: { userId: user.id, type: 'PURCHASE', amount: '-30.10', balanceAfter: 0, description: `购买实例，订单 ${order.no}` } });
    for (const page of [1, 2]) {
      const res = await get(`/api/admin/orders?q=order-summary&pageSize=1&page=${page}`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ total: 2, amountTotal: '35.10', discountTotal: '11.90', refundedTotal: '5.00' });
      expect(res.json().items).toHaveLength(1);
    }
    const paid = (await get('/api/admin/orders?q=order-summary&status=PAID')).json();
    expect(paid).toMatchObject({ total: 1, amountTotal: '30.10', discountTotal: '9.90', refundedTotal: '0.00' });
    expect(paid.items[0]).toMatchObject({ plan: { name: plan.name, product: product.name }, couponCode: 'SAVE10', cycle: 'ANNUAL' });
    expect((await get('/api/admin/orders?q=save10')).json().total).toBe(1);
    expect((await get('/api/admin/orders?q=Annual%20mini')).json().total).toBe(2);
    const log = (await get('/api/admin/billing/records?kind=charge&q=order-summary')).json().items[0];
    expect(log.order).toMatchObject({ plan: 'Billing product / Annual mini', amount: '30.10', discount: '9.90', couponCode: 'SAVE10', cycle: 'ANNUAL' });
    const overview = (await get('/api/admin/billing/overview')).json();
    expect(overview.coupons).toEqual({ count: 1, amount: '9.90' });
    expect(overview.incomeByProduct.find((p: { productId: number }) => p.productId === product.id)).toMatchObject({ amount: '30.10', count: 1 });
  });

  it('credits a payment exactly once, excludes fees from balance and shows channel and method independently', async () => {
    const user = await createUser('payment-ledger');
    const { completePayment, savePayChannels } = await import('../src/services/payments/payments.ts');
    await savePayChannels([
      {
        id: 'stripe-merchant-a',
        name: 'Merchant A',
        type: 'stripe',
        enabled: false,
        sort: 0,
        minAmount: 1,
        maxAmount: 0,
        feeFixed: 0,
        feePercent: 2,
        currency: 'USD',
        secretKeyEnc: '',
        webhookSecretEnc: '',
      },
    ]);
    const payment = await db.payment.create({
      data: {
        no: 'P-BILLING-001',
        userId: user.id,
        gateway: 'stripe',
        channel: 'stripe',
        channelId: 'stripe-merchant-a',
        amount: '100.01',
        fee: '2.04',
        payAmount: '14.77',
        currency: 'USD',
      },
    });
    await expect(completePayment(payment.no, { money: '102.00' })).rejects.toThrow();
    expect(await db.balanceLog.count({ where: { userId: user.id } })).toBe(0);
    expect(await completePayment(payment.no, { money: '102.05' })).toBe(true);
    expect(await completePayment(payment.no, { money: '102.05' })).toBe(false);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).balance.toFixed(2)).toBe('100.01');
    const records = (await get('/api/admin/billing/records?kind=recharge&q=payment-ledger')).json();
    expect(records).toMatchObject({ total: 1, creditTotal: '100.01', debitTotal: '0.00' });
    expect(records.items[0].payment).toMatchObject({
      channelName: 'Merchant A',
      methodName: 'Stripe',
      amount: '100.01',
      fee: '2.04',
      payAmount: '14.77',
      currency: 'USD',
      status: 'PAID',
    });
    // 渠道删除后保留原渠道 ID，不把支付方式误当成渠道名称。
    await savePayChannels([]);
    expect((await get('/api/admin/billing/records?kind=recharge&q=payment-ledger')).json().items[0].payment).toMatchObject({
      channelName: 'stripe-merchant-a',
      methodName: 'Stripe',
    });
  });

  it('does not attach another user’s order or payment from a manually entered reference', async () => {
    const owner = await createUser('reference-owner');
    const other = await createUser('reference-other');
    const no = 'FOREIGN-ORDER-001';
    await db.order.create({ data: { no, userId: owner.id, type: 'NEW', cycle: 'MONTHLY', amount: 1 } });
    const paymentNo = 'P-FOREIGN-PAYMENT';
    await db.payment.create({ data: { no: paymentNo, userId: owner.id, gateway: 'epay', channel: 'alipay', amount: 1, payAmount: 1, currency: 'CNY', status: 'PAID' } });
    await db.balanceLog.createMany({
      data: [
        { userId: other.id, type: 'PURCHASE', amount: -1, balanceAfter: 0, description: `说明，订单 ${no}` },
        { userId: other.id, type: 'RECHARGE', amount: 1, balanceAfter: 0, description: `说明, ref ${paymentNo}` },
      ],
    });
    const records = (await get('/api/admin/billing/records?kind=all&q=reference-other')).json();
    expect(records.items).toHaveLength(2);
    for (const item of records.items) {
      expect(item.order).toBeUndefined();
      expect(item.payment).toBeUndefined();
    }
  });
});

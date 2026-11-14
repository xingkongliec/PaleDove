import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../src/lib/prisma.ts';
import { defaultNightDrawRules, nightHighQuality, type AdminUserNightMarketDTO, type AdminUserNightResetDTO, type InvoiceDTO, type NightConfig, type NightMarketDTO, type NightOfferDTO, type NightPrizeSnapshot } from '../src/shared/index.ts';

describe('Night Market', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let service: typeof import('../src/services/night-market.ts');
  let directory: string;
  let adminCookie: string;
  let cookie: string;
  let otherCookie: string;
  let userId: number;
  let otherId: number;
  let imageId: number;
  let nodeId: number;
  let secondNodeId: number;
  let planIds: number[];
  let config: NightConfig;
  let number = 0;
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, auth = cookie, payload?: object) => app.inject({ method, url, payload, remoteAddress: `10.92.${Math.floor(++number / 240)}.${number % 240 + 1}`, headers: { cookie: auth, 'x-requested-with': 'XMLHttpRequest' } });
  const save = (input = config) => request('PUT', '/api/admin/night-market', adminCookie, input);
  const market = async (auth = cookie) => {
    const response = await request('GET', '/api/night-market', auth);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<NightMarketDTO>();
  };
  const reveal = async (id: number, auth = cookie) => {
    const response = await request('POST', `/api/night-market/offers/${id}/reveal`, auth);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<NightOfferDTO>();
  };
  const input = (offer: NightOfferDTO, extra: object = {}) => ({ planId: offer.prize!.planId, region: 'Test', imageId, nodeId, cycle: offer.prize!.cycle, hostname: 'night-instance', nightMarketOfferId: offer.id, ...extra });
  const invoice = async (offer: NightOfferDTO, extra: object = {}) => {
    const response = await request('POST', '/api/store/orders', cookie, input(offer, extra));
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ invoice: InvoiceDTO }>().invoice;
  };
  const balance = async () => (await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toFixed(2);
  const enable = async () => {
    const response = await save();
    expect(response.statusCode, response.body).toBe(200);
    return market();
  };
  const inspect = async (id = userId) => {
    const response = await request('GET', `/api/admin/users/${id}/night-market`, adminCookie);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<AdminUserNightMarketDTO>();
  };
  const resetPool = (current: AdminUserNightMarketDTO, auth = adminCookie, id = userId) => request('POST', `/api/admin/users/${id}/night-market/reset`, auth, { periodId: current.period!.id, offerIds: current.offers.map(offer => offer.id) });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-night-market-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-night-market-secret-123456789', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    service = await import('../src/services/night-market.ts');
    const password = 'night-market-test-password-1';
    const passwordHash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'night-admin', email: 'night-admin@example.com', role: 'ADMIN', passwordHash, emailVerifiedAt: new Date() } });
    userId = (await db.user.create({ data: { username: 'night-user', email: 'night-user@example.com', passwordHash, emailVerifiedAt: new Date(), balance: 1000 } })).id;
    otherId = (await db.user.create({ data: { username: 'night-other', email: 'night-other@example.com', passwordHash, emailVerifiedAt: new Date() } })).id;
    nodeId = (await db.node.create({ data: { name: 'Night node', region: 'Test', status: 'ONLINE', endpoint: 'mock://night-market', publicIp: '203.0.113.44' } })).id;
    secondNodeId = (await db.node.create({ data: { name: 'Night second node', region: 'Test', status: 'ONLINE', endpoint: 'mock://night-market-second', publicIp: '203.0.113.45' } })).id;
    imageId = (await db.image.create({ data: { name: 'Debian', family: 'debian', alias: 'debian/12/cloud' } })).id;
    planIds = [];
    for (let group = 0; group < 4; group++) {
      const product = await db.product.create({ data: { name: `Night product ${group}`, nodes: { connect: [{ id: nodeId }, { id: secondNodeId }] } } });
      for (let index = 0; index < 3; index++) planIds.push((await db.plan.create({ data: { productId: product.id, name: `Night plan ${group}-${index}`, type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, priceMonthly: 20, priceAnnual: 200 } })).id);
    }
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await request('POST', '/api/auth/login', '', { account, password });
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    };
    adminCookie = await login('night-admin'); cookie = await login('night-user'); otherCookie = await login('night-other');
  }, 90_000);

  beforeEach(async () => {
    await db.nightMarketPool.deleteMany();
    await db.nightMarketPeriod.deleteMany();
    await db.setting.deleteMany({ where: { key: 'nightMarket' } });
    await db.user.update({ where: { id: userId }, data: { balance: 1000 } });
    await db.plan.updateMany({ where: { id: { in: planIds } }, data: { enabled: true, stock: null, priceMonthly: 20 } });
    config = { enabled: true, startsAt: new Date(Date.now() - 60_000).toISOString(), refreshHours: 24, activeHours: 12, drawRules: defaultNightDrawRules(),
      prizes: planIds.map((planId, i) => ({ id: randomUUID(), name: `Prize ${i}`, description: '', planId, cycle: 'MONTHLY', quality: i === 11 ? 'EXCLUSIVE' : i % 3 === 0 ? 'PREMIUM' : i % 2 === 0 ? 'SELECT' : 'DELUXE', groupKey: `group-${Math.floor(i / 3)}`, eligibleFromPeriod: 1, discountMin: 10, discountMax: 49, discountMode: 'ONCE', enabled: true })) };
  });

  afterAll(async () => {
    await app?.close();
    await (await import('../src/jobs/queue.ts')).closeQueues();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-night-market-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('defaults to disabled and restricts configuration and pools to the proper role', async () => {
    expect((await market()).state).toBe('disabled');
    expect((await request('GET', '/api/night-market', '')).statusCode).toBe(401);
    expect((await request('GET', '/api/night-market', adminCookie)).statusCode).toBe(403);
    expect((await request('GET', '/api/admin/night-market', cookie)).statusCode).toBe(403);
    expect((await request('PUT', '/api/admin/night-market', cookie, config)).statusCode).toBe(403);
    expect((await request('GET', '/api/public/config')).json().nightMarketEnabled).toBe(false);
    await enable();
    expect((await request('GET', '/api/public/config')).json().nightMarketEnabled).toBe(true);
  });

  it('restricts user night-market inspection and reset to admins and validates users and snapshots', async () => {
    const current = await enable();
    const snapshot = { periodId: current.period!.id, offerIds: current.offers.map(offer => offer.id) };
    for (const auth of ['', cookie, otherCookie]) {
      expect((await request('GET', `/api/admin/users/${userId}/night-market`, auth)).statusCode).toBe(auth ? 403 : 401);
      expect((await request('POST', `/api/admin/users/${userId}/night-market/reset`, auth, snapshot)).statusCode).toBe(auth ? 403 : 401);
    }
    expect((await request('GET', '/api/admin/users/999999/night-market', adminCookie)).statusCode).toBe(404);
    expect((await request('POST', '/api/admin/users/999999/night-market/reset', adminCookie, snapshot)).statusCode).toBe(404);
    expect((await request('POST', `/api/admin/users/${userId}/night-market/reset`, adminCookie, { ...snapshot, offerIds: [snapshot.offerIds[0], snapshot.offerIds[0]] })).statusCode).toBe(400);
    const admin = await db.user.findUniqueOrThrow({ where: { username: 'night-admin' } });
    const adminView = await inspect(admin.id);
    expect(adminView.resetBlockedReason).toBe('role');
    expect((await resetPool(adminView, adminCookie, admin.id)).statusCode).toBe(409);
  });

  it('inspects sealed prizes without revealing or creating user pools, and can generate a pool explicitly', async () => {
    expect((await save()).statusCode).toBe(200);
    const empty = await inspect();
    expect(empty).toMatchObject({ state: 'open', offers: [], poolId: null, generatedAt: null, resetBlockedReason: null });
    expect(await db.nightMarketPool.count()).toBe(0);
    const generated = await resetPool(empty);
    expect(generated.statusCode, generated.body).toBe(200);
    expect(generated.json<AdminUserNightResetDTO>()).toMatchObject({ canceledInvoices: 0, retainedOffers: 0, market: { state: 'open' } });
    const adminView = await inspect();
    expect(adminView.offers).toHaveLength(6);
    expect(adminView.offers.every(card => card.prize && card.amount && card.revealedAt === null)).toBe(true);
    const publicView = await market();
    expect(publicView.offers.every(card => card.revealedAt === null && card.prize === undefined && card.amount === undefined)).toBe(true);
    expect((await inspect()).offers).toEqual(adminView.offers);
    expect((await inspect(otherId)).offers).toEqual([]);
    expect(await db.nightMarketPool.count()).toBe(1);
  });

  it('redraws only the selected user with frozen rules, cancels pending invoices and invalidates old cards', async () => {
    const current = await enable();
    const other = await market(otherCookie);
    const revealed = await reveal(current.offers[0].id);
    const bill = await invoice(revealed);
    const before = await inspect();
    const oldIds = before.offers.map(card => card.id);
    config.prizes = config.prizes.map(p => ({ ...p, name: `Next ${p.name}`, quality: 'SELECT', discountMin: 70, discountMax: 90 }));
    config.drawRules = { guaranteeEnabled: false, guaranteeCount: 1, guaranteeQuality: 'SELECT', qualityProbabilities: { SELECT: 100, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: 0 } };
    expect((await save()).statusCode).toBe(200);
    const response = await resetPool(before);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<AdminUserNightResetDTO>();
    expect(result).toMatchObject({ canceledInvoices: 1, retainedOffers: 0 });
    expect(result.market.offers).toHaveLength(6);
    expect(result.market.period).toEqual(before.period);
    expect(result.market.offers.every(card => !oldIds.includes(card.id) && !card.revealedAt && !card.prize.name.startsWith('Next ') && card.discountPercent <= 49)).toBe(true);
    expect(result.market.offers.filter(card => nightHighQuality(card.quality)).length).toBeGreaterThanOrEqual(2);
    const groups = result.market.offers.map(card => card.prize.groupKey);
    expect(groups.every(group => groups.filter(value => value === group).length <= 2)).toBe(true);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('CANCELED');
    expect((await request('POST', `/api/invoices/${bill.id}/pay`)).statusCode).toBe(409);
    expect((await request('POST', `/api/night-market/offers/${revealed.id}/reveal`)).statusCode).toBe(404);
    expect((await market(otherCookie)).offers).toEqual(other.offers);
    expect(await balance()).toBe('1000.00');
    const log = await db.activityLog.findFirstOrThrow({ where: { action: 'admin.user_night_market_reset' }, orderBy: { id: 'desc' } });
    expect(log.userId).toBe((await db.user.findUniqueOrThrow({ where: { username: 'night-admin' } })).id);
    expect(log.detail).toContain(`user #${userId}`);
  });

  it('preserves purchased cards, paid invoices, instances and recurring prices across resets', async () => {
    config.prizes = config.prizes.map(prize => ({ ...prize, discountMode: 'RECURRING', discountMin: 40, discountMax: 40 }));
    const current = await enable();
    const offer = await reveal(current.offers[0].id);
    const bill = await invoice(offer);
    const paid = await request('POST', `/api/invoices/${bill.id}/pay`);
    expect(paid.statusCode, paid.body).toBe(200);
    const instanceId = paid.json<InvoiceDTO>().instanceId!;
    const before = await inspect();
    const purchased = before.offers.find(card => card.id === offer.id)!;
    const oldBalance = await balance();
    const oldOrder = await db.order.findFirstOrThrow({ where: { instanceId } });
    const response = await resetPool(before);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<AdminUserNightResetDTO>();
    expect(result).toMatchObject({ canceledInvoices: 0, retainedOffers: 1 });
    expect(result.market.offers.find(card => card.id === offer.id)).toEqual(purchased);
    expect(result.market.offers.filter(card => card.prize.id === purchased.prize.id)).toHaveLength(1);
    expect(new Set(result.market.offers.map(card => card.prize.id)).size).toBe(6);
    expect(result.market.offers.filter(card => card.revealedAt)).toHaveLength(1);
    expect((await db.instance.findUniqueOrThrow({ where: { id: instanceId } })).nightRenewPrice?.toFixed(2)).toBe(offer.amount);
    expect(await db.order.findUniqueOrThrow({ where: { id: oldOrder.id } })).toEqual(oldOrder);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('PAID');
    expect(await balance()).toBe(oldBalance);
    expect((await request('POST', '/api/store/orders', cookie, input(offer))).statusCode).toBe(409);
  });

  it('blocks reset while payment is processing and rejects stale or concurrent reset requests', async () => {
    const current = await enable();
    const offer = await reveal(current.offers[0].id);
    const bill = await invoice(offer);
    await db.invoice.update({ where: { id: bill.id }, data: { status: 'PROCESSING' } });
    const busy = await inspect();
    expect(busy.resetBlockedReason).toBe('processing');
    expect((await resetPool(busy)).statusCode).toBe(409);
    expect((await inspect()).offers).toEqual(busy.offers);
    await db.invoice.update({ where: { id: bill.id }, data: { status: 'PENDING' } });
    const ready = await inspect();
    const concurrent = await Promise.all([resetPool(ready), resetPool(ready)]);
    expect(concurrent.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect((await inspect()).offers).toHaveLength(6);
    expect((await resetPool(ready)).statusCode).toBe(409);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('CANCELED');
  });

  it('keeps cards visible but prevents reset after closure, disable, and purchase of all six cards', async () => {
    const current = await enable();
    await save({ ...config, enabled: false });
    const disabled = await inspect();
    expect(disabled).toMatchObject({ state: 'disabled', resetBlockedReason: 'closed' });
    expect(disabled.offers).toHaveLength(6);
    expect((await resetPool(disabled)).statusCode).toBe(409);
    await save();
    await db.nightMarketOffer.updateMany({ where: { pool: { userId, periodId: current.period!.id } }, data: { purchasedAt: new Date() } });
    const purchased = await inspect();
    expect(purchased.resetBlockedReason).toBe('purchased');
    expect((await resetPool(purchased)).statusCode).toBe(409);
    await db.nightMarketPeriod.update({ where: { id: current.period!.id }, data: { closesAt: new Date(Date.now() - 1) } });
    const closed = await inspect();
    expect(closed).toMatchObject({ state: 'closed', resetBlockedReason: 'closed' });
    expect(closed.offers).toHaveLength(6);
    expect((await resetPool(closed)).statusCode).toBe(409);
  });

  it('never charges an orphaned card when payment races with an admin reset', async () => {
    const current = await enable();
    const offer = await reveal(current.offers[0].id);
    const bill = await invoice(offer);
    const before = await inspect();
    const [reset, payment] = await Promise.all([resetPool(before), request('POST', `/api/invoices/${bill.id}/pay`)]);
    expect([200, 409], reset.body).toContain(reset.statusCode);
    expect([200, 409], payment.body).toContain(payment.statusCode);
    const invoiceRow = await db.invoice.findUniqueOrThrow({ where: { id: bill.id } });
    const after = await inspect();
    expect(after.offers).toHaveLength(6);
    if (invoiceRow.status === 'PAID') {
      expect(payment.statusCode).toBe(200);
      expect(after.offers.find(card => card.id === offer.id)).toMatchObject({ purchasedAt: expect.any(String), invoiceId: bill.id, instanceId: invoiceRow.instanceId });
      expect(Number(await balance())).toBeCloseTo(1000 - Number(offer.amount), 2);
    } else {
      expect(invoiceRow.status).toBe('CANCELED');
      expect(reset.statusCode).toBe(200);
      expect(payment.statusCode).toBe(409);
      expect(after.offers.some(card => card.id === offer.id)).toBe(false);
      expect(await balance()).toBe('1000.00');
    }
  });

  it('requires six eligible prizes, a quality guarantee, group capacity and valid scheduling', async () => {
    for (const invalid of [
      { ...config, prizes: config.prizes.slice(0, 5) },
      { ...config, prizes: config.prizes.map(p => ({ ...p, quality: 'DELUXE' })) },
      { ...config, prizes: config.prizes.map(p => ({ ...p, groupKey: 'same-group' })) },
      { ...config, prizes: config.prizes.map(p => ({ ...p, eligibleFromPeriod: 2 })) },
      { ...config, prizes: config.prizes.map(p => ({ ...p, eligibleFromPeriod: 0 })) },
      { ...config, prizes: config.prizes.map(p => ({ ...p, eligibleFromPeriod: 1.5 })) },
      { ...config, prizes: config.prizes.map(p => ({ ...p, enabled: false })) },
      { ...config, activeHours: 25 },
      { ...config, refreshHours: 0 },
      { ...config, prizes: [config.prizes[0], ...config.prizes] },
    ]) expect((await save(invalid as NightConfig)).statusCode).toBe(400);
    await db.plan.updateMany({ where: { id: { in: planIds } }, data: { priceMonthly: 0 } });
    expect((await save()).statusCode).toBe(400);
    expect((await save({ ...config, enabled: false, prizes: [] })).statusCode).toBe(200);
  });

  it('starts at period one and previews the next catalog without manual release batches', async () => {
    const draft = (await request('GET', '/api/admin/night-market', adminCookie)).json();
    expect(draft).toMatchObject({ period: null, draftPeriodNumber: 1 });
    expect(draft.config).not.toHaveProperty('currentAct');
    const first = await enable();
    expect(first.period?.number).toBe(1);
    expect(first.period).not.toHaveProperty('currentAct');
    const next = { ...config, prizes: config.prizes.map(p => ({ ...p, eligibleFromPeriod: 2 })) };
    const saved = await save(next);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ period: { number: 1 }, draftPeriodNumber: 2, eligibleCount: 12 });
    expect((await market()).offers).toEqual(first.offers);
    expect((await db.nightMarketPeriod.findFirstOrThrow()).catalog).toEqual(expect.arrayContaining([expect.objectContaining({ eligibleFromPeriod: 1 })]));
  });

  it('validates guarantee settings and integer probabilities totaling 100, even while disabled', async () => {
    for (const fields of [
      { guaranteeEnabled: 'true' }, { guaranteeCount: 0 }, { guaranteeCount: 7 }, { guaranteeCount: 1.5 },
      { guaranteeQuality: 'INVALID' },
      { qualityProbabilities: { SELECT: 0, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: 0 } },
      { qualityProbabilities: { SELECT: 50, DELUXE: 50, PREMIUM: 1, EXCLUSIVE: 0 } },
      { qualityProbabilities: { SELECT: -1, DELUXE: 51, PREMIUM: 50, EXCLUSIVE: 0 } },
      { qualityProbabilities: { SELECT: 100.5, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: -0.5 } },
      { qualityProbabilities: { SELECT: 25, DELUXE: 25, PREMIUM: 50 } },
    ]) {
      const response = await save({ ...config, enabled: false, drawRules: { ...config.drawRules, ...fields } } as NightConfig);
      expect(response.statusCode, response.body).toBe(400);
    }
    const { drawRules: _rules, ...legacy } = config;
    const response = await request('PUT', '/api/admin/night-market', adminCookie, legacy);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().config.drawRules).toEqual(defaultNightDrawRules());
  });

  it('allows disabling or changing the guarantee and rejects impossible quality or group capacity', async () => {
    const deluxeOnly = config.prizes.map(p => ({ ...p, quality: 'DELUXE' as const }));
    expect((await save({ ...config, prizes: deluxeOnly })).statusCode).toBe(400);
    config.prizes = deluxeOnly;
    config.drawRules.guaranteeEnabled = false;
    const noGuarantee = await enable();
    expect(noGuarantee.offers.every(card => card.quality === 'DELUXE')).toBe(true);
    expect(noGuarantee.period?.drawRules.guaranteeEnabled).toBe(false);
    const custom = { ...config.drawRules, guaranteeEnabled: true, guaranteeCount: 6, guaranteeQuality: 'DELUXE' as const };
    expect((await save({ ...config, drawRules: custom })).statusCode).toBe(200);
    expect((await save({ ...config, drawRules: { ...custom, guaranteeQuality: 'PREMIUM' } })).statusCode).toBe(400);
    // 六个卓越奖品都在同一组，原始数量足够，但最多只能贡献两个保底名额。
    const constrained = config.prizes.map((p, i) => ({ ...p, quality: i < 6 ? 'PREMIUM' as const : 'SELECT' as const, groupKey: i < 6 ? 'guaranteed' : `other-${i}` }));
    expect((await save({ ...config, prizes: constrained, drawRules: { ...custom, guaranteeCount: 3, guaranteeQuality: 'PREMIUM' } })).statusCode).toBe(400);
    expect((await save({ ...config, prizes: constrained, drawRules: { ...custom, guaranteeCount: 2, guaranteeQuality: 'PREMIUM' } })).statusCode).toBe(200);
    const excluded = { ...custom, guaranteeCount: 2, guaranteeQuality: 'PREMIUM' as const, qualityProbabilities: { SELECT: 50, DELUXE: 50, PREMIUM: 0, EXCLUSIVE: 0 } };
    expect((await save({ ...config, prizes: constrained, drawRules: excluded })).statusCode).toBe(400);
    expect((await save({ ...config, prizes: constrained, drawRules: { ...excluded, guaranteeEnabled: false } })).statusCode).toBe(200);
  });

  it('freezes draw rules for existing and first-time visitors, and applies changes next period', async () => {
    const current = await enable();
    const originalRules = structuredClone(config.drawRules);
    config.prizes = config.prizes.map(p => ({ ...p, quality: 'EXCLUSIVE' }));
    config.drawRules = { guaranteeEnabled: true, guaranteeCount: 6, guaranteeQuality: 'EXCLUSIVE', qualityProbabilities: { SELECT: 0, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: 100 } };
    const saved = await save();
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json().config.drawRules).toEqual(config.drawRules);
    expect(saved.json().period.drawRules).toEqual(originalRules);
    expect((await market()).offers).toEqual(current.offers);
    const late = await market(otherCookie);
    expect(late.period?.drawRules).toEqual(originalRules);
    expect(late.offers.filter(p => nightHighQuality(p.quality)).length).toBeGreaterThanOrEqual(2);
    expect(late.offers.some(p => p.quality !== 'EXCLUSIVE')).toBe(true); // 原始快照只有一个典藏奖品。
    await save({ ...config, enabled: false });
    await save();
    expect((await market()).period?.drawRules).toEqual(originalRules);
    await db.nightMarketPeriod.update({ where: { id: current.period!.id }, data: { closesAt: new Date(Date.now() - 2000), refreshAt: new Date(Date.now() - 1000) } });
    const next = await market();
    expect(next.period?.number).toBe(2);
    expect(next.period?.drawRules).toEqual(config.drawRules);
    expect(next.offers.every(p => p.quality === 'EXCLUSIVE')).toBe(true);
  });

  it('upgrades old settings and uses default rules for old periods without changing existing cards', async () => {
    const { drawRules: _rules, ...legacy } = config;
    await db.setting.create({ data: { key: 'nightMarket', value: legacy as unknown as Prisma.InputJsonValue } });
    expect((await service.getNightConfig()).drawRules).toEqual(defaultNightDrawRules());
    const current = await market();
    const { Prisma } = await import('../src/lib/prisma.ts');
    await db.nightMarketPeriod.update({ where: { id: current.period!.id }, data: { drawRules: Prisma.DbNull } });
    config.prizes = config.prizes.map(p => ({ ...p, quality: 'EXCLUSIVE' }));
    config.drawRules = { guaranteeEnabled: true, guaranteeCount: 6, guaranteeQuality: 'EXCLUSIVE', qualityProbabilities: { SELECT: 0, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: 100 } };
    expect((await save()).statusCode).toBe(200);
    expect((await market()).offers).toEqual(current.offers);
    const late = await market(otherCookie);
    expect(late.period?.drawRules).toEqual(defaultNightDrawRules());
    expect(late.offers.some(p => p.quality !== 'EXCLUSIVE')).toBe(true);
  });

  it('honors configured probabilities independently of prize counts and renormalizes unavailable qualities', async () => {
    await enable();
    const base = (await db.nightMarketPeriod.findFirstOrThrow()).catalog as unknown as NightPrizeSnapshot[];
    const catalog = Array.from({ length: 38 }, (_, i) => ({ ...base[0], id: `weighted-${i}`, groupKey: `weighted-${i}`, quality: i < 30 ? 'SELECT' as const : 'EXCLUSIVE' as const }));
    const rules = { ...defaultNightDrawRules(), guaranteeEnabled: false, qualityProbabilities: { SELECT: 20, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: 80 } };
    let exclusive = 0;
    for (let run = 0; run < 400; run++) {
      const prizes = service.drawNightPrizes(catalog, rules).map(card => card.snapshot as unknown as NightPrizeSnapshot);
      expect(new Set(prizes.map(p => p.id)).size).toBe(6);
      exclusive += prizes.filter(p => p.quality === 'EXCLUSIVE').length;
    }
    // 2400 张卡约有 1920 张典藏；宽容区间远离按奖品数量抽取的约 505 张。
    expect(exclusive).toBeGreaterThan(1750);
    expect(exclusive).toBeLessThan(2090);
    const onlyExclusive = { ...rules, qualityProbabilities: { SELECT: 0, DELUXE: 50, PREMIUM: 0, EXCLUSIVE: 50 } };
    expect(service.drawNightPrizes(catalog, onlyExclusive).every(card => (card.snapshot as unknown as NightPrizeSnapshot).quality === 'EXCLUSIVE')).toBe(true);
    const sparse = catalog.slice(0, 6);
    expect(() => service.drawNightPrizes(sparse, onlyExclusive)).toThrow();
  });

  it('completes tight catalogs with guarantees from one to six without duplicates or group overflow', async () => {
    await enable();
    const base = (await db.nightMarketPeriod.findFirstOrThrow()).catalog as unknown as NightPrizeSnapshot[];
    for (let count = 1; count <= 6; count++) {
      // 每组包含一个必须保留的高品质奖品和多个低品质候选，不能过早用完该组名额。
      const catalog = base.map((p, i) => ({ ...p, groupKey: `tight-${Math.floor(i / 4)}`, quality: i % 4 < 2 ? 'EXCLUSIVE' as const : 'SELECT' as const }));
      const rules = { ...defaultNightDrawRules(), guaranteeCount: count, guaranteeQuality: 'EXCLUSIVE' as const, qualityProbabilities: { SELECT: 99, DELUXE: 0, PREMIUM: 0, EXCLUSIVE: 1 } };
      for (let run = 0; run < 20; run++) {
        const prizes = service.drawNightPrizes(catalog, rules).map(card => card.snapshot as unknown as NightPrizeSnapshot);
        expect(prizes).toHaveLength(6);
        expect(new Set(prizes.map(p => p.id)).size).toBe(6);
        expect(prizes.filter(p => p.quality === 'EXCLUSIVE').length).toBeGreaterThanOrEqual(count);
        for (const key of new Set(prizes.map(p => p.groupKey))) expect(prizes.filter(p => p.groupKey === key).length).toBeLessThanOrEqual(2);
      }
    }
  });

  it('validates individual discount ranges and modes including inclusive fixed discounts', async () => {
    for (const fields of [
      { discountMin: 0 }, { discountMax: 100 }, { discountMin: 1.5 }, { discountMax: 20.5 },
      { discountMin: 50, discountMax: 49 }, { discountMode: 'INVALID' },
    ]) {
      const result = await save({ ...config, prizes: config.prizes.map(p => ({ ...p, ...fields })) } as NightConfig);
      expect(result.statusCode, result.body).toBe(400);
    }
    config.prizes = config.prizes.map((p, i) => ({ ...p, discountMin: i % 2 ? 34 : 23, discountMax: i % 2 ? 37 : 23, discountMode: i % 2 ? 'RECURRING' : 'ONCE' }));
    await enable();
    const catalog = (await db.nightMarketPeriod.findFirstOrThrow()).catalog as unknown as NightPrizeSnapshot[];
    const seen = new Set<number>();
    for (let run = 0; run < 100; run++) {
      for (const card of service.drawNightPrizes(catalog)) {
        const prize = card.snapshot as unknown as NightPrizeSnapshot;
        expect(card.discountPercent).toBeGreaterThanOrEqual(prize.discountMin);
        expect(card.discountPercent).toBeLessThanOrEqual(prize.discountMax);
        expect(Number(card.amount)).toBeCloseTo(20 * (100 - card.discountPercent) / 100, 2);
        if (prize.discountMin === 23) expect(card.discountPercent).toBe(23);
        else seen.add(card.discountPercent);
      }
    }
    expect([...seen].sort()).toEqual([34, 35, 36, 37]);
  });

  it('defaults legacy configuration and frozen snapshots to first-term 10–49% without redrawing', async () => {
    const strip = <T extends object>(prize: T) => {
      const { discountMin: _min, discountMax: _max, discountMode: _mode, ...rest } = prize as T & { discountMin?: number; discountMax?: number; discountMode?: string };
      return rest;
    };
    const legacy = { ...config, prizes: config.prizes.map(strip) };
    await db.setting.create({ data: { key: 'nightMarket', value: legacy as unknown as Prisma.InputJsonValue } });
    const upgraded = await service.getNightConfig();
    expect(upgraded.prizes.every(p => p.discountMin === 10 && p.discountMax === 49 && p.discountMode === 'ONCE')).toBe(true);
    expect((await db.setting.findUniqueOrThrow({ where: { key: 'nightMarket' } })).value).toEqual(upgraded);
    const pool = await market();
    const rows = await db.nightMarketOffer.findMany();
    const period = await db.nightMarketPeriod.findFirstOrThrow();
    await db.nightMarketPeriod.update({ where: { id: period.id }, data: { catalog: (period.catalog as unknown as NightPrizeSnapshot[]).map(strip) } });
    for (const row of rows) await db.nightMarketOffer.update({ where: { id: row.id }, data: { snapshot: strip(row.snapshot as unknown as NightPrizeSnapshot) } });
    const card = await reveal(pool.offers[0].id);
    expect(card.prize).toMatchObject({ discountMin: 10, discountMax: 49, discountMode: 'ONCE' });
    expect(card.discountPercent).toBe(rows[0].discountPercent);
    const late = await market(otherCookie);
    expect((await reveal(late.offers[0].id, otherCookie)).prize?.discountMode).toBe('ONCE');
    const bill = await invoice(card);
    expect(bill.nightMarket?.discountMode).toBe('ONCE');
  });

  it('automatically admits scheduled prizes when their first eligible period arrives', async () => {
    config.prizes[10].eligibleFromPeriod = 2;
    config.prizes[11].eligibleFromPeriod = 3;
    const first = await enable();
    expect(first.period?.number).toBe(1);
    expect((await db.nightMarketPeriod.findUniqueOrThrow({ where: { id: first.period!.id } })).catalog).toHaveLength(10);
    const advance = async (id: number) => db.nightMarketPeriod.update({ where: { id }, data: { closesAt: new Date(Date.now() - 2000), refreshAt: new Date(Date.now() - 1000) } });
    await advance(first.period!.id);
    const second = await market();
    expect(second.period?.number).toBe(2);
    const secondCatalog = (await db.nightMarketPeriod.findUniqueOrThrow({ where: { id: second.period!.id } })).catalog as unknown as NightPrizeSnapshot[];
    expect(secondCatalog).toHaveLength(11);
    expect(secondCatalog.some(p => p.id === config.prizes[10].id)).toBe(true);
    expect(secondCatalog.some(p => p.id === config.prizes[11].id)).toBe(false);
    await advance(second.period!.id);
    const third = await market();
    expect(third.period?.number).toBe(3);
    expect((await db.nightMarketPeriod.findUniqueOrThrow({ where: { id: third.period!.id } })).catalog).toHaveLength(12);
  });

  it('counts elapsed periods without creating pools for skipped periods', async () => {
    config.startsAt = new Date(Date.now() - 72 * 3600_000 - 60_000).toISOString();
    const current = await enable();
    expect(current.period?.number).toBe(4);
    expect(await db.nightMarketPeriod.count()).toBe(1);
    expect(await db.nightMarketPool.count()).toBe(1);
    expect(current.offers).toHaveLength(6);
  });

  it('upgrades legacy zero-based batches once and preserves eligibility as periods advance', async () => {
    const legacy = { ...config, currentAct: 2, prizes: config.prizes.map(({ eligibleFromPeriod: _eligible, ...prize }, index) => ({ ...prize, releaseAct: index === 10 ? 1 : index === 11 ? 2 : 0 })) };
    await db.setting.create({ data: { key: 'nightMarket', value: legacy as unknown as Prisma.InputJsonValue } });
    const upgraded = await service.getNightConfig();
    expect(upgraded).not.toHaveProperty('currentAct');
    expect(upgraded.prizes[0]).toMatchObject({ eligibleFromPeriod: 1 });
    expect(upgraded.prizes[0]).not.toHaveProperty('releaseAct');
    expect(upgraded.prizes[10].eligibleFromPeriod).toBe(2);
    expect(upgraded.prizes[11].eligibleFromPeriod).toBe(3);
    expect((await db.setting.findUniqueOrThrow({ where: { key: 'nightMarket' } })).value).toEqual(upgraded);
    const first = await market();
    expect(first.period?.number).toBe(1);
    await db.nightMarketPeriod.update({ where: { id: first.period!.id }, data: { refreshAt: new Date(Date.now() - 1000), closesAt: new Date(Date.now() - 2000) } });
    expect((await market()).period?.number).toBe(2);
    expect(await service.getNightConfig()).toEqual(upgraded);
    const catalog = (await db.nightMarketPeriod.findFirstOrThrow({ orderBy: { number: 'desc' } })).catalog as unknown as NightPrizeSnapshot[];
    expect(catalog.some(p => p.id === config.prizes[10].id)).toBe(true);
    expect(catalog.some(p => p.id === config.prizes[11].id)).toBe(false);
  });

  it('draws six unique cards with at least two high qualities, at most two per group and independent discounts', async () => {
    await enable();
    const period = await db.nightMarketPeriod.findFirstOrThrow();
    const catalog = period.catalog as unknown as NightPrizeSnapshot[];
    const fingerprints = new Set<string>();
    for (let run = 0; run < 300; run++) {
      const draw = service.drawNightPrizes(catalog);
      const prizes = draw.map(card => card.snapshot as unknown as NightPrizeSnapshot);
      expect(prizes).toHaveLength(6);
      expect(new Set(prizes.map(p => p.id)).size).toBe(6);
      expect(prizes.filter(p => nightHighQuality(p.quality)).length).toBeGreaterThanOrEqual(2);
      for (const group of new Set(prizes.map(p => p.groupKey))) expect(prizes.filter(p => p.groupKey === group).length).toBeLessThanOrEqual(2);
      for (const card of draw) {
        expect(card.discountPercent).toBeGreaterThanOrEqual(10); expect(card.discountPercent).toBeLessThanOrEqual(49);
        expect(Number(card.amount.toString())).toBeCloseTo(20 * (100 - card.discountPercent) / 100, 2);
      }
      fingerprints.add(JSON.stringify(draw));
    }
    expect(fingerprints.size).toBeGreaterThan(295);
    // A tight catalog with both guaranteed cards in the same group must still fill all six slots.
    const tight = catalog.slice(0, 6).map((p, i) => ({ ...p, groupKey: `tight-${Math.floor(i / 2)}`, quality: i < 2 ? 'PREMIUM' as const : 'SELECT' as const }));
    for (let i = 0; i < 25; i++) expect(service.drawNightPrizes(tight)).toHaveLength(6);
  });

  it('persists one pool under concurrent visits, hides sealed contents, and isolates users', async () => {
    await save();
    const results = await Promise.all(Array.from({ length: 6 }, () => market()));
    for (const result of results) expect(result.offers).toEqual(results[0].offers);
    expect(await db.nightMarketPool.count({ where: { userId } })).toBe(1);
    for (const offer of results[0].offers) {
      expect(offer).not.toHaveProperty('prize'); expect(offer).not.toHaveProperty('amount'); expect(offer).not.toHaveProperty('discountPercent');
    }
    const other = await market(otherCookie);
    expect(other.offers.map(p => p.id)).not.toEqual(results[0].offers.map(p => p.id));
    const id = results[0].offers[0].id;
    expect((await request('POST', `/api/night-market/offers/${id}/reveal`, otherCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/night-market/offers/${id}`, otherCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/night-market/offers/${id}`)).statusCode).toBe(400);
    const [a, b] = await Promise.all([reveal(id), reveal(id)]);
    expect(a).toEqual(b);
    expect((await market()).offers[0]).toEqual(a);
    expect((await market(otherCookie)).offers.every(offer => !offer.revealedAt)).toBe(true);
  });

  it('excludes future and disabled prizes without excluding already-owned plans', async () => {
    config.prizes[10].eligibleFromPeriod = 2; config.prizes[11].eligibleFromPeriod = 3; config.prizes[9].enabled = false;
    await enable();
    const period = await db.nightMarketPeriod.findFirstOrThrow();
    const catalog = period.catalog as unknown as NightPrizeSnapshot[];
    expect(catalog).toHaveLength(9);
    expect(catalog.every(p => p.eligibleFromPeriod === 1 && p.enabled)).toBe(true);
    const original = await market();
    const offer = await reveal(original.offers[0].id);
    const bill = await invoice(offer);
    expect((await request('POST', `/api/invoices/${bill.id}/pay`)).statusCode).toBe(200);
    const paidPlan = offer.prize!.planId;
    expect((period.catalog as unknown as NightPrizeSnapshot[]).some(p => p.planId === paidPlan)).toBe(true);
    expect((await market()).offers[0].prize?.planId).toBe(paidPlan);
  });

  it('freezes the catalog, prices and timing until next period, including for later visitors', async () => {
    const current = await enable();
    const originalCatalog = (await db.nightMarketPeriod.findFirstOrThrow()).catalog;
    await db.plan.updateMany({ where: { id: { in: planIds } }, data: { priceMonthly: 30 } });
    const next = { ...config, refreshHours: 48, activeHours: 24, prizes: config.prizes.map(p => ({ ...p, name: 'Changed', quality: 'EXCLUSIVE' as const, eligibleFromPeriod: 2, discountMin: 50, discountMax: 50, discountMode: 'RECURRING' as const })) };
    expect((await save(next)).statusCode).toBe(200);
    expect((await db.nightMarketPeriod.findFirstOrThrow()).catalog).toEqual(originalCatalog);
    expect((await market()).period).toEqual(current.period);
    const late = await market(otherCookie);
    const lateCard = await reveal(late.offers[0].id, otherCookie);
    expect(lateCard.prize?.name).not.toBe('Changed'); expect(lateCard.prize?.originalPrice).toBe('20.00');
    expect(lateCard.prize).toMatchObject({ discountMin: 10, discountMax: 49, discountMode: 'ONCE' });
    await db.nightMarketPeriod.update({ where: { id: current.period!.id }, data: { startsAt: new Date(Date.now() - 200 * 3600_000), closesAt: new Date(Date.now() - 190 * 3600_000), refreshAt: new Date(Date.now() - 144 * 3600_000 - 60_000) } });
    const refreshed = await market();
    expect(refreshed.state).toBe('open'); expect(refreshed.period?.id).not.toBe(current.period?.id);
    expect(refreshed.period?.number).toBe(5);
    expect(new Date(refreshed.period!.refreshAt).getTime() - new Date(refreshed.period!.startsAt).getTime()).toBe(48 * 3600_000);
    const newCard = await reveal(refreshed.offers[0].id);
    expect(newCard.prize).toMatchObject({ name: 'Changed', originalPrice: '30.00', discountMin: 50, discountMax: 50, discountMode: 'RECURRING' });
    expect(newCard.discountPercent).toBe(50);
  });

  it('supports scheduled, closed and unavailable states and preserves cards across disable/re-enable', async () => {
    const future = { ...config, startsAt: new Date(Date.now() + 3600_000).toISOString() };
    expect((await save(future)).statusCode).toBe(200);
    expect(await market()).toMatchObject({ state: 'scheduled', offers: [], nextStartsAt: future.startsAt });
    await save();
    const open = await market();
    const revealed = await reveal(open.offers[0].id);
    expect((await save({ ...config, enabled: false })).statusCode).toBe(200);
    expect((await market()).state).toBe('disabled');
    expect((await request('POST', `/api/night-market/offers/${revealed.id}/reveal`)).statusCode).toBe(409);
    expect((await save()).statusCode).toBe(200);
    expect((await market()).offers[0]).toEqual(revealed);
    await db.nightMarketPeriod.update({ where: { id: open.period!.id }, data: { closesAt: new Date(Date.now() - 1) } });
    expect((await market()).state).toBe('closed');
    expect((await request('POST', `/api/night-market/offers/${open.offers[1].id}/reveal`)).statusCode).toBe(409);
    await db.plan.updateMany({ where: { id: { in: planIds } }, data: { enabled: false } });
    await db.nightMarketPeriod.update({ where: { id: open.period!.id }, data: { refreshAt: new Date(Date.now() - 1) } });
    expect((await market()).state).toBe('unavailable');
  });

  it('creates one fixed-price invoice without charging, rejects misuse, and rebinds canceled invoices', async () => {
    const pool = await enable();
    const sealed = pool.offers[0];
    const stored = await db.nightMarketOffer.findUniqueOrThrow({ where: { id: sealed.id } });
    const guessed = { ...sealed, prize: stored.snapshot as unknown as NightPrizeSnapshot };
    expect((await request('POST', '/api/store/orders', cookie, input(guessed))).statusCode).toBe(400);
    const offer = await reveal(sealed.id);
    expect((await request('POST', '/api/store/orders', otherCookie, input(offer))).statusCode).toBe(404);
    expect((await request('POST', '/api/store/orders', cookie, input(offer, { couponCode: 'ANY' }))).statusCode).toBe(400);
    expect((await request('POST', '/api/store/orders', cookie, input(offer, { cycle: 'ANNUAL' }))).statusCode).toBe(400);
    const differentPlan = planIds.find(id => id !== offer.prize!.planId)!;
    expect((await request('POST', '/api/store/orders', cookie, input(offer, { planId: differentPlan }))).statusCode).toBe(400);
    const [a, b] = await Promise.all([invoice(offer), invoice(offer)]);
    expect(a.id).toBe(b.id); expect(a.amount).toBe(offer.amount);
    expect(a.nightMarket).toMatchObject({ name: offer.prize!.name, quality: offer.quality, discountPercent: offer.discountPercent, periodId: pool.period!.id });
    expect(await balance()).toBe('1000.00');
    expect((await db.nightMarketOffer.findUniqueOrThrow({ where: { id: offer.id } })).purchasedAt).toBeNull();
    expect(a.expiresAt && new Date(a.expiresAt).getTime()).toBeLessThanOrEqual(new Date(pool.period!.closesAt).getTime());
    expect((await market()).offers[0].invoiceId).toBe(a.id);
    expect((await request('POST', `/api/invoices/${a.id}/cancel`)).statusCode).toBe(200);
    const replacement = await invoice(offer);
    expect(replacement.id).not.toBe(a.id);
    expect((await request('POST', `/api/invoices/${a.id}/pay`)).statusCode).toBe(409);
    expect((await market()).offers[0].invoiceId).toBe(replacement.id);
  });

  it('charges the frozen first-term price once, leaves normal renewal pricing, and survives payment response retries', async () => {
    const pool = await enable();
    const offer = await reveal(pool.offers[0].id);
    await db.plan.update({ where: { id: offer.prize!.planId }, data: { priceMonthly: 30 } });
    const bill = await invoice(offer);
    expect(bill.amount).toBe(offer.amount);
    const results = await Promise.all([request('POST', `/api/invoices/${bill.id}/pay`), request('POST', `/api/invoices/${bill.id}/pay`)]);
    for (const res of results) expect(res.statusCode, res.body).toBe(200);
    const paid = results[0].json<InvoiceDTO>();
    expect(paid.status).toBe('PAID');
    expect(Number(await balance())).toBeCloseTo(1000 - Number(offer.amount), 2);
    const inst = await db.instance.findUniqueOrThrow({ where: { id: paid.instanceId! } });
    expect(inst.price.toFixed(2)).toBe('30.00');
    expect(inst.nightRenewPrice).toBeNull();
    const order = await db.order.findFirstOrThrow({ where: { instanceId: paid.instanceId! } });
    expect(order.amount.toFixed(2)).toBe(offer.amount); expect(Number(order.discount)).toBeCloseTo(20 - Number(offer.amount), 2);
    expect((await request('POST', '/api/store/orders', cookie, input(offer))).statusCode).toBe(409);
    expect((await market()).offers[0]).toMatchObject({ purchasedAt: expect.any(String), instanceId: paid.instanceId });
    const before = await balance();
    // Simulate a committed purchase whose final invoice response/update was interrupted.
    await db.invoice.update({ where: { id: bill.id }, data: { status: 'PENDING', instanceId: null, paidAt: null } });
    expect((await request('POST', `/api/invoices/${bill.id}/pay`)).statusCode).toBe(200);
    expect(await balance()).toBe(before);
    expect(await db.order.count({ where: { instanceId: paid.instanceId! } })).toBe(1);
    await db.instance.update({ where: { id: inst.id }, data: { status: 'RUNNING', provisionedAt: new Date() } });
    const renewal = await (await import('../src/services/invoices.ts')).createRenewInvoice(userId, inst.id, 2);
    expect(renewal.amount.toFixed(2)).toBe('60.00');
    expect(renewal.discount.toFixed(2)).toBe('0.00');
  });

  it('allows all six prizes once each, including concurrent payments on different hosts', async () => {
    const pool = await enable();
    const cards = await Promise.all(pool.offers.slice(0, 3).map(card => reveal(card.id)));
    const bills = await Promise.all(cards.map((card, i) => invoice(card, { nodeId: i === 1 ? secondNodeId : nodeId })));
    const count = await db.instance.count();
    const orderCount = await db.order.count();
    const results = await Promise.all(bills.slice(0, 2).map(bill => request('POST', `/api/invoices/${bill.id}/pay`)));
    for (const result of results) expect(result.statusCode, result.body).toBe(200);
    expect(await db.instance.count()).toBe(count + 2);
    expect(await db.order.count()).toBe(orderCount + 2);
    expect(Number(await balance())).toBeCloseTo(1000 - Number(bills[0].amount) - Number(bills[1].amount), 2);
    // 购买其他奖品不能取消或阻止这张已生成的待支付账单。
    expect((await db.invoice.findUniqueOrThrow({ where: { id: bills[2].id } })).status).toBe('PENDING');
    const refreshed = await market();
    expect(refreshed.offers.filter(card => card.purchasedAt)).toHaveLength(2);
    expect(refreshed.offers.find(card => card.id === cards[2].id)).toMatchObject({ purchasedAt: null, invoiceId: bills[2].id });
    expect((await request('GET', `/api/night-market/offers/${cards[2].id}`)).statusCode).toBe(200);
    expect((await invoice(cards[2])).id).toBe(bills[2].id);
    // 只阻止已购奖品再次下单；重试成功账单仍返回原结果且不重复扣款。
    for (const card of cards.slice(0, 2)) {
      expect((await request('GET', `/api/night-market/offers/${card.id}`)).statusCode).toBe(409);
      expect((await request('POST', '/api/store/orders', cookie, input(card))).statusCode).toBe(409);
    }
    const beforeRetry = await balance();
    expect((await request('POST', `/api/invoices/${bills[0].id}/pay`)).statusCode).toBe(200);
    expect(await balance()).toBe(beforeRetry);
    const remainingCards = await Promise.all(pool.offers.slice(3).map(card => reveal(card.id)));
    const remainingBills = await Promise.all(remainingCards.map(card => invoice(card)));
    const remainingResults = await Promise.all([bills[2], ...remainingBills].map(bill => request('POST', `/api/invoices/${bill.id}/pay`)));
    for (const result of remainingResults) expect(result.statusCode, result.body).toBe(200);
    expect(await db.instance.count()).toBe(count + 6);
    expect(await db.order.count()).toBe(orderCount + 6);
    expect(Number(await balance())).toBeCloseTo(1000 - [...bills, ...remainingBills].reduce((total, bill) => total + Number(bill.amount), 0), 2);
    expect((await market()).offers.every(card => card.purchasedAt && card.instanceId)).toBe(true);
    expect((await market(otherCookie)).offers.every(card => !card.purchasedAt)).toBe(true);
  });

  it('keeps the same prize available to other users and when drawn again next period', async () => {
    config.prizes = config.prizes.slice(0, 6).map((prize, i) => ({ ...prize, groupKey: `group-${Math.floor(i / 2)}` }));
    const pool = await enable();
    const offer = await reveal(pool.offers[0].id);
    const bill = await invoice(offer);
    expect((await request('POST', `/api/invoices/${bill.id}/pay`)).statusCode).toBe(200);
    const otherPool = await market(otherCookie);
    const otherCards = await Promise.all(otherPool.offers.map(card => reveal(card.id, otherCookie)));
    const otherCard = otherCards.find(card => card.prize!.id === offer.prize!.id)!;
    await db.user.update({ where: { id: otherId }, data: { balance: 1000 } });
    const otherOrder = await request('POST', '/api/store/orders', otherCookie, input(otherCard));
    expect(otherOrder.statusCode, otherOrder.body).toBe(200);
    const otherBill = otherOrder.json<{ invoice: InvoiceDTO }>().invoice;
    expect((await request('POST', `/api/invoices/${otherBill.id}/pay`, otherCookie)).statusCode).toBe(200);
    await db.nightMarketPeriod.update({ where: { id: pool.period!.id }, data: { closesAt: new Date(Date.now() - 2000), refreshAt: new Date(Date.now() - 1000) } });
    const next = await market();
    expect(next.period!.id).not.toBe(pool.period!.id);
    expect(next.offers.every(card => !card.purchasedAt)).toBe(true);
    const nextCards = await Promise.all(next.offers.map(card => reveal(card.id)));
    const nextCard = nextCards.find(card => card.prize!.id === offer.prize!.id)!;
    const nextBill = await invoice(nextCard);
    expect((await request('POST', `/api/invoices/${nextBill.id}/pay`)).statusCode).toBe(200);
    expect((await market()).offers.find(card => card.id === nextCard.id)!.purchasedAt).not.toBeNull();
  });

  it('binds the fixed recurring price for manual and automatic renewals without coupon stacking', async () => {
    config.prizes = config.prizes.map(p => ({ ...p, discountMin: 37, discountMax: 37, discountMode: 'RECURRING' }));
    const pool = await enable();
    const offer = await reveal(pool.offers[0].id);
    expect(offer.amount).toBe('12.60');
    const bill = await invoice(offer);
    expect(bill.nightMarket?.discountMode).toBe('RECURRING');
    expect(bill.discountSource).toBe('NIGHT_MARKET');
    await db.plan.update({ where: { id: offer.prize!.planId }, data: { priceMonthly: 30 } });
    const result = await request('POST', `/api/invoices/${bill.id}/pay`);
    expect(result.statusCode, result.body).toBe(200);
    const id = result.json<InvoiceDTO>().instanceId!;
    const inst = await db.instance.update({ where: { id }, data: { status: 'RUNNING', provisionedAt: new Date() } });
    expect(inst.price.toFixed(2)).toBe('20.00');
    expect(inst.nightRenewPrice?.toFixed(2)).toBe('12.60');
    const pricing = await import('../src/services/coupons.ts');
    expect(pricing.renewalPrice(inst).toFixed(2)).toBe('12.60');
    const { toInstance, instanceInclude } = await import('../src/services/serializers.ts');
    expect(toInstance(await db.instance.findUniqueOrThrow({ where: { id }, include: instanceInclude }))).toMatchObject({ price: '20.00', renewPrice: '12.60', nightRenewPrice: '12.60', renewCoupon: null });
    const invoiceService = await import('../src/services/invoices.ts');
    await expect(invoiceService.createRenewInvoice(userId, id, 2, 'ANY')).rejects.toMatchObject({ statusCode: 400 });
    expect((await request('POST', '/api/store/coupon', cookie, { kind: 'RENEW', code: 'ANY', instanceId: id, periods: 2 })).statusCode).toBe(400);
    const renewal = await invoiceService.createRenewInvoice(userId, id, 3);
    expect(renewal.amount.toFixed(2)).toBe('37.80');
    expect(renewal.discount.toFixed(2)).toBe('22.20');
    expect((await invoiceService.getInvoiceDetail(renewal.id, userId)).discountSource).toBe('NIGHT_MARKET');
    const before = Number(await balance());
    expect((await request('POST', `/api/invoices/${renewal.id}/pay`)).statusCode).toBe(200);
    expect(Number(await balance())).toBeCloseTo(before - 37.8, 2);
    const billing = await import('../src/services/billing.ts');
    await expect(billing.renew(id, 1, { userId, couponCode: 'ANY' })).rejects.toMatchObject({ statusCode: 400 });
    // Changing the future catalog or closing the market cannot remove a sold recurring discount.
    await save({ ...config, enabled: false, prizes: config.prizes.map(p => ({ ...p, discountMode: 'ONCE', discountMin: 10, discountMax: 10 })) });
    await billing.renew(id, 2, { userId, auto: true });
    expect(Number(await balance())).toBeCloseTo(before - 37.8 - 25.2, 2);
    const orders = await db.order.findMany({ where: { instanceId: id, type: 'RENEW' }, orderBy: { id: 'asc' } });
    expect(orders.map(o => [o.amount.toFixed(2), o.discount.toFixed(2)])).toEqual([['37.80', '22.20'], ['25.20', '14.80']]);
    expect(orders.every(o => o.couponId === null)).toBe(true);
    expect(orders.every(o => o.discountSource === 'NIGHT_MARKET')).toBe(true);
    const updated = await db.instance.findUniqueOrThrow({ where: { id } });
    expect(updated.nightRenewPrice?.toFixed(2)).toBe('12.60');
    const newAutoInvoice = await invoiceService.createRenewInvoice(userId, id, 1);
    expect(newAutoInvoice.amount.toFixed(2)).toBe('12.60');
    const { renewalEstimate } = await import('../../web/src/lib/renewal.ts');
    expect(renewalEstimate(toInstance(await db.instance.findUniqueOrThrow({ where: { id }, include: instanceInclude })), 3, '100', null)).toMatchObject({ original: 60, total: 37.8, discount: 22.2 });
    await db.nightMarketPeriod.delete({ where: { id: pool.period!.id } });
    const adminDetail = await request('GET', `/api/admin/billing/invoices/${renewal.id}`, adminCookie);
    expect(adminDetail.statusCode, adminDetail.body).toBe(200);
    expect(adminDetail.json()).toMatchObject({ status: 'PAID', discountSource: 'NIGHT_MARKET', discount: '22.20' });
  });

  it('does not consume a card on insufficient funds, stock failure, disable, or expiry', async () => {
    const pool = await enable();
    const offer = await reveal(pool.offers[0].id);
    const bill = await invoice(offer);
    const pay = () => request('POST', `/api/invoices/${bill.id}/pay`);
    await db.user.update({ where: { id: userId }, data: { balance: 0 } });
    expect((await pay()).statusCode).toBe(402);
    expect((await db.nightMarketOffer.findUniqueOrThrow({ where: { id: offer.id } })).purchasedAt).toBeNull();
    expect((await market()).offers.every(card => !card.purchasedAt)).toBe(true);
    await db.user.update({ where: { id: userId }, data: { balance: 1000 } });
    await db.plan.update({ where: { id: offer.prize!.planId }, data: { stock: 0 } });
    expect((await pay()).statusCode).toBe(409);
    await db.plan.update({ where: { id: offer.prize!.planId }, data: { stock: null } });
    await save({ ...config, enabled: false }); expect((await pay()).statusCode).toBe(409);
    await save();
    await db.nightMarketPeriod.update({ where: { id: pool.period!.id }, data: { closesAt: new Date(Date.now() - 1) } });
    expect((await pay()).statusCode).toBe(409);
    expect(await balance()).toBe('1000.00');
    expect((await db.nightMarketOffer.findUniqueOrThrow({ where: { id: offer.id } })).purchasedAt).toBeNull();
    expect((await db.invoice.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('PENDING');
  });
});

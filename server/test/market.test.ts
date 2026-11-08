import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

describe('marketplace', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let runTask: typeof import('../src/services/operations.ts').runTask;
  let directory: string;
  let adminCookie: string;
  let sellerCookie: string;
  let buyerCookie: string;
  let otherCookie: string;
  let sellerId: number;
  let buyerId: number;
  let otherId: number;
  let nodeId: number;
  let imageId: number;
  let planId: number;
  let requestNumber = 0;
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.4.0.${(++requestNumber % 250) + 1}`, headers: { 'x-requested-with': 'XMLHttpRequest', cookie } });
  const balanceOf = async (id: number) => (await db.user.findUniqueOrThrow({ where: { id } })).balance.toFixed(2);

  /** 为卖家创建一台已开通的实例 */
  const makeInstance = async (hostname: string, over: Record<string, unknown> = {}) => {
    const res = await request('POST', '/api/admin/instances', adminCookie, {
      userId: sellerId, nodeId, type: 'LXC_NAT', imageId, hostname, planId,
      cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 500, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 1,
      portLimit: 5, siteLimit: 1, snapshotLimit: 1, billingCycle: 'MONTHLY', price: '5.00',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: true, ...over,
    });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().instanceId as number;
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
    return id;
  };
  const list = async (id: number, price: number | string, extra: object = {}, cookie = sellerCookie) => {
    const res = await request('POST', '/api/market/listings', cookie, { instanceId: id, price, ...extra });
    // 挂牌后实例会自动关机：测试里没有 Worker，手动执行这个任务
    const stop = await db.task.findFirst({ where: { instanceId: id, type: 'STOP', status: 'QUEUED' } });
    if (stop) await runTask(stop.id);
    return res;
  };
  const enable = (body: object = {}) => request('PUT', '/api/admin/settings', adminCookie, { marketEnabled: true, marketFeeRate: 5, marketMinDays: 3, ...body });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-market-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-market-secret-1234567890123', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    runTask = (await import('../src/services/operations.ts')).runTask;
    const password = 'test-market-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    const user = (username: string, balance: number) =>
      db.user.create({ data: { username, email: `${username}@example.com`, passwordHash: hash, emailVerifiedAt: new Date(), balance } }).then((u) => u.id);
    await db.user.create({ data: { username: 'mk-admin', email: 'mk-admin@example.com', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
    sellerId = await user('mk-seller', 0);
    buyerId = await user('mk-buyer', 100);
    otherId = await user('mk-other', 100);
    nodeId = (await db.node.create({ data: { name: 'Market node', region: 'Tokyo', country: 'JP', endpoint: 'mock://market-nat', publicIp: '203.0.113.60', status: 'ONLINE', maxInstances: 100 } })).id;
    imageId = (await db.image.create({ data: { name: 'Debian 12', family: 'debian', alias: 'debian/12', server: 'https://images.example.com', protocol: 'simplestreams' } })).id;
    const product = await db.product.create({ data: { name: 'JP Lite', tags: ['精品线路'], nodes: { connect: { id: nodeId } } } });
    planId = (await db.plan.create({ data: { productId: product.id, name: 'JPLite Mini', type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, priceMonthly: 5 } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(res.statusCode, res.body).toBe(200);
      return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    };
    adminCookie = await login('mk-admin');
    sellerCookie = await login('mk-seller');
    buyerCookie = await login('mk-buyer');
    otherCookie = await login('mk-other');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-market-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('stays closed until an administrator opens it', async () => {
    const id = await makeInstance('mk-closed');
    expect((await request('GET', '/api/public/config', '')).json().marketEnabled).toBe(false);
    expect((await list(id, 20)).statusCode).toBe(400);
    expect((await request('GET', '/api/public/market', '')).json()).toMatchObject({ items: [], total: 0 });
    expect((await enable()).statusCode).toBe(200);
    expect((await request('GET', '/api/public/config', '')).json().marketEnabled).toBe(true);
  }, 30_000);

  it('lists an instance, shows it publicly without identifying details and locks it', async () => {
    const id = await makeInstance('mk-list');
    // 可挂牌的实例与不能挂牌的原因
    const sellable = (await request('GET', '/api/market/sellable', sellerCookie)).json();
    expect(sellable.find((s: { id: number }) => s.id === id)).toMatchObject({ blocker: null, region: 'Tokyo' });
    const soon = await makeInstance('mk-soon', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await list(soon, 10)).statusCode).toBe(400);
    expect((await request('GET', '/api/market/sellable', sellerCookie)).json().find((s: { id: number }) => s.id === soon).blocker).toBeTruthy();

    // 价格校验与不属于自己的实例
    expect((await list(id, 0)).statusCode).toBe(400);
    expect((await list(id, 12.5, {}, buyerCookie)).statusCode).toBe(404);
    const created = await list(id, 12.5);
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ price: '12.50', fee: '0.63', income: '11.87', status: 'ACTIVE', mine: true, hostname: 'mk-list' });
    // 同一实例不能重复挂牌
    expect((await list(id, 9)).statusCode).toBe(400);

    // 公开列表：不含主机名与 IP，带地区、产品与套餐
    const pub = (await request('GET', '/api/public/market', '')).json();
    const item = pub.items.find((i: { id: number }) => i.id === created.json().id);
    expect(item).toMatchObject({ price: '12.50', region: 'Tokyo', country: 'JP', plan: 'JPLite Mini', mine: false, targeted: false, seller: 'mk***r', ipv4: 'NAT' });
    expect(item.product).toMatchObject({ name: 'JP Lite', tags: ['精品线路'] });
    expect(JSON.stringify(item)).not.toContain('mk-list');
    expect(pub.regions).toEqual(['Tokyo']);
    expect((await request('GET', '/api/public/market?region=Paris', '')).json().total).toBe(0);
    expect((await request('GET', '/api/public/market?q=jplite', '')).json().total).toBeGreaterThan(0);
    expect((await request('GET', `/api/instances/${id}`, sellerCookie)).json().marketListing).toMatchObject({ price: '12.50' });

    // 挂牌后自动关机，挂牌期间不能开机、删除、重装、转移、重置密码、改名或使用终端等；可以查看、续费与开关自动续费
    expect((await db.instance.findUniqueOrThrow({ where: { id } })).status).toBe('STOPPED');
    expect((await request('POST', `/api/instances/${id}/power`, sellerCookie, { action: 'start' })).statusCode).toBe(409);
    expect((await request('POST', `/api/instances/${id}/ports`, sellerCookie, { internalPort: 80, protocol: 'TCP' })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/instances/${id}`, sellerCookie, { hostname: 'mk-renamed' })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/instances/${id}`, sellerCookie, { autoRenew: false })).statusCode).toBe(200);
    expect((await request('GET', `/api/instances/${id}/credentials`, sellerCookie)).statusCode).toBe(200);
    expect((await request('DELETE', `/api/instances/${id}`, sellerCookie, { confirm: 'mk-list' })).statusCode).toBe(409);
    expect((await request('POST', `/api/instances/${id}/reinstall`, sellerCookie, { imageId })).statusCode).toBe(409);
    expect((await request('POST', `/api/instances/${id}/transfer`, sellerCookie, { target: 'mk-other', mode: 'KEEP', confirm: 'mk-list' })).statusCode).toBe(409);
    expect((await request('POST', `/api/instances/${id}/reset-password`, sellerCookie, {})).statusCode).toBe(409);

    // 改价与撤销；撤销后解除锁定
    expect((await request('PATCH', `/api/market/listings/${created.json().id}`, sellerCookie, { price: 15 })).json().price).toBe('15.00');
    expect((await request('PATCH', `/api/market/listings/${created.json().id}`, buyerCookie, { price: 1 })).statusCode).toBe(404);
    expect((await request('DELETE', `/api/market/listings/${created.json().id}`, sellerCookie)).statusCode).toBe(200);
    expect((await request('GET', '/api/public/market', '')).json().items.find((i: { id: number }) => i.id === created.json().id)).toBeUndefined();
    expect((await request('POST', `/api/market/listings/${created.json().id}/buy`, buyerCookie)).statusCode).toBe(409);
    expect((await request('GET', `/api/instances/${id}`, sellerCookie)).json().marketListing).toBeNull();
    expect((await request('POST', `/api/instances/${id}/power`, sellerCookie, { action: 'start' })).statusCode).toBe(200);
  }, 60_000);

  it('sells to a buyer: pays, takes the fee, transfers the instance and notifies both sides', async () => {
    const id = await makeInstance('mk-sale');
    const listing = (await list(id, 20)).json();
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, sellerCookie)).statusCode).toBe(400); // 自己不能买
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, '')).statusCode).toBe(401);

    const sellerBefore = await balanceOf(sellerId);
    const buyerBefore = await balanceOf(buyerId);
    const res = await request('POST', `/api/market/listings/${listing.id}/buy`, buyerCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ instanceId: id });
    // 买家付 20.00；卖家收到 19.00（手续费 5% = 1.00）
    expect(await balanceOf(buyerId)).toBe((Number(buyerBefore) - 20).toFixed(2));
    expect(await balanceOf(sellerId)).toBe((Number(sellerBefore) + 19).toFixed(2));
    expect(await db.balanceLog.findMany({ where: { type: 'MARKET', userId: { in: [buyerId, sellerId] } }, orderBy: { id: 'desc' }, take: 2 })).toMatchObject([{ userId: sellerId, amount: expect.anything() }, { userId: buyerId }]);
    expect(await db.marketListing.findUniqueOrThrow({ where: { id: listing.id } })).toMatchObject({ status: 'SOLD', buyerId });
    expect((await db.marketListing.findUniqueOrThrow({ where: { id: listing.id } })).fee.toFixed(2)).toBe('1.00');

    // 实例已转给买家，并关闭了自动续费
    const moved = await db.instance.findUniqueOrThrow({ where: { id } });
    expect(moved).toMatchObject({ userId: buyerId, autoRenew: false });
    expect(await db.instanceTransfer.count({ where: { instanceId: id, fromUserId: sellerId, toUserId: buyerId, byAdmin: false } })).toBe(1);
    // 买卖双方都收到站内信，转移手续费没有另外收取
    expect(await db.message.count({ where: { userId: sellerId, title: { contains: 'JPLite Mini' } } })).toBe(1);
    expect(await db.message.count({ where: { userId: buyerId, title: { contains: 'JPLite Mini' } } })).toBe(1);
    expect(await db.balanceLog.count({ where: { type: 'TRANSFER' } })).toBe(0);
    // 同一件商品不能被再次购买
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, otherCookie)).statusCode).toBe(409);
    // 卖家的挂牌记录显示成交情况
    const mine = (await request('GET', '/api/market/mine', sellerCookie)).json().find((l: { id: number }) => l.id === listing.id);
    expect(mine).toMatchObject({ status: 'SOLD', fee: '1.00', income: '19.00', buyer: 'mk***r' });

    // 成交记录：保存成交时的实例信息，之后实例变化（买家改名、续费）不影响记录
    const before = await db.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
    expect(mine.snapshot).toMatchObject({
      instanceId: id,
      instanceName: before.name,
      hostname: 'mk-sale',
      nodeName: before.node.name,
      cpu: before.cpu,
      memory: before.memory,
      price: '20.00',
      fee: '1.00',
      income: '19.00',
      seller: { id: sellerId },
      // 卖家看到的买家信息脱敏
      buyer: { id: 0, username: 'mk***r' },
    });
    await db.instance.update({ where: { id }, data: { hostname: 'renamed-by-buyer', expiresAt: new Date(Date.now() + 400 * 86400_000) } });
    const later = (await request('GET', '/api/market/mine', sellerCookie)).json().find((l: { id: number }) => l.id === listing.id);
    expect(later).toMatchObject({ hostname: 'mk-sale', expiresAt: mine.snapshot.expiresAt });
    const admin = (await request('GET', '/api/admin/market?status=SOLD', adminCookie)).json().items.find((l: { id: number }) => l.id === listing.id);
    expect(admin.snapshot).toMatchObject({ hostname: 'mk-sale', buyer: { id: buyerId } });
  }, 60_000);

  it('refuses a buyer without enough balance and keeps the listing', async () => {
    const id = await makeInstance('mk-poor');
    const listing = (await list(id, 500)).json();
    const res = await request('POST', `/api/market/listings/${listing.id}/buy`, buyerCookie);
    expect(res.statusCode).toBe(402);
    expect((await db.marketListing.findUniqueOrThrow({ where: { id: listing.id } })).status).toBe('ACTIVE');
    expect((await db.instance.findUniqueOrThrow({ where: { id } })).userId).toBe(sellerId);
  }, 30_000);

  it('hides targeted listings from everyone but the chosen buyer and the seller', async () => {
    const id = await makeInstance('mk-target');
    const listing = (await list(id, 10, { target: 'mk-other@example.com' })).json();
    expect(listing).toMatchObject({ targeted: true, target: 'mk-other' });
    const ids = async (cookie: string) => (await request('GET', '/api/public/market', cookie)).json().items.map((i: { id: number }) => i.id);
    expect(await ids('')).not.toContain(listing.id);
    expect(await ids(buyerCookie)).not.toContain(listing.id);
    expect(await ids(otherCookie)).toContain(listing.id);
    expect(await ids(sellerCookie)).toContain(listing.id);
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, buyerCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/public/market/${listing.id}/history`, buyerCookie)).statusCode).toBe(404);
    // 指定的买家可以购买；定向对象不存在 / 是自己时挂不上
    expect((await list(await makeInstance('mk-target2'), 10, { target: 'nobody' })).statusCode).toBe(404);
    expect((await list(await makeInstance('mk-target3'), 10, { target: 'mk-seller' })).statusCode).toBe(400);
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, otherCookie)).statusCode).toBe(200);
  }, 60_000);

  it('always reinstalls the instance for the buyer, whatever the seller asks for', async () => {
    const id = await makeInstance('mk-wipe');
    // 卖家传「原样交接」也会被忽略：成交后一律全新安装
    const listing = (await list(id, 8, { mode: 'KEEP' })).json();
    expect(listing.mode).toBe('REINSTALL');
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, buyerCookie)).statusCode).toBe(200);
    const task = await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'REINSTALL' } });
    expect(task.payload).toMatchObject({ imageId, rename: expect.stringMatching(new RegExp(`^pd-${buyerId}-`)) });
    // 没有记录系统镜像的实例无法全新安装，不能挂牌
    const bare = await makeInstance('mk-noimage');
    await db.instance.update({ where: { id: bare }, data: { imageId: null } });
    expect((await request('GET', '/api/market/sellable', sellerCookie)).json().find((i: { id: number }) => i.id === bare).blocker).toBeTruthy();
    expect((await list(bare, 8)).statusCode).toBe(400);
  }, 60_000);

  it('summarises recent sale prices of the same plan', async () => {
    const id = await makeInstance('mk-history');
    const listing = (await list(id, 12)).json();
    const history = (await request('GET', `/api/public/market/${listing.id}/history`, '')).json();
    // 前面的用例已成交 20.00、10.00、8.00 三笔同套餐的订单
    expect(history).toMatchObject({ plan: 'JPLite Mini', currentPrice: '12.00', renewPrice: '5.00', count: 3, min: '8.00', max: '20.00' });
    expect(Number(history.average)).toBeCloseTo(12.67, 2);
    expect(history.points).toHaveLength(3);
    const targeted = (await request('GET', `/api/public/market/${listing.id}/history?kind=TARGETED`, '')).json();
    expect(targeted).toMatchObject({ count: 1, min: '10.00', max: '10.00' });
    expect((await request('GET', `/api/public/market/${listing.id}/history?kind=PUBLIC`, '')).json().count).toBe(2);
    expect((await request('GET', '/api/public/market/99999/history', '')).statusCode).toBe(404);
  }, 60_000);

  it('lets administrators take listings down and closes them when the instance is deleted', async () => {
    const a = await makeInstance('mk-admin-a');
    const b = await makeInstance('mk-admin-b');
    const la = (await list(a, 9)).json();
    const lb = (await list(b, 9)).json();
    expect((await request('POST', `/api/admin/market/${la.id}/remove`, sellerCookie, { reason: 'x' })).statusCode).toBe(403);
    expect((await request('POST', `/api/admin/market/${la.id}/remove`, adminCookie, { reason: '价格异常' })).statusCode).toBe(200);
    expect(await db.marketListing.findUniqueOrThrow({ where: { id: la.id } })).toMatchObject({ status: 'REMOVED', endReason: '价格异常' });
    expect((await db.message.findFirstOrThrow({ where: { userId: sellerId, title: { contains: 'mk-admin-a' } } })).content).toContain('价格异常');
    const listed = (await request('GET', '/api/admin/market?status=REMOVED', adminCookie)).json();
    expect(listed.items.map((i: { id: number }) => i.id)).toContain(la.id);
    // 下架后实例恢复可操作；删除实例会让挂牌自动下架
    expect((await request('POST', `/api/admin/instances/${b}/actions`, adminCookie, { action: 'delete', refundMode: 'NONE' })).statusCode).toBe(200);
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: b, type: 'DELETE' } })).id);
    expect(await db.marketListing.findUniqueOrThrow({ where: { id: lb.id } })).toMatchObject({ status: 'REMOVED' });
  }, 60_000);

  it('lets administrators edit the price and the target buyer of a listing and notifies the seller', async () => {
    const id = await makeInstance('mk-admin-edit');
    const listing = (await list(id, 30)).json();
    const patch = (body: object, cookie = adminCookie) => request('PATCH', `/api/admin/market/${listing.id}`, cookie, body);
    expect((await patch({ price: 1 }, sellerCookie)).statusCode).toBe(403);
    expect((await patch({ price: 0 })).statusCode).toBe(400);

    // 改价：手续费与卖家到账随之变化，卖家收到通知（含说明）
    const priced = await patch({ price: '25.5', note: '价格过高' });
    expect(priced.statusCode, priced.body).toBe(200);
    expect(priced.json()).toMatchObject({ id: listing.id, price: '25.50', targeted: false });
    const msg = await db.message.findFirstOrThrow({ where: { userId: sellerId, title: { contains: 'mk-admin-edit' } }, orderBy: { id: 'desc' } });
    expect(msg.content).toContain('25.50');
    expect(msg.content).toContain('价格过高');

    // 定向给其他用户：只有该用户可见；卖家自己与不存在的用户不行；空字符串恢复公开
    expect((await patch({ target: 'mk-seller' })).statusCode).toBe(400);
    expect((await patch({ target: 'nobody-here' })).statusCode).toBe(404);
    expect((await patch({ target: 'mk-other' })).json()).toMatchObject({ targeted: true, target: 'mk-other' });
    expect((await request('GET', '/api/public/market', buyerCookie)).json().items.map((i: { id: number }) => i.id)).not.toContain(listing.id);
    expect((await patch({ target: '' })).json()).toMatchObject({ targeted: false, target: null });

    // 没有变化不再通知；已下架的不能修改
    const before = await db.message.count({ where: { userId: sellerId } });
    expect((await patch({ price: '25.50' })).statusCode).toBe(200);
    expect(await db.message.count({ where: { userId: sellerId } })).toBe(before);
    await request('POST', `/api/admin/market/${listing.id}/remove`, adminCookie, {});
    expect((await patch({ price: 10 })).statusCode).toBe(409);
  }, 60_000);

  it('features one public listing on the home page and replaces it once it is gone', async () => {
    await enable({ marketFeeRate: 5 });
    const a = (await list(await makeInstance('mk-feat-a'), 6)).json();
    const b = (await list(await makeInstance('mk-feat-b'), 7)).json();
    const featured = async () => {
      const res = await request('GET', '/api/public/market/featured', '');
      expect(res.statusCode, res.body).toBe(200);
      return res.json().listing as { id: number; mine: boolean; targeted: boolean } | null;
    };
    const first = (await featured())!;
    expect(first).toMatchObject({ mine: false, targeted: false });
    // 展示期间保持不变
    expect((await featured())!.id).toBe(first.id);
    const { getSetting } = await import('../src/lib/settings.ts');
    const until = Date.parse((await getSetting('marketFeatured')).until);
    expect(until - Date.now()).toBeGreaterThan(23 * 3600_000);

    // 按挂牌编号搜索（首页卡片跳转到交易市场时使用）
    for (const q of [String(first.id), `#${first.id}`]) {
      const found = (await request('GET', `/api/public/market?q=${encodeURIComponent(q)}`, '')).json();
      expect(found.items.map((i: { id: number }) => i.id)).toContain(first.id);
    }

    // 被下架后立即换一个仍在售的商品
    expect((await request('POST', `/api/admin/market/${first.id}/remove`, adminCookie, { reason: 'x' })).statusCode).toBe(200);
    const next = await featured();
    expect(next?.id).not.toBe(first.id);
    const active = await db.marketListing.findMany({ where: { status: 'ACTIVE', targetUserId: null }, select: { id: true } });
    expect(active.map((l) => l.id)).toContain(next!.id);
    expect([a.id, b.id, ...active.map((l) => l.id)]).toContain(next!.id);
  }, 60_000);

  it('uses the configured remaining-time threshold consistently', async () => {
    expect((await enable({ marketMinDays: 0 })).statusCode).toBe(200);
    const id = await makeInstance('mk-threshold', { expiresAt: new Date(Date.now() + 12 * 3600_000).toISOString() });
    const listing = (await list(id, 8)).json();
    const listedIds = (await request('GET', '/api/public/market', '')).json().items.map((item: { id: number }) => item.id);
    expect(listedIds).toContain(listing.id);

    // Raising the threshold hides the same listing and blocks checkout as soon as it falls below it.
    expect((await enable({ marketMinDays: 3 })).statusCode).toBe(200);
    expect((await request('GET', '/api/public/market', '')).json().items.map((item: { id: number }) => item.id)).not.toContain(listing.id);
    expect((await request('POST', `/api/market/listings/${listing.id}/buy`, buyerCookie)).statusCode).toBe(409);
  }, 30_000);

  it('uses the configured fee rate', async () => {
    expect((await enable({ marketFeeRate: 10 })).statusCode).toBe(200);
    const id = await makeInstance('mk-fee');
    const listing = (await list(id, 33.33)).json();
    expect(listing).toMatchObject({ fee: '3.33', income: '30.00' });
    expect((await enable({ marketFeeRate: 60 })).statusCode).toBe(400);
  }, 30_000);
});

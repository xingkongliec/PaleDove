import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { AdminPlanDTO, AdminProductDTO } from '../src/shared/index.ts';
import { instancePlanDefaults } from '../../web/src/pages/admin/instances/instance-create-plan';

describe('admin instance creation and store purchase', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let Prisma: typeof import('../src/lib/prisma.ts').Prisma;
  let runTask: typeof import('../src/services/operations.ts').runTask;
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let userId: number;
  let natNodeId: number;
  let ipv4NodeId: number;
  let imageId: number;
  let planId: number;
  let requestNumber = 0;
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.3.0.${(++requestNumber % 250) + 1}`, headers: { 'x-requested-with': 'XMLHttpRequest', cookie } });
  const spec = (over: Record<string, unknown> = {}) => ({
    userId, nodeId: natNodeId, type: 'LXC_NAT', imageId, hostname: 'custom-01',
    cpu: 3, cpuAllowance: 50, memory: 1536, disk: 25, bandwidthIn: 200, bandwidthOut: 100, traffic: 800, trafficMode: 'OUT', overLimitAction: 'STOP', throttleRate: 2,
    portLimit: 7, siteLimit: 2, snapshotLimit: 3, storagePool: null, billingCycle: 'MONTHLY', price: '12.50', expiresAt: new Date(Date.now() + 90 * 86400_000).toISOString(), autoRenew: true, remark: 'vip',
    ...over,
  });
  const balance = async () => (await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString();

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-admin-create-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-admin-create-secret-1234567', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db, Prisma } = await import('../src/lib/prisma.ts'));
    runTask = (await import('../src/services/operations.ts')).runTask;
    const password = 'test-admin-create-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'create-admin', email: 'create-admin@example.com', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
    userId = (await db.user.create({ data: { username: 'create-user', email: 'create-user@example.com', passwordHash: hash, emailVerifiedAt: new Date(), balance: 20 } })).id;
    natNodeId = (await db.node.create({ data: { name: 'NAT node', region: 'Test', endpoint: 'mock://create-nat', publicIp: '203.0.113.30', status: 'ONLINE' } })).id;
    ipv4NodeId = (await db.node.create({ data: { name: 'IPv4 node', region: 'Test', endpoint: 'mock://create-v4', networkMode: 'IPV4', publicNicParent: 'br0', status: 'ONLINE' } })).id;
    imageId = (await db.image.create({ data: { name: 'Debian 12', family: 'debian', alias: 'debian/12', server: 'https://images.example.com', protocol: 'simplestreams' } })).id;
    const product = await db.product.create({ data: { name: 'NAT', nodes: { connect: { id: natNodeId } } } });
    planId = (await db.plan.create({ data: { productId: product.id, name: 'Small', type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, priceMonthly: 5 } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(res.statusCode, res.body).toBe(200);
      return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    };
    adminCookie = await login('create-admin');
    userCookie = await login('create-user');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-admin-create-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('creates a free instance with custom specs and provisions it', async () => {
    const res = await request('POST', '/api/admin/instances', adminCookie, spec());
    expect(res.statusCode, res.body).toBe(200);
    const inst = await db.instance.findUniqueOrThrow({ where: { id: res.json().instanceId }, include: { portMappings: true } });
    expect(inst).toMatchObject({ userId, nodeId: natNodeId, hostname: 'custom-01', cpu: 3, cpuAllowance: 50, memory: 1536, disk: 25, traffic: 800, overLimitAction: 'STOP', portLimit: 7, autoRenew: true, remark: 'vip', status: 'CREATING', planId: null });
    expect(inst.price.toString()).toBe('12.5');
    // 实例 ID：pd-用户 ID-8 位随机编码
    expect(inst.name).toMatch(new RegExp(`^pd-${userId}-[a-z0-9]{8}$`));
    expect(inst.privateIp).toBeTruthy();
    expect(inst.portMappings).toHaveLength(1);
    expect(inst.portMappings[0]).toMatchObject({ privatePort: 22, system: true, publicPort: inst.sshPort });
    expect(await balance()).toBe('20');
    expect(await db.order.count({ where: { instanceId: inst.id } })).toBe(0);
    const task = await db.task.findFirstOrThrow({ where: { instanceId: inst.id, type: 'CREATE' } });
    await runTask(task.id);
    const done = await db.instance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(done.status, done.lastError ?? '').toBe('RUNNING');
  }, 30_000);

  it('creates from complete plan defaults and preserves per-instance overrides and charges', async () => {
    const { passwordHash } = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const owner = await db.user.create({ data: { username: 'plan-create-user', email: 'plan-create@example.com', passwordHash, balance: 100 } });
    const product = await db.product.create({ data: {
      name: 'Admin plan template', privileged: true, nesting: false,
      nodes: { connect: { id: natNodeId } }, nodeOptions: { [natNodeId]: { trafficMultiplier: 1.5, storagePool: null } },
    } });
    const template = await db.plan.create({ data: {
      productId: product.id, name: 'Admin annual', type: 'LXC_NAT', cpu: 2, cpuAllowance: 50, cpuPriority: 0,
      processLimit: 256, memory: 1024, swap: 128, disk: 20, diskReadIops: 200,
      bandwidthIn: 100, bandwidthOut: 50, traffic: 100, portLimit: 3, siteLimit: 1, snapshotLimit: 2,
      priceAnnual: 30,
    } });
    const plans = (await request('GET', '/api/admin/plans', adminCookie)).json() as AdminPlanDTO[];
    const products = (await request('GET', '/api/admin/products', adminCookie)).json() as AdminProductDTO[];
    const defaults = instancePlanDefaults(plans.find((p) => p.id === template.id)!, 'MONTHLY', { id: natNodeId, networkMode: 'NAT' }, products.find((p) => p.id === product.id));
    expect(defaults).toMatchObject({ billingCycle: 'ANNUAL', price: '30.00', traffic: 150, privileged: true, nesting: false });

    const free = await request('POST', '/api/admin/instances', adminCookie, spec({ ...defaults, userId: owner.id, hostname: 'plan-defaults' }));
    expect(free.statusCode, free.body).toBe(200);
    const original = await db.instance.findUniqueOrThrow({ where: { id: free.json().instanceId } });
    expect(original).toMatchObject({ planId: template.id, cpu: 2, cpuPriority: 0, memory: 1024, swap: 128, disk: 20, diskReadIops: 200, traffic: 150, privileged: true, nesting: false, billingCycle: 'ANNUAL' });
    expect(original.price.toString()).toBe('30');
    expect(await db.order.count({ where: { instanceId: original.id } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).balance.toString()).toBe('100');

    const changed = await request('POST', '/api/admin/instances', adminCookie, spec({ ...defaults, userId: owner.id, hostname: 'plan-overrides', cpu: 4, memory: 2048, price: '12.50', charge: true }));
    expect(changed.statusCode, changed.body).toBe(200);
    const customized = await db.instance.findUniqueOrThrow({ where: { id: changed.json().instanceId } });
    expect(customized).toMatchObject({ planId: template.id, cpu: 4, memory: 2048, traffic: 150, billingCycle: 'ANNUAL' });
    expect(customized.price.toString()).toBe('12.5');
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).balance.toString()).toBe('87.5');
    const order = await db.order.findFirstOrThrow({ where: { instanceId: customized.id } });
    expect(order).toMatchObject({ planId: template.id, cycle: 'ANNUAL', type: 'NEW' });
    expect(order.amount.toString()).toBe('12.5');
    expect(await db.plan.findUniqueOrThrow({ where: { id: template.id } })).toMatchObject({ cpu: 2, memory: 1024 });
    await db.instance.updateMany({ where: { id: { in: [original.id, customized.id] } }, data: { status: 'DELETED' } });
    await db.product.update({ where: { id: product.id }, data: { enabled: false } });
  });

  it('opens a web terminal for the owner and administrators only', async () => {
    const inst = await db.instance.findFirstOrThrow({ where: { hostname: 'custom-01', userId } });
    type Ws = Awaited<ReturnType<FastifyInstance['injectWS']>>;
    // 收集终端输出，直到出现指定文本
    const read = (ws: Ws, until: string) =>
      new Promise<string>((resolve, reject) => {
        let buf = '';
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${JSON.stringify(until)}: ${JSON.stringify(buf)}`)), 5000);
        ws.on('message', (d: Buffer) => {
          buf += d.toString();
          if (buf.includes(until)) {
            clearTimeout(timer);
            resolve(buf);
          }
        });
      });
    const closed = (ws: Ws) => new Promise<void>((resolve) => ws.once('close', () => resolve()));

    const ws = await app.injectWS(`/api/instances/${inst.id}/terminal?cols=100&rows=30`, { headers: { cookie: userCookie } });
    await read(ws, '# ');
    const size = read(ws, '30 100');
    ws.send(JSON.stringify({ type: 'input', data: 'stty size\r' }));
    await size;
    const resized = read(ws, '40 132');
    ws.send(JSON.stringify({ type: 'resize', cols: 132, rows: 40 }));
    ws.send(JSON.stringify({ type: 'input', data: 'stty size\r' }));
    await resized;
    // shell 退出后服务端关闭连接
    const ended = closed(ws);
    ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
    await ended;
    expect(await db.activityLog.count({ where: { action: 'instance.terminal' } })).toBe(1);

    const admin = await app.injectWS(`/api/admin/instances/${inst.id}/terminal`, { headers: { cookie: adminCookie } });
    await read(admin, inst.name);
    admin.terminate();

    // 其他网站发起的连接直接关闭；管理员不能使用用户控制台的终端接口
    const cross = await app.injectWS(`/api/instances/${inst.id}/terminal`, { headers: { cookie: userCookie, 'sec-fetch-site': 'cross-site' } });
    await closed(cross);
    await expect(app.injectWS(`/api/instances/${inst.id}/terminal`, { headers: { cookie: adminCookie } })).rejects.toThrow();
    expect(await db.activityLog.count({ where: { action: 'instance.terminal' } })).toBe(2);
  }, 30_000);

  it('lets users pick an avatar style and exposes only a hashed seed', async () => {
    const { createHash } = await import('node:crypto');
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const seed = createHash('md5').update(user.email.trim().toLowerCase()).digest('hex');
    const me = (await request('GET', '/api/auth/me', userCookie)).json();
    expect((me.user ?? me).avatar).toEqual({ style: 'bigSmile', seed, variant: 0 });

    const res = await request('PUT', '/api/auth/profile', userCookie, { avatarStyle: 'pixelArt', avatarVariant: 12 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user.avatar).toEqual({ style: 'pixelArt', seed, variant: 12 });
    expect((await request('PUT', '/api/auth/profile', userCookie, { avatarVariant: 1000 })).statusCode).toBe(400);
    expect(JSON.stringify(res.json().user.avatar)).not.toContain(user.email);
    expect((await request('PUT', '/api/auth/profile', userCookie, { avatarStyle: 'not-a-style' })).statusCode).toBe(400);

    // 管理员可设置头像 API 地址，公开配置随之下发；非 http(s) 地址被拒绝
    expect((await request('GET', '/api/public/config', userCookie)).json().avatarApiBase).toBe('https://api.dicebear.com/9.x');
    expect((await request('PUT', '/api/admin/settings', adminCookie, { avatarApiBase: 'ftp://x' })).statusCode).toBe(400);
    expect((await request('PUT', '/api/admin/settings', adminCookie, { avatarApiBase: 'https://avatar.example.com/9.x' })).statusCode).toBe(200);
    expect((await request('GET', '/api/public/config', userCookie)).json().avatarApiBase).toBe('https://avatar.example.com/9.x');
    await request('PUT', '/api/admin/settings', adminCookie, { avatarApiBase: 'https://api.dicebear.com/9.x' });
    await request('PUT', '/api/auth/profile', userCookie, { avatarStyle: 'bigSmile', avatarVariant: 0 });
  });

  it('charges the first period when asked and refuses when the balance is short', async () => {
    const ok = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname: 'paid-01', charge: true, price: '15', planId }));
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await balance()).toBe('5');
    const order = await db.order.findFirstOrThrow({ where: { instanceId: ok.json().instanceId } });
    expect(order).toMatchObject({ type: 'NEW', planId, cycle: 'MONTHLY' });
    expect(order.amount.toString()).toBe('15');

    const before = await db.instance.count();
    const short = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname: 'paid-02', charge: true, price: '10' }));
    expect(short.statusCode).toBe(402);
    expect(await db.instance.count()).toBe(before);
    expect(await balance()).toBe('5');
  });

  it('validates the node, type, image, user and expiry', async () => {
    const bad = async (over: Record<string, unknown>, code: number) => expect((await request('POST', '/api/admin/instances', adminCookie, spec(over))).statusCode).toBe(code);
    await bad({ nodeId: ipv4NodeId }, 400); // NAT 实例不能放在独立 IPv4 宿主机
    await bad({ type: 'KVM_IPV4', nodeId: ipv4NodeId }, 409); // 没有空闲的独立 IPv4
    await bad({ nodeId: 9999 }, 404);
    await bad({ userId: 9999 }, 404);
    await bad({ expiresAt: new Date(Date.now() - 1000).toISOString() }, 400);
    await bad({ hostname: 'bad host!' }, 400);
    await db.node.update({ where: { id: natNodeId }, data: { imageIds: [12345] } });
    await bad({}, 400); // 宿主机不提供该镜像
    await db.node.update({ where: { id: natNodeId }, data: { imageIds: Prisma.DbNull } });
    expect((await request('POST', '/api/admin/instances', userCookie, spec())).statusCode).toBe(403);
  });

  it('only offers images that match the host architecture', async () => {
    const arm = await db.image.create({ data: { name: 'Debian 12', family: 'debian', alias: 'debian/12', arch: 'aarch64' } });
    const regionImages = async () => {
      const plans = (await request('GET', '/api/store/plans', userCookie)).json() as Array<{ id: number; regionInfo: Record<string, { imageIds: number[] | null }> }>;
      return plans.find((p) => p.id === planId)?.regionInfo.Test?.imageIds;
    };
    // 架构未读取时不过滤
    expect(await regionImages()).toBeNull();
    // 测试连接时记录架构（模拟宿主机为 x86_64）
    expect((await request('POST', `/api/admin/nodes/${natNodeId}/connect`, adminCookie, {})).statusCode).toBe(200);
    expect((await db.node.findUniqueOrThrow({ where: { id: natNodeId } })).arch).toBe('x86_64');
    expect(await regionImages()).toEqual([imageId]);
    expect((await request('POST', '/api/admin/instances', adminCookie, spec({ imageId: arm.id }))).statusCode).toBe(400);
    const order = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId: arm.id, cycle: 'MONTHLY', hostname: 'arm-01' });
    expect(order.statusCode).toBe(400);
    await db.image.delete({ where: { id: arm.id } });
    await db.node.update({ where: { id: natNodeId }, data: { arch: null } });
  });

  it('partial updates only touch the fields that were sent', async () => {
    const patch = (url: string, body: object) => app.inject({ method: 'PATCH', url, payload: body, remoteAddress: '10.3.9.1', headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
    await db.node.update({ where: { id: natNodeId }, data: { serverFingerprint: 'AA:BB', description: 'keep me' } });
    expect((await patch(`/api/admin/nodes/${natNodeId}`, { requireRealName: true, maxInstances: 7 })).statusCode).toBe(200);
    expect((await patch(`/api/admin/nodes/${natNodeId}`, { imageIds: [imageId] })).statusCode).toBe(200);
    const node = await db.node.findUniqueOrThrow({ where: { id: natNodeId } });
    expect(node).toMatchObject({ requireRealName: true, maxInstances: 7, imageIds: [imageId], serverFingerprint: 'AA:BB', description: 'keep me', enabled: true });
    await db.node.update({ where: { id: natNodeId }, data: { requireRealName: false, imageIds: Prisma.DbNull } });

    expect((await patch(`/api/admin/plans/${planId}`, { name: 'Small v2' })).statusCode).toBe(200);
    const plan = await db.plan.findUniqueOrThrow({ where: { id: planId } });
    expect(plan.name).toBe('Small v2');
    expect(plan.priceMonthly?.toString()).toBe('5');

    await db.image.update({ where: { id: imageId }, data: { sortOrder: 9, forVm: false } });
    expect((await patch(`/api/admin/images/${imageId}`, { name: 'Debian 12 (bookworm)' })).statusCode).toBe(200);
    expect(await db.image.findUniqueOrThrow({ where: { id: imageId } })).toMatchObject({ name: 'Debian 12 (bookworm)', sortOrder: 9, forVm: false, family: 'debian', enabled: true });
  });

  it('groups plans under products that own the node bindings', async () => {
    const products = await request('GET', '/api/store/products', userCookie);
    expect(products.json()).toEqual([expect.objectContaining({ name: 'NAT', regions: ['Test'], tags: [] })]);
    const plans = (await request('GET', '/api/store/plans', userCookie)).json() as Array<{ id: number; productId: number; regions: string[] }>;
    expect(plans.find((p) => p.id === planId)).toMatchObject({ productId: products.json()[0].id, regions: ['Test'] });

    const created = await request('POST', '/api/admin/products', adminCookie, { name: 'Empty', tags: ['A', ' A ', ''], nodeIds: [] });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ name: 'Empty', tags: ['A'], regions: [], planCount: 0, activeInstances: 0, listed: false });
    // 有套餐的产品不能删除；套餐移到其他产品时跟随新产品的宿主机
    expect((await request('DELETE', `/api/admin/products/${products.json()[0].id}`, adminCookie)).statusCode).toBe(409);
    const moved = await app.inject({ method: 'PATCH', url: `/api/admin/plans/${planId}`, payload: { productId: created.json().id }, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
    expect(moved.json()).toMatchObject({ productId: created.json().id, regions: [] });
    await db.plan.update({ where: { id: planId }, data: { productId: products.json()[0].id } });
    expect((await request('DELETE', `/api/admin/products/${created.json().id}`, adminCookie)).statusCode).toBe(200);

    // 产品决定实例类型：宿主机网络模式必须匹配，套餐类型跟随产品
    expect((await request('POST', '/api/admin/products', adminCookie, { name: 'Bad', type: 'KVM_IPV4', nodeIds: [natNodeId] })).statusCode).toBe(400);
    const kvm = (await request('POST', '/api/admin/products', adminCookie, { name: 'KVM', type: 'KVM_NAT', nodeIds: [natNodeId] })).json();
    expect(kvm.type).toBe('KVM_NAT');
    const plan = await request('POST', '/api/admin/plans', adminCookie, { productId: kvm.id, name: 'K1', type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 10, bandwidthOut: 10, priceMonthly: '1' });
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().type).toBe('KVM_NAT');
    const toLxc = await app.inject({ method: 'PATCH', url: `/api/admin/products/${kvm.id}`, payload: { type: 'LXC_NAT' }, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
    expect(toLxc.statusCode, toLxc.body).toBe(200);
    expect((await db.plan.findUniqueOrThrow({ where: { id: plan.json().id } })).type).toBe('LXC_NAT');
    expect((await request('DELETE', `/api/admin/plans/${plan.json().id}`, adminCookie)).statusCode).toBe(200);
    expect((await request('DELETE', `/api/admin/products/${kvm.id}`, adminCookie)).statusCode).toBe(200);
  });

  it('still sells plans through the store', async () => {
    // 产品在宿主机上的设置：流量倍率与存储池；容器选项随产品
    const { productId } = await db.plan.update({ where: { id: planId }, data: { traffic: 100 } });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/admin/products/${productId}`,
      payload: { privileged: true, nesting: false, nodeOptions: { [natNodeId]: { trafficMultiplier: 1.5, storagePool: 'fast' }, 999: { trafficMultiplier: 3 } } },
      headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie },
    });
    expect(patched.json()).toMatchObject({ privileged: true, nesting: false, nodeOptions: { [natNodeId]: { trafficMultiplier: 1.5, storagePool: 'fast' } } });
    // 未绑定的宿主机设置不会保存
    expect((await db.product.findUniqueOrThrow({ where: { id: productId } })).nodeOptions).toEqual({ [natNodeId]: { trafficMultiplier: 1.5, storagePool: 'fast' } });
    const plans = (await request('GET', '/api/store/plans', userCookie)).json() as Array<{ id: number; regionInfo: Record<string, { trafficMultiplier: number }> }>;
    expect(plans.find((p) => p.id === planId)?.regionInfo.Test?.trafficMultiplier).toBe(1.5);

    const res = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'bought-01' });
    expect(res.statusCode, res.body).toBe(200);
    const inst = await db.instance.findUniqueOrThrow({ where: { id: res.json().instanceId } });
    expect(inst).toMatchObject({ planId, cpu: 1, memory: 512, disk: 10, nodeId: natNodeId, traffic: 150, storagePool: 'fast', privileged: true, nesting: false });
    expect(await balance()).toBe('0');
    expect(await db.order.count({ where: { instanceId: inst.id, type: 'NEW' } })).toBe(1);
  });

  it('sells enabled cycles priced 0 for free and rejects disabled cycles', async () => {
    const patch = (body: object) =>
      app.inject({ method: 'PATCH', url: `/api/admin/plans/${planId}`, payload: body, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
    expect((await patch({ priceMonthly: '0', priceAnnual: null })).statusCode).toBe(200);
    const plans = (await request('GET', '/api/store/plans', userCookie)).json() as Array<{ id: number; prices: Record<string, string> }>;
    expect(plans.find((p) => p.id === planId)?.prices).toEqual({ MONTHLY: '0.00' });
    // 余额为 0 也能开通免费周期
    expect(await balance()).toBe('0');
    const free = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'free-01' });
    expect(free.statusCode, free.body).toBe(200);
    expect((await db.instance.findUniqueOrThrow({ where: { id: free.json().instanceId } })).price.toString()).toBe('0');
    const off = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'ANNUAL', hostname: 'free-02' });
    expect(off.statusCode).toBe(400);
    expect((await patch({ priceMonthly: '5' })).statusCode).toBe(200);
  });

  it('offers SWAP on container plans, off by default and toggled by the user', async () => {
    const patchPlan = (body: object) => request('PATCH', `/api/admin/plans/${planId}`, adminCookie, body);
    expect((await patchPlan({ priceMonthly: '0', swap: 256 })).statusCode).toBe(200);
    let id = 0;
    try {
      const bought = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'swap-01', nodeId: natNodeId });
      expect(bought.statusCode, bought.body).toBe(200);
      id = bought.json().instanceId as number;
      await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
      const inst = await db.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
      expect(inst).toMatchObject({ swap: 256, swapEnabled: false });
      const { getIncus } = await import('../src/incus/index.ts');
      const swapConfig = async () => (await (await getIncus(inst.node)).getInstance(inst.name)).config['limits.memory.swap'];
      // 默认关闭：不使用宿主机 SWAP
      expect(await swapConfig()).toBe('false');
      const toggle = (enabled: boolean) => request('POST', `/api/instances/${id}/swap`, userCookie, { enabled });
      const on = await toggle(true);
      expect(on.statusCode, on.body).toBe(200);
      expect(on.json()).toMatchObject({ swap: 256, swapEnabled: true });
      expect(await swapConfig()).toBe('256MiB');
      expect((await toggle(false)).json()).toMatchObject({ swapEnabled: false });
      expect(await swapConfig()).toBe('false');
      // 套餐不提供 SWAP 的实例不能启用
      await db.instance.update({ where: { id }, data: { swap: 0 } });
      expect((await toggle(true)).statusCode).toBe(400);
    } finally {
      // 释放占用的宿主机容量，不影响后面的用例
      if (id) await db.instance.update({ where: { id }, data: { status: 'DELETED' } });
      await patchPlan({ priceMonthly: '5', swap: 0 });
    }
  });

  it('switches data centers once a month for free and charges extra switches', async () => {
    const patchPlan = (body: object) => request('PATCH', `/api/admin/plans/${planId}`, adminCookie, body);
    expect((await patchPlan({ priceMonthly: '0' })).statusCode).toBe(200);
    const product = await db.product.findFirstOrThrow({ where: { plans: { some: { id: planId } } } });
    const target = await db.node.create({ data: { name: 'DC1', region: 'Test', endpoint: 'mock://switch-dc1', publicIp: '203.0.113.32', status: 'ONLINE', products: { connect: { id: product.id } } } });
    const settings = (body: object) => request('PUT', '/api/admin/settings', adminCookie, body);
    try {
      const bought = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'switch-01', nodeId: natNodeId });
      expect(bought.statusCode, bought.body).toBe(200);
      const paidInvoice = await request('POST', `/api/invoices/${bought.json().invoice.id}/pay`, userCookie);
      expect(paidInvoice.statusCode, paidInvoice.body).toBe(200);
      const id = paidInvoice.json().instanceId as number;
      await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
      // 流量倍率：目标机房 2x，额度按倍率换算；已用流量超过原额度的限速在换算后解除
      await db.product.update({ where: { id: product.id }, data: { nodeOptions: { [target.id]: { trafficMultiplier: 2 } } } });
      await db.instance.update({ where: { id }, data: { traffic: 100, trafficOut: 150n * 1024n ** 3n, trafficThrottled: true } });
      const before = await db.instance.findUniqueOrThrow({ where: { id } });
      const runSwitch = async () => runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'SWITCH_NODE' }, orderBy: { id: 'desc' } })).id);

      // 可切换的机房与规则状态：本周期免费
      const info = (await request('GET', `/api/instances/${id}/switch-node`, userCookie)).json();
      expect(info).toMatchObject({ current: { id: natNodeId }, free: true, nextFreeAt: null, cooldownUntil: null, blocked: null, fee: '0.00' });
      expect(info.targets).toEqual([expect.objectContaining({ id: target.id, name: 'DC1', available: true, trafficMultiplier: 2, traffic: 200 })]);
      expect(info.current).toMatchObject({ trafficMultiplier: 1, traffic: 100 });
      expect((await request('POST', `/api/instances/${id}/switch-node`, userCookie, { targetNodeId: natNodeId, imageId })).statusCode).toBe(400);

      // 即时 Agent ICMP 检测：进行中禁止切换，六个目标均超时仍不足以判墙。
      const { issueAgentToken, clearHostReport, signResponse } = await import('../src/services/agent/agent.ts');
      const { createHash, createHmac, randomBytes } = await import('node:crypto');
      const secret = await issueAgentToken(natNodeId);
      const agentRequest = async (url: string, body: object) => {
        const payload = JSON.stringify(body), timestamp = String(Date.now()), nonce = randomBytes(16).toString('hex');
        const signature = createHmac('sha256', secret).update(['POST', url, timestamp, nonce, createHash('sha256').update(payload).digest('hex')].join('\n')).digest('hex');
        const response = await app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json', 'x-paledove-node': String(natNodeId), 'x-paledove-timestamp': timestamp, 'x-paledove-nonce': nonce, 'x-paledove-signature': signature } });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.headers['x-paledove-signature']).toBe(signResponse(secret, nonce, response.body));
        return response.json();
      };
      const heartbeat = () => agentRequest('/api/agent/nodes/report', { cpu: 1, load: [0, 0, 0], uptime: 100, capabilities: ['ipv4-check'] });
      await heartbeat();
      const check = async () => (await request('GET', `/api/instances/${id}/switch-node/check?fresh=1`, userCookie)).json();
      expect(await check()).toMatchObject({ status: 'pending' });
      expect((await request('POST', `/api/instances/${id}/switch-node`, userCookie, { targetNodeId: target.id, imageId })).statusCode).toBe(409);
      const report = async (reachable: boolean) => {
        const job = (await heartbeat()).ipv4Checks.find((j: { id: number }) => j.id === id);
        expect(job).toMatchObject({ kind: 'nat', ip: '203.0.113.30' });
        expect(await agentRequest('/api/agent/nodes/ipv4-check', { id, requestId: job.requestId, method: 'icmp', via: 'local', results: job.targets.map((p: { id: string }) => ({ id: p.id, latency: reachable ? 30 : null, loss: reachable ? 0 : 100 })) })).toEqual({ ok: true });
      };
      await report(false);
      expect((await request('GET', `/api/instances/${id}/switch-node/check`, userCookie)).json()).toMatchObject({ status: 'unknown', reason: 'icmpOnly', method: 'icmp', reachable: 0, total: 6 });
      expect(await check()).toMatchObject({ status: 'pending' });
      await report(true);
      expect((await request('GET', `/api/instances/${id}/switch-node/check`, userCookie)).json()).toMatchObject({ status: 'ok', method: 'icmp' });
      await clearHostReport(natNodeId);

      // 免费切换：在目标宿主机全新安装，保留到期时间与续费价格，原宿主机上的实例被删除
      const res = await request('POST', `/api/instances/${id}/switch-node`, userCookie, { targetNodeId: target.id, imageId });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ free: true, fee: '0.00', password: expect.any(String) });
      await runSwitch();
      const after = await db.instance.findUniqueOrThrow({ where: { id } });
      expect(after).toMatchObject({ nodeId: target.id, status: 'RUNNING', expiresAt: before.expiresAt, price: before.price, billingCycle: before.billingCycle });
      expect(after).toMatchObject({ traffic: 200, trafficOut: 150n * 1024n ** 3n, trafficThrottled: false });
      expect(after.freeSwitchAt).toBeTruthy();
      expect(after.nodeSwitchedAt).toBeTruthy();
      const { getIncus } = await import('../src/incus/index.ts');
      const sourceNode = await db.node.findUniqueOrThrow({ where: { id: natNodeId } });
      expect(await (await getIncus(sourceNode)).instanceExists(after.name)).toBe(false);
      expect(await (await getIncus(target)).instanceExists(after.name)).toBe(true);

      // 成功后冷却 2 小时
      expect((await request('POST', `/api/instances/${id}/switch-node`, userCookie, { targetNodeId: natNodeId, imageId })).statusCode).toBe(409);
      // 冷却结束但本周期免费已用：未设置额外费用时不能切换
      await db.instance.update({ where: { id }, data: { nodeSwitchedAt: new Date(Date.now() - 3 * 3600_000) } });
      const used = (await request('GET', `/api/instances/${id}/switch-node`, userCookie)).json();
      expect(used).toMatchObject({ free: false, nextFreeAt: expect.any(String) });
      expect((await request('POST', `/api/instances/${id}/switch-node`, userCookie, { targetNodeId: natNodeId, imageId })).statusCode).toBe(409);

      // 额外切换：按设置的费用扣余额，不推迟下一次免费时间
      expect((await settings({ nodeSwitchFee: 5 })).statusCode).toBe(200);
      await db.user.update({ where: { id: userId }, data: { balance: 10 } });
      const paid = await request('POST', `/api/instances/${id}/switch-node`, userCookie, { targetNodeId: natNodeId, imageId });
      expect(paid.statusCode, paid.body).toBe(200);
      expect(paid.json()).toMatchObject({ free: false, fee: '5.00' });
      expect(await balance()).toBe('5');
      await runSwitch();
      const back = await db.instance.findUniqueOrThrow({ where: { id } });
      expect(back.nodeId).toBe(natNodeId);
      // 切回 1x 机房：额度换算回 100 GB，已用 150 GB 超额，按超额策略处理
      expect(back.traffic).toBe(100);
      expect(back.freeSwitchAt?.getTime()).toBe(after.freeSwitchAt?.getTime());
      expect(await db.balanceLog.count({ where: { userId, type: 'SWITCH' } })).toBe(1);
    } finally {
      // 清理 Agent 上报，不影响后面的节点测试用例。
      const { redis } = await import('../src/lib/redis.ts');
      await redis.del(`node:host:${natNodeId}`);
      await settings({ nodeSwitchFee: 0 });
      await db.user.update({ where: { id: userId }, data: { balance: 0 } });
      await db.product.update({ where: { id: product.id }, data: { nodeOptions: product.nodeOptions ?? {} } });
      await db.node.update({ where: { id: target.id }, data: { enabled: false, products: { disconnect: { id: product.id } } } });
      await patchPlan({ priceMonthly: '5' });
    }
  }, 60_000);

  it('lets buyers choose among several nodes of a product in a region', async () => {
    const patch = (body: object) => request('PATCH', `/api/admin/plans/${planId}`, adminCookie, body);
    expect((await patch({ priceMonthly: '0' })).statusCode).toBe(200);
    const product = await db.product.findFirstOrThrow({ where: { plans: { some: { id: planId } } } });
    const second = await db.node.create({ data: { name: 'DC2', region: 'Test', endpoint: 'mock://create-nat-2', publicIp: '203.0.113.31', status: 'ONLINE', products: { connect: { id: product.id } } } });
    const nodes = async () => (await app.inject({ method: 'GET', url: `/api/public/products/${product.id}/nodes?region=Test` })).json().nodes as Array<{ id: number; name: string; plans: number[] }>;
    try {
      // 两台宿主机都能开通该套餐
      expect((await nodes()).map((n) => [n.id, n.plans.includes(planId)])).toEqual(
        expect.arrayContaining([
          [natNodeId, true],
          [second.id, true],
        ]),
      );
      // 满载的宿主机不能开通，指定它下单被拒绝
      await db.node.update({ where: { id: second.id }, data: { maxInstances: 0 } });
      expect((await nodes()).find((n) => n.id === second.id)?.plans).toEqual([]);
      const full = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'node-full', nodeId: second.id });
      expect(full.statusCode).toBe(409);
      // 指定的宿主机可用时开通在这台上
      await db.node.update({ where: { id: second.id }, data: { maxInstances: 10 } });
      const chosen = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'node-dc2', nodeId: second.id });
      expect(chosen.statusCode, chosen.body).toBe(200);
      expect((await db.instance.findUniqueOrThrow({ where: { id: chosen.json().instanceId } })).nodeId).toBe(second.id);
      // 不属于该产品 / 地区的宿主机
      expect((await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'node-x', nodeId: 999999 })).statusCode).toBe(409);
    } finally {
      // 不影响后续测试：解除绑定并停用
      await db.node.update({ where: { id: second.id }, data: { enabled: false, products: { disconnect: { id: product.id } } } });
      await patch({ priceMonthly: '5' });
    }
  }, 30_000);

  it('applies coupons to new orders and renewals with their limits', async () => {
    const admin = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      app.inject({ method, url, payload, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
    const quote = (payload: object) => request('POST', '/api/store/coupon', userCookie, payload);
    await db.user.update({ where: { id: userId }, data: { balance: 100 } });
    const { productId } = await db.plan.findUniqueOrThrow({ where: { id: planId } });

    // 后台：百分比不能超过 100；不填优惠码时自动生成
    expect((await admin('POST', '/api/admin/coupons', { code: 'over', type: 'PERCENT', value: 120 })).statusCode).toBe(400);
    const auto = await admin('POST', '/api/admin/coupons', { type: 'AMOUNT', value: 1, scope: 'RENEW' });
    expect(auto.json().code).toMatch(/^[A-Z2-9]{8}$/);
    const created = await admin('POST', '/api/admin/coupons', { code: 'half', type: 'PERCENT', value: 50, maxDiscount: 2, productIds: [productId], cycles: ['MONTHLY'], perUser: 1 });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({ code: 'HALF', scope: 'NEW', perUser: 1 });
    expect((await admin('POST', '/api/admin/coupons', { code: 'HALF', type: 'AMOUNT', value: 1 })).statusCode).toBe(409);

    // 试算：5 元的 50% 是 2.5，封顶 2 元
    const q = await quote({ kind: 'NEW', code: ' half ', planId, cycle: 'MONTHLY' });
    expect(q.statusCode, q.body).toBe(200);
    expect(q.json()).toMatchObject({ code: 'HALF', amount: '5.00', discount: '2.00', total: '3.00' });
    expect((await quote({ kind: 'NEW', code: 'nope', planId, cycle: 'MONTHLY' })).statusCode).toBe(400);
    expect((await quote({ kind: 'NEW', code: auto.json().code, planId, cycle: 'MONTHLY' })).statusCode).toBe(400); // 只能续费

    // 新购：实付 3 元，订单记录原价与减免
    const bought = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'coupon-01', couponCode: 'half' });
    expect(bought.statusCode, bought.body).toBe(200);
    expect(await balance()).toBe('97');
    const order = await db.order.findFirstOrThrow({ where: { instanceId: bought.json().instanceId, type: 'NEW' } });
    expect(order).toMatchObject({ couponCode: 'HALF' });
    expect([order.amount.toString(), order.discount.toString()]).toEqual(['3', '2']);
    expect((await db.coupon.findUniqueOrThrow({ where: { code: 'HALF' } })).usedCount).toBe(1);
    // 每人限用一次
    expect((await quote({ kind: 'NEW', code: 'half', planId, cycle: 'MONTHLY' })).statusCode).toBe(400);
    expect((await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'coupon-02', couponCode: 'half' })).statusCode).toBe(400);
    expect(await balance()).toBe('97');
    // 使用过的优惠码不能删除
    expect((await admin('DELETE', `/api/admin/coupons/${created.json().id}`)).statusCode).toBe(409);
    expect((await app.inject({ url: `/api/admin/coupons/${created.json().id}/usages`, headers: { cookie: adminCookie } })).json().items).toHaveLength(1);

    // 退还未开通实例的订单时归还次数
    const { refundUnprovisioned } = await import('../src/services/billing.ts');
    const inst = await db.instance.update({ where: { id: bought.json().instanceId }, data: { provisionedAt: null } });
    await db.$transaction((tx) => refundUnprovisioned(tx, inst));
    expect(await balance()).toBe('100');
    expect((await db.coupon.findUniqueOrThrow({ where: { code: 'HALF' } })).usedCount).toBe(0);
    await db.instance.update({ where: { id: inst.id }, data: { provisionedAt: new Date() } });

    // 续费：2 期 10 元，减 1 元
    const renewQuote = await quote({ kind: 'RENEW', code: auto.json().code, instanceId: inst.id, periods: 2 });
    expect(renewQuote.json()).toMatchObject({ amount: '10.00', discount: '1.00', total: '9.00' });
    const renewed = await request('POST', `/api/instances/${inst.id}/renew`, userCookie, { periods: 2, couponCode: auto.json().code });
    expect(renewed.statusCode, renewed.body).toBe(200);
    expect(await balance()).toBe('91');
    const overview = (await app.inject({ url: '/api/admin/billing/overview', headers: { cookie: adminCookie } })).json();
    expect(overview.coupons).toMatchObject({ count: 1 });

    // 循环抵扣：实例按优惠价续费；仅新用户的优惠码老用户不能用
    const recurring = await admin('POST', '/api/admin/coupons', { code: 'loyal', type: 'AMOUNT', value: 1, mode: 'RECURRING', planIds: [planId] });
    expect(recurring.json()).toMatchObject({ mode: 'RECURRING', planIds: [planId] });
    const loyal = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'loyal-01', couponCode: 'loyal' });
    expect(loyal.statusCode, loyal.body).toBe(200);
    const loyalInst = await db.instance.findUniqueOrThrow({ where: { id: loyal.json().instanceId } });
    // 原价不变，优惠码绑定到实例；自动续费也按优惠价扣款并在订单上记录
    expect(loyalInst.price.toString()).toBe('5');
    expect(loyalInst.couponId).toBe(recurring.json().id);
    const { renew } = await import('../src/services/billing.ts');
    await db.instance.update({ where: { id: loyalInst.id }, data: { provisionedAt: new Date() } });
    const beforeRenew = Number(await balance());
    await renew(loyalInst.id, 2, { auto: true });
    expect(Number(await balance())).toBe(beforeRenew - 8);
    const autoOrder = await db.order.findFirstOrThrow({ where: { instanceId: loyalInst.id, type: 'RENEW' } });
    expect([autoOrder.amount.toString(), autoOrder.discount.toString(), autoOrder.couponCode]).toEqual(['8', '2', 'LOYAL']);
    const dto = (await request('GET', `/api/instances/${loyalInst.id}`, userCookie)).json();
    expect(dto).toMatchObject({ renewPrice: '4.00', renewCoupon: { code: 'LOYAL' } });
    const totals = (await app.inject({ url: '/api/admin/coupons?q=loyal', headers: { cookie: adminCookie } })).json();
    expect(totals.items[0]).toMatchObject({ totalDiscount: '3.00', usedCount: 1 });
    // 多个产品与套餐：指定了套餐的产品只能用于这些套餐，没指定套餐的产品不限
    const other = await db.plan.create({ data: { productId, name: 'Other', type: 'LXC_NAT', cpu: 1, memory: 256, disk: 5, bandwidthIn: 10, bandwidthOut: 10, priceMonthly: 3 } });
    const second = await db.product.create({ data: { name: 'Second', type: 'LXC_NAT' } });
    const secondPlan = await db.plan.create({ data: { productId: second.id, name: 'S1', type: 'LXC_NAT', cpu: 1, memory: 256, disk: 5, bandwidthIn: 10, bandwidthOut: 10, priceMonthly: 3 } });
    await admin('POST', '/api/admin/coupons', { code: 'multi', type: 'AMOUNT', value: 1, productIds: [productId, second.id], planIds: [planId], perUser: null });
    expect((await quote({ kind: 'NEW', code: 'multi', planId, cycle: 'MONTHLY' })).statusCode).toBe(200);
    expect((await quote({ kind: 'NEW', code: 'multi', planId: other.id, cycle: 'MONTHLY' })).statusCode).toBe(400);
    expect((await quote({ kind: 'NEW', code: 'multi', planId: secondPlan.id, cycle: 'MONTHLY' })).statusCode).toBe(200);
    await db.plan.deleteMany({ where: { id: { in: [other.id, secondPlan.id] } } });
    await db.product.delete({ where: { id: second.id } });

    await admin('POST', '/api/admin/coupons', { code: 'first', type: 'AMOUNT', value: 1, newUserOnly: true });
    expect((await quote({ kind: 'NEW', code: 'first', planId, cycle: 'MONTHLY' })).statusCode).toBe(400);
  });

  it('lets each account redeem a multi-use code once', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/redeem-codes', payload: { amount: 3, count: 1, maxUses: 2 }, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
    const [code] = created.json().codes as string[];
    const before = Number(await balance());
    expect((await request('POST', '/api/billing/redeem', userCookie, { code })).statusCode).toBe(200);
    expect(Number(await balance())).toBe(before + 3);
    expect((await request('POST', '/api/billing/redeem', userCookie, { code })).statusCode).toBe(400);
    const row = await db.redeemCode.findUniqueOrThrow({ where: { code }, include: { usages: true } });
    expect([row.usedCount, row.maxUses, row.usages.length]).toEqual([1, 2, 1]);
    // 已经有人兑换过的不能删除
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/redeem-codes/${row.id}`, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } })).statusCode).toBe(409);
  });

  it('assigns the number of public IPv6 addresses configured on the plan', async () => {
    const v6 = await db.node.create({
      data: { name: 'V6 node', region: 'V6', endpoint: 'mock://create-v6', publicIp: '203.0.113.31', networkMode: 'NAT_IPV6', ipv6Subnet: '2001:db8:6::/64', status: 'ONLINE' },
    });
    const product = await db.product.create({ data: { name: 'V6', nodes: { connect: [{ id: natNodeId }, { id: v6.id }] } } });
    const plan = await request('POST', '/api/admin/plans', adminCookie, { productId: product.id, name: 'V6x2', cpu: 1, memory: 512, disk: 10, bandwidthIn: 10, bandwidthOut: 10, ipv6Count: 2, priceMonthly: '0' });
    expect(plan.statusCode, plan.body).toBe(200);
    // 需要 IPv6 的套餐只在 IPv6 宿主机所在地区出售
    expect(plan.json()).toMatchObject({ ipv6Count: 2, regions: ['V6'] });
    const res = await request('POST', '/api/store/orders', userCookie, { planId: plan.json().id, region: 'V6', imageId, cycle: 'MONTHLY', hostname: 'v6-01' });
    expect(res.statusCode, res.body).toBe(200);
    const inst = await db.instance.findUniqueOrThrow({ where: { id: res.json().instanceId } });
    const addresses = inst.publicIpv6!.split(',');
    expect(addresses).toHaveLength(2);
    expect(new Set(addresses).size).toBe(2);
    expect(addresses.every((a) => a.startsWith('2001:db8:6:'))).toBe(true);
    const dto = (await request('GET', `/api/instances/${inst.id}`, userCookie)).json();
    expect(dto.ipv6List).toEqual(addresses);
    expect(dto.ipv6).toBe(addresses[0]);
  });

  it('transfers instances to another user as-is or after a fresh install', async () => {
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword('test-admin-create-password-1');
    const recipient = await db.user.create({ data: { username: 'recv-user', email: 'recv-user@example.com', passwordHash: hash, emailVerifiedAt: new Date() } });
    await db.user.create({ data: { username: 'gone-user', email: 'gone-user@example.com', passwordHash: hash, status: 'DISABLED' } });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: 'recv-user', password: 'test-admin-create-password-1' }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    const recipientCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const inst = await db.instance.findFirstOrThrow({ where: { hostname: 'custom-01' }, include: { portMappings: true } });
    expect(inst).toMatchObject({ userId, status: 'RUNNING', autoRenew: true });
    const snapshot = await db.snapshot.create({ data: { instanceId: inst.id, name: 'keep-me' } });
    const transfer = (cookie: string, body: object, admin = false) =>
      request('POST', `${admin ? '/api/admin' : '/api'}/instances/${inst.id}/transfer`, cookie, { confirm: 'custom-01', mode: 'KEEP', ...body });

    // 校验：确认文本、接收方不存在 / 是管理员 / 已禁用 / 已是所有者
    expect((await transfer(userCookie, { target: 'recv-user', confirm: 'nope' })).statusCode).toBe(400);
    expect((await transfer(userCookie, { target: 'nobody' })).statusCode).toBe(404);
    expect((await transfer(userCookie, { target: 'create-admin' })).statusCode).toBe(404);
    expect((await transfer(userCookie, { target: 'gone-user' })).statusCode).toBe(400);
    expect((await transfer(userCookie, { target: 'create-user' })).statusCode).toBe(400);
    expect((await transfer(recipientCookie, { target: 'recv-user' })).statusCode).toBe(404);

    // 转移前检查：接收方是否可用与手续费（按续费价格 12.50 的 10%，管理员不收取）
    expect((await request('PUT', '/api/admin/settings', adminCookie, { transferFeeMode: 'PERCENT', transferFeeValue: 10 })).statusCode).toBe(200);
    const check = async (target: string, cookie = userCookie, base = '/api') =>
      (await request('GET', `${base}/instances/${inst.id}/transfer/check?target=${encodeURIComponent(target)}`, cookie)).json();
    expect(await check('nobody')).toMatchObject({ fee: '1.25', recipient: null, error: expect.any(String) });
    expect(await check('gone-user')).toMatchObject({ recipient: null, error: expect.any(String) });
    expect(await check('recv-user')).toEqual({ fee: '1.25', recipient: { username: 'recv-user' }, error: null });
    expect(await check('')).toEqual({ fee: '1.25', recipient: null, error: null });
    expect(await check('recv-user', adminCookie, '/api/admin')).toMatchObject({ fee: '0.00' });
    const before = Number(await balance());

    // 完整转移（按邮箱指定接收方）：数据、快照、端口映射保留，自动续费关闭，原所有者失去访问权限
    const kept = await transfer(userCookie, { target: 'RECV-USER@example.com', remark: '交易单号 A1' });
    expect(kept.statusCode, kept.body).toBe(200);
    // 转出方支付手续费，双方都收到带备注的站内信
    expect(Number(await balance())).toBeCloseTo(before - 1.25, 2);
    expect(await db.balanceLog.count({ where: { userId, type: 'TRANSFER' } })).toBe(1);
    const msgs = await db.message.findMany({ where: { userId: { in: [userId, recipient.id] } } });
    expect(msgs).toHaveLength(2);
    expect(msgs.every((m) => m.content.includes('交易单号 A1'))).toBe(true);
    expect(msgs.find((m) => m.userId === userId)!.content).toContain('1.25');
    expect((await request('PUT', '/api/admin/settings', adminCookie, { transferFeeMode: 'NONE' })).statusCode).toBe(200);
    expect(kept.json().target.username).toBe('recv-user');
    const after = await db.instance.findUniqueOrThrow({ where: { id: inst.id }, include: { portMappings: true } });
    expect(after).toMatchObject({ userId: recipient.id, autoRenew: false, status: 'RUNNING', rootPassword: inst.rootPassword });
    expect(after.portMappings).toHaveLength(inst.portMappings.length);
    expect(await db.snapshot.count({ where: { id: snapshot.id } })).toBe(1);
    expect(await db.task.count({ where: { instanceId: inst.id, type: 'REINSTALL' } })).toBe(0);
    // 实例 ID 改为接收方：关机改名后恢复运行
    const rename = await db.task.findFirstOrThrow({ where: { instanceId: inst.id, type: 'RENAME' } });
    await runTask(rename.id);
    const renamed = await db.instance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(renamed.name).toMatch(new RegExp(`^pd-${recipient.id}-[a-z0-9]{8}$`));
    expect(renamed.status, renamed.lastError ?? '').toBe('RUNNING');
    expect((await db.task.findUniqueOrThrow({ where: { id: rename.id } })).status).toBe('SUCCESS');
    expect((await request('GET', `/api/instances/${inst.id}`, userCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/instances/${inst.id}`, recipientCookie)).statusCode).toBe(200);
    expect(await db.message.count({ where: { userId: recipient.id } })).toBe(1);
    expect(await db.activityLog.count({ where: { action: 'instance.transfer_in', userId: recipient.id } })).toBe(1);

    // 管理员全新安装后转回：删除自定义端口映射与网站绑定，生成新密码并重装
    await db.portMapping.create({ data: { instanceId: inst.id, nodeId: inst.nodeId, publicPort: 40001, privatePort: 80 } });
    await db.siteBinding.create({ data: { instanceId: inst.id, domain: 'old-owner.example.com' } });
    const fresh = await transfer(adminCookie, { target: 'create-user', mode: 'REINSTALL', imageId }, true);
    expect(fresh.statusCode, fresh.body).toBe(200);
    const moved = await db.instance.findUniqueOrThrow({ where: { id: inst.id }, include: { portMappings: true } });
    expect(moved.userId).toBe(userId);
    expect(moved.portMappings.map((m) => m.system)).toEqual([true]);
    expect(await db.siteBinding.count({ where: { instanceId: inst.id } })).toBe(0);
    const task = await db.task.findFirstOrThrow({ where: { instanceId: inst.id, type: 'REINSTALL' } });
    await runTask(task.id);
    const done = await db.instance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(done.status, done.lastError ?? '').toBe('RUNNING');
    expect(done.rootPassword).not.toBe(inst.rootPassword);
    expect(done.name).toMatch(new RegExp(`^pd-${userId}-[a-z0-9]{8}$`));
    expect(await db.snapshot.count({ where: { instanceId: inst.id } })).toBe(0);
    // 管理员操作时通知原所有者和新所有者
    expect(await db.message.count({ where: { userId: recipient.id } })).toBe(2);
    expect(await db.message.count({ where: { userId } })).toBe(2);

    // 转移记录：各自看到转入 / 转出，管理员操作时不显示对方账号
    const records = async (cookie: string) => (await request('GET', '/api/transfers', cookie)).json() as Array<Record<string, unknown>>;
    expect(await records(recipientCookie)).toMatchObject([
      { direction: 'OUT', counterpart: null, byAdmin: true, mode: 'REINSTALL', accessible: false, hostname: 'custom-01' },
      { direction: 'IN', counterpart: 'create-user', byAdmin: false, mode: 'KEEP', accessible: false, remark: '交易单号 A1', fee: '0.00' },
    ]);
    expect(await records(userCookie)).toMatchObject([
      { direction: 'IN', counterpart: null, byAdmin: true, mode: 'REINSTALL', accessible: true },
      { direction: 'OUT', counterpart: 'recv-user', mode: 'KEEP', accessible: true, remark: '交易单号 A1', fee: '1.25', spec: { type: 'LXC_NAT', cpu: 3, memory: 1536, disk: 25, price: '12.50', cycle: 'MONTHLY', image: expect.stringContaining('Debian 12'), region: 'Test' } },
    ]);
    expect((await request('GET', '/api/transfers', adminCookie)).statusCode).toBe(403);
  }, 30_000);

  it('pays referral commission on invitee orders and reverses it on refunds', async () => {
    const settings = (body: object) => request('PUT', '/api/admin/settings', adminCookie, body);
    const register = (username: string, aff?: string) =>
      request('POST', '/api/auth/register', '', { email: `${username}@example.com`, username, password: 'test-admin-create-password-1', aff });

    // 未开启时：没有推广码，带推广码注册也不记录邀请人
    expect((await request('GET', '/api/aff', userCookie)).json()).toMatchObject({ enabled: false, code: null });
    expect((await register('aff_early', 'ANYCODE')).statusCode).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { username: 'aff_early' } })).referrerId).toBeNull();

    expect((await settings({ affEnabled: true, affRateNew: 8, affRateRenew: 3, affFreezeDays: 0, affMinWithdraw: 1 })).statusCode).toBe(200);
    expect((await request('GET', '/api/public/config', '')).json().affEnabled).toBe(true);
    const summary = (await request('GET', '/api/aff', userCookie)).json();
    expect(summary).toMatchObject({ enabled: true, rateNew: 8, rateRenew: 3, freezeDays: 0, balance: '0.00', pending: '0.00', invited: 0 });
    expect(summary.code).toMatch(/^[A-Z0-9]{8}$/);
    // 推广码只生成一次
    expect((await request('GET', '/api/aff', userCookie)).json().code).toBe(summary.code);

    expect((await register('aff_friend', summary.code.toLowerCase())).statusCode).toBe(200);
    const friend = await db.user.findUniqueOrThrow({ where: { username: 'aff_friend' } });
    expect(friend.referrerId).toBe(userId);
    await db.user.update({ where: { id: friend.id }, data: { balance: 100 } });
    const { addAffCredit } = await import('../src/services/aff.ts');
    const topUp = (amount: number) => db.$transaction((tx) => addAffCredit(tx, friend.id, new Prisma.Decimal(amount)));
    const buy = async (hostname: string, price: string) => {
      const res = await request('POST', '/api/admin/instances', adminCookie, spec({ userId: friend.id, hostname, charge: true, price }));
      expect(res.statusCode, res.body).toBe(200);
      return db.instance.findUniqueOrThrow({ where: { id: res.json().instanceId } });
    };
    const aff = async () => (await request('GET', '/api/aff', userCookie)).json();
    const logs = async () => (await request('GET', '/api/aff/logs', userCookie)).json().items;

    // 赠送 / 调整得到的余额付款不返佣
    const zero = await buy('aff-00', '20.05');
    expect(await aff()).toMatchObject({ balance: '0.00', paidInvitees: 0 });

    // 支付渠道充值 15 后首购 20.05：按实际支付的 15.00 返 8%
    await topUp(15);
    const first = await buy('aff-01', '20.05');
    expect(await aff()).toMatchObject({ balance: '1.20', total: '1.20', invited: 1, paidInvitees: 1 });
    expect((await db.user.findUniqueOrThrow({ where: { id: friend.id } })).affCredit.toString()).toBe('0');
    // 再充值 10 后续费（已开通的实例）：返 3%
    await topUp(10);
    await db.instance.update({ where: { id: zero.id }, data: { provisionedAt: new Date(), status: 'RUNNING' } });
    const { renew } = await import('../src/services/billing.ts');
    await renew(zero.id, 1, { userId: friend.id });
    expect(await logs()).toMatchObject([
      { type: 'EARN', status: 'SETTLED', amount: '0.30', orderAmount: '10.00', rate: '3', orderType: 'RENEW', invitee: 'af***d' },
      { type: 'EARN', status: 'SETTLED', amount: '1.20', orderAmount: '15.00', rate: '8', orderType: 'NEW', orderNo: expect.any(String) },
    ]);

    // 转入余额
    const before = Number(await balance());
    const withdraw = await request('POST', '/api/aff/withdraw', userCookie);
    expect(withdraw.statusCode, withdraw.body).toBe(200);
    expect(Number(await balance())).toBeCloseTo(before + 1.5, 2);
    expect(await db.balanceLog.count({ where: { userId, type: 'AFF' } })).toBe(1);
    expect((await request('POST', '/api/aff/withdraw', userCookie)).statusCode).toBe(400);

    // 首购订单退款（实例未开通就删除）：撤回佣金（佣金余额变为负数），退回可返佣额度
    const { refundUnprovisioned } = await import('../src/services/billing.ts');
    await db.$transaction((tx) => refundUnprovisioned(tx, first));
    expect(await aff()).toMatchObject({ balance: '-1.20', total: '0.30' });
    expect((await logs()).map((l: { status: string }) => l.status)).toEqual(['SETTLED', 'REVOKED']);
    expect((await db.user.findUniqueOrThrow({ where: { id: friend.id } })).affCredit.toString()).toBe('15');

    // 冻结期：佣金先待生效，期间退款作废；到期后计入可用佣金
    expect((await settings({ affFreezeDays: 7 })).statusCode).toBe(200);
    const frozen = await buy('aff-02', '10.00');
    expect(await aff()).toMatchObject({ balance: '-1.20', pending: '0.80', freezeDays: 7 });
    const pending = (await logs())[0];
    expect(pending).toMatchObject({ status: 'PENDING', amount: '0.80' });
    expect(new Date(pending.effectiveAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    await db.$transaction((tx) => refundUnprovisioned(tx, frozen));
    expect(await aff()).toMatchObject({ balance: '-1.20', pending: '0.00' });
    expect((await logs())[0].status).toBe('CANCELED');
    await buy('aff-03', '5.00');
    await db.affLog.updateMany({ where: { status: 'PENDING' }, data: { effectiveAt: new Date(Date.now() - 1000) } });
    expect(await aff()).toMatchObject({ balance: '-0.80', pending: '0.00', total: '0.70' });
    expect((await logs())[0].status).toBe('SETTLED');
    expect((await settings({ affEnabled: false, affFreezeDays: 0 })).statusCode).toBe(200);
  });

  it('batch edits specs, limits, traffic, quotas and renewal settings of several instances', async () => {
    const make = async (hostname: string, over: Record<string, unknown>) => {
      const res = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname, ...over }));
      expect(res.statusCode, res.body).toBe(200);
      const id = res.json().instanceId as number;
      await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
      return id;
    };
    const a = await make('batch-01', { disk: 10, cpuPriority: 5, trafficResetPrice: '1.00' });
    const b = await make('batch-02', { disk: 30, processLimit: 512 });
    const batch = (config: object) => request('POST', '/api/admin/instances/batch', adminCookie, { ids: [a, b], action: 'config', config });

    const res = await batch({
      cpu: 2, cpuPriority: null, processLimit: 256, disk: 20, diskReadIops: 3000, diskWrite: 80, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 5, trafficResetPrice: null, snapshotLimit: 4, price: '9.90', autoRenew: false,
    });
    expect(res.statusCode, res.body).toBe(200);
    // 系统盘不能缩小：30 GiB 的实例单独失败，其余照常修改
    expect(res.json()).toMatchObject({ ok: 1, failed: [{ id: b }] });
    const edited = await db.instance.findUniqueOrThrow({ where: { id: a } });
    expect(edited).toMatchObject({ cpu: 2, cpuPriority: null, processLimit: 256, disk: 20, diskReadIops: 3000, diskWrite: 80, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 5, trafficResetPrice: null, snapshotLimit: 4, autoRenew: false });
    expect(edited.price.toString()).toBe('9.9');
    expect((await db.instance.findUniqueOrThrow({ where: { id: b } })).processLimit).toBe(512);
    // 资源限制变化后下发到宿主机
    expect(await db.task.count({ where: { instanceId: a, type: 'APPLY_LIMITS' } })).toBe(1);

    // 同一方向既按速率又按 IOPS 限制的实例单独失败（a 已按 IOPS 限制读取）
    expect((await batch({ diskRead: 100 })).json()).toMatchObject({ ok: 1, failed: [{ id: a }] });
    expect((await batch({})).statusCode).toBe(400);

    // 通知用户：站内信按用户去重；勾选邮件时，单个收件人立即发送，多个收件人进入队列每分钟发 1 封
    const notify = (ids: number[], email: boolean) => request('POST', '/api/admin/instances/batch', adminCookie, { ids, action: 'notify', title: '维护通知', content: '今晚维护', email });
    expect((await notify([a, b], true)).statusCode).toBe(400); // 邮件未配置
    const { setMailCapture } = await import('../src/services/mail/mailer.ts');
    const { setSetting } = await import('../src/lib/settings.ts');
    const { mailQueueLength, sendQueuedMail } = await import('../src/services/mail/business-mail.ts');
    const sent: { to: string; subject: string; text: string }[] = [];
    setMailCapture((m) => sent.push(m));
    await setSetting('mail', { enabled: true, host: 'smtp.example.invalid', fromEmail: 'noreply@example.invalid' });
    try {
      const single = await notify([a, b], true);
      expect(single.json()).toMatchObject({ ok: 2, notified: { users: 1, mailSent: 1, mailQueued: 0 } });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'create-user@example.com', subject: expect.stringContaining('维护通知') });
      expect(sent[0].text).toContain('batch-01');

      const other = await db.user.create({ data: { username: 'notify-user', email: 'notify-user@example.com', passwordHash: 'x' } });
      await db.instance.update({ where: { id: b }, data: { userId: other.id } });
      const multi = (await notify([a, b], true)).json();
      expect(multi.notified).toEqual({ users: 2, mailSent: 0, mailQueued: 2 });
      expect(sent).toHaveLength(1);
      expect(await mailQueueLength()).toBe(2);
      const log = { warn: () => undefined };
      await sendQueuedMail(log);
      expect(sent).toHaveLength(2);
      expect(await mailQueueLength()).toBe(1);
      await sendQueuedMail(log);
      expect(sent.map((m) => m.to).sort()).toEqual(['create-user@example.com', 'create-user@example.com', 'notify-user@example.com']);
      expect(await db.message.count({ where: { title: '维护通知' } })).toBe(3);
    } finally {
      setMailCapture(null);
      await setSetting('mail', { enabled: false });
    }

    // 封禁时填写原因：用户可见，解封后清空
    const act = (body: object) => request('POST', `/api/admin/instances/${a}/actions`, adminCookie, body);
    // 先执行完批量配置排队的下发任务
    for (const task of await db.task.findMany({ where: { instanceId: a, status: 'QUEUED' } })) await runTask(task.id);
    const suspended = await act({ action: 'suspend', note: '  被投诉发送垃圾邮件  ' });
    expect(suspended.statusCode, suspended.body).toBe(200);
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: a, type: 'SUSPEND' }, orderBy: { id: 'desc' } })).id);
    expect(await db.instance.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: 'SUSPENDED', suspendReason: 'ADMIN', suspendNote: '被投诉发送垃圾邮件' });
    expect((await request('GET', `/api/instances/${a}`, userCookie)).json()).toMatchObject({ status: 'SUSPENDED', suspendNote: '被投诉发送垃圾邮件' });
    const blocked = await request('POST', `/api/instances/${a}/power`, userCookie, { action: 'start' });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().message).toContain('被投诉发送垃圾邮件');
    expect((await act({ action: 'unsuspend' })).statusCode).toBe(200);
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: a, type: 'UNSUSPEND' }, orderBy: { id: 'desc' } })).id);
    expect(await db.instance.findUniqueOrThrow({ where: { id: a } })).toMatchObject({ status: 'RUNNING', suspendReason: null, suspendNote: null });
  }, 30_000);

  it('deletes instances with a remaining-value, full or no refund and tells the owner why', async () => {
    await db.user.update({ where: { id: userId }, data: { balance: 500 } });
    const make = async (hostname: string) => {
      const res = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname, price: '30.00', charge: true, autoRenew: false }));
      expect(res.statusCode, res.body).toBe(200);
      const id = res.json().instanceId as number;
      await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
      return id;
    };
    const runDelete = async (id: number) => runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'DELETE' } })).id);
    const refundLogs = () => db.balanceLog.findMany({ where: { userId, type: 'REFUND' }, orderBy: { id: 'desc' } });
    const { remainingValue, renew } = await import('../src/services/billing.ts');

    // 按剩余价值：半个周期左右的剩余时长退回对应金额，用户收到带原因与金额的站内信
    const half = await make('del-remaining');
    await db.instance.update({ where: { id: half }, data: { expiresAt: new Date(Date.now() + 15 * 86_400_000) } });
    const expected = remainingValue(await db.instance.findUniqueOrThrow({ where: { id: half } }));
    expect(Number(expected)).toBeGreaterThan(13);
    expect(Number(expected)).toBeLessThan(16);
    // 删除前的退款预览：剩余价值与实际退款一致（允许跨分钟的 1 分误差），全额为已付订单之和
    const preview1 = await request('POST', '/api/admin/instances/refund-preview', adminCookie, { ids: [half] });
    expect(preview1.statusCode, preview1.body).toBe(200);
    expect(preview1.json().items).toHaveLength(1);
    expect(Math.abs(Number(preview1.json().items[0].refund.REMAINING) - Number(expected))).toBeLessThanOrEqual(0.01);
    expect(preview1.json().items[0].refund).toMatchObject({ FULL: '30.00', NONE: '0.00' });
    const res = await request('POST', `/api/admin/instances/${half}/actions`, adminCookie, { action: 'delete', refundMode: 'REMAINING', note: '多次被投诉' });
    expect(res.statusCode, res.body).toBe(200);
    await runDelete(half);
    expect((await refundLogs())[0].amount.toString()).toBe(expected.toString());
    const msg = await db.message.findFirstOrThrow({ where: { userId, title: { contains: 'del-remaining' } } });
    expect(msg.content).toContain('多次被投诉');
    expect(msg.content).toContain(expected.toFixed(2));

    // 退全款：新购与续费订单全部退回并标记为已退款
    const full = await make('del-full');
    await renew(full, 1, { userId });
    // 多个实例的预览：逐个列出并给出合计；已删除的实例不计入
    const preview2 = (await request('POST', '/api/admin/instances/refund-preview', adminCookie, { ids: [full, half] })).json();
    expect(preview2.items.map((i: { id: number }) => i.id)).toEqual([full]);
    expect(preview2.items[0].refund.FULL).toBe('60.00');
    expect(preview2.total.FULL).toBe('60.00');
    const batch = await request('POST', '/api/admin/instances/batch', adminCookie, { ids: [full], action: 'delete', refundMode: 'FULL', note: '' });
    expect(batch.json()).toMatchObject({ ok: 1, failed: [] });
    await runDelete(full);
    expect((await refundLogs())[0].amount.toString()).toBe('60');
    expect(await db.order.count({ where: { instanceId: full, status: 'REFUNDED' } })).toBe(2);
    expect((await db.message.findFirstOrThrow({ where: { userId, title: { contains: 'del-full' } } })).content).not.toContain('删除原因');

    // 不退款
    const none = await make('del-none');
    const before = await db.balanceLog.count({ where: { userId, type: 'REFUND' } });
    await request('POST', `/api/admin/instances/${none}/actions`, adminCookie, { action: 'delete', refundMode: 'NONE' });
    await runDelete(none);
    expect(await db.balanceLog.count({ where: { userId, type: 'REFUND' } })).toBe(before);
    expect((await db.message.findFirstOrThrow({ where: { userId, title: { contains: 'del-none' } } })).content).toContain('不退款');
    expect((await db.instance.findUniqueOrThrow({ where: { id: none } })).status).toBe('DELETED');
  }, 60_000);

  it('lets the owner pay to reset traffic when the instance offers it', async () => {
    const make = async (hostname: string, trafficResetPrice: string | null) => {
      const res = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname, price: '0', trafficResetPrice }));
      expect(res.statusCode, res.body).toBe(200);
      const task = await db.task.findFirstOrThrow({ where: { instanceId: res.json().instanceId, type: 'CREATE' } });
      await runTask(task.id);
      return res.json().instanceId as number;
    };
    const paid = await make('traffic-01', '2.50');
    const off = await make('traffic-02', null);
    expect((await request('GET', `/api/instances/${paid}`, userCookie)).json()).toMatchObject({ trafficResetPrice: '2.50', throttleRate: 2 });

    // 超额被限速后付费重置：扣款、清零、解除限速；重置日不变
    const before = await db.instance.update({ where: { id: paid }, data: { trafficOut: 900n * 1024n ** 3n, trafficThrottled: true } });
    const balanceBefore = Number(await balance());
    const res = await request('POST', `/api/instances/${paid}/reset-traffic`, userCookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().price).toBe('2.50');
    const after = await db.instance.findUniqueOrThrow({ where: { id: paid } });
    expect(after).toMatchObject({ trafficOut: 0n, trafficThrottled: false });
    expect(after.trafficResetAt.getTime()).toBe(before.trafficResetAt.getTime());
    expect(Number(await balance())).toBeCloseTo(balanceBefore - 2.5, 2);
    expect(await db.balanceLog.count({ where: { userId, type: 'TRAFFIC' } })).toBe(1);
    expect(await db.task.count({ where: { instanceId: paid, type: 'APPLY_LIMITS' } })).toBe(1);

    // 未开放自助重置、管理员接口路径不提供该操作
    expect((await request('POST', `/api/instances/${off}/reset-traffic`, userCookie)).statusCode).toBe(400);
    expect((await request('POST', `/api/admin/instances/${paid}/reset-traffic`, adminCookie)).statusCode).toBe(404);
    // 余额不足
    await db.user.update({ where: { id: userId }, data: { balance: 1 } });
    expect((await request('POST', `/api/instances/${paid}/reset-traffic`, userCookie)).statusCode).toBe(402);
    await db.user.update({ where: { id: userId }, data: { balance: balanceBefore - 2.5 } });
  }, 30_000);

  it('restricts registration to whitelisted email domains', async () => {
    const register = (email: string, username: string) => request('POST', '/api/auth/register', '', { email, username, password: 'test-admin-create-password-1' });
    // 规范化：去掉 @、转小写、去重；格式错误时拒绝保存
    expect((await request('PUT', '/api/admin/settings', adminCookie, { emailDomains: ['bad domain'] })).statusCode).toBe(400);
    const saved = await request('PUT', '/api/admin/settings', adminCookie, { emailDomains: ['@Example.ORG', 'edu.cn', 'edu.cn'] });
    expect(saved.json().emailDomains).toEqual(['example.org', 'edu.cn']);
    expect((await request('GET', '/api/public/config', '')).json().emailDomains).toEqual(['example.org', 'edu.cn']);

    const denied = await register('someone@gmail.com', 'wl_denied');
    expect(denied.statusCode).toBe(400);
    expect(denied.json().message).toContain('example.org');
    // 子域名也允许
    expect((await register('ok@example.org', 'wl_ok')).statusCode).toBe(200);
    expect((await register('ok@mail.edu.cn', 'wl_sub')).statusCode).toBe(200);
    // 形似但不是子域名的不允许
    expect((await register('x@notedu.cn', 'wl_fake')).statusCode).toBe(400);
    expect((await request('PUT', '/api/admin/settings', adminCookie, { emailDomains: [] })).statusCode).toBe(200);
  });

  it('counts a TCP+UDP port mapping as two quota', async () => {
    const res = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname: 'ports-01', price: '0', portLimit: 3 }));
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().instanceId as number;
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
    const add = (protocol: string, privatePort: number) => request('POST', `/api/instances/${id}/ports`, userCookie, { protocol, privatePort });
    expect((await add('TCP_UDP', 80)).statusCode).toBe(200);
    // 剩 1 个配额：TCP+UDP 放不下，单一协议可以
    const over = await add('TCP_UDP', 443);
    expect(over.statusCode).toBe(400);
    expect(over.json().message).toContain('TCP+UDP');
    expect((await add('UDP', 53)).statusCode).toBe(200);
    expect((await add('TCP', 22)).statusCode).toBe(400);
  }, 30_000);

  it('saves SSH public keys with OpenSSH fingerprints', async () => {
    const key = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAeG0tZef0EJy/KCvrpp3PiWjVUvvi/64mLHCS1OWl6E test@paledove';
    const added = await request('POST', '/api/ssh-keys', userCookie, { publicKey: `  ${key}\n` });
    expect(added.statusCode, added.body).toBe(200);
    // 与 ssh-keygen -lf 的输出一致；没填名称时用注释
    expect(added.json()).toMatchObject({ name: 'test@paledove', type: 'ssh-ed25519', bits: null, fingerprint: 'SHA256:kEnNqAvwjqUpIfC5c36MYP9cWfM+v/PNtureZaqa2aI', publicKey: key });
    expect((await request('POST', '/api/ssh-keys', userCookie, { name: 'again', publicKey: key })).statusCode).toBe(409);
    // 类型与内容不一致、乱码
    expect((await request('POST', '/api/ssh-keys', userCookie, { publicKey: key.replace('ssh-ed25519', 'ssh-rsa') })).statusCode).toBe(400);
    expect((await request('POST', '/api/ssh-keys', userCookie, { publicKey: 'ssh-ed25519 not-base64!' })).statusCode).toBe(400);
    const list = (await request('GET', '/api/ssh-keys', userCookie)).json();
    expect(list).toHaveLength(1);
    // 管理员没有这个功能；只能删除自己的公钥
    expect((await request('GET', '/api/ssh-keys', adminCookie)).statusCode).toBe(403);
    expect((await request('DELETE', `/api/ssh-keys/${list[0].id}`, userCookie)).statusCode).toBe(200);
    expect((await request('GET', '/api/ssh-keys', userCookie)).json()).toHaveLength(0);
  });

  it('pages messages and filters the account activity log', async () => {
    const page = (await request('GET', '/api/messages?page=1&pageSize=1', userCookie)).json();
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
    const unread = (await request('GET', '/api/messages?unread=true', userCookie)).json();
    expect(unread.total).toBe(unread.unread);
    const first = page.items[0].id as number;
    expect((await request('POST', '/api/messages/read', userCookie, { ids: [first] })).statusCode).toBe(200);
    expect((await db.message.findUniqueOrThrow({ where: { id: first } })).readAt).not.toBeNull();
    // 只能删除自己的站内信
    expect((await request('POST', '/api/messages/delete', adminCookie, { ids: [first] })).json().deleted).toBe(0);
    expect((await request('POST', '/api/messages/delete', userCookie, { ids: [first] })).json().deleted).toBe(1);

    const logs = (await request('GET', '/api/logs?module=instance', userCookie)).json();
    expect(logs.total).toBeGreaterThan(0);
    expect(logs.items.every((l: { action: string }) => l.action.startsWith('instance.'))).toBe(true);
    const tasks = (await request('GET', '/api/tasks?type=REINSTALL', userCookie)).json();
    expect(tasks.items.every((x: { type: string }) => x.type === 'REINSTALL')).toBe(true);
  });

  it('configures smart routing egresses, pushes them to the agent and lets users switch', async () => {
    const agentLib = await import('../src/services/agent/agent.ts');
    const { createHash, createHmac, randomBytes } = await import('node:crypto');
    const secret = await agentLib.issueAgentToken(natNodeId);
    const signed = (method: 'GET' | 'POST', url: string, body?: object) => {
      const payload = body ? JSON.stringify(body) : '';
      const nonce = randomBytes(18).toString('base64url');
      const ts = String(Date.now());
      const sig = createHmac('sha256', secret).update([method, url, ts, nonce, createHash('sha256').update(payload).digest('hex')].join('\n')).digest('hex');
      return app.inject({ method, url, payload: body ? payload : undefined, headers: { 'content-type': 'application/json', 'x-paledove-node': String(natNodeId), 'x-paledove-timestamp': ts, 'x-paledove-nonce': nonce, 'x-paledove-signature': sig } });
    };
    const report = () => signed('POST', '/api/agent/nodes/report', { version: 3, release: '0.0.1', cpu: 1, load: [0, 0, 0], uptime: 10, arch: 'amd64', capabilities: ['egress'] });
    const base = `/api/admin/nodes/${natNodeId}/egress`;
    const inst = await db.instance.findFirstOrThrow({ where: { nodeId: natNodeId, userId, status: { not: 'DELETED' }, privateIp: { not: null } } });
    const priv = 'kNCnIzbQ3nRbNDNnYEsr5hDJ1z9RXQgRIzO7W1OSv2Q=';
    const pub = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
    try {
      // 未开启：用户不能切换
      expect((await request('GET', `/api/instances/${inst.id}/egress`, userCookie)).json()).toMatchObject({ available: false });
      expect((await request('PUT', `${base}/enabled`, userCookie, { enabled: true })).statusCode).toBe(403);
      const v0 = (await report()).json().egress.version as number;
      expect((await request('PUT', `${base}/enabled`, adminCookie, { enabled: true })).json()).toMatchObject({ enabled: true, agent: { online: true, supported: true } });

      // 添加 WireGuard 与 SOCKS5 出口；校验密钥与地址
      expect((await request('POST', base, adminCookie, { name: 'bad', type: 'WIREGUARD', wireguard: { privateKey: 'nope', address: '10.7.0.2/32', peerPublicKey: pub, endpoint: '1.2.3.4:51820' } })).statusCode).toBe(400);
      expect((await request('POST', base, adminCookie, { name: 'bad', type: 'WIREGUARD', wireguard: { privateKey: '', address: '10.7.0.2/32', peerPublicKey: pub, endpoint: '1.2.3.4:51820' } })).statusCode).toBe(400);
      const wg = await request('POST', base, adminCookie, { name: 'HK WG', type: 'WIREGUARD', wireguard: { privateKey: priv, address: '10.7.0.2/32', peerPublicKey: pub, endpoint: '203.0.113.9:51820' } });
      expect(wg.statusCode, wg.body).toBe(200);
      const socks = (await request('POST', base, adminCookie, { name: 'US', type: 'SOCKS5', proxy: { host: '198.51.100.4', port: 1080, username: 'u', password: 'secret-pass' } })).json();
      const [wgItem, socksItem] = socks.items as { id: number; wireguard: Record<string, unknown> | null; proxy: Record<string, unknown> | null }[];
      // 管理端不返回私钥与密码，只标出已设置；数据库中加密保存
      expect(JSON.stringify(socks)).not.toContain(priv);
      expect(JSON.stringify(socks)).not.toContain('secret-pass');
      expect(wgItem!.wireguard).toMatchObject({ hasPrivateKey: true, mtu: 1420, keepalive: 25 });
      expect(socksItem!.proxy).toMatchObject({ username: 'u', hasPassword: true });
      expect((await db.nodeEgress.findUniqueOrThrow({ where: { id: wgItem!.id } })).configEnc).not.toContain(priv);
      // 留空私钥 / 密码表示不修改
      expect((await request('PUT', `${base}/${socksItem!.id}`, adminCookie, { name: 'US-2', type: 'SOCKS5', proxy: { host: '198.51.100.4', port: 1081, username: 'u', password: '' } })).statusCode).toBe(200);

      // 用户切换出口（只能选本宿主机已启用的出口）
      const options = (await request('GET', `/api/instances/${inst.id}/egress`, userCookie)).json();
      expect(options).toMatchObject({ available: true, current: null });
      expect(options.options.map((o: { id: number }) => o.id)).toEqual([wgItem!.id, socksItem!.id]);
      expect((await request('PUT', `/api/instances/${inst.id}/egress`, userCookie, { egressId: 999999 })).statusCode).toBe(404);
      expect((await request('PUT', `/api/instances/${inst.id}/egress`, userCookie, { egressId: wgItem!.id })).json()).toMatchObject({ current: wgItem!.id });

      // Agent：心跳拿到新版本，拉取完整配置（含私钥，签名回复）；未签名请求被拒绝
      const v1 = (await report()).json().egress.version as number;
      expect(v1).toBeGreaterThan(v0);
      expect((await app.inject({ method: 'GET', url: '/api/agent/nodes/egress' })).statusCode).toBe(401);
      const cfgRes = await signed('GET', '/api/agent/nodes/egress');
      expect(cfgRes.headers['x-paledove-signature']).toBeTruthy();
      const cfg = cfgRes.json();
      expect(cfg).toMatchObject({ version: v1, enabled: true, instances: [{ name: inst.name, ip: inst.privateIp, egressId: wgItem!.id }] });
      expect(cfg.bypass.length).toBe(1);
      expect(cfg.egresses.find((e: { id: number }) => e.id === wgItem!.id).wireguard).toMatchObject({ privateKey: priv, peerPublicKey: pub });
      expect(cfg.egresses.find((e: { id: number }) => e.id === socksItem!.id).proxy).toMatchObject({ port: 1081, password: 'secret-pass' });

      // Agent 回报状态，管理端与用户看到
      const now = Math.floor(Date.now() / 1000);
      expect((await signed('POST', '/api/agent/nodes/egress-status', { version: v1, items: [{ id: wgItem!.id, ok: true, handshakeAt: now, rx: 10, tx: 20 }, { id: socksItem!.id, ok: false, error: 'refused' }] })).statusCode).toBe(200);
      const admin = (await request('GET', base, adminCookie)).json();
      expect(admin).toMatchObject({ appliedVersion: v1 });
      expect(admin.items[0]).toMatchObject({ instanceCount: 1, status: { ok: true, rx: 10, tx: 20 } });
      expect((await request('GET', `/api/instances/${inst.id}/egress`, userCookie)).json().options.map((o: { ok: boolean | null }) => o.ok)).toEqual([true, false]);

      // 删除出口：实例回到默认线路；关闭智能分流后下发空配置
      expect((await request('DELETE', `${base}/${wgItem!.id}`, adminCookie)).statusCode).toBe(200);
      expect((await db.instance.findUniqueOrThrow({ where: { id: inst.id } })).egressId).toBeNull();
      await request('PUT', `${base}/enabled`, adminCookie, { enabled: false });
      expect((await signed('GET', '/api/agent/nodes/egress')).json()).toMatchObject({ enabled: false, egresses: [], instances: [] });
      expect((await request('PUT', `/api/instances/${inst.id}/egress`, userCookie, { egressId: socksItem!.id })).statusCode).toBe(400);
    } finally {
      await db.instance.update({ where: { id: inst.id }, data: { egressId: null } });
      await db.nodeEgress.deleteMany({ where: { nodeId: natNodeId } });
      await db.node.update({ where: { id: natNodeId }, data: { egressEnabled: false } });
      await agentLib.clearHostReport(natNodeId);
    }
  });

  it('shows the host announcement on every instance of that host', async () => {
    const inst = await db.instance.findFirstOrThrow({ where: { nodeId: natNodeId, userId, status: { not: 'DELETED' } } });
    const get = async () => (await request('GET', `/api/instances/${inst.id}`, userCookie)).json();
    expect((await get()).hostAnnouncement).toBeNull();
    try {
      const patched = await request('PATCH', `/api/admin/nodes/${natNodeId}`, adminCookie, { announcement: '  11 月 5 日维护  ' });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json().announcement).toBe('11 月 5 日维护');
      expect((await get()).hostAnnouncement).toBe('11 月 5 日维护');
      expect((await request('PATCH', `/api/admin/nodes/${natNodeId}`, adminCookie, { announcement: 'x'.repeat(2001) })).statusCode).toBe(400);
    } finally {
      await request('PATCH', `/api/admin/nodes/${natNodeId}`, adminCookie, { announcement: '' });
    }
    expect((await get()).hostAnnouncement).toBeNull();
  });

  it('keeps announcements unread per user until each one is clicked or all are marked read', async () => {
    const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
    // 注册之前发布的公告视为已读；之后发布的未读
    const old = await db.announcement.create({ data: { title: 'Old', content: 'before signup', createdAt: new Date(user.createdAt.getTime() - 60_000) } });
    const a = await db.announcement.create({ data: { title: 'A', content: 'first' } });
    const b = await db.announcement.create({ data: { title: 'B', content: 'second' } });
    try {
      const readState = async (cookie: string) =>
        Object.fromEntries(((await request('GET', '/api/announcements', cookie)).json() as { id: number; read: boolean }[]).filter((x) => [old.id, a.id, b.id].includes(x.id)).map((x) => [x.id, x.read]));
      expect(await readState(userCookie)).toEqual({ [old.id]: true, [a.id]: false, [b.id]: false });
      // 点击一条：只有这一条已读，其他用户不受影响
      expect((await request('POST', '/api/announcements/read', userCookie, { ids: [a.id] })).json()).toMatchObject({ marked: 1 });
      expect((await request('POST', '/api/announcements/read', userCookie, { ids: [a.id] })).json()).toMatchObject({ marked: 0 });
      expect(await readState(userCookie)).toEqual({ [old.id]: true, [a.id]: true, [b.id]: false });
      expect((await readState(adminCookie))[b.id]).toBe(false);
      // 全部已读
      expect((await request('POST', '/api/announcements/read', userCookie, {})).statusCode).toBe(200);
      expect(Object.values(await readState(userCookie)).every(Boolean)).toBe(true);
    } finally {
      await db.announcement.deleteMany({ where: { id: { in: [old.id, a.id, b.id] } } });
    }
  });

  it('connects instances on the same host through a VPC', async () => {
    // 两台在同一宿主机上的实例，一台在另一台宿主机上
    const make = async (hostname: string, nodeId = natNodeId) => {
      const res = await request('POST', '/api/admin/instances', adminCookie, spec({ hostname, nodeId, price: '0' }));
      expect(res.statusCode, res.body).toBe(200);
      const task = await db.task.findFirstOrThrow({ where: { instanceId: res.json().instanceId, type: 'CREATE' } });
      await runTask(task.id);
      return res.json().instanceId as number;
    };
    const a = await make('vpc-a');
    const b = await make('vpc-b');
    const otherNode = await db.node.create({ data: { name: 'Other node', region: 'Test', endpoint: 'mock://vpc-other', publicIp: '203.0.113.40', status: 'ONLINE' } });
    const far = await make('vpc-far', otherNode.id);

    const list = (await request('GET', '/api/vpcs', userCookie)).json();
    expect(list.limit).toBe(5);
    expect(list.locations.map((l: { nodeId: number }) => l.nodeId)).toEqual(expect.arrayContaining([natNodeId, otherNode.id]));

    // 网段校验：私有地址、掩码范围、不能与宿主机 NAT 网段重叠、只能建在自己实例所在的宿主机
    const create = (cidr: string, nodeId = natNodeId) => request('POST', '/api/vpcs', userCookie, { name: 'app', cidr, nodeId });
    expect((await create('8.8.8.0/24')).statusCode).toBe(400);
    expect((await create('10.10.0.0/30')).statusCode).toBe(400);
    const nat = (await db.node.findUniqueOrThrow({ where: { id: natNodeId } })).natCidr!;
    expect((await create(nat)).statusCode).toBe(400);
    expect((await create('10.10.0.0/24', 9999)).statusCode).toBe(400);
    const created = await create('10.10.0.9/24');
    expect(created.statusCode, created.body).toBe(200);
    const vpc = created.json();
    expect(vpc).toMatchObject({ cidr: '10.10.0.0/24', members: [] });
    expect((await db.vpc.findUniqueOrThrow({ where: { id: vpc.id } })).network).toBe(`pdvpc-${vpc.id}`);

    // 加入：自动分配与指定地址；另一台宿主机上的实例不能加入
    const base = `/api/vpcs/${vpc.id}`;
    const join = (instanceId: number, ip?: string) => request('POST', `${base}/instances`, userCookie, { instanceId, ip });
    const ja = await join(a);
    expect(ja.statusCode, ja.body).toBe(200);
    expect(ja.json().ip).toBe('10.10.0.1');
    expect((await join(b, '10.10.0.1')).statusCode).toBe(409);
    expect((await join(b, '10.10.1.5')).statusCode).toBe(400);
    expect((await join(b, '10.10.0.20')).json().vpc.members.map((m: { ip: string }) => m.ip)).toEqual(['10.10.0.1', '10.10.0.20']);
    expect((await join(b)).statusCode).toBe(409);
    expect((await join(far)).statusCode).toBe(400);
    expect((await request('GET', `/api/instances/${a}`, userCookie)).json().vpc).toMatchObject({ id: vpc.id, ip: '10.10.0.1' });

    // 有成员时不能删除；移出后可以删除
    expect((await request('DELETE', base, userCookie)).statusCode).toBe(409);
    expect((await request('DELETE', `${base}/instances/${a}`, userCookie)).statusCode).toBe(200);
    expect((await request('DELETE', `${base}/instances/${b}`, userCookie)).statusCode).toBe(200);
    expect((await db.instance.findUniqueOrThrow({ where: { id: a } })).vpcId).toBeNull();
    expect((await request('DELETE', base, userCookie)).statusCode).toBe(200);
    expect(await db.vpc.count({ where: { id: vpc.id } })).toBe(0);

    // 不填网段时自动分配：/24，不与宿主机 NAT 网段及自己已有的 VPC 重叠
    const auto1 = (await request('POST', '/api/vpcs', userCookie, { name: 'auto1', nodeId: natNodeId })).json();
    const auto2 = (await request('POST', '/api/vpcs', userCookie, { name: 'auto2', nodeId: natNodeId })).json();
    expect(auto1.cidr).toMatch(/^10\.\d+\.0\.0\/24$/);
    expect(auto2.cidr).not.toBe(auto1.cidr);
    const natNet = nat.split('.').slice(0, 2).join('.');
    expect([auto1.cidr, auto2.cidr].every((c: string) => !c.startsWith(`${natNet}.`))).toBe(true);
    for (const v of [auto1, auto2]) expect((await request('DELETE', `/api/vpcs/${v.id}`, userCookie)).statusCode).toBe(200);
    // 管理员不能使用用户控制台的 VPC 接口
    expect((await request('GET', '/api/vpcs', adminCookie)).statusCode).toBe(403);

    // 管理员在用户管理里代该用户管理 VPC：不受「未开放」与数量上限限制，用户自己看得到
    const adminBase = `/api/admin/users/${userId}/vpcs`;
    expect((await request('GET', adminBase, userCookie)).statusCode).toBe(403);
    expect((await request('GET', '/api/admin/users/999999/vpcs', adminCookie)).statusCode).toBe(404);
    expect((await request('PUT', '/api/admin/settings', adminCookie, { vpcLimit: 0 })).statusCode).toBe(200);
    try {
      expect((await request('POST', '/api/vpcs', userCookie, { name: 'self', nodeId: natNodeId })).statusCode).toBe(400);
      const byAdmin = await request('POST', adminBase, adminCookie, { name: 'ops', nodeId: natNodeId });
      expect(byAdmin.statusCode, byAdmin.body).toBe(200);
      const adminVpc = byAdmin.json();
      expect((await db.vpc.findUniqueOrThrow({ where: { id: adminVpc.id } })).userId).toBe(userId);
      expect((await request('GET', '/api/vpcs', userCookie)).json().items.map((v: { id: number }) => v.id)).toContain(adminVpc.id);
      // 加入、改名、移出与删除
      const joined = await request('POST', `${adminBase}/${adminVpc.id}/instances`, adminCookie, { instanceId: a });
      expect(joined.statusCode, joined.body).toBe(200);
      expect(joined.json().vpc.members.map((m: { instanceId: number }) => m.instanceId)).toEqual([a]);
      expect((await request('PATCH', `${adminBase}/${adminVpc.id}`, adminCookie, { name: 'ops-2' })).json()).toMatchObject({ name: 'ops-2' });
      // 不能操作其他用户的 VPC / 实例
      const adminUserId = (await db.user.findFirstOrThrow({ where: { role: 'ADMIN' } })).id;
      expect((await request('PATCH', `/api/admin/users/${adminUserId}/vpcs/${adminVpc.id}`, adminCookie, { name: 'x' })).statusCode).toBe(404);
      expect((await request('DELETE', `${adminBase}/${adminVpc.id}/instances/${a}`, adminCookie)).statusCode).toBe(200);
      expect((await request('DELETE', `${adminBase}/${adminVpc.id}`, adminCookie)).statusCode).toBe(200);
      expect(await db.activityLog.count({ where: { action: 'admin.vpc_create' } })).toBeGreaterThan(0);
    } finally {
      await request('PUT', '/api/admin/settings', adminCookie, { vpcLimit: 5 });
    }
  }, 60_000);

  it('applies disk I/O, process and boot settings and serves VM CPU limits to the host agent', async () => {
    const boot = { autostart: 'NEVER', delay: 5, priority: 3, stopPriority: null, shutdownTimeout: 60 };
    const productRes = await request('POST', '/api/admin/products', adminCookie, { name: 'Limits', type: 'LXC_NAT', nodeIds: [natNodeId], boot });
    expect(productRes.statusCode, productRes.body).toBe(200);
    expect(productRes.json().boot).toEqual(boot);
    const product = productRes.json();
    const planRes = await request('POST', '/api/admin/plans', adminCookie, {
      productId: product.id, name: 'IO', cpu: 2, memory: 512, disk: 10, bandwidthIn: 10, bandwidthOut: 10, priceMonthly: '0',
      diskReadIops: 2000, diskWrite: 50, processLimit: 300, cpuPriority: 4,
    });
    expect(planRes.statusCode, planRes.body).toBe(200);
    expect(planRes.json()).toMatchObject({ diskRead: 0, diskReadIops: 2000, diskWrite: 50, diskWriteIops: 0, processLimit: 300, cpuPriority: 4 });
    // 同一方向不能同时按速率与 IOPS 限制
    expect((await request('POST', '/api/admin/plans', adminCookie, { productId: product.id, name: 'Both', cpu: 1, memory: 512, disk: 10, bandwidthIn: 10, bandwidthOut: 10, diskRead: 10, diskReadIops: 10 })).statusCode).toBe(400);
    // 进程数限制过小会导致系统无法启动
    expect((await request('POST', '/api/admin/plans', adminCookie, { productId: product.id, name: 'Bad', cpu: 1, memory: 512, disk: 10, bandwidthIn: 10, bandwidthOut: 10, processLimit: 5 })).statusCode).toBe(400);

    // 前面的用例可能已占满宿主机的实例数
    await db.node.update({ where: { id: natNodeId }, data: { maxInstances: 1000 } });
    const order = await request('POST', '/api/store/orders', userCookie, { planId: planRes.json().id, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'limits-01' });
    expect(order.statusCode, order.body).toBe(200);
    const id = order.json().instanceId;
    expect(await db.instance.findUniqueOrThrow({ where: { id } })).toMatchObject({ diskRead: 0, diskReadIops: 2000, processLimit: 300, cpuPriority: 4, boot });
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
    const inst = await db.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
    expect(inst.status, inst.lastError ?? '').toBe('RUNNING');
    const { getIncus } = await import('../src/incus/index.ts');
    const remote = async () => (await getIncus(inst.node)).getInstance(inst.name);
    const created = await remote();
    expect(created.config).toMatchObject({ 'limits.processes': '300', 'limits.cpu.priority': '4', 'boot.autostart': 'false', 'boot.autostart.delay': '5', 'boot.autostart.priority': '3', 'boot.host_shutdown_timeout': '60' });
    expect(created.config['boot.stop.priority']).toBeUndefined();
    expect(created.devices.root).toMatchObject({ 'limits.read': '2000iops', 'limits.write': '50MB' });
    expect((await request('GET', `/api/instances/${id}`, userCookie)).json()).toMatchObject({ diskRead: 0, diskWrite: 50, diskReadIops: 2000, processLimit: 300 });

    // 修改产品的启动设置：同步到实例并下发到宿主机
    const patched = await request('PATCH', `/api/admin/products/${product.id}`, adminCookie, { boot: { autostart: 'ALWAYS' } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((await db.instance.findUniqueOrThrow({ where: { id } })).boot).toEqual({ autostart: 'ALWAYS', delay: null, priority: null, stopPriority: null, shutdownTimeout: null });
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'APPLY_LIMITS' } })).id);
    const applied = await remote();
    expect(applied.config['boot.autostart']).toBe('true');
    expect(applied.config['boot.autostart.delay']).toBeUndefined();
    expect(applied.config['limits.processes']).toBe('300');

    // 管理员修改实例的 I/O 限制：取消的项从宿主机删除
    const edited = await request('PATCH', `/api/admin/instances/${id}`, adminCookie, { diskRead: 0, diskReadIops: 0, processLimit: null });
    expect(edited.statusCode, edited.body).toBe(200);
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'APPLY_LIMITS', status: 'QUEUED' } })).id);
    const cleared = await remote();
    expect(cleared.devices.root['limits.read']).toBeUndefined();
    expect(cleared.devices.root['limits.write']).toBe('50MB');
    expect(cleared.config['limits.processes']).toBeUndefined();

    // 上报程序拉取虚拟机的 CPU 限制（Incus 不支持限制虚拟机，由上报程序设置 systemd scope）
    const { issueAgentToken } = await import('../src/services/agent/agent.ts');
    const token = await issueAgentToken(natNodeId);
    const limits = () => app.inject({ method: 'GET', url: '/api/agent/nodes/vm-limits', headers: { authorization: `Bearer ${token}` } });
    expect((await limits()).body).toBe('');
    await db.instance.update({ where: { id }, data: { type: 'KVM_NAT', cpuAllowance: 50 } });
    const res = await limits();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(`default ${inst.name} 1000000 40
`);
    expect((await app.inject({ method: 'GET', url: '/api/agent/nodes/vm-limits', headers: { authorization: 'Bearer wrong-token-0000000000' } })).statusCode).toBe(401);
    await db.instance.update({ where: { id }, data: { type: 'LXC_NAT', cpuAllowance: null } });
  }, 60_000);

  it('reports live instance stats through the agent while the instance page is open', async () => {
    const agentLib = await import('../src/services/agent/agent.ts');
    const { createHash, createHmac, randomBytes } = await import('node:crypto');
    const { redis } = await import('../src/lib/redis.ts');
    const secret = await agentLib.issueAgentToken(natNodeId);
    const signed = (url: string, body: object) => {
      const payload = JSON.stringify(body);
      const nonce = randomBytes(18).toString('base64url');
      const ts = String(Date.now());
      const sig = createHmac('sha256', secret).update(['POST', url, ts, nonce, createHash('sha256').update(payload).digest('hex')].join('\n')).digest('hex');
      return app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json', 'x-paledove-node': String(natNodeId), 'x-paledove-timestamp': ts, 'x-paledove-nonce': nonce, 'x-paledove-signature': sig } });
    };
    const report = (capabilities: string[]) => signed('/api/agent/nodes/report', { version: 3, release: '0.0.1', cpu: 1, load: [0, 0, 0], uptime: 10, arch: 'amd64', capabilities });
    expect((await request('PATCH', `/api/admin/plans/${planId}`, adminCookie, { priceMonthly: '0' })).statusCode).toBe(200);
    let id = 0;
    try {
      const bought = await request('POST', '/api/store/orders', userCookie, { planId, region: 'Test', imageId, cycle: 'MONTHLY', hostname: 'agent-stats-01', nodeId: natNodeId });
      expect(bought.statusCode, bought.body).toBe(200);
      id = bought.json().instanceId as number;
      await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
      const inst = await db.instance.findUniqueOrThrow({ where: { id } });
      const live = async () => {
        await redis.del(`state:cache:${id}`);
        return (await request('GET', `/api/instances/${id}/state`, userCookie)).json();
      };

      // 旧版 Agent（不支持实例资源上报）：面板直接查询，不下发查看列表
      expect((await report([])).json().instances).toBeUndefined();
      expect(await live()).toMatchObject({ source: 'panel' });

      // 新版 Agent 在线：查询实时状态时标记为正在查看，心跳回复下发查看列表
      await report(['instance-stats']);
      expect(await live()).toMatchObject({ source: 'panel' });
      expect((await report(['instance-stats'])).json().instances).toEqual({ names: [inst.name], interval: 3 });

      // Agent 上报两次（相隔 3 秒）：使用上报的数据，CPU 与网络速率由两次上报计算；其他宿主机的实例忽略
      const sample = (cpuNs: number, rx: number) => ({
        name: inst.name,
        state: {
          status: 'Running',
          status_code: 103,
          cpu: { usage: cpuNs },
          memory: { usage: 300 * 1024 ** 2, usage_peak: 0, swap_usage: 0, swap_usage_peak: 0 },
          disk: { root: { usage: 2 * 1024 ** 3 } },
          network: { eth0: { addresses: [], counters: { bytes_received: rx, bytes_sent: rx / 2, packets_received: 0, packets_sent: 0 }, hwaddr: '', host_name: '', mtu: 1500, state: 'up', type: 'broadcast' } },
          pid: 1,
          processes: 12,
        },
      });
      const first = await signed('/api/agent/nodes/instance-states', { states: [sample(1e9, 10_000), { name: 'pd-999-elsewhere', state: { status: 'Running' } }] });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().watch).toEqual({ names: [inst.name], interval: 3 });
      // 把第一次上报的时间往前调 3 秒，模拟上报间隔
      const cur = JSON.parse((await redis.get(`agent:istate:${id}`))!);
      await redis.set(`agent:istate:${id}`, JSON.stringify({ ...cur, t: cur.t - 3000 }), 'EX', 60);
      expect((await signed('/api/agent/nodes/instance-states', { states: [sample(1e9 + 1.5e9 * inst.cpu, 13_000)] })).statusCode).toBe(200);
      const viaAgent = await live();
      expect(viaAgent).toMatchObject({ source: 'agent', status: 'Running', memoryUsage: 300 * 1024 ** 2, diskUsage: 2 * 1024 ** 3, processes: 12 });
      expect(viaAgent.cpuPercent).toBeCloseTo(50, 0);
      expect(viaAgent.netRxRate).toBeGreaterThan(900);
      expect(viaAgent.netRxRate).toBeLessThanOrEqual(1000);

      // 未签名的上报被拒绝
      expect((await app.inject({ method: 'POST', url: '/api/agent/nodes/instance-states', payload: { states: [] } })).statusCode).toBe(401);

      // 上报过期（超过 12 秒）后回到面板直接查询；页面关闭后查看列表过期，回复不再下发
      const latest = JSON.parse((await redis.get(`agent:istate:${id}`))!);
      await redis.set(`agent:istate:${id}`, JSON.stringify({ ...latest, t: latest.t - 20_000 }), 'EX', 60);
      expect(await live()).toMatchObject({ source: 'panel' });
      await redis.hset(`agent:watch:${natNodeId}`, inst.name, String(Date.now() - 1));
      expect((await report(['instance-stats'])).json().instances).toBeUndefined();
    } finally {
      await agentLib.clearHostReport(natNodeId);
      await redis.del(`agent:watch:${natNodeId}`);
      if (id) await db.instance.update({ where: { id }, data: { status: 'DELETED' } });
      await request('PATCH', `/api/admin/plans/${planId}`, adminCookie, { priceMonthly: '5' });
    }
  }, 60_000);

  it('runs node tests through the agent hourly and shows them on the store page', async () => {
    const agentLib = await import('../src/services/agent/agent.ts');
    const { createHash, createHmac, randomBytes } = await import('node:crypto');
    const { PING_TARGETS, PING_INTERVAL_SEC, pingTargetsHash } = await import('../src/shared/index.ts');
    const secret = await agentLib.issueAgentToken(natNodeId);
    const signed = (method: 'GET' | 'POST', url: string, body?: object) => {
      const payload = body ? JSON.stringify(body) : '';
      const nonce = randomBytes(18).toString('base64url');
      const ts = String(Date.now());
      const sig = createHmac('sha256', secret).update([method, url, ts, nonce, createHash('sha256').update(payload).digest('hex')].join('\n')).digest('hex');
      return app.inject({ method, url, payload: body ? payload : undefined, headers: { 'content-type': 'application/json', 'x-paledove-node': String(natNodeId), 'x-paledove-timestamp': ts, 'x-paledove-nonce': nonce, 'x-paledove-signature': sig } });
    };
    const report = () => signed('POST', '/api/agent/nodes/report', { version: 3, release: '0.0.1', cpu: 1, load: [0, 0, 0], uptime: 10, arch: 'amd64' });
    const product = await db.product.findFirstOrThrow({ where: { nodes: { some: { id: natNodeId } } } });
    const publicPingRes = async () => (await app.inject({ method: 'GET', url: `/api/public/products/${product.id}/ping?region=Test` })).json();
    const publicPing = async () => (await publicPingRes()).nodes;

    // 未启用：上报回复没有测试配置，立即测试被拒绝；购买页显示未开启
    expect(await publicPingRes()).toEqual({ enabled: false, nodes: [] });
    expect((await report()).json().ping).toBeUndefined();
    expect((await request('POST', `/api/admin/nodes/${natNodeId}/ping-run`, adminCookie)).statusCode).toBe(400);

    // 在宿主机设置中启用；管理员要求立即测试
    expect((await request('PATCH', `/api/admin/nodes/${natNodeId}`, adminCookie, { pingEnabled: true })).json()).toMatchObject({ pingEnabled: true });
    expect((await request('POST', `/api/admin/nodes/${natNodeId}/ping-run`, adminCookie)).statusCode).toBe(200);
    expect((await report()).json().ping).toEqual({ enabled: true, interval: PING_INTERVAL_SEC, hash: pingTargetsHash(), runNow: true });
    // 立即测试只下发一次
    expect((await report()).json().ping.runNow).toBe(false);
    // 已开启、还没有结果
    expect(await publicPingRes()).toEqual({ enabled: true, nodes: [] });
    expect(PING_INTERVAL_SEC).toBe(3600);

    // Agent 拉取 93 个内置目标，回传结果（未知目标忽略）
    const targets = (await signed('GET', '/api/agent/nodes/ping-targets')).json();
    expect(targets.targets).toHaveLength(93);
    expect(targets.targets[0]).toEqual({ id: 'bj-ct', host: 'bj-ct-v4.ip.zstaticcdn.com', port: 80 });
    expect(PING_TARGETS.filter((t) => t.isp === 'CM')).toHaveLength(31);
    const results = [
      { id: 'gd-ct', latency: 13.26, loss: 0 },
      { id: 'xj-cm', latency: null, loss: 100 },
      { id: 'nope', latency: 1, loss: 0 },
    ];
    expect((await signed('POST', '/api/agent/nodes/ping-results', { method: 'icmp', results })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/agent/nodes/ping-results', payload: { method: 'icmp', results } })).statusCode).toBe(401);

    // 管理员与购买页看到结果；购买页不显示宿主机名称
    const admin = (await request('GET', `/api/admin/nodes/${natNodeId}/ping`, adminCookie)).json();
    expect(admin.result.results).toEqual([{ id: 'gd-ct', latency: 13.3, loss: 0 }, { id: 'xj-cm', latency: null, loss: 100 }]);
    const nodes = await publicPing();
    expect(nodes).toEqual([{ label: 'Test', country: expect.any(String), testedAt: expect.any(String), method: 'icmp', results: admin.result.results }]);
    expect(JSON.stringify(nodes)).not.toContain('NAT node');
    expect((await app.inject({ method: 'GET', url: `/api/public/products/${product.id}/ping?region=Other` })).json().nodes).toEqual([]);

    // 关闭后不再下发配置，购买页也不再显示
    await request('PATCH', `/api/admin/nodes/${natNodeId}`, adminCookie, { pingEnabled: false });
    expect((await report()).json().ping).toBeUndefined();
    expect(await publicPing()).toEqual([]);
  }, 30_000);

  it('refreshes Incus and Caddy install tokens without changing running host credentials', async () => {
    const nodes = await import('../src/services/nodes.ts');
    const caddy = await import('../src/services/gateway.ts');
    const before = await db.node.findUniqueOrThrow({ where: { id: natNodeId } });
    for (const [issue, lookup] of [
      [nodes.issueInstallToken, nodes.nodeByInstallToken],
      [caddy.issueCaddyToken, caddy.nodeByCaddyToken],
    ] as const) {
      const first = await issue(natNodeId);
      expect(await issue(natNodeId)).toEqual(first);
      const next = await issue(natNodeId, true);
      expect(next.token).not.toBe(first.token);
      expect(next.expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
      await expect(lookup(first.token)).rejects.toThrow();
      expect((await lookup(next.token)).id).toBe(natNodeId);
    }
    const after = await db.node.findUniqueOrThrow({ where: { id: natNodeId } });
    expect(after.agentTokenHash).toBe(before.agentTokenHash);
    expect(after.serverFingerprint).toBe(before.serverFingerprint);
    expect(after.caddyCaCert).toBe(before.caddyCaCert);
    expect(after.status).toBe(before.status);
  });

  it('invalidates previous Agent install commands and serializes concurrent refreshes and exchanges', async () => {
    const agent = await import('../src/services/agent/agent.ts');
    const { redis } = await import('../src/lib/redis.ts');
    const { sha256 } = await import('../src/lib/crypto.ts');
    const secret = await agent.issueAgentToken(natNodeId);
    const command = async () => {
      const response = await request('POST', `/api/admin/nodes/${natNodeId}/agent-command`, adminCookie);
      expect(response.statusCode, response.body).toBe(200);
      return /PALEDOVE_INSTALL_TOKEN='(pdi_[^']+)'/.exec(response.json().command)![1]!;
    };
    const exchange = (token: string) => app.inject({ method: 'GET', url: '/api/agent/install-config', headers: { 'x-paledove-install-token': token } });
    const previous = await command();
    const next = await command();
    expect((await exchange(previous)).statusCode).toBe(401);
    // 刷新命令时仍可使用当前 Agent 密钥；兑换安装令牌后才轮换。
    expect((await agent.nodeByAgentToken(secret)).id).toBe(natNodeId);
    const redeemed = await Promise.all([exchange(next), exchange(next)]);
    expect(redeemed.map((r) => r.statusCode).sort()).toEqual([200, 401]);
    await expect(agent.nodeByAgentToken(secret)).rejects.toThrow();

    const other = await agent.issueAgentInstallToken(ipv4NodeId);
    const concurrent = await Promise.all([command(), command(), command()]);
    const results = await Promise.all(concurrent.map(exchange));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 401)).toHaveLength(2);
    expect((await exchange(other.token)).statusCode).toBe(200);

    const expired = await command();
    await redis.expire(`agent:install:${sha256(expired)}`, 0);
    expect((await exchange(expired)).statusCode).toBe(401);
    expect((await exchange(await command())).statusCode).toBe(200);
  });

  it('installs the Go agent with a one-time token and accepts signed reports with upgrade instructions', async () => {
    const agentLib = await import('../src/services/agent/agent.ts');
    const { createHash, createHmac, randomBytes } = await import('node:crypto');
    const { HOST_AGENT_RELEASE } = await import('../src/shared/index.ts');
    // 与 Go 版 Agent 的测试使用同一组向量，保证两端签名算法一致
    expect(agentLib.bodyHash('{"cpu":1}')).toBe('d6c34d94bce46312e061d19dbab47c7acfe6d2d6ece35fb884e7717a29fa0f83');
    expect(agentLib.hmacHex('s3cret', agentLib.signingPayload('post', '/api/agent/nodes/report', '1700000000000', 'nonce_abcdefghijklmnop', agentLib.bodyHash('{"cpu":1}')))).toBe(
      '0fbd72b08c7997c19347577d8838b13071407e2b25016689e8c78b28d9c7309b',
    );
    expect(agentLib.signResponse('s3cret', 'nonce_abcdefghijklmnop', '{"ok":true}')).toBe('db4f24a15cb510faa0675343d44a955bfb573fb0cf69153a7cb29769d0585a3c');

    // 管理员生成安装命令：通用脚本 + 一次性令牌（30 分钟内有效）
    const cmd = (await request('POST', `/api/admin/nodes/${natNodeId}/agent-command`, adminCookie)).json();
    const installToken = /PALEDOVE_INSTALL_TOKEN='(pdi_[^']+)'/.exec(cmd.command)?.[1];
    expect(installToken, cmd.command).toBeTruthy();
    expect(cmd.command).toContain('/api/agent/install.sh');
    expect(Date.parse(cmd.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    const generic = await app.inject({ method: 'GET', url: '/api/agent/install.sh' });
    expect(generic.statusCode).toBe(200);
    expect(generic.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
    expect(generic.headers.pragma).toBe('no-cache');
    expect(generic.headers.expires).toBe('0');
    expect(generic.body).not.toContain(installToken!);

    // 用令牌换取 Agent 配置；令牌只能使用一次
    const exchange = () => app.inject({ method: 'GET', url: '/api/agent/install-config', headers: { 'x-paledove-install-token': installToken! } });
    const conf = await exchange();
    expect(conf.statusCode, conf.body).toBe(200);
    const env = Object.fromEntries(conf.body.trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    expect(env.NODE_ID).toBe(String(natNodeId));
    expect(env.AGENT_SECRET).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect((await exchange()).statusCode).toBe(401);

    const full = {
      version: 3, release: '0.0.1', cpu: 12.345, cores: 4, load: [0.5, 0.4, 0.3], uptime: 6400000, processes: 215,
      memory: { total: 2e9, used: 7.5e8 }, swap: { total: 3e9, used: 2.2e8 }, disk: { path: '/', total: 2e10, used: 1.3e10 },
      hostname: 'hk-01', os: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0', arch: 'amd64',
      incus: { available: true, socket: '/var/lib/incus/unix.socket', version: '6.0.4' }, capabilities: ['heartbeat', 'host-metrics'],
    };
    // 签名请求（与 Go 版 Agent 相同的算法）
    const signed = (body: object | null, opts: { secret?: string; nonce?: string; ts?: number; url?: string; method?: 'GET' | 'POST' } = {}) => {
      const payload = body ? JSON.stringify(body) : '';
      const nonce = opts.nonce ?? randomBytes(18).toString('base64url');
      const ts = String(opts.ts ?? Date.now());
      const method = opts.method ?? 'POST';
      const url = opts.url ?? '/api/agent/nodes/report';
      const sig = createHmac('sha256', opts.secret ?? env.AGENT_SECRET!)
        .update([method, url, ts, nonce, createHash('sha256').update(payload).digest('hex')].join('\n'))
        .digest('hex');
      return app.inject({
        method,
        url,
        payload: body ? payload : undefined,
        remoteAddress: '198.51.100.7',
        headers: { 'content-type': 'application/json', 'x-paledove-node': String(natNodeId), 'x-paledove-timestamp': ts, 'x-paledove-nonce': nonce, 'x-paledove-signature': sig },
      });
    };
    const nonce = randomBytes(18).toString('base64url');
    const res = await signed(full, { nonce });
    expect(res.statusCode, res.body).toBe(200);
    // 回复签名有效
    expect(res.headers['x-paledove-signature']).toBe(agentLib.signResponse(env.AGENT_SECRET!, nonce, res.body));
    const { agentManifest } = await import('../src/services/agent/agent-binary.ts');
    const manifest = agentManifest();
    expect(res.json()).toMatchObject({ ok: true, interval: 10, latest: manifest.version });
    // 有对应架构的二进制且版本不同：下发同源的升级指令
    if (manifest.files.amd64) {
      expect(res.json().upgrade).toEqual({ version: manifest.version, url: expect.stringMatching(/\/api\/agent\/binary\/amd64\?v=/), sha256: manifest.files.amd64.sha256, size: manifest.files.amd64.size });
      expect((await signed({ ...full, release: manifest.version })).json().upgrade).toBeUndefined();
    }
    expect(manifest.version).toBe(HOST_AGENT_RELEASE);

    // 管理员看到完整的宿主机状态、心跳 IP 与在线状态
    const host = (await request('GET', `/api/admin/nodes/${natNodeId}/resources`, adminCookie)).json().host;
    expect(host).toMatchObject({ online: true, version: 3, cpu: 12.35, cores: 4, processes: 215, ip: '198.51.100.7', incus: { available: true }, memory: { total: 2e9 } });

    // 重放、时间偏差、错误密钥、篡改请求体都被拒绝
    expect((await signed(full, { nonce })).statusCode).toBe(401);
    expect((await signed(full, { ts: Date.now() - 10 * 60_000 })).statusCode).toBe(401);
    expect((await signed(full, { secret: 'wrong-secret' })).statusCode).toBe(401);
    // 按原请求体签名、发送另一个请求体
    const ts = String(Date.now());
    const tn = randomBytes(18).toString('base64url');
    const sig = createHmac('sha256', env.AGENT_SECRET!)
      .update(['POST', '/api/agent/nodes/report', ts, tn, createHash('sha256').update(JSON.stringify(full)).digest('hex')].join('\n'))
      .digest('hex');
    const tampered = await app.inject({
      method: 'POST',
      url: '/api/agent/nodes/report',
      payload: JSON.stringify({ ...full, cpu: 99 }),
      headers: { 'content-type': 'application/json', 'x-paledove-node': String(natNodeId), 'x-paledove-timestamp': ts, 'x-paledove-nonce': tn, 'x-paledove-signature': sig },
    });
    expect(tampered.statusCode).toBe(401);
    // 拉取虚拟机限制同样签名，回复也签名
    const vmNonce = randomBytes(18).toString('base64url');
    const vm = await signed(null, { method: 'GET', url: '/api/agent/nodes/vm-limits', nonce: vmNonce });
    expect(vm.statusCode, vm.body).toBe(200);
    expect(vm.headers['x-paledove-signature']).toBe(agentLib.signResponse(env.AGENT_SECRET!, vmNonce, vm.body));
    expect((await signed({ ...full, cpu: 101 })).statusCode).toBe(400);

    // 旧版 bash 上报程序（Bearer 令牌）：安装新 Agent 时密钥已更换，旧令牌失效；有效令牌仍可上报但没有升级指令
    const legacy = await agentLib.issueAgentToken(natNodeId);
    const bearer = await app.inject({ method: 'POST', url: '/api/agent/nodes/report', payload: { cpu: 1, load: [0, 0, 0], uptime: 10, version: 2 }, headers: { authorization: `Bearer ${legacy}` } });
    expect(bearer.statusCode).toBe(200);
    expect(bearer.json().upgrade).toBeUndefined();
    expect(bearer.headers['x-paledove-signature']).toBeUndefined();
    expect((await signed(full)).statusCode).toBe(401);

    // 版本清单与公开下载
    expect((await app.inject({ method: 'GET', url: '/api/agent/manifest.json' })).json().version).toBe(manifest.version);
    expect((await app.inject({ method: 'GET', url: '/api/agent/binary/mips' })).statusCode).toBe(400);
    const bin = await app.inject({ method: 'GET', url: '/api/agent/binary/amd64' });
    expect(bin.statusCode).toBe(manifest.files.amd64 ? 200 : 404);
    // 旧版安装命令（地址里带长期令牌）仍可用：脚本里嵌入新签发的一次性令牌
    const old = await app.inject({ method: 'GET', url: `/api/agent/reporter/${legacy}/install.sh` });
    expect(old.statusCode).toBe(200);
    expect(old.body).toMatch(/PALEDOVE_INSTALL_TOKEN='pdi_/);
  }, 30_000);
});

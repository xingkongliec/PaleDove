import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { marketPingVerdict, MARKET_PING_CONTROLS, PING_TARGETS, type PingResultDTO } from '../src/shared/index.ts';

/** 全部目标的结果：failProvinces 中的省份三网都超时 */
const results = (failProvinces: string[] = [], latency = 150): PingResultDTO[] =>
  PING_TARGETS.map((t, index) => ({ id: t.id, latency: failProvinces.includes(t.province) ? null : latency + (t.isp === 'CM' ? -10 : 0), loss: failProvinces.includes(t.province) ? 100 : 0, targetIp: `198.51.100.${index + 1}` }));

describe('market ping verdict', () => {
  const allTimeouts = () => results(PING_TARGETS.map(t => t.province));
  const controls = () => MARKET_PING_CONTROLS.map(t => ({ id: t.id, latency: 30, loss: 0, targetIp: t.host }));
  const verification = () => ({ results: allTimeouts(), controls: controls(), confirmationControls: controls() });
  it('never labels partial failures or historical unverified timeouts as blocked', () => {
    expect(marketPingVerdict(results())).toMatchObject({ verdict: 'NORMAL', reachable: 93, total: 93, failedProvinces: [] });
    expect(marketPingVerdict(results(['北京', '上海'])).verdict).toBe('PARTIAL');
    expect(marketPingVerdict(results(['北京', '上海', '广东', '江苏', '浙江'])).verdict).toBe('PARTIAL');
    expect(marketPingVerdict(results(['北京', '上海', '广东', '江苏', '浙江', '四川'])).verdict).toBe('PARTIAL');
    const oneIsp = PING_TARGETS.map((t) => ({ id: t.id, latency: t.isp === 'CM' ? null : 100, loss: t.isp === 'CM' ? 100 : 0 }));
    expect(marketPingVerdict(oneIsp)).toMatchObject({ verdict: 'PARTIAL', reachable: 62, failedProvinces: [] });
    expect(marketPingVerdict(allTimeouts()).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict([]).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict([{ id: 'unknown', latency: null, loss: 100 }]).verdict).toBe('UNKNOWN');
  });
  it('requires complete, repeated mainland failures and two stable international controls', () => {
    expect(marketPingVerdict(allTimeouts(), PING_TARGETS, verification()).verdict).toBe('ABNORMAL');
    expect(marketPingVerdict(allTimeouts(), PING_TARGETS, { ...verification(), results: results() }).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts().slice(0, -1), PING_TARGETS, verification()).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts(), PING_TARGETS, { ...verification(), results: allTimeouts().slice(0, -1) }).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts(), PING_TARGETS, { ...verification(), controls: controls().map(r => ({ ...r, latency: null, loss: 100 })) }).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts(), PING_TARGETS, { ...verification(), confirmationControls: controls().slice(0, 1) }).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts(), PING_TARGETS, { ...verification(), controls: controls().slice(0, 2), confirmationControls: controls().slice(1) }).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(results(['北京']), PING_TARGETS, verification()).verdict).toBe('PARTIAL');
  });
  it('requires sufficient distinct mainland coverage and ignores regional targets for blocking', () => {
    for (const targets of [PING_TARGETS.slice(0, 3), PING_TARGETS.filter(t => t.isp === 'CT'), PING_TARGETS.map(t => ({ ...t, province: '香港', isp: null }))]) {
      expect(marketPingVerdict(allTimeouts(), targets, verification()).verdict).toBe('UNKNOWN');
    }
    const targets = [...PING_TARGETS, { ...PING_TARGETS[0], id: 'hk', province: '香港', isp: null }];
    const rows = [...allTimeouts(), { id: 'hk', latency: 20, loss: 0 }];
    expect(marketPingVerdict(rows, targets, { ...verification(), results: rows }).verdict).toBe('ABNORMAL');
    const malformed = allTimeouts().map((r, i) => i ? r : { ...r, error: 'DNS error' });
    expect(marketPingVerdict(malformed, PING_TARGETS, verification()).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts().map(r => ({ ...r, targetIp: '198.51.100.1' })), PING_TARGETS, verification()).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict(allTimeouts().map(({ targetIp: _, ...r }) => r), PING_TARGETS, verification()).verdict).toBe('UNKNOWN');
    expect(marketPingVerdict([...allTimeouts(), allTimeouts()[0]], PING_TARGETS, verification()).verdict).toBe('UNKNOWN');
  });
});

describe('market listing ping', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let runTask: typeof import('../src/services/operations.ts').runTask;
  let ping: typeof import('../src/services/market-ping.ts');
  let saveHostReport: typeof import('../src/services/agent/agent.ts').saveHostReport;
  let directory: string;
  let adminCookie: string;
  let sellerCookie: string;
  let otherCookie: string;
  let sellerId: number;
  let natNodeId: number;
  let ipNodeId: number;
  let imageId: number;
  let requestNumber = 0;
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.5.0.${(++requestNumber % 250) + 1}`, headers: { 'x-requested-with': 'XMLHttpRequest', cookie } });

  /** 在模拟节点上开通实例（节点已改成真实地址时临时改回模拟地址，开通后恢复） */
  const makeInstance = async (hostname: string, nodeId: number, type: 'LXC_NAT' | 'KVM_IPV4') => {
    const { endpoint } = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
    await db.node.update({ where: { id: nodeId }, data: { endpoint: `mock://mping-${nodeId}` } });
    const res = await request('POST', '/api/admin/instances', adminCookie, {
      userId: sellerId, nodeId, type, imageId, hostname,
      cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 500, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 1,
      portLimit: 5, siteLimit: 1, snapshotLimit: 1, billingCycle: 'MONTHLY', price: '5.00',
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), autoRenew: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    const id = res.json().instanceId as number;
    await runTask((await db.task.findFirstOrThrow({ where: { instanceId: id, type: 'CREATE' } })).id);
    await db.node.update({ where: { id: nodeId }, data: { endpoint } });
    return id;
  };
  const agentOnline = (nodeId: number, capabilities = ['heartbeat', 'listing-ping', 'listing-ping-v2']) =>
    saveHostReport(nodeId, { cpu: 1, load: [0, 0, 0], uptime: 100, version: 3, capabilities });
  const useRealEndpoint = (nodeId: number) => db.node.update({ where: { id: nodeId }, data: { endpoint: `https://192.0.2.${nodeId}:8443` } });
  const waitFor = async (check: () => Promise<boolean>, ms = 8_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  const jobOf = async (nodeId: number, listingId: number) => {
    expect(await waitFor(async () => (await ping.agentListingJobs(nodeId)).some(job => job.id === listingId))).toBe(true);
    return (await ping.agentListingJobs(nodeId)).find(job => job.id === listingId)!;
  };
  const finish = async (nodeId: number, input: Parameters<typeof ping.saveAgentListingPing>[1]) => {
    const job = await jobOf(nodeId, input.id);
    return ping.saveAgentListingPing(nodeId, { requestId: job.requestId, ip: job.ip, ...input });
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-mping-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-mping-secret-12345678901234', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    runTask = (await import('../src/services/operations.ts')).runTask;
    ping = await import('../src/services/market-ping.ts');
    saveHostReport = (await import('../src/services/agent/agent.ts')).saveHostReport;
    const password = 'test-mping-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'mp-admin', email: 'mp-admin@example.com', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
    sellerId = (await db.user.create({ data: { username: 'mp-seller', email: 'mp-seller@example.com', passwordHash: hash, emailVerifiedAt: new Date() } })).id;
    await db.user.create({ data: { username: 'mp-other', email: 'mp-other@example.com', passwordHash: hash, emailVerifiedAt: new Date() } });
    natNodeId = (await db.node.create({ data: { name: 'NAT node', region: 'Tokyo', country: 'JP', endpoint: 'mock://mping-1', publicIp: '203.0.113.60', status: 'ONLINE', maxInstances: 100 } })).id;
    ipNodeId = (
      await db.node.create({
        data: {
          name: 'IP node', region: 'Los Angeles', country: 'US', endpoint: 'mock://mping-2', publicIp: '203.0.113.70', status: 'ONLINE', maxInstances: 100,
          networkMode: 'IPV4', publicNicMode: 'BRIDGED', publicNicParent: 'br0',
          ipAddresses: { create: [{ address: '198.51.100.20', prefix: 24, gateway: '198.51.100.1' }, { address: '198.51.100.21', prefix: 24, gateway: '198.51.100.1' }] },
        },
      })
    ).id;
    imageId = (await db.image.create({ data: { name: 'Debian 12', family: 'debian', alias: 'debian/12', server: 'https://images.example.com', protocol: 'simplestreams' } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(res.statusCode, res.body).toBe(200);
      return res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    };
    adminCookie = await login('mp-admin');
    sellerCookie = await login('mp-seller');
    otherCookie = await login('mp-other');
    expect((await request('PUT', '/api/admin/settings', adminCookie, { marketEnabled: true, marketFeeRate: 5, marketMinDays: 3 })).statusCode).toBe(200);
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-mping-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('simulates the test on mock nodes', async () => {
    const id = await makeInstance('mp-mock', natNodeId, 'LXC_NAT');
    const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
    expect(res.statusCode, res.body).toBe(200);
    // 测试环境里模拟节点立即完成拨测并公开
    expect(res.json()).toMatchObject({ published: true, ping: { status: 'DONE' } });
    const listingId = res.json().id as number;
    const detail = (await request('GET', `/api/public/market/${listingId}/ping`, '')).json();
    expect(detail).toMatchObject({ status: 'DONE', verdict: 'NORMAL', via: 'mock', ipv4: 'NAT', reachable: 93, total: 93 });
    expect(detail.results).toHaveLength(93);
    // 卡片只带摘要：三网最快，不带全部结果
    const card = (await request('GET', '/api/public/market', '')).json().items.find((l: { id: number }) => l.id === listingId);
    expect(card.ping.fastest).toHaveLength(3);
    expect(card.ping.results).toBeUndefined();
    await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
  }, 60_000);

  it('archives custom target metadata independently of later settings changes', async () => {
    const { getSetting, setSetting } = await import('../src/lib/settings.ts');
    const original = await getSetting('ping');
    const custom = { ...PING_TARGETS[0]!, id: 'custom-market', name: 'Custom market target', host: 'probe.example.test', port: 443, enabled: true };
    const id = await makeInstance('mp-custom', natNodeId, 'LXC_NAT');
    try {
      await setSetting('ping', { enabled: false, targets: [custom] });
      const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
      expect(res.statusCode, res.body).toBe(200);
      const listingId = res.json().id as number;
      await setSetting('ping', original);
      const detail = (await request('GET', `/api/public/market/${listingId}/ping`, '')).json();
      expect(detail).toMatchObject({ status: 'DONE', verdict: 'NORMAL', reachable: 1, total: 1, fastest: [{ province: '北京', isp: 'CT' }], targets: [{ id: custom.id, name: custom.name, host: custom.host }] });
      expect(detail.results).toHaveLength(1);
      await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
    } finally {
      await setSetting('ping', original);
    }
  }, 60_000);

  it('retains regional targets without reporting them as one of the three mainland carriers', async () => {
    const { getSetting, setSetting } = await import('../src/lib/settings.ts');
    const original = await getSetting('ping');
    const custom = { ...PING_TARGETS[0]!, id: 'custom-hk', province: '香港', provinceEn: 'Hong Kong', host: 'hk-probe.example.test', isp: null, enabled: true };
    const id = await makeInstance('mp-regional', natNodeId, 'LXC_NAT');
    try {
      await setSetting('ping', { targets: [custom] });
      const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
      expect(res.statusCode, res.body).toBe(200);
      const listingId = res.json().id as number;
      const detail = (await request('GET', `/api/public/market/${listingId}/ping`, '')).json();
      expect(detail).toMatchObject({ status: 'DONE', verdict: 'NORMAL', reachable: 1, total: 1, fastest: [], targets: [{ id: custom.id, province: '香港', isp: null }] });
      expect(detail.results).toHaveLength(1);
      expect(ping.pingSummary({ status: 'DONE', requestedAt: detail.requestedAt, results: [{ id: custom.id, latency: 5, loss: 0 }], targets: [{ ...custom, isp: 'CT' }] })?.fastest).toEqual([]);
      await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
    } finally {
      await setSetting('ping', original);
    }
  }, 60_000);

  it('asks the agent to test a NAT instance from the host public IP and archives the result', async () => {
    const id = await makeInstance('mp-nat', natNodeId, 'LXC_NAT');
    await useRealEndpoint(natNodeId);
    await agentOnline(natNodeId);
    const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 12 });
    expect(res.statusCode, res.body).toBe(200);
    const listingId = res.json().id as number;
    expect(res.json()).toMatchObject({ published: false, ping: { status: 'PENDING' } });
    // 拨测完成前不公开：市场里看不到、其他用户打不开快照、不能购买
    expect((await request('GET', '/api/public/market', '')).json().items.some((l: { id: number }) => l.id === listingId)).toBe(false);
    expect((await request('GET', `/api/public/market/${listingId}/ping`, otherCookie)).statusCode).toBe(404);
    expect((await request('POST', `/api/market/listings/${listingId}/buy`, otherCookie)).statusCode).toBe(409);
    expect((await request('GET', '/api/market/mine', sellerCookie)).json().find((l: { id: number }) => l.id === listingId)).toMatchObject({ published: false });
    // NAT 实例：拨测与实例开关机无关，立即关机
    expect(await db.task.count({ where: { instanceId: id, type: 'STOP' } })).toBe(1);
    // Agent 在上报回复里拿到任务：宿主机公网 IPv4
    expect(await waitFor(async () => (await ping.agentListingJobs(natNodeId)).length > 0)).toBe(true);
    expect(await jobOf(natNodeId, listingId)).toMatchObject({ id: listingId, ip: '203.0.113.60', kind: 'nat', targets: [{ id: 'bj-ct', mainland: true }, ...PING_TARGETS.slice(1).map(t => ({ id: t.id }))], controls: [...MARKET_PING_CONTROLS] });
    // 其他宿主机不能回传这个任务
    expect(await ping.saveAgentListingPing(ipNodeId, { id: listingId, method: 'icmp', via: 'local', results: results() })).toBe(false);
    expect(await finish(natNodeId, { id: listingId, method: 'icmp', via: 'local', results: [...results(['西藏']), { id: 'zz-ct', latency: 1, loss: 0 }] })).toBe(true);
    expect(await ping.agentListingJobs(natNodeId)).toEqual([]);
    const detail = (await request('GET', `/api/public/market/${listingId}/ping`, '')).json();
    expect(detail).toMatchObject({ status: 'DONE', verdict: 'PARTIAL', failedProvinces: 1, reachable: 90, total: 93, method: 'icmp', via: 'local' });
    // 拨测完成：公开上架
    expect((await request('GET', '/api/public/market', '')).json().items.find((l: { id: number }) => l.id === listingId)).toMatchObject({ published: true });
    expect(detail.fastest.map((f: { isp: string }) => f.isp)).toEqual(['CT', 'CM', 'CU']);
    // 撤销后：只有卖家（与管理员）还能看到存档
    await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
    expect((await request('GET', `/api/public/market/${listingId}/ping`, otherCookie)).statusCode).toBe(404);
    expect((await request('GET', `/api/public/market/${listingId}/ping`, sellerCookie)).statusCode).toBe(200);
    expect((await request('GET', `/api/public/market/${listingId}/ping`, adminCookie)).statusCode).toBe(200);
  }, 60_000);

  it('tests a dedicated IPv4 from the instance address and MAC, then shuts the instance down', async () => {
    const id = await makeInstance('mp-ip', ipNodeId, 'KVM_IPV4');
    await useRealEndpoint(ipNodeId);
    await agentOnline(ipNodeId);
    const inst = await db.instance.findUniqueOrThrow({ where: { id }, include: { ipAddress: true } });
    expect(inst.status).toBe('RUNNING');
    const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 15 });
    expect(res.statusCode, res.body).toBe(200);
    const listingId = res.json().id as number;
    // 独立 IPv4 要在实例运行时测：测完才关机
    expect(await db.task.count({ where: { instanceId: id, type: 'STOP' } })).toBe(0);
    expect(await waitFor(async () => (await ping.agentListingJobs(ipNodeId)).length > 0)).toBe(true);
    expect(await jobOf(ipNodeId, listingId)).toMatchObject({ id: listingId, ip: inst.ipAddress!.address, kind: 'dedicated', mac: inst.macAddress, gateway: '198.51.100.1', bridge: 'br0' });
    const blocked = ['北京', '上海', '广东', '江苏', '浙江', '四川'];
    expect(await finish(ipNodeId, { id: listingId, method: 'icmp', via: 'spoof-l2', results: results(blocked) })).toBe(true);
    expect(await waitFor(async () => (await db.task.count({ where: { instanceId: id, type: 'STOP' } })) === 1)).toBe(true);
    const card = (await request('GET', '/api/public/market', '')).json().items.find((l: { id: number }) => l.id === listingId);
    expect(card.ping).toMatchObject({ status: 'DONE', verdict: 'PARTIAL', failedProvinces: 6 });
    expect((await request('GET', `/api/public/market/${listingId}/ping`, '')).json()).toMatchObject({ ipv4: 'DEDICATED', via: 'spoof-l2' });
    await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
  }, 60_000);

  it('starts a stopped dedicated IPv4 instance for the test', async () => {
    const id = await makeInstance('mp-ip-off', ipNodeId, 'KVM_IPV4');
    await db.instance.update({ where: { id }, data: { status: 'STOPPED' } });
    await agentOnline(ipNodeId);
    const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 15 });
    expect(res.statusCode, res.body).toBe(200);
    const listingId = res.json().id as number;
    // 先开机（测试里没有 Worker：模拟开机完成）
    expect(await waitFor(async () => (await db.task.count({ where: { instanceId: id, type: 'START' } })) === 1)).toBe(true);
    expect(await ping.agentListingJobs(ipNodeId)).toEqual([]);
    await db.instance.update({ where: { id }, data: { status: 'RUNNING' } });
    expect(await waitFor(async () => (await ping.agentListingJobs(ipNodeId)).length > 0)).toBe(true);
    await finish(ipNodeId, { id: listingId, method: 'icmp', via: 'spoof-l2', results: results() });
    expect(await waitFor(async () => (await db.task.count({ where: { instanceId: id, type: 'STOP' } })) === 1)).toBe(true);
    expect((await request('GET', `/api/public/market/${listingId}/ping`, '')).json().verdict).toBe('NORMAL');
    await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
  }, 60_000);

  it('records why the test could not run', async () => {
    // Agent 版本过旧（不支持上架拨测）
    await agentOnline(natNodeId, ['heartbeat']);
    const id = await makeInstance('mp-old-agent', natNodeId, 'LXC_NAT');
    const res = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 9 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ published: false, ping: { status: 'FAILED', reason: 'agent', verdict: null } });
    expect((await request('GET', '/api/public/market', '')).json().items.some((l: { id: number }) => l.id === res.json().id)).toBe(false);
    // Agent 升级后重新拨测，完成后上架
    await agentOnline(natNodeId);
    const retried = await request('POST', `/api/market/listings/${res.json().id}/ping`, sellerCookie);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ published: false, ping: { status: 'PENDING' } });
    // 拨测中不能再重新拨测；其他用户不能操作
    expect((await request('POST', `/api/market/listings/${res.json().id}/ping`, sellerCookie)).statusCode).toBe(409);
    expect((await request('POST', `/api/market/listings/${res.json().id}/ping`, otherCookie)).statusCode).toBe(404);
    expect(await waitFor(async () => (await ping.agentListingJobs(natNodeId)).length > 0)).toBe(true);
    await finish(natNodeId, { id: res.json().id, method: 'icmp', via: 'default', results: results() });
    expect((await request('GET', '/api/public/market', '')).json().items.find((l: { id: number }) => l.id === res.json().id)).toMatchObject({ published: true, ping: { verdict: 'NORMAL' } });
    // Agent 回传错误
    await agentOnline(natNodeId);
    await request('DELETE', `/api/market/listings/${res.json().id}`, sellerCookie);
    // 测试里没有 Worker：上一次上架排队的关机任务视为已完成
    await db.task.deleteMany({ where: { instanceId: id, status: 'QUEUED' } });
    await db.instance.update({ where: { id }, data: { status: 'STOPPED' } });
    const again = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 9 });
    expect(again.statusCode, again.body).toBe(200);
    expect(await waitFor(async () => (await ping.agentListingJobs(natNodeId)).length > 0)).toBe(true);
    await finish(natNodeId, { id: again.json().id, error: 'boom' });
    expect((await request('GET', `/api/public/market/${again.json().id}/ping`, sellerCookie)).json()).toMatchObject({ status: 'FAILED', reason: 'error' });
    // 未公开的商品其他人看不到快照
    expect((await request('GET', `/api/public/market/${again.json().id}/ping`, '')).statusCode).toBe(404);
  }, 60_000);

  it('only marks verified two-round mainland blocking as abnormal, and recovers positive second-round replies', async () => {
    await agentOnline(natNodeId);
    const allTimeouts = results(PING_TARGETS.map(t => t.province));
    const controls = MARKET_PING_CONTROLS.map(t => ({ id: t.id, latency: 30, loss: 0, targetIp: t.host }));
    const cases: [number, Parameters<typeof finish>[1]['verification'], string][] = [
      [0, { results: allTimeouts, controls, confirmationControls: controls }, 'ABNORMAL'],
      [1, { results: allTimeouts, controls, confirmationControls: [] }, 'UNKNOWN'],
      [2, { results: results(), controls, confirmationControls: controls }, 'NORMAL'],
      [3, undefined, 'UNKNOWN'],
      [4, { results: allTimeouts.map((r, i) => i ? r : { ...r, error: 'DNS failed' }), controls, confirmationControls: controls }, 'UNKNOWN'],
      [5, { results: allTimeouts.map(r => ({ ...r, targetIp: '198.51.100.1' })), controls, confirmationControls: controls }, 'UNKNOWN'],
      [6, { results: [...allTimeouts, allTimeouts[0]], controls, confirmationControls: controls }, 'UNKNOWN'],
      [7, { results: allTimeouts, controls: controls.map(r => ({ ...r, targetIp: '203.0.113.2' })), confirmationControls: controls }, 'UNKNOWN'],
    ];
    for (const [index, verification, verdict] of cases) {
      const id = await makeInstance(`mp-confirm-${index}`, natNodeId, 'LXC_NAT');
      const response = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
      expect(response.statusCode, response.body).toBe(200);
      const listingId = response.json().id;
      expect(await finish(natNodeId, { id: listingId, method: 'icmp', via: 'local', results: allTimeouts, verification })).toBe(true);
      expect((await request('GET', `/api/public/market/${listingId}/ping`, '')).json()).toMatchObject({ status: 'DONE', verdict });
      expect((await request('GET', '/api/public/market', '')).json().items.find((l: { id: number }) => l.id === listingId)).toMatchObject({ published: true });
      await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
    }
  }, 60_000);

  it('rejects TCP fallback, wrong source, incomplete results, DNS failures and contradictory loss reports', async () => {
    await agentOnline(natNodeId);
    const id = await makeInstance('mp-invalid-test', natNodeId, 'LXC_NAT');
    const response = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
    expect(response.statusCode, response.body).toBe(200);
    const listingId = response.json().id;
    const cases: Partial<Parameters<typeof finish>[1]>[] = [
      { method: 'tcp' }, { ip: '203.0.113.99' }, { results: results().slice(0, -1) },
      { results: results().map((r, i) => i ? r : { ...r, latency: null, loss: 100, error: 'DNS failure' }) },
      { results: results().map((r, i) => i ? r : { ...r, latency: null, loss: 0 }) },
      { results: [...results(), results()[0]] },
    ];
    for (let index = 0; index < cases.length; index++) {
      if (index) expect((await request('POST', `/api/market/listings/${listingId}/ping`, sellerCookie)).statusCode).toBe(200);
      expect(await finish(natNodeId, { id: listingId, method: 'icmp', via: 'local', results: results(), ...cases[index] })).toBe(true);
      const detail = (await request('GET', `/api/public/market/${listingId}/ping`, sellerCookie)).json();
      expect(detail).toMatchObject({ status: 'FAILED', verdict: null, reason: 'error' });
      expect((await db.marketListing.findUniqueOrThrow({ where: { id: listingId } })).published).toBe(false);
    }
    await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
  }, 60_000);

  it('binds results to each attempt and freezes target metadata, rejecting duplicate and stale reports', async () => {
    const { getSetting, setSetting } = await import('../src/lib/settings.ts');
    const original = await getSetting('ping');
    await agentOnline(natNodeId);
    const id = await makeInstance('mp-frozen-targets', natNodeId, 'LXC_NAT');
    const response = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
    const listingId = response.json().id;
    const first = await jobOf(natNodeId, listingId);
    try {
      expect(await ping.saveAgentListingPing(natNodeId, { id: listingId, method: 'icmp', via: 'local', results: results() })).toBe(false);
      expect(await finish(natNodeId, { id: listingId, error: 'retry this attempt' })).toBe(true);
      expect((await request('POST', `/api/market/listings/${listingId}/ping`, sellerCookie)).statusCode).toBe(200);
      const second = await jobOf(natNodeId, listingId);
      expect(second.requestId).not.toBe(first.requestId);
      expect(await ping.saveAgentListingPing(natNodeId, { id: listingId, requestId: first.requestId, ip: first.ip, method: 'icmp', via: 'local', results: results() })).toBe(false);
      await setSetting('ping', { targets: [{ ...PING_TARGETS[0], id: 'changed-target', enabled: true }] });
      expect(await finish(natNodeId, { id: listingId, method: 'icmp', via: 'local', results: results() })).toBe(true);
      expect(await ping.saveAgentListingPing(natNodeId, { id: listingId, requestId: second.requestId, ip: second.ip, method: 'icmp', via: 'local', results: results() })).toBe(false);
      const detail = (await request('GET', `/api/public/market/${listingId}/ping`, '')).json();
      expect(detail).toMatchObject({ status: 'DONE', verdict: 'NORMAL', total: 93 });
      expect(detail.targets).toHaveLength(93);
      expect(detail.targets[0].id).toBe('bj-ct');
    } finally {
      await setSetting('ping', original);
      await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
    }
  }, 60_000);

  it('does not publish reports from canceled listings or accept old agent capabilities', async () => {
    await agentOnline(natNodeId, ['heartbeat', 'listing-ping']);
    const id = await makeInstance('mp-canceled-ping', natNodeId, 'LXC_NAT');
    const response = await request('POST', '/api/market/listings', sellerCookie, { instanceId: id, price: 10 });
    const listingId = response.json().id;
    expect(response.json()).toMatchObject({ ping: { status: 'FAILED', reason: 'agent' } });
    await agentOnline(natNodeId);
    await request('POST', `/api/market/listings/${listingId}/ping`, sellerCookie);
    const job = await jobOf(natNodeId, listingId);
    await request('DELETE', `/api/market/listings/${listingId}`, sellerCookie);
    expect(await ping.saveAgentListingPing(natNodeId, { id: listingId, requestId: job.requestId, ip: job.ip, method: 'icmp', via: 'local', results: results() })).toBe(false);
    expect((await db.marketListing.findUniqueOrThrow({ where: { id: listingId } })).published).toBe(false);
  }, 60_000);
});

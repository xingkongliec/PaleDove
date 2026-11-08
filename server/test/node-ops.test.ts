import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { HostInstancesDTO } from '../src/shared/index.ts';

describe('node ops: host instances, baseline sync and network repair', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let incus: import('../src/incus/types.ts').IncusApi;
  let runTask: typeof import('../src/services/operations.ts').runTask;
  let directory: string;
  let adminCookie: string;
  let nodeId: number;
  let instanceId: number;
  let cidr: string;
  let privateIp: string;
  let requestNumber = 0;
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, payload, remoteAddress: `10.2.0.${(++requestNumber % 250) + 1}`, headers: { 'x-requested-with': 'XMLHttpRequest', cookie: adminCookie } });
  const list = async () => {
    const res = await request('GET', `/api/admin/nodes/${nodeId}/ops/instances`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as HostInstancesDTO;
  };
  /** 提交批量任务并直接执行（测试中不启动 Worker） */
  const runBatch = async (path: string, body: object = {}) => {
    const res = await request('POST', `/api/admin/nodes/${nodeId}/ops/${path}`, body);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: 1, failed: [] });
    const task = await db.task.findFirstOrThrow({ where: { instanceId }, orderBy: { id: 'desc' } });
    await runTask(task.id);
    const done = await db.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(done.status, done.error ?? '').toBe('SUCCESS');
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-node-ops-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-node-ops-secret-1234567890', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    runTask = (await import('../src/services/operations.ts')).runTask;
    const { buildCreateRequest } = await import('../src/services/spec.ts');
    const password = 'test-node-ops-password-123';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    const admin = await db.user.create({ data: { username: 'ops-admin', email: 'ops-admin@example.com', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
    const node = await db.node.create({ data: { name: 'Ops node', region: 'Test', endpoint: 'mock://ops', publicIp: '203.0.113.20', status: 'ONLINE' } });
    nodeId = node.id;
    // 模拟宿主机的 NAT 网段由名称决定，同步到面板记录
    const natNode = await (await import('../src/services/allocation.ts')).ensureNatNetwork(node);
    cidr = natNode.natCidr!;
    privateIp = cidr.replace(/\.1\/24$/, '.10');
    const image = await db.image.create({ data: { name: 'Debian 12', family: 'debian', alias: 'debian/12', server: 'https://images.example.com', protocol: 'simplestreams' } });
    const inst = await db.instance.create({
      data: {
        name: 'ops-managed', hostname: 'ops-managed', userId: admin.id, nodeId, imageId: image.id, type: 'LXC_NAT', status: 'RUNNING', privateIp, macAddress: '00:16:3e:00:00:10', provisionedAt: new Date(),
        cpu: 2, memory: 1024, disk: 10, bandwidthIn: 100, bandwidthOut: 50, traffic: 100, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 1,
        portLimit: 5, siteLimit: 5, snapshotLimit: 5, trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY', price: 10, expiresAt: new Date(Date.now() + 86400_000),
      },
    });
    instanceId = inst.id;
    await db.portMapping.create({ data: { instanceId, nodeId, protocol: 'TCP', publicPort: 20022, privatePort: 22, system: true } });
    incus = await (await import('../src/incus/index.ts')).getIncus(node);
    const full = await (await import('../src/services/operations.ts')).loadFullInstance(instanceId);
    await incus.createInstance(buildCreateRequest({ instance: full, node: full.node, image, ip: null, portMappings: full.portMappings, vars: { hostname: 'ops-managed', password: 'x', sshKeys: [] } }));
    // 不是面板创建的实例、带面板标记但数据库里没有记录的残留
    await incus.createInstance({ name: 'hand-made', type: 'container', source: { type: 'image', alias: 'alpine/3.20', server: 'x', protocol: 'simplestreams', mode: 'pull' }, config: {}, devices: {}, profiles: ['default'], start: false });
    await incus.createInstance({ name: 'leftover', type: 'container', source: { type: 'image', alias: 'alpine/3.20', server: 'x', protocol: 'simplestreams', mode: 'pull' }, config: { 'user.paledove.id': '9999' }, devices: {}, profiles: ['default'], start: true });
    app = await (await import('../src/app.ts')).buildApp();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: 'ops-admin', password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(login.statusCode, login.body).toBe(200);
    adminCookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-node-ops-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('classifies instances on the node and reports no drift for a freshly created instance', async () => {
    const data = await list();
    expect(data.network).toMatchObject({ ok: true, cidr });
    expect(data.items.map((i) => [i.name, i.category])).toEqual([['ops-managed', 'managed'], ['leftover', 'orphan'], ['hand-made', 'other']]);
    const managed = data.items[0];
    expect(managed.record).toMatchObject({ id: instanceId, hostname: 'ops-managed' });
    expect(managed.drift).toEqual([]);
    expect(data.items[1].panelId).toBe(9999);
    expect(data.missing).toEqual([]);
  });

  it('audits running instances without changing them and reports stopped instances clearly', async () => {
    const library = await request('GET', `/api/admin/nodes/${nodeId}/ops/audit-rules`);
    expect(library.statusCode, library.body).toBe(200);
    expect(library.json().rules).toHaveLength(9);
    const res = await request('POST', `/api/admin/nodes/${nodeId}/ops/audit`, { names: ['ops-managed', 'hand-made'] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ops-managed', type: 'container', status: 'CLEAN', findings: [] }),
        expect.objectContaining({ name: 'hand-made', type: 'container', status: 'STOPPED', findings: [] }),
      ]),
    );
    expect((await incus.getInstance('ops-managed')).status).toBe('Running');
  });

  it('lets administrators manage custom audit rules and excludes disabled rules from audits', async () => {
    const created = await request('POST', '/api/admin/audit-rules', {
      name: 'Internal packet helper', category: 'PACKET', risk: 'MEDIUM', matches: ['internal-packet-helper'],
    });
    expect(created.statusCode, created.body).toBe(200);
    const custom = created.json().rules.find((rule: { source: string; name: string }) => rule.source === 'CUSTOM' && rule.name === 'Internal packet helper');
    expect(custom).toMatchObject({ source: 'CUSTOM', enabled: true, category: 'PACKET', risk: 'MEDIUM', matches: ['internal-packet-helper'] });
    expect(custom.databaseId).toEqual(expect.any(Number));

    const renamed = await request('PATCH', `/api/admin/audit-rules/${custom.databaseId}`, { name: 'Internal packet helper v2' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renamed.json().rules.find((rule: { databaseId?: number }) => rule.databaseId === custom.databaseId)).toMatchObject({ name: 'Internal packet helper v2', enabled: true });

    const disabled = await request('PATCH', `/api/admin/audit-rules/${custom.databaseId}`, { enabled: false });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().rules.find((rule: { databaseId?: number }) => rule.databaseId === custom.databaseId)).toMatchObject({ enabled: false });

    const audit = await request('POST', `/api/admin/nodes/${nodeId}/ops/audit`, { names: ['ops-managed'] });
    expect(audit.statusCode, audit.body).toBe(200);
    expect(audit.json().rules.find((rule: { databaseId?: number }) => rule.databaseId === custom.databaseId)).toBeUndefined();

    const removed = await request('DELETE', `/api/admin/audit-rules/${custom.databaseId}`);
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json().rules.some((rule: { databaseId?: number }) => rule.databaseId === custom.databaseId)).toBe(false);
  });

  it('detects drift and fixes it with baseline sync', async () => {
    await incus.modifyInstance('ops-managed', (i) => {
      i.config['limits.cpu'] = '8';
      i.config['boot.autostart'] = 'false';
      i.devices.eth0['limits.egress'] = '1000Mbit';
    });
    const drift = (await list()).items[0].drift;
    expect(drift).toEqual(
      expect.arrayContaining([
        { kind: 'baseline', key: 'limits.cpu', expected: '2', actual: '8' },
        { kind: 'baseline', key: 'boot.autostart', expected: 'true', actual: 'false' },
        { kind: 'baseline', key: 'eth0.limits', expected: 'limits.ingress=100Mbit, limits.egress=50Mbit', actual: 'limits.ingress=100Mbit, limits.egress=1000Mbit' },
      ]),
    );
    expect(drift.every((d) => d.kind === 'baseline')).toBe(true);
    await runBatch('sync-baseline');
    expect((await list()).items[0].drift).toEqual([]);
  });

  it('detects broken networking and repairs NIC and port mapping devices', async () => {
    await incus.modifyInstance('ops-managed', (i) => {
      i.devices.eth0['ipv4.address'] = cidr.replace(/\.1\/24$/, '.99');
      delete i.devices['pm1-tcp'];
    });
    const drift = (await list()).items[0].drift;
    expect(drift.map((d) => d.key).sort()).toEqual(['eth0', 'guest.ipv4', 'proxy']);
    expect(drift.every((d) => d.kind === 'network')).toBe(true);
    await runBatch('repair-network', { ids: [instanceId] });
    const after = await incus.getInstance('ops-managed');
    expect(after.devices.eth0['ipv4.address']).toBe(privateIp);
    expect(after.devices['pm1-tcp']).toBeTruthy();
    expect(after.status).toBe('Running');
    expect((await list()).items[0].drift).toEqual([]);
  }, 30_000);

  it('manages unregistered instances directly and protects panel instances', async () => {
    const base = `/api/admin/nodes/${nodeId}/ops/instances`;
    expect((await request('POST', `${base}/ops-managed/state`, { action: 'stop' })).statusCode).toBe(409);
    expect((await request('DELETE', `${base}/ops-managed`)).statusCode).toBe(409);
    expect((await request('POST', `${base}/missing-one/state`, { action: 'start' })).statusCode).toBe(404);

    expect((await request('PATCH', `${base}/hand-made`, { cpu: 2, memory: 256, autostart: true, description: 'manual' })).statusCode).toBe(200);
    const edited = await incus.getInstance('hand-made');
    expect(edited.config).toMatchObject({ 'limits.cpu': '2', 'limits.memory': '256MiB', 'boot.autostart': 'true' });
    expect(edited.description).toBe('manual');
    expect((await request('PATCH', `${base}/hand-made`, { cpu: null })).statusCode).toBe(200);
    expect((await incus.getInstance('hand-made')).config['limits.cpu']).toBeUndefined();

    expect((await request('POST', `${base}/hand-made/state`, { action: 'start' })).statusCode).toBe(200);
    expect((await incus.getInstanceState('hand-made')).status).toBe('Running');
    const raw = await request('GET', `${base}/hand-made`);
    expect(raw.json().config['limits.memory']).toBe('256MiB');

    expect((await request('DELETE', `${base}/leftover`)).statusCode).toBe(200);
    expect(await incus.instanceExists('leftover')).toBe(false);
  }, 30_000);

  it('opens a web terminal for any running instance on the node', async () => {
    type Ws = Awaited<ReturnType<FastifyInstance['injectWS']>>;
    const base = `/api/admin/nodes/${nodeId}/ops/instances`;
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

    // 面板实例与未登记的实例都可以连接；shell 退出后服务端关闭连接
    for (const name of ['ops-managed', 'hand-made']) {
      const ws = await app.injectWS(`${base}/${name}/terminal?cols=100&rows=30`, { headers: { cookie: adminCookie } });
      await read(ws, '# ');
      const ended = closed(ws);
      ws.send(JSON.stringify({ type: 'input', data: 'exit\r' }));
      await ended;
    }
    expect(await db.activityLog.count({ where: { action: 'admin.node_ops_terminal' } })).toBe(2);

    // 宿主机上不存在的实例：提示后关闭
    const missing = await app.injectWS(`${base}/missing-one/terminal`, { headers: { cookie: adminCookie } });
    const gone = closed(missing);
    await read(missing, '\x1b[31m');
    await gone;
    // 其他网站发起的连接直接关闭；未登录不能连接
    const cross = await app.injectWS(`${base}/ops-managed/terminal`, { headers: { cookie: adminCookie, 'sec-fetch-site': 'cross-site' } });
    await closed(cross);
    await expect(app.injectWS(`${base}/ops-managed/terminal`)).rejects.toThrow();
    expect(await db.activityLog.count({ where: { action: 'admin.node_ops_terminal' } })).toBe(2);
  }, 30_000);

  it('lists panel instances that are missing on the node', async () => {
    await incus.setState('ops-managed', 'stop', { force: true });
    await incus.deleteInstance('ops-managed');
    const data = await list();
    expect(data.missing.map((m) => m.id)).toEqual([instanceId]);
    expect(data.items.map((i) => i.name)).toEqual(['hand-made']);
  }, 30_000);
});

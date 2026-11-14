import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { normalizeArch, type PlanDTO } from '../src/shared/index.ts';
import type { SaleNodeDTO } from '../src/services/billing.ts';

describe('persistent host architecture and offline store images', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let redis: typeof import('../src/lib/redis.ts').redis;
  let reports: typeof import('../src/services/agent/agent.ts');
  let catalog: typeof import('../src/routes/store.ts');
  let cache: typeof import('../src/lib/cache.ts');
  let architecture: typeof import('../src/services/node-architecture.ts');
  let incus: typeof import('../src/incus/index.ts');
  let directory: string;
  let nodeId: number;
  let armId: number;
  let productId: number;
  let singleProductId: number;
  let singlePlanId: number;
  let x86ImageId: number;
  let armImageId: number;
  let extraImageId: number;
  const token = 'test-architecture-agent-token';
  const report = (arch?: string) => ({ cpu: 1, load: [0, 0, 0] as [number, number, number], uptime: 100, version: 3, ...(arch === undefined ? {} : { arch }) });
  const node = () => db.node.findUniqueOrThrow({ where: { id: nodeId } });
  const saleNodes = async (product = singleProductId) => {
    const response = await app.inject({ method: 'GET', url: `/api/public/products/${product}/nodes?region=Test` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().nodes as SaleNodeDTO[];
  };
  const regionImages = async () => (await catalog.listSalePlans()).find(plan => plan.id === singlePlanId)!.regionInfo.Test!.imageIds;

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-architecture-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-architecture-secret-12345678', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    redis = (await import('../src/lib/redis.ts')).redis;
    reports = await import('../src/services/agent/agent.ts');
    catalog = await import('../src/routes/store.ts');
    cache = await import('../src/lib/cache.ts');
    architecture = await import('../src/services/node-architecture.ts');
    incus = await import('../src/incus/index.ts');
    const { sha256 } = await import('../src/lib/crypto.ts');
    nodeId = (await db.node.create({ data: { name: 'x86 host', region: 'Test', endpoint: 'mock://architecture-x86', status: 'ONLINE', arch: 'x86_64', agentTokenHash: sha256(token) } })).id;
    armId = (await db.node.create({ data: { name: 'ARM host', region: 'Test', endpoint: 'mock://architecture-arm', status: 'ONLINE', arch: 'aarch64' } })).id;
    x86ImageId = (await db.image.create({ data: { name: 'Alpine 3.21', family: 'alpine', alias: 'alpine/3.21/cloud', arch: 'x86_64' } })).id;
    armImageId = (await db.image.create({ data: { name: 'Alpine 3.21', family: 'alpine', alias: 'alpine/3.21/cloud', arch: 'aarch64' } })).id;
    extraImageId = (await db.image.create({ data: { name: 'Debian 12', family: 'debian', alias: 'debian/12/cloud', arch: 'x86_64' } })).id;
    const plan = { type: 'LXC_NAT' as const, cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, priceMonthly: 5 };
    productId = (await db.product.create({ data: { name: 'Mixed architectures', nodes: { connect: [{ id: nodeId }, { id: armId }] }, plans: { create: { ...plan, name: 'Mixed plan' } } } })).id;
    const single = await db.product.create({ data: { name: 'Single host', nodes: { connect: { id: nodeId } }, plans: { create: { ...plan, name: 'Single plan' } } }, include: { plans: true } });
    singleProductId = single.id;
    singlePlanId = single.plans[0].id;
    app = await (await import('../src/app.ts')).buildApp();
  }, 60_000);

  beforeEach(async () => {
    await db.node.update({ where: { id: nodeId }, data: { arch: 'x86_64', status: 'ONLINE', imageIds: (await import('../src/lib/prisma.ts')).Prisma.DbNull } });
    await db.node.update({ where: { id: armId }, data: { arch: 'aarch64', status: 'ONLINE' } });
    for (const id of [nodeId, armId]) { incus.invalidateIncus(id); await redis.del(`node:host:${id}`, `node:resources:${id}`); }
    await cache.invalidateCache('catalog');
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-architecture-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('normalizes Agent and Incus architecture names without guessing unknown hardware', () => {
    expect(['amd64', 'x86_64', ' AMD64 '].map(normalizeArch)).toEqual(['x86_64', 'x86_64', 'x86_64']);
    expect(['arm64', 'aarch64', ' AARCH64 '].map(normalizeArch)).toEqual(['aarch64', 'aarch64', 'aarch64']);
    expect(normalizeArch('ppc64le')).toBe('ppc64le');
    expect(normalizeArch('  ')).toBeNull();
  });

  it('persists architecture from an actual Agent report and invalidates cached store images immediately', async () => {
    await db.node.update({ where: { id: nodeId }, data: { arch: null } });
    expect(await regionImages()).toBeNull();
    const response = await app.inject({ method: 'POST', url: '/api/agent/nodes/report', headers: { authorization: `Bearer ${token}`, 'x-requested-with': 'XMLHttpRequest' }, payload: report('amd64') });
    expect(response.statusCode, response.body).toBe(200);
    expect((await node()).arch).toBe('x86_64');
    expect(await regionImages()).toEqual([x86ImageId, extraImageId]);
    expect((await saleNodes())[0].imageIds).toEqual([x86ImageId, extraImageId]);
  });

  it('keeps the last known architecture when heartbeat data is missing or empty and temporary data expires', async () => {
    await reports.saveHostReport(nodeId, report('arm64'));
    await reports.saveHostReport(nodeId, report());
    await reports.saveHostReport(nodeId, report(' '));
    await reports.clearHostReport(nodeId);
    await db.node.update({ where: { id: nodeId }, data: { status: 'OFFLINE' } });
    expect((await node()).arch).toBe('aarch64');
    expect((await saleNodes())[0]).toMatchObject({ status: 'OFFLINE', imageIds: [armImageId], plans: [] });
    expect(await regionImages()).toEqual([armImageId]);
  });

  it('recovers an offline legacy host architecture from its last heartbeat and persists it beyond Redis expiry', async () => {
    await db.node.update({ where: { id: nodeId }, data: { arch: null, status: 'OFFLINE' } });
    await redis.set(`node:host:${nodeId}`, JSON.stringify({ ...report('arm64'), reportedAt: '2020-01-01T00:00:00.000Z' }));
    expect((await saleNodes())[0]).toMatchObject({ id: nodeId, imageIds: [armImageId], plans: [] });
    expect((await node()).arch).toBe('aarch64');
    await reports.clearHostReport(nodeId);
    await cache.invalidateCache('catalog');
    const response = await app.inject({ method: 'GET', url: '/api/public/plans' });
    const plans = response.json() as PlanDTO[];
    expect(plans.find(plan => plan.id === singlePlanId)!.regionInfo.Test!.imageIds).toEqual([armImageId]);
  });

  it('recovers legacy architecture while loading the region catalog, before the node endpoint is requested', async () => {
    await db.node.update({ where: { id: nodeId }, data: { arch: null, status: 'OFFLINE' } });
    await redis.set(`node:host:${nodeId}`, JSON.stringify(report('amd64')));
    expect(await regionImages()).toEqual([x86ImageId, extraImageId]);
    expect((await node()).arch).toBe('x86_64');
  });

  it('retains offline hosts and their own image restrictions beside a host of another architecture', async () => {
    await db.node.update({ where: { id: nodeId }, data: { status: 'OFFLINE', imageIds: [x86ImageId, armImageId] } });
    const nodes = await saleNodes(productId);
    expect(nodes).toHaveLength(2);
    expect(nodes.find(node => node.id === nodeId)).toMatchObject({ status: 'OFFLINE', imageIds: [x86ImageId], plans: [] });
    expect(nodes.find(node => node.id === armId)).toMatchObject({ status: 'ONLINE', imageIds: [armImageId] });
    expect(nodes.find(node => node.id === armId)!.plans).not.toHaveLength(0);
  });

  it('prefers persistent architecture to an old cached heartbeat and only invalidates the catalog when architecture changes', async () => {
    await redis.set(`node:host:${nodeId}`, JSON.stringify(report('arm64')));
    expect((await saleNodes())[0].imageIds).toEqual([x86ImageId, extraImageId]);
    expect((await architecture.resolveNodeArchitectures([{ id: nodeId, arch: null }]))[0].arch).toBe('x86_64');
    expect((await node()).arch).toBe('x86_64');
    const version = await redis.get('cache:ver:catalog');
    await reports.saveHostReport(nodeId, report('amd64'));
    expect(await redis.get('cache:ver:catalog')).toBe(version);
    await reports.saveHostReport(nodeId, report('arm64'));
    expect(await redis.get('cache:ver:catalog')).not.toBe(version);
    expect(await regionImages()).toEqual([armImageId]);
  });

  it('retains architecture on a failed health check and never overwrites a new Agent report with an empty Incus response', async () => {
    const client = await incus.getIncus(await node());
    const server = await client.getServer();
    vi.spyOn(incus, 'getIncus').mockResolvedValue(client);
    const getServer = vi.spyOn(client, 'getServer').mockRejectedValue(new Error('offline'));
    const { checkNodes } = await import('../src/services/lifecycle.ts');
    await checkNodes({ info: () => {}, warn: () => {} });
    expect(await node()).toMatchObject({ status: 'OFFLINE', arch: 'x86_64' });
    await db.node.update({ where: { id: nodeId }, data: { arch: null } });
    getServer.mockImplementation(async () => {
      await reports.saveHostReport(nodeId, report('arm64'));
      return { ...server, environment: { ...server.environment!, architectures: [] } };
    });
    await checkNodes({ info: () => {}, warn: () => {} });
    expect(await node()).toMatchObject({ status: 'ONLINE', arch: 'aarch64' });
  });

  it('records architecture from successful Incus connection and resource reads', async () => {
    const services = await import('../src/services/nodes.ts');
    await db.node.update({ where: { id: nodeId }, data: { arch: null } });
    await services.connectNode(await node());
    expect((await node()).arch).toBe('x86_64');
    const client = await incus.getIncus(await node());
    const server = await client.getServer();
    const resources = await client.getResources();
    vi.spyOn(incus, 'getIncus').mockResolvedValue(client);
    vi.spyOn(client, 'getServer').mockResolvedValue({ ...server, environment: { ...server.environment!, architectures: [] } });
    vi.spyOn(client, 'getResources').mockResolvedValue({ ...resources, cpu: { ...resources.cpu, architecture: 'aarch64' } });
    await services.getNodeResources(await node());
    expect((await node()).arch).toBe('aarch64');
    expect(await regionImages()).toEqual([armImageId]);
  });

  it('ignores malformed legacy reports and preserves unsupported architectures without offering incompatible images', async () => {
    await db.node.update({ where: { id: nodeId }, data: { arch: null, status: 'OFFLINE' } });
    for (const raw of ['{broken', JSON.stringify({ arch: 42 }), JSON.stringify(report())]) {
      await redis.set(`node:host:${nodeId}`, raw);
      expect((await architecture.resolveNodeArchitectures([await node()]))[0].arch).toBeNull();
    }
    await reports.saveHostReport(nodeId, report('ppc64le'));
    expect((await saleNodes())[0]).toMatchObject({ imageIds: [], plans: [] });
  });
});

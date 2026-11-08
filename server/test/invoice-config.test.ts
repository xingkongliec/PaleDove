import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import type { InstanceType, InvoiceDTO } from '../src/shared/index.ts';

describe('purchase invoice configuration', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let cookie: string;
  let userId: number;
  let otherUserId: number;
  let sequence = 0;
  const request = (method: 'GET' | 'POST', url: string, payload?: object) => app.inject({ method, url, payload, headers: { cookie, 'x-requested-with': 'XMLHttpRequest' } });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-invoice-config-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://',
      APP_SECRET: 'test-invoice-config-secret-12345678', LOG_LEVEL: 'error', COOKIE_SECURE: 'false',
    });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    const password = 'invoice-config-password-1';
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    userId = (await db.user.create({ data: { username: 'invoice-user', email: 'invoice@example.com', passwordHash: hash, emailVerifiedAt: new Date(), balance: 0 } })).id;
    otherUserId = (await db.user.create({ data: { username: 'other-user', email: 'other@example.com', passwordHash: hash, emailVerifiedAt: new Date() } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: 'invoice-user', password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(login.statusCode, login.body).toBe(200);
    cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-invoice-config-test-')) rmSync(directory, { recursive: true, force: true });
  });

  async function fixture(overrides: { type?: InstanceType; traffic?: number } = {}) {
    const n = ++sequence;
    const nodes = await Promise.all([1, 2].map((index) => db.node.create({ data: { name: `node-${n}-${index}`, region: 'HK', endpoint: `mock://invoice-${n}-${index}`, networkMode: overrides.type === 'KVM_IPV4' ? 'IPV4_IPV6' : 'NAT_IPV6' } })));
    const product = await db.product.create({ data: { name: `Product ${n}`, type: overrides.type ?? 'LXC_NAT', nodes: { connect: nodes.map(({ id }) => ({ id })) }, nodeOptions: { [nodes[0].id]: { trafficMultiplier: 1.5 }, [nodes[1].id]: { trafficMultiplier: 2 } } } });
    const plan = await db.plan.create({ data: {
      productId: product.id, name: `Plan ${n}`, type: overrides.type ?? 'LXC_NAT', cpu: 2, cpuAllowance: 50,
      memory: 1024, swap: 256, disk: 20, diskRead: 100, diskWriteIops: 3000,
      bandwidthIn: 200, bandwidthOut: 100, traffic: overrides.traffic ?? 100, trafficMode: 'OUT',
      portLimit: 10, siteLimit: 2, snapshotLimit: 3, ipv6Count: 1, priceMonthly: 9.99,
    } });
    const image = await db.image.create({ data: { name: `Debian ${n}`, family: 'debian', alias: 'debian/12/cloud' } });
    const input = { planId: plan.id, region: 'HK', imageId: image.id, cycle: 'MONTHLY', hostname: `invoice-vps-${n}`, nodeId: nodes[0].id, password: 'Root-password-123', sshKeys: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test' };
    return { plan, product, image, nodes, input };
  }

  async function create(input: object): Promise<InvoiceDTO> {
    const res = await request('POST', '/api/store/orders', input);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ invoice: InvoiceDTO }>().invoice;
  }

  it('returns selected resources and node traffic without charging or exposing credentials', async () => {
    const f = await fixture();
    const invoice = await create(f.input);
    expect(invoice.purchaseConfig).toMatchObject({
      product: f.product.name, plan: f.plan.name, hostname: f.input.hostname, region: 'HK', node: f.nodes[0].name, image: f.image.name,
      cycle: 'MONTHLY', type: 'LXC_NAT', cpu: 2, cpuAllowance: 50, memory: 1024, swap: 256, disk: 20,
      diskRead: 100, diskWriteIops: 3000, bandwidthIn: 200, bandwidthOut: 100, traffic: 150,
      trafficMode: 'OUT', portLimit: 10, siteLimit: 2, snapshotLimit: 3, ipv6Count: 1, snapshot: true, trafficIsEstimate: false,
    });
    expect(invoice.status).toBe('PENDING');
    expect(invoice.amount).toBe('9.99');
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString()).toBe('0');
    expect(await db.instance.count()).toBe(0);
    expect(await db.balanceLog.count()).toBe(0);
    const stored = await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stored.payload).toHaveProperty('passwordEnc');
    expect(JSON.stringify(invoice)).not.toMatch(/password|sshKeys|passwordEnc|ssh-ed25519/);
    const list = await request('GET', '/api/invoices');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ items: InvoiceDTO[] }>().items.find((i) => i.id === invoice.id)?.purchaseConfig).toEqual(invoice.purchaseConfig);
    expect(list.body).not.toMatch(/password|sshKeys|passwordEnc|ssh-ed25519/);
  });

  it('keeps the configuration after plan edits or deletion and after canceling', async () => {
    const f = await fixture();
    const invoice = await create(f.input);
    await db.plan.update({ where: { id: f.plan.id }, data: { name: 'Changed plan', cpu: 8, memory: 8192, traffic: 999 } });
    await db.product.update({ where: { id: f.product.id }, data: { name: 'Changed product', nodeOptions: { [f.nodes[0].id]: { trafficMultiplier: 9 } } } });
    await db.image.update({ where: { id: f.image.id }, data: { name: 'Changed OS' } });
    const detail = await request('GET', `/api/invoices/${invoice.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<InvoiceDTO>().purchaseConfig).toEqual(invoice.purchaseConfig);
    await db.plan.delete({ where: { id: f.plan.id } });
    const canceled = await request('POST', `/api/invoices/${invoice.id}/cancel`);
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json<InvoiceDTO>()).toMatchObject({ status: 'CANCELED', plan: null, purchaseConfig: invoice.purchaseConfig });
  });

  it('fills legacy invoice details from the linked plan without rewriting the invoice', async () => {
    const f = await fixture();
    const invoice = await create(f.input);
    const { password, sshKeys, ...payload } = f.input;
    await db.invoice.update({ where: { id: invoice.id }, data: { payload } });
    const detail = await request('GET', `/api/invoices/${invoice.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<InvoiceDTO>().purchaseConfig).toEqual({ ...invoice.purchaseConfig, snapshot: false });
    const canceled = await request('POST', `/api/invoices/${invoice.id}/cancel`);
    expect(canceled.statusCode, canceled.body).toBe(200);
    expect(canceled.json<InvoiceDTO>().purchaseConfig?.snapshot).toBe(false);
    expect((await db.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).payload).not.toHaveProperty('purchaseConfig');
    await db.plan.delete({ where: { id: f.plan.id } });
    const missingPlan = await request('GET', `/api/invoices/${invoice.id}`);
    expect(missingPlan.statusCode, missingPlan.body).toBe(200);
    expect(missingPlan.json<InvoiceDTO>().purchaseConfig).toBeNull();
  });

  it('preserves unlimited quotas and normalizes VM and dedicated IPv4 configuration', async () => {
    const f = await fixture({ type: 'KVM_IPV4', traffic: 0 });
    const invoice = await create(f.input);
    expect(invoice.purchaseConfig).toMatchObject({ type: 'KVM_IPV4', swap: 0, traffic: 0, portLimit: 0, siteLimit: 0, trafficIsEstimate: false });
  });

  it('marks traffic as an estimate only for automatic assignment across different multipliers', async () => {
    const f = await fixture();
    const { nodeId, ...input } = f.input;
    const invoice = await create(input);
    expect(invoice.purchaseConfig).toMatchObject({ node: null, traffic: 150, trafficIsEstimate: true });
  });

  it('keeps purchase configuration scoped to its owner and invoice type', async () => {
    const f = await fixture();
    const invoice = await create(f.input);
    await db.invoice.update({ where: { id: invoice.id }, data: { userId: otherUserId } });
    expect((await request('GET', `/api/invoices/${invoice.id}`)).statusCode).toBe(404);
    await db.invoice.update({ where: { id: invoice.id }, data: { userId, type: 'RENEW' } });
    const renewal = await request('GET', `/api/invoices/${invoice.id}`);
    expect(renewal.statusCode, renewal.body).toBe(200);
    expect(renewal.json<InvoiceDTO>().purchaseConfig).toBeNull();
  });

  it('filters all invoices before paginating and includes the entire selected end date', async () => {
    const startAt = '2040-01-15T00:00:00+08:00';
    const endAt = '2040-01-16T00:00:00+08:00';
    const first = new Date(startAt);
    const last = new Date(new Date(endAt).getTime() - 1);
    await db.invoice.createMany({ data: [
      { no: 'FILTER-FIRST', userId, type: 'PURCHASE', status: 'PENDING', createdAt: first },
      { no: 'FILTER-LAST', userId, type: 'PURCHASE', status: 'PENDING', createdAt: last },
      { no: 'FILTER-BEFORE', userId, type: 'PURCHASE', status: 'PENDING', createdAt: new Date(first.getTime() - 1) },
      { no: 'FILTER-AFTER', userId, type: 'PURCHASE', status: 'PENDING', createdAt: new Date(endAt) },
      { no: 'FILTER-RENEW', userId, type: 'RENEW', status: 'PENDING', createdAt: first },
      { no: 'FILTER-PAID', userId, type: 'PURCHASE', status: 'PAID', createdAt: first },
      { no: 'FILTER-OTHER-USER', userId: otherUserId, type: 'PURCHASE', status: 'PENDING', createdAt: first },
    ].map((row) => ({ ...row, type: row.type as 'PURCHASE' | 'RENEW', status: row.status as 'PENDING' | 'PAID', amount: 10, description: row.no, payload: {} })) });
    const params = new URLSearchParams({ q: 'filter-', type: 'PURCHASE', status: 'PENDING', startAt, endAt, pageSize: '1' });
    const firstPage = await request('GET', `/api/invoices?${params}`);
    expect(firstPage.statusCode, firstPage.body).toBe(200);
    expect(firstPage.json()).toMatchObject({ total: 2, page: 1, pageSize: 1, items: [{ no: 'FILTER-LAST' }] });
    expect(firstPage.json<{ items: InvoiceDTO[] }>().items[0].updatedAt).toBeTruthy();
    params.set('page', '2');
    const secondPage = await request('GET', `/api/invoices?${params}`);
    expect(secondPage.statusCode, secondPage.body).toBe(200);
    expect(secondPage.json()).toMatchObject({ total: 2, page: 2, pageSize: 1, items: [{ no: 'FILTER-FIRST' }] });
    params.set('q', 'not-a-real-invoice-number');
    const empty = await request('GET', `/api/invoices?${params}`);
    expect(empty.json()).toMatchObject({ total: 0, items: [] });
  });

  it('validates filters instead of returning misleading results for invalid dates or types', async () => {
    for (const query of [
      'type=UNKNOWN', 'startAt=not-a-date',
      'startAt=2040-01-16T00%3A00%3A00Z&endAt=2040-01-15T00%3A00%3A00Z',
    ]) {
      const res = await request('GET', `/api/invoices?${query}`);
      expect(res.statusCode, res.body).toBe(400);
    }
  });
});

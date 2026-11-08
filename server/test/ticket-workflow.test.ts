import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

describe('ticket workflow and attachments', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let settings: typeof import('../src/lib/settings.ts');
  let directory: string;
  let adminCookie: string; let userCookie: string; let otherCookie: string;
  let userId: number; let otherId: number; let instanceId: number;
  let requestNumber = 0;
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, cookie: string, payload?: object | Buffer, contentType?: string) => app.inject({
    method, url, payload, remoteAddress: `10.1.${Math.floor(++requestNumber / 250)}.${requestNumber % 250 + 1}`,
    headers: { 'x-requested-with': 'XMLHttpRequest', cookie, ...(contentType ? { 'content-type': contentType } : {}) },
  });
  const form = (fields: Record<string, string>, files: { name: string; data: Buffer | string; mime?: string }[] = []) => {
    const boundary = 'test-ticket-multipart-boundary'; const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    for (const file of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.mime || 'application/octet-stream'}\r\n\r\n`), Buffer.from(file.data), Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  };
  const upload = (url: string, cookie: string, fields: Record<string, string>, files: { name: string; data: Buffer | string; mime?: string }[]) => {
    const body = form(fields, files); return request('POST', url, cookie, body.payload, body.contentType);
  };
  const storedFiles = () => existsSync(resolve(directory, 'uploads')) ? readdirSync(resolve(directory, 'uploads'), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length : 0;
  const create = async (overrides: Record<string, unknown> = {}) => {
    const response = await request('POST', '/api/tickets', userCookie, { subject: 'Network issue', content: 'Connection times out', category: 'network', priority: 'HIGH', ...overrides });
    expect(response.statusCode, response.body).toBe(200); return response.json();
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-tickets-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, UPLOAD_DIR: resolve(directory, 'uploads'), REDIS_URL: 'memory://', APP_SECRET: 'test-ticket-workflow-secret-12345', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3'); new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma; settings = await import('../src/lib/settings.ts');
    await settings.updateSettings({ allowTickets: true });
    const password = 'test-ticket-password-123'; const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const [username, role] of [['support-admin', 'ADMIN'], ['customer', 'USER'], ['stranger', 'USER']] as const) await db.user.create({ data: { username, email: `${username}@example.com`, role, passwordHash: hash, emailVerifiedAt: new Date() } });
    userId = (await db.user.findUniqueOrThrow({ where: { username: 'customer' } })).id; otherId = (await db.user.findUniqueOrThrow({ where: { username: 'stranger' } })).id;
    const node = await db.node.create({ data: { name: 'Ticket test node', region: 'Test', endpoint: 'mock://tickets' } });
    instanceId = (await db.instance.create({ data: {
      name: 'customer-instance', hostname: 'customer-instance', userId, nodeId: node.id, type: 'LXC_NAT', status: 'STOPPED',
      cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 100, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 1,
      portLimit: 5, siteLimit: 5, snapshotLimit: 5, trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY', price: 10, expiresAt: new Date(Date.now() + 86400_000),
    } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await request('POST', '/api/auth/login', '', { account, password });
      expect(response.statusCode, response.body).toBe(200); return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('support-admin'); userCookie = await login('customer'); otherCookie = await login('stranger');
  }, 60_000);
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-tickets-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('creates resource-linked tickets and searches numbers, categories, priorities and owner email', async () => {
    const ticket = await create({ resourceRef: instanceId });
    expect(ticket).toMatchObject({ number: ticket.id + 10000, category: 'network', priority: 'HIGH', status: 'OPEN', resourceRef: instanceId, resourceName: 'customer-instance', counts: { messages: 1, attachments: 0 } });
    expect(ticket.user.email).toBeUndefined();
    for (const query of [`q=%23${ticket.number}`, 'q=Network', 'category=network&priority=HIGH', 'status=OPEN']) expect((await request('GET', `/api/tickets?${query}`, userCookie)).json().items.some((row: { id: number }) => row.id === ticket.id)).toBe(true);
    expect((await request('GET', '/api/tickets?priority=LOW', userCookie)).json().total).toBe(0);
    expect((await request('GET', '/api/admin/tickets?q=customer%40example.com', adminCookie)).json().items[0].user.email).toBe('customer@example.com');
    expect((await request('GET', `/api/tickets?q=%23${ticket.number}`, otherCookie)).json().total).toBe(0);
    expect((await request('POST', '/api/tickets', otherCookie, { subject: 'Foreign instance', content: 'Test', resourceRef: instanceId })).statusCode).toBe(404);
  });

  it('moves between pending, replied and closed, hides support accounts and closes atomically with a reply', async () => {
    const ticket = await create(); const url = `/api/tickets/${ticket.id}`; const adminUrl = `/api/admin/tickets/${ticket.id}`;
    expect((await request('POST', `${adminUrl}/messages`, adminCookie, { content: 'Try again' })).statusCode).toBe(200);
    const detail = (await request('GET', url, userCookie)).json();
    expect(detail.status).toBe('REPLIED'); expect(detail.messages.at(-1).author).toEqual({ id: null, username: '技术支持', role: 'ADMIN', avatar: null });
    expect(JSON.stringify(detail)).not.toContain('support-admin');
    expect((await request('GET', '/api/tickets/stats', userCookie)).json().REPLIED).toBeGreaterThan(0);
    expect((await request('POST', `${url}/messages`, userCookie, { content: 'Still happens' })).statusCode).toBe(200);
    expect((await request('GET', url, userCookie)).json().status).toBe('OPEN');
    expect((await request('PATCH', adminUrl, adminCookie, { category: 'domain', priority: 'URGENT' })).statusCode).toBe(200);
    expect((await request('PATCH', url, userCookie, { priority: 'LOW', status: 'OPEN' })).statusCode).toBe(400);
    expect((await request('POST', `${url}/messages`, userCookie, { content: 'Close for me', close: true })).statusCode).toBe(403);
    expect((await request('POST', `${adminUrl}/messages`, adminCookie, { content: 'Resolved', close: '1' })).statusCode).toBe(200);
    const closed = (await request('GET', url, userCookie)).json();
    expect(closed).toMatchObject({ status: 'CLOSED', category: 'domain', priority: 'URGENT', counts: { messages: 4 } }); expect(closed.closedAt).toBeTruthy();
    expect((await request('POST', `${adminUrl}/messages`, adminCookie, { content: 'Too late' })).statusCode).toBe(409);
    expect((await request('PATCH', url, userCookie, { status: 'OPEN' })).statusCode).toBe(200);
    expect((await request('GET', url, userCookie)).json().closedAt).toBeNull();
  });

  it('stores multipart attachments, enforces ownership and returns safe download headers', async () => {
    const response = await upload('/api/tickets', userCookie, { subject: 'Log upload', category: 'disk', content: 'Please inspect logs' }, [{ name: '错误日志.txt', data: 'a <script>log</script>', mime: 'text/html' }, { name: 'screen.png', data: Buffer.from('image-test') }]);
    expect(response.statusCode, response.body).toBe(200); const ticket = response.json();
    const detail = (await request('GET', `/api/tickets/${ticket.id}`, userCookie)).json();
    expect(detail.counts.attachments).toBe(2); const [log, picture] = detail.messages[0].attachments;
    expect(log.mimeType).toBe('text/plain'); expect(log.storageKey).toBeUndefined();
    const url = `/api/tickets/${ticket.id}/attachments/${log.id}`;
    expect((await request('GET', url, '', undefined)).statusCode).toBe(401);
    expect((await request('GET', url, otherCookie)).statusCode).toBe(404);
    expect((await request('GET', url, adminCookie)).statusCode).toBe(403);
    const download = await request('GET', url, userCookie);
    expect(download.body).toBe('a <script>log</script>'); expect(download.headers['content-disposition']).toContain("attachment;"); expect(download.headers['content-disposition']).toContain("filename*=UTF-8''");
    expect(download.headers['x-content-type-options']).toBe('nosniff'); expect(download.headers['cache-control']).toBe('private, no-store'); expect(download.headers['content-security-policy']).toContain('sandbox');
    expect((await request('GET', `/api/tickets/${ticket.id}/attachments/${picture.id}`, userCookie)).headers['content-disposition']).toContain('inline;');
    expect((await request('GET', `/api/tickets/${ticket.id}/attachments/${picture.id}?download=1`, userCookie)).headers['content-disposition']).toContain('attachment;');
    expect((await request('GET', `/api/admin/tickets/${ticket.id}/attachments/${log.id}`, adminCookie)).statusCode).toBe(200);
    const another = await create(); expect((await request('GET', `/api/tickets/${another.id}/attachments/${log.id}`, userCookie)).statusCode).toBe(404);
    const before = storedFiles();
    expect((await request('DELETE', `/api/admin/tickets/${ticket.id}`, userCookie)).statusCode).toBe(403);
    expect((await request('DELETE', `/api/admin/tickets/${ticket.id}`, adminCookie)).statusCode).toBe(200);
    expect(storedFiles()).toBe(before - 2); expect(await db.ticketAttachment.count({ where: { ticketId: ticket.id } })).toBe(0);
  });

  it('accepts attachment replies and cleans up files on validation or closed-ticket failure', async () => {
    const ticket = await create(); const url = `/api/tickets/${ticket.id}`;
    const sent = await upload(`${url}/messages`, userCookie, { content: 'More logs' }, [{ name: 'debug.log', data: 'details' }]);
    expect(sent.statusCode, sent.body).toBe(200);
    expect((await request('GET', url, userCookie)).json().messages.at(-1).attachments).toHaveLength(1);
    await request('PATCH', url, userCookie, { status: 'CLOSED' });
    const before = storedFiles();
    const closed = await upload(`${url}/messages`, userCookie, { content: 'Late upload' }, [{ name: 'late.txt', data: 'discard me' }]);
    expect(closed.statusCode, closed.body).toBe(409); expect(storedFiles()).toBe(before);
    const invalid = await upload('/api/tickets', userCookie, { subject: 'Valid title', content: '', category: 'other' }, [{ name: 'invalid.log', data: 'discard me' }]);
    expect(invalid.statusCode).toBe(400); expect(storedFiles()).toBe(before);
  });

  it('rejects executable types, too many files and oversized uploads without keeping partial files', async () => {
    const before = storedFiles(); const fields = { subject: 'Attachment limits', content: 'Test', category: 'other' };
    for (const name of ['danger.svg', 'danger.html', 'danger.exe']) {
      const result = await upload('/api/tickets', otherCookie, fields, [{ name: 'first.txt', data: 'first' }, { name, data: 'bad' }]);
      expect(result.statusCode, result.body).toBe(400); expect(storedFiles()).toBe(before);
    }
    const count = await upload('/api/tickets', otherCookie, fields, Array.from({ length: 6 }, (_, i) => ({ name: `file${i}.txt`, data: 'test' })));
    expect(count.statusCode, count.body).toBe(400); expect(storedFiles()).toBe(before);
    const size = await upload('/api/tickets', otherCookie, fields, [{ name: 'big.log', data: Buffer.alloc(10 * 1024 * 1024 + 1, 97) }]);
    expect(size.statusCode, size.body).toBe(400); expect(storedFiles()).toBe(before);
  });

  it('rejects daily quota excess and still allows messages without attachments', async () => {
    const ticket = await create(); const message = await db.ticketMessage.findFirstOrThrow({ where: { ticketId: ticket.id } });
    const quota = await db.ticketAttachment.create({ data: { ticketId: ticket.id, messageId: message.id, fileName: 'quota.txt', mimeType: 'text/plain', size: 200 * 1024 * 1024, storageKey: 'tickets/test-quota' } });
    const before = storedFiles();
    const response = await upload(`/api/tickets/${ticket.id}/messages`, userCookie, { content: 'Over quota' }, [{ name: 'extra.log', data: 'one more' }]);
    expect(response.statusCode).toBe(409); expect(storedFiles()).toBe(before);
    expect((await request('POST', `/api/tickets/${ticket.id}/messages`, userCookie, { content: 'Without files' })).statusCode).toBe(200);
    await db.ticketAttachment.delete({ where: { id: quota.id } });
  });

  it('enforces the active-ticket limit on creation and reopening', async () => {
    await db.ticket.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ userId: otherId, subject: `Quota ticket ${i}` })) });
    const response = await request('POST', '/api/tickets', otherCookie, { subject: 'Over active limit', content: 'Not created' });
    expect(response.statusCode, response.body).toBe(409);
    const closed = await db.ticket.create({ data: { userId: otherId, subject: 'Closed ticket', status: 'CLOSED', closedAt: new Date() } });
    expect((await request('PATCH', `/api/tickets/${closed.id}`, otherCookie, { status: 'OPEN' })).statusCode).toBe(409);
    expect((await request('GET', '/api/tickets/stats', otherCookie)).json()).toMatchObject({ OPEN: 20, CLOSED: 1 });
  });

  it('keeps history usable while submission is disabled and rejects admin customer operations', async () => {
    const ticket = await create(); await settings.updateSettings({ allowTickets: false });
    expect((await request('POST', '/api/tickets', userCookie, { subject: 'Disabled', content: 'No' })).statusCode).toBe(403);
    expect((await request('GET', `/api/tickets/${ticket.id}`, userCookie)).statusCode).toBe(200);
    expect((await request('POST', `/api/tickets/${ticket.id}/messages`, userCookie, { content: 'History reply' })).statusCode).toBe(200);
    expect((await request('GET', '/api/tickets/stats', adminCookie)).statusCode).toBe(403);
    expect((await request('GET', '/api/admin/tickets/stats', userCookie)).statusCode).toBe(403);
    expect((await request('POST', '/api/admin/tickets', adminCookie, { subject: 'Admin create', content: 'No' })).statusCode).toBe(404);
  });
});

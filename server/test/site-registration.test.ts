import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';
import { loginLanding } from '../src/shared/index.ts';

describe('site settings and registration', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let settings: typeof import('../src/lib/settings.ts');
  let mailer: typeof import('../src/services/mail/mailer.ts');
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let otherCookie: string;
  const delivered: { to: string; subject: string; html: string; text: string }[] = [];
  const password = 'test-password-123';
  const request = (options: string | { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; headers?: Record<string, string>; payload?: object; remoteAddress?: string }) =>
    app.inject(typeof options === 'string' ? { url: options, headers: { 'x-requested-with': 'XMLHttpRequest' } } : { ...options, headers: { 'x-requested-with': 'XMLHttpRequest', ...options.headers } });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-site-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-site-registration-secret-12345', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    settings = await import('../src/lib/settings.ts');
    mailer = await import('../src/services/mail/mailer.ts');
    mailer.setMailCapture((mail) => delivered.push(mail));
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const [username, role] of [['admin', 'ADMIN'], ['member', 'USER'], ['other', 'USER']] as const) await db.user.create({ data: { username, email: `${username}@example.com`, role, passwordHash: hash, emailVerifiedAt: new Date() } });
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await request({ method: 'POST', url: '/api/auth/login', payload: { account, password } });
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('admin'); userCookie = await login('member'); otherCookie = await login('other');
  }, 60_000);
  afterAll(async () => {
    mailer?.setMailCapture(null);
    await app?.close(); await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-site-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('stores registration controls, validates bonus amounts and protects settings', async () => {
    expect((await request({ method: 'PUT', url: '/api/admin/settings', payload: { signupBonus: 20 } })).statusCode).toBe(401);
    expect((await request({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: userCookie }, payload: { signupBonus: 20 } })).statusCode).toBe(403);
    for (const signupBonus of [-1, 1.001, 10001]) expect((await request({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: { signupBonus } })).statusCode).toBe(400);
    const response = await request({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload: { siteName: 'Test Cloud', allowRegister: true, requireEmailVerification: true, allowTickets: true, signupBonus: 12.5 } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requireEmailVerification: true, signupBonus: 12.5, icon: null });
    expect((await request('/api/public/config')).json()).toMatchObject({ siteName: 'Test Cloud', requireEmailVerification: true, signupBonus: 12.5 });
  });

  it('requires verification, consumes links once and credits the bonus only once', async () => {
    const payload = { email: 'new@example.com', username: 'newmember', password };
    const response = await request({ method: 'POST', url: '/api/auth/register', payload });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ needVerify: true, mailSent: true }); expect(response.cookies).toHaveLength(0);
    const user = await db.user.findUniqueOrThrow({ where: { email: payload.email } });
    expect(user.emailVerifiedAt).toBeNull(); expect(user.balance.toString()).toBe('12.5');
    const rejected = await request({ method: 'POST', url: '/api/auth/login', payload: { account: payload.email, password } });
    expect(rejected.statusCode).toBe(403); expect(rejected.json().error).toBe('EMAIL_NOT_VERIFIED');
    const token = /#token=([A-Za-z0-9_-]+)/.exec(delivered.find((mail) => mail.to === payload.email)!.text)![1]!;
    expect((await request({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })).statusCode).toBe(200);
    expect((await request({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })).statusCode).toBe(400);
    expect((await request({ method: 'POST', url: '/api/auth/login', payload: { account: payload.email, password } })).statusCode).toBe(200);
    expect((await request({ method: 'POST', url: '/api/auth/register', payload })).statusCode).toBe(409);
    expect(await db.balanceLog.count({ where: { userId: user.id, type: 'ADJUST' } })).toBe(1);
  });

  it('rejects expired verification links and throttles resends without disclosing accounts', async () => {
    const email = 'expired@example.com';
    expect((await request({ method: 'POST', url: '/api/auth/register', payload: { email, username: 'expiredmember', password } })).statusCode).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const token = /#token=([A-Za-z0-9_-]+)/.exec(delivered.find((mail) => mail.to === email)!.text)![1]!;
    await db.emailVerificationToken.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request({ method: 'POST', url: '/api/auth/verify-email', payload: { token } })).statusCode).toBe(400);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
    const before = delivered.length;
    const known = await request({ method: 'POST', url: '/api/auth/resend-verification', payload: { email } });
    const unknown = await request({ method: 'POST', url: '/api/auth/resend-verification', payload: { email: 'absent@example.com' } });
    expect(known.json()).toEqual(unknown.json()); expect(delivered).toHaveLength(before);
  });

  it('credits trusted OAuth sign-ups using the same registration transaction', async () => {
    const { createRegisteredUser } = await import('../src/services/registration.ts');
    const user = await createRegisteredUser({ email: 'oauth@example.com', username: 'oauthmember', passwordHash: 'oauth$test', emailVerifiedAt: new Date() }, await settings.getSettings());
    expect(user.balance.toString()).toBe('12.5');
    expect(await db.balanceLog.count({ where: { userId: user.id } })).toBe(1);
  });

  it('keeps existing tickets usable when submissions are disabled and checks ownership', async () => {
    const created = await request({ method: 'POST', url: '/api/tickets', headers: { cookie: userCookie }, payload: { subject: 'Network issue', content: 'Please help' } });
    expect(created.statusCode).toBe(200); const id = created.json().id;
    for (const [method, url, payload] of [['GET', `/api/tickets/${id}`, undefined], ['POST', `/api/tickets/${id}/messages`, { content: 'not allowed' }], ['PATCH', `/api/tickets/${id}`, { status: 'CLOSED' }]] as const) expect((await request({ method, url, headers: { cookie: otherCookie }, payload })).statusCode).toBe(404);
    expect((await request({ url: '/api/tickets', headers: { cookie: otherCookie } })).json().total).toBe(0);
    await settings.updateSettings({ allowTickets: false });
    expect((await request({ method: 'POST', url: '/api/tickets', headers: { cookie: userCookie }, payload: { subject: 'New', content: 'New issue' } })).statusCode).toBe(403);
    expect((await request({ method: 'POST', url: `/api/tickets/${id}/messages`, headers: { cookie: userCookie }, payload: { content: 'More details' } })).statusCode).toBe(200);
    expect((await request({ method: 'POST', url: `/api/admin/tickets/${id}/messages`, headers: { cookie: adminCookie }, payload: { content: 'Admin reply' } })).statusCode).toBe(200);
    expect((await request({ method: 'PATCH', url: `/api/tickets/${id}`, headers: { cookie: userCookie }, payload: { status: 'CLOSED' } })).statusCode).toBe(200);
    expect((await request({ method: 'POST', url: `/api/tickets/${id}/messages`, headers: { cookie: userCookie }, payload: { content: 'Closed reply' } })).statusCode).toBe(409);
    expect((await request({ method: 'PATCH', url: `/api/tickets/${id}`, headers: { cookie: userCookie }, payload: { status: 'OPEN' } })).statusCode).toBe(200);
    expect((await request({ url: `/api/admin/tickets/${id}`, headers: { cookie: adminCookie } })).json().messages).toHaveLength(3);
  });

  it('restricts console APIs to ordinary users while preserving shared account and management APIs', async () => {
    const consolePaths = ['/api/dashboard', '/api/store/plans', '/api/store/images', '/api/instances', '/api/ports', '/api/sites', '/api/snapshots', '/api/tasks', '/api/billing/summary', '/api/billing/logs', '/api/billing/orders', '/api/payments', '/api/payments/options', '/api/tickets', '/api/tokens', '/api/realname'];
    for (const url of consolePaths) {
      expect((await request(url)).statusCode, url).toBe(401);
      expect((await request({ url, headers: { cookie: adminCookie } })).statusCode, url).toBe(403);
      expect((await request({ url, headers: { cookie: userCookie } })).statusCode, url).toBe(200);
    }
    for (const url of ['/api/store/orders', '/api/payments', '/api/billing/redeem', '/api/tickets', '/api/tokens', '/api/realname', '/api/realname/check']) {
      expect((await request({ method: 'POST', url, headers: { cookie: adminCookie }, payload: {} })).statusCode, url).toBe(403);
    }
    for (const url of ['/api/admin/settings', '/api/admin/users', '/api/admin/instances', '/api/admin/tickets']) {
      expect((await request({ url, headers: { cookie: adminCookie } })).statusCode, url).toBe(200);
      expect((await request({ url, headers: { cookie: userCookie } })).statusCode, url).toBe(403);
    }
    expect((await request({ method: 'POST', url: '/api/admin/tickets', headers: { cookie: adminCookie }, payload: { subject: 'Admin ticket', content: 'No customer submissions for administrators' } })).statusCode).toBe(404);
    for (const url of ['/api/auth/me', '/api/auth/sessions', '/api/auth/2fa', '/api/auth/oauth/accounts', '/api/announcements', '/api/messages']) {
      expect((await request({ url, headers: { cookie: adminCookie } })).statusCode, url).toBe(200);
    }
  });

  it('uses separate instance management endpoints and keeps instance ownership checks', async () => {
    const member = await db.user.findUniqueOrThrow({ where: { username: 'member' } });
    const node = await db.node.create({ data: { name: 'Access test node', region: 'Test', endpoint: 'mock://access-test' } });
    const instance = await db.instance.create({ data: {
      name: 'access-test', hostname: 'access-test', userId: member.id, nodeId: node.id, type: 'LXC_NAT', status: 'STOPPED',
      cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, traffic: 100, trafficMode: 'BOTH',
      overLimitAction: 'THROTTLE', throttleRate: 1, portLimit: 5, siteLimit: 5, snapshotLimit: 5,
      trafficAnchorDay: 1, trafficResetAt: new Date(), billingCycle: 'MONTHLY', price: 10, expiresAt: new Date(Date.now() + 86400_000),
    } });
    const customer = `/api/instances/${instance.id}`;
    const management = `/api/admin/instances/${instance.id}`;
    for (const suffix of ['', '/metrics', '/traffic', '/credentials', '/tasks', '/ports', '/sites', '/volumes', '/snapshots']) {
      expect((await request({ url: customer + suffix, headers: { cookie: adminCookie } })).statusCode, suffix).toBe(403);
      expect((await request({ url: customer + suffix, headers: { cookie: userCookie } })).statusCode, suffix).toBe(200);
      expect((await request({ url: customer + suffix, headers: { cookie: otherCookie } })).statusCode, suffix).toBe(404);
      expect((await request({ url: management + suffix, headers: { cookie: adminCookie } })).statusCode, suffix).toBe(200);
      expect((await request({ url: management + suffix, headers: { cookie: userCookie } })).statusCode, suffix).toBe(403);
    }
    for (const suffix of ['/power', '/reinstall', '/reset-password', '/renew', '/ports', '/sites', '/snapshots', '/volumes']) {
      expect((await request({ method: 'POST', url: customer + suffix, headers: { cookie: adminCookie }, payload: {} })).statusCode, suffix).toBe(403);
      if (suffix !== '/renew') expect((await request({ method: 'POST', url: management + suffix, headers: { cookie: userCookie }, payload: {} })).statusCode, suffix).toBe(403);
    }
    for (const method of ['PATCH', 'DELETE'] as const) expect((await request({ method, url: customer, headers: { cookie: adminCookie }, payload: {} })).statusCode).toBe(403);
    expect((await request({ url: `/api/%69nstances/${instance.id}`, headers: { cookie: adminCookie } })).statusCode).toBe(403);
    const powered = await request({ method: 'POST', url: management + '/power', headers: { cookie: adminCookie }, payload: { action: 'start' } });
    expect(powered.statusCode, powered.body).toBe(200);
    expect(powered.json().type).toBe('START');
    const updated = await request({ method: 'PATCH', url: management, headers: { cookie: adminCookie }, payload: { hostname: 'managed-host', memory: 1024 } });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ hostname: 'managed-host', memory: 1024, user: { id: member.id } });
    expect((await request({ method: 'PATCH', url: management, headers: { cookie: userCookie }, payload: { hostname: 'unauthorized' } })).statusCode).toBe(403);
    expect((await request({ method: 'POST', url: management + '/renew', headers: { cookie: adminCookie }, payload: { periods: 1 } })).statusCode).toBe(404);
  });

  it('edits port mapping notes only on the owning instance', async () => {
    const instance = await db.instance.findFirstOrThrow({ where: { name: 'access-test' } });
    const mapping = await db.portMapping.create({ data: { instanceId: instance.id, nodeId: instance.nodeId, publicPort: 20022, privatePort: 22 } });
    const url = `/api/instances/${instance.id}/ports/${mapping.id}`;
    const edited = await request({ method: 'PATCH', url, headers: { cookie: userCookie }, payload: { description: '  SSH  ' } });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(edited.json()).toMatchObject({ id: mapping.id, description: 'SSH', publicPort: 20022 });
    expect((await request({ method: 'PATCH', url, headers: { cookie: otherCookie }, payload: { description: 'x' } })).statusCode).toBe(404);
    expect((await request({ method: 'PATCH', url: `/api/instances/${instance.id}/ports/${mapping.id + 999}`, headers: { cookie: userCookie }, payload: { description: 'x' } })).statusCode).toBe(404);
    expect((await request({ method: 'PATCH', url, headers: { cookie: userCookie }, payload: { description: 'x'.repeat(65) } })).statusCode).toBe(400);
    const cleared = await request({ method: 'PATCH', url: `/api/admin/instances/${instance.id}/ports/${mapping.id}`, headers: { cookie: adminCookie }, payload: { description: '' } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((await db.portMapping.findUniqueOrThrow({ where: { id: mapping.id } })).description).toBeNull();
  });

  it('keeps impersonation within the effective user role and returns to administrator permissions', async () => {
    const member = await db.user.findUniqueOrThrow({ where: { username: 'member' } });
    const response = await request({ method: 'POST', url: `/api/admin/users/${member.id}/impersonate`, headers: { cookie: adminCookie } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().user).toMatchObject({ role: 'USER', impersonatedBy: { username: 'admin' } });
    const cookie = response.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    expect((await request({ url: '/api/dashboard', headers: { cookie } })).statusCode).toBe(200);
    expect((await request({ url: '/api/admin/settings', headers: { cookie } })).statusCode).toBe(403);
    const restored = await request({ method: 'POST', url: '/api/auth/stop-impersonate', headers: { cookie } });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json().user.role).toBe('ADMIN');
    const restoredCookie = restored.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    expect((await request({ url: '/api/dashboard', headers: { cookie: restoredCookie } })).statusCode).toBe(403);
    expect((await request({ url: '/api/admin/settings', headers: { cookie: restoredCookie } })).statusCode).toBe(200);
  });

  it('keeps password and OAuth login redirects within the role-specific backend', () => {
    expect(loginLanding('ADMIN', '/billing?topup=1')).toBe('/admin');
    expect(loginLanding('ADMIN', '/store?plan=1')).toBe('/admin');
    expect(loginLanding('ADMIN', '/admin/settings?tab=mail')).toBe('/admin/settings?tab=mail');
    expect(loginLanding('USER', '/admin/settings')).toBe('/dashboard');
    expect(loginLanding('USER', '/instances/1?tab=monitor')).toBe('/instances/1?tab=monitor');
    expect(loginLanding('ADMIN', '/admin/../store')).toBe('/admin');
    for (const next of ['//example.com', '/\\example.com', '/login', 'https://example.com', '/%61dmin/settings']) {
      expect(loginLanding('USER', next)).toBe('/dashboard');
    }
  });

  it('encrypts SMTP passwords and preserves saved passwords when the form is blank', async () => {
    const body = { enabled: true, host: 'smtp.example.com', port: 587, secure: false, user: 'test', password: 'smtp-test-secret', fromName: 'Cloud', fromEmail: 'cloud@example.com' };
    const response = await request({ method: 'PUT', url: '/api/admin/settings/mail', headers: { cookie: adminCookie }, payload: body });
    expect(response.statusCode).toBe(200); expect(response.body).not.toContain(body.password); expect(response.json().hasPassword).toBe(true);
    const encrypted = (await settings.getSetting('mail')).passwordEnc; expect(encrypted).not.toBe(body.password);
    expect((await request({ method: 'PUT', url: '/api/admin/settings/mail', headers: { cookie: adminCookie }, payload: { ...body, password: '' } })).statusCode).toBe(200);
    expect((await settings.getSetting('mail')).passwordEnc).toBe(encrypted);
  });

  it('tests unsaved SMTP settings, defaults to the administrator and sends branded multipart content', async () => {
    const before = await settings.getSetting('mail');
    const draft = { enabled: false, host: 'draft.smtp.example.com', port: 465, secure: true, user: 'draft-user', password: 'draft-secret', fromName: 'Draft sender', fromEmail: 'sender@example.com' };
    const self = await request({ method: 'POST', url: '/api/admin/settings/mail/test', headers: { cookie: adminCookie }, payload: draft });
    expect(self.statusCode, self.body).toBe(200);
    expect(self.json()).toEqual({ ok: true, to: 'admin@example.com' });
    const sent = delivered.at(-1)!;
    expect(sent.to).toBe('admin@example.com');
    expect(sent.subject).toContain('Test Cloud');
    expect(sent.html).toContain('<table role="presentation"');
    expect(sent.html).toContain('Test Cloud');
    expect(sent.html).toContain('/logo.png');
    expect(sent.text).toContain('SMTP');
    expect(sent.text).not.toContain('<table');
    expect(await settings.getSetting('mail')).toEqual(before);
    const recipient = await request({ method: 'POST', url: '/api/admin/settings/mail/test', headers: { cookie: adminCookie }, payload: { ...draft, password: '', to: ' recipient@example.com ' } });
    expect(recipient.statusCode, recipient.body).toBe(200);
    expect(recipient.json().to).toBe('recipient@example.com');
    expect(delivered.at(-1)!.to).toBe('recipient@example.com');
    expect(await settings.getSetting('mail')).toEqual(before);
    const invalid = await request({ method: 'POST', url: '/api/admin/settings/mail/test', headers: { cookie: adminCookie }, payload: { ...draft, to: 'invalid' } });
    expect(invalid.statusCode).toBe(400);
    expect((await request({ method: 'POST', url: '/api/admin/settings/mail/test', headers: { cookie: userCookie }, payload: draft, remoteAddress: '127.0.0.2' })).statusCode).toBe(403);
  });

  it('checks SMTP before sending and preserves settings when connection verification fails', async () => {
    const before = await settings.getSetting('mail');
    const count = delivered.length;
    const verify = vi.spyOn(mailer, 'verifyMailConnection').mockRejectedValueOnce(new Error('SMTP authentication failed'));
    try {
      const response = await request({ method: 'POST', url: '/api/admin/settings/mail/test', headers: { cookie: adminCookie }, remoteAddress: '127.0.0.3', payload: { enabled: false, host: 'draft.example.com', port: 587, secure: false, user: 'test', password: '', fromName: '', fromEmail: 'sender@example.com' } });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().message).toContain('SMTP authentication failed');
      expect(verify).toHaveBeenCalledOnce();
      expect(delivered).toHaveLength(count);
      expect(await settings.getSetting('mail')).toEqual(before);
    } finally {
      verify.mockRestore();
    }
  });

  it('stores site icons locally and refuses private image URLs', async () => {
    await settings.setSetting('siteIcon', { mime: 'image/svg+xml', data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>').toString('base64'), source: 'https://example.com/logo.svg', updatedAt: new Date().toISOString() });
    const icon = await request('/api/site/icon'); expect(icon.statusCode).toBe(200); expect(icon.headers['content-security-policy']).toContain('sandbox');
    const before = (await settings.getSetting('siteIcon')).data;
    expect((await request({ method: 'PUT', url: '/api/admin/settings/icon', headers: { cookie: adminCookie }, payload: { url: 'http://127.0.0.1/logo.png' } })).statusCode).toBe(400);
    expect((await settings.getSetting('siteIcon')).data).toBe(before);
    expect((await request({ method: 'DELETE', url: '/api/admin/settings/icon', headers: { cookie: adminCookie } })).json().icon).toBeNull();
  });

  it('protects operations settings and validates maintenance schedules', async () => {
    for (const name of ['maintenance','legal']) {
      expect((await request(`/api/admin/settings/${name}`)).statusCode).toBe(401);
      expect((await request({ url: `/api/admin/settings/${name}`, headers: { cookie: userCookie } })).statusCode).toBe(403);
    }
    const payload = { ...settings.settingDefaults.maintenance, title: 'Database upgrade', autoSchedule: true };
    expect((await request({ method: 'PUT', url: '/api/admin/settings/maintenance', headers: { cookie: adminCookie }, payload })).statusCode).toBe(400);
    expect((await request({ method: 'PUT', url: '/api/admin/settings/maintenance', headers: { cookie: adminCookie }, payload: { ...payload, startAt: '2026-10-18T10:00:00Z', endAt: '2026-10-18T09:00:00Z' } })).statusCode).toBe(400);
    expect((await request({ method: 'PUT', url: '/api/admin/settings/maintenance', headers: { cookie: adminCookie }, payload: { ...payload, autoSchedule: false, allowEmails: ['not an email'] } })).statusCode).toBe(400);
    expect((await settings.getSetting('maintenance')).enabled).toBe(false);
  });

  it('enforces notice, read only and full scopes without blocking administrators or support', async () => {
    const base = { ...settings.settingDefaults.maintenance, enabled: true, title: 'Upgrade' };
    try {
      await settings.setSetting('maintenance', { ...base, scope: 'NOTICE' });
      expect((await request({ method: 'POST', url: '/api/store/orders', headers: { cookie: userCookie }, payload: {} })).statusCode).toBe(400);
      await settings.setSetting('maintenance', { ...base, scope: 'READONLY' });
      expect((await request({ url: '/api/instances', headers: { cookie: userCookie } })).statusCode).toBe(200);
      for (const url of ['/api/store/orders','/api/%73tore/orders','/api/billing/redeem']) {
        const response = await request({ method: 'POST', url, headers: { cookie: userCookie }, payload: {} });
        expect(response.statusCode,url).toBe(503); expect(response.json().error).toBe('MAINTENANCE');
      }
      await settings.updateSettings({ allowTickets: true });
      expect((await request({ method: 'POST', url: '/api/tickets', headers: { cookie: userCookie }, payload: { subject: 'Support during maintenance', content: 'Please help' } })).statusCode).toBe(200);
      expect((await request({ url: '/api/admin/users', headers: { cookie: adminCookie } })).statusCode).toBe(200);
      await settings.setSetting('maintenance', { ...base, scope: 'FULL' });
      expect((await request({ url: '/api/instances', headers: { cookie: userCookie } })).statusCode).toBe(503);
      for (const url of ['/api/auth/me','/api/public/config','/api/public/legal/terms','/api/health']) expect((await request({ url, headers: { cookie: userCookie } })).statusCode).toBe(200);
      expect((await request({ url: '/api/admin/settings', headers: { cookie: adminCookie } })).statusCode).toBe(200);
      const config = (await request('/api/public/config')).json();
      expect(config.maintenance.state).toBe('active'); expect(config.maintenance).not.toHaveProperty('allowEmails');
    } finally { await settings.setSetting('maintenance', settings.settingDefaults.maintenance); }
  });

  it('uses the actual account for allow lists, including API tokens and impersonation', async () => {
    const member = await db.user.findUniqueOrThrow({ where: { username: 'member' } });
    const { sha256 } = await import('../src/lib/crypto.ts');
    const token = 'pd_test_maintenance_token_123456789';
    await db.apiToken.create({ data: { userId: member.id, name: 'maintenance test', tokenHash: sha256(token), prefix: token.slice(0,10) } });
    try {
      await settings.setSetting('maintenance', { ...settings.settingDefaults.maintenance, enabled: true, scope: 'FULL' });
      expect((await request({ url: '/api/instances', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(503);
      const impersonated = await request({ method: 'POST', url: `/api/admin/users/${member.id}/impersonate`, headers: { cookie: adminCookie } });
      const cookie = impersonated.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
      expect((await request({ url: '/api/instances', headers: { cookie } })).statusCode).toBe(503);
      expect((await request({ method: 'POST', url: '/api/auth/stop-impersonate', headers: { cookie } })).statusCode).toBe(200);
      await settings.setSetting('maintenance', { allowEmails: ['member@example.com'] });
      expect((await request({ url: '/api/instances', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
      expect((await request({ url: '/api/public/config', headers: { cookie: userCookie } })).json().maintenance.exempt).toBe(true);
      expect((await request({ url: '/api/instances', headers: { cookie: otherCookie } })).statusCode).toBe(503);
    } finally { await settings.setSetting('maintenance', settings.settingDefaults.maintenance); }
  });

  it('allows advance notice, restores access at the end and expires maintenance announcements', async () => {
    const startAt = new Date(Date.now()+3600_000).toISOString(), endAt = new Date(Date.now()+7200_000).toISOString();
    try {
      const payload = { ...settings.settingDefaults.maintenance, title: 'Scheduled upgrade', scope: 'FULL', autoSchedule: true, startAt, endAt, allowEmails: [' MEMBER@example.com ', 'member@example.com'], announce: true };
      const response = await request({ method: 'PUT', url: '/api/admin/settings/maintenance', headers: { cookie: adminCookie }, payload });
      expect(response.statusCode,response.body).toBe(200);
      expect(response.json().allowEmails).toEqual(['member@example.com']);
      expect((await request('/api/public/config')).json().maintenance.state).toBe('upcoming');
      expect((await request({ url: '/api/instances', headers: { cookie: otherCookie } })).statusCode).toBe(200);
      const a = await db.announcement.findFirstOrThrow({ where: { title: { contains: 'Scheduled upgrade' } } });
      expect(a.expiresAt!.getTime()).toBe(Date.parse(endAt)+86400_000);
      await db.announcement.update({ where: { id: a.id }, data: { expiresAt: new Date(Date.now()-1000) } });
      expect((await request({ url: '/api/announcements', headers: { cookie: otherCookie } })).json().some((item: { id: number }) => item.id === a.id)).toBe(false);
      await settings.setSetting('maintenance', { startAt: new Date(Date.now()-7200_000).toISOString(), endAt: new Date(Date.now()-1000).toISOString() });
      expect((await request('/api/public/config')).json().maintenance).toBeNull();
      expect((await request({ url: '/api/instances', headers: { cookie: otherCookie } })).statusCode).toBe(200);
    } finally { await settings.setSetting('maintenance', settings.settingDefaults.maintenance); }
  });

  it('publishes legal documents, preserves versions for unchanged text and restores built-in content', async () => {
    const initial = (await request({ url: '/api/admin/settings/legal', headers: { cookie: adminCookie } })).json();
    const content = '## Service\n\nWelcome to {{站点名称}} at {{网址}}.';
    const payload = { terms: { content }, privacy: { content: '' }, requireAgree: true, announce: true };
    const response = await request({ method: 'PUT', url: '/api/admin/settings/legal', headers: { cookie: adminCookie }, payload });
    expect(response.statusCode,response.body).toBe(200); expect(response.json().changed).toEqual(['terms']);
    const version = response.json().terms.updatedAt;
    const published = (await request('/api/public/legal/terms')).json();
    expect(published.content).toContain('Test Cloud'); expect(published.content).not.toContain('{{');
    expect((await request('/api/public/config')).json().legalRequireAgree).toBe(true);
    const count = await db.announcement.count();
    const unchanged = await request({ method: 'PUT', url: '/api/admin/settings/legal', headers: { cookie: adminCookie }, payload: { ...payload, terms: { content: `  ${content.replaceAll('\n','\r\n')}  ` } } });
    expect(unchanged.json().terms.updatedAt).toBe(version); expect(unchanged.json().changed).toEqual([]); expect(await db.announcement.count()).toBe(count);
    const restored = await request({ method: 'PUT', url: '/api/admin/settings/legal', headers: { cookie: adminCookie }, payload: { ...payload, terms: { content: initial.defaults.terms }, announce: false } });
    expect(restored.json().terms.custom).toBe(false); expect((await settings.getSetting('legal')).terms.content).toBe('');
    expect((await request('/api/public/legal/terms')).json().content).toContain('Incus');
  });

  it('requires explicit acceptance before registration and logs the agreed versions', async () => {
    await settings.updateSettings({ requireEmailVerification: false });
    const payload = { email: 'legalmember@example.com', username: 'legalmember', password };
    const rejected = await request({ method: 'POST', url: '/api/auth/register', remoteAddress: '127.0.1.1', payload });
    expect(rejected.statusCode,rejected.body).toBe(400); expect(await db.user.count({ where: { email: payload.email } })).toBe(0);
    const accepted = await request({ method: 'POST', url: '/api/auth/register', remoteAddress: '127.0.1.1', payload: { ...payload, agreeTerms: true } });
    expect(accepted.statusCode,accepted.body).toBe(200);
    const user = await db.user.findUniqueOrThrow({ where: { email: payload.email } });
    expect((await db.activityLog.findFirstOrThrow({ where: { userId: user.id, action: 'auth.register' } })).detail).toContain('已勾选同意');
    await settings.setSetting('legal', settings.settingDefaults.legal);
  });

  it('sends password resets without disclosing accounts, consumes links once and revokes sessions', async () => {
    await settings.setSetting('mail', { enabled: true, host: 'smtp.example.com', fromEmail: 'panel@example.com' });
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    const user = await db.user.create({ data: { email: 'reset@example.com', username: 'resetmember', passwordHash: hash, emailVerifiedAt: new Date(), locale: 'en' } });
    const login = await request({ method: 'POST', url: '/api/auth/login', payload: { account: user.username, password }, remoteAddress: '127.0.2.1' });
    const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
    const known = await request({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: ' RESET@example.com ' } });
    const unknown = await request({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'absent-reset@example.com' } });
    expect(known.json()).toEqual(unknown.json());
    const mail = delivered.findLast((mail) => mail.to === user.email)!;
    expect(mail.subject).toContain('Reset');
    const token = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect((await db.passwordResetToken.findFirstOrThrow({ where: { userId: user.id } })).tokenHash).not.toBe(token);
    const before = delivered.length;
    await request({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: user.email } });
    expect(delivered).toHaveLength(before);
    const resets = await Promise.all([0,1].map(() => request({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password: 'new-password-456' } })));
    expect(resets.map((response) => response.statusCode).sort()).toEqual([200,400]);
    expect((await request({ url: '/api/auth/me', headers: { cookie } })).json().user).toBeNull();
    expect((await request({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password } })).statusCode).toBe(400);
    expect((await request({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.2.2', payload: { account: user.username, password } })).statusCode).toBe(401);
    expect((await request({ method: 'POST', url: '/api/auth/login', remoteAddress: '127.0.2.2', payload: { account: user.username, password: 'new-password-456' } })).statusCode).toBe(200);
  });

  it('rejects expired reset links and disables reset delivery when SMTP is off', async () => {
    const { sha256 } = await import('../src/lib/crypto.ts');
    const user = await db.user.findUniqueOrThrow({ where: { username: 'resetmember' } });
    const token = 'expired_password_reset_token_12345';
    await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now()-1000) } });
    expect((await request({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password } })).statusCode).toBe(400);
    await settings.setSetting('mail', { enabled: false });
    const before = delivered.length;
    expect((await request({ method: 'POST', url: '/api/auth/forgot-password', payload: { email: 'member@example.com' } })).json()).toEqual({ ok: true });
    expect(delivered).toHaveLength(before);
    await settings.setSetting('mail', { enabled: true });
  });

  it('notifies the other party on ticket messages without mailing rejected requests', async () => {
    const created = await request({ method: 'POST', url: '/api/tickets', headers: { cookie: userCookie }, payload: { subject: 'Email test', content: '<script>ticket</script>' } });
    const id = created.json().id;
    await vi.waitFor(() => expect(delivered.findLast((mail) => mail.to === 'admin@example.com')?.text).toContain('Email test'));
    const message = delivered.findLast((mail) => mail.to === 'admin@example.com')!;
    expect(message.html).not.toContain('<script>ticket</script>'); expect(message.text).toContain(`/admin/tickets/${id}`);
    await request({ method: 'POST', url: `/api/admin/tickets/${id}/messages`, headers: { cookie: adminCookie }, payload: { content: 'Support reply' } });
    await vi.waitFor(() => expect(delivered.findLast((mail) => mail.to === 'member@example.com')?.text).toContain('Support reply'));
    expect(delivered.findLast((mail) => mail.to === 'member@example.com')!.text).toContain(`/tickets/${id}`);
    const before = delivered.length;
    expect((await request({ method: 'POST', url: `/api/tickets/${id}/messages`, headers: { cookie: otherCookie }, payload: { content: 'Unauthorized' } })).statusCode).toBe(404);
    expect(delivered).toHaveLength(before);
  });

  it('honors announcement preferences and verified emails', async () => {
    const { emailAnnouncement } = await import('../src/services/announcements.ts');
    await db.user.update({ where: { username: 'other' }, data: { announceEmail: false } });
    const before = delivered.length;
    await emailAnnouncement({ title: 'Policy update', content: '<b>Updated</b>' }, 'https://panel.example.com');
    const sent = delivered.slice(before);
    expect(sent.some((mail) => mail.to === 'member@example.com')).toBe(true);
    expect(sent.some((mail) => mail.to === 'other@example.com')).toBe(false);
    expect(sent.some((mail) => mail.to === 'expired@example.com')).toBe(false);
    expect(sent.every((mail) => !mail.html.includes('<b>Updated</b>'))).toBe(true);
  });

  it('deduplicates business alerts, respects switches and retries failed delivery', async () => {
    const { sendBusinessNotice } = await import('../src/services/mail/business-mail.ts');
    const user = await db.user.findUniqueOrThrow({ where: { username: 'member' } });
    const before = delivered.length;
    expect(await sendBusinessNotice(user.id,'expiring',{ name: '<unsafe>', time: 'tomorrow' },'test-expiry')).toBe(true);
    expect(await sendBusinessNotice(user.id,'expiring',{ name: '<unsafe>', time: 'tomorrow' },'test-expiry')).toBe(false);
    expect(delivered).toHaveLength(before+1); expect(delivered.at(-1)!.html).not.toContain('<unsafe>');
    await db.user.update({ where: { id: user.id }, data: { alertEmail: false } });
    expect(await sendBusinessNotice(user.id,'released',{ name: 'test' },'test-release')).toBe(false);
    await db.user.update({ where: { id: user.id }, data: { alertEmail: true } });
    const spy = vi.spyOn(mailer,'sendMail').mockRejectedValueOnce(new Error('SMTP unavailable'));
    try { await expect(sendBusinessNotice(user.id,'released',{ name: 'test' },'test-retry')).rejects.toThrow('SMTP unavailable'); } finally { spy.mockRestore(); }
    expect(await sendBusinessNotice(user.id,'released',{ name: 'test' },'test-retry')).toBe(true);
    const { runBusinessMailChecks } = await import('../src/services/mail/business-mail.ts');
    const instance = await db.instance.findFirstOrThrow({ where: { userId: user.id } });
    await db.instance.update({ where: { id: instance.id }, data: { autoRenew: true, expiresAt: new Date(Date.now()+3600_000), provisionedAt: new Date() } });
    const beforeChecks = delivered.length;
    await runBusinessMailChecks({ warn: (message) => { throw new Error(message); } });
    expect(delivered.slice(beforeChecks).some((mail) => mail.text.includes('续费余额不足'))).toBe(true);
    const afterChecks = delivered.length;
    await runBusinessMailChecks({ warn: (message) => { throw new Error(message); } });
    expect(delivered).toHaveLength(afterChecks);
    await db.user.update({ where: { id: user.id }, data: { balanceAlert: false } });
    expect(await sendBusinessNotice(user.id,'lowBalance',{ name: 'test', balance: '0', price: '10' },'disabled-balance')).toBe(false);
    await settings.setSetting('mail', { enabled: false });
  });

  it('restricts registration email domains with an allowlist or a blocklist', async () => {
    const { emailDomainAllowed, normalizeEmailDomain, matchedEmailDomain } = await import('../src/shared/index.ts');
    expect(['@QQ.com', '*.edu.cn', 'gmail.com.', ' .Example.org '].map(normalizeEmailDomain)).toEqual(['qq.com', 'edu.cn', 'gmail.com', 'example.org']);
    expect(matchedEmailDomain('a@Stu.EDU.cn.', ['qq.com', 'edu.cn'])).toBe('edu.cn');
    expect(emailDomainAllowed('a@notedu.cn', { mode: 'ALLOW', domains: ['edu.cn'] })).toBe(false);
    expect(emailDomainAllowed('a@x.com', { mode: 'ALLOW', domains: [] })).toBe(true);
    expect(emailDomainAllowed('a@x.com', { mode: 'OFF', domains: ['qq.com'] })).toBe(true);

    const put = (payload: object) => request({ method: 'PUT', url: '/api/admin/settings', headers: { cookie: adminCookie }, payload });
    const register = (email: string, username: string) =>
      request({ method: 'POST', url: '/api/auth/register', remoteAddress: '10.9.8.7', payload: { email, username, password, agreeTerms: true } });
    try {
      // 白名单：规范化、去重，被更短后缀覆盖的子域名去掉
      const saved = await put({ emailDomainMode: 'ALLOW', emailDomains: ['@QQ.com', '*.edu.cn', 'a.edu.cn', 'gmail.com.', 'qq.com'] });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json()).toMatchObject({ emailDomainMode: 'ALLOW', emailDomains: ['qq.com', 'edu.cn', 'gmail.com'] });
      expect((await request('/api/public/config')).json()).toMatchObject({ emailDomainMode: 'ALLOW', emailDomains: ['qq.com', 'edu.cn', 'gmail.com'] });
      const denied = await register('someone@163.com', 'domainuser1');
      expect(denied.statusCode).toBe(400);
      expect(denied.json().message).toContain('qq.com');
      expect((await register('someone@stu.edu.cn', 'domainuser2')).statusCode).toBe(200);
      expect((await put({ emailDomainMode: 'ALLOW', emailDomains: ['not a domain'] })).statusCode).toBe(400);

      // 黑名单：列表中的后缀（含子域名）不能注册，其他都可以
      await put({ emailDomainMode: 'DENY', emailDomains: ['mailinator.com'] });
      const blocked = await register('x@inbox.mailinator.com', 'domainuser3');
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().message).not.toContain('mailinator');
      expect((await register('x@163.com', 'domainuser4')).statusCode).toBe(200);

      // 不限制：公开配置不返回列表
      await put({ emailDomainMode: 'OFF' });
      expect((await request('/api/public/config')).json()).toMatchObject({ emailDomainMode: 'OFF', emailDomains: [] });
      expect((await register('x@mailinator.com', 'domainuser5')).statusCode).toBe(200);
    } finally {
      await put({ emailDomainMode: 'OFF', emailDomains: [] });
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { nextLocalMidnight, popupDismissed } from '../src/shared/index.ts';
import { dismissPopup, isPopupHidden } from '../../web/src/lib/popup-state.ts';

describe('popup settings and public announcements', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let settings: typeof import('../src/lib/settings.ts');
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let planId: number;
  let productId: number;
  const notice = { enabled: true, title: 'Maintenance notice', content: '**Notice**\nA new announcement.' };
  const promotion = () => ({ enabled: true, title: 'New plan', imageUrl: 'https://example.test/promotion.png', planId });
  const request = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, cookie = adminCookie) => app.inject({ method, url, payload, headers: { cookie, 'x-requested-with': 'XMLHttpRequest' } });
  const publicConfig = async () => {
    const response = await request('GET', '/api/public/config', undefined, '');
    expect(response.statusCode, response.body).toBe(200);
    return response.json();
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-popups-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-popup-secret-1234567890123', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    settings = await import('../src/lib/settings.ts');
    const password = 'popup-test-password-123';
    const passwordHash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const [username, role] of [['popup-admin', 'ADMIN'], ['popup-user', 'USER']] as const) await db.user.create({ data: { username, email: `${username}@example.test`, role, passwordHash, emailVerifiedAt: new Date() } });
    productId = (await db.product.create({ data: { name: 'Test product' } })).id;
    planId = (await db.plan.create({ data: { productId, name: 'Test plan', type: 'LXC_NAT', cpu: 1, memory: 512, disk: 10, bandwidthIn: 100, bandwidthOut: 100, priceMonthly: 20 } })).id;
    app = await (await import('../src/app.ts')).buildApp();
    for (const account of ['popup-admin', 'popup-user']) {
      const response = await request('POST', '/api/auth/login', { account, password }, '');
      expect(response.statusCode, response.body).toBe(200);
      const cookie = response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      if (account === 'popup-admin') adminCookie = cookie; else userCookie = cookie;
    }
  }, 60_000);

  beforeEach(async () => {
    await settings.setSetting('popups', structuredClone(settings.settingDefaults.popups));
    await db.plan.update({ where: { id: planId }, data: { enabled: true } });
    await db.product.update({ where: { id: productId }, data: { enabled: true } });
  });
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-popups-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('defaults to disabled and restricts all settings endpoints to administrators', async () => {
    expect((await publicConfig()).popups).toEqual({ notice: null, promotion: null });
    const data = (await request('GET', '/api/admin/settings/popups')).json();
    expect(data.notice.enabled).toBe(false);
    expect(data.plans).toEqual([{ id: planId, name: 'Test plan', productName: 'Test product' }]);
    for (const [method, url, payload] of [
      ['GET', '/api/admin/settings/popups', undefined],
      ['PUT', '/api/admin/settings/popups/notice', notice],
      ['PUT', '/api/admin/settings/popups/promotion', promotion()],
    ] as const) {
      expect((await request(method, url, payload, '')).statusCode).toBe(401);
      expect((await request(method, url, payload, userCookie)).statusCode).toBe(403);
    }
  });

  it('publishes immediately, preserves the revision on unchanged saves and creates a new revision for changed content', async () => {
    const saved = await request('PUT', '/api/admin/settings/popups/notice', notice);
    expect(saved.statusCode, saved.body).toBe(200);
    const first = saved.json();
    expect(first.revision).toBeTruthy();
    expect((await publicConfig()).popups.notice).toEqual(first);
    expect((await request('PUT', '/api/admin/settings/popups/notice', notice)).json().revision).toBe(first.revision);
    const changed = (await request('PUT', '/api/admin/settings/popups/notice', { ...notice, content: 'Updated content' })).json();
    expect(changed.revision).not.toBe(first.revision);
    expect((await publicConfig()).popups.notice.content).toBe('Updated content');
    const renamed = (await request('PUT', '/api/admin/settings/popups/notice', { ...notice, title: 'New title', content: changed.content })).json();
    expect(renamed.revision).not.toBe(changed.revision);
  });

  it('can pause announcements or clear them without removing notification-center announcements', async () => {
    const first = (await request('PUT', '/api/admin/settings/popups/notice', notice)).json();
    await request('PUT', '/api/admin/settings/popups/notice', { ...notice, enabled: false });
    expect((await publicConfig()).popups.notice).toBeNull();
    const resumed = (await request('PUT', '/api/admin/settings/popups/notice', notice)).json();
    expect(resumed.revision).toBe(first.revision);
    const cleared = (await request('PUT', '/api/admin/settings/popups/notice', { ...notice, content: '  \n ' })).json();
    expect(cleared).toMatchObject({ enabled: false, content: '' });
    expect((await publicConfig()).popups.notice).toBeNull();
    expect(await db.announcement.count()).toBe(0);
  });

  it('saves both popup kinds independently and links only to an available plan', async () => {
    await request('PUT', '/api/admin/settings/popups/notice', notice);
    const saved = await request('PUT', '/api/admin/settings/popups/promotion', promotion());
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await publicConfig()).popups).toMatchObject({ notice, promotion: promotion() });
    expect((await request('PUT', '/api/admin/settings/popups/promotion', promotion())).json().revision).toBe(saved.json().revision);
    const changed = (await request('PUT', '/api/admin/settings/popups/promotion', { ...promotion(), imageUrl: 'https://example.test/new.png' })).json();
    expect(changed.revision).not.toBe(saved.json().revision);
    await db.plan.update({ where: { id: planId }, data: { enabled: false } });
    expect((await publicConfig()).popups.promotion).toBeNull();
    await db.plan.update({ where: { id: planId }, data: { enabled: true } });
    await db.product.update({ where: { id: productId }, data: { enabled: false } });
    expect((await publicConfig()).popups.promotion).toBeNull();
    expect((await request('PUT', '/api/admin/settings/popups/promotion', promotion())).statusCode).toBe(400);
    expect((await request('PUT', '/api/admin/settings/popups/promotion', { ...promotion(), enabled: false })).statusCode).toBe(200);
    const imageOnly = await request('PUT', '/api/admin/settings/popups/promotion', { ...promotion(), planId: null });
    expect(imageOnly.statusCode).toBe(200);
    expect((await publicConfig()).popups.promotion.planId).toBeNull();
  });

  it('rejects oversized notices, unsafe image URLs and unavailable plans without saving them', async () => {
    for (const input of [{ ...notice, content: 'a'.repeat(5001) }, { ...notice, title: 'a'.repeat(101) }]) expect((await request('PUT', '/api/admin/settings/popups/notice', input)).statusCode).toBe(400);
    for (const input of [
      { ...promotion(), imageUrl: 'javascript:alert(1)' }, { ...promotion(), imageUrl: 'data:image/png;base64,abc' },
      { ...promotion(), imageUrl: '//example.test/image.png' }, { ...promotion(), imageUrl: '' },
      { ...promotion(), planId: 999999 }, { ...promotion(), planId: -1 },
    ]) expect((await request('PUT', '/api/admin/settings/popups/promotion', input)).statusCode, JSON.stringify(input)).toBe(400);
    expect((await publicConfig()).popups).toEqual({ notice: null, promotion: null });
  });

  it('preserves both sections when administrators save them concurrently', async () => {
    const responses = await Promise.all([
      request('PUT', '/api/admin/settings/popups/notice', notice),
      request('PUT', '/api/admin/settings/popups/promotion', promotion()),
    ]);
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    expect((await publicConfig()).popups).toMatchObject({ notice, promotion: promotion() });
  });
});

describe('popup dismissal preferences', () => {
  const storage = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, clear: () => data.clear() };
  };
  let local: ReturnType<typeof storage>;
  let session: ReturnType<typeof storage>;
  beforeEach(() => { local = storage(); session = storage(); vi.stubGlobal('localStorage', local); vi.stubGlobal('sessionStorage', session); });
  afterAll(() => vi.unstubAllGlobals());

  it('keeps ordinary close for this visit, including reloads, and isolates accounts and popup kinds', () => {
    dismissPopup('user-1', 'notice', 'revision-1', 'session');
    expect(isPopupHidden('user-1', 'notice', 'revision-1')).toBe(true);
    expect(isPopupHidden('user-2', 'notice', 'revision-1')).toBe(false);
    expect(isPopupHidden('user-1', 'promotion', 'revision-1')).toBe(false);
    session.clear();
    expect(isPopupHidden('user-1', 'notice', 'revision-1')).toBe(false);
  });

  it('hides until local midnight, survives a new visit and displays again the next day', () => {
    const now = new Date(2026, 10, 14, 20, 30);
    dismissPopup('visitor', 'notice', 'revision-1', 'today', now);
    session.clear();
    expect(isPopupHidden('visitor', 'notice', 'revision-1', now.getTime())).toBe(true);
    expect(isPopupHidden('visitor', 'notice', 'revision-1', nextLocalMidnight(now))).toBe(false);
  });

  it('honors permanent dismissal while showing a new revision', () => {
    dismissPopup('visitor', 'notice', 'revision-1', 'forever');
    expect(isPopupHidden('visitor', 'notice', 'revision-1')).toBe(true);
    expect(isPopupHidden('visitor', 'notice', 'revision-2')).toBe(false);
  });

  it('ignores malformed storage and still closes when browser storage is disabled', () => {
    for (const value of [null, 'bad', {}, { revision: 'one', until: 'bad' }, { revision: 'one', until: NaN }]) expect(popupDismissed(value, 'one')).toBe(false);
    const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    vi.stubGlobal('localStorage', blocked); vi.stubGlobal('sessionStorage', blocked);
    dismissPopup('private-test', 'notice', 'revision-1', 'forever');
    expect(isPopupHidden('private-test', 'notice', 'revision-1')).toBe(true);
    expect(isPopupHidden('private-test', 'notice', 'revision-2')).toBe(false);
  });

  it('can dismiss when storage can be read but writes fail because the quota is full', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() { throw new Error('quota exceeded'); } });
    dismissPopup('quota-test', 'notice', 'revision-1', 'forever');
    expect(isPopupHidden('quota-test', 'notice', 'revision-1')).toBe(true);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

describe('managed documents', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let settings: typeof import('../src/lib/settings.ts');
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  const password = 'test-document-password-123';
  const payload = (overrides: Record<string, unknown> = {}) => ({ title: 'Getting started', slug: 'getting-started', content: '## Welcome\n\n{{站点名称}} at {{网址}}', categoryId: 'general', order: 10, published: false, pinned: false, ...overrides });
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: object, cookie = adminCookie) => app.inject({ method, url, payload: body, headers: { 'x-requested-with': 'XMLHttpRequest', ...(cookie ? { cookie } : {}) } });

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-documents-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-documents-secret-12345678', LOG_LEVEL: 'error', COOKIE_SECURE: 'false', PANEL_URL: 'https://docs.example.test' });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    settings = await import('../src/lib/settings.ts');
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const [username, role] of [['admin', 'ADMIN'], ['member', 'USER']] as const) await db.user.create({ data: { username, email: `${username}@example.test`, role, passwordHash: hash, emailVerifiedAt: new Date() } });
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await request('POST', '/api/auth/login', { account, password }, '');
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('admin'); userCookie = await login('member');
  }, 60_000);

  beforeEach(async () => { await settings.setSetting('legal', structuredClone(settings.settingDefaults.legal)); });
  afterAll(async () => {
    await app?.close(); await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-documents-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('preserves existing terms and privacy and restricts management to admins', async () => {
    await settings.setSetting('legal', { terms: { content: 'Original terms', updatedAt: '2026-01-01T00:00:00.000Z' }, privacy: { content: 'Original privacy', updatedAt: '' }, requireAgree: true });
    const response = await request('GET', '/api/admin/documents');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().categories.map((category: { name: string }) => category.name)).toEqual(['常规', '快速开始', '实例管理', '网络配置', '计费相关', '常见问题']);
    expect(response.json()).toMatchObject({ requireAgree: true, documents: [{ id: 'terms', content: 'Original terms' }, { id: 'privacy', content: 'Original privacy' }] });
    expect((await request('GET', '/api/public/legal/terms', undefined, '')).json().content).toBe('Original terms');
    for (const [method, url, body] of [
      ['GET', '/api/admin/documents', undefined], ['POST', '/api/admin/documents', payload()],
      ['PATCH', '/api/admin/documents/settings', { requireAgree: false }],
      ['POST', '/api/admin/documents/categories', { name: 'Private', order: 0 }],
      ['DELETE', '/api/admin/documents/terms', undefined],
    ] as const) {
      expect((await request(method, url, body, '')).statusCode).toBe(401);
      expect((await request(method, url, body, userCookie)).statusCode).toBe(403);
    }
  });

  it('keeps drafts private and supports publishing, sorting, renaming and deletion', async () => {
    const created = await request('POST', '/api/admin/documents', payload());
    expect(created.statusCode, created.body).toBe(200);
    const draft = created.json();
    expect((await request('GET', '/api/public/documents', undefined, '')).json().documents.map((doc: { slug: string }) => doc.slug)).not.toContain(draft.slug);
    expect((await request('GET', '/api/public/documents/getting-started', undefined, '')).statusCode).toBe(404);
    const published = await request('PATCH', `/api/admin/documents/${draft.id}`, payload({ published: true, pinned: true, order: 999 }));
    expect(published.statusCode, published.body).toBe(200);
    const list = (await request('GET', '/api/public/documents', undefined, '')).json();
    expect(list.documents[0]).toMatchObject({ id: draft.id, pinned: true });
    expect(list.documents.every((doc: object) => !('content' in doc))).toBe(true);
    const detail = await request('GET', '/api/public/documents/getting-started', undefined, '');
    expect(detail.json().content).toContain('PaleDove at https://docs.example.test');
    await request('PATCH', `/api/admin/documents/${draft.id}`, payload({ slug: 'quick-start', published: true }));
    expect((await request('GET', '/api/public/documents/getting-started', undefined, '')).statusCode).toBe(404);
    expect((await request('GET', '/api/public/documents/quick-start', undefined, '')).statusCode).toBe(200);
    await request('PATCH', `/api/admin/documents/${draft.id}`, payload({ slug: 'quick-start', published: false }));
    expect((await request('GET', '/api/public/documents/quick-start', undefined, '')).statusCode).toBe(404);
    expect((await request('DELETE', `/api/admin/documents/${draft.id}`)).statusCode).toBe(200);
    expect((await request('GET', '/api/admin/documents')).json().documents).toHaveLength(2);
  });

  it('rejects duplicate or invalid URLs, empty content and missing categories', async () => {
    for (const slug of ['../terms', 'Getting-Started', '-start', 'start-', 'two--hyphens']) expect((await request('POST', '/api/admin/documents', payload({ slug }))).statusCode, slug).toBe(400);
    expect((await request('POST', '/api/admin/documents', payload({ slug: 'terms' }))).statusCode).toBe(409);
    expect((await request('POST', '/api/admin/documents', payload({ content: ' \r\n ' }))).statusCode).toBe(400);
    expect((await request('POST', '/api/admin/documents', payload({ categoryId: 'missing' }))).statusCode).toBe(400);
    await request('POST', '/api/admin/documents', payload());
    expect((await request('POST', '/api/admin/documents', payload())).statusCode).toBe(409);
  });

  it('manages categories without orphaning documents', async () => {
    const category = (await request('POST', '/api/admin/documents/categories', { name: 'Guides', order: -1 })).json();
    expect((await request('GET', '/api/admin/documents')).json().categories[0].id).toBe(category.id);
    expect((await request('POST', '/api/admin/documents/categories', { name: 'guides', order: 1 })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/admin/documents/categories/${category.id}`, { name: 'Tutorials', order: 2 })).statusCode).toBe(200);
    const doc = (await request('POST', '/api/admin/documents', payload({ categoryId: category.id, published: true }))).json();
    expect((await request('DELETE', `/api/admin/documents/categories/${category.id}`)).statusCode).toBe(400);
    expect((await request('DELETE', '/api/admin/documents/categories/general')).statusCode).toBe(400);
    await request('PATCH', `/api/admin/documents/${doc.id}`, payload({ published: true }));
    expect((await request('DELETE', `/api/admin/documents/categories/${category.id}`)).statusCode).toBe(200);
    expect((await request('GET', '/api/public/documents', undefined, '')).json().documents.find((item: { id: string }) => item.id === doc.id).categoryId).toBe('general');
  });

  it('adds missing default categories to legacy settings while retaining edits and deletions', async () => {
    const { categoryDefaultsVersion: _version, ...legacy } = structuredClone(settings.settingDefaults.legal);
    legacy.categories = [
      { id: 'general', name: '常用文档', order: 3 },
      { id: 'existing-guide', name: '快速开始', order: 7 },
      { id: 'custom-category', name: '自定义分类', order: 9 },
    ];
    legacy.terms.content = 'Existing terms';
    await settings.setInternal('legal', legacy);
    await settings.getSetting('legal', true);
    const migrated = (await request('GET', '/api/admin/documents')).json();
    expect(migrated.categories).toHaveLength(7);
    expect(migrated.categories).toEqual(expect.arrayContaining(legacy.categories));
    expect(migrated.categories.some((category: { id: string }) => category.id === 'getting-started')).toBe(false);
    expect(migrated.documents.find((doc: { id: string }) => doc.id === 'terms').content).toBe('Existing terms');
    expect((await request('DELETE', '/api/admin/documents/categories/networking')).statusCode).toBe(200);
    expect((await request('PATCH', '/api/admin/documents/categories/billing', { name: '费用说明', order: 17 })).statusCode).toBe(200);
    const saved = await settings.getSetting('legal', true);
    expect(saved.categoryDefaultsVersion).toBe(1);
    expect(saved.categories.some(category => category.id === 'networking')).toBe(false);
    expect(saved.categories.find(category => category.id === 'billing')).toEqual({ id: 'billing', name: '费用说明', order: 17 });
  });

  it('updates legal pages and registration versions while protecting their URLs', async () => {
    const original = (await request('GET', '/api/admin/documents')).json().documents.find((doc: { id: string }) => doc.id === 'terms');
    for (const overrides of [{ slug: 'new-terms' }, { published: false }]) expect((await request('PATCH', '/api/admin/documents/terms', { ...original, ...overrides })).statusCode).toBe(400);
    expect((await request('DELETE', '/api/admin/documents/privacy')).statusCode).toBe(400);
    const edited = await request('PATCH', '/api/admin/documents/terms', { ...original, title: 'Platform terms', content: 'Updated terms', announce: true });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await request('GET', '/api/public/legal/terms', undefined, '')).json()).toMatchObject({ title: 'Platform terms', content: 'Updated terms', updatedAt: edited.json().updatedAt });
    expect((await request('GET', '/api/public/documents/terms', undefined, '')).json().content).toBe('Updated terms');
    expect(await db.announcement.count({ where: { title: { contains: 'Platform terms' } } })).toBe(1);
    expect((await request('PATCH', '/api/admin/documents/settings', { requireAgree: true })).statusCode).toBe(200);
    expect((await request('GET', '/api/public/config', undefined, '')).json().legalRequireAgree).toBe(true);
    const signup = { username: 'new_reader', email: 'reader@example.test', password };
    expect((await request('POST', '/api/auth/register', signup, '')).statusCode).toBe(400);
    const accepted = await request('POST', '/api/auth/register', { ...signup, agreeTerms: true }, '');
    expect(accepted.statusCode, accepted.body).toBe(200);
    const activity = await db.activityLog.findFirst({ where: { action: 'auth.register', user: { username: 'new_reader' } } });
    expect(activity?.detail).toContain(edited.json().updatedAt);
  });

  it('preserves documents across concurrent writes and updates from the legacy settings API', async () => {
    const responses = await Promise.all(['first', 'second'].map(slug => request('POST', '/api/admin/documents', payload({ slug }))));
    for (const response of responses) expect(response.statusCode, response.body).toBe(200);
    const response = await request('PUT', '/api/admin/settings/legal', { terms: { content: 'Legacy edit' }, privacy: { content: '' }, requireAgree: false });
    expect(response.statusCode, response.body).toBe(200);
    expect((await request('GET', '/api/admin/documents')).json().documents).toHaveLength(4);
    expect((await request('GET', '/api/public/legal/terms', undefined, '')).json().content).toBe('Legacy edit');
  });
});

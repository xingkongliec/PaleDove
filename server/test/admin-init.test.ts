import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

describe('administrator initialization only when none exists', () => {
  let directory: string;
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let redis: typeof import('../src/lib/redis.ts').redis;
  let crypto: typeof import('../src/lib/crypto.ts');
  let initialize: typeof import('../src/services/admin-init.ts').initializeAdmin;
  const password = 'Original-$word#123\'"`\\';
  const env = { NODE_ENV: 'production', ADMIN_USERNAME: ' ADMIN ', ADMIN_EMAIL: ' ADMIN@EXAMPLE.COM ', ADMIN_PASSWORD: password };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-admin-init-test-'));
    const file = resolve(directory, 'test.db');
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `file:${file}`, REDIS_URL: 'memory://',
      APP_SECRET: 'isolated-admin-init-test-secret', COOKIE_SECURE: 'false', LOG_LEVEL: 'error',
    });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(file).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    ({ redis } = await import('../src/lib/redis.ts'));
    crypto = await import('../src/lib/crypto.ts');
    ({ initializeAdmin: initialize } = await import('../src/services/admin-init.ts'));
    app = await (await import('../src/app.ts')).buildApp();
  }, 60_000);

  beforeEach(async () => { await db.user.deleteMany(); });

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    redis?.disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-admin-init-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('validates initialization credentials only when no administrator exists', async () => {
    for (const ADMIN_PASSWORD of ['', 'too-short', 'admin123456', 'replace-with-a-strong-admin-password', 'x'.repeat(129)]) {
      await expect(initialize({ ...env, ADMIN_PASSWORD })).rejects.toThrow('数据库中尚无管理员');
    }
    expect(await db.user.count()).toBe(0);
  });

  it('creates the first administrator from environment variables and accepts that password through the login API', async () => {
    expect(await initialize(env)).toEqual({ created: true, username: 'admin', email: 'admin@example.com' });
    const admin = await db.user.findUniqueOrThrow({ where: { username: 'admin' } });
    expect(admin.role).toBe('ADMIN');
    expect(await crypto.verifyPassword(admin.passwordHash, password)).toBe(true);
    const result = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account: 'admin', password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().user.role).toBe('ADMIN');
  });

  it('skips existing administrators even if the new environment has different or invalid credentials', async () => {
    const admin = await db.user.create({ data: {
      username: 'original', email: 'original@example.com', role: 'ADMIN', status: 'DISABLED',
      passwordHash: await crypto.hashPassword(password), totpEnabledAt: new Date(), totpSecretEnc: crypto.encrypt('JBSWY3DPEHPK3PXP'), recoveryCodes: '["preserved-code-hash"]',
    } });
    await db.apiToken.create({ data: { userId: admin.id, name: 'existing', prefix: 'pd_test', tokenHash: 'unchanged-token' } });
    await db.passwordResetToken.create({ data: { userId: admin.id, tokenHash: 'existing-reset-token', expiresAt: new Date(Date.now() + 60_000) } });
    const failKey = `auth:fail:pw:${crypto.sha256(admin.username).slice(0, 32)}`;
    await redis.set(failKey, '10', 'EX', 900);
    await redis.set('sess:existing-admin-init-test', 'existing session', 'EX', 60);
    for (const credentials of [env, { NODE_ENV: 'production' }, { ...env, ADMIN_USERNAME: '', ADMIN_EMAIL: 'invalid', ADMIN_PASSWORD: 'short' }]) {
      expect(await initialize(credentials)).toEqual({ created: false, username: admin.username, email: admin.email });
    }
    expect(await db.user.count()).toBe(1);
    expect(await db.user.findUniqueOrThrow({ where: { id: admin.id } })).toEqual(admin);
    expect(await db.apiToken.count({ where: { userId: admin.id } })).toBe(1);
    expect(await db.passwordResetToken.count({ where: { userId: admin.id } })).toBe(1);
    expect(await db.activityLog.count({ where: { userId: admin.id } })).toBe(0);
    expect(await redis.get(failKey)).toBe('10');
    expect(await redis.get('sess:existing-admin-init-test')).toBe('existing session');
  });

  it('does not promote an ordinary user when initialization credentials collide', async () => {
    await db.user.create({ data: { username: 'admin', email: 'regular@example.com', passwordHash: await crypto.hashPassword(password) } });
    await expect(initialize(env)).rejects.toThrow('已被普通用户使用');
    expect((await db.user.findUniqueOrThrow({ where: { username: 'admin' } })).role).toBe('USER');
    expect(await db.user.count({ where: { role: 'ADMIN' } })).toBe(0);
  });
});

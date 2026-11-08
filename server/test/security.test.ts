import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

describe('security hardening', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let sha256: typeof import('../src/lib/crypto.ts').sha256;
  let directory: string;
  let userCookie: string;
  let userId: number;
  const password = 'test-security-password-1';
  let ip = 0;
  const request = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, opts: { cookie?: string; token?: string; payload?: object; remote?: string } = {}) =>
    app.inject({
      method,
      url,
      payload: opts.payload,
      remoteAddress: opts.remote ?? `10.9.${Math.floor(++ip / 250) % 250}.${(ip % 250) + 1}`,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : { 'x-requested-with': 'XMLHttpRequest' }),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      },
    });
  const login = (account: string, pass: string) => request('POST', '/api/auth/login', { payload: { account, password: pass } });
  const createToken = async (readOnly: boolean) => {
    const res = await request('POST', '/api/tokens', { cookie: userCookie, payload: { name: readOnly ? 'monitor' : 'ci', expiresInDays: 30, readOnly } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().readOnly).toBe(readOnly);
    return res.json().token as string;
  };

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-security-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-security-secret-123456789012', LOG_LEVEL: 'error', COOKIE_SECURE: 'false' });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    const crypto = await import('../src/lib/crypto.ts');
    sha256 = crypto.sha256;
    const hash = await crypto.hashPassword(password);
    userId = (await db.user.create({ data: { username: 'sec-user', email: 'sec-user@example.com', passwordHash: hash, emailVerifiedAt: new Date() } })).id;
    await db.user.create({ data: { username: 'sec-victim', email: 'sec-victim@example.com', passwordHash: hash, emailVerifiedAt: new Date() } });
    app = await (await import('../src/app.ts')).buildApp();
    const res = await login('sec-user', password);
    expect(res.statusCode, res.body).toBe(200);
    userCookie = res.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-security-test-')) rmSync(directory, { recursive: true, force: true });
  });

  it('limits read-only API tokens to queries and keeps the terminal and passwords out of reach', async () => {
    const token = await createToken(true);
    expect((await request('GET', '/api/instances', { token })).statusCode).toBe(200);
    expect((await request('GET', '/api/ssh-keys', { token })).statusCode).toBe(200);
    // 写操作
    const write = await request('POST', '/api/ssh-keys', { token, payload: { name: 'k', publicKey: 'ssh-ed25519 AAAA' } });
    expect(write.statusCode).toBe(403);
    expect(write.json().message).toMatch(/只读|Read-only/);
    // 实例密码与网页终端虽然是 GET 也不允许
    expect((await request('GET', '/api/instances/1/credentials', { token })).statusCode).toBe(403);
    expect((await request('GET', '/api/instances/1/terminal', { token })).statusCode).toBe(403);
    // 账号安全接口对任何令牌都关闭
    expect((await request('GET', '/api/tokens', { token })).statusCode).toBe(403);
    expect((await request('GET', '/api/auth/me', { token })).statusCode).toBe(200);
  });

  it('lets full-access tokens write and lists the access level', async () => {
    const token = await createToken(false);
    const res = await request('POST', '/api/ssh-keys', { token, payload: { name: 'k', publicKey: 'not a key' } });
    // 通过了权限检查，由接口自己校验参数
    expect(res.statusCode).not.toBe(403);
    const list = (await request('GET', '/api/tokens', { cookie: userCookie })).json() as { name: string; readOnly: boolean }[];
    expect(list.map((t) => [t.name, t.readOnly]).sort()).toEqual([['ci', false], ['monitor', true]]);
  });

  it('locks password attempts per account across IPs without disclosing whether it exists', async () => {
    for (let i = 0; i < 10; i++) expect((await login('sec-victim', 'wrong-password')).statusCode).toBe(401);
    // 换 IP、密码正确也被暂停
    const locked = await login('sec-victim', password);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error).toBe('TOO_MANY_ATTEMPTS');
    // 不存在的账号同样计数、同样提示
    for (let i = 0; i < 10; i++) expect((await login('nobody-here', 'x')).statusCode).toBe(401);
    expect((await login('nobody-here', 'x')).statusCode).toBe(429);
    // 其他账号不受影响；成功登录会清零计数
    expect((await login('sec-user', 'wrong-password')).statusCode).toBe(401);
    expect((await login('sec-user', password)).statusCode).toBe(200);
  });

  it('sends anti-framing and nosniff headers without overriding route-specific policies', async () => {
    const res = await request('GET', '/api/health');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('revokes API tokens when the password is reset', async () => {
    expect(await db.apiToken.count({ where: { userId } })).toBe(2);
    const raw = 'reset-token-for-security-test-0123456789';
    await db.passwordResetToken.create({ data: { userId, tokenHash: sha256(raw), expiresAt: new Date(Date.now() + 600_000) } });
    const res = await request('POST', '/api/auth/reset-password', { payload: { token: raw, password: 'brand-new-password-9' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await db.apiToken.count({ where: { userId } })).toBe(0);
  });

  it('rejects OAuth return paths that browsers would turn into another origin', async () => {
    const { safeNext } = await import('../src/services/oauth.ts');
    expect(safeNext('/dashboard?tab=1')).toBe('/dashboard?tab=1');
    for (const bad of ['//evil.example', '/\t/evil.example', '/\n/evil.example', '/\\evil.example', 'https://evil.example', '/ /evil']) expect(safeNext(bad)).toBe('');
  });
});

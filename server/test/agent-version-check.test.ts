import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('administrator Agent version check', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let adminCookie: string;
  let userCookie: string;
  let version = '0.8.0';
  let offline = false;
  const digest = createHash('sha256').update('test-binary').digest('hex');
  const upstream = vi.fn<typeof fetch>(async () => {
    if (offline) throw new Error('offline');
    return new Response(JSON.stringify([{
      tag_name: `agent-v${version}`, draft: false, prerelease: false,
      assets: ['x86_64', 'aarch64'].map((arch, index) => ({ id: index + 1, name: `paledove-agent-${arch}-v${version}`, size: 11, digest: `sha256:${digest}` })),
    }]));
  });
  const check = (cookie = adminCookie, csrf = true) => app.inject({
    method: 'POST', url: '/api/admin/agent/check-update',
    headers: { ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-requested-with': 'XMLHttpRequest' } : {}) },
  });

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'paledove-agent-version-test-'));
    for (const [key, value] of Object.entries({
      NODE_ENV: 'test', DATABASE_URL: `file:${join(directory, 'test.db')}`, REDIS_URL: 'memory://',
      APP_SECRET: 'test-agent-version-secret-1234567890', LOG_LEVEL: 'error', COOKIE_SECURE: 'false',
      AGENT_RELEASE_REPOSITORY: 'test/paledove', AGENT_RELEASE_CACHE_DIR: join(directory, 'cache'), AGENT_RELEASE_TOKEN: 'private-test-token',
    })) vi.stubEnv(key, value);
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(join(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    vi.stubGlobal('fetch', upstream);
    db = (await import('../src/lib/prisma.ts')).prisma;
    const password = 'test-agent-version-password-123';
    const passwordHash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const [username, role] of [['version-admin', 'ADMIN'], ['version-member', 'USER']] as const) {
      await db.user.create({ data: { username, email: `${username}@example.test`, passwordHash, role, emailVerifiedAt: new Date() } });
    }
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { account, password }, headers: { 'x-requested-with': 'XMLHttpRequest' } });
      expect(response.statusCode, response.body).toBe(200);
      return response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
    };
    adminCookie = await login('version-admin');
    userCookie = await login('version-member');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-agent-version-test-')) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires an administrator session and CSRF header before querying GitHub', async () => {
    expect((await check('')).statusCode).toBe(401);
    expect((await check(userCookie)).statusCode).toBe(403);
    expect((await check(adminCookie, false)).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('bypasses the five-minute cache and returns the new version without exposing credentials', async () => {
    const { loadAgentManifest, agentManifest } = await import('../src/services/agent/agent-binary.ts');
    expect((await loadAgentManifest()).version).toBe('0.8.0');
    version = '0.8.1';
    const response = await check();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ version, source: 'github', checkedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(response.json().checkedAt))).toBe(true);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).not.toContain('private-test-token');
    expect(agentManifest().version).toBe(version);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(await db.node.count()).toBe(0);
  });

  it('reports upstream failures clearly and allows an immediate manual retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    offline = true;
    const failed = await check();
    expect(failed.statusCode, failed.body).toBe(503);
    expect(failed.json().error).toBe('AGENT_RELEASE_UNAVAILABLE');
    const { agentManifest } = await import('../src/services/agent/agent-binary.ts');
    expect(agentManifest().version).toBe('0.8.1');
    offline = false;
    version = '0.8.2';
    const retried = await check();
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ version, source: 'github' });
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

describe('public Agent release download API', () => {
  let app: FastifyInstance;
  let directory: string;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  const binary = Buffer.from('isolated Agent binary');
  const sha256 = createHash('sha256').update(binary).digest('hex');
  const upstream = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes('/releases/assets/')) return new Response(binary);
    return new Response(JSON.stringify([{
      tag_name: 'agent-v0.7.1', draft: false, prerelease: false,
      assets: ['x86_64', 'aarch64'].map((arch, i) => ({
        id: i + 1, name: `paledove-agent-${arch}-v0.7.1`, size: binary.length, digest: `sha256:${sha256}`,
      })),
    }]));
  });

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'paledove-agent-api-test-'));
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', `file:${join(directory, 'test.db')}`);
    vi.stubEnv('REDIS_URL', 'memory://');
    vi.stubEnv('APP_SECRET', 'isolated-agent-download-test-secret');
    vi.stubEnv('AGENT_RELEASE_REPOSITORY', 'test/paledove');
    vi.stubEnv('AGENT_RELEASE_CACHE_DIR', join(directory, 'cache'));
    vi.stubEnv('AGENT_RELEASE_TOKEN', 'github-test-secret');
    vi.stubGlobal('fetch', upstream);
    app = Fastify();
    // 此测试仅注册下载路由，沿用主应用对 Zod 输入错误的状态码约定。
    app.setErrorHandler((error, _request, reply) => {
      if (error instanceof ZodError) return reply.code(400).send({ error: 'BAD_REQUEST' });
      return reply.send(error);
    });
    await app.register((await import('../src/routes/agent.ts')).default);
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    await app.ready();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('proxies verified bytes and preserves both old and pinned text manifest formats', async () => {
    const manifest = await app.inject({ method: 'GET', url: '/api/agent/manifest.json' });
    expect(manifest.statusCode, manifest.body).toBe(200);
    expect(manifest.json()).toMatchObject({ version: '0.7.1', files: { amd64: { sha256, size: binary.length } } });
    expect(manifest.body).not.toContain('github-test-secret');
    const legacy = await app.inject({ method: 'GET', url: '/api/agent/manifest.json?format=text' });
    expect(legacy.body.split('\n')[0]).toBe(`amd64 ${sha256} ${binary.length}`);
    const pinned = await app.inject({ method: 'GET', url: '/api/agent/manifest.json?format=text&version=1' });
    expect(pinned.body.split('\n')[0]).toBe(`amd64 ${sha256} ${binary.length} 0.7.1`);
    const download = await app.inject({ method: 'GET', url: `/api/agent/binary/amd64?v=0.7.1&sha256=${sha256}` });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.rawPayload).toEqual(binary);
    expect(download.headers['content-length']).toBe(String(binary.length));
    expect(download.headers['content-disposition']).toContain('paledove-agent-linux-amd64');
    expect(download.headers.location).toBeUndefined();
    expect(download.headers['cache-control']).toBe('no-store');
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid architectures and versions before making any upstream request', async () => {
    const before = upstream.mock.calls.length;
    expect((await app.inject({ method: 'GET', url: '/api/agent/binary/mips' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/agent/binary/amd64?v=bad-version' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/agent/binary/amd64?sha256=bad-digest' })).statusCode).toBe(400);
    expect(upstream).toHaveBeenCalledTimes(before);
  });

  it('pins upgrade downloads and does not offer a downgrade', async () => {
    const { upgradeInstruction } = await import('../src/services/agent/agent-binary.ts');
    expect(upgradeInstruction('https://panel.example.com', '0.7.0', 'amd64')).toEqual({
      version: '0.7.1', url: `https://panel.example.com/api/agent/binary/amd64?v=0.7.1&sha256=${sha256}`, sha256, size: binary.length,
    });
    expect(upgradeInstruction('https://panel.example.com', '0.8.0', 'amd64')).toBeNull();
    expect(upgradeInstruction('https://panel.example.com', '0.7.1', 'amd64')).toBeNull();
    expect(upgradeInstruction('https://panel.example.com', '0.7.0', '__proto__')).toBeNull();
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('interactive node installation callback', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let nodes: typeof import('../src/services/nodes.ts');
  let directory: string;
  let serial = 0;

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-node-install-test-'));
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`,
      REDIS_URL: 'memory://', APP_SECRET: 'isolated-node-install-test-secret', LOG_LEVEL: 'error',
    });
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    ({ prisma: db } = await import('../src/lib/prisma.ts'));
    nodes = await import('../src/services/nodes.ts');
    app = await (await import('../src/app.ts')).buildApp();
  }, 90_000);

  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-node-install-test-')) rmSync(directory, { recursive: true, force: true });
  });

  const pending = async () => {
    const node = await db.node.create({ data: {
      name: `interactive-${++serial}`, region: 'Test', endpoint: `mock://interactive-${serial}`,
      storageDriver: 'zfs', storageSource: '/dev/preset', storageSize: '200GiB',
      installAgent: true, installFirewall: false, enableFirewallRules: false,
    } });
    const { token } = await nodes.issueInstallToken(node.id);
    return { node, token };
  };

  const register = (token: string, extra: Record<string, unknown> = {}) => app.inject({
    method: 'POST', url: '/api/agent/nodes/register',
    payload: { token, fingerprint: 'a'.repeat(64), publicIp: '192.0.2.1', port: 8443, ...extra },
  });

  it('saves runtime storage and component choices, including false values, and consumes the token', async () => {
    const { node, token } = await pending();
    const response = await register(token, {
      storagePool: 'chosen-pool', storageDriver: 'dir', storageSource: '/srv/incus', storageSize: '100GiB',
      installAgent: false, installFirewall: true, enableFirewallRules: true,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      storagePool: 'chosen-pool', storageDriver: 'dir', storageSource: '/srv/incus', storageSize: '100GiB',
      installAgent: false, installFirewall: true, enableFirewallRules: true, installTokenHash: null,
    });
    expect((await register(token)).statusCode).toBe(401);
  });

  it('keeps the existing options when an older installer omits the new fields', async () => {
    const { node, token } = await pending();
    expect((await register(token)).statusCode).toBe(200);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({
      storageDriver: 'zfs', storageSource: '/dev/preset', storageSize: '200GiB',
      installAgent: true, installFirewall: false, enableFirewallRules: false,
    });
  });

  it('clears an unused storage source and rejects malformed configurations without consuming the token', async () => {
    const { node, token } = await pending();
    for (const extra of [{ storageDriver: 'shell' }, { storagePool: '../escape' }, { storageSource: '/srv/invalid\npath' }, { installAgent: 'true' }, { storageSize: '12345' }]) {
      expect((await register(token, extra)).statusCode).toBe(400);
    }
    expect((await register(token, { storageDriver: 'btrfs', storageSource: '', storageSize: '102400MiB' })).statusCode).toBe(200);
    expect(await db.node.findUniqueOrThrow({ where: { id: node.id } })).toMatchObject({ storageDriver: 'btrfs', storageSource: null, storageSize: '102400MiB' });
  });
});

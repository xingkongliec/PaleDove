import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startupBuilds } from '../scripts/ensure-web.mjs';

const project = () => {
  const root = mkdtempSync(join(tmpdir(), 'paledove-startup-test-'));
  const server = join(root, 'server');
  mkdirSync(server);
  return { root, server, create(path) {
    const file = join(root, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, 'test build artifact');
  } };
};

test('first start prepares frontend and backend; hot reload only needs frontend', () => {
  const { server } = project();
  assert.deepEqual(startupBuilds(server, {}, true), ['@paledove/web', '@paledove/server']);
  assert.deepEqual(startupBuilds(server, {}, false), ['@paledove/web']);
});

test('existing PostgreSQL bundle stays usable; SQLite starts rebuild a legacy bundle missing its client', () => {
  const { server, create } = project();
  create('web/dist/index.html');
  create('server/dist/index.js');
  assert.deepEqual(startupBuilds(server, { DATABASE_URL: 'postgresql://db.test/panel' }, true), []);
  assert.deepEqual(startupBuilds(server, { DATABASE_URL: 'file:./data/dev.db' }, true), ['@paledove/server']);
  create('server/dist/prisma-sqlite.js');
  assert.deepEqual(startupBuilds(server, {}, true), []);
});

test('honors custom frontend directories and explicit skip options', () => {
  const { server, create } = project();
  assert.deepEqual(startupBuilds(server, { SKIP_WEB_BUILD: '1' }), []);
  assert.deepEqual(startupBuilds(server, { WEB_DIST: '' }), []);
  create('custom/index.html');
  assert.deepEqual(startupBuilds(server, { WEB_DIST: '../custom' }), []);
  assert.deepEqual(startupBuilds(server, { WEB_DIST: '../missing' }), ['@paledove/web']);
});

test('local migration creates a missing SQLite directory and database without external services', () => {
  const directory = mkdtempSync(join(tmpdir(), 'paledove-sqlite-first-start-'));
  const file = join(directory, 'nested', 'dev.db');
  const dotenvPath = join(directory, '.env');
  writeFileSync(dotenvPath, '');
  const args = [fileURLToPath(new URL('../scripts/db.mjs', import.meta.url)), 'migrate'];
  const options = {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, DOTENV_CONFIG_PATH: dotenvPath, NODE_ENV: 'test', DATABASE_URL: `file:${file}` },
    stdio: 'pipe', timeout: 60_000,
  };
  execFileSync(process.execPath, args, options);
  const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
  const Database = require('better-sqlite3');
  const database = new Database(file, { readonly: true });
  try {
    assert(database.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'User'));
    assert.equal(database.prepare('SELECT count(*) AS count FROM "User"').get().count, 0);
  } finally {
    database.close();
  }
});

// Exercise the emitted ESM: source-level tests cannot catch bundled async initialization deadlocks.
test('production bundle initializes the administrator and starts with piped logs', { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'paledove-runtime-startup-'));
  t.after(() => {
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('paledove-runtime-startup-')) {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const serverDirectory = fileURLToPath(new URL('../', import.meta.url));
  const databaseFile = join(directory, 'test.db');
  const dotenv = join(directory, '.env');
  writeFileSync(dotenv, '');
  const env = {
    ...process.env, DOTENV_CONFIG_PATH: dotenv, NODE_ENV: 'production',
    DATABASE_URL: `file:${databaseFile}`, REDIS_URL: 'memory://',
    APP_SECRET: 'isolated-runtime-startup-test-secret',
    HOST: '127.0.0.1', PORT: '0', WEB_DIST: '', INCUS_CERT_DIR: join(directory, 'certs'), UPLOAD_DIR: join(directory, 'uploads'),
    PANEL_URL: 'http://127.0.0.1', RUN_API: 'true', RUN_WORKER: 'true',
    LOG_LEVEL: 'info', LOG_REQUESTS: 'true', NO_COLOR: '1', COOKIE_SECURE: 'false',
    ADMIN_USERNAME: 'startup_admin', ADMIN_EMAIL: 'startup-admin@example.com', ADMIN_PASSWORD: 'isolated-startup-password-1234',
  };
  const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
  new (require('better-sqlite3'))(databaseFile).close();
  execFileSync(process.execPath, [join(serverDirectory, 'node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { cwd: serverDirectory, env, stdio: 'pipe', timeout: 30_000 });
  const initialize = overrides => execFileSync(process.execPath, [join(serverDirectory, 'dist/init-admin.js')], { cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 });
  assert.match(initialize({}), /已创建管理员/);
  assert.match(initialize({ ADMIN_PASSWORD: 'different-password-must-not-reset' }), /已有管理员/);

  for (const { format, api } of [{ format: 'pretty', api: true }, { format: 'json', api: true }, { format: 'pretty', api: false }]) {
    await t.test(`${format} logs, API ${api ? 'and worker' : 'disabled, worker only'}`, { timeout: 15_000 }, async () => {
      const child = spawn(process.execPath, [join(serverDirectory, 'dist/index.js')], { cwd: directory, env: { ...env, LOG_FORMAT: format, RUN_API: String(api) }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let stderr = '';
      const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal })));
      let readyTimer;
      const ready = new Promise((resolveReady, reject) => {
        readyTimer = setTimeout(() => reject(new Error(`Startup timed out.\n${output}\n${stderr}`)), 10_000);
        child.once('error', reject);
        child.stdout.on('data', chunk => {
          output += chunk.toString();
          if (output.includes('PaleDove 后端已就绪') && output.includes('启动耗时')) resolveReady();
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        exited.then(({ code, signal }) => reject(new Error(`Process exited before readiness (${code ?? signal}).\n${output}\n${stderr}`)));
      });
      try {
        await ready;
        assert.equal(child.exitCode, null);
        assert.doesNotMatch(stderr, /unsettled top-level await|ReferenceError|TypeError/);
        assert.match(output, /正在启动后端/);
        assert.match(output, /正在恢复任务队列/);
        if (api) {
          const address = format === 'json'
            ? output.trim().split('\n').map(line => JSON.parse(line)).find(log => log.startup)?.startup['服务地址']
            : output.match(/服务地址\s+(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
          assert(address, output);
          const health = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(3000) });
          assert.equal(health.status, 200);
          assert.deepEqual(await health.json(), { ok: true });
          const login = await fetch(`${address}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
            body: JSON.stringify({ account: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }), signal: AbortSignal.timeout(3000),
          });
          assert.equal(login.status, 200, await login.text());
          assert(!output.includes(env.ADMIN_PASSWORD));
        } else {
          assert.match(output, /API 已关闭/);
        }
      } finally {
        clearTimeout(readyTimer);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        const killTimer = setTimeout(() => child.kill('SIGKILL'), 3000);
        await exited;
        clearTimeout(killTimer);
      }
    });
  }
});

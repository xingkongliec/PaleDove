import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateEnvironment } from '../scripts/docker/check-env.mjs';

const valid = {
  DATABASE_URL: 'postgresql://panel:password@db.example.test:5432/panel',
  REDIS_URL: 'rediss://:password@redis.example.test:6380/0',
  APP_SECRET: 'a-test-secret-for-container-validation',
  ADMIN_PASSWORD: 'a-strong-test-admin-password',
};

test('accepts external PostgreSQL and TLS Redis without embedding services', () => {
  assert.deepEqual(validateEnvironment(valid), []);
  assert.deepEqual(validateEnvironment({ ...valid, DATABASE_URL: valid.DATABASE_URL.replace('postgresql:', 'postgres:') }), []);
});

test('rejects development-only databases and memory Redis before startup', () => {
  for (const DATABASE_URL of ['', 'file:./data/dev.db', 'mysql://db.example.test/panel']) {
    assert.match(validateEnvironment({ ...valid, DATABASE_URL }).join('\n'), /DATABASE_URL/);
  }
  for (const REDIS_URL of ['', 'memory://', 'http://redis.example.test']) {
    assert.match(validateEnvironment({ ...valid, REDIS_URL }).join('\n'), /REDIS_URL/);
  }
});

test('requires real application secrets and defers administrator credentials to the database check', () => {
  assert.match(validateEnvironment({ ...valid, APP_SECRET: 'replace-with-a-random-secret' }).join('\n'), /APP_SECRET/);
  for (const ADMIN_PASSWORD of ['', 'admin123456', 'replace-with-a-strong-admin-password']) {
    assert.deepEqual(validateEnvironment({ ...valid, ADMIN_PASSWORD }, 'init'), []);
  }
  assert.deepEqual(validateEnvironment({ ...valid, ADMIN_PASSWORD: '' }, 'start'), []);
  assert.deepEqual(validateEnvironment({ ...valid, SEED_DEMO: 'false' }, 'init'), []);
  assert.match(validateEnvironment({ ...valid, SEED_DEMO: 'true' }, 'seed').join('\n'), /SEED_DEMO/);
});

test('migration only requires the external database connection', () => {
  assert.deepEqual(validateEnvironment({ DATABASE_URL: valid.DATABASE_URL }, 'migrate'), []);
});

test('configuration errors do not disclose URLs or credentials', () => {
  const errors = validateEnvironment({ ...valid, DATABASE_URL: 'mysql://secret-user:do-not-expose@private.example.test/db', REDIS_URL: 'memory://do-not-expose' });
  assert.equal(errors.length, 2);
  assert.doesNotMatch(errors.join('\n'), /do-not-expose|secret-user|private\.example/);
});

test('does not silently skip migrations for misspelled options or launch an idle process', () => {
  assert.match(validateEnvironment({ ...valid, DB_MIGRATE: 'treu' }).join('\n'), /DB_MIGRATE/);
  assert.match(validateEnvironment({ ...valid, RUN_API: 'false', RUN_WORKER: 'false' }).join('\n'), /Enable RUN_API or RUN_WORKER/);
  assert.deepEqual(validateEnvironment({ ...valid, RUN_API: 'false', RUN_WORKER: 'true', DB_MIGRATE: 'false' }), []);
});

const healthcheck = fileURLToPath(new URL('../scripts/docker/healthcheck.mjs', import.meta.url));
const runHealthcheck = env => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [healthcheck], { env: { ...process.env, ...env }, stdio: 'ignore' });
  child.on('error', reject);
  child.on('exit', resolve);
});

test('health check verifies status and body rather than accepting an SPA fallback', async () => {
  let body = '{"ok":true}';
  let status = 200;
  const paths = [];
  const server = createServer((req, res) => {
    paths.push(req.url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const env = { PORT: String(server.address().port), RUN_API: 'true' };
  try {
    assert.equal(await runHealthcheck(env), 0);
    body = '<html>SPA fallback</html>';
    assert.equal(await runHealthcheck(env), 1);
    body = '{"ok":false}';
    assert.equal(await runHealthcheck(env), 1);
    status = 503;
    body = '{"ok":true}';
    assert.equal(await runHealthcheck(env), 1);
    assert.deepEqual(paths, Array(4).fill('/api/health'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('health check fails when API is unreachable and supports a separate worker', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const PORT = String(server.address().port);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await runHealthcheck({ PORT, RUN_API: 'true' }), 1);
  assert.equal(await runHealthcheck({ PORT, RUN_API: 'false' }), 0);
});

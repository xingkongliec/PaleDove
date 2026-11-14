import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

describe('Night Market period number migration', () => {
  it('numbers existing periods chronologically, preserves snapshots, and runs safely twice', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'paledove-night-migration-'));
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    const file = resolve(directory, 'legacy.db');
    const env = { ...process.env, DATABASE_URL: `file:${file}` };
    try {
      new Database(file).close();
      const schema = readFileSync('prisma/sqlite/schema.prisma', 'utf8').replace(/^\s*nightRenewPrice\s+Decimal[^\n]*\n/m, '').replace(/model NightMarketPeriod \{[\s\S]*?\n\}/, block => block.replace(/^\s*number\s+Int[^\n]*\n/m, '').replace(/^\s*drawRules\s+Json[^\n]*\n/m, '').replace(/currentAct Int @default\(2\)/, 'currentAct Int'));
      const legacySchema = resolve(directory, 'legacy.prisma');
      writeFileSync(legacySchema, schema);
      execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', legacySchema, '--config', 'prisma.sqlite.config.ts'], { env, stdio: 'pipe' });
      const before = new Database(file);
      const time = Date.UTC(2026, 10, 1);
      const rows = [[41, time + 86400_000], [7, time], [92, time + 2 * 86400_000]];
      for (const [id, startsAt] of rows) before.prepare('INSERT INTO "NightMarketPeriod" (id, startsAt, closesAt, refreshAt, currentAct, catalog) VALUES (?, ?, ?, ?, ?, ?)').run(id, startsAt, startsAt + 3600_000, startsAt + 86400_000, 5, JSON.stringify([{ id: `prize-${id}`, releaseAct: 3, originalPrice: '20.00' }]));
      const snapshots = before.prepare('SELECT id, currentAct, catalog FROM "NightMarketPeriod" ORDER BY id').all();
      before.close();
      const deploy = () => execFileSync(process.execPath, ['scripts/db.mjs', 'deploy'], { env, stdio: 'pipe' });
      deploy();
      const after = new Database(file);
      expect(after.prepare('SELECT id, number FROM "NightMarketPeriod" ORDER BY number').all()).toEqual([{ id: 7, number: 1 }, { id: 41, number: 2 }, { id: 92, number: 3 }]);
      expect(after.prepare('SELECT id, currentAct, catalog FROM "NightMarketPeriod" ORDER BY id').all()).toEqual(snapshots);
      expect(after.prepare('SELECT drawRules FROM "NightMarketPeriod"').all()).toEqual([{ drawRules: null }, { drawRules: null }, { drawRules: null }]);
      expect(after.prepare('PRAGMA table_info("Instance")').all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'nightRenewPrice', notnull: 0 })]));
      after.prepare('INSERT INTO "NightMarketPeriod" (number, startsAt, closesAt, refreshAt, catalog) VALUES (4, ?, ?, ?, ?)').run(time + 3 * 86400_000, time + 3 * 86400_000 + 3600_000, time + 4 * 86400_000, '[]');
      after.close();
      deploy();
      const again = new Database(file);
      expect(again.prepare('SELECT number FROM "NightMarketPeriod" ORDER BY number').all()).toEqual([1, 2, 3, 4].map(number => ({ number })));
      expect(again.prepare('SELECT id, currentAct, catalog FROM "NightMarketPeriod" WHERE number < 4 ORDER BY id').all()).toEqual(snapshots);
      again.close();
    } finally {
      if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-night-migration-')) rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it('adds recurring prices without repricing existing instances', () => {
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE "Instance" (id INTEGER PRIMARY KEY, price DECIMAL(10,2) NOT NULL, billingCycle TEXT NOT NULL)');
      db.exec('INSERT INTO "Instance" (id, price, billingCycle) VALUES (3, 19.99, \'MONTHLY\'), (8, 199.99, \'ANNUAL\')');
      db.exec(readFileSync('prisma/migrations/20261114020000_night_market_recurring_price/migration.sql', 'utf8'));
      expect(db.prepare('SELECT * FROM "Instance" ORDER BY id').all()).toEqual([
        { id: 3, price: 19.99, billingCycle: 'MONTHLY', nightRenewPrice: null },
        { id: 8, price: 199.99, billingCycle: 'ANNUAL', nightRenewPrice: null },
      ]);
    } finally { db.close(); }
  });

  it('adds nullable draw-rule snapshots without modifying existing catalogs', () => {
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE "NightMarketPeriod" (id INTEGER PRIMARY KEY, catalog TEXT NOT NULL)');
      db.prepare('INSERT INTO "NightMarketPeriod" (id, catalog) VALUES (?, ?)').run(7, '[{"id":"old-prize"}]');
      db.exec(readFileSync('prisma/migrations/20261114040000_night_market_draw_rules/migration.sql', 'utf8'));
      expect(db.prepare('SELECT * FROM "NightMarketPeriod"').all()).toEqual([{ id: 7, catalog: '[{"id":"old-prize"}]', drawRules: null }]);
    } finally { db.close(); }
  });
});

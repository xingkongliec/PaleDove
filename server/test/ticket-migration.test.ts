import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

describe('legacy ticket migration', () => {
  it('preserves old messages, derives their roles and backfills reply and close times once', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'paledove-ticket-migration-'));
    const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
    const Database = require('better-sqlite3');
    const file = resolve(directory, 'legacy.db');
    const env = { ...process.env, DATABASE_URL: `file:${file}` };
    try {
      new Database(file).close();
      let schema = readFileSync('prisma/sqlite/schema.prisma', 'utf8');
      schema = schema.replace(/model TicketAttachment \{[\s\S]*?\n\}/, '');
      schema = schema.replace(/model Ticket \{[\s\S]*?\n\}/, (block) => block.split('\n').filter((line) => !/^\s*(category |priority |resourceRef |resourceName |lastReplyAt |closedAt |attachments |@@index\(\[status)/.test(line)).join('\n'));
      schema = schema.replace(/model TicketMessage \{[\s\S]*?\n\}/, (block) => block.split('\n').filter((line) => !/^\s*(isAdmin |attachments )/.test(line)).join('\n'));
      const oldSchema = resolve(directory, 'old.prisma'); writeFileSync(oldSchema, schema);
      execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', oldSchema, '--config', 'prisma.sqlite.config.ts'], { env, stdio: 'pipe' });
      const before = new Database(file);
      const time = Date.UTC(2026, 9, 1);
      for (const [id, username, role] of [[1, 'old-user', 'USER'], [2, 'old-support', 'ADMIN']] as const) before.prepare('INSERT INTO "User" (id, email, username, passwordHash, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, `${username}@example.com`, username, 'legacy-test-hash', role, time, time);
      for (const [id, status, authorId] of [[1, 'OPEN', 2], [2, 'CLOSED', 1], [3, 'OPEN', 1]] as const) {
        before.prepare('INSERT INTO "Ticket" (id, userId, subject, status, createdAt, updatedAt) VALUES (?, 1, ?, ?, ?, ?)').run(id, `Legacy ${id}`, status, time, time + id * 1000);
        before.prepare('INSERT INTO "TicketMessage" (ticketId, authorId, content, createdAt) VALUES (?, ?, ?, ?)').run(id, authorId, `Legacy message ${id}`, time + id * 1000);
      }
      before.close();
      const deploy = () => execFileSync(process.execPath, ['scripts/db.mjs', 'deploy'], { env, stdio: 'pipe' });
      deploy();
      const after = new Database(file);
      expect(after.prepare('SELECT subject, status, category, priority, lastReplyAt, closedAt FROM "Ticket" ORDER BY id').all()).toEqual([
        { subject: 'Legacy 1', status: 'REPLIED', category: 'other', priority: 'NORMAL', lastReplyAt: time + 1000, closedAt: null },
        { subject: 'Legacy 2', status: 'CLOSED', category: 'other', priority: 'NORMAL', lastReplyAt: time + 2000, closedAt: time + 2000 },
        { subject: 'Legacy 3', status: 'OPEN', category: 'other', priority: 'NORMAL', lastReplyAt: time + 3000, closedAt: null },
      ]);
      expect(after.prepare('SELECT content, isAdmin FROM "TicketMessage" ORDER BY id').all()).toEqual([
        { content: 'Legacy message 1', isAdmin: 1 }, { content: 'Legacy message 2', isAdmin: 0 }, { content: 'Legacy message 3', isAdmin: 0 },
      ]);
      after.prepare('UPDATE "Ticket" SET priority = ? WHERE id = 1').run('URGENT'); after.close();
      deploy();
      const again = new Database(file); expect(again.prepare('SELECT priority FROM "Ticket" WHERE id = 1').get().priority).toBe('URGENT'); again.close();
    } finally {
      if (dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-ticket-migration-')) rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);
});

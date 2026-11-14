// pnpm db:migrate / db:deploy 的入口：
//  - PostgreSQL：prisma migrate dev / prisma migrate deploy（prisma/migrations）
//  - SQLite（DATABASE_URL=file:...，仅本地开发）：重新生成 SQLite schema 与客户端，并用 db push 同步表结构
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [command, ...rest] = process.argv.slice(2);
if (command !== 'migrate' && command !== 'deploy') {
  console.error('usage: node scripts/db.mjs <migrate|deploy> [prisma args...]');
  process.exit(1);
}

function prisma(...args) {
  const cli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url));
  const res = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

if (process.env.DATABASE_URL?.startsWith('file:')) {
  // 添加邮箱验证字段时，保留旧账号的登录能力；只在升级前没有此字段时执行。
  const file = resolve(process.env.DATABASE_URL.replace(/^file:/, ''));
  const require = createRequire(import.meta.resolve('@prisma/adapter-better-sqlite3'));
  const Database = require('better-sqlite3');
  let verifyExisting = false;
  let upgradeTickets = false;
  let upgradeBilling = false;
  // 首次开发启动先创建目录和空库，避免 Windows 上 Prisma 对不存在文件报 Schema engine error。
  mkdirSync(dirname(file), { recursive: true });
  {
    const db = new Database(file);
    const columns = db.prepare('PRAGMA table_info("User")').all();
    verifyExisting = columns.length > 0 && !columns.some((column) => column.name === 'emailVerifiedAt');
    const ticketColumns = db.prepare('PRAGMA table_info("Ticket")').all();
    upgradeTickets = ticketColumns.length > 0 && !ticketColumns.some((column) => column.name === 'lastReplyAt');
    const invoiceColumns = db.prepare('PRAGMA table_info("Invoice")').all();
    upgradeBilling = invoiceColumns.length > 0 && !invoiceColumns.some((column) => column.name === 'discountSource');
    const nightColumns = db.prepare('PRAGMA table_info("NightMarketPeriod")').all();
    if (nightColumns.length > 0 && !nightColumns.some((column) => column.name === 'number')) {
      // Backfill distinct display numbers before Prisma adds their unique index.
      db.transaction(() => {
        db.exec('ALTER TABLE "NightMarketPeriod" ADD COLUMN "number" INTEGER NOT NULL DEFAULT 1');
        db.exec('WITH numbered AS (SELECT "id", ROW_NUMBER() OVER (ORDER BY "startsAt", "id") AS n FROM "NightMarketPeriod") UPDATE "NightMarketPeriod" SET "number" = (SELECT n FROM numbered WHERE numbered."id" = "NightMarketPeriod"."id")');
        db.exec('CREATE UNIQUE INDEX "NightMarketPeriod_number_key" ON "NightMarketPeriod"("number")');
      })();
    }
    db.close();
  }
  await import('./sqlite-schema.mjs');
  prisma('generate', '--config', 'prisma.sqlite.config.ts');
  prisma('db', 'push', '--config', 'prisma.sqlite.config.ts', ...rest);
  if (upgradeBilling) {
    const db = new Database(file);
    const { backfillBillingDiscounts } = await import('./billing-discounts.mjs');
    backfillBillingDiscounts(db);
    db.close();
  }
  if (verifyExisting) {
    const db = new Database(file);
    db.exec('UPDATE "User" SET "emailVerifiedAt" = CURRENT_TIMESTAMP');
    db.close();
  }
  if (upgradeTickets) {
    const db = new Database(file);
    db.transaction(() => {
      db.exec('UPDATE "Ticket" SET "lastReplyAt" = "updatedAt", "closedAt" = CASE WHEN "status" = \'CLOSED\' THEN "updatedAt" END');
      db.exec('UPDATE "TicketMessage" SET "isAdmin" = true WHERE "authorId" IN (SELECT "id" FROM "User" WHERE "role" = \'ADMIN\')');
      db.exec('UPDATE "Ticket" SET "status" = \'REPLIED\' WHERE "status" = \'OPEN\' AND (SELECT "isAdmin" FROM "TicketMessage" WHERE "ticketId" = "Ticket"."id" ORDER BY "id" DESC LIMIT 1) = true');
    })();
    db.close();
  }
} else {
  prisma('migrate', command === 'migrate' ? 'dev' : 'deploy', ...rest);
}

// 本地开发用 SQLite（DATABASE_URL=file:...），schema 由 scripts/sqlite-schema.mjs 生成，
// 使用 db push 同步表结构，不使用 prisma/migrations 中的 PostgreSQL 迁移。
import 'dotenv/config';
import { defineConfig } from 'prisma/config';
import { sqliteUrl } from './src/lib/sqlite-url.ts';

export default defineConfig({
  schema: 'prisma/sqlite/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL?.startsWith('file:') ? sqliteUrl(process.env.DATABASE_URL) : '',
  },
});

// 本地开发用 SQLite 客户端，仅在 DATABASE_URL=file:... 时动态加载，构建时单独输出。
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '../generated/prisma-sqlite/client.ts';
import type { PrismaClient as PgPrismaClient } from '../generated/prisma/client.ts';
import { sqliteUrl } from './sqlite-url.ts';

/**
 * 两份生成代码来自同一份模型定义、共用同一个运行时（Decimal、错误类型相同），
 * 对外统一使用 PostgreSQL 客户端的类型；方言差异见 lib/prisma.ts 中的辅助函数。
 */
export function createSqliteClient(url: string): PgPrismaClient {
  const client = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqliteUrl(url) }) });
  return client as unknown as PgPrismaClient;
}

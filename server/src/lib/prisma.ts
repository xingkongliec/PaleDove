import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.ts';
import { config } from '../config.ts';

/** DATABASE_URL=file:... 时使用 SQLite（仅用于本地开发） */
export const isSqlite = config.DATABASE_URL.startsWith('file:');

export const prisma: PrismaClient = isSqlite
  ? (await import('./prisma-sqlite.ts')).createSqliteClient(config.DATABASE_URL)
  : new PrismaClient({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });

/** 不区分大小写的包含匹配；SQLite 不支持 mode 参数，其 LIKE 对 ASCII 本身不区分大小写 */
export function containsInsensitive(value: string): { contains: string; mode?: Prisma.QueryMode } {
  return isSqlite ? { contains: value } : { contains: value, mode: 'insensitive' };
}

/** createMany 的 skipDuplicates 参数，SQLite 不支持 */
export const skipDuplicates: { skipDuplicates?: true } = isSqlite ? {} : { skipDuplicates: true };

export { Prisma } from '../generated/prisma/client.ts';
export * from '../generated/prisma/enums.ts';
export type {
  User,
  Node,
  NodeEgress,
  IpAddress,
  Image,
  Plan,
  Product,
  Instance,
  PortMapping,
  SiteBinding,
  Snapshot,
  Task,
  Volume,
  Order,
  BalanceLog,
  RedeemCode,
  Announcement,
  Payment,
  ProxySite,
  OAuthAccount,
  Passkey,
  Vpc,
  Coupon,
  RealNameVerification,
  ApiToken,
  AffLog,
  SshKey,
  MarketListing,
  Invoice,
} from '../generated/prisma/client.ts';

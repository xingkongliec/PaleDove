import { z } from 'zod';
import { hashPassword } from '../lib/crypto.ts';
import { isSqlite, prisma } from '../lib/prisma.ts';

export class AdminInitializationError extends Error {}

const identity = z.object({
  username: z.string().regex(/^[a-z][a-z0-9_]{2,31}$/),
  email: z.email(),
});
const placeholders = new Set(['admin123456', 'replace-with-a-strong-admin-password', 'change-me-to-a-long-random-string']);

/** 仅在数据库中完全没有管理员时创建；已有账号不读取或比较环境变量中的密码。 */
export async function initializeAdmin(env = process.env) {
  return prisma.$transaction(async (tx) => {
    // PostgreSQL 下将多个 API / Worker 容器的首次初始化串行化。
    if (!isSqlite) await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(1885432933, 1)`;
    const existing = await tx.user.findFirst({ where: { role: 'ADMIN' }, select: { username: true, email: true } });
    if (existing) return { created: false, ...existing };

    const parsed = identity.safeParse({
      username: (env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase(),
      email: (env.ADMIN_EMAIL ?? 'admin@example.com').trim().toLowerCase(),
    });
    if (!parsed.success) throw new AdminInitializationError('首次初始化管理员时，请设置有效的 ADMIN_USERNAME（3 至 32 位字母、数字或下划线，以字母开头）和 ADMIN_EMAIL。');
    const password = env.ADMIN_PASSWORD || (env.NODE_ENV === 'production' ? '' : 'admin123456');
    if (env.NODE_ENV === 'production' && (password.length < 12 || password.length > 128 || placeholders.has(password))) {
      throw new AdminInitializationError('数据库中尚无管理员，请在 .env 设置 12 至 128 个字符的 ADMIN_PASSWORD，不能使用示例占位符。');
    }
    const { username, email } = parsed.data;
    if (await tx.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } })) {
      throw new AdminInitializationError('ADMIN_USERNAME 或 ADMIN_EMAIL 已被普通用户使用，请为首次初始化的管理员设置其他用户名和邮箱。');
    }
    await tx.user.create({ data: { username, email, role: 'ADMIN', passwordHash: await hashPassword(password) } });
    return { created: true, username, email };
  }, { maxWait: 15_000, timeout: 15_000 });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { forbidden, notFound, unauthorized } from './errors.ts';
import { prisma, type User } from './prisma.ts';
import { m } from '../i18n/index.ts';
import { config } from '../config.ts';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

/**
 * PATCH：按创建时的字段做部分校验，只返回请求里实际传了的字段。
 * Zod 4 的 partial() 仍会为缺失字段填入 default() 并执行 transform，直接使用会把没传的字段重置为默认值。
 */
export function parsePatch<T extends z.ZodRawShape>(shape: T, data: unknown): Partial<z.infer<z.ZodObject<T>>> {
  const raw = (data ?? {}) as Record<string, unknown>;
  const parsed = z.object(shape).partial().parse(raw) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(parsed).filter(([k]) => Object.hasOwn(raw, k))) as Partial<z.infer<z.ZodObject<T>>>;
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(20),
});

export function paging(q: { page: number; pageSize: number }) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdmin(req: FastifyRequest): User {
  const user = requireUser(req);
  if (user.role !== 'ADMIN') throw forbidden();
  return user;
}

/** Fastify preHandler：要求登录 */
export async function authGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  requireUser(req);
}

/** 普通用户控制台与购买、充值等接口；管理员使用独立的管理接口 */
export async function consoleGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (requireUser(req).role !== 'USER') throw forbidden();
}

/** Fastify preHandler：要求管理员 */
export async function adminGuard(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  requireAdmin(req);
}

/** 面板对外地址：优先使用环境变量 PANEL_URL，其次根据请求推断（反向代理后需开启 TRUST_PROXY） */
export function panelUrl(req: FastifyRequest): string {
  return config.PANEL_URL ?? `${req.protocol}://${req.host}`;
}

/**
 * 发给未登录访客的邮件（找回密码、验证邮箱）里的链接地址。
 * 请求的 Host / X-Forwarded-Host 可以伪造：攻击者替受害者申请找回密码时把 Host 改成自己的域名，
 * 重置令牌就会落到攻击者手里。所以生产环境只使用 PANEL_URL，未配置时不发送（开发环境仍按请求地址）。
 */
export function mailBaseUrl(req: FastifyRequest): string {
  if (config.PANEL_URL) return config.PANEL_URL;
  if (config.isProd) throw new Error('PANEL_URL is not configured; refusing to build email links from the request Host header');
  return `${req.protocol}://${req.host}`;
}

export async function logActivity(req: FastifyRequest | null, userId: number | null, action: string, detail?: string): Promise<void> {
  await prisma.activityLog
    .create({ data: { userId, action, detail: detail?.slice(0, 1000) ?? null, ip: req?.ip ?? null } })
    .catch(() => undefined);
}

export function ensureFound<T>(value: T | null | undefined, message?: string): T {
  if (value === null || value === undefined) throw notFound(message);
  return value;
}

// 常用字段校验
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, m('v.hostname'));

export const instancePasswordSchema = z
  .string()
  .min(8, m('v.passwordMin'))
  .max(64, m('v.passwordMax'))
  .regex(/^[A-Za-z0-9!@#$%^&*()_+\-=.,:;?~]+$/, m('v.passwordChars'))
  .regex(/[A-Za-z]/, m('v.passwordLetter'))
  .regex(/[0-9]/, m('v.passwordDigit'));

export const sshKeysSchema = z
  .string()
  .max(16_000)
  .optional()
  .transform((v) =>
    (v ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  )
  .refine(
    (keys) => keys.every((k) => /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\n]*)?$/.test(k)),
    m('v.sshKey'),
  );

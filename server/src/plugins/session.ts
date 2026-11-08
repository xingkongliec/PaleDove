import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { localeStore, t } from '../i18n/index.ts';
import { normalizeLocale, type Locale } from '../shared/index.ts';
import { randomToken, sha256 } from '../lib/crypto.ts';
import { prisma, type User } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';

export const SESSION_COOKIE = 'pd_sid';
const ttlSec = () => config.SESSION_TTL_HOURS * 3600;

export interface SessionData {
  userId: number;
  createdAt: number;
  ip: string;
  userAgent: string;
  /** 最后活动时间（每分钟最多更新一次） */
  lastActiveAt?: number;
  /** 管理员以用户身份登录时，记录管理员信息与其原会话令牌 */
  impersonator?: { id: number; username: string; token: string };
}

declare module 'fastify' {
  interface FastifyRequest {
    user: User | null;
    session: SessionData | null;
    sessionToken: string | null;
  }
}

const key = (token: string) => `sess:${sha256(token)}`;
const userSetKey = (userId: number) => `user-sess:${userId}`;

export async function createSession(
  req: FastifyRequest,
  reply: FastifyReply,
  user: User,
  extra: Partial<SessionData> = {},
): Promise<string> {
  const token = randomToken();
  const data: SessionData = {
    userId: user.id,
    createdAt: Date.now(),
    ip: req.ip,
    userAgent: String(req.headers['user-agent'] ?? '').slice(0, 200),
    ...extra,
  };
  await redis.multi().set(key(token), JSON.stringify(data), 'EX', ttlSec()).sadd(userSetKey(user.id), sha256(token)).exec();
  // 每个账号最多保留最近活跃的 MAX_SESSIONS 个会话，更早的自动退出（例如脚本反复登录产生的会话）
  const all = await listUserSessions(user.id);
  if (all.length > MAX_SESSIONS) {
    const stale = all.sort(([, a], [, b]) => (b.lastActiveAt ?? b.createdAt) - (a.lastActiveAt ?? a.createdAt)).slice(MAX_SESSIONS);
    await redis.del(...stale.map(([h]) => `sess:${h}`));
    await redis.srem(userSetKey(user.id), ...stale.map(([h]) => h));
  }
  setSessionCookie(reply, token);
  return token;
}

const MAX_SESSIONS = 20;

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: ttlSec(),
  });
}

export async function readSession(token: string): Promise<SessionData | null> {
  const raw = await redis.get(key(token));
  return raw ? (JSON.parse(raw) as SessionData) : null;
}

export async function destroySession(token: string): Promise<void> {
  const raw = await redis.get(key(token));
  if (raw) {
    const data = JSON.parse(raw) as SessionData;
    await redis.srem(userSetKey(data.userId), sha256(token));
  }
  await redis.del(key(token));
}

/** 用户的全部有效会话（登录设备），清理已过期的记录；返回 [会话 ID（令牌哈希）, 会话数据] */
export async function listUserSessions(userId: number): Promise<[string, SessionData][]> {
  const hashes = await redis.smembers(userSetKey(userId));
  const rows = await Promise.all(hashes.map(async (h) => [h, await redis.get(`sess:${h}`)] as const));
  const expired = rows.filter(([, raw]) => !raw).map(([h]) => h);
  if (expired.length) await redis.srem(userSetKey(userId), ...expired);
  return rows.filter(([, raw]) => raw).map(([h, raw]) => [h, JSON.parse(raw!) as SessionData]);
}

/** 按会话 ID（令牌哈希）注销用户的某个会话 */
export async function destroyUserSession(userId: number, id: string): Promise<boolean> {
  if (!(await redis.smembers(userSetKey(userId))).includes(id)) return false;
  await redis.del(`sess:${id}`);
  await redis.srem(userSetKey(userId), id);
  return true;
}

/** 注销用户的全部会话（修改密码、禁用账户时） */
export async function destroyUserSessions(userId: number, exceptToken?: string): Promise<void> {
  const hashes = await redis.smembers(userSetKey(userId));
  const keep = exceptToken ? sha256(exceptToken) : null;
  const drop = hashes.filter((h) => h !== keep);
  if (drop.length) {
    await redis.del(...drop.map((h) => `sess:${h}`));
    await redis.srem(userSetKey(userId), ...drop);
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** API 令牌前缀 */
export const API_TOKEN_PREFIX = 'pd_';

/**
 * 判断权限用的请求路径：匹配到的路由模式（如 /api/instances/:id）。不能用原始的 req.url：
 * 路由匹配前会解码百分号编码，/api/%61uth/password 实际命中 /api/auth/password，按原始路径判断会被绕过。
 * 没有匹配到路由时（404）用解码后的路径。
 */
export function routePath(req: FastifyRequest) {
  const matched = req.routeOptions?.url;
  if (matched) return matched;
  const raw = req.url.split('?')[0]!;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** API 令牌不能访问的接口：登录与账号安全（密码、两步验证、会话、第三方登录）、令牌管理、实名认证 */
const TOKEN_FORBIDDEN = /^\/api\/(auth|tokens|realname)(\/|$)/;
/** 只读令牌额外禁止的查询接口：网页终端、实例 root 密码 */
const TOKEN_READ_ONLY_BLOCKED = /^\/api\/instances\/:id\/(terminal|credentials)$/;

/** Authorization: Bearer pd_... 个人 API 令牌（只用于普通用户的控制台接口） */
async function authenticateApiToken(req: FastifyRequest, raw: string) {
  const row = await prisma.apiToken.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
  if (!row || (row.expiresAt && row.expiresAt < new Date())) throw unauthorized(t('apiToken.invalid'));
  if (row.user.status !== 'ACTIVE' || row.user.role !== 'USER') throw forbidden(t('apiToken.userOnly'));
  const path = routePath(req);
  if (TOKEN_FORBIDDEN.test(path) && !(path === '/api/auth/me' && req.method === 'GET')) throw forbidden(t('apiToken.forbiddenPath'));
  // 只读令牌：只能查询；网页终端（root shell）与实例密码虽然是 GET 也不允许
  if (row.readOnly && (!SAFE_METHODS.has(req.method) || TOKEN_READ_ONLY_BLOCKED.test(path))) throw forbidden(t('apiToken.readOnly'));
  req.user = row.user;
  // 最近使用时间每分钟最多写一次
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    void prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date(), lastUsedIp: req.ip } }).catch(() => undefined);
  }
}

export default fp(async (app) => {
  app.decorateRequest('user', null);
  app.decorateRequest('session', null);
  app.decorateRequest('sessionToken', null);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    // API 令牌：以令牌所属用户的身份访问，不使用 Cookie，也不需要 CSRF 请求头
    const auth = req.headers.authorization;
    if (auth?.startsWith(`Bearer ${API_TOKEN_PREFIX}`)) return authenticateApiToken(req, auth.slice(7).trim());
    // CSRF 防护：写操作必须携带自定义请求头（跨站表单无法设置，且未开放 CORS）。
    // 安装脚本回调与支付网关回调使用令牌 / 签名认证，不依赖 Cookie，因此豁免。
    const exempt = req.url.startsWith('/api/agent/') || req.url.startsWith('/api/pay/');
    if (!exempt && !SAFE_METHODS.has(req.method) && req.headers['x-requested-with'] !== 'XMLHttpRequest') {
      throw forbidden(t('err.badOrigin'));
    }
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const session = await readSession(token);
    if (!session) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: session.userId } });
    if (!user || user.status !== 'ACTIVE') {
      await destroySession(token);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    req.user = user;
    req.session = session;
    req.sessionToken = token;
    // 同步用户语言偏好：显式切换时记录，未指定时沿用用户偏好
    const store = localeStore();
    if (store) {
      if (store.explicit && user.locale !== store.locale) {
        user.locale = store.locale;
        void prisma.user.update({ where: { id: user.id }, data: { locale: store.locale } }).catch(() => undefined);
      } else if (!store.explicit && user.locale) {
        store.locale = (normalizeLocale(user.locale) ?? store.locale) as Locale;
      }
    }
    // 滑动过期；最后活动时间最多每分钟写一次，同时更新 IP 以反映最近的来源
    if (Date.now() - (session.lastActiveAt ?? session.createdAt) > 60_000) {
      void redis.set(key(token), JSON.stringify({ ...session, lastActiveAt: Date.now(), ip: req.ip }), 'EX', ttlSec());
    } else {
      void redis.expire(key(token), ttlSec());
    }
  });
});

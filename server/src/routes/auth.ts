import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AVATAR_STYLES, AVATAR_VARIANTS, LOCALES, THEME_PREFERENCES, type AvatarStyle, emailDomainAllowed, isMaintenanceExempt, maintenanceState, maintenanceStartedAt, type LoginResultDTO, type PublicConfigDTO, type SessionDTO } from '../shared/index.ts';
import { config } from '../config.ts';
import { decrypt, encrypt, hashPassword, sha256, verifyPassword } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.ts';
import { authGuard, idParam, logActivity, mailBaseUrl, parse, requireUser } from '../lib/http.ts';
import { redis } from '../lib/redis.ts';
import { prisma, type User } from '../lib/prisma.ts';
import { getSetting, getSettings } from '../lib/settings.ts';
import { emailDomainError } from '../lib/email-domain.ts';
import { cached } from '../lib/cache.ts';
import { isMailConfigured, sendVerification, verifyEmailToken } from '../services/mail/mailer.ts';
import { createRegisteredUser } from '../services/registration.ts';
import { resolveReferrer } from '../services/aff.ts';
import { agreedDetail } from '../services/legal.ts';
import { siteIconUrl } from '../services/site-icon.ts';
import { generateRecoveryCodes, generateSecret, otpauthUrl, verifyTotp } from '../lib/totp.ts';
import { parseUserAgent } from '../lib/ua.ts';
import { m, t } from '../i18n/index.ts';
import {
  createSession,
  destroySession,
  destroyUserSession,
  destroyUserSessions,
  listUserSessions,
  readSession,
  SESSION_COOKIE,
  setSessionCookie,
} from '../plugins/session.ts';
import { activeProviders } from '../services/oauth.ts';
import { hasPassword, toMe } from '../services/serializers.ts';
import { listEnabledImages, listSalePlans, listSaleProducts } from './store.ts';
import { productPing } from '../services/agent/ping.ts';
import { getNightConfig } from '../services/night-market.ts';
import { saleNodes } from '../services/billing.ts';
import { publicPopups } from '../services/popups.ts';

const passwordSchema = z.string().min(8, m('v.passwordMin')).max(128, m('v.passwordTooLong'));
const countrySchema = z.string().regex(/^[A-Z]{2}$/, m('v.country'));

/** 建立会话并记录登录信息（密码登录、两步验证、第三方登录共用） */
export async function finishLogin(req: FastifyRequest, reply: FastifyReply, userId: number, action = 'auth.login', detail?: string) {
  const account = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (account.role !== 'ADMIN' && !account.emailVerifiedAt && (await getSettings()).requireEmailVerification) throw new AppError(403, 'EMAIL_NOT_VERIFIED', t('auth.emailNotVerified'));
  if (req.sessionToken) await destroySession(req.sessionToken);
  const updated = await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date(), lastLoginIp: req.ip } });
  await createSession(req, reply, updated);
  await logActivity(req, updated.id, action, detail);
  return { user: toMe(updated) };
}

// ───────── 按账号限制失败次数 ─────────
// 按 IP 的限流挡不住分散到大量 IP 的撞库与验证码爆破：同一账号 15 分钟内密码错 10 次、验证码错 5 次后暂停尝试。
// 账号不存在时同样计数，返回同样的提示，不泄露账号是否存在。
const FAIL_WINDOW_SEC = 15 * 60;
const PASSWORD_FAIL_MAX = 10;
const TOTP_FAIL_MAX = 5;
const passwordFailKey = (account: string) => `auth:fail:pw:${createHash('sha256').update(account).digest('hex').slice(0, 32)}`;
const totpFailKey = (userId: number) => `auth:fail:2fa:${userId}`;

async function assertNotLocked(key: string, max: number) {
  if (Number((await redis.get(key)) ?? 0) >= max) throw new AppError(429, 'TOO_MANY_ATTEMPTS', t('auth.tooManyAttempts', { minutes: FAIL_WINDOW_SEC / 60 }));
}

async function recordFailure(key: string) {
  const n = await redis.incr(key);
  if (n === 1) await redis.expire(key, FAIL_WINDOW_SEC);
}

/** 登录挑战令牌：userId.过期时间.签名 */
export function signChallenge(userId: number) {
  const body = `${userId}.${Date.now() + 5 * 60_000}`;
  return `${body}.${createHmac('sha256', config.APP_SECRET).update(`2fa:${body}`).digest('base64url')}`;
}
function readChallenge(token: string): number {
  const [uid, exp, sig] = token.split('.');
  const good = uid && exp && sig && createHmac('sha256', config.APP_SECRET).update(`2fa:${uid}.${exp}`).digest('base64url');
  const ok = !!good && good.length === sig!.length && timingSafeEqual(Buffer.from(good), Buffer.from(sig!)) && Number(exp) > Date.now();
  if (!ok) throw badRequest(t('twofa.challengeExpired'));
  return Number(uid);
}

/**
 * 校验两步验证码或恢复码，并立即记下已使用（时间步 / 剩余恢复码）。带读到的旧值做条件更新：
 * 同一个验证码 / 恢复码被并发提交时只有一次成功。失败返回 false
 */
async function useSecondFactor(user: Pick<User, 'id' | 'totpSecretEnc' | 'totpLastStep' | 'recoveryCodes'>, code: string) {
  const input = code.trim();
  if (/^\d{6}$/.test(input) && user.totpSecretEnc) {
    const step = verifyTotp(decrypt(user.totpSecretEnc), input);
    // 同一个时间步的验证码只能用一次
    if (step === null || (user.totpLastStep !== null && step <= user.totpLastStep)) return false;
    const r = await prisma.user.updateMany({ where: { id: user.id, totpLastStep: user.totpLastStep }, data: { totpLastStep: step } });
    return r.count > 0;
  }
  const hash = sha256(input.toLowerCase().replace(/\s/g, ''));
  const codes = JSON.parse(user.recoveryCodes || '[]') as string[];
  if (!codes.includes(hash)) return false;
  const r = await prisma.user.updateMany({ where: { id: user.id, recoveryCodes: user.recoveryCodes }, data: { recoveryCodes: JSON.stringify(codes.filter((c) => c !== hash)) } });
  return r.count > 0;
}

/** 管理员“以用户身份登录”时不能修改该用户的登录安全设置 */
export function requireOwnSession(req: FastifyRequest): User {
  const user = requireUser(req);
  if (req.session?.impersonator) throw forbidden(t('auth.noSecurityChangeWhileImpersonating'));
  return user;
}

export default async function authRoutes(app: FastifyInstance) {
  // 每个页面都会请求：与请求无关的部分缓存在 Redis（多进程共用，设置修改时立即失效）；维护状态随时间与登录用户变化，按请求计算
  app.get('/api/public/config', async (req): Promise<PublicConfigDTO> => {
    const { base, full } = await cached('settings', 'public-config', 300, async () => {
      const s = await getSettings();
      const base: Omit<PublicConfigDTO, 'maintenance' | 'popups'> = { nightMarketEnabled: (await getNightConfig()).enabled, siteName: s.siteName, icon: siteIconUrl(await getSetting('siteIcon')), avatarApiBase: s.avatarApiBase, nodeSwitchFee: s.nodeSwitchFee, allowRegister: s.allowRegister, requireEmailVerification: s.requireEmailVerification,
        allowTickets: s.allowTickets, signupBonus: s.signupBonus, emailDomainMode: s.emailDomainMode, emailDomains: s.emailDomainMode === 'OFF' ? [] : s.emailDomains, mailEnabled: isMailConfigured(await getSetting('mail')),
        currency: s.currency, footer: s.footer, oauth: await activeProviders(), legalRequireAgree: (await getSetting('legal')).requireAgree, affEnabled: s.affEnabled, affRateNew: s.affRateNew, affRateRenew: s.affRateRenew, marketEnabled: s.marketEnabled, marketFeeRate: s.marketFeeRate, marketMinDays: s.marketMinDays };
      return { base, full: await getSetting('maintenance') };
    });
    const { allowEmails: _allowEmails, ...maintenance } = full;
    const state = maintenanceState(full);
    return { ...base, popups: await publicPopups(), maintenance: state === 'off' ? null : { ...maintenance, state, startedAt: maintenanceStartedAt(full), exempt: isMaintenanceExempt(full, req.user?.email) } };
  });

  app.get('/api/site/icon', async (_req, reply) => {
    const icon = await getSetting('siteIcon');
    if (!icon.data) throw notFound(t('icon.empty'));
    return reply.type(icon.mime).header('cache-control', 'public, max-age=31536000, immutable')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .header('x-content-type-options', 'nosniff').send(Buffer.from(icon.data, 'base64'));
  });

  // 首页展示的在售套餐，无需登录（内容与登录后的购买页一致）
  app.get('/api/public/plans', listSalePlans);
  app.get('/api/public/products', listSaleProducts);
  app.get('/api/public/images', listEnabledImages);
  // 购买页「选择节点」：产品在某地区的宿主机与各自能开通的套餐
  app.get('/api/public/products/:id/nodes', async (req) => {
    const { id } = parse(idParam, req.params);
    const { region } = parse(z.object({ region: z.string().trim().min(1).max(64) }), req.query);
    return { nodes: await saleNodes(id, region) };
  });
  // 购买页「节点测试」：产品在某地区启用了测试的宿主机的最近一次结果
  app.get('/api/public/products/:id/ping', async (req) => {
    const { id } = parse(idParam, req.params);
    const { region } = parse(z.object({ region: z.string().trim().max(64).optional() }), req.query);
    return productPing(id, region);
  });

  // 统一登录入口：管理员与普通用户使用同一接口，前端根据角色跳转
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply): Promise<LoginResultDTO> => {
      const body = parse(
        z.object({ account: z.string().trim().min(1, m('v.accountRequired')), password: z.string().min(1, m('v.passwordRequired')) }),
        req.body,
      );
      const account = body.account.toLowerCase();
      await assertNotLocked(passwordFailKey(account), PASSWORD_FAIL_MAX);
      const user = await prisma.user.findFirst({ where: { OR: [{ email: account }, { username: account }] } });
      if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
        await recordFailure(passwordFailKey(account));
        await logActivity(req, user?.id ?? null, 'auth.login_failed', `account: ${account}`);
        throw unauthorized(t('auth.invalidCredentials'));
      }
      await redis.del(passwordFailKey(account));
      if (user.status !== 'ACTIVE') throw forbidden(t('auth.disabled'));
      if (user.role !== 'ADMIN' && !user.emailVerifiedAt && (await getSettings()).requireEmailVerification) throw new AppError(403, 'EMAIL_NOT_VERIFIED', t('auth.emailNotVerified'));
      // 已启用两步验证：先不建立会话，返回挑战令牌，由 /api/auth/login/2fa 凭验证码完成登录
      if (user.totpEnabledAt) return { needTotp: true, challenge: signChallenge(user.id) };
      return finishLogin(req, reply, user.id);
    },
  );

  app.post(
    '/api/auth/login/2fa',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply): Promise<LoginResultDTO> => {
      const body = parse(z.object({ challenge: z.string().min(10).max(512), code: z.string().trim().min(6, m('twofa.codeRequired')).max(16) }), req.body);
      const userId = readChallenge(body.challenge);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user || user.status !== 'ACTIVE' || !user.totpEnabledAt) throw badRequest(t('twofa.challengeExpired'));
      await assertNotLocked(totpFailKey(user.id), TOTP_FAIL_MAX);
      if (!(await useSecondFactor(user, body.code))) {
        await recordFailure(totpFailKey(user.id));
        await logActivity(req, user.id, 'auth.login_failed', '2fa');
        throw badRequest(t('twofa.invalidCode'));
      }
      await redis.del(totpFailKey(user.id));
      return finishLogin(req, reply, user.id);
    },
  );

  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const settings = await getSettings();
      if (!settings.allowRegister) throw forbidden(t('auth.registerClosed'));
      const body = parse(
        z.object({
          email: z.email(m('v.email')).trim().toLowerCase(),
          username: z
            .string()
            .trim()
            .toLowerCase()
            .regex(/^[a-z][a-z0-9_]{2,31}$/, m('v.username')),
          password: passwordSchema,
          agreeTerms: z.boolean().optional(),
          aff: z.string().trim().max(16).optional(),
        }),
        req.body,
      );
      if (!emailDomainAllowed(body.email, { mode: settings.emailDomainMode, domains: settings.emailDomains })) throw badRequest(emailDomainError(settings));
      const legal = await getSetting('legal');
      if (legal.requireAgree && !body.agreeTerms) throw badRequest(t('legal.agreeRequired'));
      const exists = await prisma.user.findFirst({ where: { OR: [{ email: body.email }, { username: body.username }] } });
      if (exists) throw conflict(exists.email === body.email ? t('auth.emailTaken') : t('auth.usernameTaken'));
      const user = await createRegisteredUser({ email: body.email, username: body.username, passwordHash: await hashPassword(body.password),
        emailVerifiedAt: settings.requireEmailVerification ? null : new Date() }, settings, await resolveReferrer(body.aff));
      await logActivity(req, user.id, 'auth.register', body.agreeTerms ? agreedDetail(legal) : undefined);
      if (settings.requireEmailVerification) {
        const mailSent = await sendVerification(user, mailBaseUrl(req)).catch((error) => { req.log.error({ err: error }, 'verification email failed'); return false; });
        return { needVerify: true, mailSent };
      }
      await createSession(req, reply, user);
      return { needVerify: false, user: toMe(user) };
    },
  );

  app.post('/api/auth/verify-email', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = parse(z.object({ token: z.string().min(16).max(128) }), req.body);
    await verifyEmailToken(token);
    return { ok: true };
  });
  app.post('/api/auth/resend-verification', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const { email } = parse(z.object({ email: z.email().trim().toLowerCase() }), req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (user && !user.emailVerifiedAt && user.status === 'ACTIVE') {
      const last = await prisma.emailVerificationToken.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
      if (!last || Date.now() - last.createdAt.getTime() >= 60_000) await sendVerification(user, mailBaseUrl(req)).catch((error) => req.log.error({ err: error }, 'verification resend failed'));
    }
    // 不泄露邮箱是否已经注册。
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionToken) await destroySession(req.sessionToken);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    if (!req.user) return { user: null };
    const imp = req.session?.impersonator;
    return { user: toMe(req.user, imp ? { id: imp.id, username: imp.username } : null) };
  });

  // 结束“以用户身份登录”，恢复管理员会话
  app.post('/api/auth/stop-impersonate', { preHandler: authGuard }, async (req, reply) => {
    const imp = req.session?.impersonator;
    if (!imp) throw badRequest(t('auth.notImpersonating'));
    const adminSession = await readSession(imp.token);
    if (req.sessionToken) await destroySession(req.sessionToken);
    if (!adminSession) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      throw unauthorized(t('auth.adminSessionExpired'));
    }
    setSessionCookie(reply, imp.token);
    const admin = await prisma.user.findUniqueOrThrow({ where: { id: imp.id } });
    return { user: toMe(admin) };
  });

  app.put('/api/auth/password', { preHandler: authGuard, config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async (req) => {
    const user = requireOwnSession(req);
    // 第三方登录注册的账号没有本地密码：没有找回密码邮件，直接设置密码，不需要原密码
    const own = hasPassword(user);
    const body = parse(z.object({ oldPassword: own ? z.string().min(1, m('v.passwordRequired')) : z.string().optional(), newPassword: passwordSchema }), req.body);
    if (own && !(await verifyPassword(user.passwordHash, body.oldPassword ?? ''))) throw badRequest(t('auth.wrongOldPassword'));
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
    await destroyUserSessions(user.id, req.sessionToken ?? undefined);
    await logActivity(req, user.id, 'account.password');
    return { ok: true };
  });

  app.put('/api/auth/profile', { preHandler: authGuard }, async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        name: z.string().trim().max(32, m('v.tooLong')).optional(),
        locale: z.enum(LOCALES).optional(),
        country: countrySchema.optional(),
        theme: z.enum(THEME_PREFERENCES).optional(),
        announceEmail: z.boolean().optional(),
        balanceAlert: z.boolean().optional(),
        alertEmail: z.boolean().optional(),
        avatarStyle: z.enum(AVATAR_STYLES as [AvatarStyle, ...AvatarStyle[]]).optional(),
        avatarVariant: z.number().int().min(0).max(AVATAR_VARIANTS - 1).optional(),
      }),
      req.body,
    );
    const u = await prisma.user.update({ where: { id: user.id }, data: { ...body, ...(body.name !== undefined ? { name: body.name || null } : {}) } });
    return { user: toMe(u) };
  });

  // ───────────── 登录设备 ─────────────

  /** 当前账号的所有登录会话：设备、IP、最后活动 */
  app.get('/api/auth/sessions', { preHandler: authGuard }, async (req): Promise<{ items: SessionDTO[] }> => {
    const user = requireOwnSession(req);
    const current = req.sessionToken ? sha256(req.sessionToken) : null;
    const rows = await listUserSessions(user.id);
    return {
      items: rows
        // 管理员“以用户身份登录”产生的会话属于管理员，不列出
        .filter(([, s]) => !s.impersonator)
        .map(([id, s]) => ({
          id,
          ...parseUserAgent(s.userAgent),
          ip: s.ip || null,
          createdAt: new Date(s.createdAt).toISOString(),
          lastActiveAt: new Date(s.lastActiveAt ?? s.createdAt).toISOString(),
          current: id === current,
        })),
    };
  });

  /** 退出其他所有设备（保留当前会话） */
  app.post('/api/auth/sessions/revoke-others', { preHandler: authGuard }, async (req) => {
    const user = requireOwnSession(req);
    await destroyUserSessions(user.id, req.sessionToken ?? undefined);
    await logActivity(req, user.id, 'account.session_revoke_all');
    return { ok: true };
  });

  /** 退出指定设备；当前设备请用退出登录 */
  app.delete('/api/auth/sessions/:id', { preHandler: authGuard }, async (req) => {
    const user = requireOwnSession(req);
    const { id } = parse(z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }), req.params);
    if (req.sessionToken && id === sha256(req.sessionToken)) throw badRequest(t('account.cannotRevokeCurrent'));
    if (!(await destroyUserSession(user.id, id))) throw notFound(t('account.sessionNotFound'));
    await logActivity(req, user.id, 'account.session_revoke');
    return { ok: true };
  });

  // ───────────── 两步验证（TOTP） ─────────────

  app.get('/api/auth/2fa', { preHandler: authGuard }, async (req) => {
    const user = requireUser(req);
    return { enabled: !!user.totpEnabledAt, enabledAt: user.totpEnabledAt?.toISOString() ?? null, recoveryRemaining: (JSON.parse(user.recoveryCodes || '[]') as string[]).length };
  });

  /** 开始设置：生成新密钥（未确认前不生效），返回密钥和 otpauth 链接供认证器扫描 */
  app.post('/api/auth/2fa/setup', { preHandler: authGuard }, async (req) => {
    const user = requireOwnSession(req);
    if (user.totpEnabledAt) throw conflict(t('twofa.alreadyEnabled'));
    const site = await getSettings();
    const secret = generateSecret();
    await prisma.user.update({ where: { id: user.id }, data: { totpSecretEnc: encrypt(secret), totpLastStep: null } });
    return { secret, otpauthUrl: otpauthUrl(secret, user.email, site.siteName) };
  });

  /** 输入认证器里的验证码确认绑定，成功后返回一次性展示的恢复码 */
  app.post('/api/auth/2fa/enable', { preHandler: authGuard, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const user = requireOwnSession(req);
    const { code } = parse(z.object({ code: z.string().trim().regex(/^\d{6}$/, m('twofa.codeSix')) }), req.body);
    if (user.totpEnabledAt) throw conflict(t('twofa.alreadyEnabled'));
    if (!user.totpSecretEnc) throw badRequest(t('twofa.setupFirst'));
    const step = verifyTotp(decrypt(user.totpSecretEnc), code);
    if (step === null) throw badRequest(t('twofa.enableWrongCode'));
    const recovery = generateRecoveryCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabledAt: new Date(), totpLastStep: step, recoveryCodes: JSON.stringify(recovery.map((c) => sha256(c))) },
    });
    await logActivity(req, user.id, 'account.2fa_enable');
    return { recoveryCodes: recovery };
  });

  /** 关闭 / 重新生成恢复码：需要登录密码 + 验证码（或恢复码） */
  const confirmSensitive = async (req: FastifyRequest) => {
    const user = requireOwnSession(req);
    const body = parse(z.object({ password: z.string().min(1, m('v.passwordRequired')), code: z.string().trim().min(6, m('twofa.codeRequired')).max(16) }), req.body);
    if (!user.totpEnabledAt) throw badRequest(t('twofa.notEnabled'));
    if (!(await verifyPassword(user.passwordHash, body.password))) throw badRequest(t('twofa.wrongPassword'));
    if (!(await useSecondFactor(user, body.code))) throw badRequest(t('twofa.invalidCode'));
    return { user };
  };

  app.post('/api/auth/2fa/disable', { preHandler: authGuard, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const { user } = await confirmSensitive(req);
    await prisma.user.update({ where: { id: user.id }, data: { totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null, recoveryCodes: '[]' } });
    await logActivity(req, user.id, 'account.2fa_disable');
    return { ok: true };
  });

  app.post('/api/auth/2fa/recovery', { preHandler: authGuard, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req) => {
    const { user } = await confirmSensitive(req);
    const recovery = generateRecoveryCodes();
    // 刚用掉的时间步 / 恢复码已经在 confirmSensitive 里记下，这里整体换成新的恢复码
    await prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: JSON.stringify(recovery.map((c) => sha256(c))) } });
    await logActivity(req, user.id, 'account.2fa_recovery');
    return { recoveryCodes: recovery };
  });
}

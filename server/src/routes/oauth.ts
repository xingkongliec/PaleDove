import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { emailDomainAllowed, loginLanding } from '../shared/index.ts';
import { randomToken } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { logActivity, panelUrl, parse, requireUser } from '../lib/http.ts';
import { prisma, type User } from '../lib/prisma.ts';
import { getSetting, getSettings } from '../lib/settings.ts';
import { emailDomainError } from '../lib/email-domain.ts';
import { t } from '../i18n/index.ts';
import { authorizeUrl, fetchProfile, listProviders, oauthRequirement, packFlow, providerName, safeNext, unpackFlow, type OAuthProfile } from '../services/oauth.ts';
import { hasPassword } from '../services/serializers.ts';
import { finishLogin, signChallenge } from './auth.ts';
import { createRegisteredUser } from '../services/registration.ts';
import { resolveReferrer } from '../services/aff.ts';

const FLOW_COOKIE = 'pd_oauth';

/** 第三方登录（GitHub / Google / 自定义 OAuth 2.0）：授权码流程，state 放在签名 Cookie 里防 CSRF */
export default async function oauthRoutes(app: FastifyInstance) {
  const fail = (reply: FastifyReply, message: string, linkBase: string | null = null) =>
    reply.redirect(linkBase ? `${linkBase}&oauth_error=${encodeURIComponent(message)}` : `/login?error=${encodeURIComponent(message)}`);
  const accountPage = (role?: string) => `${role === 'ADMIN' ? '/admin/account' : '/console/account'}?tab=connections`;

  app.get('/api/auth/oauth/:provider/start', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = parse(z.object({ next: z.string().optional(), link: z.string().optional(), aff: z.string().trim().max(16).optional() }), req.query);
    // 绑定流程必须已登录
    const link = q.link === '1' ? requireUser(req).id : null;
    const state = randomToken(16);
    // 提供商不存在或未启用时这里会报错
    const url = await authorizeUrl(panelUrl(req), provider, state);
    reply.setCookie(FLOW_COOKIE, packFlow({ state, provider, next: safeNext(q.next), link, aff: q.aff || undefined }), {
      path: '/api/auth/oauth',
      httpOnly: true,
      sameSite: 'lax',
      secure: panelUrl(req).startsWith('https://'),
      maxAge: 600,
    });
    return reply.redirect(url);
  });

  app.get('/api/auth/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const q = parse(z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }), req.query);
    const flow = unpackFlow(req.cookies[FLOW_COOKIE]);
    reply.clearCookie(FLOW_COOKIE, { path: '/api/auth/oauth' });
    const linkBase = flow?.link ? accountPage(req.user?.role) : null;
    if (!flow || flow.provider !== provider || !q.state || q.state !== flow.state) return fail(reply, t('oauth.flowExpired'), linkBase);
    const label = await providerName(provider);
    if (q.error || !q.code) return fail(reply, t('oauth.cancelled', { name: label }), linkBase);

    let profile: OAuthProfile;
    try {
      profile = await fetchProfile(panelUrl(req), provider, q.code);
    } catch (e) {
      return fail(reply, (e as Error).message, linkBase);
    }

    // 绑定到当前登录的账号
    if (flow.link) {
      if (req.user?.id !== flow.link) return fail(reply, t('oauth.loginFirst'), accountPage(req.user?.role));
      const exist = await prisma.oAuthAccount.findUnique({ where: { provider_providerId: { provider, providerId: profile.providerId } } });
      if (exist && exist.userId !== flow.link) return fail(reply, t('oauth.boundToOther', { name: label }), accountPage(req.user.role));
      // 每种登录方式只能绑定一个账号，换绑要先解绑
      if (!exist && (await prisma.oAuthAccount.findFirst({ where: { userId: flow.link, provider } }))) return fail(reply, t('oauth.alreadyBound', { name: label }), accountPage(req.user.role));
      if (!exist) {
        await prisma.oAuthAccount.create({ data: { userId: flow.link, provider, providerId: profile.providerId, email: profile.email, name: profile.name } });
        await logActivity(req, flow.link, 'account.oauth_bind', label);
      }
      return reply.redirect(`${accountPage(req.user.role)}&linked=${encodeURIComponent(provider)}`);
    }

    // 登录：先按绑定关系找，再按已验证邮箱找，都没有则（在开放注册时）创建账号
    let user: User | null = (await prisma.oAuthAccount.findUnique({ where: { provider_providerId: { provider, providerId: profile.providerId } }, include: { user: true } }))?.user ?? null;
    if (!user) {
      // 提供商没有返回可信的邮箱：不能据此找到或创建账号，只能先登录再绑定
      if (!profile.trustedEmail || !profile.email) return fail(reply, t('oauth.notLinked', { name: label }));
      user = await prisma.user.findUnique({ where: { email: profile.email } });
      if (user) {
        // 对方已验证该邮箱，可以自动绑定到同一邮箱的账号
        await prisma.oAuthAccount.create({ data: { userId: user.id, provider, providerId: profile.providerId, email: profile.email, name: profile.name } });
        user = await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
      } else {
        const site = await getSettings();
        if (!site.allowRegister) return fail(reply, t('auth.registerClosed'));
        if (!emailDomainAllowed(profile.email, { mode: site.emailDomainMode, domains: site.emailDomains })) return fail(reply, emailDomainError(site));
        user = await createOAuthUser(provider, { ...profile, email: profile.email }, await resolveReferrer(flow.aff));
        await logActivity(req, user.id, 'auth.register', label);
      }
    }
    if (user.status !== 'ACTIVE') return fail(reply, t('auth.disabled'));
    if (!user.emailVerifiedAt && user.role !== 'ADMIN' && (await getSettings()).requireEmailVerification) return fail(reply, t('auth.emailNotVerified'));

    const next = flow.next ? `&next=${encodeURIComponent(flow.next)}` : '';
    // 启用了两步验证：同样需要验证码，凭挑战令牌回到登录页完成
    if (user.totpEnabledAt) return reply.redirect(`/login?challenge=${encodeURIComponent(signChallenge(user.id))}${next}`);
    await finishLogin(req, reply, user.id, 'auth.login', label);
    // 带上标记，前端据此提示“登录成功”
    const landing = loginLanding(user.role, flow.next);
    return reply.redirect(`${landing}${landing.includes('?') ? '&' : '?'}signed_in=1`);
  });

  /** 用户名：取第三方账号的名称，转成小写字母、数字、下划线，重名时加数字后缀 */
  async function uniqueUsername(preferred: string): Promise<string> {
    let base = preferred.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24);
    if (!/^[a-z]/.test(base)) base = `u${base}`;
    if (base.length < 3) base = `${base}user`;
    for (let i = 0; i < 20; i++) {
      const name = i === 0 ? base : `${base}_${Math.floor(1000 + Math.random() * 9000)}`;
      if (!(await prisma.user.findUnique({ where: { username: name } }))) return name;
    }
    return `u${randomToken(8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  }

  async function createOAuthUser(provider: string, p: OAuthProfile & { email: string }, referrerId: number | null) {
    return createRegisteredUser({
        email: p.email,
        username: await uniqueUsername(p.email.split('@')[0]!),
        name: p.name.slice(0, 32) || null,
        // 没有本地密码：oauth$ 前缀不是合法哈希，密码登录必然失败；用户可在「账号设置 → 安全设置」中设置密码
        passwordHash: `oauth$${randomToken()}`,
        emailVerifiedAt: new Date(),
        oauthAccounts: { create: { provider, providerId: p.providerId, email: p.email, name: p.name } },
    }, await getSettings(), referrerId);
  }

  /** 自定义登录方式的图标（公开，登录页用）。SVG 可能带脚本：加 sandbox CSP，直接打开也不会执行 */
  app.get('/api/auth/oauth/:provider/icon', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const icon = (await getSetting('oauthIcons')).icons[provider];
    if (!icon) throw notFound(t('oauth.noIcon'));
    return reply
      .header('content-type', icon.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(Buffer.from(icon.data, 'base64'));
  });

  // ───────────── 账号设置：已绑定的第三方账号 ─────────────

  app.get('/api/auth/oauth/accounts', async (req) => {
    const user = requireUser(req);
    const [o, items, requirement] = await Promise.all([
      getSetting('oauth'),
      prisma.oAuthAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } }),
      oauthRequirement(user.id),
    ]);
    const required = new Set(requirement.required.map((p) => p.id));
    // 已启用的登录方式，加上已经绑定但提供商已停用 / 删除的（以便解绑）
    const providers = listProviders(o).filter((p) => p.active || items.some((i) => i.provider === p.id));
    for (const i of items) if (!providers.some((p) => p.id === i.provider)) providers.push({ id: i.provider, name: i.provider, active: false, icon: null });
    return {
      providers: providers.map((p) => {
        const a = items.find((i) => i.provider === p.id);
        return { id: p.id, name: p.name, icon: p.icon, active: p.active, required: required.has(p.id), account: a ? { email: a.email, name: a.name, createdAt: a.createdAt.toISOString() } : null };
      }),
      requirement,
      hasPassword: hasPassword(user),
    };
  });

  /** 购买实例前必须绑定的第三方账号（控制台顶部提示用） */
  app.get('/api/auth/oauth/requirement', async (req) => oauthRequirement(requireUser(req).id));

  app.delete('/api/auth/oauth/:provider', async (req) => {
    const user = requireUser(req);
    if (req.session?.impersonator) throw badRequest(t('auth.noSecurityChangeWhileImpersonating'));
    const { provider } = req.params as { provider: string };
    const all = await prisma.oAuthAccount.findMany({ where: { userId: user.id } });
    if (!all.some((a) => a.provider === provider)) throw badRequest(t('oauth.notBound'));
    // 没有设置过密码的账号至少保留一种登录方式
    if (!hasPassword(user) && all.length <= 1) throw badRequest(t('oauth.lastLogin'));
    await prisma.oAuthAccount.deleteMany({ where: { userId: user.id, provider } });
    await logActivity(req, user.id, 'account.oauth_unbind', await providerName(provider));
    return { ok: true };
  });
}

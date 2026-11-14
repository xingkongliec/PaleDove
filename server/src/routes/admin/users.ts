import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseIpv6List, ROLES, USER_STATUSES, type AdminUserDetailDTO, type AdminUserInstanceDTO, type AdminUserOAuthAccountDTO, type AdminUserSecurityDTO, type AdminUserSessionDTO } from '../../shared/index.ts';
import { toPasskey } from '../passkeys.ts';
import { hashPassword } from '../../lib/crypto.ts';
import { badRequest, conflict } from '../../lib/errors.ts';
import { adminGuard, ensureFound, idParam, logActivity, pageQuery, paging, parse, requireAdmin } from '../../lib/http.ts';
import { containsInsensitive, prisma, Prisma } from '../../lib/prisma.ts';
import { getSetting } from '../../lib/settings.ts';
import { parseUserAgent } from '../../lib/ua.ts';
import { createSession, destroyUserSession, destroyUserSessions, listUserSessions } from '../../plugins/session.ts';
import { changeBalance } from '../../services/billing.ts';
import { adminUserNightMarket, resetUserNightMarket } from '../../services/night-market.ts';
import { listProviders, type ProviderInfo } from '../../services/oauth.ts';
import { money, toAdminUser, toMe } from '../../services/serializers.ts';
import { m, t } from '../../i18n/index.ts';

const userInclude = {
  _count: { select: { instances: { where: { status: { not: 'DELETED' as const } } } } },
  oauthAccounts: { select: { provider: true }, orderBy: { createdAt: 'asc' as const } },
};

/** 第三方登录提供商的显示信息；提供商已被删除时只有 ID */
function providerView(providers: ProviderInfo[], id: string) {
  const p = providers.find((x) => x.id === id);
  return { provider: id, providerName: p?.name ?? id, icon: p?.icon ?? null, active: !!p?.active, removed: !p };
}

const oauthProviders = async () => listProviders(await getSetting('oauth'));

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>;
const adminUser = (u: UserRow, providers: ProviderInfo[]) => toAdminUser(u, u.oauthAccounts.map((a) => providerView(providers, a.provider)));
/** 只用第三方账号注册的用户没有本地密码 */
const hasPassword = (u: { passwordHash: string }) => !u.passwordHash.startsWith('oauth$');

export default async function adminUserRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.post('/api/admin/users/:id/verify-email', async (req) => {
    const admin = requireAdmin(req); const { id } = parse(idParam, req.params);
    await prisma.user.update({ where: { id }, data: { emailVerifiedAt: new Date() } });
    await logActivity(req, admin.id, 'admin.user_verify_email', String(id));
    return { ok: true };
  });

  app.get('/api/admin/users', async (req) => {
    const q = parse(pageQuery.extend({ q: z.string().trim().optional(), role: z.enum(ROLES).optional(), status: z.enum(USER_STATUSES).optional() }), req.query);
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { username: containsInsensitive(q.q) },
              { email: containsInsensitive(q.q) },
              { name: containsInsensitive(q.q) },
              ...(/^\d+$/.test(q.q) ? [{ id: Number(q.q) }] : []),
            ],
          }
        : {}),
    };
    const [items, total, providers] = await Promise.all([
      prisma.user.findMany({ where, include: userInclude, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.user.count({ where }),
      oauthProviders(),
    ]);
    return { items: items.map((u) => adminUser(u, providers)), total, page: q.page, pageSize: q.pageSize };
  });

  /** 用户详情：账号信息和资源用量 */
  app.get('/api/admin/users/:id', async (req): Promise<AdminUserDetailDTO> => {
    const { id } = parse(idParam, req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id }, include: userInclude }), t('user.notFound'));
    const alive = { userId: id, status: { not: 'DELETED' as const } };
    const [providers, specs, running, ports, sites, snapshots, spending, recharge, registration] = await Promise.all([
      oauthProviders(),
      prisma.instance.aggregate({ where: alive, _count: true, _sum: { cpu: true, memory: true, disk: true } }),
      prisma.instance.count({ where: { userId: id, status: 'RUNNING' } }),
      prisma.portMapping.count({ where: { instance: alive } }),
      prisma.siteBinding.count({ where: { instance: alive } }),
      prisma.snapshot.count({ where: { instance: alive } }),
      // 与用户费用中心保持相同口径，退款抵扣消费，充值包含兑换码到账。
      prisma.balanceLog.aggregate({ where: { userId: id, type: { in: ['PURCHASE', 'RENEW', 'REFUND', 'TRANSFER', 'TRAFFIC', 'MARKET', 'SWITCH'] } }, _sum: { amount: true } }),
      prisma.balanceLog.aggregate({ where: { userId: id, type: { in: ['RECHARGE', 'REDEEM'] } }, _sum: { amount: true } }),
      prisma.activityLog.findFirst({ where: { userId: id, action: 'auth.register' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { ip: true } }),
    ]);
    const totalSpend = spending._sum.amount;
    return {
      user: adminUser(user, providers),
      billing: { totalSpend: money(totalSpend?.isNegative() ? totalSpend.abs() : null), totalRecharge: money(recharge._sum.amount) },
      profile: { registrationIp: registration?.ip ?? null, locale: user.locale, country: user.country },
      usage: { instances: specs._count, running, ports, sites, snapshots, cpu: specs._sum.cpu ?? 0, memory: specs._sum.memory ?? 0, disk: specs._sum.disk ?? 0 },
      hasPassword: hasPassword(user),
    };
  });

  /** 用户的实例（未删除的） */
  app.get('/api/admin/users/:id/instances', async (req): Promise<{ items: AdminUserInstanceDTO[] }> => {
    const { id } = parse(idParam, req.params);
    const rows = await prisma.instance.findMany({
      where: { userId: id, status: { not: 'DELETED' } },
      include: { node: { select: { name: true } }, plan: { select: { name: true } }, image: { select: { name: true, family: true } }, ipAddress: { select: { address: true } } },
      orderBy: { id: 'desc' },
    });
    return {
      items: rows.map((i) => ({
        id: i.id,
        name: i.name,
        hostname: i.hostname,
        type: i.type,
        status: i.status,
        suspendReason: i.suspendReason,
        nodeName: i.node.name,
        planName: i.plan?.name ?? null,
        imageName: i.image?.name ?? null,
        family: i.image?.family ?? null,
        ip: i.ipAddress?.address ?? parseIpv6List(i.publicIpv6)[0] ?? null,
        cpu: i.cpu,
        memory: i.memory,
        disk: i.disk,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    };
  });

  app.get('/api/admin/users/:id/night-market', async req => {
    const { id } = parse(idParam, req.params);
    return adminUserNightMarket(id);
  });

  app.post('/api/admin/users/:id/night-market/reset', async req => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ periodId: z.number().int().positive(), offerIds: z.array(z.number().int().positive()).max(6).refine(ids => new Set(ids).size === ids.length) }).strict(), req.body);
    const result = await resetUserNightMarket(id, body);
    await logActivity(req, requireAdmin(req).id, 'admin.user_night_market_reset', `user #${id}; period #${body.periodId}; retained=${result.retainedOffers}; canceledInvoices=${result.canceledInvoices}`);
    return result;
  });

  /** 用户的登录设备（有效会话），含管理员代登录产生的会话 */
  app.get('/api/admin/users/:id/sessions', async (req): Promise<{ items: AdminUserSessionDTO[] }> => {
    const { id } = parse(idParam, req.params);
    const rows = await listUserSessions(id);
    return {
      items: rows
        .map(([sid, s]) => ({
          id: sid,
          ...parseUserAgent(s.userAgent),
          ip: s.ip || null,
          createdAt: new Date(s.createdAt).toISOString(),
          lastActiveAt: new Date(s.lastActiveAt ?? s.createdAt).toISOString(),
          impersonatedBy: s.impersonator?.username ?? null,
        }))
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
    };
  });

  /** 强制下线：退出该用户的某个设备或全部设备（不传 sessionId 即全部）；管理员对自己操作时保留当前会话 */
  app.post('/api/admin/users/:id/sessions/revoke', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { sessionId } = parse(z.object({ sessionId: z.string().regex(/^[a-f0-9]{64}$/).optional() }), req.body ?? {});
    const user = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    let count: number;
    if (sessionId) count = (await destroyUserSession(id, sessionId)) ? 1 : 0;
    else {
      const self = id === admin.id;
      count = Math.max(0, (await listUserSessions(id)).length - (self ? 1 : 0));
      await destroyUserSessions(id, self ? (req.sessionToken ?? undefined) : undefined);
    }
    await logActivity(req, admin.id, sessionId ? 'admin.user_session_revoke' : 'admin.user_sessions_revoke', `${user.username} ${count}`);
    return { count };
  });

  // ───────── 两步验证与通行密钥 ─────────

  /** 两步验证状态（是否启用、剩余恢复码）与通行密钥列表 */
  app.get('/api/admin/users/:id/security', async (req): Promise<AdminUserSecurityDTO> => {
    const { id } = parse(idParam, req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id }, include: { passkeys: { orderBy: { id: 'asc' } } } }), t('user.notFound'));
    return {
      twofa: {
        enabled: !!user.totpEnabledAt,
        enabledAt: user.totpEnabledAt?.toISOString() ?? null,
        recoveryRemaining: (JSON.parse(user.recoveryCodes || '[]') as string[]).length,
      },
      passkeys: user.passkeys.map(toPasskey),
    };
  });

  /** 关闭两步验证（用户丢失认证器与恢复码时由管理员重置）：清除密钥与恢复码，用户可以重新设置 */
  app.post('/api/admin/users/:id/2fa/disable', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    if (!user.totpEnabledAt && !user.totpSecretEnc) throw badRequest(t('twofa.notEnabled'));
    await prisma.user.update({ where: { id }, data: { totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null, recoveryCodes: '[]' } });
    await logActivity(req, admin.id, 'admin.user_2fa_disable', user.username);
    return { ok: true };
  });

  /** 删除用户的通行密钥：指定 ID 删除一个，不指定删除全部 */
  app.delete('/api/admin/users/:id/passkeys', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    const { count } = await prisma.passkey.deleteMany({ where: { userId: id } });
    await logActivity(req, admin.id, 'admin.user_passkeys_remove', `${user.username} ${count}`);
    return { count };
  });

  app.delete('/api/admin/users/:id/passkeys/:pid', async (req) => {
    const admin = requireAdmin(req);
    const { id, pid } = parse(z.object({ id: z.coerce.number().int().positive(), pid: z.coerce.number().int().positive() }), req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    const row = ensureFound(await prisma.passkey.findFirst({ where: { id: pid, userId: id } }), t('passkey.notFound'));
    await prisma.passkey.delete({ where: { id: row.id } });
    await logActivity(req, admin.id, 'admin.user_passkey_remove', `${user.username} ${row.name}`);
    return { ok: true };
  });

  /** 用户绑定的第三方登录账号（提供商已停用 / 删除的也列出），以及有没有本地密码 */
  app.get('/api/admin/users/:id/oauth', async (req): Promise<{ hasPassword: boolean; items: AdminUserOAuthAccountDTO[] }> => {
    const { id } = parse(idParam, req.params);
    const user = ensureFound(await prisma.user.findUnique({ where: { id }, select: { passwordHash: true } }), t('user.notFound'));
    const [providers, items] = await Promise.all([oauthProviders(), prisma.oAuthAccount.findMany({ where: { userId: id }, orderBy: { createdAt: 'asc' } })]);
    return {
      hasPassword: hasPassword(user),
      items: items.map((a) => ({ id: a.id, ...providerView(providers, a.provider), providerId: a.providerId, email: a.email, name: a.name, createdAt: a.createdAt.toISOString() })),
    };
  });

  app.post('/api/admin/users', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        email: z.email(m('v.email')).trim().toLowerCase(),
        username: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{2,31}$/, m('v.username')),
        password: z.string().min(8, m('v.passwordMin')),
        role: z.enum(ROLES).default('USER'),
        balance: z.union([z.string(), z.number()]).optional(),
        remark: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    const exists = await prisma.user.findFirst({ where: { OR: [{ email: body.email }, { username: body.username }] } });
    if (exists) throw conflict(t('user.exists'));
    const user = await prisma.$transaction(async (tx) => {
      const u = await tx.user.create({
        data: {
          email: body.email,
          username: body.username,
          passwordHash: await hashPassword(body.password),
          emailVerifiedAt: new Date(),
          role: body.role,
          remark: body.remark || null,
        },
      });
      if (body.balance && Number(body.balance) > 0) {
        await changeBalance(tx, u.id, new Prisma.Decimal(body.balance), 'ADJUST', t('log.openingBonus'));
      }
      return tx.user.findUniqueOrThrow({ where: { id: u.id }, include: userInclude });
    });
    await logActivity(req, admin.id, 'admin.user_create', user.username);
    return adminUser(user, await oauthProviders());
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        email: z.email(m('v.email')).trim().toLowerCase().optional(),
        name: z.string().trim().max(32).nullable().optional(),
        emailVerified: z.boolean().optional(),
        role: z.enum(ROLES).optional(),
        status: z.enum(USER_STATUSES).optional(),
        password: z.string().min(8, m('v.passwordMin')).optional().or(z.literal('').transform(() => undefined)),
        remark: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    if (id === admin.id && (body.role === 'USER' || body.status === 'DISABLED')) throw badRequest(t('user.cannotDemoteSelf'));
    const current = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    if (body.email && body.email !== current.email && (await prisma.user.findUnique({ where: { email: body.email } }))) throw conflict(t('user.exists'));
    const { password, emailVerified, name, ...rest } = body;
    const data: Prisma.UserUpdateInput = { ...rest };
    if (name !== undefined) data.name = name || null;
    if (emailVerified !== undefined) data.emailVerifiedAt = emailVerified ? (current.emailVerifiedAt ?? new Date()) : null;
    if (password) data.passwordHash = await hashPassword(password);
    const user = await prisma.user.update({ where: { id }, data, include: userInclude });
    // 改密码、禁用、角色变更后已登录的设备需要重新登录（角色决定能进控制台还是管理后台）
    if (password || body.status === 'DISABLED' || (body.role && body.role !== current.role)) await destroyUserSessions(id, id === admin.id ? (req.sessionToken ?? undefined) : undefined);
    await logActivity(req, admin.id, 'admin.user_update', `${user.username} ${JSON.stringify({ ...body, password: password ? '***' : undefined })}`);
    return adminUser(user, await oauthProviders());
  });

  app.post('/api/admin/users/:id/balance', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        amount: z
          .union([z.string(), z.number()])
          .transform((v) => new Prisma.Decimal(v))
          .refine((v) => v.isFinite() && !v.isZero(), m('v.amountNonZero')),
        type: z.enum(['RECHARGE', 'ADJUST']).default('RECHARGE'),
        description: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    const balance = await prisma.$transaction((tx) =>
      changeBalance(tx, id, body.amount, body.type, body.description || (body.type === 'RECHARGE' ? t('log.adminRecharge') : t('log.adminAdjust'))),
    );
    await logActivity(req, admin.id, 'admin.user_balance', `#${id} ${body.amount.toFixed(2)}`);
    return { balance: money(balance) };
  });

  // 以该用户身份登录（排查问题用），原管理员会话保留，可随时切回
  app.post('/api/admin/users/:id/impersonate', async (req, reply) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    if (req.session?.impersonator) throw badRequest(t('user.alreadyImpersonating'));
    const target = ensureFound(await prisma.user.findUnique({ where: { id } }), t('user.notFound'));
    if (target.id === admin.id) throw badRequest(t('user.cannotImpersonateSelf'));
    await createSession(req, reply, target, {
      impersonator: { id: admin.id, username: admin.username, token: req.sessionToken! },
    });
    await logActivity(req, admin.id, 'admin.impersonate', target.username);
    return { user: toMe(target, { id: admin.id, username: admin.username }) };
  });
}

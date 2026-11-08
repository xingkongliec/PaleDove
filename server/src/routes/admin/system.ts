import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EMAIL_DOMAIN_MODES, LOG_MODULES, normalizeEmailDomain, TASK_STATUSES, TRANSFER_FEE_MODES, TASK_TYPES, type AdminSettingsDTO, type AdminStatsDTO, type SiteSettings } from '../../shared/index.ts';
import { config } from '../../config.ts';
import { adminGuard, idParam, logActivity, pageQuery, paging, panelUrl, parse, requireAdmin } from '../../lib/http.ts';
import { containsInsensitive, isSqlite, prisma, Prisma } from '../../lib/prisma.ts';
import { getSetting, setSetting, getSettings, updateSettings } from '../../lib/settings.ts';
import { badRequest } from '../../lib/errors.ts';
import { encrypt } from '../../lib/crypto.ts';
import { downloadIcon, siteIconUrl } from '../../services/site-icon.ts';
import { isMailConfigured, sendTestEmail, verifyMailConnection } from '../../services/mail/mailer.ts';
import { getSystemInfo } from '../../lib/system-info.ts';
import { emailAnnouncement } from '../../services/announcements.ts';
import { dayjs } from '../../lib/time.ts';
import { getNodeResources } from '../../services/nodes.ts';
import { m, t } from '../../i18n/index.ts';
import {
  money,
  toActivity,
  toAnnouncement,
  orderInclude,
  toOrder,
  toTask,
} from '../../services/serializers.ts';

/** 每日收入（UTC 日期），与 PostgreSQL 分支的 date_trunc 结果一致；SQLite 仅用于开发，数据量小，直接在内存中汇总 */
async function dailyRevenueSqlite(since: Date): Promise<{ date: string; amount: number }[]> {
  const rows = await prisma.order.findMany({
    where: { status: 'PAID', createdAt: { gte: since } },
    select: { createdAt: true, amount: true },
  });
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.createdAt.toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.amount.toNumber());
  }
  return [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([date, amount]) => ({ date, amount }));
}

export default async function adminSystemRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/stats', async (): Promise<AdminStatsDTO> => {
    const today = dayjs().startOf('day').toDate();
    const month = dayjs().startOf('month').toDate();
    const since = dayjs().subtract(29, 'day').startOf('day').toDate();
    // 系统状态检测与统计查询并行进行
    const systemInfo = getSystemInfo();
    const lastMonthStart = dayjs().subtract(1, 'month').startOf('month').toDate();
    const lastMonthNow = dayjs().subtract(1, 'month').toDate();
    const [users, usersToday, byStatus, nodes, online, rToday, rMonth, rTotal, recharge, daily, recentOrders, failedTasks, nodeRows, alloc, pendingSites, usersActive, rLastMonth, payToday, payPaidToday, payPending, ticketsOpen] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: today } } }),
      prisma.instance.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.node.count(),
      prisma.node.count({ where: { status: 'ONLINE' } }),
      prisma.order.aggregate({ where: { status: 'PAID', createdAt: { gte: today } }, _sum: { amount: true } }),
      prisma.order.aggregate({ where: { status: 'PAID', createdAt: { gte: month } }, _sum: { amount: true } }),
      prisma.order.aggregate({ where: { status: 'PAID' }, _sum: { amount: true } }),
      prisma.balanceLog.aggregate({ where: { type: { in: ['RECHARGE', 'REDEEM'] }, createdAt: { gte: month } }, _sum: { amount: true } }),
      isSqlite
        ? dailyRevenueSqlite(since)
        : prisma.$queryRaw<{ date: string; amount: number }[]>`
        SELECT to_char(date_trunc('day', "createdAt"), 'YYYY-MM-DD') AS date, COALESCE(SUM(amount), 0)::float8 AS amount
        FROM "Order" WHERE status = 'PAID' AND "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1`,
      prisma.order.findMany({ include: { ...orderInclude, user: { select: { id: true, username: true } } }, orderBy: { id: 'desc' }, take: 8 }),
      prisma.task.findMany({
        where: { status: 'FAILED', createdAt: { gte: dayjs().subtract(3, 'day').toDate() } },
        include: { instance: { select: { name: true } }, user: { select: { id: true, username: true } } },
        orderBy: { id: 'desc' },
        take: 8,
      }),
      prisma.node.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], take: 20 }),
      prisma.instance.groupBy({
        by: ['nodeId'],
        where: { status: { notIn: ['DELETED'] } },
        _sum: { cpu: true, memory: true, disk: true },
        _count: { _all: true },
      }),
      prisma.siteBinding.count({ where: { status: { in: ['PENDING', 'ERROR'] } } }),
      prisma.user.count({ where: { status: 'ACTIVE' } }),
      prisma.order.aggregate({ where: { status: 'PAID', createdAt: { gte: lastMonthStart, lt: lastMonthNow } }, _sum: { amount: true } }),
      prisma.payment.count({ where: { createdAt: { gte: today } } }),
      prisma.payment.count({ where: { createdAt: { gte: today }, status: 'PAID' } }),
      prisma.payment.count({ where: { status: 'PENDING' } }),
      prisma.ticket.count({ where: { status: 'OPEN' } }),
    ]);
    const allocMap = new Map(alloc.map((a) => [a.nodeId, a]));
    // 在线节点的实际容量（带缓存，单个节点最多等 2.5 秒，取不到时只显示已分配量）
    const capacity = await Promise.all(
      nodeRows.map(async (n) => {
        if (n.status !== 'ONLINE' || !n.endpoint) return null;
        try {
          const r = await Promise.race([getNodeResources(n), new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500))]);
          return r ? { cpu: r.cpu.cores, memory: r.memory.total, disk: r.storage?.total ?? null } : null;
        } catch {
          return null;
        }
      }),
    );
    const nodeUsage = nodeRows.map((n, i) => {
      const a = allocMap.get(n.id);
      return {
        id: n.id,
        name: n.name,
        region: n.region,
        status: n.status,
        enabled: n.enabled,
        instanceCount: a?._count._all ?? 0,
        allocated: { cpu: a?._sum.cpu ?? 0, memory: a?._sum.memory ?? 0, disk: a?._sum.disk ?? 0 },
        capacity: capacity[i],
      };
    });
    const map = new Map(daily.map((d) => [d.date, d.amount]));
    const revenueDaily = Array.from({ length: 30 }, (_, i) => {
      const date = dayjs(since).add(i, 'day').format('YYYY-MM-DD');
      return { date, amount: map.get(date) ?? 0 };
    });
    return {
      users,
      usersToday,
      usersActive,
      payments: { todayPaid: payPaidToday, todayTotal: payToday, pending: payPending },
      ticketsOpen,
      instances: Object.fromEntries(byStatus.map((s) => [s.status, s._count._all])),
      nodes: { total: nodes, online },
      revenue: {
        today: money(rToday._sum.amount),
        month: money(rMonth._sum.amount),
        lastMonth: money(rLastMonth._sum.amount),
        total: money(rTotal._sum.amount),
        monthRecharge: money(recharge._sum.amount),
      },
      revenueDaily,
      recentOrders: recentOrders.map(toOrder),
      failedTasks: failedTasks.map(toTask),
      nodeUsage,
      pendingSites,
      system: await systemInfo,
    };
  });

  // ───────── 公告 ─────────

  const announcementBody = z.object({
    title: z.string().trim().min(1, m('v.titleRequired')).max(100),
    content: z.string().trim().min(1, m('v.contentRequired')).max(10_000),
    pinned: z.boolean().default(false),
    published: z.boolean().default(true),
    level: z.enum(['INFO', 'WARNING', 'CRITICAL']).default('INFO'),
    expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
  });

  app.get('/api/admin/announcements', async () => {
    const rows = await prisma.announcement.findMany({ orderBy: [{ pinned: 'desc' }, { id: 'desc' }] });
    return rows.map(toAnnouncement);
  });

  app.post('/api/admin/announcements', async (req) => {
    const { announceEmail, ...body } = parse(announcementBody.extend({ announceEmail: z.boolean().default(false) }), req.body);
    const a = await prisma.announcement.create({ data: body });
    if (announceEmail && a.published && (!a.expiresAt || a.expiresAt > new Date())) void emailAnnouncement(a, panelUrl(req)).catch((error) => req.log.error({ err: error }, 'announcement email failed'));
    return toAnnouncement(a);
  });

  app.patch('/api/admin/announcements/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { announceEmail, ...body } = parse(announcementBody.partial().extend({ announceEmail: z.boolean().default(false) }), req.body);
    const a = await prisma.announcement.update({ where: { id }, data: body });
    if (announceEmail && a.published && (!a.expiresAt || a.expiresAt > new Date())) void emailAnnouncement(a, panelUrl(req)).catch((error) => req.log.error({ err: error }, 'announcement email failed'));
    return toAnnouncement(a);
  });

  app.delete('/api/admin/announcements/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    await prisma.announcement.delete({ where: { id } });
    return { ok: true };
  });

  // ───────── 设置 ─────────

  const adminSettings = async (s: SiteSettings): Promise<AdminSettingsDTO> => {
    const [icon, mail] = await Promise.all([getSetting('siteIcon'), getSetting('mail')]);
    return { ...s, panelUrl: config.PANEL_URL ?? '', icon: siteIconUrl(icon), iconSource: icon.source, mailEnabled: isMailConfigured(mail) };
  };

  app.get('/api/admin/settings', async () => adminSettings(await getSettings()));

  app.put('/api/admin/settings', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z
        .object({
          siteName: z.string().trim().min(1).max(64),
          allowRegister: z.boolean(),
          requireEmailVerification: z.boolean(),
          allowTickets: z.boolean(),
          signupBonus: z.number().min(0).max(10_000).refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 0.000001, m('settings.bonusPrecision')),
          footer: z.string().max(500),
          emailDomainMode: z.enum(EMAIL_DOMAIN_MODES),
          // 规范化（小写、去掉 @ / *. / 结尾的点）并去重；被更短后缀覆盖的子域名一并去掉（有 edu.cn 时 xxx.edu.cn 多余）
          emailDomains: z
            .array(z.string().transform(normalizeEmailDomain).pipe(z.string().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/, m('settings.emailDomainInvalid'))))
            .max(500)
            .transform((list) => {
              const unique = [...new Set(list)];
              return unique.filter((d) => !unique.some((o) => o !== d && d.endsWith(`.${o}`)));
            }),
          requireDnsCheck: z.boolean(),
          acmeEmail: z.union([z.email(), z.literal('')]),
          graceDays: z.number().int().min(0).max(365),
          autoRenewHours: z.number().int().min(1).max(720),
          reinstallCooldownMinutes: z.number().int().min(0).max(10_080),
          vpcLimit: z.number().int().min(0).max(100),
          affEnabled: z.boolean(),
          affRateNew: z.number().min(0).max(100),
          affRateRenew: z.number().min(0).max(100),
          affFreezeDays: z.number().int().min(0).max(365),
          affMinWithdraw: z.number().min(0).max(100_000),
          marketEnabled: z.boolean(),
          marketFeeRate: z.number().min(0).max(50),
          marketMinDays: z.number().int().min(0).max(365),
          transferFeeMode: z.enum(TRANSFER_FEE_MODES),
          transferFeeValue: z.number().min(0).max(100_000),
          nodeSwitchFee: z.number().min(0).max(100_000),
          avatarApiBase: z.union([z.string().trim().max(255).regex(/^https?:\/\/[^\s]+$/i, m('settings.avatarApiInvalid')), z.literal('')]),
        })
        .partial(),
      req.body,
    );
    // 兼容旧接口：只传了后缀列表、没有传模式时（以前只有白名单），未开启限制则按白名单处理
    if (body.emailDomains?.length && body.emailDomainMode === undefined && (await getSettings()).emailDomainMode === 'OFF') body.emailDomainMode = 'ALLOW';
    const settings = await updateSettings(body);
    await logActivity(req, admin.id, 'admin.settings', JSON.stringify(body));
    return adminSettings(settings);
  });

  app.put('/api/admin/settings/icon', async (req) => {
    const admin = requireAdmin(req);
    const { url } = parse(z.object({ url: z.string().trim().min(1).max(2048) }), req.body);
    const icon = await downloadIcon(url).catch((error: Error) => { throw badRequest(error.message); });
    await setSetting('siteIcon', { ...icon, updatedAt: new Date().toISOString() });
    await logActivity(req, admin.id, 'admin.site_icon', icon.source);
    return adminSettings(await getSettings());
  });
  app.delete('/api/admin/settings/icon', async (req) => {
    const admin = requireAdmin(req);
    await setSetting('siteIcon', { mime: '', data: '', source: '', updatedAt: '' });
    await logActivity(req, admin.id, 'admin.site_icon_reset');
    return adminSettings(await getSettings());
  });
  const mailView = async () => { const { passwordEnc, ...mail } = await getSetting('mail'); return { ...mail, hasPassword: !!passwordEnc }; };
  const mailSchema = z.object({
    enabled: z.boolean(), host: z.string().trim().max(255), port: z.number().int().min(1).max(65535), secure: z.boolean(),
    user: z.string().trim().max(255), password: z.string().max(2000).optional(), fromName: z.string().trim().max(64), fromEmail: z.string().trim().pipe(z.union([z.email(), z.literal('')])),
  });
  const mailInput = async (body: z.infer<typeof mailSchema>) => {
    const { password, ...rest } = body;
    if (rest.enabled && (!rest.host || !rest.fromEmail)) throw badRequest(t('mail.configRequired'));
    const current = await getSetting('mail');
    return { ...rest, passwordEnc: password ? encrypt(password) : current.passwordEnc };
  };
  app.get('/api/admin/settings/mail', mailView);
  app.put('/api/admin/settings/mail', async (req) => {
    const admin = requireAdmin(req);
    await setSetting('mail', await mailInput(parse(mailSchema, req.body)));
    await logActivity(req, admin.id, 'admin.mail_settings');
    return mailView();
  });
  app.post('/api/admin/settings/mail/test', { config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async (req) => {
    const admin = requireAdmin(req);
    const body = parse(mailSchema.extend({ to: z.preprocess((v) => typeof v === 'string' ? v.trim() || undefined : v, z.email().optional()) }), req.body);
    const mail = await mailInput({ ...body, enabled: true });
    const to = body.to ?? admin.email;
    try {
      await verifyMailConnection(mail);
      await sendTestEmail(to, mail, panelUrl(req), admin.locale);
    }
    catch (error) { throw badRequest(t('mail.sendFailed', { message: (error as Error).message })); }
    return { ok: true, to };
  });

  // ───────── 任务 / 日志 ─────────

  app.get('/api/admin/tasks', async (req) => {
    const q = parse(
      pageQuery.extend({ status: z.enum(TASK_STATUSES).optional(), type: z.enum(TASK_TYPES).optional(), q: z.string().trim().max(100).optional() }),
      req.query,
    );
    const where: Prisma.TaskWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      // 搜索实例名、主机名、操作者或错误信息
      ...(q.q
        ? { OR: [{ instance: { name: containsInsensitive(q.q) } }, { instance: { hostname: containsInsensitive(q.q) } }, { user: { username: containsInsensitive(q.q) } }, { error: containsInsensitive(q.q) }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: { instance: { select: { name: true } }, user: { select: { id: true, username: true } } },
        orderBy: { id: 'desc' },
        ...paging(q),
      }),
      prisma.task.count({ where }),
    ]);
    return { items: items.map(toTask), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/admin/logs', async (req) => {
    const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), userId: z.coerce.number().int().optional(), module: z.enum(LOG_MODULES).optional() }), req.query);
    const where: Prisma.ActivityLogWhereInput = {
      ...(q.userId ? { userId: q.userId } : {}),
      // 模块即操作名的前缀
      ...(q.module ? { action: { startsWith: `${q.module}.` } } : {}),
      ...(q.q
        ? { OR: [{ action: containsInsensitive(q.q) }, { detail: containsInsensitive(q.q) }, { ip: { contains: q.q } }, { user: { username: containsInsensitive(q.q) } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.activityLog.findMany({ where, include: { user: { select: { id: true, username: true } } }, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.activityLog.count({ where }),
    ]);
    return { items: items.map(toActivity), total, page: q.page, pageSize: q.pageSize };
  });
}

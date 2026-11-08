import { visibleAnnouncements } from '../services/announcements.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { BILLING_CYCLES, CYCLE_PRICE_FIELD, LOG_MODULES, type AffLogDTO, type AffSummaryDTO, type CouponQuoteDTO, type MessageDTO, type Paginated, type UserDashboardDTO } from '../shared/index.ts';
import {
  authGuard,
  consoleGuard,
  hostnameSchema,
  instancePasswordSchema,
  logActivity,
  pageQuery,
  paging,
  parse,
  requireUser,
  sshKeysSchema,
} from '../lib/http.ts';
import { containsInsensitive, prisma, skipDuplicates, type Prisma } from '../lib/prisma.ts';
import { dayjs } from '../lib/time.ts';
import { m, t } from '../i18n/index.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { ensureOAuthBound } from '../services/oauth.ts';
import { redeemCode } from '../services/billing.ts';
import { createPurchaseInvoice, invoiceDto } from '../services/invoices.ts';
import { resolveNodeArchitectures } from '../services/node-architecture.ts';
import { affLogs, affSummary, withdrawAff } from '../services/aff.ts';
import { quoteCoupon } from '../services/coupons.ts';
import { cached, invalidateCache } from '../lib/cache.ts';
import {
  money,
  orderInclude,
  toActivity,
  toAnnouncement,
  toBalanceLogs,
  toImage,
  toOrder,
  toPlan,
  toProduct,
  toTask,
} from '../services/serializers.ts';

/**
 * 在售套餐（套餐与所属产品均已启用、有可售地区且设置了价格）；登录后的购买页与公开首页共用。
 * 首页、购买页频繁请求：缓存在 Redis（含库存，15 秒；后台修改、下单与删除实例时立即失效）
 */
export function listSalePlans() {
  return cached('catalog', 'sale-plans', 15, loadSalePlans);
}

/** 直接查询数据库的在售套餐（后台需要实时数据时使用） */
export async function loadSalePlans() {
  const plans = await prisma.plan.findMany({
    where: { enabled: true, product: { enabled: true } },
    include: { product: { select: { nodeOptions: true, nodes: { select: { id: true, region: true, enabled: true, networkMode: true, requireRealName: true, imageIds: true, arch: true } } } } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const images = await prisma.image.findMany({ where: { enabled: true }, select: { id: true, arch: true } });
  const nodes = await resolveNodeArchitectures([...new Map(plans.flatMap(plan => plan.product.nodes).map(node => [node.id, node])).values()]);
  const architectures = new Map(nodes.map(node => [node.id, node.arch]));
  const counts = await prisma.instance.groupBy({
    by: ['planId'],
    where: { planId: { in: plans.map((p) => p.id) }, status: { not: 'DELETED' } },
    _count: { _all: true },
  });
  return plans
    .map(p => toPlan({ ...p, product: { ...p.product, nodes: p.product.nodes.map(node => ({ ...node, arch: architectures.get(node.id) ?? null })) } }, counts.find(c => c.planId === p.id)?._count._all ?? 0, images))
    .filter((p) => p.regions.length > 0 && Object.keys(p.prices).length > 0);
}

/** 在售产品：已启用且至少有一个在售套餐（Redis 缓存，同在售套餐） */
export function listSaleProducts() {
  return cached('catalog', 'sale-products', 15, loadSaleProducts);
}

async function loadSaleProducts() {
  const plans = await listSalePlans();
  const ids = new Set(plans.map((p) => p.productId));
  const rows = await prisma.product.findMany({
    where: { enabled: true, id: { in: [...ids] } },
    include: { nodes: { select: { region: true, enabled: true, country: true }, orderBy: { id: 'asc' } } },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toProduct);
}

/** 可选的系统镜像；购买页与公开首页共用（Redis 缓存 5 分钟，后台修改镜像时立即失效） */
export function listEnabledImages() {
  return cached('catalog', 'images', 300, async () => {
    const images = await prisma.image.findMany({ where: { enabled: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    return images.map(toImage);
  });
}

export default async function storeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);
  // 下单成功后库存变化：在售套餐缓存失效
  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'POST' && reply.statusCode < 400 && req.routeOptions.url === '/api/store/orders') await invalidateCache('catalog');
  });

  app.get('/api/store/plans', listSalePlans);

  app.get('/api/store/products', listSaleProducts);

  app.get('/api/store/images', listEnabledImages);

  app.post('/api/store/orders', async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        planId: z.number().int().positive(),
        region: z.string().min(1, m('v.regionRequired')),
        imageId: z.number().int().positive(m('v.imageRequired')),
        cycle: z.enum(BILLING_CYCLES),
        hostname: hostnameSchema,
        password: instancePasswordSchema.optional().or(z.literal('').transform(() => undefined)),
        sshKeys: sshKeysSchema,
        couponCode: z.string().trim().max(32).optional().transform((v) => v || undefined),
        nodeId: z.number().int().positive().optional(),
      }),
      req.body,
    );
    await ensureOAuthBound(user.id, user);
    const invoice = await createPurchaseInvoice(user, body);
    await logActivity(req, user.id, 'billing.invoice_create', invoice.no);
    return { invoice: invoiceDto(invoice) };
  });

  /** 下单 / 续费前试算优惠码；不能使用时返回 400 并说明原因 */
  app.post('/api/store/coupon', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req): Promise<CouponQuoteDTO> => {
    const user = requireUser(req);
    const code = z.string().trim().min(1, m('coupon.codeRequired')).max(32);
    const body = parse(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('NEW'), code, planId: z.number().int().positive(), cycle: z.enum(BILLING_CYCLES) }),
        z.object({ kind: z.literal('RENEW'), code, instanceId: z.number().int().positive(), periods: z.number().int().min(1).max(36).default(1) }),
      ]),
      req.body,
    );
    let target: { productId: number | null; planId: number | null; cycle: (typeof BILLING_CYCLES)[number]; amount: Prisma.Decimal };
    if (body.kind === 'NEW') {
      const plan = await prisma.plan.findUnique({ where: { id: body.planId }, include: { product: { select: { enabled: true } } } });
      if (!plan || !plan.enabled || !plan.product.enabled) throw notFound(t('plan.unavailable'));
      const price = plan[CYCLE_PRICE_FIELD[body.cycle]];
      if (!price) throw badRequest(t('coupon.freeOrder'));
      target = { productId: plan.productId, planId: plan.id, cycle: body.cycle, amount: price };
    } else {
      const inst = await prisma.instance.findFirst({ where: { id: body.instanceId, userId: user.id, status: { notIn: ['DELETED', 'DELETING'] } }, include: { plan: { select: { productId: true } } } });
      if (!inst) throw notFound(t('instance.notFound'));
      target = { productId: inst.plan?.productId ?? null, planId: inst.planId, cycle: inst.billingCycle, amount: inst.price.mul(body.periods) };
    }
    const { coupon, discount } = await quoteCoupon(prisma, body.code, { userId: user.id, kind: body.kind, ...target });
    return {
      code: coupon.code,
      name: coupon.name,
      mode: coupon.mode === 'RECURRING' ? 'RECURRING' : 'ONCE',
      type: coupon.type === 'AMOUNT' ? 'AMOUNT' : 'PERCENT',
      value: money(coupon.value),
      amount: money(target.amount),
      discount: money(discount),
      total: money(target.amount.minus(discount)),
    };
  });

  app.get('/api/dashboard', async (req): Promise<UserDashboardDTO> => {
    const user = requireUser(req);
    const soon = new Date(Date.now() + 7 * 86400_000);
    const [total, running, expiringSoon, announcements, recentTasks] = await Promise.all([
      prisma.instance.count({ where: { userId: user.id, status: { not: 'DELETED' } } }),
      prisma.instance.count({ where: { userId: user.id, status: 'RUNNING' } }),
      prisma.instance.count({ where: { userId: user.id, status: { not: 'DELETED' }, expiresAt: { lte: soon } } }),
      prisma.announcement.findMany({ where: visibleAnnouncements(), orderBy: [{ pinned: 'desc' }, { id: 'desc' }], take: 5 }),
      prisma.task.findMany({
        where: { instance: { userId: user.id } },
        include: { instance: { select: { name: true } } },
        orderBy: { id: 'desc' },
        take: 8,
      }),
    ]);
    return {
      balance: money(user.balance),
      instances: { total, running, expiringSoon },
      announcements: announcements.map(toAnnouncement),
      recentTasks: recentTasks.map(toTask),
    };
  });

  app.get('/api/billing/logs', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery, req.query);
    const where = { userId: user.id };
    const [items, total] = await Promise.all([
      prisma.balanceLog.findMany({ where, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.balanceLog.count({ where }),
    ]);
    return { items: await toBalanceLogs(items), total, ...q } satisfies Paginated<unknown>;
  });

  /** 费用中心汇总：余额、累计充值、累计消费、本月消费 */
  app.get('/api/billing/summary', async (req) => {
    const user = requireUser(req);
    const monthStart = dayjs().startOf('month').toDate();
    const sum = async (where: Prisma.BalanceLogWhereInput) => (await prisma.balanceLog.aggregate({ where: { userId: user.id, ...where }, _sum: { amount: true } }))._sum.amount;
    // 消费为负数记账，退款（开通失败等）抵扣消费
    const spendTypes: Prisma.BalanceLogWhereInput = { type: { in: ['PURCHASE', 'RENEW', 'REFUND', 'TRANSFER', 'TRAFFIC', 'MARKET', 'SWITCH'] } };
    const [spend, totalSpend, monthRecharge, totalRecharge, active] = await Promise.all([
      sum({ ...spendTypes, createdAt: { gte: monthStart } }),
      sum(spendTypes),
      sum({ type: { in: ['RECHARGE', 'REDEEM'] }, createdAt: { gte: monthStart } }),
      sum({ type: { in: ['RECHARGE', 'REDEEM'] } }),
      prisma.instance.count({ where: { userId: user.id, status: { notIn: ['DELETED', 'DELETING'] } } }),
    ]);
    return {
      balance: money(user.balance),
      monthSpend: money(spend && spend.isNegative() ? spend.abs() : null),
      totalSpend: money(totalSpend && totalSpend.isNegative() ? totalSpend.abs() : null),
      monthRecharge: money(monthRecharge),
      totalRecharge: money(totalRecharge),
      activeInstances: active,
    };
  });

  app.get('/api/billing/orders', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery, req.query);
    const where = { userId: user.id };
    const [items, total] = await Promise.all([
      prisma.order.findMany({ where, include: orderInclude, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.order.count({ where }),
    ]);
    return { items: items.map((o) => toOrder(o)), total, ...q };
  });

  app.post(
    '/api/billing/redeem',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const user = requireUser(req);
      const body = parse(z.object({ code: z.string().trim().min(4, m('v.redeemRequired')).max(64) }), req.body);
      const balance = await redeemCode(user.id, body.code);
      await logActivity(req, user.id, 'billing.redeem');
      return { balance: money(balance) };
    },
  );

  // ───────── 推广返利 ─────────

  app.get('/api/aff', async (req): Promise<AffSummaryDTO> => {
    const user = requireUser(req);
    return affSummary(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, affCode: true } }));
  });

  app.get('/api/aff/logs', async (req): Promise<Paginated<AffLogDTO>> => {
    const user = requireUser(req);
    const q = parse(pageQuery, req.query);
    return { ...(await affLogs(user.id, q.page, q.pageSize)), ...q };
  });

  app.post('/api/aff/withdraw', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const r = await withdrawAff(user.id);
    await logActivity(req, user.id, 'billing.aff_withdraw', money(r.amount));
    return { amount: money(r.amount), balance: money(r.balance) };
  });

  // ───────── 操作日志（账号自己的操作记录） ─────────

  app.get('/api/logs', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery.extend({ q: z.string().trim().max(100).optional(), module: z.enum(LOG_MODULES).optional() }), req.query);
    const where: Prisma.ActivityLogWhereInput = {
      userId: user.id,
      ...(q.module ? { action: { startsWith: `${q.module}.` } } : {}),
      ...(q.q ? { OR: [{ action: containsInsensitive(q.q) }, { detail: containsInsensitive(q.q) }, { ip: { contains: q.q } }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.activityLog.findMany({ where, include: { user: { select: { id: true, username: true } } }, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.activityLog.count({ where }),
    ]);
    return { items: items.map(toActivity), total, page: q.page, pageSize: q.pageSize };
  });
}

/** 公告和站内信属于两个后台共用的通知功能。 */
export async function notificationRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authGuard);

  // 公告：带当前用户的已读状态（点击后才算已读；注册之前发布的公告视为已读）
  app.get('/api/announcements', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.announcement.findMany({
      where: visibleAnnouncements(),
      orderBy: [{ pinned: 'desc' }, { id: 'desc' }],
      take: 50,
      include: { reads: { where: { userId: user.id }, select: { userId: true } } },
    });
    return rows.map(({ reads, ...a }) => ({ ...toAnnouncement(a), read: reads.length > 0 || a.createdAt < user.createdAt }));
  });

  /** 公告标记已读：不带 ids 时把当前可见的公告全部标记 */
  app.post('/api/announcements/read', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).max(200).optional() }).optional(), req.body);
    const visible = await prisma.announcement.findMany({
      where: { ...visibleAnnouncements(), ...(body?.ids ? { id: { in: body.ids } } : {}) },
      select: { id: true },
    });
    const done = new Set(
      (await prisma.announcementRead.findMany({ where: { userId: user.id, announcementId: { in: visible.map((a) => a.id) } }, select: { announcementId: true } })).map((r) => r.announcementId),
    );
    const todo = visible.filter((a) => !done.has(a.id)).map((a) => ({ userId: user.id, announcementId: a.id }));
    if (todo.length) await prisma.announcementRead.createMany({ data: todo, ...skipDuplicates });
    return { ok: true, marked: todo.length };
  });

  // 站内信：分页列表（可只看未读）与未读数量
  app.get('/api/messages', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery.extend({ unread: z.stringbool().optional() }), req.query);
    const where: Prisma.MessageWhereInput = { userId: user.id, ...(q.unread ? { readAt: null } : {}) };
    const [rows, total, unread] = await Promise.all([
      prisma.message.findMany({ where, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.message.count({ where }),
      prisma.message.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return {
      unread,
      total,
      page: q.page,
      pageSize: q.pageSize,
      items: rows.map((m): MessageDTO => ({ id: m.id, title: m.title, content: m.content, read: !!m.readAt, createdAt: m.createdAt.toISOString() })),
    };
  });

  /** 标记已读：不带 ids 时全部标记 */
  app.post('/api/messages/read', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).max(500).optional() }).optional(), req.body);
    await prisma.message.updateMany({ where: { userId: user.id, readAt: null, ...(body?.ids ? { id: { in: body.ids } } : {}) }, data: { readAt: new Date() } });
    return { ok: true };
  });

  /** 删除站内信：带 ids 删除指定的，否则删除全部已读的 */
  app.post('/api/messages/delete', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).max(500).optional() }), req.body ?? {});
    const r = await prisma.message.deleteMany({ where: { userId: user.id, ...(body.ids ? { id: { in: body.ids } } : { readAt: { not: null } }) } });
    return { deleted: r.count };
  });

}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILLING_CYCLES, COUPON_MODES, COUPON_SCOPES, COUPON_TYPES } from '../../shared/index.ts';
import { conflict } from '../../lib/errors.ts';
import { adminGuard, idParam, logActivity, pageQuery, paging, parse, parsePatch, requireAdmin } from '../../lib/http.ts';
import { containsInsensitive, prisma, Prisma, skipDuplicates } from '../../lib/prisma.ts';
import { generateRedeemCode } from '../../services/billing.ts';
import { generateCouponCode, normalizeCouponCode, toCoupon, toCouponUsage } from '../../services/coupons.ts';
import { toRedeemCode } from '../../services/serializers.ts';
import { m, t } from '../../i18n/index.ts';

const decimal = z
  .union([z.string(), z.number()])
  .transform((v) => new Prisma.Decimal(v))
  .refine((v) => v.isFinite() && v.greaterThan(0), m('v.amountPositive'));
const optionalDecimal = z
  .union([z.string(), z.number(), z.null()])
  .transform((v) => (v === null || v === '' ? null : new Prisma.Decimal(v)))
  .refine((v) => v === null || (v.isFinite() && v.greaterThan(0)), m('v.amountPositive'));
const optionalCount = z.number().int().min(1).max(1_000_000).nullable();

const couponFields = {
  code: z
    .string()
    .trim()
    .transform(normalizeCouponCode)
    .pipe(z.string().regex(/^[A-Z0-9_-]{3,32}$/, m('coupon.codeFormat'))),
  name: z.string().trim().max(64).nullable().default(null).transform((v) => v || null),
  type: z.enum(COUPON_TYPES),
  value: decimal,
  scope: z.enum(COUPON_SCOPES).default('NEW'),
  productIds: z.array(z.number().int().positive()).max(500).nullable().default(null),
  planIds: z.array(z.number().int().positive()).max(500).nullable().default(null),
  cycles: z.array(z.enum(BILLING_CYCLES)).nullable().default(null),
  minAmount: optionalDecimal.default(null),
  maxDiscount: optionalDecimal.default(null),
  maxUses: optionalCount.default(null),
  perUser: optionalCount.default(1),
  mode: z.enum(COUPON_MODES).default('ONCE'),
  newUserOnly: z.boolean().default(false),
  startsAt: z.coerce.date().nullable().default(null),
  expiresAt: z.coerce.date().nullable().default(null),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(200).nullable().default(null),
};

/** 百分比不超过 100；结束时间要晚于开始时间 */
function checkCoupon(c: { type?: string; value?: Prisma.Decimal; startsAt?: Date | null; expiresAt?: Date | null }) {
  if (c.type === 'PERCENT' && c.value && c.value.gt(100)) throw new z.ZodError([{ code: 'custom', path: ['value'], message: m('coupon.percentMax'), input: c.value }]);
  if (c.startsAt && c.expiresAt && c.expiresAt <= c.startsAt) throw new z.ZodError([{ code: 'custom', path: ['expiresAt'], message: m('coupon.timeRange'), input: c.expiresAt }]);
}

/** Json 列：null 要写成 DbNull */
const jsonList = <T>(v: T[] | null | undefined) => (v === undefined ? undefined : v === null || v.length === 0 ? Prisma.DbNull : [...new Set(v)]);

async function withTotals(rows: Prisma.CouponGetPayload<object>[]) {
  // 累计减免按已支付订单统计，包括循环抵扣在之后每次续费时的减免
  const sums = await prisma.order.groupBy({ by: ['couponId'], where: { couponId: { in: rows.map((r) => r.id) }, status: 'PAID' }, _sum: { discount: true } });
  return rows.map((r) => toCoupon(r, sums.find((s) => s.couponId === r.id)?._sum.discount ?? null));
}

export default async function adminPromotionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  // ───────── 优惠码 ─────────

  app.get('/api/admin/coupons', async (req) => {
    const q = parse(pageQuery.extend({ q: z.string().trim().max(64).optional(), status: z.enum(['all', 'active', 'disabled']).default('all') }), req.query);
    const where: Prisma.CouponWhereInput = {
      ...(q.q ? { OR: [{ code: containsInsensitive(q.q) }, { name: containsInsensitive(q.q) }, { remark: containsInsensitive(q.q) }] } : {}),
      ...(q.status === 'active' ? { enabled: true } : q.status === 'disabled' ? { enabled: false } : {}),
    };
    const [rows, total] = await Promise.all([prisma.coupon.findMany({ where, orderBy: { id: 'desc' }, ...paging(q) }), prisma.coupon.count({ where })]);
    return { items: await withTotals(rows), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/api/admin/coupons/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return (await withTotals([await prisma.coupon.findUniqueOrThrow({ where: { id } })]))[0];
  });

  /** 未填写优惠码时自动生成 */
  app.post('/api/admin/coupons', async (req) => {
    const admin = requireAdmin(req);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    const body = parse(z.object(couponFields), { ...raw, code: typeof raw.code === 'string' && raw.code.trim() ? raw.code : generateCouponCode() });
    checkCoupon(body);
    if (await prisma.coupon.findUnique({ where: { code: body.code } })) throw conflict(t('coupon.codeTaken'));
    const row = await prisma.coupon.create({ data: { ...body, productIds: jsonList(body.productIds), planIds: jsonList(body.planIds), cycles: jsonList(body.cycles) } });
    await logActivity(req, admin.id, 'admin.coupon_create', row.code);
    return toCoupon(row);
  });

  app.patch('/api/admin/coupons/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parsePatch(couponFields, req.body);
    const current = await prisma.coupon.findUniqueOrThrow({ where: { id } });
    checkCoupon({ type: body.type ?? current.type, value: body.value ?? current.value, startsAt: body.startsAt === undefined ? current.startsAt : body.startsAt, expiresAt: body.expiresAt === undefined ? current.expiresAt : body.expiresAt });
    if (body.code && body.code !== current.code && (await prisma.coupon.findUnique({ where: { code: body.code } }))) throw conflict(t('coupon.codeTaken'));
    const row = await prisma.coupon.update({ where: { id }, data: { ...body, productIds: jsonList(body.productIds), planIds: jsonList(body.planIds), cycles: jsonList(body.cycles) } });
    await logActivity(req, admin.id, 'admin.coupon_update', row.code);
    return (await withTotals([row]))[0];
  });

  /** 已经使用过的优惠码保留使用记录，只能停用 */
  app.delete('/api/admin/coupons/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const row = await prisma.coupon.findUniqueOrThrow({ where: { id } });
    if (await prisma.couponUsage.count({ where: { couponId: id } })) throw conflict(t('coupon.usedCannotDelete'));
    await prisma.coupon.delete({ where: { id } });
    await logActivity(req, admin.id, 'admin.coupon_delete', row.code);
    return { ok: true };
  });

  app.get('/api/admin/coupons/:id/usages', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(pageQuery, req.query);
    const where = { couponId: id };
    const [rows, total] = await Promise.all([
      prisma.couponUsage.findMany({ where, include: { user: { select: { id: true, username: true } }, order: { select: { no: true, type: true } } }, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.couponUsage.count({ where }),
    ]);
    return { items: rows.map(toCouponUsage), total, page: q.page, pageSize: q.pageSize };
  });

  // ───────── 兑换码 ─────────

  app.get('/api/admin/redeem-codes', async (req) => {
    const q = parse(pageQuery.extend({ used: z.enum(['all', 'used', 'unused']).default('all') }), req.query);
    // 可用：还有剩余次数；已用完：次数用尽
    const where: Prisma.RedeemCodeWhereInput =
      q.used === 'used' ? { usedCount: { gte: prisma.redeemCode.fields.maxUses } } : q.used === 'unused' ? { usedCount: { lt: prisma.redeemCode.fields.maxUses } } : {};
    const [items, total] = await Promise.all([
      prisma.redeemCode.findMany({ where, include: { usedBy: { select: { id: true, username: true } } }, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.redeemCode.count({ where }),
    ]);
    return { items: items.map(toRedeemCode), total, page: q.page, pageSize: q.pageSize };
  });

  app.post('/api/admin/redeem-codes', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        amount: decimal,
        count: z.number().int().min(1).max(500).default(1),
        maxUses: z.number().int().min(1).max(100_000).default(1),
        expiresAt: z.coerce.date().nullable().optional(),
        remark: z.string().trim().max(100).optional(),
      }),
      req.body,
    );
    const codes = Array.from({ length: body.count }, generateRedeemCode);
    await prisma.redeemCode.createMany({
      data: codes.map((code) => ({ code, amount: body.amount, maxUses: body.maxUses, expiresAt: body.expiresAt ?? null, remark: body.remark || null })),
      ...skipDuplicates,
    });
    await logActivity(req, admin.id, 'admin.redeem_create', `${body.count} × ${body.amount.toFixed(2)}`);
    return { codes };
  });

  app.delete('/api/admin/redeem-codes/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    // 已经有人兑换过的保留记录，不能删除
    const r = await prisma.redeemCode.deleteMany({ where: { id, usedCount: 0 } });
    if (!r.count) throw conflict(t('redeem.usedCannotDelete'));
    return { ok: true };
  });
}

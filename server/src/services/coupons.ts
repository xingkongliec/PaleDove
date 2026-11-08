import { randomInt } from 'node:crypto';
import { BILLING_CYCLES, type BillingCycle, type CouponDTO, type CouponUsageDTO } from '../shared/index.ts';
import { badRequest } from '../lib/errors.ts';
import { prisma, Prisma, type Coupon } from '../lib/prisma.ts';
import { getSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { money } from './serializers.ts';

type Db = Prisma.TransactionClient | typeof prisma;

/** 用户输入的优惠码统一转成大写 */
export const normalizeCouponCode = (code: string) => code.trim().toUpperCase();

/** 生成 8 位优惠码（去掉容易混淆的 0 / O / 1 / I） */
export function generateCouponCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

const idList = (v: Prisma.JsonValue | null) => (Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x)) : null);
const cycleList = (v: Prisma.JsonValue | null) => (Array.isArray(v) ? v.filter((x): x is BillingCycle => BILLING_CYCLES.includes(x as BillingCycle)) : null);

/** 要使用优惠码的订单 */
export interface CouponTarget {
  userId: number;
  kind: 'NEW' | 'RENEW';
  /** 套餐与所属产品；自定义实例（没有套餐）为 null */
  productId: number | null;
  planId: number | null;
  cycle: BillingCycle;
  /** 订单原价 */
  amount: Prisma.Decimal;
  /** 续费期数：循环抵扣按每期价格减免再乘以期数 */
  periods?: number;
}

/** 按优惠方式计算一笔金额的减免（不超过金额本身） */
export function discountOf(coupon: Pick<Coupon, 'type' | 'value' | 'maxDiscount'>, amount: Prisma.Decimal): Prisma.Decimal {
  let discount = coupon.type === 'PERCENT' ? amount.mul(coupon.value).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN) : coupon.value;
  if (coupon.type === 'PERCENT' && coupon.maxDiscount && discount.gt(coupon.maxDiscount)) discount = coupon.maxDiscount;
  return discount.gt(amount) ? amount : discount;
}

/** 循环抵扣：每一期都按一期价格减免 */
export const recurringDiscount = (coupon: Pick<Coupon, 'type' | 'value' | 'maxDiscount'>, unitPrice: Prisma.Decimal, periods: number) => discountOf(coupon, unitPrice).mul(periods);

/** 实例每期实际续费价格：绑定了循环抵扣的优惠码时扣除每期减免 */
export const renewalPrice = (inst: { price: Prisma.Decimal; coupon?: Pick<Coupon, 'type' | 'value' | 'maxDiscount'> | null }) =>
  inst.coupon ? inst.price.minus(recurringDiscount(inst.coupon, inst.price, 1)) : inst.price;

/** 校验优惠码能否用于这笔订单并计算减免金额；不能使用时抛出 400 并说明原因 */
export async function quoteCoupon(db: Db, rawCode: string, target: CouponTarget): Promise<{ coupon: Coupon; discount: Prisma.Decimal }> {
  const coupon = await db.coupon.findUnique({ where: { code: normalizeCouponCode(rawCode) } });
  if (!coupon || !coupon.enabled) throw badRequest(t('coupon.notFound'));
  const now = new Date();
  if (coupon.startsAt && coupon.startsAt > now) throw badRequest(t('coupon.notStarted'));
  if (coupon.expiresAt && coupon.expiresAt <= now) throw badRequest(t('coupon.expired'));
  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) throw badRequest(t('coupon.exhausted'));
  if (coupon.scope !== 'ALL' && coupon.scope !== target.kind) throw badRequest(t(coupon.scope === 'NEW' ? 'coupon.newOnly' : 'coupon.renewOnly'));
  const products = idList(coupon.productIds);
  if (products && (target.productId === null || !products.includes(target.productId))) throw badRequest(t('coupon.productMismatch'));
  // 指定了套餐的产品只能用于这些套餐；没有指定套餐的产品不限套餐
  const plans = idList(coupon.planIds);
  if (plans && !(target.planId !== null && plans.includes(target.planId))) {
    if (target.planId === null || (await db.plan.count({ where: { id: { in: plans }, productId: target.productId ?? -1 } }))) throw badRequest(t('coupon.planMismatch'));
  }
  const cycles = cycleList(coupon.cycles);
  if (cycles && !cycles.includes(target.cycle)) throw badRequest(t('coupon.cycleMismatch'));
  if (target.amount.lte(0)) throw badRequest(t('coupon.freeOrder'));
  if (coupon.minAmount && target.amount.lt(coupon.minAmount)) {
    const { currency } = await getSettings();
    throw badRequest(t('coupon.minAmount', { amount: `${currency}${coupon.minAmount.toFixed(2)}` }));
  }
  if (coupon.newUserOnly && (await db.order.count({ where: { userId: target.userId, status: 'PAID' } }))) throw badRequest(t('coupon.newUserOnly'));
  if (coupon.perUser !== null && (await db.couponUsage.count({ where: { couponId: coupon.id, userId: target.userId } })) >= coupon.perUser) {
    throw badRequest(t('coupon.userLimit'));
  }
  const periods = target.periods ?? 1;
  const discount = coupon.mode === 'RECURRING' ? recurringDiscount(coupon, target.amount.div(periods), periods) : discountOf(coupon, target.amount);
  return { coupon, discount };
}

/**
 * 在下单 / 续费事务中占用一次优惠码并记录使用。总次数用条件更新保证并发时不超过上限；
 * 每人次数在写入后复查，超出时整个事务回滚
 */
export async function consumeCoupon(tx: Prisma.TransactionClient, coupon: Coupon, order: { id: number; userId: number }, amount: Prisma.Decimal, discount: Prisma.Decimal) {
  const claimed = await tx.coupon.updateMany({
    where: { id: coupon.id, enabled: true, ...(coupon.maxUses !== null ? { usedCount: { lt: coupon.maxUses } } : {}) },
    data: { usedCount: { increment: 1 } },
  });
  if (!claimed.count) throw badRequest(t('coupon.exhausted'));
  await tx.couponUsage.create({ data: { couponId: coupon.id, userId: order.userId, orderId: order.id, amount, discount } });
  await tx.order.update({ where: { id: order.id }, data: { couponId: coupon.id } });
  if (coupon.perUser !== null && (await tx.couponUsage.count({ where: { couponId: coupon.id, userId: order.userId } })) > coupon.perUser) {
    throw badRequest(t('coupon.userLimit'));
  }
}

/** 订单退款时归还优惠码次数 */
export async function releaseCoupon(tx: Prisma.TransactionClient, orderId: number) {
  const usage = await tx.couponUsage.findUnique({ where: { orderId } });
  if (!usage) return;
  await tx.couponUsage.delete({ where: { id: usage.id } });
  await tx.coupon.update({ where: { id: usage.couponId }, data: { usedCount: { decrement: 1 } } });
}

export function toCoupon(c: Coupon, totalDiscount: Prisma.Decimal | null = null): CouponDTO {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    type: c.type === 'AMOUNT' ? 'AMOUNT' : 'PERCENT',
    value: money(c.value),
    scope: c.scope === 'RENEW' || c.scope === 'ALL' ? c.scope : 'NEW',
    productIds: idList(c.productIds),
    planIds: idList(c.planIds),
    cycles: cycleList(c.cycles),
    minAmount: c.minAmount ? money(c.minAmount) : null,
    maxDiscount: c.maxDiscount ? money(c.maxDiscount) : null,
    maxUses: c.maxUses,
    perUser: c.perUser,
    mode: c.mode === 'RECURRING' ? 'RECURRING' : 'ONCE',
    newUserOnly: c.newUserOnly,
    usedCount: c.usedCount,
    totalDiscount: money(totalDiscount),
    startsAt: c.startsAt?.toISOString() ?? null,
    expiresAt: c.expiresAt?.toISOString() ?? null,
    enabled: c.enabled,
    remark: c.remark,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toCouponUsage(u: Prisma.CouponUsageGetPayload<{ include: { user: { select: { id: true; username: true } }; order: { select: { no: true; type: true } } } }>): CouponUsageDTO {
  return {
    id: u.id,
    user: u.user,
    orderNo: u.order.no,
    orderType: u.order.type,
    amount: money(u.amount),
    discount: money(u.discount),
    createdAt: u.createdAt.toISOString(),
  };
}

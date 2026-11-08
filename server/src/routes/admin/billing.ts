import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BALANCE_LOG_TYPES,
  type AdminBillingOverviewDTO,
  type AdminBillingRecordsDTO,
  type AdminOrdersDTO,
  type AmountCount,
  type BalanceLogType,
  type BillingRecordKind,
} from '../../shared/index.ts';
import { adminGuard, pageQuery, paging, parse } from '../../lib/http.ts';
import { containsInsensitive, isSqlite, prisma, Prisma } from '../../lib/prisma.ts';
import { dayjs } from '../../lib/time.ts';
import { money, orderInclude, toBalanceLogs, toOrder } from '../../services/serializers.ts';
import { billingChange, billingPeriods } from '../../services/billing-report.ts';
import { t } from '../../i18n/index.ts';

/** 市场买卖是用户间转账，不混入服务收入；切换机房失败退费也按实际流水抵减。 */
const SERVICE_TYPES: BalanceLogType[] = ['PURCHASE', 'RENEW', 'REFUND', 'TRANSFER', 'TRAFFIC', 'SWITCH'];
const CHARGE_TYPES: BalanceLogType[] = [...SERVICE_TYPES, 'MARKET'];
const RECHARGE_TYPES: BalanceLogType[] = ['RECHARGE', 'REDEEM'];

type Range = { gte?: Date; lt?: Date };

async function sumLogs(db: Prisma.TransactionClient, types: BalanceLogType[], createdAt: Range = {}) {
  const r = await db.balanceLog.aggregate({ where: { type: { in: types }, createdAt }, _sum: { amount: true }, _count: { _all: true } });
  return { amount: r._sum.amount ?? new Prisma.Decimal(0), count: r._count._all };
}

async function serviceSummary(db: Prisma.TransactionClient, createdAt: Range) {
  const [debits, credits] = await Promise.all([
    db.balanceLog.groupBy({ by: ['type'], where: { type: { in: SERVICE_TYPES }, amount: { lt: 0 }, createdAt }, _sum: { amount: true }, _count: { _all: true } }),
    db.balanceLog.aggregate({ where: { type: { in: SERVICE_TYPES }, amount: { gt: 0 }, createdAt }, _sum: { amount: true }, _count: { _all: true } }),
  ]);
  const gross = debits.reduce((sum, row) => sum.minus(row._sum.amount ?? 0), new Prisma.Decimal(0));
  const refund = credits._sum.amount ?? new Prisma.Decimal(0);
  const purchase = (debits.find((row) => row.type === 'PURCHASE')?._sum.amount ?? new Prisma.Decimal(0)).negated();
  const renew = (debits.find((row) => row.type === 'RENEW')?._sum.amount ?? new Prisma.Decimal(0)).negated();
  return {
    amount: gross.minus(refund),
    gross,
    refund,
    chargeCount: debits.reduce((sum, row) => sum + row._count._all, 0),
    refundCount: credits._count._all,
    byType: { purchase: money(purchase), renew: money(renew), other: money(gross.minus(purchase).minus(renew)) },
  };
}

// 统计使用同一只读快照，避免并发入账时列表、合计与净额取到不同时间的数据。
const reportIsolation = isSqlite ? Prisma.TransactionIsolationLevel.Serializable : Prisma.TransactionIsolationLevel.RepeatableRead;

const amountCount = (r: { amount: Prisma.Decimal; count: number }): AmountCount => ({ amount: money(r.amount), count: r.count });

/** 充值含在线支付、兑换码与人工增加；扣费含服务消费、退费、市场交易与人工扣减。 */
function recordWhere(kind: BillingRecordKind, type?: BalanceLogType): Prisma.BalanceLogWhereInput {
  if (kind === 'all') return type ? { type } : {};
  const adjust: Prisma.BalanceLogWhereInput = { type: 'ADJUST', amount: kind === 'recharge' ? { gt: 0 } : { lt: 0 } };
  const base = kind === 'recharge' ? RECHARGE_TYPES : CHARGE_TYPES;
  if (type === 'ADJUST') return adjust;
  if (type) return base.includes(type) ? { type } : { id: -1 };
  return { OR: [{ type: { in: base } }, adjust] };
}

export default async function adminBillingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/billing/overview', async (): Promise<AdminBillingOverviewDTO> => {
    return prisma.$transaction(
      async (tx) => {
        const now = dayjs();
        const { asOf, today, month, lastMonth, lastMonthToDate } = billingPeriods(now.toDate());
        const all = { lt: asOf };
        const sum = (types: BalanceLogType[], range: Range = all) => sumLogs(tx, types, range);
        const income = async (range: Range) => (await sum(SERVICE_TYPES, range)).amount.negated();
        const soon = now.add(7, 'day').toDate();
        const alive = { status: { notIn: ['DELETED' as const, 'DELETING' as const] } };

        const [
          incomeTotal,
          incomeToday,
          incomeMonth,
          incomeLastMonth,
          incomeLastMonthToDate,
          rechargeTotal,
          rechargeMonth,
          rechargeToday,
          rechargeLastMonth,
          rechargeLastMonthToDate,
          monthOnline,
          monthRedeem,
          online,
          redeem,
          adjust,
          balance,
          total,
          expired,
          suspended,
          free,
          autoRenew,
          expiringSoon,
          byPlan,
          couponDiscount,
          monthOrders,
        ] = await Promise.all([
          serviceSummary(tx, all),
          income(today),
          serviceSummary(tx, month),
          income(lastMonth),
          income(lastMonthToDate),
          sum(RECHARGE_TYPES),
          sum(RECHARGE_TYPES, month),
          sum(RECHARGE_TYPES, today),
          sum(RECHARGE_TYPES, lastMonth),
          sum(RECHARGE_TYPES, lastMonthToDate),
          sum(['RECHARGE'], month),
          sum(['REDEEM'], month),
          sum(['RECHARGE']),
          sum(['REDEEM']),
          sum(['ADJUST']),
          tx.user.aggregate({ where: { balance: { gt: 0 } }, _sum: { balance: true }, _count: { _all: true } }),
          tx.instance.count({ where: alive }),
          tx.instance.count({ where: { ...alive, expiresAt: { lte: now.toDate() } } }),
          tx.instance.count({ where: { ...alive, status: 'SUSPENDED', expiresAt: { gt: now.toDate() } } }),
          tx.instance.count({ where: { ...alive, price: 0 } }),
          tx.instance.count({ where: { ...alive, autoRenew: true } }),
          tx.instance.count({ where: { ...alive, expiresAt: { gt: now.toDate(), lte: soon } } }),
          // 按产品统计：已支付的新购与续费订单
          tx.order.groupBy({ by: ['planId'], where: { status: 'PAID', createdAt: all }, _sum: { amount: true }, _count: { _all: true } }),
          tx.order.aggregate({ where: { status: 'PAID', discount: { gt: 0 }, createdAt: all }, _sum: { discount: true }, _count: { _all: true } }),
          tx.order.groupBy({ by: ['type'], where: { status: 'PAID', createdAt: month }, _sum: { amount: true, discount: true }, _count: { _all: true } }),
        ]);
        const monthDiscounted = await tx.order.count({ where: { status: 'PAID', createdAt: month, discount: { gt: 0 } } });

        const plans = await tx.plan.findMany({
          where: { id: { in: byPlan.map((r) => r.planId).filter((x): x is number => x !== null) } },
          select: { id: true, product: { select: { id: true, name: true } } },
        });
        const products = new Map<string, { productId: number | null; name: string; amount: Prisma.Decimal; count: number }>();
        for (const r of byPlan) {
          const product = plans.find((p) => p.id === r.planId)?.product;
          const key = product ? String(product.id) : 'custom';
          const hit = products.get(key) ?? { productId: product?.id ?? null, name: product?.name ?? t('billing.customInstance'), amount: new Prisma.Decimal(0), count: 0 };
          hit.amount = hit.amount.plus(r._sum.amount ?? 0);
          hit.count += r._count._all;
          products.set(key, hit);
        }

        return {
          period: { asOf: asOf.toISOString(), monthStart: month.gte.toISOString(), lastMonthStart: lastMonth.gte.toISOString(), lastMonthToDateEnd: lastMonthToDate.lt.toISOString() },
          income: {
            total: money(incomeTotal.amount),
            gross: money(incomeTotal.gross),
            refund: money(incomeTotal.refund),
            today: money(incomeToday),
            month: money(incomeMonth.amount),
            lastMonth: money(incomeLastMonth),
            lastMonthToDate: money(incomeLastMonthToDate),
            change: billingChange(incomeMonth.amount, incomeLastMonthToDate),
            monthCharges: { amount: money(incomeMonth.gross), count: incomeMonth.chargeCount },
            monthRefunds: { amount: money(incomeMonth.refund), count: incomeMonth.refundCount },
          },
          recharge: {
            total: amountCount(rechargeTotal),
            month: amountCount(rechargeMonth),
            today: amountCount(rechargeToday),
            online: money(online.amount),
            redeem: money(redeem.amount),
            lastMonth: amountCount(rechargeLastMonth),
            lastMonthToDate: amountCount(rechargeLastMonthToDate),
            change: billingChange(rechargeMonth.amount, rechargeLastMonthToDate.amount),
            monthOnline: amountCount(monthOnline),
            monthRedeem: amountCount(monthRedeem),
          },
          monthOrders: {
            amount: money(monthOrders.reduce((sum, row) => sum.plus(row._sum.amount ?? 0), new Prisma.Decimal(0))),
            count: monthOrders.reduce((sum, row) => sum + row._count._all, 0),
            newCount: monthOrders.find((row) => row.type === 'NEW')?._count._all ?? 0,
            renewCount: monthOrders.find((row) => row.type === 'RENEW')?._count._all ?? 0,
            discount: money(monthOrders.reduce((sum, row) => sum.plus(row._sum.discount ?? 0), new Prisma.Decimal(0))),
            discountedCount: monthDiscounted,
          },
          adjust: money(adjust.amount),
          coupons: { amount: money(couponDiscount._sum.discount), count: couponDiscount._count._all },
          balance: { total: money(balance._sum.balance), users: balance._count._all },
          incomeByType: { ...incomeTotal.byType, refund: money(incomeTotal.refund) },
          monthIncomeByType: incomeMonth.byType,
          incomeByProduct: [...products.values()]
            .sort((a, b) => b.amount.comparedTo(a.amount))
            .map((p) => ({ productId: p.productId, name: p.name, amount: money(p.amount), count: p.count })),
          instances: {
            total,
            active: total - expired - suspended,
            expired,
            suspended,
            paid: total - free,
            free,
            autoRenew,
            expiringSoon,
          },
        };
      },
      { isolationLevel: reportIsolation },
    );
  });

  app.get('/api/admin/billing/records', async (req): Promise<AdminBillingRecordsDTO> => {
    const q = parse(
      pageQuery.extend({
        kind: z.enum(['all', 'recharge', 'charge']).default('recharge'),
        type: z.enum(BALANCE_LOG_TYPES).optional(),
        q: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const where: Prisma.BalanceLogWhereInput = {
      AND: [
        recordWhere(q.kind, q.type),
        ...(q.q ? [{ OR: [{ user: { username: containsInsensitive(q.q) } }, { user: { email: containsInsensitive(q.q) } }, { description: containsInsensitive(q.q) }] }] : []),
      ],
    };
    const [items, total, sum, debits, credits] = await prisma.$transaction(
      [
        prisma.balanceLog.findMany({ where, include: { user: { select: { id: true, username: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...paging(q) }),
        prisma.balanceLog.count({ where }),
        prisma.balanceLog.aggregate({ where, _sum: { amount: true } }),
        prisma.balanceLog.aggregate({ where: { AND: [where, { amount: { lt: 0 } }] }, _sum: { amount: true } }),
        prisma.balanceLog.aggregate({ where: { AND: [where, { amount: { gt: 0 } }] }, _sum: { amount: true } }),
      ],
      { isolationLevel: reportIsolation },
    );
    return {
      items: await toBalanceLogs(items),
      total,
      page: q.page,
      pageSize: q.pageSize,
      sum: money(sum._sum.amount),
      debitTotal: money((debits._sum.amount ?? new Prisma.Decimal(0)).negated()),
      creditTotal: money(credits._sum.amount),
    };
  });

  // ───────── 订单与余额明细 ─────────

  app.get('/api/admin/orders', async (req): Promise<AdminOrdersDTO> => {
    const q = parse(
      pageQuery.extend({ q: z.string().trim().max(100).optional(), userId: z.coerce.number().int().optional(), status: z.enum(['PAID', 'REFUNDED']).optional() }),
      req.query,
    );
    const where: Prisma.OrderWhereInput = {
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.q
        ? {
            OR: [
              { no: containsInsensitive(q.q) },
              { user: { username: containsInsensitive(q.q) } },
              { user: { email: containsInsensitive(q.q) } },
              { couponCode: containsInsensitive(q.q) },
              { plan: { name: containsInsensitive(q.q) } },
              { plan: { product: { name: containsInsensitive(q.q) } } },
              { instance: { hostname: containsInsensitive(q.q) } },
              { description: containsInsensitive(q.q) },
            ],
          }
        : {}),
    };
    const [items, total, sums, refunded] = await prisma.$transaction(
      [
        prisma.order.findMany({ where, include: { ...orderInclude, user: { select: { id: true, username: true } } }, orderBy: { id: 'desc' }, ...paging(q) }),
        prisma.order.count({ where }),
        prisma.order.aggregate({ where, _sum: { amount: true, discount: true } }),
        prisma.order.aggregate({ where: { AND: [where, { status: 'REFUNDED' }] }, _sum: { amount: true } }),
      ],
      { isolationLevel: reportIsolation },
    );
    return {
      items: items.map(toOrder),
      total,
      page: q.page,
      pageSize: q.pageSize,
      amountTotal: money(sums._sum.amount),
      discountTotal: money(sums._sum.discount),
      refundedTotal: money(refunded._sum.amount),
    };
  });

  app.get('/api/admin/balance-logs', async (req) => {
    const q = parse(pageQuery.extend({ userId: z.coerce.number().int().optional() }), req.query);
    const where: Prisma.BalanceLogWhereInput = q.userId ? { userId: q.userId } : {};
    const [items, total] = await Promise.all([
      prisma.balanceLog.findMany({ where, include: { user: { select: { id: true, username: true } } }, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.balanceLog.count({ where }),
    ]);
    return { items: await toBalanceLogs(items), total, page: q.page, pageSize: q.pageSize };
  });
}

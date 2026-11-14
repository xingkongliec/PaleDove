import { t } from '../i18n/index.ts';
import { conflict, notFound } from '../lib/errors.ts';
import { prisma } from '../lib/prisma.ts';
import { PLAN_STOCK_MAX, type PlanStockChange } from '../shared/index.ts';

/** 在数据库中直接增减，范围条件与更新一起执行，防止并发覆盖或减成负数。 */
export async function changePlanStock(id: number, change: PlanStockChange): Promise<void> {
  const updated = change.operation === 'adjust'
    ? await prisma.plan.updateMany({
      where: { id, stock: { gte: Math.max(0, -change.delta), lte: PLAN_STOCK_MAX - Math.max(0, change.delta) } },
      data: { stock: { increment: change.delta } },
    })
    : await prisma.plan.updateMany({
      where: { id, stock: change.expectedStock },
      data: { stock: change.stock },
    });
  if (updated.count) return;

  const current = await prisma.plan.findUnique({ where: { id }, select: { stock: true } });
  if (!current) throw notFound(t('plan.notFound'));
  if (change.operation === 'set') throw conflict(t('plan.stockChanged'));
  if (current.stock === null) throw conflict(t('plan.stockUnlimited'));
  throw conflict(t('plan.stockRange'));
}

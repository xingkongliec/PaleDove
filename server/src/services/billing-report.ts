import { Prisma } from '../generated/prisma/client.ts';
import { dayjs } from '../lib/time.ts';

/** 自然月按服务器时区统计；上月缺少对应日期时，使用上月整月，不能截断最后一天。 */
export function billingPeriods(date = new Date()) {
  const now = dayjs(date);
  const monthStart = now.startOf('month');
  const lastMonthStart = monthStart.subtract(1, 'month');
  const lastMonthEnd = now.date() > lastMonthStart.daysInMonth() ? monthStart : now.subtract(1, 'month');
  return {
    asOf: date,
    today: { gte: now.startOf('day').toDate(), lt: date },
    month: { gte: monthStart.toDate(), lt: date },
    lastMonth: { gte: lastMonthStart.toDate(), lt: monthStart.toDate() },
    lastMonthToDate: { gte: lastMonthStart.toDate(), lt: lastMonthEnd.toDate() },
  };
}

/** 百分比只用于正基数；零基数和负基数保留准确差额，由界面说明无法计算环比。 */
export function billingChange(current: Prisma.Decimal, previous: Prisma.Decimal) {
  const difference = current.minus(previous);
  return {
    difference: difference.toFixed(2),
    percent: previous.gt(0) ? difference.dividedBy(previous).times(100).toDecimalPlaces(1).toNumber() : null,
  };
}

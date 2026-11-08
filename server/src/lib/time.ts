import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import { CYCLE_MONTHS, type BillingCycle } from '../shared/index.ts';

dayjs.extend(utc);

/** 按自然月叠加，保持“日”锚点（如 1 月 31 日 + 1 月 = 2 月 28/29 日） */
export function addMonths(date: Date, months: number, anchorDay = date.getDate()): Date {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  const target = new Date(d.getFullYear(), targetMonth, 1, d.getHours(), d.getMinutes(), d.getSeconds());
  const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(anchorDay, daysInMonth));
  return target;
}

export function addCycle(date: Date, cycle: BillingCycle, anchorDay?: number): Date {
  return addMonths(date, CYCLE_MONTHS[cycle], anchorDay);
}

/** 两个时间之间相差的自然月数（只看年月） */
function monthsBetween(from: Date, to: Date): number {
  return (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth();
}

/**
 * 实例流量周期按开通时间计算：每月与开通时相同的日期和时刻重置（月末自动取当月最后一天）。
 * 返回 from 之后的第一个重置时间。
 */
export function nextTrafficReset(from: Date, openedAt: Date): Date {
  let k = Math.max(0, monthsBetween(openedAt, from));
  let candidate = addMonths(openedAt, k);
  while (candidate <= from) candidate = addMonths(openedAt, ++k);
  return candidate;
}

/** 以 resetAt 结束的流量周期的开始时间（第一个周期从开通时间开始） */
export function trafficCycleStart(resetAt: Date, openedAt: Date): Date {
  const k = monthsBetween(openedAt, resetAt);
  return k <= 1 ? openedAt : addMonths(openedAt, k - 1);
}

export function startOfDayUTC(date = new Date()): Date {
  return dayjs.utc(date).startOf('day').toDate();
}

/** 宿主机当前流量周期：从最近一次重置日（UTC 0 点）起一个月；重置日限制在 1-28，避免月末日期不存在 */
export function nodeTrafficPeriod(resetDay: number, now = new Date()): { start: Date; end: Date } {
  const day = Math.min(Math.max(resetDay, 1), 28);
  let start = dayjs.utc(now).startOf('month').date(day);
  if (start.isAfter(now)) start = start.subtract(1, 'month');
  return { start: start.toDate(), end: start.add(1, 'month').toDate() };
}

export { dayjs };

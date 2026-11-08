import { describe, expect, it } from 'vitest';
import { Prisma } from '../src/generated/prisma/client.ts';
import { billingChange, billingPeriods } from '../src/services/billing-report.ts';

const d = (y: number, m: number, day: number, h = 0, min = 0, sec = 0, ms = 0) => new Date(y, m - 1, day, h, min, sec, ms);

describe('billing report periods', () => {
  it('compares matching local dates and times, with exclusive cutoffs', () => {
    const now = d(2026, 11, 15, 12, 34, 56, 789);
    expect(billingPeriods(now)).toEqual({
      asOf: now,
      today: { gte: d(2026, 11, 15), lt: now },
      month: { gte: d(2026, 11, 1), lt: now },
      lastMonth: { gte: d(2026, 10, 1), lt: d(2026, 11, 1) },
      lastMonthToDate: { gte: d(2026, 10, 1), lt: d(2026, 10, 15, 12, 34, 56, 789) },
    });
  });

  it.each([
    [2026, 3, 29], [2026, 3, 30], [2026, 3, 31], [2026, 5, 31], [2028, 3, 30],
  ])('includes the entire shorter previous month for %i-%i-%i', (y, m, day) => {
    const periods = billingPeriods(d(y, m, day, 12));
    expect(periods.lastMonthToDate).toEqual(periods.lastMonth);
  });

  it('preserves a matching leap day and handles the year boundary', () => {
    expect(billingPeriods(d(2028, 3, 29, 12)).lastMonthToDate.lt).toEqual(d(2028, 2, 29, 12));
    expect(billingPeriods(d(2027, 1, 1)).lastMonthToDate).toEqual({ gte: d(2026, 12, 1), lt: d(2026, 12, 1) });
    expect(billingPeriods(d(2027, 1, 1)).month).toEqual({ gte: d(2027, 1, 1), lt: d(2027, 1, 1) });
  });
});

describe('billing report comparisons', () => {
  it.each([
    ['65', '40', '25.00', 62.5],
    ['30', '40', '-10.00', -25],
    ['0', '40', '-40.00', -100],
    ['-20', '40', '-60.00', -150],
    ['40', '40', '0.00', 0],
    ['0.30', '0.10', '0.20', 200],
    ['0.10', '0.30', '-0.20', -66.7],
    ['100', '0', '100.00', null],
    ['0', '0', '0.00', null],
    ['-5', '0', '-5.00', null],
    ['10', '-20', '30.00', null],
    ['-30', '-20', '-10.00', null],
  ])('compares %s with %s without misleading zero or negative percentages', (current, previous, difference, percent) => {
    expect(billingChange(new Prisma.Decimal(current), new Prisma.Decimal(previous))).toEqual({ difference, percent });
  });
});

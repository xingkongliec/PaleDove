import { describe, expect, it } from 'vitest';
import { addCycle, addMonths, nextTrafficReset, nodeTrafficPeriod, trafficCycleStart } from '../src/lib/time.ts';

const d = (y: number, m: number, day: number, h = 0) => new Date(y, m - 1, day, h);

describe('billing cycle math', () => {
  it('clamps month-end anchors', () => {
    expect(addMonths(d(2026, 1, 31), 1)).toEqual(d(2026, 2, 28));
    expect(addMonths(d(2028, 1, 31), 1)).toEqual(d(2028, 2, 29));
    // 锚点保持为 31 日，二月之后回到月末
    expect(addMonths(d(2026, 2, 28), 1, 31)).toEqual(d(2026, 3, 31));
  });

  it('adds cycles by months', () => {
    expect(addCycle(d(2026, 10, 11, 6), 'MONTHLY')).toEqual(d(2026, 11, 11, 6));
    expect(addCycle(d(2026, 10, 11), 'QUARTERLY')).toEqual(d(2027, 1, 11));
    expect(addCycle(d(2026, 10, 11), 'SEMIANNUAL')).toEqual(d(2027, 4, 11));
    expect(addCycle(d(2026, 10, 11), 'ANNUAL')).toEqual(d(2027, 10, 11));
  });

  it('resets instance traffic monthly at the opening time', () => {
    const opened = new Date(2026, 9, 23, 22, 38, 26);
    const at = (y: number, m: number, day: number) => new Date(y, m - 1, day, 22, 38, 26);
    // 开通时：第一个周期在一个月后的同一时刻结束
    expect(nextTrafficReset(opened, opened)).toEqual(at(2026, 11, 23));
    // 重置日当天、开通时刻之前不重置
    expect(nextTrafficReset(d(2026, 11, 23, 9), opened)).toEqual(at(2026, 11, 23));
    expect(nextTrafficReset(at(2026, 11, 23), opened)).toEqual(at(2026, 12, 23));
    // 跨年，长时间未运行也只取下一个重置点
    expect(nextTrafficReset(d(2027, 3, 1), opened)).toEqual(at(2027, 3, 23));
    // 月末开通：小月取最后一天，之后回到 31 日
    const monthEnd = d(2026, 1, 31, 8);
    expect(nextTrafficReset(d(2026, 4, 15), monthEnd)).toEqual(d(2026, 4, 30, 8));
    expect(nextTrafficReset(d(2026, 4, 30, 9), monthEnd)).toEqual(d(2026, 5, 31, 8));
  });

  it('derives the start of the current traffic cycle', () => {
    const opened = new Date(2026, 9, 23, 22, 38);
    expect(trafficCycleStart(new Date(2026, 10, 23, 22, 38), opened)).toEqual(opened);
    expect(trafficCycleStart(new Date(2027, 0, 23, 22, 38), opened)).toEqual(new Date(2026, 11, 23, 22, 38));
    // 旧版本 0 点重置的数据也能得到正确的周期开始
    expect(trafficCycleStart(new Date(2026, 10, 23), opened)).toEqual(opened);
    expect(trafficCycleStart(d(2026, 3, 31, 8), d(2026, 1, 31, 8))).toEqual(d(2026, 2, 28, 8));
  });
});

describe('host traffic period', () => {
  const utc = (iso: string) => new Date(iso);
  it('starts on the most recent reset day (UTC)', () => {
    expect(nodeTrafficPeriod(1, utc('2026-10-17T09:00:00Z'))).toEqual({ start: utc('2026-10-01T00:00:00Z'), end: utc('2026-11-01T00:00:00Z') });
    expect(nodeTrafficPeriod(20, utc('2026-10-17T09:00:00Z'))).toEqual({ start: utc('2026-09-20T00:00:00Z'), end: utc('2026-10-20T00:00:00Z') });
    // 重置日当天 0 点即进入新周期
    expect(nodeTrafficPeriod(17, utc('2026-10-17T00:00:00Z')).start).toEqual(utc('2026-10-17T00:00:00Z'));
    // 跨年
    expect(nodeTrafficPeriod(15, utc('2027-01-03T00:00:00Z'))).toEqual({ start: utc('2026-12-15T00:00:00Z'), end: utc('2027-01-15T00:00:00Z') });
  });
});

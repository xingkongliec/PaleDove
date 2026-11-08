import { describe, expect, it } from 'vitest';
import type { CouponQuoteDTO } from '../src/shared/index.ts';
import { renewalEstimate } from '../../web/src/lib/renewal.ts';

const date = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h);
const instance = {
  price: '19.99',
  renewPrice: '15.99',
  billingCycle: 'MONTHLY' as const,
  createdAt: date(2025, 1, 31).toISOString(),
  expiresAt: date(2026, 1, 31).toISOString(),
};
const now = date(2026, 1, 10);
const quote: CouponQuoteDTO = { code: 'SAVE', name: null, mode: 'ONCE', type: 'AMOUNT', value: '10.00', amount: '59.97', discount: '10.00', total: '49.97' };

describe('renewal UI estimates', () => {
  it('uses integer cents for recurring prices, discounts and the remaining balance', () => {
    expect(renewalEstimate(instance, 3, '50.00', null, now)).toMatchObject({
      original: 59.97, total: 47.97, discount: 12, balanceAfter: 2.03, shortfall: 0, quoteStale: false,
    });
    expect(renewalEstimate({ ...instance, price: '0.10', renewPrice: '0.10' }, 3, '0.30', null, now)).toMatchObject({ total: 0.3, balanceAfter: 0, shortfall: 0 });
  });

  it('uses the explicitly applied coupon instead of stacking it with the bound discount', () => {
    expect(renewalEstimate(instance, 3, '50.00', quote, now)).toMatchObject({ original: 59.97, total: 49.97, discount: 10, balanceAfter: 0.03, quoteStale: false });
  });

  it('detects quotes for the old duration so checkout can be blocked until recalculation', () => {
    expect(renewalEstimate(instance, 6, '50.00', quote, now)).toMatchObject({ quoteStale: true, total: 95.94, shortfall: 45.94 });
  });

  it('distinguishes an unknown balance, an exact balance and a top-up shortfall', () => {
    expect(renewalEstimate(instance, 1, null, null, now)).toMatchObject({ balanceAfter: null, shortfall: null });
    expect(renewalEstimate(instance, 1, '15.99', null, now)).toMatchObject({ balanceAfter: 0, shortfall: 0 });
    expect(renewalEstimate(instance, 1, '10.00', null, now)).toMatchObject({ balanceAfter: -5.99, shortfall: 5.99 });
  });

  it('preserves month-end anchors through February and matches the server cycle calculations', () => {
    expect(renewalEstimate(instance, 1, '50', null, now).renewedUntil).toEqual(date(2026, 2, 28));
    expect(renewalEstimate(instance, 2, '50', null, now).renewedUntil).toEqual(date(2026, 3, 31));
    const leap = { ...instance, expiresAt: date(2028, 1, 31).toISOString() };
    expect(renewalEstimate(leap, 1, '50', null, now).renewedUntil).toEqual(date(2028, 2, 29));
  });

  it('extends from the expiry if active and from now if expired', () => {
    expect(renewalEstimate(instance, 1, '50', null, now).expired).toBe(false);
    const expired = renewalEstimate(instance, 1, '50', null, date(2026, 2, 15));
    expect(expired.expired).toBe(true);
    expect(expired.renewedUntil).toEqual(date(2026, 3, 31));
  });

  it('handles free instances, a fully discounted order and longer billing cycles', () => {
    expect(renewalEstimate({ ...instance, price: '0', renewPrice: '0' }, 12, '0', null, now)).toMatchObject({ original: 0, total: 0, discount: 0, shortfall: 0 });
    expect(renewalEstimate(instance, 3, '0', { ...quote, discount: '59.97', total: '0.00' }, now)).toMatchObject({ total: 0, discount: 59.97, shortfall: 0 });
    expect(renewalEstimate({ ...instance, billingCycle: 'QUARTERLY' }, 2, '500', null, now).renewedUntil).toEqual(date(2026, 7, 31));
  });
});

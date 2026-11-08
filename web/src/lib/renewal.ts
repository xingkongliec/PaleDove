import { CYCLE_MONTHS, type CouponQuoteDTO, type InstanceDTO } from '../shared/index';

type RenewableInstance = Pick<InstanceDTO, 'price' | 'renewPrice' | 'expiresAt' | 'billingCycle' | 'createdAt'>;

/** 仅供界面预览：金额按分计算；到期日与服务端一样按开通日锚点逐期顺延。 */
export function renewalEstimate(inst: RenewableInstance, periods: number, balance: string | null, coupon: CouponQuoteDTO | null, now = new Date()) {
  const cents = (amount: string) => Math.round(Number(amount) * 100);
  const original = cents(inst.price) * periods;
  const quoteStale = !!coupon && cents(coupon.amount) !== original;
  const total = coupon && !quoteStale ? cents(coupon.total) : cents(inst.renewPrice) * periods;
  const available = balance === null ? null : cents(balance);
  const expires = new Date(inst.expiresAt);
  const expired = expires <= now;
  let renewedUntil = expired ? now : expires;
  const anchor = new Date(inst.createdAt).getDate();
  for (let i = 0; i < periods; i++) {
    const base = renewedUntil;
    const target = new Date(base.getFullYear(), base.getMonth() + CYCLE_MONTHS[inst.billingCycle], 1, base.getHours(), base.getMinutes(), base.getSeconds());
    target.setDate(Math.min(anchor, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
    renewedUntil = target;
  }
  return {
    original: original / 100,
    total: total / 100,
    discount: (original - total) / 100,
    balanceAfter: available === null ? null : (available - total) / 100,
    shortfall: available === null ? null : Math.max(0, total - available) / 100,
    quoteStale,
    expired,
    renewedUntil,
  };
}

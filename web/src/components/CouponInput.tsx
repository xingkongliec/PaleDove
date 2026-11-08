import { LoaderCircle, TicketPercent, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CouponQuoteDTO } from '../shared/index';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatMoney } from '@/lib/format';

/** 试算参数：新购（套餐 + 周期）或续费（实例 + 期数） */
export type CouponTarget = { kind: 'NEW'; planId: number; cycle: string } | { kind: 'RENEW'; instanceId: number; periods: number };

/**
 * 优惠码输入：默认收起成一行链接，展开后填写并试算；已使用的优惠码在订单内容变化时自动重新试算，不再适用时取消并提示原因
 */
export function CouponInput({ target, value, onChange, onPendingChange, disabled, refreshKey, currency }: {
  target: CouponTarget | null;
  value: CouponQuoteDTO | null;
  onChange: (q: CouponQuoteDTO | null) => void;
  onPendingChange?: (pending: boolean) => void;
  disabled?: boolean;
  /** 实例价格被后台更新后，也需要重新核算原有优惠码。 */
  refreshKey?: string;
  currency: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = target ? JSON.stringify([target, refreshKey]) : '';
  const lastKey = useRef(key);
  const currentKey = useRef(key);
  currentKey.current = key;
  const request = useRef(0);

  useEffect(() => () => {
    request.current++;
  }, []);

  const apply = async (c: string, refresh = false) => {
    if (!target || !c.trim() || (disabled && !refresh)) return;
    const id = ++request.current;
    setPending(true);
    onPendingChange?.(true);
    setError(null);
    try {
      const quote = await api.post<CouponQuoteDTO>('/store/coupon', { ...target, code: c.trim() });
      if (id !== request.current || key !== currentKey.current) return;
      onChange(quote);
      setOpen(false);
    } catch (e) {
      if (id !== request.current || key !== currentKey.current) return;
      onChange(null);
      setOpen(true);
      setCode(c);
      setError(errorText(e));
    } finally {
      if (id === request.current) {
        setPending(false);
        onPendingChange?.(false);
      }
    }
  };

  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    request.current++;
    setPending(false);
    onPendingChange?.(false);
    if (value) void apply(value.code, true);
  }, [key]);

  if (value) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-[13px]" aria-busy={pending}>
        <TicketPercent className="size-3.5 shrink-0 text-fg-3" />
        <span className="min-w-0 font-mono break-all text-fg">{value.code}</span>
        <span className="tabular ml-auto shrink-0 text-fg">{pending ? <LoaderCircle aria-label={t('common.loading')} className="size-3.5 animate-spin" /> : `-${formatMoney(value.discount, currency)}`}</span>
        <button type="button" disabled={disabled || pending} aria-label={t('coupon.remove')} title={t('coupon.remove')} className="shrink-0 rounded p-0.5 text-fg-4 transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={() => onChange(null)}>
          <X className="size-3.5" />
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button type="button" disabled={!target || disabled} onClick={() => setOpen(true)} className="inline-flex items-center gap-1.5 rounded text-[13px] text-fg-3 transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        <TicketPercent className="size-3.5" />
        {t('coupon.have')}
      </button>
    );
  }
  return (
    <div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void apply(code);
        }}
      >
        <Input autoFocus aria-label={t('coupon.placeholder')} disabled={disabled || pending} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder={t('coupon.placeholder')} className="h-8 font-mono text-[13px]" maxLength={32} />
        <Button type="submit" size="sm" loading={pending} disabled={!code.trim() || !target || disabled}>
          {t('coupon.apply')}
        </Button>
      </form>
      {error && <p className="mt-1 text-xs text-danger-text">{error}</p>}
    </div>
  );
}

import type { ReactNode } from 'react';
import type { DiscountSource } from '@/shared/index';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';

/** 只用数字、留白与分隔线建立层级，不给金额卡片添加彩色背景。 */
export function BillingMetrics({ items, busy, className }: { items: { label: ReactNode; value: ReactNode; hint?: ReactNode }[]; busy?: boolean; className?: string }) {
  return (
    <dl aria-busy={busy} className={cn('grid grid-cols-2 gap-x-6 gap-y-4 px-4 py-4 sm:px-5 lg:grid-cols-4', className)}>
      {items.map((item, i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-fg-3">{item.label}</dt>
          <dd className="mt-1.5 tabular text-xl leading-7 font-semibold tracking-tight break-words text-fg">{item.value}</dd>
          {item.hint && <dd className="mt-1 text-xs leading-5 text-fg-3">{item.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function DiscountCell({ discount, source, code, currency }: { discount: string; source: DiscountSource | null; code: string | null; currency: string }) {
  const { t } = useI18n();
  return Number(discount) > 0 ? (
    <div className="md:text-right">
      <div className="tabular whitespace-nowrap text-success-text">-{formatMoney(discount, currency)}</div>
      <div className="mt-1 text-xs break-all text-fg-3">{t(source === 'NIGHT_MARKET' ? 'billingAdmin.nightDiscount' : source === 'COUPON' ? 'billingAdmin.couponDiscount' : 'billingAdmin.otherDiscount')}{source === 'COUPON' && code ? ` · ${code}` : ''}</div>
    </div>
  ) : (
    <span className="block text-fg-4 md:text-right">—</span>
  );
}

export const numericHeader = (label: ReactNode) => <span className="block md:text-right">{label}</span>;
export const billingTableClass =
  '[&_thead_tr]:bg-transparent [&_td]:px-3 [&_th]:px-3 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4';

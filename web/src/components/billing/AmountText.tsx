import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';

export function AmountText({ amount, currency }: { amount: string; currency: string }) {
  const n = Number(amount);
  return (
    <span className={cn('tabular font-medium', n > 0 ? 'text-success-text' : n < 0 ? 'text-danger-text' : 'text-fg')}>
      {n > 0 ? '+' : ''}
      {formatMoney(n, currency)}
    </span>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { PLAN_STOCK_MAX, type AdminPlanDTO, type PlanStockChange } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';

type Mode = 'increase' | 'decrease' | 'set' | 'unlimited';

export function PlanStockDialog({ plan, onClose }: { plan: AdminPlanDTO; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ['admin-plan', plan.id], queryFn: () => api.get<AdminPlanDTO>(`/admin/plans/${plan.id}`),
    initialData: plan, staleTime: 0, refetchOnMount: 'always',
  });
  const current = detail.data;
  const [mode, setMode] = useState<Mode>(plan.stock === null ? 'set' : 'increase');
  const [amount, setAmount] = useState(plan.stock === null ? String(plan.activeInstances) : '1');
  const [error, setError] = useState<string | null>(null);
  const number = Number(amount);
  const adjusting = mode === 'increase' || mode === 'decrease';
  const nextStock = mode === 'unlimited' ? null : mode === 'set' ? number
    : current.stock === null ? null : current.stock + (mode === 'increase' ? number : -number);
  const validNumber = amount.trim() !== '' && Number.isInteger(number) && number >= (mode === 'set' ? 0 : 1) && number <= PLAN_STOCK_MAX;
  const validRange = nextStock !== null && nextStock >= 0 && nextStock <= PLAN_STOCK_MAX;
  const valid = mode === 'unlimited' ? current.stock !== null : validNumber && validRange && (!adjusting || current.stock !== null) && nextStock !== current.stock;
  const fieldError = adjusting && current.stock === null ? t('plans.stockUnlimitedHint')
    : mode === 'decrease' && validNumber && nextStock !== null && nextStock < 0 ? t('plans.stockDecreaseInvalid', { stock: current.stock! })
    : amount !== '' && (!validNumber || !validRange) ? t('plans.stockInvalid') : null;
  const display = (value: number | null) => value === null ? t('common.unlimited') : String(value);
  const save = useMutation({
    mutationFn: (change: PlanStockChange) => api.post<AdminPlanDTO>(`/admin/plans/${plan.id}/stock`, change),
    onSuccess: updated => {
      qc.setQueryData(['admin-plan', plan.id], updated);
      qc.setQueryData<AdminPlanDTO[]>(['admin-plans'], rows => rows?.map(row => row.id === updated.id ? updated : row));
      for (const key of ['admin-plans', 'admin-products', 'store-plans', 'store-products', 'public-plans', 'public-products']) void qc.invalidateQueries({ queryKey: [key] });
      toast.success(t('plans.stockUpdated'));
      onClose();
    },
    onError: error => { setError(errorText(error)); void detail.refetch(); },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid || save.isPending || detail.isFetching || detail.isError) return;
    setError(null);
    save.mutate(adjusting
      ? { operation: 'adjust', delta: mode === 'increase' ? number : -number }
      : { operation: 'set', stock: mode === 'unlimited' ? null : number, expectedStock: current.stock });
  };
  const changeMode = (value: Mode) => {
    setMode(value);
    setAmount(value === 'set' ? String(current.stock ?? current.activeInstances) : '1');
    setError(null);
  };

  return <Modal open size="sm" title={t('plans.adjustStock')} description={current.name} onOpenChange={open => !open && !save.isPending && onClose()} footer={<>
    <Button disabled={save.isPending} onClick={onClose}>{t('common.cancel')}</Button>
    <Button type="submit" form="plan-stock-form" variant="primary" loading={save.isPending} disabled={!valid || detail.isFetching || detail.isError}>{t('common.confirm')}</Button>
  </>}>
    <form id="plan-stock-form" onSubmit={submit} className="space-y-4">
      <dl className="grid grid-cols-3 gap-3 border-b border-line pb-4">
        {[[t('plans.stockSold'), current.activeInstances], [t('plans.stock'), display(current.stock)], [t('plans.stockAvailable'), display(current.stockLeft)]].map(([label, value]) => <div key={label}><dt className="text-xs text-fg-3">{label}</dt><dd className="tabular mt-1 text-lg font-semibold text-fg">{value}</dd></div>)}
      </dl>
      <FormField label={t('plans.stockOperation')}>
        <Select<Mode> value={mode} onChange={changeMode} disabled={save.isPending} options={[
          { value: 'increase', label: t('plans.stockIncrease'), description: t('plans.stockIncreaseHint'), disabled: current.stock === null },
          { value: 'decrease', label: t('plans.stockDecrease'), description: t('plans.stockDecreaseHint'), disabled: current.stock === null },
          { value: 'set', label: t('plans.stockSet'), description: t('plans.stockSetHint') },
          { value: 'unlimited', label: t('plans.stockUnlimited'), description: t('plans.stockUnlimitedDesc') },
        ]} />
      </FormField>
      {mode !== 'unlimited' && <FormField required label={t(mode === 'set' ? 'plans.stock' : 'plans.stockQuantity')} error={fieldError}>
        <Input autoFocus type="number" step={1} min={mode === 'set' ? 0 : 1} max={mode === 'decrease' ? current.stock ?? 0 : mode === 'increase' ? PLAN_STOCK_MAX - (current.stock ?? 0) : PLAN_STOCK_MAX} value={amount} onChange={event => { setAmount(event.target.value); setError(null); }} disabled={save.isPending} required />
        <div className="flex gap-1">
          {[1, 5, 10, 50].map(value => <Button key={value} size="sm" variant="ghost" disabled={save.isPending || (mode === 'decrease' && value > (current.stock ?? 0))} onClick={() => { setAmount(String(value)); setError(null); }}>{mode === 'increase' ? '+' : mode === 'decrease' ? '-' : ''}{value}</Button>)}
        </div>
      </FormField>}
      <div className="rounded-md bg-surface-2 px-3 py-2.5 text-[13px]" aria-live="polite" aria-atomic="true">
        <div className="flex items-center justify-between gap-3"><span className="text-fg-3">{t('plans.stockAfter')}</span><span className="tabular flex items-center gap-2 font-medium"><span className="text-fg-3">{display(current.stock)}</span><ArrowRight className="size-3.5 text-fg-4" />{mode === 'unlimited' || (validNumber && validRange) ? display(nextStock) : '-'}</span></div>
        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-fg-3"><span>{t('plans.stockAvailable')}</span><span className="tabular">{mode === 'unlimited' ? t('common.unlimited') : validNumber && validRange ? Math.max(0, nextStock! - current.activeInstances) : '-'}</span></div>
      </div>
      <p className="text-xs leading-relaxed text-fg-3">{t('plans.stockAdjustHint')}</p>
      {detail.isError && <Alert tone="danger">{errorText(detail.error)} <Button size="sm" variant="ghost" onClick={() => void detail.refetch()}>{t('common.retry')}</Button></Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  </Modal>;
}

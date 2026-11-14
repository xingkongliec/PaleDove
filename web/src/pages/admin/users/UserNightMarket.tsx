import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Diamond, ExternalLink, RotateCcw } from 'lucide-react';
import { Link } from 'react-router';
import type { AdminUserNightMarketDTO, AdminUserNightResetDTO, AdminUserNightResetInput } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Badge, Empty, ErrorState, PageLoading } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatCores, formatDate, formatMemory, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

const invoiceLabel = { PENDING: 'invoice.pending', PROCESSING: 'invoice.processing', PAID: 'invoice.paid', CANCELED: 'invoice.canceled', EXPIRED: 'invoice.expired' } as const;

export function UserNightMarket({ userId }: { userId: number }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const key = ['admin-user-night-market', userId];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<AdminUserNightMarketDTO>(`/admin/users/${userId}/night-market`), refetchInterval: 30_000 });
  const reset = useMutation({
    mutationFn: (input: AdminUserNightResetInput) => api.post<AdminUserNightResetDTO>(`/admin/users/${userId}/night-market/reset`, input),
    onSuccess: result => {
      qc.setQueryData(key, result.market);
      void qc.invalidateQueries({ queryKey: ['night-market'] });
      void qc.invalidateQueries({ queryKey: ['admin-invoices'] });
      void qc.invalidateQueries({ queryKey: ['admin-invoice'] });
      toast.success(t('night.user.resetDone'), t('night.user.resetResult', { retained: result.retainedOffers, canceled: result.canceledInvoices }));
    },
    onError: error => { toast.fromError(error); void qc.invalidateQueries({ queryKey: key }); },
  });
  const data = query.data;
  if (!data) return query.error ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <PageLoading />;
  const purchased = data.offers.filter(offer => offer.purchasedAt).length;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          {data.period && <span className="text-sm font-medium text-fg">{t('night.period', { id: data.period.number })}</span>}
          <Badge dot tone={data.state === 'open' ? 'success' : 'neutral'}>{t(data.state === 'open' ? 'night.openNow' : `night.state.${data.state}`)}</Badge>
          {!!data.offers.length && <span className="text-xs text-fg-3">{t('night.user.progress', { revealed: data.offers.filter(offer => offer.revealedAt).length, purchased })}</span>}
        </div>
        <p className="max-w-2xl text-xs leading-5 text-fg-3">{t('night.user.viewHint')}</p>
        {data.period && <p className="text-xs text-fg-3">{t('night.user.closesAt', { time: formatDate(data.period.closesAt) })}</p>}
      </div>
      <Button size="sm" variant="danger-ghost" icon={<RotateCcw />} loading={reset.isPending} disabled={!!data.resetBlockedReason || query.isFetching} onClick={async () => {
        if (!data.period) return;
        const snapshot = { periodId: data.period.id, offerIds: data.offers.map(offer => offer.id) };
        if (await confirm({ title: t('night.user.resetTitle'), description: t('night.user.resetConfirm', { count: 6 - purchased }), confirmText: t('night.user.reset'), danger: true })) reset.mutate(snapshot);
      }}>{t('night.user.reset')}</Button>
    </div>
    {data.resetBlockedReason && <p role="status" className="border-l-2 border-line-strong pl-3 text-xs leading-5 text-fg-3">{t(`night.user.blocked.${data.resetBlockedReason}`)}</p>}
    {!data.offers.length ? <Empty icon={<Diamond />} title={t('night.user.empty')} description={t('night.user.emptyHint')} /> : <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {data.offers.map(offer => <article key={offer.id} className="min-w-0 rounded-md border border-line bg-surface-2/30 p-3.5">
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="tabular text-fg-4">0{offer.position + 1}</span>
          <span className="inline-flex items-center gap-1 text-fg-2"><Diamond className="size-3" />{t(`night.quality.${offer.quality}`)}</span>
          <Badge tone={offer.purchasedAt ? 'success' : 'neutral'} className="ml-auto">{t(offer.purchasedAt ? 'night.purchased' : offer.revealedAt ? 'night.user.revealed' : 'night.user.sealed')}</Badge>
        </div>
        <div className="text-xs break-words text-fg-3">{offer.prize.productName} / {offer.prize.planName}</div>
        <h3 className="mt-1 text-sm font-semibold break-words text-fg">{offer.prize.name}</h3>
        {offer.prize.description && <p className="mt-1 text-xs leading-5 break-words text-fg-3">{offer.prize.description}</p>}
        <p className="mt-2 text-xs text-fg-2">{formatCores(offer.prize.cpu)} · {formatMemory(offer.prize.memory)} · {offer.prize.disk} GB</p>
        <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <strong className="tabular text-lg text-fg">{formatMoney(offer.amount, currency)}</strong><span className="text-xs text-fg-3">/ {L.billingCycle[offer.prize.cycle]}</span>
          <del className="tabular text-xs text-fg-4">{formatMoney(offer.prize.originalPrice, currency)}</del>
        </div>
        <p className="mt-1 text-xs text-fg-3">{t('night.savePercent', { percent: offer.discountPercent })} · {t(`night.mode.${offer.prize.discountMode}`)}</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line/70 pt-2.5 text-xs">
          <span className="text-fg-3">{offer.purchasedAt ? formatDate(offer.purchasedAt) : offer.revealedAt ? formatDate(offer.revealedAt) : '—'}</span>
          <div className="flex flex-wrap gap-3">
            {offer.invoiceId && <Link className="inline-flex items-center gap-1 text-fg-2 hover:text-fg hover:underline" to={`/admin/billing/invoices/${offer.invoiceId}`}>#{offer.invoiceId} · {offer.invoiceStatus ? t(invoiceLabel[offer.invoiceStatus]) : t('invoice.viewDetails')}<ExternalLink className="size-3" /></Link>}
            {offer.instanceId && <Link className="text-fg-2 hover:text-fg hover:underline" to={`/admin/instances/${offer.instanceId}`}>{t('night.viewInstance')}</Link>}
          </div>
        </div>
      </article>)}
    </div>}
    <p className="text-xs leading-5 text-fg-3">{t('night.user.resetHint')}</p>
  </div>;
}

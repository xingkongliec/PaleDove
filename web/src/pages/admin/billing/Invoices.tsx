import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReceiptText, Search } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { INVOICE_STATUSES, INVOICE_TYPES, type InvoiceStatus, type InvoiceType } from '@/shared/index';
import { Button, LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, Empty, ErrorState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { dayjs, formatDate, formatMoney } from '@/lib/format';
import { adminInvoiceListOptions } from '@/lib/invoice-query';
import { useCurrency } from '@/lib/queries';
import { BillingMetrics, DiscountCell, numericHeader } from './billing-ui';

const statusLabel = { PENDING: 'invoice.pending', PROCESSING: 'invoice.processing', PAID: 'invoice.paid', CANCELED: 'invoice.canceled', EXPIRED: 'invoice.expired' } as const;
const statusTone = { PENDING: 'warning', PROCESSING: 'warning', PAID: 'success', CANCELED: 'neutral', EXPIRED: 'danger' } as const;
const typeLabel = { PURCHASE: 'invoice.purchase', RENEW: 'invoice.renew', TRAFFIC_RESET: 'invoice.trafficReset' } as const;
const filterKeys = ['q', 'status', 'type', 'startDate', 'endDate'] as const;

export function Invoices() {
  const { t } = useI18n();
  const currency = useCurrency();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') as InvoiceStatus;
  const type = params.get('type') as InvoiceType;
  const dateParam = (key: string) => {
    const value = params.get(key) ?? '';
    return /^\d{4}-\d{2}-\d{2}$/.test(value) && dayjs(value).isValid() && dayjs(value).format('YYYY-MM-DD') === value ? value : '';
  };
  const filters = {
    q: (params.get('q') ?? '').slice(0, 100),
    status: INVOICE_STATUSES.includes(status) ? status : 'ALL' as const,
    type: INVOICE_TYPES.includes(type) ? type : 'ALL' as const,
    startDate: dateParam('startDate'), endDate: dateParam('endDate'),
  };
  const page = Math.max(1, Math.min(1_000_000, Math.floor(Number(params.get('page'))) || 1));
  const [draft, setDraft] = useState(filters);
  const list = useQuery({ ...adminInvoiceListOptions(filters, page), placeholderData: keepPreviousData });
  const setPage = (next: number) => { const p = new URLSearchParams(params); p.set('page', String(next)); setParams(p, { replace: true }); };
  const reset = () => {
    const p = new URLSearchParams(params);
    [...filterKeys, 'page'].forEach(key => p.delete(key));
    setDraft({ q: '', status: 'ALL', type: 'ALL', startDate: '', endDate: '' });
    setParams(p, { replace: true });
  };
  const detailUrl = (id: number) => `/admin/billing/invoices/${id}?${params}`;
  const m = (value?: string) => value === undefined ? '—' : formatMoney(value, currency);
  return <>
    {!list.isError && <BillingMetrics busy={list.isFetching} className="border-b border-line" items={[
      { label: t('billingAdmin.pendingAmount'), value: m(list.data?.pending.amount), hint: t('billingAdmin.pendingHint', { n: list.data?.pending.count ?? 0 }) },
      { label: t('billingAdmin.paidInvoices'), value: m(list.data?.paid.amount), hint: t('billingAdmin.paidInvoiceHint', { n: list.data?.paid.count ?? 0 }) },
      { label: t('billingAdmin.nightDiscount'), value: m(list.data?.discounts.nightMarket), hint: t('billingAdmin.paidDiscountScope') },
      { label: t('billingAdmin.totalDiscount'), value: m(list.data?.discounts.total), hint: <>{t('billingAdmin.couponDiscount')} {m(list.data?.discounts.coupon)}{Number(list.data?.discounts.other) > 0 ? ` · ${t('billingAdmin.otherDiscount')} ${m(list.data?.discounts.other)}` : ''}</> },
    ]} />}
    <form className="border-b border-line px-4 py-3" onSubmit={event => {
      event.preventDefault();
      const p = new URLSearchParams(params);
      filterKeys.forEach(key => { const value = draft[key].trim(); if (value && value !== 'ALL') p.set(key, value); else p.delete(key); });
      p.delete('page');
      setParams(p, { replace: true });
    }}>
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <div className="relative col-span-2 min-w-0 sm:min-w-56 sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input aria-label={t('billingAdmin.invoiceSearch')} placeholder={t('billingAdmin.invoiceSearch')} maxLength={100} className="pl-9" value={draft.q} onChange={event => setDraft(v => ({ ...v, q: event.target.value }))} />
        </div>
        <Select<InvoiceStatus | 'ALL'> aria-label={t('invoice.paymentStatus')} className="sm:w-36" value={draft.status} onChange={status => setDraft(v => ({ ...v, status }))} options={[{ value: 'ALL', label: t('billingAdmin.allStatuses') }, ...INVOICE_STATUSES.map(value => ({ value, label: t(statusLabel[value]) }))]} />
        <Select<InvoiceType | 'ALL'> aria-label={t('invoice.allTypes')} className="sm:w-36" value={draft.type} onChange={type => setDraft(v => ({ ...v, type }))} options={[{ value: 'ALL', label: t('invoice.allTypes') }, ...INVOICE_TYPES.map(value => ({ value, label: t(typeLabel[value]) }))]} />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
        <label className="min-w-0 text-xs text-fg-3">{t('invoice.startDate')}<Input type="date" aria-label={t('invoice.startDate')} className="mt-1 w-full sm:w-40" value={draft.startDate} max={draft.endDate || undefined} onChange={event => setDraft(v => ({ ...v, startDate: event.target.value }))} /></label>
        <label className="min-w-0 text-xs text-fg-3">{t('invoice.endDate')}<Input type="date" aria-label={t('invoice.endDate')} className="mt-1 w-full sm:w-40" value={draft.endDate} min={draft.startDate || undefined} onChange={event => setDraft(v => ({ ...v, endDate: event.target.value }))} /></label>
        <div className="col-span-2 flex items-center gap-2 sm:contents">
          <Button type="submit" variant="primary" loading={list.isFetching}>{t('invoice.query')}</Button>
          <Button variant="ghost" onClick={reset}>{t('common.reset')}</Button>
          <span aria-live="polite" className="ml-auto text-xs text-fg-3 sm:pb-2">{list.data ? t('invoice.count', { n: list.data.total }) : t('common.loading')}</span>
        </div>
      </div>
    </form>
    {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <DataTable
      rows={list.data?.items} rowKey={invoice => invoice.id} loading={list.isLoading} refreshing={list.isFetching}
      onRowClick={invoice => navigate(detailUrl(invoice.id))}
      empty={<Empty icon={<ReceiptText />} title={t('invoice.noResults')} />}
      columns={[
        { key: 'name', header: t('billingAdmin.orderProduct'), mobile: 'title', className: 'min-w-48', cell: invoice => <div className="max-w-sm space-y-1"><Link to={detailUrl(invoice.id)} onClick={event => event.stopPropagation()} className="font-medium text-fg hover:text-primary">{invoice.purchaseConfig ? `${invoice.purchaseConfig.product} / ${invoice.purchaseConfig.plan}` : invoice.plan ? `${invoice.plan.product} / ${invoice.plan.name}` : invoice.description}</Link><div className="text-xs text-fg-3">{t(typeLabel[invoice.type])}{invoice.purchaseConfig?.hostname || invoice.instance?.hostname ? ` · ${invoice.purchaseConfig?.hostname ?? invoice.instance?.hostname}` : ''}</div><div className="font-mono text-xs break-all text-fg-3">{invoice.no}</div></div> },
        { key: 'user', header: t('common.user'), cell: invoice => <Link onClick={event => event.stopPropagation()} className="font-medium text-fg-2 hover:text-primary" to={`/admin/users/${invoice.user.id}`}>{invoice.user.username}</Link> },
        { key: 'amount', header: numericHeader(t('invoice.amount')), cell: invoice => <span className="tabular block font-semibold whitespace-nowrap text-fg md:text-right">{m(invoice.amount)}</span> },
        { key: 'discount', header: numericHeader(t('billingAdmin.discountAmount')), cell: invoice => <DiscountCell discount={invoice.discount} source={invoice.discountSource} code={invoice.couponCode} currency={currency} /> },
        { key: 'status', header: t('invoice.paymentStatus'), cell: invoice => <Badge dot tone={statusTone[invoice.status]}>{t(statusLabel[invoice.status])}</Badge> },
        { key: 'created', header: t('invoice.createdAt'), cell: invoice => <time className="tabular text-xs whitespace-nowrap text-fg-3" dateTime={invoice.createdAt}>{formatDate(invoice.createdAt, 'YYYY-MM-DD')}<br />{formatDate(invoice.createdAt, 'HH:mm:ss')}</time> },
        { key: 'actions', header: t('common.actions'), cell: invoice => <LinkButton size="sm" onClick={event => event.stopPropagation()} to={detailUrl(invoice.id)}>{t('invoice.viewDetails')}</LinkButton> },
      ]}
    />}
    {list.data && !list.isError && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
  </>;
}

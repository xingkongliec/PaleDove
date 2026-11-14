import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ReceiptText, Search, Wallet } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { INVOICE_TYPES, type InvoiceDTO, type InvoiceStatus } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, Card, Empty, ErrorState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { formatDate, formatMoney } from '@/lib/format';
import { emptyInvoiceFilters as emptyFilters, invoiceListOptions, type InvoiceFilters as Filters } from '@/lib/invoice-query';
import { useCurrency } from '@/lib/queries';

const statusTone: Record<InvoiceStatus, 'warning' | 'success' | 'neutral' | 'danger'> = {
  PENDING: 'warning', PROCESSING: 'warning', PAID: 'success', CANCELED: 'neutral', EXPIRED: 'danger',
};
const statusLabel = { PENDING: 'invoice.pending', PROCESSING: 'invoice.processing', PAID: 'invoice.paid', CANCELED: 'invoice.canceled', EXPIRED: 'invoice.expired' } as const;
const typeLabel = { PURCHASE: 'invoice.purchase', RENEW: 'invoice.renew', TRAFFIC_RESET: 'invoice.trafficReset' } as const;

function InvoiceTime({ value }: { value: string }) {
  return <time dateTime={value} className="tabular block whitespace-nowrap text-[13px] leading-5 text-fg-2"><span className="block">{formatDate(value, 'YYYY-MM-DD')}</span><span className="block text-xs text-fg-3">{formatDate(value, 'HH:mm:ss')}</span></time>;
}

export default function Invoices() {
  const { t } = useI18n();
  const currency = useCurrency();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<Filters>(emptyFilters);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const query = useQuery({
    ...invoiceListOptions(filters, page, pageSize),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(filters.q || filters.type !== 'ALL' || filters.startDate || filters.endDate);
  const canReset = filtered || !!(draft.q || draft.type !== 'ALL' || draft.startDate || draft.endDate);
  const reset = () => { setDraft(emptyFilters); setFilters(emptyFilters); setPage(1); };
  return (
    <div>
      <PageHeader title={t('invoice.title')} description={t('invoice.subtitle')} />
      <Card className="overflow-hidden">
        <div className="border-b border-line bg-surface-2/20 px-4 pt-4 pb-3 sm:px-5">
          <form className="grid grid-cols-2 items-center gap-2.5 xl:flex" onSubmit={(e) => {
            e.preventDefault();
            const next = { ...draft, q: draft.q.trim() };
            const unchanged = page === 1 && Object.entries(next).every(([key, value]) => filters[key as keyof Filters] === value);
            setFilters(next);
            setPage(1);
            if (unchanged) void query.refetch();
          }}>
            <div className="relative col-span-2 min-w-0 xl:flex-1">
              <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-4" />
              <Input aria-label={t('invoice.searchPlaceholder')} placeholder={t('invoice.searchPlaceholder')} value={draft.q} maxLength={100} onChange={(e) => setDraft((v) => ({ ...v, q: e.target.value }))} className="h-10 pl-9" />
            </div>
            <Select<Filters['type']> aria-label={t('invoice.allTypes')} value={draft.type} onChange={(type) => setDraft((v) => ({ ...v, type }))} options={[{ value: 'ALL', label: t('invoice.allTypes') }, ...INVOICE_TYPES.map((type) => ({ value: type, label: t(typeLabel[type]) }))]} className="col-span-2 h-10 xl:w-36 xl:shrink-0" />
            <label className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2 xl:shrink-0">
              <span className="shrink-0 text-xs text-fg-3">{t('invoice.startDate')}</span>
              <Input type="date" aria-label={t('invoice.startDate')} value={draft.startDate} max={draft.endDate || undefined} onChange={(e) => setDraft((v) => ({ ...v, startDate: e.target.value }))} className="h-10 sm:w-38" />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2 xl:shrink-0">
              <span className="shrink-0 text-xs text-fg-3">{t('invoice.endDate')}</span>
              <Input type="date" aria-label={t('invoice.endDate')} value={draft.endDate} min={draft.startDate || undefined} onChange={(e) => setDraft((v) => ({ ...v, endDate: e.target.value }))} className="h-10 sm:w-38" />
            </label>
            <Button type="submit" variant="primary" loading={query.isFetching} className="col-span-2 h-10 shrink-0 px-5">{t('invoice.query')}</Button>
          </form>
          <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-xs text-fg-3">
            <div className="flex items-center gap-3" aria-live="polite">
              <span className="tabular">{query.data ? t('invoice.count', { n: query.data.total }) : query.isError ? '—' : t('common.loading')}</span>
              {canReset && <button type="button" onClick={reset} className="text-fg-2 underline decoration-line-strong underline-offset-4 hover:text-fg">{t('common.reset')}</button>}
            </div>
            <Link to="/console/billing" className="inline-flex shrink-0 items-center gap-1.5 text-fg-2 transition-colors hover:text-fg"><Wallet className="size-3.5" />{t('nav.billing')}</Link>
          </div>
        </div>
        {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : <DataTable<InvoiceDTO>
          rows={query.data?.items}
          rowKey={(invoice) => invoice.id}
          loading={query.isLoading || query.isPlaceholderData}
          refreshing={query.isFetching}
          onRowClick={(invoice) => navigate(`/console/invoices/${invoice.id}`)}
          empty={<Empty icon={<ReceiptText />} title={t(filtered ? 'invoice.noResults' : 'invoice.empty')} action={filtered ? <Button size="sm" onClick={reset}>{t('common.reset')}</Button> : undefined} />}
          columns={[
            { key: 'no', header: t('invoice.number'), mobile: 'full', cell: (invoice) => <Link to={`/console/invoices/${invoice.id}`} onClick={(e) => e.stopPropagation()} className="tabular whitespace-nowrap text-xs text-fg-2 underline-offset-4 hover:text-fg hover:underline">{invoice.no}</Link> },
            { key: 'name', header: t('invoice.name'), mobile: 'title', className: 'w-[27%] min-w-48', cell: (invoice) => {
              const config = invoice.purchaseConfig;
              const title = config ? `${config.product} / ${config.plan}` : invoice.plan ? `${invoice.plan.product} / ${invoice.plan.name}` : invoice.instance?.hostname ?? invoice.description;
              const hostname = config?.hostname ?? invoice.instance?.hostname;
              return <div className="max-w-sm"><div className="font-medium leading-5 break-words text-fg">{title}</div><div className="mt-1 text-xs leading-5 text-fg-3">{t(typeLabel[invoice.type])}{hostname ? ` · ${hostname}` : ''}</div></div>;
            } },
            { key: 'amount', header: t('invoice.amount'), className: 'text-right', headerClassName: 'text-right', cell: (invoice) => <div className="tabular whitespace-nowrap"><div className="font-semibold text-fg">{formatMoney(invoice.amount, currency)}</div>{Number(invoice.discount) > 0 && <div className="mt-1 text-[11px] text-success-text">{t(invoice.discountSource === 'NIGHT_MARKET' ? 'billingAdmin.nightDiscount' : invoice.discountSource === 'COUPON' ? 'billingAdmin.couponDiscount' : 'billingAdmin.otherDiscount')} −{formatMoney(invoice.discount, currency)}</div>}</div> },
            { key: 'status', header: t('invoice.paymentStatus'), cell: (invoice) => <Badge dot tone={statusTone[invoice.status]} className="rounded-md px-2 py-1.5 ring-0">{t(statusLabel[invoice.status])}</Badge> },
            { key: 'createdAt', header: t('invoice.createdAt'), cell: (invoice) => <InvoiceTime value={invoice.createdAt} /> },
            { key: 'updatedAt', header: t('common.updatedAt'), cell: (invoice) => invoice.updatedAt !== invoice.createdAt ? <InvoiceTime value={invoice.updatedAt} /> : <span className="whitespace-nowrap text-xs text-fg-3">{t('invoice.noUpdates')}</span> },
            { key: 'actions', header: t('common.actions'), headerClassName: 'text-right', className: 'border-l border-line/70 text-right', cell: (invoice) => <LinkButton size="sm" to={`/console/invoices/${invoice.id}`} onClick={(e) => e.stopPropagation()} className="h-8 px-3.5">{t('invoice.viewDetails')}</LinkButton> },
          ]}
        />}
        {query.data && !query.isError && <Pagination page={page} pageSize={pageSize} total={query.data.total} onChange={setPage} onPageSizeChange={(size) => { setPageSize(size); setPage(1); }} pageSizes={[20, 50, 100]} />}
      </Card>
    </div>
  );
}

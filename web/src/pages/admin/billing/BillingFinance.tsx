import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useDeferredValue, useState } from 'react';
import type { AdminOrdersDTO, OrderStatus } from '../../../shared/index';
import { Toolbar } from '@/components/page';
import { Input } from '@/components/ui/input';
import { Badge, Empty, ErrorState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { BillingMetrics, DiscountCell, numericHeader } from './billing-ui';

/** 订单金额包含已全退订单，退款单独列出；真实资金变动以余额流水为准。 */
export function Orders() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin-orders', q, status, page],
    queryFn: () => api.get<AdminOrdersDTO>('/admin/orders', { q: q || undefined, status: status === 'all' ? undefined : status, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const m = (value?: string) => (value === undefined ? '—' : formatMoney(value, currency));
  return (
    <>
      {!list.error && (
        <BillingMetrics
          busy={list.isFetching}
          className="border-b border-line"
          items={[
            { label: t('billingAdmin.orderPaidTotal'), value: m(list.data?.amountTotal), hint: t('billingAdmin.orderPaidHint') },
            { label: t('billingAdmin.discountAmount'), value: m(list.data?.discountTotal), hint: t('billingAdmin.orderDiscountHint') },
            { label: t('billingAdmin.refundedOrders'), value: m(list.data?.refundedTotal), hint: t('billingAdmin.refundedOrdersHint') },
            { label: t('billingAdmin.matchingRecords'), value: list.data?.total ?? '—', hint: t('billingAdmin.filteredTotals') },
          ]}
        />
      )}
      <Toolbar
        right={
          <span aria-live="polite" className="pt-2 text-xs text-fg-3">
            {list.isFetching ? t('common.loading') : t('billingAdmin.orderLedgerHint')}
          </span>
        }
      >
        <Select<OrderStatus | 'all'>
          aria-label={t('common.status')}
          className="sm:w-40"
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
          options={[
            { value: 'all', label: t('common.all'), description: t('billingAdmin.allOrdersHint') },
            { value: 'PAID', label: t('common.paid'), description: t('billingAdmin.paidOrdersHint') },
            { value: 'REFUNDED', label: t('common.refunded'), description: t('billingAdmin.refundedOrdersHint') },
          ]}
        />
        <div className="relative min-w-0 sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input
            aria-label={t('finance.searchOrders')}
            className="pl-9"
            placeholder={t('finance.searchOrders')}
            value={search}
            maxLength={100}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
      </Toolbar>
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(o) => o.id}
          empty={<Empty title={t('billing.noOrders')} />}
          columns={[
            {
              key: 'desc',
              header: t('billingAdmin.orderProduct'),
              mobile: 'title',
              className: 'min-w-40',
              cell: (o) => (
                <div className="max-w-sm space-y-1 break-words">
                  <div className="font-medium text-fg">{o.plan ? `${o.plan.product} / ${o.plan.name}` : (o.description ?? t('billingAdmin.customInstance'))}</div>
                  <div className="text-xs text-fg-3">
                    {[
                      o.type === 'NEW' ? t('common.orderNew') : t('common.orderRenew'),
                      o.instance?.hostname,
                      L.billingCycle[o.cycle],
                      o.instance && L.instanceType[o.instance.type],
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                  {o.plan && o.type === 'RENEW' && o.description && <div className="text-xs text-fg-3">{o.description}</div>}
                </div>
              ),
            },
            { key: 'user', header: t('common.user'), cell: (o) => <span className="font-medium text-fg-2">{o.user?.username ?? '—'}</span> },
            {
              key: 'original',
              header: numericHeader(t('billingAdmin.originalAmount')),
              cell: (o) => <span className="tabular block whitespace-nowrap text-fg-3 md:text-right">{formatMoney(Number(o.amount) + Number(o.discount), currency)}</span>,
            },
            {
              key: 'discount',
              header: numericHeader(t('billingAdmin.discountAmount')),
              cell: (o) => <DiscountCell discount={o.discount} source={o.discountSource} code={o.couponCode} currency={currency} />,
            },
            {
              key: 'amount',
              header: numericHeader(t('billingAdmin.orderPaid')),
              cell: (o) => <span className="tabular block font-semibold whitespace-nowrap text-fg md:text-right">{m(o.amount)}</span>,
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (o) => (
                <Badge tone={o.status === 'PAID' ? 'success' : 'warning'} dot>
                  {o.status === 'PAID' ? t('common.paid') : t('common.refunded')}
                </Badge>
              ),
            },
            {
              key: 'no',
              header: t('billingAdmin.orderAndTime'),
              mobile: 'full',
              cell: (o) => (
                <div className="space-y-1">
                  <div className="font-mono text-xs break-all text-fg-2">{o.no}</div>
                  <div className="tabular text-xs whitespace-nowrap text-fg-3">{formatDate(o.createdAt, 'YYYY-MM-DD HH:mm:ss')}</div>
                </div>
              ),
            },
          ]}
        />
      )}
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
    </>
  );
}

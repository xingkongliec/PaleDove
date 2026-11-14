import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { AFF_LOG_STATUSES, AFF_LOG_TYPES, type AdminAffLogDTO, type AffLogStatus, type AffLogType, type Paginated } from '@/shared/index';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, Empty, ErrorState, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dayjs, formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';

interface Filters {
  q: string;
  type: AffLogType | 'ALL';
  status: AffLogStatus | 'ALL';
  startDate: string;
  endDate: string;
}
const emptyFilters: Filters = { q: '', type: 'ALL', status: 'ALL', startDate: '', endDate: '' };
const statusTone = { PENDING: 'warning', SETTLED: 'success', CANCELED: 'neutral' } as const;

/** 全站返利流水：返佣、退款撤回和转入余额分别展示，设置关闭后仍可查看历史。 */
export function AffRecords() {
  const t = useT();
  const currency = useCurrency();
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const list = useQuery({
    queryKey: ['admin-aff-logs', filters, page, pageSize],
    queryFn: () => api.get<Paginated<AdminAffLogDTO>>('/admin/aff/logs', {
      q: filters.q || undefined,
      type: filters.type === 'ALL' ? undefined : filters.type,
      status: filters.status === 'ALL' ? undefined : filters.status,
      startAt: filters.startDate ? dayjs(filters.startDate).startOf('day').toISOString() : undefined,
      endAt: filters.endDate ? dayjs(filters.endDate).add(1, 'day').startOf('day').toISOString() : undefined,
      page, pageSize,
    }),
    placeholderData: keepPreviousData,
  });
  const m = (value: string) => formatMoney(value, currency);
  const userLink = (user: AdminAffLogDTO['user']) => <Link to={`/admin/users/${user.id}`} className="font-medium break-all text-fg-2 hover:text-primary">{user.username}<span className="ml-1.5 text-xs font-normal text-fg-4">#{user.id}</span></Link>;
  return (
    <Card className="overflow-hidden">
      <CardHeader title={t('adminAff.title')} description={t('adminAff.description')} actions={<Button size="sm" icon={<RefreshCw />} loading={list.isFetching} onClick={() => void list.refetch()}>{t('common.refresh')}</Button>} />
      <form className="space-y-2 border-b border-line px-4 py-3 sm:px-5" onSubmit={event => {
        event.preventDefault();
        setFilters({ ...draft, q: draft.q.trim() });
        setPage(1);
      }}>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <div className="relative col-span-2 min-w-0 sm:min-w-64 sm:flex-1">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <Input aria-label={t('adminAff.search')} placeholder={t('adminAff.search')} maxLength={100} className="pl-9" value={draft.q} onChange={event => setDraft(v => ({ ...v, q: event.target.value }))} />
          </div>
          <Select<Filters['type']> className="sm:w-36" aria-label={t('common.type')} value={draft.type} onChange={type => setDraft(v => ({ ...v, type }))} options={[{ value: 'ALL', label: t('adminAff.allTypes') }, ...AFF_LOG_TYPES.map(value => ({ value, label: t(`aff.type.${value}`) }))]} />
          <Select<Filters['status']> className="sm:w-36" aria-label={t('common.status')} value={draft.status} onChange={status => setDraft(v => ({ ...v, status }))} options={[{ value: 'ALL', label: t('adminAff.allStatuses') }, ...AFF_LOG_STATUSES.map(value => ({ value, label: t(`adminAff.status.${value}`) }))]} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
          <label className="min-w-0 text-xs text-fg-3">{t('invoice.startDate')}<Input type="date" aria-label={t('invoice.startDate')} className="mt-1 w-full sm:w-40" max={draft.endDate || undefined} value={draft.startDate} onChange={event => setDraft(v => ({ ...v, startDate: event.target.value }))} /></label>
          <label className="min-w-0 text-xs text-fg-3">{t('invoice.endDate')}<Input type="date" aria-label={t('invoice.endDate')} className="mt-1 w-full sm:w-40" min={draft.startDate || undefined} value={draft.endDate} onChange={event => setDraft(v => ({ ...v, endDate: event.target.value }))} /></label>
          <div className="col-span-2 flex items-center gap-2 sm:contents">
            <Button type="submit" variant="primary" loading={list.isFetching}>{t('invoice.query')}</Button>
            <Button variant="ghost" onClick={() => { setDraft(emptyFilters); setFilters(emptyFilters); setPage(1); }}>{t('common.reset')}</Button>
            <span aria-live="polite" className="ml-auto text-xs text-fg-3 sm:pb-2">{list.isError ? '' : list.data && !list.isPlaceholderData ? t('adminAff.count', { n: list.data.total }) : t('common.loading')}</span>
          </div>
        </div>
      </form>
      {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : <DataTable
        rows={list.data?.items} rowKey={row => row.id} loading={list.isLoading} refreshing={list.isFetching}
        empty={<Empty title={t('adminAff.empty')} description={t('adminAff.emptyHint')} />}
        columns={[
          { key: 'user', header: t('adminAff.referrer'), mobile: 'title', cell: row => userLink(row.user) },
          { key: 'invitee', header: t('aff.invitee'), cell: row => row.invitee ? userLink(row.invitee) : <span className="text-fg-4">—</span> },
          { key: 'order', header: t('adminAff.order'), mobile: 'full', cell: row => row.order ? <div className="space-y-1"><div className="font-mono text-xs break-all text-fg-2">{row.order.no}</div><div className="text-xs text-fg-3">{t(row.order.type === 'RENEW' ? 'aff.kindRenew' : 'aff.kindNew')} · {t('adminAff.orderPaid')} {m(row.order.amount)}{row.order.status === 'REFUNDED' && <span className="ml-1.5 text-danger-text">{t('common.refunded')}</span>}</div></div> : <span className="text-fg-4">—</span> },
          { key: 'base', header: t('adminAff.base'), cell: row => row.orderAmount !== null ? <div className="tabular whitespace-nowrap text-fg-2">{m(row.orderAmount)}{row.rate !== null && <div className="mt-1 text-xs text-fg-3">× {row.rate}%</div>}</div> : <span className="text-fg-4">—</span> },
          { key: 'amount', header: t('adminAff.amount'), cell: row => <span className={cn('tabular font-medium whitespace-nowrap text-fg', row.status === 'CANCELED' && 'text-fg-4 line-through')}>{Number(row.amount) > 0 ? '+' : ''}{m(row.amount)}</span> },
          { key: 'balance', header: t('aff.balanceAfter'), cell: row => <span className="tabular whitespace-nowrap text-fg-2">{row.balanceAfter === null ? '—' : m(row.balanceAfter)}</span> },
          { key: 'status', header: t('adminAff.entry'), mobile: 'actions', cell: row => <div className="space-y-1.5"><div className="text-xs text-fg-2">{t(`aff.type.${row.type}`)}</div><Tag tone={statusTone[row.status]}>{t(`adminAff.status.${row.status}`)}</Tag></div> },
          { key: 'time', header: t('common.time'), mobile: 'full', cell: row => <div className="space-y-1 text-xs text-fg-3"><time className="tabular whitespace-nowrap" dateTime={row.createdAt}>{formatDate(row.createdAt, 'YYYY-MM-DD HH:mm:ss')}</time>{row.type === 'EARN' && row.status !== 'CANCELED' && row.effectiveAt && <div className="tabular whitespace-nowrap">{t(row.status === 'PENDING' ? 'aff.expected' : 'aff.actual')} {formatDate(row.effectiveAt, 'MM-DD HH:mm')}</div>}</div> },
        ]}
      />}
      {list.data && !list.isError && <Pagination page={page} pageSize={pageSize} total={list.data.total} onChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />}
    </Card>
  );
}

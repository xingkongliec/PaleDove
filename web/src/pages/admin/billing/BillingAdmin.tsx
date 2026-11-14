import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, Minus, Search } from 'lucide-react';
import { useDeferredValue, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { BALANCE_LOG_TYPES, type AdminBillingOverviewDTO, type AdminBillingRecordsDTO, type BalanceLogDTO, type BalanceLogType, type BillingChange, type BillingRecordKind } from '../../../shared/index';
import { AmountText } from '@/components/billing/AmountText';
import { PageHeader, Toolbar } from '@/components/page';
import { Input } from '@/components/ui/input';
import { Badge, Card, Empty, ErrorState, PageLoading } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { Orders } from './BillingFinance';
import { Invoices } from './Invoices';
import { PayChannels } from './PayChannels';
import { BillingMetrics, DiscountCell, billingTableClass, numericHeader } from './billing-ui';

type Tab = 'overview' | 'invoices' | 'records' | 'payment';

function Line({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5 text-[13px]">
      <span className="min-w-0 text-fg-3">{label}</span>
      <span className="tabular shrink-0 font-medium text-fg">{children}</span>
    </div>
  );
}

function DetailPanel({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-line px-4 py-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        {hint && <span className="text-xs text-fg-3">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function MonthMetric({ label, value, previous, previousFull, change, hint }: { label: string; value: string; previous: string; previousFull: string; change: BillingChange; hint?: string }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const difference = Number(change.difference);
  const direction = difference > 0 ? 'growth' : difference < 0 ? 'decline' : 'unchanged';
  const Icon = difference > 0 ? ArrowUpRight : difference < 0 ? ArrowDownRight : Minus;
  const m = (v: string | number) => formatMoney(v, currency);
  return (
    <section className="min-w-0 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium text-fg-2">{label}</h2>
        {hint && <span className="text-xs text-fg-3">{hint}</span>}
      </div>
      <div className="mt-1 tabular text-2xl leading-8 font-semibold tracking-tight break-words text-fg">{m(value)}</div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-5">
        <span className="text-fg-3">{t('billingAdmin.vsLastMonth')}</span>
        <span className={cn('inline-flex items-center gap-0.5 font-medium', difference > 0 ? 'text-success-text' : difference < 0 ? 'text-danger-text' : 'text-fg-2')}>
          <Icon aria-hidden="true" className="size-3.5" />
          {t(`billingAdmin.${direction}`)}
          {change.percent !== null && difference !== 0 && <span className="ml-0.5 tabular">{change.percent === 0 ? '<0.1' : Math.abs(change.percent).toFixed(1)}%</span>}
        </span>
        {difference !== 0 && <span className="tabular text-fg-2">({difference > 0 ? '+' : '−'}{m(Math.abs(difference))})</span>}
        {change.percent === null && <span className="text-fg-3">{t(Number(previous) < 0 ? 'billingAdmin.negativeBaseline' : 'billingAdmin.zeroBaseline')}</span>}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs leading-5 text-fg-3">
        <span>{t('billingAdmin.lastMonthToDate')} <span className="tabular text-fg-2">{m(previous)}</span></span>
        <span>{t('billingAdmin.lastFullMonth')} <span className="tabular text-fg-2">{m(previousFull)}</span></span>
      </div>
    </section>
  );
}

function Overview() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const q = useQuery({ queryKey: ['admin-billing-overview'], queryFn: () => api.get<AdminBillingOverviewDTO>('/admin/billing/overview'), refetchInterval: 60_000 });
  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data;
  const m = (v: string | number) => formatMoney(v, currency);
  const productTotal = o.incomeByProduct.reduce((n, p) => n + Number(p.amount), 0);
  const amountWithCount = (amount: string, count: number) => (
    <><span className="mr-2 text-xs font-normal text-fg-3">{t('billingAdmin.recordSum', { n: count })}</span>{m(amount)}</>
  );
  return (
    <div className="space-y-3">
      <Card className="grid divide-y divide-line sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <MonthMetric
          label={t('billingAdmin.monthIncome')}
          value={o.income.month}
          previous={o.income.lastMonthToDate}
          previousFull={o.income.lastMonth}
          change={o.income.change}
          hint={t('billingAdmin.incomeEquation', { gross: m(o.income.monthCharges.amount), refund: m(o.income.monthRefunds.amount) })}
        />
        <MonthMetric
          label={t('billingAdmin.monthRecharge')}
          value={o.recharge.month.amount}
          previous={o.recharge.lastMonthToDate.amount}
          previousFull={o.recharge.lastMonth.amount}
          change={o.recharge.change}
          hint={t('billingAdmin.rechargeCounts', { current: o.recharge.month.count, previous: o.recharge.lastMonthToDate.count })}
        />
      </Card>

      <div className="grid gap-3 lg:grid-cols-3">
        <DetailPanel title={t('billingAdmin.monthStructure')} hint={t('billingAdmin.monthScope')}>
          <Line label={L.balanceLogType.PURCHASE}>{m(o.monthIncomeByType.purchase)}</Line>
          <Line label={L.balanceLogType.RENEW}>{m(o.monthIncomeByType.renew)}</Line>
          <Line label={t('billingAdmin.otherServiceCharges')}>{m(o.monthIncomeByType.other)}</Line>
          <div className="mt-1 border-t border-line pt-1">
            <Line label={t('billingAdmin.serviceCharges')}>{amountWithCount(o.income.monthCharges.amount, o.income.monthCharges.count)}</Line>
            <Line label={t('billingAdmin.refund')}>
              {amountWithCount(o.income.monthRefunds.amount, o.income.monthRefunds.count)}
            </Line>
            <Line label={t('billingAdmin.todayIncome')}>{m(o.income.today)}</Line>
          </div>
        </DetailPanel>
        <DetailPanel title={t('billingAdmin.monthActivity')} hint={t('billingAdmin.monthScope')}>
          <Line label={t('billingAdmin.online')}>{amountWithCount(o.recharge.monthOnline.amount, o.recharge.monthOnline.count)}</Line>
          <Line label={L.balanceLogType.REDEEM}>{amountWithCount(o.recharge.monthRedeem.amount, o.recharge.monthRedeem.count)}</Line>
          <Line label={t('billingAdmin.todayRechargeLabel')}>{amountWithCount(o.recharge.today.amount, o.recharge.today.count)}</Line>
          <div className="mt-1 border-t border-line pt-1">
            <Line label={t('billingAdmin.monthPaidOrders')}>{amountWithCount(o.monthOrders.amount, o.monthOrders.count)}</Line>
            <Line label={t('billingAdmin.orderTypeCounts', { new: o.monthOrders.newCount, renew: o.monthOrders.renewCount })}>
              <span className="text-xs font-normal text-fg-3">{t('billingAdmin.excludesFullRefunds')}</span>
            </Line>
            <Line label={t('billingAdmin.discountAmount')}>
              {amountWithCount(o.monthOrders.discount, o.monthOrders.discountedCount)}
            </Line>
          </div>
        </DetailPanel>
        <DetailPanel title={t('billingAdmin.byProduct')} hint={t('billingAdmin.cumulativePaidOrders')}>
          {o.incomeByProduct.length === 0 ? (
            <p className="py-6 text-sm text-fg-3">{t('billingAdmin.noIncome')}</p>
          ) : (
            o.incomeByProduct.map((p) => (
              <div key={p.productId ?? 'custom'} className="py-1">
                <div className="flex items-baseline justify-between gap-3 text-[13px]">
                  <span className="min-w-0 break-words text-fg-2">{p.name}</span>
                  <span className="tabular shrink-0 font-medium text-fg">{m(p.amount)}</span>
                </div>
                <div className="mt-1 flex items-center gap-3">
                  <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: `${productTotal > 0 ? Math.min(100, (Number(p.amount) / productTotal) * 100) : 0}%` }} />
                  </div>
                  <span className="shrink-0 text-xs text-fg-3">{t('billingAdmin.orders', { n: p.count })}</span>
                </div>
              </div>
            ))
          )}
          <p className="mt-2 text-xs leading-5 text-fg-3">{t('billingAdmin.discountNoDoubleCount')}</p>
        </DetailPanel>
      </div>

      <Card>
        <BillingMetrics
          className="gap-y-3 py-2.5 [&_dd:first-of-type]:mt-1 [&_dd:first-of-type]:leading-6"
          items={[
            { label: t('billingAdmin.netIncome'), value: m(o.income.total), hint: t('billingAdmin.incomeEquation', { gross: m(o.income.gross), refund: m(o.income.refund) }) },
            {
              label: t('billingAdmin.totalRecharge'), value: m(o.recharge.total.amount),
              hint: <>{t('billingAdmin.recordSum', { n: o.recharge.total.count })} · {t('billingAdmin.online')} {m(o.recharge.online)} · {L.balanceLogType.REDEEM} {m(o.recharge.redeem)}</>,
            },
            { label: t('billingAdmin.totalDiscount'), value: m(o.discounts.total.amount), hint: <>
              <span className="block">{t('billingAdmin.nightDiscount')} {m(o.discounts.nightMarket.amount)}</span>
              <span className="block">{t('billingAdmin.couponDiscount')} {m(o.discounts.coupon.amount)}</span>
              {Number(o.discounts.other.amount) > 0 && <span className="block">{t('billingAdmin.otherDiscount')} {m(o.discounts.other.amount)}</span>}
            </> },
            {
              label: t('billingAdmin.userBalance'), value: m(o.balance.total),
              hint: <>{t('billingAdmin.balanceUsers', { n: o.balance.users })} · {t('billingAdmin.manualNet')} <AmountText amount={o.adjust} currency={currency} /></>,
            },
          ]}
        />
      </Card>

      <div className="text-xs leading-5 text-fg-3">
        <p>{t('billingAdmin.incomeScope')}</p>
        <p>{t('billingAdmin.comparisonScope')} · {t('billingAdmin.reportAsOf', { time: formatDate(o.period.asOf) })}</p>
      </div>
    </div>
  );
}

const RECORD_TYPES: Record<BillingRecordKind, readonly BalanceLogType[]> = {
  all: BALANCE_LOG_TYPES,
  recharge: ['RECHARGE', 'REDEEM', 'ADJUST'],
  charge: ['PURCHASE', 'RENEW', 'REFUND', 'TRANSFER', 'TRAFFIC', 'SWITCH', 'MARKET', 'ADJUST'],
};

/** 余额明细 / 充值记录 / 扣费记录共用同一资金口径。 */
function Records({ kind, onKindChange }: { kind: BillingRecordKind; onKindChange: (kind: BillingRecordKind) => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [type, setType] = useState<BalanceLogType | 'all'>('all');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin-billing-records', kind, type, q, page],
    queryFn: () => api.get<AdminBillingRecordsDTO>('/admin/billing/records', { kind, type: type === 'all' ? undefined : type, q: q || undefined, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const m = (v?: string) => (v === undefined ? '—' : formatMoney(v, currency));
  const typeLabel = (ty: BalanceLogType) =>
    ty === 'ADJUST' && kind !== 'all' ? t(kind === 'recharge' ? 'billingAdmin.adjustAdd' : 'billingAdmin.adjustSub') : L.balanceLogType[ty];
  const detail = (l: BalanceLogDTO) => (
    <div className="max-w-sm space-y-1 break-words">
      <div className="font-medium text-fg">{l.order?.plan ?? l.description ?? typeLabel(l.type)}</div>
      {l.order && (
        <div className="text-xs text-fg-3">{[l.order.hostname, l.order.type && L.instanceType[l.order.type], L.billingCycle[l.order.cycle]].filter(Boolean).join(' · ')}</div>
      )}
      {l.order && l.type === 'REFUND' && <div className="text-xs text-fg-3">{l.description}</div>}
      {l.ref && <div className="font-mono text-xs break-all text-fg-3">{l.ref}</div>}
    </div>
  );
  const payment = (l: BalanceLogDTO) => {
    if (l.payment)
      return (
        <div className="space-y-1 text-xs">
          <div className="font-medium break-words text-fg">{l.payment.channelName ?? t('billingAdmin.unknownChannel')}</div>
          <div className="text-fg-3">{l.payment.methodName}</div>
        </div>
      );
    if (l.type === 'RECHARGE') return <span className="text-xs text-fg-3">{t('billingAdmin.unknownPayment')}</span>;
    if (l.type === 'REDEEM' || l.type === 'ADJUST') return <span className="text-fg-2">{typeLabel(l.type)}</span>;
    return <span className="text-fg-4">—</span>;
  };
  return (
    <Card className={cn('overflow-hidden', billingTableClass)}>
      {!list.error && (
        <BillingMetrics
          busy={list.isFetching}
          className={cn('border-b border-line', kind === 'recharge' && 'lg:grid-cols-2')}
          items={
            kind === 'recharge'
              ? [
                  { label: t('billingAdmin.creditTotal'), value: m(list.data?.creditTotal), hint: t('billingAdmin.kindHint.recharge') },
                  { label: t('billingAdmin.matchingRecords'), value: list.data?.total ?? '—', hint: t('billingAdmin.filteredTotals') },
                ]
              : [
                  { label: t('billingAdmin.debitTotal'), value: m(list.data?.debitTotal), hint: t('billingAdmin.debitHint') },
                  {
                    label: t(kind === 'charge' ? 'billingAdmin.returnedTotal' : 'billingAdmin.creditTotal'),
                    value: m(list.data?.creditTotal),
                    hint: t(kind === 'charge' ? 'billingAdmin.returnedHint' : 'billingAdmin.creditHint'),
                  },
                  { label: t('billingAdmin.netChange'), value: list.data ? <AmountText amount={list.data.sum} currency={currency} /> : '—', hint: t('billingAdmin.netHint') },
                  { label: t('billingAdmin.matchingRecords'), value: list.data?.total ?? '—', hint: t('billingAdmin.filteredTotals') },
                ]
          }
        />
      )}
      <Toolbar
        right={
          list.isFetching && (
            <span aria-live="polite" className="pt-2 text-xs text-fg-3">
              {t('common.loading')}
            </span>
          )
        }
      >
        <Select<BillingRecordKind>
          aria-label={t('billingAdmin.recordScope')}
          className="sm:w-40"
          value={kind}
          onChange={onKindChange}
          options={(['all', 'recharge', 'charge'] as const).map(value => ({ value, label: t(`billingAdmin.scope.${value}`), description: t(`billingAdmin.kindHint.${value}`) }))}
        />
        <Select<BalanceLogType | 'all'>
          aria-label={t('common.type')}
          className="sm:w-44"
          value={type}
          onChange={(v) => {
            setType(v);
            setPage(1);
          }}
          options={[
            { value: 'all', label: t('common.all'), description: t(`billingAdmin.kindHint.${kind}`) },
            ...RECORD_TYPES[kind].map((ty) => ({ value: ty, label: typeLabel(ty), description: t(`billingAdmin.typeHint.${ty}`) })),
          ]}
        />
        <div className="relative min-w-0 sm:w-80">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input
            aria-label={t('billingAdmin.search')}
            className="pl-9"
            value={search}
            maxLength={100}
            placeholder={t('billingAdmin.search')}
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
          rowKey={(l) => l.id}
          empty={<Empty title={t(kind === 'all' ? 'billing.noLogs' : kind === 'recharge' ? 'billingAdmin.noRecharge' : 'billingAdmin.noCharge')} />}
          columns={[
            { key: 'desc', header: t(kind === 'recharge' ? 'billingAdmin.sourceDetail' : 'billingAdmin.orderProduct'), mobile: 'title', className: 'min-w-40', cell: detail },
            { key: 'user', header: t('common.user'), cell: (l) => <span className="font-medium text-fg-2">{l.user?.username ?? '—'}</span> },
            { key: 'type', header: t('common.type'), cell: (l) => <Badge tone="neutral">{typeLabel(l.type)}</Badge> },
            ...(kind !== 'charge' ? [{ key: 'payment', header: t('billingAdmin.paymentDetail'), mobile: 'full' as const, cell: payment }] : []),
            ...(kind === 'recharge'
              ? [
                  {
                    key: 'paid',
                    header: numericHeader(t('billingAdmin.paymentPaid')),
                    cell: (l: BalanceLogDTO) =>
                      l.payment ? (
                        <div className="space-y-1 md:text-right">
                          <div className="tabular font-medium whitespace-nowrap text-fg">
                            {l.payment.payAmount} {l.payment.currency.toUpperCase()}
                          </div>
                          <div className="text-xs whitespace-nowrap text-fg-3">
                            {t('billingAdmin.fee')} {m(l.payment.fee)}
                          </div>
                        </div>
                      ) : (
                        <span className="block text-fg-4 md:text-right">—</span>
                      ),
                  },
                ]
              : [
                  {
                    key: 'discount',
                    header: numericHeader(t('billingAdmin.discountAmount')),
                    cell: (l: BalanceLogDTO) =>
                      l.order && l.type !== 'REFUND' ? (
                        <DiscountCell discount={l.order.discount} source={l.order.discountSource} code={l.order.couponCode} currency={currency} />
                      ) : (
                        <span className="block text-fg-4 md:text-right">—</span>
                      ),
                  },
                ]),
            {
              key: 'amount',
              header: numericHeader(t(kind === 'recharge' ? 'billingAdmin.credited' : 'billingAdmin.balanceChange')),
              cell: (l) => (
                <div className="md:text-right">
                  <AmountText amount={l.amount} currency={currency} />
                  {l.order && l.type !== 'REFUND' && (
                    <div className="mt-1 text-xs whitespace-nowrap text-fg-3">
                      {t('billingAdmin.originalAmount')} {formatMoney(Number(l.order.amount) + Number(l.order.discount), currency)}
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: 'after',
              header: numericHeader(t('billingAdmin.balanceAfter')),
              cell: (l) => <span className="tabular block whitespace-nowrap text-fg-2 md:text-right">{m(l.balanceAfter)}</span>,
            },
            {
              key: 'time',
              header: t('common.time'),
              cell: (l) => (
                <span className="tabular text-xs whitespace-nowrap text-fg-3">
                  {formatDate(l.createdAt, 'YYYY-MM-DD')}
                  <br />
                  {formatDate(l.createdAt, 'HH:mm:ss')}
                </span>
              ),
            },
          ]}
        />
      )}
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
    </Card>
  );
}

export default function AdminBilling() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const legacyKind = requested === 'all' || requested === 'recharge' || requested === 'charge' ? requested : null;
  const tab: Tab = requested === 'orders' || requested === 'invoices' ? 'invoices' : legacyKind || requested === 'records' ? 'records' : requested === 'payment' ? 'payment' : 'overview';
  const view = requested === 'orders' || params.get('view') === 'orders' ? 'orders' : 'invoices';
  const kindParam = legacyKind ?? params.get('kind');
  const kind: BillingRecordKind = kindParam === 'recharge' || kindParam === 'charge' ? kindParam : 'all';
  const setTab = (next: Tab) => {
    const p = new URLSearchParams();
    if (next !== 'overview') p.set('tab', next);
    setParams(p, { replace: true });
  };
  return (
    <>
      <div className="[&>div]:mb-4">
        <PageHeader title={t('nav.admin.billing')} description={t('billingAdmin.subtitle')} />
      </div>
      <TabBar<Tab>
        value={tab}
        onChange={setTab}
        className="mb-3"
        listClassName="flex-wrap overflow-x-visible overflow-y-visible gap-1 [&>button]:px-2 sm:gap-1.5 sm:[&>button]:px-3"
        items={[
          { value: 'overview', label: t('billingAdmin.tabOverview') },
          { value: 'invoices', label: t('billingAdmin.tabInvoices') },
          { value: 'records', label: t('billingAdmin.tabRecords') },
          { value: 'payment', label: t('payAdmin.channels') },
        ]}
      />
      <div key={tab} className="panel-enter">
        {tab === 'overview' ? (
          <Overview />
        ) : tab === 'invoices' ? (
          <Card className={cn('overflow-hidden', billingTableClass)}>
            <Toolbar right={<span className="pt-2 text-xs text-fg-3">{t(view === 'invoices' ? 'billingAdmin.invoiceViewHint' : 'billingAdmin.ordersViewHint')}</span>}>
              <Select<'invoices' | 'orders'>
                aria-label={t('billingAdmin.documentView')}
                className="sm:w-56"
                value={view}
                onChange={next => setParams({ tab: 'invoices', ...(next === 'orders' ? { view: 'orders' } : {}) }, { replace: true })}
                options={[
                  { value: 'invoices', label: t('billingAdmin.invoiceView'), description: t('billingAdmin.invoiceViewHint') },
                  { value: 'orders', label: t('billingAdmin.ordersView'), description: t('billingAdmin.ordersViewHint') },
                ]}
              />
            </Toolbar>
            {view === 'orders' ? <Orders /> : <Invoices />}
          </Card>
        ) : tab === 'payment' ? (
          <PayChannels />
        ) : (
          <Records key={kind} kind={kind} onKindChange={next => setParams({ tab: 'records', ...(next !== 'all' ? { kind: next } : {}) }, { replace: true })} />
        )}
      </div>
    </>
  );
}

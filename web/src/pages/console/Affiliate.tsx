// 邀请推广：收益概览（可用 / 待生效 / 已生效佣金与邀请人数）、通用与套餐推广链接、佣金明细（管理员开启推广返利后在侧边栏显示）
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Clock, Copy, Gift, LayoutGrid, Link2, Package, RefreshCw, ShieldCheck, ShoppingBag, UserPlus, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { AffCommissionStatus, AffLogDTO, AffSummaryDTO, Paginated, PlanDTO, ProductDTO } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Alert, Card, Empty, ErrorState, PageLoading, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

export const useAff = () => useQuery({ queryKey: ['aff'], queryFn: () => api.get<AffSummaryDTO>('/aff'), staleTime: 30_000 });

const statusTone: Record<AffCommissionStatus, 'warning' | 'success' | 'neutral' | 'danger'> = { PENDING: 'warning', SETTLED: 'success', CANCELED: 'neutral', REVOKED: 'danger' };

/** 标题前的图标块 */
function IconChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2 [&>svg]:size-4', className)}>{children}</span>;
}

/** 分区卡片：图标 + 标题 + 说明，下方内容 */
function Section({ icon, title, desc, action, children }: { icon: ReactNode; title: string; desc: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <IconChip>{icon}</IconChip>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
            <p className="mt-0.5 text-xs text-fg-3">{desc}</p>
          </div>
        </div>
        {action}
      </div>
      {children}
    </Card>
  );
}

/** 收益概览里的统计块 */
function Metric({ icon, label, value, unit, children, highlight }: { icon: ReactNode; label: string; value: ReactNode; unit?: string; children?: ReactNode; highlight?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col rounded-lg border px-4 py-3.5', highlight ? 'border-line-strong bg-surface-2' : 'border-line bg-surface-2/40')}>
      <div className="flex items-center gap-2 text-[13px] text-fg-2">
        <IconChip className="size-6 rounded-md bg-surface [&>svg]:size-3.5">{icon}</IconChip>
        {label}
      </div>
      <div className="mt-3 flex items-baseline gap-1">
        <span className="tabular truncate text-[26px] leading-none font-semibold text-fg">{value}</span>
        {unit && <span className="text-xs text-fg-3">{unit}</span>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

/** 展示后台配置的当前返佣比例。 */
function RewardOverview({ aff }: { aff: AffSummaryDTO }) {
  const { t } = useI18n();
  const rewards = [
    { label: t('aff.rateNew'), rate: aff.rateNew, icon: <ShoppingBag /> },
    { label: t('aff.rateRenew'), rate: aff.rateRenew, icon: <RefreshCw /> },
  ];
  return (
    <Card className="overflow-hidden bg-linear-to-br from-surface-2 via-surface to-surface-3/40">
      <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_minmax(24rem,1fr)] lg:items-center lg:gap-8">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-medium text-fg-3">
            <Gift className="size-3.5" aria-hidden />
            {t('aff.rewardPlan')}
          </div>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-fg sm:text-2xl">{t('aff.rewardTitle')}</h2>
          <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-fg-3">{t('aff.rewardDesc')}</p>
        </div>
        <dl className="grid min-w-0 grid-cols-2 gap-3">
          {rewards.map(({ label, rate, icon }) => (
            <div key={label} className="min-w-0 rounded-lg border border-line bg-surface/80 p-3.5 sm:p-4">
              <dt className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
                <span className="text-fg-3 [&>svg]:size-3.5" aria-hidden>{icon}</span>
                {label}
              </dt>
              <dd className="mt-3 flex items-baseline gap-0.5 text-fg">
                <span className="tabular text-4xl leading-none font-semibold tracking-tight">{rate}</span>
                <span className="text-lg font-medium text-fg-3">%</span>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

/** 链接卡片：说明 + 链接 + 复制按钮 */
function LinkCard({ icon, title, desc, link, extra }: { icon: ReactNode; title: string; desc: string; link: string | null; extra?: ReactNode }) {
  const { t } = useI18n();
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      toast.success(t('aff.copied'));
    } catch {
      toast.error(t('common.copyFailed'));
    }
  };
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface-2/40 p-4">
      <div className="flex items-start gap-3">
        <IconChip>{icon}</IconChip>
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          <div className="mt-0.5 text-xs text-fg-3">{desc}</div>
        </div>
      </div>
      {extra}
      <div className="mt-auto flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2.5 py-1.5 font-mono text-xs text-fg-2" title={link ?? undefined}>
          {link ?? t('aff.pickPlanFirst')}
        </span>
        <Button size="sm" variant="primary" icon={<Copy />} disabled={!link} onClick={copy}>
          {t('aff.copyLink')}
        </Button>
      </div>
    </div>
  );
}

function AffContent({ aff }: { aff: AffSummaryDTO }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [planId, setPlanId] = useState<number | null>(null);
  const logs = useQuery({
    queryKey: ['aff-logs', page, pageSize],
    queryFn: () => api.get<Paginated<AffLogDTO>>('/aff/logs', { page, pageSize }),
    placeholderData: keepPreviousData,
  });
  const plans = useQuery({ queryKey: ['store-plans'], queryFn: () => api.get<PlanDTO[]>('/store/plans') });
  const products = useQuery({ queryKey: ['store-products'], queryFn: () => api.get<ProductDTO[]>('/store/products') });
  const withdraw = useMutation({
    mutationFn: () => api.post<{ amount: string; balance: string }>('/aff/withdraw'),
    onSuccess: (r) => {
      toast.success(t('aff.withdrawn', { amount: formatMoney(r.amount, currency) }), t('billing.currentBalance', { balance: formatMoney(r.balance, currency) }));
      for (const key of ['aff', 'aff-logs', 'me', 'billing-logs', 'billing-summary']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast.fromError(e),
  });
  const code = aff.code ?? '';
  const link = `${location.origin}/register?aff=${code}`;
  const planLink = planId ? `${location.origin}/store?plan=${planId}&aff=${code}` : null;
  const balance = Number(aff.balance);
  const canWithdraw = balance > 0 && balance >= aff.minWithdraw;
  const m = (v: string | number) => formatMoney(v, currency);
  const productName = (id: number) => products.data?.find((p) => p.id === id)?.name ?? '';

  return (
    <div className="space-y-4">
      <RewardOverview aff={aff} />
      <Section icon={<LayoutGrid />} title={t('aff.overview')} desc={t('aff.overviewDesc')}>
        <div className="space-y-3 p-4 sm:p-5">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <Metric icon={<Wallet />} label={t('aff.balance')} value={m(aff.balance)} highlight>
              <Button size="sm" variant="primary" icon={<ArrowRightLeft />} className="w-full" disabled={!canWithdraw} loading={withdraw.isPending} onClick={() => withdraw.mutate()}>
                {t('aff.withdraw')}
              </Button>
            </Metric>
            <Metric icon={<Clock />} label={t('aff.pending')} value={m(aff.pending)} />
            <Metric icon={<ShieldCheck />} label={t('aff.total')} value={m(aff.total)} />
            <Metric icon={<UserPlus />} label={t('aff.invited')} value={aff.invited} unit={t('aff.people')}>
              <span className="text-xs text-fg-3">{t('aff.paidHint', { n: aff.paidInvitees })}</span>
            </Metric>
          </div>
          <Alert tone="warning">
            {t('aff.notice', {
              freeze: aff.freezeDays > 0 ? t('aff.freezeOn', { days: aff.freezeDays }) : t('aff.freezeOff'),
              withdraw: aff.minWithdraw > 0 ? t('aff.minHint', { min: m(aff.minWithdraw) }) : t('aff.anyHint'),
            })}
          </Alert>
        </div>
      </Section>

      <Section icon={<Link2 />} title={t('aff.shareTitle')} desc={t('aff.rules', { rateNew: aff.rateNew, rateRenew: aff.rateRenew })}>
        <div className="grid gap-3 p-4 sm:p-5 lg:grid-cols-2">
          <LinkCard icon={<Gift />} title={t('aff.link')} desc={t('aff.linkDesc', { code })} link={link} />
          <LinkCard
            icon={<Package />}
            title={t('aff.planLink')}
            desc={t('aff.planLinkDesc')}
            link={planLink}
            extra={
              <Select
                value={planId ?? 0}
                onChange={(v) => setPlanId(v || null)}
                placeholder={t('aff.pickPlan')}
                options={[
                  { value: 0, label: t('aff.pickPlan'), description: t('aff.pickPlanDesc') },
                  ...(plans.data ?? []).map((p) => ({
                    value: p.id,
                    label: `${productName(p.productId)} · ${p.name}`,
                    description: [L.instanceType[p.type], p.regions.join('、')].filter(Boolean).join(' · '),
                  })),
                ]}
              />
            }
          />
        </div>
      </Section>

      <Section icon={<Clock />} title={t('aff.logsTitle')} desc={t('aff.logsDesc')}>
        <DataTable
          rows={logs.data?.items}
          loading={logs.isLoading}
          rowKey={(l) => l.id}
          empty={<Empty title={t('aff.noLogs')} description={t('aff.noLogsDesc')} />}
          columns={[
            { key: 'no', header: t('aff.orderNo'), mobile: 'title', cell: (l) => <span className="font-mono text-xs text-fg">{l.orderNo ?? '—'}</span> },
            { key: 'invitee', header: t('aff.invitee'), cell: (l) => <span className="font-mono text-xs text-fg-2">{l.invitee ?? '—'}</span> },
            { key: 'kind', header: t('common.type'), cell: (l) => <span className="text-fg-2">{l.orderType === 'RENEW' ? t('aff.kindRenew') : t('aff.kindNew')}</span> },
            {
              key: 'base',
              header: t('aff.orderAmount'),
              cell: (l) => (l.orderAmount ? <span className="tabular text-fg-2">{m(l.orderAmount)} <span className="text-xs text-fg-4">× {Number(l.rate)}%</span></span> : <span className="text-fg-4">—</span>),
            },
            { key: 'amount', header: t('aff.commission'), cell: (l) => <span className={cn('tabular font-medium', l.status === 'CANCELED' || l.status === 'REVOKED' ? 'text-fg-4 line-through' : 'text-fg')}>{m(l.amount)}</span> },
            { key: 'status', header: t('common.status'), mobile: 'actions', cell: (l) => <Tag tone={statusTone[l.status]}>{t(`aff.status.${l.status}`)}</Tag> },
            { key: 'time', header: t('common.createdAt'), mobile: 'hide', cell: (l) => <span className="tabular text-xs whitespace-nowrap text-fg-2">{formatDate(l.createdAt, 'YYYY-MM-DD HH:mm')}</span> },
            {
              key: 'effective',
              header: t('aff.effectiveAt'),
              mobile: 'hide',
              cell: (l) =>
                l.effectiveAt && (l.status === 'PENDING' || l.status === 'SETTLED') ? (
                  <span className="tabular text-xs whitespace-nowrap text-fg-2">
                    {formatDate(l.effectiveAt, 'YYYY-MM-DD HH:mm')}
                    <span className="ml-1 text-fg-4">{l.status === 'PENDING' ? t('aff.expected') : t('aff.actual')}</span>
                  </span>
                ) : (
                  <span className="text-fg-4">—</span>
                ),
            },
          ]}
        />
        {logs.data && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={logs.data.total}
            onChange={setPage}
            onPageSizeChange={(n) => {
              setPageSize(n);
              setPage(1);
            }}
          />
        )}
      </Section>
    </div>
  );
}

export default function Affiliate() {
  const { t } = useI18n();
  const aff = useAff();
  return (
    <>
      <PageHeader title={t('nav.invite')} description={t('aff.pageDesc')} />
      {aff.isLoading ? (
        <PageLoading />
      ) : aff.error || !aff.data ? (
        <ErrorState error={aff.error} onRetry={() => aff.refetch()} />
      ) : aff.data.enabled ? (
        <AffContent aff={aff.data} />
      ) : (
        <Card>
          <Empty icon={<Gift />} title={t('aff.disabledTitle')} description={t('aff.disabledDesc')} />
        </Card>
      )}
    </>
  );
}

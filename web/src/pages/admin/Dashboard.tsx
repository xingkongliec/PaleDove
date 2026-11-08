import { useQuery } from '@tanstack/react-query';
import { Boxes, CalendarDays, ChevronRight, CircleAlert, MessagesSquare, Server, TrendingDown, TrendingUp, Users, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { AdminStatsDTO, SystemInfoDTO } from '../../shared/index';
import { Trend } from '@/components/charts';
import { PageHeader } from '@/components/page';
import { Card, ErrorState, PageLoading } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatMoney, formatUptime } from '@/lib/format';
import { useCurrency, usePublicConfig } from '@/lib/queries';
import { Stat, StatStrip } from './catalog/product-ui';

/** 底部系统状态：数据库 / 缓存为服务端实时检测结果，不可用时标红 */
function SystemStatus({ info }: { info: SystemInfoDTO }) {
  const { t } = useI18n();
  const ok = info.status === 'ok';
  const dep = (label: string, kind: string, d: { ok: boolean; version: string | null; latencyMs: number | null }) => (
    <span className={cn(!d.ok && 'text-danger-text')}>
      {label} {kind}
      {d.version && <span className="font-mono"> {d.version}</span>}
      {d.ok ? d.latencyMs !== null && <span className="tabular"> · {d.latencyMs} ms</span> : ` · ${t('adminDash.unavailable')}`}
    </span>
  );
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
      <span className={cn('inline-flex items-center gap-1.5', !ok && 'text-warning-text')}>
        <span className={cn('size-1.5 rounded-full', ok ? 'bg-success' : 'bg-warning')} />
        {ok ? t('adminDash.systemOk') : t('adminDash.systemDegraded')}
      </span>
      {dep(t('adminDash.database'), info.database.kind, info.database)}
      {dep(t('adminDash.cache'), info.cache.kind === 'memory' ? t('adminDash.memoryStore') : 'Redis', info.cache)}
      <span>
        {t('adminDash.queue')} {info.queue === 'memory' ? t('adminDash.memoryQueue') : 'BullMQ'}
        {!info.worker && <span className="text-warning-text"> · {t('adminDash.workerOff')}</span>}
      </span>
      <span>{t('adminDash.uptime', { time: formatUptime(info.uptime) })}</span>
      <span>{t('adminDash.memory', { size: formatBytes(info.memory, 0) })}</span>
      <span className="font-mono">Node {info.node}</span>
    </div>
  );
}

/** 收入环比：本月至今与上月同期相比 */
function MonthChange({ month, last }: { month: number; last: number }) {
  const { t } = useI18n();
  if (!last) return <span>{t('adminDash.noLastMonth')}</span>;
  const pct = ((month - last) / last) * 100;
  const up = pct >= 0;
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('inline-flex items-center gap-0.5 font-medium', up ? 'text-success-text' : 'text-danger-text')}>
        {up ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}
        {up ? '+' : ''}
        {pct.toFixed(1)}%
      </span>
      {t('adminDash.vsLastMonth')}
    </span>
  );
}

const RANGES = [7, 14, 30] as const;

function RevenueCard({ daily }: { daily: AdminStatsDTO['revenueDaily'] }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const data = daily.slice(-days);
  const sum = data.reduce((a, d) => a + d.amount, 0);
  return (
    <Card className="flex flex-1 flex-col">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3.5">
        <div>
          <h3 className="text-[15px] font-semibold text-fg">{t('adminDash.revenueTrend')}</h3>
          <p className="mt-0.5 text-[13px] text-fg-3">
            {t('adminDash.revenueRange', { days })} <span className="tabular font-medium text-fg">{formatMoney(sum, currency)}</span>
          </p>
        </div>
        <Segmented value={days} onChange={setDays} items={RANGES.map((d) => ({ value: d, label: t('adminDash.days', { n: d }) }))} />
      </div>
      <div className="relative min-h-56 flex-1">
        <div className="absolute inset-0 px-2 pt-3 pb-2">
        <Trend data={data} xKey="date" yKey="amount" label={t('adminDash.revenue')} xFormatter={(d) => d.slice(5)} yFormatter={(v) => `${currency}${v}`} />
        </div>
      </div>
    </Card>
  );
}

/** 卡片标题行：标题 + 右侧说明或链接 */
function Head({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
      <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
      {extra && <div className="text-xs text-fg-3">{extra}</div>}
    </div>
  );
}

const viewAll = (to: string, label: string) => (
  <Link to={to} className="text-fg-2 hover:text-fg hover:underline">
    {label}
  </Link>
);

function PendingRow({ icon, label, count, to }: { icon: ReactNode; label: string; count: number; to: string }) {
  return (
    <Link to={to} className="group flex h-9 items-center gap-3 rounded-md px-2 text-[13px] transition-colors hover:bg-surface-2">
      <span className="text-fg-3 [&>svg]:size-4">{icon}</span>
      <span className={cn('min-w-0 flex-1 truncate', count ? 'font-medium text-fg' : 'text-fg-2')}>{label}</span>
      <span className={cn('tabular text-[13px]', count ? 'font-semibold text-fg' : 'text-fg-4')}>{count}</span>
      <ChevronRight className="size-3.5 text-fg-4 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

/** 待处理事项 */
function PendingCard({ s }: { s: AdminStatsDTO }) {
  const { t } = useI18n();
  const offline = s.nodeUsage.filter((n) => n.enabled && n.status === 'OFFLINE').length;
  const rows = [
    { icon: <MessagesSquare />, label: t('adminDash.openTickets'), count: s.ticketsOpen, to: '/admin/tickets' },
    { icon: <Boxes />, label: t('adminDash.errorInstances'), count: s.instances.ERROR ?? 0, to: '/admin/instances?status=ERROR' },
    { icon: <Server />, label: t('adminDash.offlineNodes'), count: offline, to: '/admin/nodes' },
    { icon: <CircleAlert />, label: t('adminDash.failedTasks'), count: s.failedTasks.length, to: '/admin/tasks?tab=tasks' },
  ];
  const waiting = rows.filter((r) => r.count > 0).length;
  return (
    <Card>
      <Head title={t('adminDash.pendingTitle')} extra={waiting ? t('adminDash.pendingCount', { n: waiting }) : t('adminDash.allGood')} />
      <div className="px-2 py-1.5">
        {rows.map((r) => (
          <PendingRow key={r.to} {...r} />
        ))}
      </div>
    </Card>
  );
}

/** 实例状态分布 */
function InstanceStatusCard({ s, total }: { s: AdminStatsDTO; total: number }) {
  const { t } = useI18n();
  const count = (k: string) => s.instances[k] ?? 0;
  const parts = [
    { key: 'running', label: t('adminDash.stRunning'), value: count('RUNNING'), color: 'bg-success' },
    { key: 'stopped', label: t('adminDash.stStopped'), value: count('STOPPED'), color: 'bg-fg-4' },
    { key: 'suspended', label: t('adminDash.stSuspended'), value: count('SUSPENDED'), color: 'bg-danger' },
    { key: 'error', label: t('adminDash.stError'), value: count('ERROR'), color: 'bg-danger' },
  ];
  const other = Math.max(0, total - parts.reduce((a, p) => a + p.value, 0));
  parts.push({ key: 'other', label: t('adminDash.stOther'), value: other, color: 'bg-fg-2' });
  return (
    <Card>
      <Head title={t('adminDash.instanceStatus')} extra={viewAll('/admin/instances', t('adminDash.instanceTotal', { n: total }))} />
      <div className="px-4 py-3">
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-surface-3">
          {total > 0 &&
            parts
              .filter((p) => p.value > 0)
              .map((p) => <span key={p.key} className={cn('h-full first:rounded-l-full last:rounded-r-full', p.color)} style={{ width: `${(p.value / total) * 100}%` }} />)}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[13px]">
          {parts
            .filter((p) => p.value > 0 || p.key === 'running' || p.key === 'stopped')
            .map((p) => (
              <div key={p.key} className="flex items-center gap-2">
                <span className={cn('size-2 rounded-full', p.color)} />
                <span className="flex-1 text-fg-2">{p.label}</span>
                <span className="tabular font-medium text-fg">{p.value}</span>
              </div>
            ))}
        </div>
      </div>
    </Card>
  );
}

export default function AdminDashboard() {
  const { t } = useI18n();
  const currency = useCurrency();
  const { data: cfg } = usePublicConfig();
  const q = useQuery({ queryKey: ['admin-stats'], queryFn: () => api.get<AdminStatsDTO>('/admin/stats'), refetchInterval: 30_000 });
  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const total = Object.entries(s.instances)
    .filter(([k]) => k !== 'DELETED')
    .reduce((a, [, v]) => a + v, 0);

  return (
    <>
      <PageHeader title={t('adminDash.title')} description={t('adminDash.welcome', { site: cfg?.siteName ?? 'PaleDove' })} />
      <StatStrip className="sm:grid-cols-3 lg:grid-cols-3 xl:grid-cols-6">
        <Stat icon={<Wallet />} label={t('adminDash.monthRevenue')} value={formatMoney(s.revenue.month, currency)} hint={<MonthChange month={Number(s.revenue.month)} last={Number(s.revenue.lastMonth)} />} />
        <Stat icon={<CalendarDays />} label={t('adminDash.today')} value={formatMoney(s.revenue.today, currency)} hint={t('adminDash.paymentsToday', { paid: s.payments.todayPaid, total: s.payments.todayTotal })} />
        <Stat icon={<Boxes />} label={t('adminDash.instancesKpi')} value={total} hint={t('adminDash.runningN', { n: s.instances.RUNNING ?? 0 })} />
        <Stat
          icon={<Server />}
          label={t('adminDash.nodesKpi')}
          value={s.nodes.total}
          hint={s.nodes.online < s.nodes.total ? <span className="text-danger-text">{t('adminDash.onlineN', { n: s.nodes.online })}</span> : t('adminDash.onlineN', { n: s.nodes.online })}
        />
        <Stat icon={<Users />} label={t('adminDash.users')} value={s.users} hint={t('adminDash.activeN', { n: s.usersActive, today: s.usersToday })} />
        <Stat icon={<MessagesSquare />} label={t('adminDash.openTickets')} value={s.ticketsOpen} hint={t('adminDash.failedTasksN', { n: s.failedTasks.length })} />
      </StatStrip>

      {/* 左侧收入趋势，右侧待处理与实例状态；收入图拉伸到与右列等高 */}
      <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <RevenueCard daily={s.revenueDaily} />
        <div className="flex min-w-0 flex-col gap-4">
          <PendingCard s={s} />
          <InstanceStatusCard s={s} total={total} />
        </div>
      </div>

      <SystemStatus info={s.system} />
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, Box, Megaphone, Monitor, Plus, Server } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { isVmType, type AnnouncementDTO, type InstanceDTO, type UserDashboardDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { DataGlobe } from '@/components/landing/DataGlobe';
import { Reveal } from '@/components/landing/motion';
import { InstanceStatusBadge, OsIcon } from '@/components/status';
import { buttonClass } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { ErrorState, PageLoading } from '@/components/ui/misc';
import { useInstances } from '@/hooks/instances';
import { useI18n, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { daysLeft, daysLeftText, formatCores, formatDate, formatMemory, formatMoney, maskIp } from '@/lib/format';
import { useCurrency, useMe } from '@/lib/queries';
import { instanceIp } from './Instances';

export interface BillingSummary {
  balance: string;
  monthSpend: string;
  totalSpend: string;
  monthRecharge: string;
  totalRecharge: string;
  activeInstances: number;
}

/** 概览里列出的最近实例数 */
const RECENT = 6;
/** 副标题随机一句（dash.quote.1 ~ dash.quote.N） */
const QUOTE_COUNT = 12;
/** 实例表格的列（与首页「热门云服务器」表格同一样式） */
const COLS = 'lg:grid-cols-[2.2fr_1fr_1.3fr_1.1fr_1.1fr_.9fr_.8fr]';

/** 实例表格的筛选（首页地区筛选的样式） */
type Filter = 'all' | 'running' | 'stopped' | 'expiring';
const FILTERS: Record<Filter, (i: InstanceDTO) => boolean> = {
  all: () => true,
  running: (i) => i.status === 'RUNNING',
  stopped: (i) => i.status === 'STOPPED',
  expiring: (i) => daysLeft(i.expiresAt) <= 7,
};

/** 按当前时间问候 */
function greetingKey(): MessageKey {
  const hour = new Date().getHours();
  return hour < 12 ? 'dash.greetMorning' : hour < 18 ? 'dash.greetAfternoon' : 'dash.greetEvening';
}

/** 首屏右侧的毛玻璃面板：实例状态概览（总数、运行比例条、四项计数） */
function StatusPanel({ total, running, stopped, containers, vms }: { total: number; running: number; stopped: number; containers: number; vms: number }) {
  const { t } = useI18n();
  const other = Math.max(0, total - running - stopped);
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const items: [ReactNode, string, number][] = [
    [<span key="r" className="size-1.5 rounded-full bg-success" />, t('dash.runningInstances'), running],
    [<span key="s" className="size-1.5 rounded-full bg-fg-4" />, t('dash.stoppedInstances'), stopped],
    [<Box key="c" className="size-3.5" />, t('dash.containerInstances'), containers],
    [<Monitor key="v" className="size-3.5" />, t('dash.vmInstances'), vms],
  ];
  return (
    <Link to="/console/instances" className="page-enter group block rounded-xl border border-line bg-surface/75 p-4 backdrop-blur transition-[border-color,box-shadow] duration-200 [animation-delay:200ms] hover:border-line-strong hover:shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs text-fg-3">{t('dash.instanceOverview')}</div>
          <div className="mt-1.5 flex items-baseline gap-1.5">
            <span className="tabular text-[34px] leading-none font-medium tracking-tight text-fg">{total}</span>
            <span className="text-[13px] text-fg-3">{t('dash.totalInstances')}</span>
          </div>
        </div>
        <ArrowUpRight className="size-4 text-fg-4 transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-fg-2" />
      </div>
      <div className="mt-3.5 flex h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className="bg-success transition-[width] duration-500 ease-smooth" style={{ width: `${pct(running)}%` }} />
        <div className="bg-fg-4 transition-[width] duration-500 ease-smooth" style={{ width: `${pct(stopped)}%` }} />
        <div className="bg-warning transition-[width] duration-500 ease-smooth" style={{ width: `${pct(other)}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
        {items.map(([mark, label, value]) => (
          <div key={label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
              <span className="flex w-3.5 shrink-0 justify-center">{mark}</span>
              <span className="truncate">{label}</span>
            </span>
            <span className="tabular font-medium text-fg">{value}</span>
          </div>
        ))}
      </div>
    </Link>
  );
}

/** 实例表格的一行：宽屏为表格行，窄屏为卡片 */
function InstanceRow({ inst }: { inst: InstanceDTO }) {
  const { t, L } = useI18n();
  const ip = instanceIp(inst);
  const left = daysLeft(inst.expiresAt);
  const config = `${formatCores(inst.cpu)} / ${formatMemory(inst.memory)} / ${inst.disk} GB`;
  const expiry = <span className={cn('tabular whitespace-nowrap', left <= 0 ? 'text-danger-text' : left <= 7 ? 'text-warning-text' : 'text-fg-2')}>{daysLeftText(inst.expiresAt)}</span>;
  const manage = (
    <Link to={`/console/instances/${inst.id}`} className={buttonClass('secondary', 'sm', 'group/btn whitespace-nowrap')}>
      {t('dash.manage')}
      <ArrowRight className="transition-transform group-hover/btn:translate-x-0.5" />
    </Link>
  );
  const name = (
    <Link to={`/console/instances/${inst.id}`} className="flex min-w-0 items-center gap-2.5">
      {inst.image ? <OsIcon family={inst.image.family} className="size-9 text-sm" /> : <span className="size-9 shrink-0 rounded-lg bg-surface-3" />}
      <span className="min-w-0">
        <span className="block truncate font-medium text-fg hover:underline">{inst.hostname}</span>
        <span className="block truncate text-xs text-fg-3">{inst.image?.name ?? '—'}</span>
      </span>
    </Link>
  );
  return (
    <div className="border-b border-line/70 px-3.5 py-3 text-[13px] transition-colors last:border-0 hover:bg-surface-2/50 sm:px-4">
      {/* 宽屏：表格行 */}
      <div className={cn('hidden items-center gap-3 lg:grid', COLS)}>
        {name}
        <span>
          <InstanceStatusBadge status={inst.status} reason={inst.suspendReason} activeTask={inst.activeTask} />
        </span>
        <span className="min-w-0">
          <span className="tabular block truncate text-fg-2">{config}</span>
          <span className="block truncate text-xs text-fg-3">{L.instanceType[inst.type]}</span>
        </span>
        <span className="flex min-w-0 items-center gap-2">
          <CountryFlag code={inst.country} className="h-3.5 w-5" />
          <span className="truncate text-fg-2">{inst.region}</span>
        </span>
        <span className="truncate font-mono text-xs text-fg-2">{ip ? maskIp(ip) : t('dash.noPublicIp')}</span>
        {expiry}
        <span className="text-right">{manage}</span>
      </div>
      {/* 窄屏：卡片 */}
      {/* 手机：名称与状态一行；配置、地区、IP 一行；类型、到期与「管理」一行（与名称左对齐） */}
      <div className="space-y-2 lg:hidden">
        <div className="flex items-center justify-between gap-2">
          {name}
          <span className="shrink-0">
            <InstanceStatusBadge status={inst.status} reason={inst.suspendReason} activeTask={inst.activeTask} />
          </span>
        </div>
        <div className="tabular flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[2.875rem] text-xs text-fg-2">
          <span>{config}</span>
          <span className="flex items-center gap-1.5">
            <CountryFlag code={inst.country} />
            {inst.region}
          </span>
          <span className="font-mono">{ip ? maskIp(ip) : t('dash.noPublicIp')}</span>
        </div>
        <div className="flex items-center justify-between gap-3 pl-[2.875rem]">
          <span className="flex min-w-0 items-center gap-2 text-xs">
            <span className="rounded bg-surface-3 px-1.5 py-px text-[11px] text-fg-2">{L.instanceType[inst.type]}</span>
            {expiry}
          </span>
          {manage}
        </div>
      </div>
    </div>
  );
}

/**
 * 控制台主页（与首页同一视觉风格）：
 *  - 首屏卡片：数据地球动画背景；左侧公告胶囊、问候（名字渐变色）、主操作，右侧毛玻璃的实例状态概览；
 *    底部一条账户数据（余额、本月消费、累计消费、累计充值、即将到期）
 *  - 我的实例：状态筛选（首页地区筛选样式）+ 整行表格（首页「热门云服务器」表格样式），不留空白侧栏
 */
export default function Dashboard() {
  const { t } = useI18n();
  const { data: me } = useMe();
  const currency = useCurrency();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<UserDashboardDTO>('/dashboard'), refetchInterval: 30_000 });
  const summary = useQuery({ queryKey: ['billing-summary'], queryFn: () => api.get<BillingSummary>('/billing/summary') });
  const instances = useInstances();
  // 进入页面时固定一句，不随刷新变化
  const [quote] = useState(() => `dash.quote.${1 + Math.floor(Math.random() * QUOTE_COUNT)}` as MessageKey);
  const [notice, setNotice] = useState<AnnouncementDTO | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const list = instances.data ?? [];
  const count = (fn: (i: InstanceDTO) => boolean) => list.filter(fn).length;
  const stopped = count((i) => i.status === 'STOPPED');
  const filtered = list.filter(FILTERS[filter]);
  const recent = [...filtered].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, RECENT);
  const s = summary.data;
  // 问候语里的名字使用首页标题的渐变色
  const name = me?.name || me?.username || '';
  const [greetLead, greetTail = ''] = t(greetingKey(), { name: '\u0000' }).split('\u0000');
  // 公告胶囊：置顶优先，否则最新一条；没有公告时显示运行状态
  const announcement = d.announcements.find((a) => a.pinned) ?? d.announcements[0] ?? null;
  const pill = 'page-enter inline-flex max-w-full items-center gap-2.5 rounded-full border border-line bg-surface/70 py-1.5 pr-3 pl-3.5 text-[13px] text-fg-2 backdrop-blur transition-colors hover:border-line-strong hover:text-fg';
  const facts: [string, ReactNode, string?][] = [
    [t('shell.balance'), formatMoney(d.balance, currency), Number(d.balance) < 0 ? 'text-danger-text' : undefined],
    [t('dash.monthSpend'), formatMoney(s?.monthSpend ?? 0, currency)],
    [t('dash.totalSpend'), formatMoney(s?.totalSpend ?? 0, currency)],
    [t('dash.totalRechargeLabel'), formatMoney(s?.totalRecharge ?? 0, currency)],
    [t('dash.expiringSoon'), t('dash.unitCount', { n: d.instances.expiringSoon }), d.instances.expiringSoon > 0 ? 'text-warning-text' : undefined],
  ];

  return (
    <div className="space-y-5">
      {/* ───────── 首屏 ───────── */}
      <section className="relative isolate overflow-hidden rounded-xl border border-line bg-surface">
        {/* 数据地球：从右下方升起，左侧渐隐，不影响文字阅读 */}
        {/* 手机上只占顶部一块（右上角的小地球，向下渐隐），避免压在状态面板与数据上 */}
        <DataGlobe className="absolute inset-x-0 top-0 -z-10 h-56 w-full opacity-70 [mask-image:linear-gradient(180deg,#000_55%,transparent)] sm:opacity-80 lg:inset-0 lg:h-full lg:opacity-100 lg:[mask-image:linear-gradient(90deg,transparent_8%,#000_45%)]" />
        <div className="grid items-center gap-5 px-4 py-6 sm:gap-6 sm:px-7 sm:py-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            {announcement ? (
              <button type="button" onClick={() => setNotice(announcement)} className={pill}>
                <Megaphone className="size-3.5 shrink-0 text-fg-3" />
                <span className="truncate">{announcement.title}</span>
                <ArrowUpRight className="size-3.5 shrink-0 text-fg-3" />
              </button>
            ) : (
              <span className={pill}>
                <span className={cn('size-2 shrink-0 rounded-full', d.instances.running > 0 ? 'bg-success' : 'bg-fg-4')} />
                {t('dash.heroRunning', { n: d.instances.running, total: d.instances.total })}
              </span>
            )}
            <h1 className="page-enter mt-4 text-[26px] leading-[1.2] font-medium tracking-tight break-words text-fg [animation-delay:80ms] sm:text-[36px] sm:leading-[1.15]">
              {greetLead}
              <span className="text-gradient">{name}</span>
              {greetTail}
            </h1>
            <p className="page-enter mt-2.5 max-w-lg text-[14px] leading-relaxed text-fg-3 [animation-delay:140ms] sm:text-[15px]">{t(quote)}</p>
            <div className="page-enter mt-5 flex gap-2.5 sm:mt-6 sm:gap-3 [animation-delay:200ms]">
              <Link to="/console/store" className={buttonClass('primary', 'lg', 'group px-6 shadow-card active:scale-[0.97] max-sm:flex-1 max-sm:px-3')}>
                {t('dash.newInstance')}
                <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
              <Link to="/console/billing?topup=1" className={buttonClass('secondary', 'lg', 'bg-surface/70 px-6 backdrop-blur max-sm:flex-1 max-sm:px-3')}>
                {t('dash.topUpNow')}
              </Link>
            </div>
          </div>
          <StatusPanel total={d.instances.total} running={d.instances.running} stopped={stopped} containers={count((i) => !isVmType(i.type))} vms={count((i) => isVmType(i.type))} />
        </div>
        {/* 账户数据：首页「优惠与推广」卡片里的竖线分隔样式 */}
        <Link to="/console/billing" className="grid grid-cols-2 gap-x-3 gap-y-3 border-t border-line bg-surface/70 px-4 py-3.5 backdrop-blur transition-colors hover:bg-surface sm:grid-cols-5 sm:gap-x-0 sm:px-7">
          {facts.map(([label, value, cls], i) => (
            <div
              key={label}
              className={cn(
                'min-w-0 sm:border-l sm:border-line sm:px-4 sm:first:border-0 sm:first:pl-0',
                // 手机：余额单独一行并放大，下面一条分隔线；其余 2 × 2
                i === 0 && 'col-span-2 border-b border-line/70 pb-3 sm:col-span-1 sm:border-b-0 sm:pb-0',
              )}
            >
              <div className="text-xs text-fg-3">{label}</div>
              <div className={cn('tabular mt-1 truncate font-medium tracking-tight', i === 0 ? 'text-[24px] sm:text-[17px]' : 'text-[16px] sm:text-[17px]', cls ?? 'text-fg')}>{value}</div>
            </div>
          ))}
        </Link>
      </section>

      {/* ───────── 我的实例 ───────── */}
      <Reveal>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[18px] leading-tight font-medium tracking-tight text-fg sm:text-[20px]">{t('dash.myInstances')}</h2>
            <p className="mt-1 text-[13px] text-fg-3">{list.length ? t('dash.instanceListSummary', { count: recent.length, total: filtered.length }) : t('instances.emptyDesc')}</p>
          </div>
          {list.length > 0 && (
            <Link to="/console/instances" className={buttonClass('secondary', 'md', 'group shrink-0 max-sm:h-8 max-sm:px-2.5 max-sm:text-[13px]')}>
              <span className="sm:hidden">{t('common.viewAll')}</span>
              <span className="max-sm:hidden">{t('dash.viewAllCount', { n: list.length })}</span>
              <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </Link>
          )}
        </div>
        {list.length > 0 && (
          <div className="scrollbar-none -mx-4 mb-3 flex gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="tablist">
            {(Object.keys(FILTERS) as Filter[]).map((f) => {
              const on = filter === f;
              const n = list.filter(FILTERS[f]).length;
              return (
                <button
                  key={f}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border px-3 text-[13px] whitespace-nowrap transition-colors',
                    on ? 'border-line-strong bg-surface-3 font-medium text-fg' : 'border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg',
                  )}
                >
                  {f === 'running' && <span className="size-1.5 rounded-full bg-success" />}
                  {f === 'stopped' && <span className="size-1.5 rounded-full bg-fg-4" />}
                  {f === 'expiring' && <span className="size-1.5 rounded-full bg-warning" />}
                  {t(`dash.filter.${f}`)}
                  <span className="tabular text-xs text-fg-3">{n}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <div className={cn('hidden gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5 text-xs text-fg-3 lg:grid', COLS)}>
            <span>{t('dash.col.instance')}</span>
            <span>{t('dash.col.status')}</span>
            <span>{t('dash.col.config')}</span>
            <span>{t('dash.col.region')}</span>
            <span>{t('dash.col.ip')}</span>
            <span>{t('dash.col.expiry')}</span>
            <span className="text-right">{t('dash.col.action')}</span>
          </div>
          {instances.error ? (
            <ErrorState error={instances.error} onRetry={() => instances.refetch()} />
          ) : instances.isLoading ? (
            Array.from({ length: 3 }, (_, i) => <div key={i} className="h-[62px] animate-pulse border-b border-line/70 bg-surface-2/40 last:border-0" />)
          ) : list.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-10 text-center sm:flex-row sm:justify-center sm:text-left">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2">
                <Server className="size-[18px]" />
              </span>
              <div>
                <div className="text-[14px] font-medium text-fg">{t('instances.empty')}</div>
                <div className="mt-0.5 text-[13px] text-fg-3">{t('dash.deployDesc')}</div>
              </div>
              <Link to="/console/store" className={buttonClass('primary', 'md', 'max-sm:w-full sm:ml-4')}>
                <Plus />
                {t('instances.goDeploy')}
              </Link>
            </div>
          ) : recent.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-fg-3">{t('dash.filterEmpty')}</p>
          ) : (
            recent.map((i) => <InstanceRow key={i.id} inst={i} />)
          )}
        </div>
      </Reveal>

      <Modal open={!!notice} onOpenChange={(o) => !o && setNotice(null)} title={notice?.title} description={notice ? formatDate(notice.createdAt) : undefined} size="lg">
        {notice && <p className="text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{notice.content}</p>}
      </Modal>
    </div>
  );
}

// 交易市场上架前拨测快照：商品卡片上的摘要（IP 状态、拨测时间、三网最快），点击打开详情
// （中国节点地图 + 三网线路概览 + 节点列表，与节点测试相同）。卖家、买家与管理员的记录里也能打开。
import { useQuery } from '@tanstack/react-query';
import { Activity, Clock, Info } from 'lucide-react';
import { lazy, Suspense, type ReactNode } from 'react';
import { latencyLevel, type MarketPingDTO, type MarketPingSummaryDTO, type MarketPingVerdict } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { LAT_TEXT, ms } from '@/components/ping/ChinaPingMap';
import { Modal } from '@/components/ui/dialog';
import { Empty, ErrorState, Spinner, Tag } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';

const NodeTestView = lazy(() => import('@/components/ping/NodeTest').then((module) => ({ default: module.NodeTestView })));

const VERDICT_TONE: Record<MarketPingVerdict, 'success' | 'warning' | 'danger' | 'neutral'> = { NORMAL: 'success', PARTIAL: 'warning', ABNORMAL: 'danger', UNKNOWN: 'neutral' };

/** 拨测状态标签：IP 正常 / 部分超时 / IP 异常 / 拨测中 / 未拨测 */
export function PingVerdictTag({ ping }: { ping: MarketPingSummaryDTO }) {
  const { t } = useI18n();
  if (ping.status === 'PENDING') {
    return (
      <Tag>
        <span className="inline-flex items-center gap-1">
          <Spinner className="size-3" />
          {t('market.ping.pending')}
        </span>
      </Tag>
    );
  }
  if (ping.status === 'FAILED' || !ping.verdict) return <Tag>{t('market.ping.failed')}</Tag>;
  return <Tag tone={VERDICT_TONE[ping.verdict]}>{t(`market.ping.verdict.${ping.verdict}`)}</Tag>;
}

/** 三网最快的小标签，如「上海电信/133ms」 */
function FastestChips({ ping, className }: { ping: MarketPingSummaryDTO; className?: string }) {
  const { t, locale } = useI18n();
  if (!ping.fastest.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {ping.fastest.map((f) => (
        <span key={f.isp} className="tabular inline-flex items-center rounded-sm border border-line bg-surface-2/60 px-1 text-[10px] leading-4 text-fg-2">
          {locale === 'en' ? f.provinceEn : f.province}
          {t(`ping.isp.${f.isp}`)}/<span className={LAT_TEXT[latencyLevel(f.latency)]}>{ms(f.latency)}</span>
        </span>
      ))}
    </div>
  );
}

/** 商品卡片上的拨测摘要（整块可点击，打开快照详情） */
export function PingSummaryButton({ ping, onOpen }: { ping: MarketPingSummaryDTO; onOpen: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('market.ping.open')}
      className="group block w-full rounded py-0.5 text-left transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <PingVerdictTag ping={ping} />
        <span className="tabular inline-flex items-center gap-1 text-[11px] text-fg-3">
          <Clock className="size-3" />
          {formatDate(ping.testedAt ?? ping.requestedAt, 'YYYY-MM-DD HH:mm:ss')}
        </span>
      </div>
      <FastestChips ping={ping} className="mt-1" />
    </button>
  );
}

function Stat({ label, value, hint, dot }: { label: string; value: ReactNode; hint: string; dot: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 py-2">
      <div className="flex items-center gap-1.5 text-xs text-fg-3">
        <span className={cn('size-1.5 rounded-full', dot)} />
        {label}
      </div>
      <div className="tabular mt-0.5 text-lg leading-7 font-semibold text-fg">{value}</div>
      <div className="truncate text-[11px] text-fg-3">{hint}</div>
    </div>
  );
}

export interface PingSubject {
  id: number;
  title: string;
  region: string;
  country: string;
}

/** 上架前拨测快照详情 */
export function MarketPingDialog({ subject, onClose }: { subject: PingSubject | null; onClose: () => void }) {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ['market-ping', subject?.id],
    queryFn: () => api.get<MarketPingDTO>(`/public/market/${subject!.id}/ping`),
    enabled: !!subject,
    // 拨测中每 3 秒刷新一次
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' ? 3_000 : false),
  });
  const p = q.data;
  const abnormal = p ? p.total - p.reachable : 0;
  return (
    <Modal open={!!subject} onOpenChange={(o) => !o && onClose()} size="2xl" title={t('market.ping.title')} description={t('market.ping.desc')}>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !p || !subject ? (
        <div className="grid h-40 place-items-center">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-xs text-fg-2">
            <Info className="size-3.5 shrink-0 text-fg-3" />
            <span>
              <span className="font-medium text-fg">{t('market.ping.banner')}</span> · {t('market.ping.bannerDesc')}
            </span>
            <span className="text-fg-3">{t(p.ipv4 === 'DEDICATED' ? 'market.ping.sourceDedicated' : 'market.ping.sourceNat')}</span>
          </div>

          <div className="flex flex-col gap-3 rounded-lg border border-line p-3 lg:flex-row lg:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-3 text-fg-2">
                <Activity className="size-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                  <CountryFlag code={subject.country} className="h-3.5 w-5" />
                  <span className="truncate">{subject.title}</span>
                </div>
                <div className="text-xs text-fg-3">{subject.region}</div>
                <div className="tabular text-xs text-fg-3">
                  {t('market.ping.recordedAt')} / {formatDate(p.testedAt ?? p.requestedAt, 'YYYY-MM-DD HH:mm:ss')}
                </div>
              </div>
            </div>
            {p.status === 'DONE' && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[34rem]">
                <Stat label={t('market.ping.stat.nodes')} value={p.total} hint={t('market.ping.stat.nodesHint')} dot="bg-fg-3" />
                <Stat label={t('market.ping.stat.reachable')} value={`${p.reachable}/${p.total}`} hint={t('market.ping.stat.reachableHint')} dot="bg-success" />
                <Stat label={t('market.ping.stat.abnormal')} value={abnormal} hint={t('market.ping.stat.abnormalHint', { n: p.failedProvinces })} dot={abnormal ? 'bg-danger' : 'bg-fg-4'} />
                <Stat
                  label={t('market.ping.stat.status')}
                  value={<span className={p.verdict === 'NORMAL' ? 'text-success-text' : p.verdict === 'ABNORMAL' ? 'text-danger-text' : p.verdict === 'PARTIAL' ? 'text-warning-text' : 'text-fg-3'}>{t(`market.ping.verdictShort.${p.verdict ?? 'UNKNOWN'}`)}</span>}
                  hint={t('market.ping.stat.statusHint')}
                  dot={p.verdict === 'NORMAL' ? 'bg-success' : p.verdict === 'ABNORMAL' ? 'bg-danger' : p.verdict === 'PARTIAL' ? 'bg-warning' : 'bg-fg-4'}
                />
              </div>
            )}
          </div>

          {p.status === 'PENDING' ? (
            <Empty icon={<Spinner />} title={t('market.ping.pendingTitle')} description={t('market.ping.pendingDesc')} />
          ) : p.status === 'FAILED' ? (
            <Empty title={t('market.ping.failedTitle')} description={t(`market.ping.reason.${p.reason ?? 'error'}`)} />
          ) : (
            <>
              <Suspense fallback={<div className="grid h-64 place-items-center"><Spinner /></div>}>
                <NodeTestView nodes={[{ label: subject.title, country: subject.country, testedAt: p.testedAt ?? p.requestedAt, method: p.method ?? 'icmp', results: p.results, targets: p.targets }]} />
              </Suspense>
              <p className="text-[11px] leading-relaxed text-fg-4">{t('market.ping.rule')}</p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

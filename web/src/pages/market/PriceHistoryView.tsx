import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, BarChart3, Clock, Flame, Info, RefreshCw } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import type { MarketHistoryDTO, MarketListingDTO } from '../../shared/index';
import { Skeleton, Tag } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/tabs';
import { useChartColors } from '@/hooks/chart-colors';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { dayjs, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';

type Kind = 'ALL' | 'PUBLIC' | 'TARGETED';

function Stat({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface-2/50 px-4 py-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-line bg-surface text-fg-2 [&>svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <div className="truncate text-[11px] text-fg-3">{label}</div>
        <div className="tabular truncate text-base font-semibold text-fg">{value}</div>
      </div>
    </div>
  );
}

/** 同一套餐最近 30 天的成交价走势：续费价、当前价、成交均价与区间，以及成交价折线 */
export function PriceHistoryView({ listing }: { listing: MarketListingDTO }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const colors = useChartColors();
  const [kind, setKind] = useState<Kind>('ALL');
  const q = useQuery({
    queryKey: ['market-history', listing?.id, kind],
    queryFn: () => api.get<MarketHistoryDTO>(`/public/market/${listing!.id}/history`, { kind }),
    enabled: !!listing,
    // Filter changes should keep the current chart until the matching series is ready.
    placeholderData: (previousData, previousQuery) => (previousQuery?.queryKey[1] === listing?.id ? previousData : undefined),
  });
  const h = q.data;
  const m = (v: string | null | undefined) => (v ? formatMoney(v, currency) : '—');
  const data = useMemo(() => (h?.points ?? []).map((p) => ({ t: new Date(p.t).getTime(), price: Number(p.price) })), [h]);
  const avg = h?.average ? Number(h.average) : null;
  const prices = data.map((d) => d.price);
  // 纵轴从 0 开始，上限留出一点空间
  const top = prices.length ? Math.max(...prices, avg ?? 0) : 10;
  const domainMax = Math.max(10, Math.ceil((top * 1.15) / 10) * 10);
  const from = h ? new Date(h.from).getTime() : 0;
  const to = h ? new Date(h.to).getTime() : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat icon={<RefreshCw />} label={t('market.field.renew')} value={m(h?.renewPrice ?? listing?.renewPrice)} />
        <Stat icon={<Flame />} label={t('market.currentPrice')} value={m(h?.currentPrice ?? listing?.price)} />
        <Stat icon={<BarChart3 />} label={t('market.avgPrice')} value={m(h?.average)} />
        <Stat icon={<ArrowLeftRight />} label={t('market.range')} value={h?.min ? (h.min === h.max ? m(h.min) : `${m(h.min)}-${Number(h.max).toFixed(2)}`) : '—'} />
      </div>

      <div className="rounded-md border border-line bg-surface-2/30">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <div>
            <div className="text-[11px] font-medium text-fg-3">{t('market.trend')}</div>
            <div className="text-[15px] font-semibold text-fg">{t('market.dealPrice')}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={kind}
              onChange={setKind}
              aria-label={t('market.dealPrice')}
              items={[
                { value: 'ALL', label: t('market.kind.ALL') },
                { value: 'PUBLIC', label: t('market.kind.PUBLIC') },
                { value: 'TARGETED', label: t('market.kind.TARGETED') },
              ]}
            />
            <Tag>
              {q.isPlaceholderData ? <RefreshCw className="mr-1 size-3 animate-spin" /> : <Clock className="mr-1 size-3" />}
              {q.isPlaceholderData ? t('common.loading') : t('market.dealCount', { n: h?.count ?? 0 })}
            </Tag>
            {h && (
              <Tag>
                {dayjs(h.from).format('YYYY-MM-DD')} ~ {dayjs(h.to).format('YYYY-MM-DD')}
              </Tag>
            )}
          </div>
        </div>
        <div className="relative h-80 px-2 pt-4 pb-2 sm:px-4" aria-busy={q.isFetching}>
          {q.isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : data.length === 0 ? (
            <div className="flex h-full items-center justify-center text-[13px] text-fg-3">{t('market.noDeals')}</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="market-area" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={colors.series1} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={colors.series1} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={colors.grid} vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={[from, to]}
                  tickFormatter={(v: number) => dayjs(v).format('MM-DD HH:mm')}
                  tick={{ fill: colors.axis, fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickCount={6}
                />
                <YAxis domain={[0, domainMax]} tickFormatter={(v: number) => `${currency}${v}`} tick={{ fill: colors.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={52} />
                {avg !== null && (
                  <ReferenceLine y={avg} stroke={colors.axis} strokeDasharray="4 4" label={{ value: `${t('market.avgPrice')} ${currency}${avg.toFixed(2)}`, fill: colors.axis, fontSize: 11, position: 'insideTopRight' }} />
                )}
                <ChartTooltip
                  cursor={{ stroke: colors.axis, strokeDasharray: '3 3' }}
                  contentStyle={{ background: colors.surface, border: `1px solid ${colors.grid}`, borderRadius: 8, fontSize: 12, color: colors.fg }}
                  labelFormatter={(v) => dayjs(Number(v)).format('YYYY-MM-DD HH:mm')}
                  formatter={(v) => [`${currency}${Number(v).toFixed(2)}`, t('market.dealPrice')]}
                />
                <Area isAnimationActive={false} type="linear" dataKey="price" stroke={colors.series1} strokeWidth={2} fill="url(#market-area)" dot={{ r: 3, fill: colors.series1, strokeWidth: 0 }} activeDot={{ r: 4 }} />
              </AreaChart>
            </ResponsiveContainer>
          )}
          {q.isFetching && !q.isLoading && !q.isPlaceholderData && (
            <span className="absolute top-3 right-3 inline-flex items-center gap-1 rounded-full border border-line bg-surface/90 px-2 py-1 text-[11px] text-fg-3 shadow-xs">
              <RefreshCw className="size-3 animate-spin" />{t('common.loading')}
            </span>
          )}
        </div>
      </div>
      <p className="flex items-start gap-1.5 text-xs text-fg-3">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {t('market.historyNote')}
      </p>
    </div>
  );
}

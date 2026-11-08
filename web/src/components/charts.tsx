import { useEffect, useId, useState, type ReactNode } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { useChartColors } from '@/hooks/chart-colors';
import { useT } from '@/i18n';
import { Card, CardHeader, Empty } from './ui/misc';
import { Segmented } from './ui/tabs';

export interface SeriesDef {
  key: string;
  label: string;
  /** 1 或 2，对应已校验的分类色槽位 */
  slot: 1 | 2;
}

interface ChartCardProps<T> {
  title: string;
  description?: ReactNode;
  data: T[];
  /** 表格视图的列 */
  table: { header: string; cell: (row: T) => ReactNode }[];
  series: SeriesDef[];
  emptyText?: string;
  actions?: ReactNode;
  /** 图例样式：折线（第二序列为虚线）或柱状 */
  kind?: 'line' | 'bar';
  /** 图表上方的汇总信息（图表与表格视图都显示） */
  summary?: ReactNode;
  children: ReactNode;
}

/** 图例色块：黑白主题下第二序列的折线同时使用虚线区分 */
function Swatch({ slot, kind, colors }: { slot: 1 | 2; kind: 'line' | 'bar'; colors: { series1: string; series2: string } }) {
  const color = slot === 1 ? colors.series1 : colors.series2;
  if (kind === 'bar') return <span className="h-2.5 w-2.5 rounded-sm" style={{ background: color }} />;
  return (
    <svg width="16" height="8" aria-hidden className="shrink-0">
      <line x1="1" y1="4" x2="15" y2="4" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={slot === 2 ? '3 3' : undefined} />
    </svg>
  );
}

// ───────── 分帧挂载 ─────────
// 一个页面有多张图表时（如实例监控），全部同时渲染会占用主线程数百毫秒，切换标签时明显卡顿。
// 图表依次排队，每一帧只挂载一张：先显示同尺寸的占位，页面立即可交互。
const mountQueue: (() => void)[] = [];
let mountScheduled = false;

function mountNext() {
  const fn = mountQueue.shift();
  fn?.();
  if (mountQueue.length) requestAnimationFrame(() => setTimeout(mountNext, 0));
  else mountScheduled = false;
}

function useStaggeredMount(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    mountQueue.push(() => alive && setReady(true));
    if (!mountScheduled) {
      mountScheduled = true;
      requestAnimationFrame(() => setTimeout(mountNext, 0));
    }
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}

/** 图表卡片：标题 + 图例（≥2 个序列时）+ 图表/表格切换 */
export function ChartCard<T>({ title, description, data, table, series, emptyText, actions, kind = 'line', summary, children }: ChartCardProps<T>) {
  const t = useT();
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const colors = useChartColors();
  const ready = useStaggeredMount();
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          <>
            {actions}
            <Segmented
              value={view}
              onChange={setView}
              items={[
                { value: 'chart', label: t('common.chart') },
                { value: 'table', label: t('common.table') },
              ]}
            />
          </>
        }
      />
      <div className="p-3 sm:p-4">
        {summary && <div className="mb-4 px-1">{summary}</div>}
        {data.length === 0 ? (
          <Empty title={emptyText ?? t('common.noData')} />
        ) : view === 'chart' ? (
          <>
            {series.length >= 2 && (
              <div className="mb-3 flex flex-wrap gap-4 px-1 text-xs text-fg-2" aria-label={t('common.legend')}>
                {series.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5">
                    <Swatch slot={s.slot} kind={kind} colors={colors} />
                    {s.label}
                  </span>
                ))}
              </div>
            )}
            {/* 排到之前显示同尺寸的占位，页面不跳动 */}
            <div className="h-56">{ready ? children : <div className="h-full animate-pulse rounded-md bg-surface-2/60" />}</div>
          </>
        ) : (
          <div className="max-h-64 overflow-auto rounded-lg border border-line">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface-2 text-left text-fg-2">
                <tr>
                  {table.map((c) => (
                    <th key={c.header} className="px-3 py-2 font-medium">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular">
                {[...data].reverse().map((row, i) => (
                  <tr key={i} className="border-t border-line">
                    {table.map((c) => (
                      <td key={c.header} className="px-3 py-1.5 text-fg">
                        {c.cell(row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

function ChartTooltip({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  series,
}: TooltipContentProps<number, string> & {
  labelFormatter: (v: number | string) => string;
  valueFormatter: (v: number) => string;
  series: SeriesDef[];
}) {
  const colors = useChartColors();
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-card">
      <div className="mb-1 text-fg-3">{labelFormatter(label as number | string)}</div>
      {series.map((s) => {
        const p = payload.find((x) => x.dataKey === s.key);
        if (!p) return null;
        return (
          <div key={s.key} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: s.slot === 1 ? colors.series1 : colors.series2 }} />
            <span className="text-fg-2">{s.label}</span>
            <span className="tabular ml-auto pl-4 font-medium text-fg">{valueFormatter(Number(p.value))}</span>
          </div>
        );
      })}
    </div>
  );
}

const axisProps = (color: string) => ({
  tick: { fill: color, fontSize: 11 },
  axisLine: false,
  tickLine: false,
});

/** 时间序列折线/面积图（共用一个 Y 轴，不做双轴） */
export function TimeSeries<T extends { t: number }>({
  data,
  series,
  xFormatter,
  yFormatter,
  tooltipValue,
  yDomain,
  yTicks,
}: {
  data: T[];
  series: SeriesDef[];
  xFormatter: (t: number) => string;
  yFormatter: (v: number) => string;
  tooltipValue?: (v: number) => string;
  yDomain?: [number, number | 'auto'];
  yTicks?: number[];
}) {
  const c = useChartColors();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={xFormatter} minTickGap={40} {...axisProps(c.axis)} />
        <YAxis width={68} tickFormatter={yFormatter} domain={yDomain ?? [0, 'auto']} ticks={yTicks} allowDecimals={false} {...axisProps(c.axis)} />
        <Tooltip
          cursor={{ stroke: c.axis, strokeWidth: 1 }}
          content={(p) => (
            <ChartTooltip
              {...(p as TooltipContentProps<number, string>)}
              series={series}
              labelFormatter={(v) => xFormatter(Number(v))}
              valueFormatter={tooltipValue ?? yFormatter}
            />
          )}
        />
        {series.map((s) => {
          const color = s.slot === 1 ? c.series1 : c.series2;
          return (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.label}
              stroke={color}
              strokeWidth={2}
              strokeDasharray={s.slot === 2 ? '5 4' : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={color}
              // 单序列使用 10% 面积底色；多序列只画线，避免底色叠加发灰
              fillOpacity={series.length === 1 ? 0.1 : 0}
              dot={false}
              activeDot={{ r: 4, fill: color, stroke: c.surface, strokeWidth: 2 }}
              isAnimationActive={false}
            />
          );
        })}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** 柱状图：单序列或堆叠双序列，柱宽上限 24px，顶部 4px 圆角 */
export function Bars<T extends object>({
  data,
  xKey,
  series,
  xFormatter,
  yFormatter,
  stacked,
}: {
  data: T[];
  xKey: string;
  series: SeriesDef[];
  xFormatter: (v: string) => string;
  yFormatter: (v: number) => string;
  stacked?: boolean;
}) {
  const c = useChartColors();
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis dataKey={xKey} tickFormatter={xFormatter} minTickGap={16} {...axisProps(c.axis)} />
        <YAxis width={64} tickFormatter={yFormatter} {...axisProps(c.axis)} />
        <Tooltip
          cursor={{ fill: c.grid, opacity: 0.6 }}
          content={(p) => (
            <ChartTooltip
              {...(p as TooltipContentProps<number, string>)}
              series={series}
              labelFormatter={(v) => String(v)}
              valueFormatter={yFormatter}
            />
          )}
        />
        {series.map((s, i) => {
          const top = !stacked || i === series.length - 1;
          return (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? 'stack' : undefined}
              fill={s.slot === 1 ? c.series1 : c.series2}
              maxBarSize={24}
              radius={top ? [4, 4, 0, 0] : 0}
              stroke={c.surface}
              strokeWidth={stacked ? 2 : 0}
              isAnimationActive={false}
            />
          );
        })}
      </BarChart>
    </ResponsiveContainer>
  );
}

/**
 * 趋势面积图（单序列，类别 X 轴）：平滑曲线 + 自上而下渐隐的面积底色，用于总览页的收入趋势等。
 * 用法：容器需有固定高度。
 */
export function Trend<T extends object>({
  data,
  xKey,
  yKey,
  label,
  xFormatter,
  yFormatter,
}: {
  data: T[];
  xKey: string;
  yKey: string;
  label: string;
  xFormatter: (v: string) => string;
  yFormatter: (v: number) => string;
}) {
  const c = useChartColors();
  const fill = `trend-fill-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const series: SeriesDef[] = [{ key: yKey, label, slot: 1 }];
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={fill} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={c.series1} stopOpacity={0.12} />
            <stop offset="1" stopColor={c.series1} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke={c.grid} strokeWidth={1} />
        <XAxis dataKey={xKey} tickFormatter={xFormatter} minTickGap={28} tickMargin={8} {...axisProps(c.axis)} />
        <YAxis width={56} tickFormatter={yFormatter} allowDecimals={false} {...axisProps(c.axis)} />
        <Tooltip
          cursor={{ stroke: c.axis, strokeWidth: 1, strokeDasharray: '3 3' }}
          content={(p) => (
            <ChartTooltip
              {...(p as TooltipContentProps<number, string>)}
              series={series}
              labelFormatter={(v) => String(v)}
              valueFormatter={yFormatter}
            />
          )}
        />
        <Area
          type="monotone"
          dataKey={yKey}
          name={label}
          stroke={c.series1}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={`url(#${fill})`}
          dot={false}
          activeDot={{ r: 4, fill: c.series1, stroke: c.surface, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

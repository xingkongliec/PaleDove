// 中国节点地图：按省份的最低延迟着色，悬停显示该省三网延迟；右下角为南海诸岛小图。
// 地图数据（assets/china-map.json，DataV.GeoAtlas 简化）在打开节点测试时才按需加载。
import { useEffect, useRef, useState } from 'react';
import { latencyLevel, PING_ISPS, type PingSummary } from '../../shared/index';
import { Badge, Skeleton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';

interface MapData {
  viewBox: [number, number, number, number];
  inset: { viewBox: [number, number, number, number]; paths: { d: string; line?: boolean }[] };
  provinces: { code: number; name: string; d: string; cx: number; cy: number }[];
}

let cached: MapData | null = null;
function useMapData() {
  const [data, setData] = useState<MapData | null>(cached);
  useEffect(() => {
    if (cached) return;
    void import('@/assets/china-map.json').then((m) => {
      cached = (m.default ?? m) as unknown as MapData;
      setData(cached);
    });
  }, []);
  return data;
}

/** 延迟分档的填充色（与图例、列表一致） */
export const LAT_FILL = ['fill-lat-0', 'fill-lat-1', 'fill-lat-2', 'fill-lat-3', 'fill-lat-4', 'fill-lat-5'] as const;
export const LAT_BG = ['bg-lat-0', 'bg-lat-1', 'bg-lat-2', 'bg-lat-3', 'bg-lat-4', 'bg-lat-5'] as const;
export const LAT_TEXT = ['text-lat-0', 'text-lat-1', 'text-lat-2', 'text-lat-3', 'text-lat-4', 'text-lat-5'] as const;

export const ms = (v: number | null | undefined) => (v == null ? null : `${Math.round(v)}ms`);

export function ChinaPingMap({ summary }: { summary: PingSummary }) {
  const { t } = useI18n();
  const data = useMapData();
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null);
  if (!data) return <Skeleton className="aspect-[4/3] w-full" />;
  const info = hover ? summary.provinces.get(hover.name) : undefined;
  const move = (name: string) => (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    setHover({ name, x: e.clientX - r.left, y: e.clientY - r.top });
  };
  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={data.viewBox.join(' ')} className="h-auto w-full" role="img" aria-label={t('ping.map')}>
        {data.provinces.map((p) => {
          const s = summary.provinces.get(p.name);
          return (
            <path
              key={p.code}
              d={p.d}
              onMouseMove={s ? move(p.name) : undefined}
              className={cn(
                'stroke-surface transition-[opacity] duration-150 [stroke-width:0.8]',
                s ? LAT_FILL[latencyLevel(s.best)] : 'fill-surface-4',
                s && 'cursor-pointer',
                hover && hover.name !== p.name && 'opacity-80',
              )}
            />
          );
        })}
      </svg>

      {/* 图例 */}
      <ul className="absolute bottom-1 left-1 space-y-1 text-[11px] text-fg-2">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className={cn('h-3 w-5 rounded-sm', LAT_BG[i])} />
            {t(`ping.legend.${i as 0 | 1 | 2 | 3 | 4 | 5}`)}
          </li>
        ))}
      </ul>

      {/* 南海诸岛 */}
      <div className="absolute right-1 bottom-1 w-[16%] rounded border border-line bg-surface/60 p-0.5" title={t('ping.inset')}>
        <svg viewBox={data.inset.viewBox.join(' ')} className="h-auto w-full">
          {data.inset.paths.map((p, i) => (
            <path key={i} d={p.d} className={p.line ? 'fill-none stroke-fg-4 [stroke-width:0.8]' : 'fill-surface-4'} />
          ))}
        </svg>
      </div>

      {/* 悬停提示：该省三网延迟、最低延迟与可达数 */}
      {hover && info && (
        <div
          className="pointer-events-none absolute z-10 w-52 rounded-lg border border-line bg-surface p-3 text-[13px] shadow-card"
          style={{ left: Math.min(hover.x + 12, (box.current?.clientWidth ?? 0) - 216), top: hover.y + 12 }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold text-fg">{info.province}</span>
            <Badge tone={info.reachable === info.total ? 'success' : info.reachable ? 'warning' : 'danger'}>
              {t(info.reachable === info.total ? 'ping.status.ok' : info.reachable ? 'ping.status.loss' : 'ping.status.timeout')}
            </Badge>
          </div>
          <div className="space-y-1">
            {info.regional && (
              <div className="flex justify-between gap-3">
                <span className="text-fg-2">{info.province}</span>
                <span className={cn('tabular font-medium', LAT_TEXT[latencyLevel(info.regional.latency)])}>{ms(info.regional.latency) ?? t('ping.timeout')}</span>
              </div>
            )}
            {PING_ISPS.map((isp) => {
              const r = info.byIsp[isp];
              if (!r) return null;
              return (
                <div key={isp} className="flex justify-between gap-3">
                  <span className="text-fg-2">
                    {info.province}
                    {t(`ping.isp.${isp}`)}
                  </span>
                  <span className={cn('tabular font-medium', LAT_TEXT[latencyLevel(r.latency)])}>{ms(r.latency) ?? t('ping.timeout')}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between gap-3 border-t border-line pt-2 text-xs">
            <span className="text-fg-3">{info.best != null ? t('ping.best', { ms: ms(info.best)! }) : t('ping.timeout')}</span>
            <span className="tabular text-fg">{t('ping.reachable', { n: info.reachable, total: info.total })}</span>
          </div>
        </div>
      )}
    </div>
  );
}

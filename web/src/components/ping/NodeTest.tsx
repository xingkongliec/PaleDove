// 节点测试结果：中国节点地图 + 三网线路概览 + 节点列表（运营商筛选、按延迟 / 丢包排序）。
// 购买页（公开数据）与宿主机详情（管理员）共用；有多台宿主机时可切换。
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { latencyLevel, PING_ISPS, pingTarget, summarizePing, type NodePingDTO, type PingIsp } from '../../shared/index';
import { Card, Checkbox, Empty, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { ChinaPingMap, LAT_TEXT, ms } from './ChinaPingMap';

function Panel({ title, desc, extra, children, className }: { title: string; desc?: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Card className={cn('flex min-w-0 flex-col', className)}>
      <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
          {desc && <p className="mt-0.5 text-xs text-fg-3">{desc}</p>}
        </div>
        {extra}
      </div>
      <div className="flex-1 p-3">{children}</div>
    </Card>
  );
}

/** 三网线路概览：三网最快、三网稳定（可达 / 最慢）、三网综合 */
function Overview({ summary }: { summary: ReturnType<typeof summarizePing> }) {
  const { t, locale } = useI18n();
  const name = (p: { province: string; provinceEn: string }) => (locale === 'en' ? p.provinceEn : p.province);
  return (
    <div className="space-y-4 text-[13px]">
      <section>
        <div className="mb-2 flex justify-between text-xs text-fg-3">
          <span className="font-medium text-fg-2">{t('ping.fastest')}</span>
          {t('ping.fastestHint')}
        </div>
        <div className="space-y-2">
          {PING_ISPS.map((isp) => {
            const f = summary.isps[isp].fastest;
            return (
              <div key={isp} className="flex items-center justify-between rounded-lg border border-line bg-surface-2/60 px-3 py-2.5">
                <span className="text-fg">{f ? `${name(f.target)}${t(`ping.isp.${isp}`)}` : t(`ping.isp.${isp}`)}</span>
                <span className={cn('tabular text-lg', f ? LAT_TEXT[latencyLevel(f.latency)] : 'text-fg-4')}>{f ? ms(f.latency) : '—'}</span>
              </div>
            );
          })}
        </div>
      </section>
      <section className="border-t border-line pt-3">
        <div className="mb-2 flex justify-between text-xs text-fg-3">
          <span className="font-medium text-fg-2">{t('ping.stable')}</span>
          {t('ping.stableHint')}
        </div>
        <div className="space-y-1.5">
          {PING_ISPS.map((isp) => {
            const s = summary.isps[isp];
            return (
              <div key={isp} className="flex items-center justify-between rounded-md bg-surface-2/60 px-3 py-2 text-xs">
                <span className="text-fg-2">
                  {t(`ping.isp.${isp}`)} · <span className={s.reachable === s.total ? 'text-success-text' : 'text-warning-text'}>{s.reachable}</span>/{s.total}
                </span>
                {s.slowest && (
                  <span className={cn('tabular', LAT_TEXT[latencyLevel(s.slowest.latency)])}>
                    {name(s.slowest.target)} {ms(s.slowest.latency)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <div className="flex justify-between border-t border-line pt-3 text-xs">
        <span className="text-fg-3">{t('ping.total')}</span>
        <span className="text-fg">
          {t('ping.reachable', { n: summary.reachable, total: summary.total })}
        </span>
      </div>
    </div>
  );
}

type SortKey = 'latency' | 'loss';

/** 节点列表：运营商筛选（可多选），按延迟或丢包排序 */
function TargetList({ node }: { node: NodePingDTO }) {
  const { t, locale } = useI18n();
  const [isps, setIsps] = useState<Set<PingIsp>>(new Set(PING_ISPS));
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'latency', asc: true });
  const rows = useMemo(() => {
    const list = node.results.flatMap((r) => {
      const target = pingTarget(r.id, node.targets);
      return target ? [{ ...r, target }] : [];
    });
    const value = (r: (typeof list)[number]) => (sort.key === 'loss' ? r.loss : (r.latency ?? Infinity));
    return list.sort((a, b) => (value(a) - value(b)) * (sort.asc ? 1 : -1));
  }, [node.results, node.targets, sort]);
  const count = (isp: PingIsp) => rows.filter((r) => r.target.isp === isp).length;
  const shown = rows.filter((r) => isps.has(r.target.isp));
  const toggle = (isp: PingIsp | 'ALL', on: boolean) =>
    setIsps(isp === 'ALL' ? new Set(on ? PING_ISPS : []) : (prev) => {
      const next = new Set(prev);
      if (on) next.add(isp);
      else next.delete(isp);
      return next;
    });
  const header = (key: SortKey, label: string) => (
    <button type="button" className={cn('inline-flex items-center gap-0.5', sort.key === key ? 'text-fg' : 'hover:text-fg')} onClick={() => setSort({ key, asc: sort.key === key ? !sort.asc : true })}>
      {label}
      {sort.key === key && sort.asc ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5 opacity-60" />}
    </button>
  );
  const chip = (key: PingIsp | 'ALL', label: string, n: number, checked: boolean) => (
    <label key={key} className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-fg-2 hover:border-line-strong">
      <Checkbox checked={checked} onCheckedChange={(v) => toggle(key, v)} />
      {label}
      <span className="tabular text-fg-3">{n}</span>
    </label>
  );
  return (
    <Panel
      title={t('ping.list')}
      extra={
        <div className="flex flex-wrap justify-end gap-1.5">
          {chip('ALL', t('ping.all'), rows.length, isps.size === PING_ISPS.length)}
          {PING_ISPS.map((isp) => chip(isp, t(`ping.isp.${isp}`), count(isp), isps.has(isp)))}
        </div>
      }
    >
      <div className="scrollbar-thin -m-3 max-h-96 overflow-auto">
        <table className="w-full min-w-[36rem] text-[13px]">
          <thead className="sticky top-0 bg-surface-2 text-left text-xs text-fg-3">
            <tr>
              <th className="px-4 py-2 font-medium">{t('ping.col.node')}</th>
              <th className="px-3 py-2 font-medium">{t('ping.col.isp')}</th>
              <th className="px-3 py-2 font-medium">{header('latency', t('ping.col.latency'))}</th>
              <th className="px-3 py-2 font-medium">{header('loss', t('ping.col.loss'))}</th>
              <th className="px-3 py-2 font-medium">{t('ping.col.status')}</th>
              <th className="px-4 py-2 font-medium">{t('ping.col.time')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {shown.map((r) => (
              <tr key={r.id} className="hover:bg-surface-2/50">
                <td className="px-4 py-2 text-fg">
                  {r.target.name || `${locale === 'en' ? r.target.provinceEn : r.target.province}${t(`ping.isp.${r.target.isp}`)}`}
                </td>
                <td className="px-3 py-2 text-fg-2">{t(`ping.isp.${r.target.isp}`)}</td>
                <td className={cn('tabular px-3 py-2', LAT_TEXT[latencyLevel(r.latency)])}>{ms(r.latency) ?? t('ping.timeout')}</td>
                <td className="tabular px-3 py-2 text-fg-2">{r.loss}%</td>
                <td className="px-3 py-2">
                  {r.latency == null ? (
                    <Tag tone="danger">{t('ping.status.timeout')}</Tag>
                  ) : r.loss > 0 ? (
                    <Tag tone="warning">{t('ping.status.loss')}</Tag>
                  ) : (
                    <Tag tone="success">{t('ping.status.ok')}</Tag>
                  )}
                </td>
                <td className="tabular px-4 py-2 text-xs text-fg-3">{formatDate(node.testedAt, 'YYYY-MM-DD HH:mm:ss')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** 一台或多台宿主机的节点测试结果 */
export function NodeTestView({ nodes }: { nodes: NodePingDTO[] }) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const node = nodes[Math.min(index, nodes.length - 1)];
  const summary = useMemo(() => summarizePing(node?.results ?? [], node?.targets), [node]);
  if (!node) return <Empty title={t('ping.empty')} description={t('ping.emptyDesc')} />;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-3">
        <span>
          {t(node.method === 'icmp' ? 'ping.methodIcmp' : 'ping.methodTcp')} · {t('ping.testedAt', { time: formatDate(node.testedAt, 'YYYY-MM-DD HH:mm') })}
        </span>
        {nodes.length > 1 && (
          <Select<number> value={index} onChange={setIndex} className="w-48" aria-label={t('ping.node')} options={nodes.map((n, i) => ({ value: i, label: n.label }))} />
        )}
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel
          title={t('ping.map')}
          desc={t('ping.mapDesc')}
          extra={<Tag tone="success">{t('ping.provinces', { n: summary.provinces.size })}</Tag>}
        >
          <ChinaPingMap summary={summary} />
        </Panel>
        <Panel title={t('ping.overview')} desc={t('ping.overviewDesc')}>
          <Overview summary={summary} />
        </Panel>
      </div>
      <TargetList node={node} />
    </div>
  );
}

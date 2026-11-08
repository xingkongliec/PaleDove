import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { MetricPoint, TrafficDailyDTO } from '../../shared/index';
import { Bars, ChartCard, TimeSeries } from '@/components/charts';
import { Segmented } from '@/components/ui/tabs';
import { useInstanceApiPath, type AnyInstance } from '@/hooks/instances';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { dayjs, formatBytes, formatCores, formatRate } from '@/lib/format';

const time = (t: number) => dayjs(t).format('HH:mm');

export default function Monitor({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const t = useT();
  const [minutes, setMinutes] = useState(60);
  const metrics = useQuery({
    queryKey: ['metrics', inst.id, minutes],
    queryFn: () => api.get<MetricPoint[]>(`${instancePath}/metrics`, { minutes }),
    refetchInterval: 30_000,
  });
  const traffic = useQuery({
    queryKey: ['traffic', inst.id],
    queryFn: () => api.get<TrafficDailyDTO[]>(`${instancePath}/traffic`),
    refetchInterval: 120_000,
  });
  const points = metrics.data ?? [];
  const memTotal = inst.memory * 1024 * 1024;
  const empty = t('monitor.empty');
  const rx = t('monitor.inbound');
  const tx = t('monitor.outbound');
  const timeCol = { header: t('common.time'), cell: (p: MetricPoint) => dayjs(p.t).format('MM-DD HH:mm') };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-2">{t('monitor.history')}</p>
        <Segmented
          value={minutes}
          onChange={setMinutes}
          items={[
            { value: 60, label: t('monitor.range1h') },
            { value: 360, label: t('monitor.range6h') },
            { value: 1440, label: t('monitor.range24h') },
          ]}
        />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard
          title={t('monitor.cpu')}
          description={t('monitor.cpuDesc', { cores: formatCores(inst.cpu) })}
          data={points}
          series={[{ key: 'cpu', label: 'CPU', slot: 1 }]}
          emptyText={empty}
          table={[timeCol, { header: 'CPU', cell: (p) => `${p.cpu.toFixed(1)}%` }]}
        >
          <TimeSeries
            data={points}
            series={[{ key: 'cpu', label: 'CPU', slot: 1 }]}
            xFormatter={time}
            yFormatter={(v) => `${v}%`}
            tooltipValue={(v) => `${v.toFixed(1)}%`}
            yDomain={[0, 100]}
            yTicks={[0, 25, 50, 75, 100]}
          />
        </ChartCard>
        <ChartCard
          title={t('monitor.memory')}
          description={t('monitor.memoryDesc', { total: formatBytes(memTotal) })}
          data={points}
          series={[{ key: 'mem', label: t('spec.memory'), slot: 1 }]}
          emptyText={empty}
          table={[timeCol, { header: t('spec.memory'), cell: (p) => formatBytes(p.mem) }]}
        >
          <TimeSeries
            data={points}
            series={[{ key: 'mem', label: t('spec.memory'), slot: 1 }]}
            xFormatter={time}
            yFormatter={(v) => formatBytes(v, 1)}
            tooltipValue={(v) => formatBytes(v)}
            yDomain={[0, memTotal]}
            yTicks={[0, memTotal / 4, memTotal / 2, (memTotal * 3) / 4, memTotal]}
          />
        </ChartCard>
      </div>
      <ChartCard
        title={t('monitor.network')}
        description={t('monitor.networkDesc')}
        data={points}
        series={[
          { key: 'rx', label: rx, slot: 1 },
          { key: 'tx', label: tx, slot: 2 },
        ]}
        emptyText={empty}
        table={[timeCol, { header: rx, cell: (p) => formatRate(p.rx) }, { header: tx, cell: (p) => formatRate(p.tx) }]}
      >
        <TimeSeries
          data={points}
          series={[
            { key: 'rx', label: rx, slot: 1 },
            { key: 'tx', label: tx, slot: 2 },
          ]}
          xFormatter={time}
          yFormatter={(v) => formatRate(v, 0)}
          tooltipValue={(v) => formatRate(v)}
        />
      </ChartCard>
      <ChartCard
        title={t('monitor.daily')}
        kind="bar"
        description={t('monitor.dailyDesc')}
        data={traffic.data ?? []}
        series={[
          { key: 'rx', label: rx, slot: 1 },
          { key: 'tx', label: tx, slot: 2 },
        ]}
        emptyText={t('monitor.noTraffic')}
        table={[
          { header: t('monitor.date'), cell: (d) => d.date },
          { header: rx, cell: (d) => formatBytes(d.rx) },
          { header: tx, cell: (d) => formatBytes(d.tx) },
          { header: t('monitor.total'), cell: (d) => formatBytes(d.rx + d.tx) },
        ]}
      >
        <Bars
          data={traffic.data ?? []}
          xKey="date"
          stacked
          series={[
            { key: 'rx', label: rx, slot: 1 },
            { key: 'tx', label: tx, slot: 2 },
          ]}
          xFormatter={(d) => d.slice(5)}
          yFormatter={(v) => formatBytes(v, 0)}
        />
      </ChartCard>
    </div>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Database, Globe, HardDrive, MemoryStick, Network, Plug, Plus, RefreshCw, Server, ShieldCheck, Star, Terminal, Trash } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { hasIpv6Mode, isPublicIpv4Mode, STORAGE_DRIVERS, type PoolUsage, type InstallCommandDTO, type IpAddressDTO, type NodeDTO, type NodeBandwidthDTO, type NodeResourcesDTO, type NodeUsageDTO, type ProxySiteDTO, type AdminSiteBindingDTO, type Paginated, type SiteStatus, type StoragePoolDTO } from '../../../shared/index';
import { Bars, ChartCard, TimeSeries } from '@/components/charts';
import { CountryLabel } from '@/components/country';
import { PageHeader } from '@/components/page';
import { CaddyStatusBadge, NodeStatusBadge, SiteStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import {
  Alert,
  Badge,
  Checkbox,
  Card,
  CardBody,
  CardHeader,
  CodeBlock,
  CopyButton,
  Empty,
  ErrorState,
  InfoList,
  PageLoading,
  Skeleton,
  Switch,
  UsageMeter,
} from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { Segmented, TabBar } from '@/components/ui/tabs';
import { useI18n, useT, type MessageKey } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dayjs, formatBytes, formatDate, formatRate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { InstallCommandPanel, NodeInstallSteps } from './InstallCommand';
import { SiteDialog } from './SiteDialog';
import { InstanceTable } from '../instances/Instances';
import { NodeSettings } from './NodeEdit';
import { MODE_LABEL } from './NodeForm';
import { NodeOpsTab } from './NodeOps';
import { InstanceCreateForm } from '../instances/InstanceCreate';
import { NodeImagesTab } from './NodeImages';
import { formatUptime, HostStatusCard } from './HostStatus';
import { NodeEgressTab } from './NodeEgress';

const TABS = ['overview', 'instances', 'create', 'ops', 'images', 'pools', 'caddy', 'egress', 'ips', 'edit'] as const;
type Tab = (typeof TABS)[number];

function useNodeInvalidate(id: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['admin-node', id] });
    void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
  };
}

/** 待安装的宿主机：执行安装脚本 → 验证并连接 */
function InstallCard({ node }: { node: NodeDTO }) {
  const t = useT();
  const [install, setInstall] = useState<InstallCommandDTO | null>(null);
  const gen = useMutation({
    mutationFn: (regenerate: boolean) => api.post<InstallCommandDTO>(`/admin/nodes/${node.id}/install-command`, { regenerate }),
    onMutate: () => setInstall(null),
    onSuccess: setInstall,
    onError: (e) => toast.fromError(e),
  });
  return (
    <Card className="border-primary/30">
      <CardHeader title={t('nodeDetail.finishInstall')} icon={<Terminal />} description={t('nodeDetail.finishInstallDesc')} />
      <CardBody>
        <NodeInstallSteps node={node} install={install} onGenerate={(r) => gen.mutate(r)} regenerating={gen.isPending} error={gen.error} />
      </CardBody>
    </Card>
  );
}

/** 重新安装：每次主动打开都签发新的安装命令，与参考项目一致。 */
function ReinstallButton({ node }: { node: NodeDTO }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const gen = useMutation({
    mutationFn: (regenerate: boolean) => api.post<InstallCommandDTO>(`/admin/nodes/${node.id}/install-command`, { regenerate }),
    onError: (e) => toast.fromError(e),
  });
  const install = gen.data;
  return (
    <>
      <Button
        icon={<Terminal />}
        disabled={gen.isPending}
        onClick={() => {
          setOpen(true);
          gen.mutate(true);
        }}
      >
        {t('nodeDetail.reinstall')}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title={t('nodeDetail.reinstallScript')}
        description={t('nodeDetail.reinstallScriptDesc')}
        footer={
          <>
            <Button icon={<RefreshCw />} loading={gen.isPending} onClick={() => gen.mutate(true)}>
              {t('nodeDetail.regenerate')}
            </Button>
            <Button onClick={() => setOpen(false)}>{t('common.close')}</Button>
          </>
        }
      >
        <div className="space-y-2">
          {gen.isPending ? <Skeleton className="h-12 w-full" /> : gen.error ? <Alert tone="danger">{errorText(gen.error)}</Alert> : install ? (
            <>
              <CodeBlock value={install.command} />
              <p className="text-xs text-fg-3">{t('install.expires', { time: formatDate(install.expiresAt) })}</p>
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );
}

/** 测试连接：确认面板证书仍被信任，并同步 Incus 版本与 NAT 网段 */
function TestConnectButton({ node }: { node: NodeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const invalidate = useNodeInvalidate(node.id);
  const connect = useMutation({
    mutationFn: () => api.post<{ version: string; warnings: string[] }>(`/admin/nodes/${node.id}/connect`, {}),
    onSuccess: (r) => {
      toast.success(t('nodeDetail.connectOk', { version: r.version }), r.warnings.join('; ') || undefined);
      invalidate();
      void qc.invalidateQueries({ queryKey: ['node-resources', node.id] });
    },
    onError: (e) => {
      toast.fromError(e, t('nodeDetail.connectFailed'));
      invalidate();
    },
  });
  return (
    <Button icon={<Plug />} loading={connect.isPending} onClick={() => connect.mutate()}>
      {t('nodeDetail.testConnectShort')}
    </Button>
  );
}

const usageLevel = (pct: number) => (pct >= 95 ? 'danger' : pct >= 80 ? 'warning' : 'normal');

/** 资源横条：名称与使用率 → 横条 → 明细（左）与已售（右）；高占用时同时给出文字提示，不只靠颜色 */
function UsageBar({ label, icon, pct, detail, sold }: { label: string; icon: ReactNode; pct: number | null; detail: ReactNode; sold?: ReactNode }) {
  const t = useT();
  const value = pct === null ? null : Math.min(100, Math.max(0, pct));
  const level = value === null ? 'normal' : usageLevel(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="text-fg-3 [&>svg]:size-3.5">{icon}</span>
        <span className="min-w-0 truncate font-medium text-fg">{label}</span>
        {level !== 'normal' && (
          <span className={cn('text-xs', level === 'danger' ? 'text-danger-text' : 'text-warning-text')}>
            {level === 'danger' ? t('common.usageCritical') : t('common.usageHigh')}
          </span>
        )}
        <span className="tabular ml-auto font-semibold text-fg">{value === null ? '—' : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
        <div
          className={cn('h-full origin-left rounded-full transition-transform duration-700 ease-smooth', level === 'danger' ? 'bg-danger' : level === 'warning' ? 'bg-warning' : 'bg-fg-2')}
          style={{ transform: `scaleX(${(value ?? 0) / 100})` }}
        />
      </div>
      <div className="tabular flex flex-wrap justify-between gap-x-3 text-xs text-fg-3">
        <span className="min-w-0 truncate">{detail}</span>
        {sold && <span className="text-fg-4">{sold}</span>}
      </div>
    </div>
  );
}

function useNodeUsage(node: NodeDTO) {
  return useQuery({
    queryKey: ['node-usage', node.id],
    queryFn: () => api.get<NodeUsageDTO>(`/admin/nodes/${node.id}/usage`),
    refetchInterval: 60_000,
  });
}

function useNodeResources(node: NodeDTO) {
  const installed = node.status !== 'PENDING';
  return useQuery({
    queryKey: ['node-resources', node.id],
    queryFn: () => api.get<NodeResourcesDTO>(`/admin/nodes/${node.id}/resources`),
    enabled: installed && node.status !== 'OFFLINE',
    refetchInterval: 15_000,
  });
}

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/**
 * 资源占用：CPU 以系统 1 分钟负载 ÷ 线程数表示（无负载数据时用实例监控估算），
 * 内存与存储池为宿主机实际用量，并附已售出的配额。
 */
function ResourceCard({ node }: { node: NodeDTO }) {
  const t = useT();
  const res = useNodeResources(node);
  const usage = useNodeUsage(node).data;
  const r = res.data;
  const a = usage?.allocated;
  const cpuUsed = usage?.cpuUsed ?? null;
  const threads = r?.cpu.cores ?? 0;
  // 只使用在线 Agent 的数据（离线时最后一次上报仍会返回，但不再代表当前状态）
  const host = r?.host?.online ? r.host : null;
  // CPU：优先使用上报程序的真实使用率，其次是 Incus 提供的负载，最后按实例监控估算
  const cpuPct = !r
    ? null
    : host
      ? host.cpu
      : r.load && threads
        ? (r.load.avg1 / threads) * 100
        : cpuUsed !== null && threads
          ? (cpuUsed / threads) * 100
          : null;
  const load = host ? host.load : r?.load ? [r.load.avg1, r.load.avg5, r.load.avg15] : null;
  const cpuDetail = !r
    ? null
    : load
      ? [
          t('nodeDetail.loadValue', { a: load[0].toFixed(2), b: load[1].toFixed(2), c: load[2].toFixed(2), threads }),
          host && t('nodeDetail.uptime', { value: formatUptime(host.uptime, t) }),
        ]
          .filter(Boolean)
          .join(' · ')
      : cpuUsed !== null
        ? t('nodeDetail.cpuUsedValue', { used: cpuUsed.toFixed(1), cores: threads })
        : t('nodeDetail.cpuNoData', { cores: threads });
  return (
    <Card className="flex flex-col">
      <CardHeader
        title={t('nodeDetail.resources')}
        icon={<Cpu />}
        description={t('nodeDetail.instancesLine', {
          n: node.instanceCount,
          max: node.maxInstances,
          running: r?.instances.running ?? 0,
          total: r?.instances.total ?? 0,
        })}
      />
      {/* 卡片被拉高时横条在剩余空间内均匀分布 */}
      <CardBody className="flex flex-1 flex-col justify-around gap-5">
        {res.error ? (
          <ErrorState error={res.error} onRetry={() => res.refetch()} />
        ) : !r ? (
          Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-2 w-full" />
            </div>
          ))
        ) : (
          <>
            <UsageBar
              label="CPU"
              icon={<Cpu />}
              pct={cpuPct}
              detail={
                // 安装过上报程序但 2 分钟内没有上报：提示中断
                !host && r.agentInstalled ? <span className="text-warning-text">{t('nodeDetail.agentStale')}</span> : cpuDetail
              }
              sold={a && t('nodeDetail.soldCpu', { n: a.cpu })}
            />
            <UsageBar
              label={t('spec.memory')}
              icon={<MemoryStick />}
              pct={r.memory.total ? (r.memory.used / r.memory.total) * 100 : null}
              detail={`${formatBytes(r.memory.used)} / ${formatBytes(r.memory.total)}`}
              sold={a && t('nodeDetail.sold', { value: formatBytes(a.memory * MiB) })}
            />
            {r.storage ? (
              <UsageBar
                label={t('nodeDetail.poolUsage', { pool: r.storage.pool, driver: r.storage.driver })}
                icon={<HardDrive />}
                pct={r.storage.total ? (r.storage.used / r.storage.total) * 100 : null}
                detail={`${formatBytes(r.storage.used)} / ${formatBytes(r.storage.total)}`}
                sold={a && t('nodeDetail.sold', { value: formatBytes(a.disk * GiB) })}
              />
            ) : (
              <UsageBar label={t('pools.title')} icon={<HardDrive />} pct={null} detail={t('nodeDetail.poolUnavailable')} />
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** 实时带宽：宿主机物理网卡的收发速率，查看时每 5 秒采样一次，显示最近一小时 */
function BandwidthCard({ node }: { node: NodeDTO }) {
  const t = useT();
  const q = useQuery({
    queryKey: ['node-bandwidth', node.id],
    queryFn: () => api.get<NodeBandwidthDTO>(`/admin/nodes/${node.id}/bandwidth`),
    refetchInterval: 5000,
  });
  const b = q.data;
  const rx = t('monitor.inbound');
  const tx = t('monitor.outbound');
  const series = [
    { key: 'rx', label: rx, slot: 1 as const },
    { key: 'tx', label: tx, slot: 2 as const },
  ];
  const time = (v: number) => dayjs(v).format('HH:mm');
  if (q.error) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  return (
    <ChartCard
      title={t('nodeDetail.bandwidth')}
      description={b ? t('nodeDetail.bandwidthDesc', { nics: b.interfaces.join(', ') || '—' }) : undefined}
      data={b?.series ?? []}
      series={series}
      emptyText={q.isLoading ? t('common.loading') : t('nodeDetail.bandwidthWaiting')}
      summary={
        <div className="tabular flex gap-8">
          {[
            { label: rx, value: b?.current?.rx },
            { label: tx, value: b?.current?.tx },
          ].map((s) => (
            <div key={s.label}>
              <div className="text-xs text-fg-3">{s.label}</div>
              <div className="mt-1 text-xl font-semibold tracking-tight text-fg">{s.value === undefined ? '—' : formatRate(s.value)}</div>
            </div>
          ))}
        </div>
      }
      table={[
        { header: t('nodeDetail.time'), cell: (p) => dayjs(p.t).format('HH:mm:ss') },
        { header: rx, cell: (p) => formatRate(p.rx) },
        { header: tx, cell: (p) => formatRate(p.tx) },
      ]}
    >
      <TimeSeries data={b?.series ?? []} series={series} xFormatter={time} yFormatter={(v) => formatRate(v, 0)} tooltipValue={(v) => formatRate(v)} />
    </ChartCard>
  );
}

/** 硬件信息（来自 Incus 资源接口） */
function HardwareCard({ node }: { node: NodeDTO }) {
  const t = useT();
  const r = useNodeResources(node).data;
  const hw = r?.hardware;
  const speed = (mbit: number) => (mbit >= 1000 ? `${mbit / 1000} Gbps` : `${mbit} Mbps`);
  const ghz = (mhz: number) => `${(mhz / 1000).toFixed(2)} GHz`;
  const items: { label: ReactNode; value: ReactNode }[] = [];
  if (hw) {
    if (hw.system) {
      items.push({
        label: t('nodeDetail.hwSystem'),
        value: [`${hw.system.vendor} ${hw.system.product}`.trim(), hw.system.type === 'physical' ? t('nodeDetail.hwPhysical') : hw.system.type === 'virtual-machine' ? t('nodeDetail.hwVirtual') : hw.system.type].filter(Boolean).join(' · '),
      });
    }
    items.push({
      label: 'CPU',
      value: (
        <div>
          <div>{hw.cpu.model || '—'}</div>
          <div className="text-xs text-fg-3">
            {[
              hw.cpu.sockets > 1 && t('nodeDetail.hwSockets', { n: hw.cpu.sockets }),
              t('nodeDetail.hwCores', { cores: hw.cpu.cores, threads: hw.cpu.threads }),
              hw.cpu.frequency && (hw.cpu.turbo ? `${ghz(hw.cpu.frequency)} – ${ghz(hw.cpu.turbo)}` : ghz(hw.cpu.frequency)),
              hw.cpu.arch,
            ]
              .filter(Boolean)
              .join(' · ')}
          </div>
        </div>
      ),
    });
    items.push({ label: t('spec.memory'), value: formatBytes(r.memory.total) });
    if (hw.disks.length) {
      items.push({
        label: t('nodeDetail.hwDisks'),
        value: (
          <ul className="space-y-0.5">
            {hw.disks.map((d) => (
              <li key={d.name}>
                <span className="font-mono text-xs">{d.name}</span> · {formatBytes(d.size, 2)}
                <span className="text-xs text-fg-3">
                  {' '}
                  · {[d.model, d.ssd === null ? d.type : d.ssd ? 'SSD' : 'HDD'].filter(Boolean).join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        ),
      });
    }
    if (hw.nics.length) {
      items.push({
        label: t('nodeDetail.hwNics'),
        value: (
          <ul className="space-y-0.5">
            {hw.nics.map((n) => (
              <li key={n.name}>
                <span className="font-mono text-xs">{n.name}</span> · {n.link ? (n.speed ? speed(n.speed) : t('nodeDetail.hwLinkUp')) : <span className="text-fg-3">{t('nodeDetail.hwLinkDown')}</span>}
                {n.product && <span className="text-xs text-fg-3"> · {n.product}</span>}
              </li>
            ))}
          </ul>
        ),
      });
    }
    if (hw.gpus.length) items.push({ label: 'GPU', value: hw.gpus.map((g) => `${g.vendor} ${g.product}`.trim()).join('、') });
    if (hw.os) items.push({ label: t('nodeDetail.hwOs'), value: `${hw.os.name} ${hw.os.version} · ${t('nodeDetail.kernelShort', { kernel: hw.os.kernel })}` });
  }
  return (
    <Card>
      <CardHeader title={t('nodeDetail.hardware')} icon={<Server />} description={r ? `Incus ${r.serverVersion}` : undefined} />
      <CardBody className="py-3">
        {hw ? (
          <InfoList dense items={items} />
        ) : (
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** 本周期流量：汇总本机所有实例的流量，额度与重置日在「编辑」中设置 */
function TrafficCard({ node }: { node: NodeDTO }) {
  const { t, L } = useI18n();
  const q = useNodeUsage(node);
  const u = q.data;
  const rx = t('monitor.inbound');
  const tx = t('monitor.outbound');
  const series = [
    { key: 'rx', label: rx, slot: 1 as const },
    { key: 'tx', label: tx, slot: 2 as const },
  ];
  if (q.error) {
    return (
      <Card>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </Card>
    );
  }
  const traffic = u?.traffic;
  return (
    <ChartCard
      title={t('nodeDetail.traffic')}
      kind="bar"
      description={
        u
          ? t('nodeDetail.trafficPeriod', {
              start: formatDate(u.period.start, 'MM-DD'),
              end: formatDate(u.period.end, 'MM-DD'),
              day: u.period.resetDay,
              mode: L.trafficMode[u.traffic.mode],
            })
          : undefined
      }
      data={u?.daily ?? []}
      series={series}
      emptyText={q.isLoading ? t('common.loading') : t('monitor.noTraffic')}
      summary={
        traffic && (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div className="min-w-0">
              <div className="text-xs text-fg-3">{t('nodeDetail.trafficUsed')}</div>
              <div className="tabular mt-1 flex items-baseline gap-1 text-2xl font-semibold tracking-tight text-fg">
                {formatBytes(traffic.used)}
                <span className="text-sm font-normal text-fg-3">/ {traffic.limit ? formatBytes(traffic.limit) : t('nodeDetail.unlimited')}</span>
              </div>
            </div>
            <div className="tabular flex gap-6 text-xs text-fg-3">
              <div>
                {rx}
                <div className="mt-0.5 text-sm text-fg">{formatBytes(traffic.rx)}</div>
              </div>
              <div>
                {tx}
                <div className="mt-0.5 text-sm text-fg">{formatBytes(traffic.tx)}</div>
              </div>
            </div>
            {traffic.limit && traffic.used > traffic.limit ? (
              <div className="min-w-48 flex-1 text-xs">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-fg-3">{t('nodeDetail.trafficQuota')}</span>
                  <span className="tabular font-medium text-danger-text">{t('nodeDetail.overQuota', { value: formatBytes(traffic.used - traffic.limit) })}</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-danger" />
              </div>
            ) : traffic.limit ? (
              <UsageMeter
                className="min-w-48 flex-1"
                label={t('nodeDetail.trafficQuota')}
                value={traffic.used}
                max={traffic.limit}
                valueText={`${Math.round((traffic.used / traffic.limit) * 100)}%`}
              />
            ) : null}
          </div>
        )
      }
      table={[
        { header: t('monitor.date'), cell: (d) => d.date },
        { header: rx, cell: (d) => formatBytes(d.rx) },
        { header: tx, cell: (d) => formatBytes(d.tx) },
        { header: t('monitor.total'), cell: (d) => formatBytes(d.rx + d.tx) },
      ]}
    >
      <Bars data={u?.daily ?? []} xKey="date" stacked series={series} xFormatter={(d) => d.slice(5)} yFormatter={(v) => formatBytes(v, 0)} />
    </ChartCard>
  );
}

function ConnectionCard({ node }: { node: NodeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const invalidate = useNodeInvalidate(node.id);
  const [token, setToken] = useState('');
  const installed = node.status !== 'PENDING';
  // 与资源指标共用缓存，用于显示 Incus 版本与内核
  const res = useQuery({
    queryKey: ['node-resources', node.id],
    queryFn: () => api.get<NodeResourcesDTO>(`/admin/nodes/${node.id}/resources`),
    enabled: installed && node.status !== 'OFFLINE',
    refetchInterval: 30_000,
  }).data;
  const connect = useMutation({
    mutationFn: () => api.post<{ version: string; natCidr: string | null; warnings: string[] }>(`/admin/nodes/${node.id}/connect`, { trustToken: token.trim() || undefined }),
    onSuccess: (r) => {
      toast.success(t('nodeDetail.connectOk', { version: r.version }), r.warnings.join('; ') || undefined);
      setToken('');
      invalidate();
      void qc.invalidateQueries({ queryKey: ['node-resources', node.id] });
    },
    onError: (e) => {
      toast.fromError(e, t('nodeDetail.connectFailed'));
      invalidate();
    },
  });
  return (
    <Card>
      <CardHeader
        title={t('nodeDetail.connection')}
        icon={<Plug />}
        description={node.lastCheckedAt ? t('nodeDetail.lastChecked', { time: formatDate(node.lastCheckedAt) }) : t('nodeDetail.neverChecked')}
      />
      <CardBody className="space-y-3 py-3">
        <InfoList
          dense
          items={[
            { label: t('common.status'), value: <NodeStatusBadge status={node.status} /> },
            { label: t('nodeForm.endpoint'), value: <span className="font-mono text-xs break-all">{node.endpoint || '—'}</span> },
            {
              label: t('nodeDetail.fingerprintShort'),
              value: node.serverFingerprint ? (
                <span className="flex items-start gap-1">
                  <span className="font-mono text-xs break-all">{node.serverFingerprint}</span>
                  <CopyButton value={node.serverFingerprint} className="-mt-1 shrink-0" />
                </span>
              ) : (
                <span className="text-fg-3">{t('nodeDetail.notPinned')}</span>
              ),
            },
            { label: t('nodeDetail.incusVersion'), value: res ? `${res.serverVersion} · ${t('nodeDetail.kernelShort', { kernel: res.kernel })}` : (node.incusVersion ?? '—') },
            { label: t('nodeDetail.installedAt'), value: formatDate(node.installedAt) },
          ]}
        />
        {node.lastError && node.status !== 'OFFLINE' && <Alert tone="danger">{node.lastError}</Alert>}
        {installed && (
          <details className="group border-t border-line pt-3">
            <summary className="cursor-pointer text-xs font-medium text-fg-3 select-none hover:text-fg">{t('nodeDetail.trustTokenToggle')}</summary>
            <div className="mt-3 space-y-2">
              <FormField description={t('nodeDetail.trustTokenHint')}>
                <Textarea rows={2} className="font-mono text-xs" value={token} onChange={(e) => setToken(e.target.value)} aria-label={t('nodeForm.trustToken')} />
              </FormField>
              <div className="flex justify-end">
                <Button size="sm" loading={connect.isPending} disabled={!token.trim()} onClick={() => connect.mutate()}>
                  {t('nodeDetail.trustTokenSubmit')}
                </Button>
              </div>
            </div>
          </details>
        )}
      </CardBody>
    </Card>
  );
}

function NetworkCard({ node }: { node: NodeDTO }) {
  const t = useT();
  const mode = node.networkMode;
  const mono = (v: ReactNode) => <span className="font-mono text-xs break-all">{v}</span>;
  // IPv4 端口映射监听在设置的地址上，未设置时使用公网 IPv4（与服务端 natListenIpv4 一致）
  const listen = [node.natListenAddress && node.natListenAddress !== '0.0.0.0' ? node.natListenAddress : node.publicIp, node.natListenAddressV6].filter(Boolean).join(' · ');
  // 网络模式显示在卡片标题下方
  const items: { label: ReactNode; value: ReactNode }[] = [];
  if (mode !== 'IPV6_ONLY' && !isPublicIpv4Mode(mode)) {
    items.push(
      { label: t('nodeForm.publicIp'), value: mono(node.publicIp || '—') },
      ...(node.publicIpv6 ? [{ label: t('nodeForm.publicIpv6'), value: mono(node.publicIpv6) }] : []),
      { label: t('nodeForm.portRange'), value: mono(`${node.portRangeStart} – ${node.portRangeEnd}`) },
      { label: t('nodeDetail.listen'), value: listen ? mono(listen) : <span className="text-fg-3">{t('nodeDetail.listenAll')}</span> },
    );
  }
  if (hasIpv6Mode(mode)) {
    items.push({
      label: t('nodeForm.ipv6Subnet'),
      value: node.ipv6Subnet ? mono([node.ipv6Subnet, node.ipv6Parent].filter(Boolean).join(' · ')) : <span className="text-warning-text">{t('nodeDetail.ipv6Missing')}</span>,
    });
  }
  if (!isPublicIpv4Mode(mode)) {
    items.push({ label: t('nodeForm.natCidr'), value: node.natCidr ? mono(node.natCidr) : <span className="text-fg-3">{t('nodeDetail.notSynced')}</span> });
  } else {
    items.push(
      { label: t('nodeForm.ipv4'), value: <span className="tabular">{`${node.ipStats.used} / ${node.ipStats.total}`}</span> },
      { label: t('nodeForm.nicMode'), value: [node.publicNicMode === 'ROUTED' ? 'routed' : 'bridged', node.publicNicParent].filter(Boolean).join(' · ') },
    );
  }
  return (
    <Card>
      <CardHeader title={t('nodeDetail.network')} icon={<Network />} description={t(MODE_LABEL[mode])} />
      <CardBody className="py-3">
        <InfoList dense items={items} />
      </CardBody>
    </Card>
  );
}

function OverviewTab({ node }: { node: NodeDTO }) {
  const t = useT();
  const installed = node.status !== 'PENDING';
  const live = installed && node.status !== 'OFFLINE';
  const res = useNodeResources(node);
  return (
    <div className="space-y-6">
      {!installed && <InstallCard node={node} />}
      {node.status === 'OFFLINE' && (
        <Alert tone="danger" title={t('nodeDetail.offline')}>
          {node.lastError}
        </Alert>
      )}
      {live && (
        <>
          {/* Agent 上报的宿主机状态（安装 / 重装 Agent 也在这里） */}
          <HostStatusCard node={node} res={res} />
          {/* 两张卡片等高 */}
          <div className="grid gap-6 xl:grid-cols-2">
            <ResourceCard node={node} />
            <BandwidthCard node={node} />
          </div>
        </>
      )}
      {installed && <TrafficCard node={node} />}
      {/* 硬件信息需要连接宿主机读取，离线或未安装时不显示 */}
      <div className={cn('grid gap-6', live ? 'lg:grid-cols-2 2xl:grid-cols-3' : 'lg:grid-cols-2')}>
        {live && <HardwareCard node={node} />}
        <ConnectionCard node={node} />
        <NetworkCard node={node} />
      </div>
    </div>
  );
}

const DRIVER_DESC: Record<string, MessageKey> = {
  zfs: 'nodeForm.driver.zfs',
  btrfs: 'nodeForm.driver.btrfs',
  lvm: 'nodeForm.driver.lvm',
  dir: 'nodeForm.driver.dir',
};

type PoolMode = 'create' | 'import';
type Driver = (typeof STORAGE_DRIVERS)[number];
const DRIVER_LABEL: Record<Driver, string> = { zfs: 'ZFS', lvm: 'LVM', btrfs: 'Btrfs', dir: 'DIR' };
/** 导入已有存储时，各驱动需要填写的底层存储 */
const IMPORT_SOURCE: Record<Driver, { label: MessageKey; hint: MessageKey; placeholder: string }> = {
  zfs: { label: 'pools.importZfs', hint: 'pools.importZfsHint', placeholder: 'tank' },
  lvm: { label: 'pools.importLvm', hint: 'pools.importLvmHint', placeholder: 'vg0' },
  btrfs: { label: 'pools.importBtrfs', hint: 'pools.importBtrfsHint', placeholder: '/mnt/btrfs' },
  dir: { label: 'pools.importDir', hint: 'pools.importDirHint', placeholder: '/data/incus' },
};

/**
 * 创建存储池：新建（格式化物理磁盘或使用 loop 文件），或导入底层已存在、Incus 还不知道的存储；
 * 用途区分实例系统盘（可设为默认存储池）与实例存储盘。
 */
function CreatePoolDialog({ node, onClose }: { node: NodeDTO; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [mode, setMode] = useState<PoolMode>('create');
  const [f, setF] = useState({
    name: '',
    driver: 'zfs' as Driver,
    loop: false,
    source: '',
    /** 容量（GiB），提交时补上单位 */
    size: '50',
    poolName: '',
    usage: 'root' as PoolUsage,
    makeDefault: false,
    description: '',
  });
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post(`/admin/nodes/${node.id}/storage-pools`, {
        mode,
        name: f.name,
        driver: f.driver,
        loop: mode === 'create' && f.driver !== 'dir' && f.loop,
        source: f.source || undefined,
        size: f.loop && Number(f.size) > 0 ? `${Number(f.size)}GiB` : undefined,
        poolName: mode === 'create' ? f.poolName || undefined : undefined,
        usage: f.usage,
        makeDefault: f.usage === 'root' && f.makeDefault,
        description: f.description || undefined,
      }),
    onSuccess: () => {
      toast.success(t('pools.created'));
      void qc.invalidateQueries({ queryKey: ['node-pools', node.id] });
      void qc.invalidateQueries({ queryKey: ['admin-node', node.id] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF({ ...f, [k]: v });
  const dir = f.driver === 'dir';
  const needsSource = mode === 'import' || (!dir && !f.loop);
  const imp = IMPORT_SOURCE[f.driver];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('pools.create')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!f.name || (needsSource && !f.source.trim())} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Segmented
          className="w-full"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
          items={[
            { value: 'create', label: t('pools.modeCreate') },
            { value: 'import', label: t('pools.modeImport') },
          ]}
        />

        {/* 名称与驱动并排；驱动说明只在下拉列表中显示 */}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('nodeForm.poolName')} required>
            <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="default" autoComplete="off" />
          </FormField>
          <FormField label={t('pools.driver')}>
            <Select
              aria-label={t('pools.driver')}
              value={f.driver}
              onChange={(v) => setF({ ...f, driver: v, loop: v === 'dir' ? false : f.loop })}
              options={STORAGE_DRIVERS.map((d) => ({ value: d, label: DRIVER_LABEL[d], description: t(DRIVER_DESC[d]) }))}
            />
          </FormField>
        </div>

        {mode === 'create' ? (
          <div className="space-y-3">
            {dir ? (
              <FormField label={t('pools.dirPath')}>
                <Input value={f.source} onChange={(e) => set('source', e.target.value)} className="font-mono text-xs" placeholder={t('pools.dirPathPlaceholder')} />
              </FormField>
            ) : f.loop ? (
              <FormField label={t('nodeForm.size')}>
                <InputGroup type="number" min={1} step={1} inputMode="numeric" suffix="GiB" value={f.size} onChange={(e) => set('size', e.target.value)} placeholder="50" />
              </FormField>
            ) : (
              <FormField label={t('pools.source')} required description={t('pools.sourceFormatWarn')}>
                <Input value={f.source} onChange={(e) => set('source', e.target.value)} className="font-mono text-xs" placeholder="/dev/disk/by-id/nvme-xxx" />
              </FormField>
            )}
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
              {!dir && <Checkbox checked={f.loop} onCheckedChange={(v) => set('loop', v)} label={t('pools.useLoop')} />}
              {(f.driver === 'zfs' || f.driver === 'lvm') && (
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 text-[13px] text-fg-3">{f.driver === 'zfs' ? t('pools.zfsName') : t('pools.lvmName')}</span>
                  <Input
                    value={f.poolName}
                    onChange={(e) => set('poolName', e.target.value)}
                    className="h-8 font-mono text-xs"
                    placeholder={t('pools.poolNamePlaceholder')}
                    aria-label={f.driver === 'zfs' ? t('pools.zfsName') : t('pools.lvmName')}
                  />
                </div>
              )}
            </div>
          </div>
        ) : (
          <FormField label={t(imp.label)} required description={t(imp.hint)}>
            <Input value={f.source} onChange={(e) => set('source', e.target.value)} className="font-mono text-xs" placeholder={imp.placeholder} />
          </FormField>
        )}

        {/* 用途：两个选项用分段选择，下方一行说明 */}
        <div className="space-y-2 rounded-lg bg-surface-2 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-fg-2">{t('pools.purpose')}</span>
            <Segmented
              value={f.usage}
              onChange={(v) => set('usage', v)}
              items={[
                { value: 'root', label: t('pools.usageRootShort') },
                { value: 'data', label: t('pools.usageDataShort') },
              ]}
            />
          </div>
          <p className="text-xs text-fg-3">{f.usage === 'root' ? t('pools.usageRootDesc') : t('pools.usageDataDesc')}</p>
          {f.usage === 'root' && <Checkbox checked={f.makeDefault} onCheckedChange={(v) => set('makeDefault', v)} label={t('pools.makeDefault')} />}
        </div>

        <FormField label={t('common.description')}>
          <Input value={f.description} onChange={(e) => set('description', e.target.value)} placeholder={t('common.notSet')} />
        </FormField>
      </div>
    </Modal>
  );
}

function PoolsTab({ node }: { node: NodeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const installed = node.status !== 'PENDING';
  const q = useQuery({ queryKey: ['node-pools', node.id], queryFn: () => api.get<StoragePoolDTO[]>(`/admin/nodes/${node.id}/storage-pools`), enabled: installed });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['node-pools', node.id] });
    void qc.invalidateQueries({ queryKey: ['admin-node', node.id] });
  };
  const setDefault = useMutation({
    mutationFn: (name: string) => api.post(`/admin/nodes/${node.id}/storage-pools/${encodeURIComponent(name)}/default`),
    onSuccess: () => {
      toast.success(t('pools.defaultSet'));
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/admin/nodes/${node.id}/storage-pools/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success(t('pools.deleted'));
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Card>
      <CardHeader
        title={t('pools.title')}
        icon={<Database />}
        description={t('pools.desc')}
        actions={
          <Button variant="primary" size="sm" icon={<Plus />} disabled={!installed} onClick={() => setCreating(true)}>
            {t('pools.create')}
          </Button>
        }
      />
      {!installed ? (
        <Empty title={t('nodeDetail.notInstalled')} description={t('nodeDetail.notInstalledDesc')} icon={<Database />} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(p) => p.name}
          empty={<Empty title={t('pools.empty')} icon={<Database />} />}
          columns={[
            {
              key: 'name',
              header: t('common.name'),
              cell: (p) => (
                <div className="min-w-0">
                  <div className="flex items-center gap-2 font-medium text-fg">
                    {p.name}
                    {p.isDefault && <Badge tone="primary">{t('common.default')}</Badge>}
                  </div>
                  {p.description && <div className="truncate text-xs text-fg-3">{p.description}</div>}
                </div>
              ),
            },
            { key: 'driver', header: t('nodeForm.driver'), cell: (p) => <Badge>{p.driver}</Badge> },
            { key: 'purpose', header: t('pools.purpose'), cell: (p) => <span className="text-xs text-fg-2">{p.usage === 'data' ? t('pools.usageDataShort') : t('pools.usageRootShort')}</span> },
            { key: 'status', header: t('common.status'), cell: (p) => <span className="text-xs text-fg-2">{p.status}</span> },
            { key: 'source', header: t('nodeForm.source'), cell: (p) => <span className="font-mono text-xs break-all text-fg-2">{p.source ?? '—'}</span> },
            {
              key: 'usage',
              header: t('pools.usage'),
              mobile: 'full',
              cell: (p) =>
                p.space ? (
                  <UsageMeter className="w-48 max-w-full" label="" value={p.space.used} max={p.space.total} valueText={`${formatBytes(p.space.used)} / ${formatBytes(p.space.total)}`} />
                ) : (
                  <span className="text-fg-3">—</span>
                ),
            },
            { key: 'used', header: t('pools.usedBy'), cell: (p) => <span className="tabular">{p.usedBy}</span> },
            {
              key: 'actions',
              header: '',
              className: 'w-24',
              cell: (p) => (
                <div className="flex justify-end gap-1">
                  {!p.isDefault && p.usage === 'root' && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('common.setDefault')}
                      title={t('common.setDefault')}
                      loading={setDefault.isPending && setDefault.variables === p.name}
                      onClick={async () => {
                        // 确认后再设为默认：影响之后新开实例的系统盘位置
                        const current = q.data?.find((x) => x.isDefault)?.name ?? '—';
                        if (await confirm({ title: t('pools.defaultTitle', { name: p.name }), description: t('pools.defaultDesc', { name: p.name, current }), confirmText: t('common.setDefault') }))
                          setDefault.mutate(p.name);
                      }}
                    >
                      <Star />
                    </Button>
                  )}
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={t('common.delete')}
                    disabled={p.isDefault || p.usedBy > 0}
                    onClick={async () => {
                      if (await confirm({ title: t('pools.deleteTitle', { name: p.name }), description: t('pools.deleteDesc'), danger: true, requireText: p.name })) remove.mutate(p.name);
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      {creating && <CreatePoolDialog node={node} onClose={() => setCreating(false)} />}
    </Card>
  );
}


/** 站点列表的一行：域名 + 状态 + 协议，下方为来源说明 */
function SiteRow({ domain, status, https, detail, error }: { domain: string; status: SiteStatus; https: boolean; detail: ReactNode; error?: string | null }) {
  return (
    <li className="rounded-lg border border-line bg-surface-2/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] break-all text-fg">{domain}</span>
        <SiteStatusBadge status={status} />
        <Badge tone={https ? 'primary' : 'neutral'}>{https ? 'HTTPS' : 'HTTP'}</Badge>
      </div>
      <div className="mt-1 text-xs text-fg-3">{detail}</div>
      {error && <div className="mt-1 text-xs text-danger-text">{error}</div>}
    </li>
  );
}

function CaddyTab({ node }: { node: NodeDTO }) {
  const t = useT();
  const invalidate = useNodeInvalidate(node.id);
  const [installOpen, setInstallOpen] = useState(false);
  const [addingSite, setAddingSite] = useState(false);
  const proxies = useQuery({ queryKey: ['proxy-sites', node.id], queryFn: () => api.get<ProxySiteDTO[]>('/admin/proxy-sites', { nodeId: node.id }) });
  // 这台宿主机上实例绑定的网站（管理端接口分页，单页取 200 条）
  const bindings = useQuery({ queryKey: ['site-bindings', 'node', node.id], queryFn: () => api.get<Paginated<AdminSiteBindingDTO>>('/admin/site-bindings', { nodeId: node.id, pageSize: 200 }) });
  const nodeBindings = bindings.data?.items ?? [];
  const gen = useMutation({
    mutationFn: (regenerate: boolean) => api.post<InstallCommandDTO>(`/admin/nodes/${node.id}/caddy/install-command`, { regenerate }),
    onSuccess: invalidate,
    onError: (e) => toast.fromError(e),
  });
  const test = useMutation({
    mutationFn: () => api.post(`/admin/nodes/${node.id}/caddy/test`),
    onSuccess: () => {
      toast.success(t('caddy.testOk'));
      invalidate();
    },
    onError: (e) => {
      toast.fromError(e, t('caddy.testFailed'));
      invalidate();
    },
  });
  const sync = useMutation({
    mutationFn: () => api.post(`/admin/nodes/${node.id}/caddy/sync`),
    onSuccess: () => {
      toast.success(t('caddy.synced'));
      void proxies.refetch();
      void bindings.refetch();
    },
    onError: (e) => toast.fromError(e, t('caddy.syncFailed')),
  });
  const ready = node.caddyStatus === 'READY';
  const total = (proxies.data?.length ?? 0) + nodeBindings.length;
  const info = [
    { label: t('caddy.adminPort'), value: node.caddyAdminPort },
    { label: t('caddy.version'), value: node.caddyVersion ?? '—' },
    { label: t('nodeForm.publicIp'), value: node.publicIp || '—' },
    { label: t('caddy.siteCount'), value: total },
  ];
  return (
    <div className="space-y-6">
      <Card>
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-[15px] font-semibold text-fg">{t('caddy.title')}</h3>
              <p className="mt-1 text-[13px] text-fg-3">{t('caddy.desc')}</p>
            </div>
            <CaddyStatusBadge status={node.caddyStatus} />
          </div>
          {node.status === 'PENDING' && <Alert tone="warning">{t('caddy.needNode')}</Alert>}
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {info.map((it) => (
              <div key={it.label}>
                <dt className="text-xs text-fg-3">{it.label}</dt>
                <dd className="mt-0.5 font-mono text-[13px] text-fg">{it.value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-fg-3">{t('caddy.authLine')}</p>
          {node.caddyError && <Alert tone="danger">{node.caddyError}</Alert>}
          <div className="-mx-2 flex flex-wrap gap-1 border-t border-line pt-3">
            <Button variant="ghost" size="sm" icon={<Plug />} loading={test.isPending} disabled={node.status === 'PENDING'} onClick={() => test.mutate()}>
              {t('caddy.test')}
            </Button>
            <Button variant="ghost" size="sm" icon={<Terminal />} 
              disabled={node.status === 'PENDING' || gen.isPending}
              onClick={() => {
                setInstallOpen(true);
                gen.mutate(false);
              }}
            >
              {node.caddyStatus === 'NONE' ? t('caddy.generate') : t('caddy.showInstall')}
            </Button>
            <Button variant="ghost" size="sm" icon={<RefreshCw />} loading={sync.isPending} disabled={!ready} onClick={() => sync.mutate()}>
              {t('caddy.sync')}
            </Button>
          </div>
        </div>
      </Card>
      <Modal
        open={installOpen}
        onOpenChange={setInstallOpen}
        size="lg"
        title={t('caddy.installTitle')}
        description={t('caddy.installDesc')}
        footer={
          <>
            {(!gen.data || gen.data.scriptUrl) && (
              <Button icon={<RefreshCw />} loading={gen.isPending} onClick={() => gen.mutate(true)}>
                {t('nodeDetail.regenerate')}
              </Button>
            )}
            <Button onClick={() => setInstallOpen(false)}>{t('common.close')}</Button>
          </>
        }
      >
        {gen.isPending ? <Skeleton className="h-24 w-full" /> : gen.error ? <Alert tone="danger">{errorText(gen.error)}</Alert> : gen.data ? <InstallCommandPanel install={gen.data} /> : null}
      </Modal>
      {addingSite && <SiteDialog nodes={[node]} defaultNode={node.id} onClose={() => setAddingSite(false)} />}

      <Card>
        <div className="space-y-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-[15px] font-semibold text-fg">{t('caddy.siteList')}</h3>
            <div className="flex items-center gap-3">
              <span className="text-[13px] text-fg-3">{t('caddy.siteTotal', { n: total })}</span>
              <Button size="sm" icon={<Plus />} onClick={() => setAddingSite(true)}>
                {t('sitesAdmin.add')}
              </Button>
            </div>
          </div>
          {proxies.isLoading || bindings.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : total === 0 ? (
            <Empty title={t('sitesAdmin.empty')} icon={<Globe />} />
          ) : (
            <ul className="space-y-2">
              {nodeBindings.map((b) => (
                <SiteRow
                  key={`b${b.id}`}
                  domain={b.domain}
                  status={b.status}
                  https={b.https}
                  error={b.lastError}
                  detail={t('caddy.bindingDetail', { instance: b.instance.hostname, port: b.targetPort })}
                />
              ))}
              {(proxies.data ?? []).map((s) => (
                <SiteRow
                  key={`p${s.id}`}
                  domain={s.domain}
                  status={s.status}
                  https={s.https}
                  error={s.lastError}
                  detail={t('caddy.proxyDetail', { upstream: s.upstream, remark: s.remark ? ` · ${s.remark}` : '' })}
                />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function IpTab({ node }: { node: NodeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState('');
  const [prefix, setPrefix] = useState('32');
  const [gateway, setGateway] = useState('');
  const [error, setError] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['node-ips', node.id], queryFn: () => api.get<IpAddressDTO[]>(`/admin/nodes/${node.id}/ips`) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['node-ips', node.id] });
    void qc.invalidateQueries({ queryKey: ['admin-node', node.id] });
  };
  const add = useMutation({
    mutationFn: () => api.post<{ added: number; skipped: number }>(`/admin/nodes/${node.id}/ips`, { input, prefix: Number(prefix), gateway }),
    onSuccess: (r) => {
      toast.success(t('ips.added', { n: r.added }), r.skipped ? t('ips.skipped', { n: r.skipped }) : undefined);
      setAdding(false);
      setInput('');
      refresh();
    },
    onError: (e) => setError(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (ip: IpAddressDTO) => api.patch(`/admin/ips/${ip.id}`, { disabled: !ip.disabled }),
    onSuccess: refresh,
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/ips/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.fromError(e),
  });
  const bridged = node.publicNicMode === 'BRIDGED';

  return (
    <Card>
      <CardHeader
        title={t('ips.title')}
        icon={<Network />}
        description={t('ips.desc', { used: node.ipStats.used, total: node.ipStats.total, mode: bridged ? t('ips.modeBridged') : t('ips.modeRouted') })}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus />}
            onClick={() => {
              setError(null);
              setAdding(true);
            }}
          >
            {t('ips.add')}
          </Button>
        }
      />
      <DataTable
        rows={q.data}
        loading={q.isLoading}
        rowKey={(ip) => ip.id}
        empty={<Empty title={t('ips.empty')} description={t('ips.emptyDesc')} icon={<Network />} />}
        columns={[
          {
            key: 'addr',
            header: t('ips.address'),
            cell: (ip) => (
              <span className="font-mono text-xs text-fg">
                {ip.address}/{ip.prefix}
              </span>
            ),
          },
          { key: 'gw', header: t('ips.gateway'), cell: (ip) => <span className="font-mono text-xs text-fg-2">{ip.gateway ?? (bridged ? t('common.notSet') : '169.254.0.1')}</span> },
          {
            key: 'inst',
            header: t('ips.usedBy'),
            cell: (ip) =>
              ip.instance ? (
                <Link className="font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg" to={`/admin/instances/${ip.instance.id}`}>
                  {ip.instance.hostname}
                </Link>
              ) : (
                <span className="text-fg-3">{t('common.free')}</span>
              ),
          },
          { key: 'enabled', header: t('ips.assignable'), cell: (ip) => <Switch checked={!ip.disabled} onCheckedChange={() => toggle.mutate(ip)} /> },
          { key: 'remark', header: t('common.remark'), cell: (ip) => <span className="text-xs text-fg-2">{ip.remark || '—'}</span> },
          {
            key: 'actions',
            header: '',
            className: 'w-12',
            cell: (ip) =>
              !ip.instance && (
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  aria-label={t('common.delete')}
                  onClick={async () => {
                    if (await confirm({ title: t('ips.deleteTitle', { ip: ip.address }), danger: true })) remove.mutate(ip.id);
                  }}
                >
                  <Trash />
                </Button>
              ),
          },
        ]}
      />
      <Modal
        open={adding}
        onOpenChange={setAdding}
        title={t('ips.addTitle')}
        footer={
          <>
            <Button onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={add.isPending} disabled={!input.trim()} onClick={() => add.mutate()}>
              {t('common.add')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label={t('ips.address')} description={t('ips.inputHint')}>
            <Textarea rows={4} className="font-mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} />
          </FormField>
          {bridged && (
            <div className="grid grid-cols-2 gap-4">
              <FormField label={t('ips.prefix')}>
                <Input type="number" min={1} max={32} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </FormField>
              <FormField label={t('ips.gateway')}>
                <Input value={gateway} onChange={(e) => setGateway(e.target.value)} className="font-mono text-xs" />
              </FormField>
            </div>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Modal>
    </Card>
  );
}

export default function AdminNodeDetail() {
  const { t } = useI18n();
  const id = Number(useParams().id);
  // 当前标签保存在地址栏（?tab=edit），刷新或从旧的编辑页跳转过来时保持
  const [params, setParams] = useSearchParams();
  const tabParam = params.get('tab') as Tab | null;
  const setTab = (next: Tab) => setParams(next === 'overview' ? {} : { tab: next }, { replace: true });
  const q = useQuery({
    queryKey: ['admin-node', id],
    queryFn: () => api.get<NodeDTO>(`/admin/nodes/${id}`),
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' || query.state.data?.caddyStatus === 'PENDING' ? 3000 : 30_000),
  });
  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const node = q.data;
  // 未开启独立 IPv4 且没有地址池时不显示独立 IP 页
  const showIps = isPublicIpv4Mode(node.networkMode) || node.ipStats.total > 0;
  const tab: Tab = tabParam && TABS.includes(tabParam) && (tabParam !== 'ips' || showIps) && (tabParam !== 'create' || node.status !== 'PENDING') ? tabParam : 'overview';
  return (
    <>
      <PageHeader
        back={{ to: '/admin/nodes', label: t('nav.admin.nodes') }}
        title={node.name}
        meta={<NodeStatusBadge status={node.status} />}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-1 text-xs text-fg-3">
            <CountryLabel code={node.country} fallback={node.region} />
            {node.description && <span> · {node.description}</span>}
            {node.publicIp && <span className="font-mono"> · {node.publicIp}</span>}
            {node.incusVersion && <span> · Incus {node.incusVersion}</span>}
            {node.arch && <span className="font-mono"> · {node.arch}</span>}
          </span>
        }
        actions={
          <>
            {/* 待安装的宿主机在概览中按步骤安装，不显示这两个按钮 */}
            {node.status !== 'PENDING' && <TestConnectButton node={node} />}
            {node.status !== 'PENDING' && <ReinstallButton key={node.id} node={node} />}
          </>
        }
      />
      <TabBar<Tab>
        value={tab}
        onChange={setTab}
        className="mb-6"
        items={[
          { value: 'overview', label: t('detail.tab.overview') },
          { value: 'edit', label: t('nodeDetail.edit') },
          { value: 'instances', label: t('nodeDetail.tabInstances'), count: node.instanceCount },
          { value: 'pools', label: t('pools.title') },
          { value: 'ops', label: t('nodeDetail.tabOps') },
          { value: 'images', label: t('nodeDetail.tabImages') },
          { value: 'caddy', label: 'Caddy' },
          { value: 'egress', label: t('egress.tab') },
          ...(showIps ? [{ value: 'ips' as const, label: t('ips.title') }] : []),
          // 创建实例放在最右边
          ...(node.status !== 'PENDING' ? [{ value: 'create' as const, label: t('nodeDetail.tabCreate') }] : []),
        ]}
      />
      {tab === 'overview' && <OverviewTab key={node.id} node={node} />}
      {tab === 'instances' && <InstanceTable nodeId={node.id} />}
      {tab === 'create' && <InstanceCreateForm key={node.id} fixedNodeId={node.id} cancelTo={`/admin/nodes/${node.id}?tab=instances`} />}
      {tab === 'ops' && <NodeOpsTab node={node} />}
      {/* 以 imageIds 为 key：保存后用新的数据重新初始化 */}
      {tab === 'images' && <NodeImagesTab key={JSON.stringify(node.imageIds)} node={node} />}
      {tab === 'pools' && <PoolsTab node={node} />}
      {tab === 'caddy' && <CaddyTab key={node.id} node={node} />}
      {tab === 'egress' && <NodeEgressTab node={node} />}
      {tab === 'ips' && <IpTab node={node} />}
      {/* 以节点 id 为 key：切换到其他宿主机时重新以其数据初始化表单 */}
      {tab === 'edit' && <NodeSettings key={node.id} node={node} />}
    </>
  );
}

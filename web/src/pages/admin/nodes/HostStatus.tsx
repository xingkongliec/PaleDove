// 宿主机状态：由宿主机 Agent（agent，Go）每 10 秒上报的实时资源与运行状态，以及 Agent 的安装 / 重装
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { compareHostAgentReleases, HOST_AGENT_VERSION, type AgentVersionCheckDTO, type HostReportDTO, type NodeDTO, type NodeResourcesDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { Alert, Badge, Card, CodeBlock, Empty, Skeleton } from '@/components/ui/misc';
import { useT, type TFunction } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';
import { AdminNodeTestButton } from '@/components/ping/NodeTestButton';

/** 运行时长：天 + 小时，不足一天时显示小时 + 分钟 */
export function formatUptime(sec: number, t: TFunction): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return d > 0 ? t('nodeDetail.uptimeDays', { d, h }) : t('nodeDetail.uptimeHours', { h, m: Math.floor((sec % 3600) / 60) });
}

/** 安装（或重装 / 升级）宿主机 Agent：弹窗显示在宿主机上执行的命令 */
export function AgentInstallButton({ node, label, variant }: { node: NodeDTO; label: string; variant?: 'primary' | 'secondary' }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const gen = useMutation({
    mutationFn: () => api.post<{ command: string; expiresAt: string }>(`/admin/nodes/${node.id}/agent-command`),
    onError: (e) => toast.fromError(e),
  });
  return (
    <>
      <Button
        size="sm"
        variant={variant}
        icon={<Download />}
        disabled={gen.isPending}
        onClick={() => {
          setOpen(true);
          gen.mutate();
        }}
      >
        {label}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title={t('nodeDetail.agentTitle')}
        description={t('nodeDetail.agentDesc')}
        footer={
          <>
            {/* 每次生成都签发新的一次性令牌 */}
            <Button icon={<RefreshCw />} loading={gen.isPending} onClick={() => gen.mutate()}>
              {t('nodeDetail.agentRegenerate')}
            </Button>
            <Button onClick={() => setOpen(false)}>{t('common.close')}</Button>
          </>
        }
      >
        <div className="space-y-3">
          {gen.isPending ? <Skeleton className="h-12 w-full" /> : gen.error ? <Alert tone="danger">{errorText(gen.error)}</Alert> : gen.data ? (
            <>
              <CodeBlock value={gen.data.command} />
              <p className="text-xs text-warning-text">{t('nodeDetail.agentExpires', { time: formatDate(gen.data.expiresAt) })}</p>
            </>
          ) : null}
          <p className="text-xs text-fg-3">{t('nodeDetail.agentNote')}</p>
        </div>
      </Modal>
    </>
  );
}

type MetricColor = 'cpu' | 'mem' | 'swap' | 'disk';
const BAR: Record<MetricColor, string> = { cpu: 'bg-metric-cpu', mem: 'bg-metric-mem', swap: 'bg-metric-swap', disk: 'bg-metric-disk' };

/** 带占用条的指标块：标题与说明在左、百分比在右；各指标用自己的颜色，超过 75% 黄色、90% 红色 */
function Metric({ label, sub, value, pct, color }: { label: string; sub?: ReactNode; value: ReactNode; pct: number | null; color: MetricColor }) {
  const bar = pct === null ? BAR[color] : pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warning' : BAR[color];
  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-line px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] text-fg">{label}</div>
          {sub && <div className="tabular mt-0.5 truncate text-xs text-fg-3">{sub}</div>}
        </div>
        <div className="tabular shrink-0 text-lg leading-6 font-semibold text-fg">{value}</div>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={cn('h-full origin-left rounded-full transition-transform duration-700 ease-smooth', bar)} style={{ transform: `scaleX(${Math.min(100, pct ?? 0) / 100})` }} />
      </div>
    </div>
  );
}

/** 数值指标块（负载、进程数）：标题、大号数值、说明上下排列 */
function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-line px-4 py-3.5">
      <div className="text-[13px] text-fg">{label}</div>
      <div className="tabular text-lg leading-6 font-semibold text-fg">{value}</div>
      {sub && <div className="text-xs text-fg-3">{sub}</div>}
    </div>
  );
}

/** 状态行里的圆角胶囊标签 */
const PILL = 'inline-flex h-6 items-center rounded-full border px-2.5 text-xs whitespace-nowrap';

const pctOf = (u?: { total: number; used: number }) => (u && u.total > 0 ? (u.used / u.total) * 100 : null);
const pctText = (p: number | null) => (p === null ? '—' : `${p.toFixed(1)}%`);

/** 右上角的一行信息：标签 + 值 */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-xs">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className="min-w-0 truncate text-fg-2">{children}</span>
    </div>
  );
}

/**
 * 宿主机状态卡片：在线状态、Agent 版本与功能、Incus 检测、心跳信息，以及 CPU / 内存 / SWAP / 磁盘 / 负载 / 进程数。
 * 旧版 bash 上报程序只有 CPU、负载与运行时长，其他指标提示升级。
 */
export function HostStatusCard({ node, res }: { node: NodeDTO; res: UseQueryResult<NodeResourcesDTO> }) {
  const t = useT();
  const qc = useQueryClient();
  const checkVersion = useMutation({
    mutationKey: ['agent-version-check'],
    mutationFn: () => api.post<AgentVersionCheckDTO>('/admin/agent/check-update'),
    onSuccess: async result => {
      await qc.cancelQueries({ queryKey: ['node-resources'] });
      qc.setQueriesData<NodeResourcesDTO>({ queryKey: ['node-resources'] }, current => current ? { ...current, agentLatestVersion: result.version } : current);
      toast.success(t(result.source === 'github' ? 'nodeDetail.host.versionChecked' : 'nodeDetail.host.localVersionChecked', { version: result.version }));
    },
    onError: error => toast.fromError(error),
  });
  const r = res.data;
  const host: HostReportDTO | null = r?.host ?? null;
  const installed = !!r?.agentInstalled;
  const legacy = !!host && host.version < HOST_AGENT_VERSION;
  const latest = r?.agentLatestVersion;
  const outdated = !!host && (legacy || (!!latest && !!host.release && compareHostAgentReleases(latest, host.release) === 1));
  // 服务端按 max(3 × 上报间隔, 60 秒) 判断在线；离线时仍保留最后一次上报（7 天）
  const status = !installed && !host ? 'none' : host?.online ? 'online' : 'offline';
  const memPct = pctOf(host?.memory);
  const swapPct = pctOf(host?.swap);
  const diskPct = pctOf(host?.disk);
  const na = t('nodeDetail.host.needUpgrade');

  return (
    <Card>
      {/* 下方没有内容（安装了但还没有上报）时不显示分隔线 */}
      <div className={cn('flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5', (!r || status === 'none' || host) && 'border-b border-line')}>
        <div className="min-w-0">
          {/* 在线 / 离线状态跟在标题后面 */}
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold text-fg">{t('nodeDetail.host.title')}</h3>
            {r && status !== 'none' && (
              <Badge tone={status === 'online' ? 'success' : 'neutral'} dot>
                {t(status === 'online' ? 'nodeDetail.host.online' : 'nodeDetail.host.offline')}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-fg-3">{t('nodeDetail.host.desc')}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {r && (
            <AgentInstallButton
              node={node}
              label={!installed ? t('nodeDetail.agentInstall') : outdated ? t('nodeDetail.agentUpgrade') : t('nodeDetail.agentReinstall')}
            />
          )}
          {/* 节点测试（宿主机设置中启用后） */}
          {node.pingEnabled && <AdminNodeTestButton nodeId={node.id} nodeName={node.name} />}
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={res.isFetching} onClick={() => void res.refetch()}>
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {!r ? (
        <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : status === 'none' ? (
        <Empty title={t('nodeDetail.host.emptyTitle')} description={t('nodeDetail.host.emptyDesc')} />
      ) : !host ? null : (
        <div className="space-y-4 p-4 sm:p-5">
          {/* 状态行：版本、功能；右侧为 Incus 检测与心跳信息（还没有上报时整块不显示） */}
          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 border-b border-line pb-4">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <button
                type="button"
                title={t('nodeDetail.host.checkVersion')}
                aria-label={t('nodeDetail.host.checkVersion')}
                aria-busy={checkVersion.isPending}
                disabled={checkVersion.isPending}
                onClick={() => checkVersion.mutate()}
                className={cn(PILL, 'gap-1.5 font-mono transition-[color,background-color,box-shadow] hover:brightness-95 active:scale-[0.97] focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-wait disabled:opacity-70', outdated ? 'border-warning-icon/40 bg-warning-soft text-warning-text' : 'border-success/40 bg-success-soft text-success-text')}
              >
                {checkVersion.isPending && <RefreshCw aria-hidden className="size-3 animate-spin" />}
                {checkVersion.isPending ? t('nodeDetail.host.checkingVersion') : legacy ? t('nodeDetail.host.legacy') : <>
                  v{host.release} {outdated && latest ? t('nodeDetail.host.outdated', { version: latest }) : latest && compareHostAgentReleases(latest, host.release ?? '') === 0 ? t('nodeDetail.host.latest') : ''}
                </>}
              </button>
              {host?.capabilities?.map((c) => (
                <span key={c} className={cn(PILL, 'border-transparent bg-info-soft text-info-text')}>
                  {c}
                </span>
              ))}
            </div>
            {host && (
              <div className="grid min-w-0 grid-flow-col grid-rows-2 gap-x-8 gap-y-1">
                <Fact label={t('nodeDetail.host.incus')}>
                  {host.incus ? (
                    <>
                      <span className={host.incus.available ? 'text-success-text' : 'text-danger-text'}>{t(host.incus.available ? 'nodeDetail.host.incusOk' : 'nodeDetail.host.incusBad')}</span>
                      {host.incus.version && ` ${host.incus.version}`}
                      {host.incus.socket && <span className="ml-1.5 font-mono text-fg-3">{host.incus.socket}</span>}
                    </>
                  ) : (
                    '—'
                  )}
                </Fact>
                <Fact label={t('nodeDetail.host.ip')}>
                  <span className="font-mono">{host.ip ?? '—'}</span>
                </Fact>
                <Fact label={t('nodeDetail.host.lastSeen')}>{formatDate(host.reportedAt, 'YYYY/MM/DD HH:mm:ss')}</Fact>
                <Fact label={t('nodeDetail.host.uptime')}>{formatUptime(host.uptime, t)}</Fact>
              </div>
            )}
          </div>

          {(
            host && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Metric color="cpu" label={t('nodeDetail.host.cpu')} sub={host.cores ? t('nodeDetail.host.cores', { n: host.cores }) : undefined} value={`${host.cpu.toFixed(1)}%`} pct={host.cpu} />
                <Metric
                  color="mem"
                  label={t('nodeDetail.host.memory')}
                  sub={host.memory ? `${formatBytes(host.memory.used)} / ${formatBytes(host.memory.total)}` : na}
                  value={pctText(memPct)}
                  pct={memPct}
                />
                <Metric
                  color="swap"
                  label={t('nodeDetail.host.swap')}
                  sub={host.swap ? (host.swap.total ? `${formatBytes(host.swap.used)} / ${formatBytes(host.swap.total)}` : t('nodeDetail.host.swapOff')) : na}
                  value={pctText(swapPct)}
                  pct={swapPct}
                />
                <Metric
                  color="disk"
                  label={t('nodeDetail.host.disk', { path: host.disk?.path ?? '/' })}
                  sub={host.disk ? `${formatBytes(host.disk.used)} / ${formatBytes(host.disk.total)}` : na}
                  value={pctText(diskPct)}
                  pct={diskPct}
                />
                <Stat label={t('nodeDetail.host.load')} value={host.load.map((v) => v.toFixed(2)).join(' / ')} sub={t('nodeDetail.host.loadSub')} />
                <Stat label={t('nodeDetail.host.processes')} value={host.processes ?? '—'} sub={host.processes === undefined ? na : undefined} />
              </div>
            )
          )}
        </div>
      )}
    </Card>
  );
}

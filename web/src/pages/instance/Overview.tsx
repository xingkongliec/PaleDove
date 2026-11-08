import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowDownUp, Cpu, HardDrive, Megaphone, MemoryStick, Network } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { isNatType, type CredentialsDTO, type InstanceStateDTO, type InvoiceDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { useConfirm } from '@/components/ui/confirm';
import { isBusy, useInstanceApiPath, useInvalidateInstance, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { copyText, daysLeft, daysLeftText, formatBandwidth, formatBytes, formatCores, formatDate, formatMemory, formatMoney, formatRate, formatTraffic } from '@/lib/format';
import { useCurrency, useMe, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { TransferDialog } from './TransferDialog';

/** 卡片标题（incudal：text-sm 中等字重，下方留 1rem） */
function CardTitle({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-medium text-fg-2">{title}</h2>
      {extra && <div className="flex min-w-0 items-center gap-2 text-xs text-fg-3">{extra}</div>}
    </div>
  );
}

/** 胶囊标签（incudal 订阅卡片顶部的标签） */
function Chip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap', className)}>{children}</span>;
}

/** 小方角标签（实例模式等） */
function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded bg-surface-3 px-1.5 py-0.5 text-xs whitespace-nowrap text-fg-2">{children}</span>;
}

// ───────────── 订阅 ─────────────

/** 订阅卡片：套餐、续费价格、到期与自动续费，以及续费 / 转移 / 出售 / 删除 */
function SubscriptionCard({ inst, admin, onRenew }: { inst: AnyInstance; admin?: boolean; onRenew: () => void }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t, L } = useI18n();
  const currency = useCurrency();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const invalidate = useInvalidateInstance(inst.id);
  const { data: cfg } = usePublicConfig();
  const [transferOpen, setTransferOpen] = useState(false);
  const left = daysLeft(inst.expiresAt);
  const deleted = inst.status === 'DELETED' || inst.status === 'DELETING';
  const listed = !!inst.marketListing;
  const autoRenew = useMutation({
    mutationFn: (v: boolean) => api.patch(instancePath, { autoRenew: v }),
    onSuccess: (_, v) => {
      toast.success(v ? t('settings.autoRenewOnDone') : t('settings.autoRenewOffDone'));
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(instancePath, { confirm: inst.hostname }),
    onSuccess: () => {
      toast.success(t('settings.deleteSubmitted'), t('settings.deleteSubmittedDesc'));
      invalidate();
      navigate('/console/instances');
    },
    onError: (e) => toast.fromError(e),
  });
  const toggleAutoRenew = async () => {
    const v = !inst.autoRenew;
    const ok = await confirm(
      v
        ? {
            title: t('settings.autoRenewOnTitle'),
            description: t('settings.autoRenewOnDesc', { amount: formatMoney(inst.renewPrice, currency), cycle: L.billingCycle[inst.billingCycle] }),
            confirmText: t('settings.autoRenewOnConfirm'),
          }
        : { title: t('settings.autoRenewOffTitle'), description: t('settings.autoRenewOffDesc'), confirmText: t('settings.autoRenewOffConfirm') },
    );
    if (ok) autoRenew.mutate(v);
  };
  const askDelete = async () => {
    const ok = await confirm({
      title: t('settings.deleteConfirm', { name: inst.hostname }),
      description: t('settings.deleteConfirmDesc'),
      danger: true,
      confirmText: t('settings.deleteForever'),
      requireText: inst.hostname,
    });
    if (ok) remove.mutate();
  };
  const stats: { label: string; value: ReactNode }[] = [
    { label: t('overview.expiryDate'), value: formatDate(inst.expiresAt, 'YYYY-MM-DD') },
    {
      label: t('overview.remaining'),
      value: <span className={cn(left <= 0 ? 'text-danger-text' : left <= 7 && 'text-warning-text')}>{left > 0 ? t('overview.days', { n: left }) : daysLeftText(inst.expiresAt)}</span>,
    },
    { label: t('overview.cycle'), value: L.billingCycle[inst.billingCycle] },
    { label: t('settings.autoRenew'), value: <span className={inst.autoRenew ? 'text-success-text' : undefined}>{inst.autoRenew ? t('overview.autoRenewOn') : t('overview.autoRenewOff')}</span> },
  ];
  const remainingTone = left <= 0 ? 'bg-danger-soft text-danger-text' : left <= 7 ? 'bg-warning-soft text-warning-text' : 'bg-success-soft text-success-text';
  const btn = 'h-7 w-full justify-center rounded-lg px-3 text-xs sm:w-auto sm:min-w-[110px]';
  return (
    <Card className="p-4 shadow-xs sm:p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Chip className="border border-line bg-surface-2 text-fg-2">{L.instanceType[inst.type]}</Chip>
              <Chip className={remainingTone}>{daysLeftText(inst.expiresAt)}</Chip>
              <Chip className={inst.autoRenew ? 'bg-success-soft text-success-text' : 'bg-surface-3 text-fg-2'}>{inst.autoRenew ? t('overview.autoRenewOn') : t('overview.autoRenewOff')}</Chip>
            </div>
            <div className="mt-4 min-w-0">
              <h3 className="truncate text-lg font-semibold text-fg sm:text-xl">{inst.plan?.name ?? `${formatCores(inst.cpu)} · ${formatMemory(inst.memory)}`}</h3>
              <p className="mt-1 truncate text-sm text-fg-2">{inst.region}</p>
            </div>
          </div>
          {/* 续费价格 */}
          <div className="rounded-xl border border-line bg-surface-2/80 px-4 py-3 lg:min-w-[220px]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] text-fg-3">{t('overview.renewPrice')}</div>
                <div className="mt-1.5 flex items-end gap-1.5">
                  <span className="tabular text-3xl leading-none font-semibold text-fg">{formatMoney(inst.renewPrice, currency)}</span>
                  <span className="pb-0.5 text-xs text-fg-3">/ {L.billingCycle[inst.billingCycle]}</span>
                </div>
              </div>
              {inst.renewCoupon && <Chip className="shrink-0 bg-success-soft font-mono text-success-text">{inst.renewCoupon.code}</Chip>}
            </div>
          </div>
        </div>

        {/* 到期时间、剩余、计费周期、自动续费 */}
        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
          {stats.map((st) => (
            <div key={st.label} className="min-h-[84px] min-w-0 rounded-xl border border-line bg-surface-2/80 p-3">
              <div className="truncate text-[11px] text-fg-3">{st.label}</div>
              <div className="tabular mt-1.5 truncate text-sm font-medium text-fg">{st.value}</div>
            </div>
          ))}
        </div>

        {!admin && !deleted && (
          <div className="border-t border-line pt-4">
            <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
              <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <Button className={btn} onClick={onRenew}>
                  {t('settings.renew')}
                </Button>
                <Button className={btn} loading={autoRenew.isPending} onClick={() => void toggleAutoRenew()}>
                  {inst.autoRenew ? t('overview.autoRenewDisable') : t('overview.autoRenewEnable')}
                </Button>
                <Button className={btn} disabled={isBusy(inst) || listed} onClick={() => setTransferOpen(true)}>
                  {t('transfer.open')}
                </Button>
                {cfg?.marketEnabled && (
                  <Button className={btn} disabled={isBusy(inst)} onClick={() => navigate(listed ? '/console/marketplace/mine' : `/console/marketplace/mine?sell=${inst.id}`)}>
                    {listed ? t('market.manageListing') : t('overview.sell')}
                  </Button>
                )}
              </div>
              <Button
                variant="danger-ghost"
                className="h-7 w-full rounded-lg border-danger/20 bg-danger-soft px-3 text-xs hover:not-disabled:bg-danger-soft hover:not-disabled:opacity-80 lg:w-auto lg:min-w-[110px]"
                loading={remove.isPending}
                disabled={listed}
                onClick={() => void askDelete()}
              >
                {t('overview.destroy')}
              </Button>
            </div>
          </div>
        )}
      </div>
      {!admin && <TransferDialog inst={inst} open={transferOpen} onClose={() => setTransferOpen(false)} />}
    </Card>
  );
}

// ───────────── 基本信息 ─────────────

/** 文字按钮（incudal 的「显示 / 复制」） */
function TextButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 text-xs text-info-text transition-opacity hover:opacity-75">
      {children}
    </button>
  );
}

/** 复制并提示 */
function useCopy() {
  const { t } = useI18n();
  return async (v: string) => {
    if (await copyText(v)) toast.success(t('common.copied'));
  };
}

/** 信息行：左侧标签，右侧数值（等宽字体，可带「复制」） */
function InfoRow({ label, value, copy, mono = true, children }: { label: string; value?: string | null; copy?: boolean; mono?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  const doCopy = useCopy();
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-2 text-right text-fg-2">
        {children ??
          (value ? (
            <>
              <span className={cn('min-w-0 truncate', mono && 'font-mono')} translate="no">
                {value}
              </span>
              {copy && <TextButton onClick={() => void doCopy(value)}>{t('common.copy')}</TextButton>}
            </>
          ) : (
            <span className="text-fg-4">—</span>
          ))}
      </dd>
    </div>
  );
}

function BasicsCard({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t, L } = useI18n();
  const doCopy = useCopy();
  const [reveal, setReveal] = useState(false);
  const creds = useQuery({
    queryKey: ['credentials', inst.id],
    queryFn: () => api.get<CredentialsDTO>(`${instancePath}/credentials`),
    enabled: reveal,
    staleTime: 60_000,
  });
  const nat = isNatType(inst.type);
  const password = reveal ? (creds.data?.password ?? null) : null;
  const expired = daysLeft(inst.expiresAt) <= 0;
  return (
    <Card className="px-4 py-3.5 shadow-xs sm:px-5">
      <CardTitle title={t('overview.basics')} />
      <dl className="space-y-1.5 text-[13px]">
        <InfoRow label={t('overview.instanceId')}>
          <span className="truncate font-mono text-xs text-fg-2" translate="no">
            {inst.name}
          </span>
        </InfoRow>
        <InfoRow label={t('overview.image')} mono={false} value={inst.image?.name ?? null} />
        <InfoRow label={t('overview.mode')}>
          <Tag>{L.instanceType[inst.type]}</Tag>
          {inst.ipv6Only && <Tag>IPv6 Only</Tag>}
        </InfoRow>
        {!inst.ipv6Only && <InfoRow label={t('overview.publicIpv4')} value={inst.publicIp} copy />}
        {nat && !inst.ipv6Only && <InfoRow label={t('overview.sshPort')} value={inst.sshPort ? String(inst.sshPort) : null} copy />}
        {nat && <InfoRow label={t('overview.privateIp')} value={inst.privateIp} copy />}
        {inst.vpc && <InfoRow label={t('overview.vpcIp', { name: inst.vpc.name })} value={inst.vpc.ip} copy />}
        {nat && inst.portRange && <InfoRow label={t('overview.portRange')} value={`${inst.portRange.start} – ${inst.portRange.end}`} />}
        {inst.ipv6List.map((ip, i) => (
          <InfoRow key={ip} label={i ? `IPv6 #${i + 1}` : 'IPv6'} value={ip} copy />
        ))}
        {inst.ipv6Prefixes?.map((prefix) => <InfoRow key={prefix} label={t('overview.ipv6Prefix')} value={prefix} copy />)}
        <InfoRow label={t('overview.rootPassword')}>
          <span className="font-mono">{password ?? '••••••••'}</span>
          <TextButton onClick={() => setReveal(!reveal)}>{reveal ? t('common.hide') : t('common.show')}</TextButton>
          {password && <TextButton onClick={() => void doCopy(password)}>{t('common.copy')}</TextButton>}
        </InfoRow>
        <InfoRow label={t('overview.node')}>
          <CountryFlag code={inst.country} />
          <span className="truncate uppercase">{'node' in inst ? (inst as { node: { name: string } }).node.name : inst.region}</span>
        </InfoRow>
        <InfoRow label={t('common.createdAt')}>
          <span className="tabular text-xs text-fg-2">{formatDate(inst.createdAt)}</span>
        </InfoRow>
        <InfoRow label={t('overview.expiryDate')}>
          <span className={cn('tabular text-xs', expired ? 'text-danger-text' : 'text-fg-2')}>{formatDate(inst.expiresAt)}</span>
        </InfoRow>
      </dl>
    </Card>
  );
}

// ───────────── 资源占用 ─────────────

/** 各进度条上次显示的宽度：切换标签再回来时从这里继续，不再从 0 重新增长 */
const lastWidth = new Map<string, number>();

/** 进度条（h-2）：宽度变化时平滑过渡（用 transform 缩放，不触发重排）；第一次显示从 0 开始增长 */
function Bar({ id, pct, color, hidden }: { id: string; pct: number; color: string; hidden?: boolean }) {
  const [width, setWidth] = useState(() => lastWidth.get(id) ?? 0);
  useEffect(() => {
    lastWidth.set(id, pct);
    if (width === pct) return;
    const frame = requestAnimationFrame(() => setWidth(pct));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pct]);
  return (
    <div className={cn('h-2 overflow-hidden rounded-full bg-surface-3', hidden && 'opacity-0')}>
      <div className={cn('h-full origin-left rounded-full transition-[transform,background-color] duration-500 ease-smooth', color)} style={{ transform: `scaleX(${width / 100})` }} />
    </div>
  );
}

const pctText = (p: number) => `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
/** incudal 的阈值配色：内存 / 磁盘超过 80% 红色、60% 黄色；流量 100% 红色、80% 黄色 */
const usageColor = (p: number, normal: string) => (p > 80 ? 'bg-danger' : p > 60 ? 'bg-warning' : normal);
const trafficColor = (p: number) => (p >= 100 ? 'bg-danger' : p >= 80 ? 'bg-warning' : 'bg-metric-cpu');

/** 单项资源：图标与名称（灰色），右侧数值与占比 */
function UsageRow({ icon, label, note, value, pct, children }: { icon: ReactNode; label: string; note?: ReactNode; value: ReactNode; pct?: number | null; children?: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3 text-[13px]">
        <span className="flex min-w-0 items-center gap-1 text-fg-3 [&>svg]:size-4 [&>svg]:shrink-0">
          {icon}
          <span className="truncate">{label}</span>
          {note && <span className="ml-1 truncate text-xs text-fg-4">{note}</span>}
        </span>
        <span className="tabular shrink-0 text-fg-2">
          {value}
          {pct != null && pct > 0 && <span className="ml-1 text-xs text-fg-3">({pctText(pct)})</span>}
        </span>
      </div>
      {children}
    </div>
  );
}

/** 付费重置流量：确认价格后从余额扣款，清零本周期已用流量（重置日不变）；管理员在「管理」里直接重置 */
function TrafficReset({ inst }: { inst: AnyInstance }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const reset = useMutation({
    mutationFn: () => api.post<{ invoice: InvoiceDTO }>(`/instances/${inst.id}/reset-traffic`),
    onSuccess: (r) => {
      toast.success(t('invoice.created'), r.invoice.no);
      navigate('/console/invoices');
    },
    onError: (e) => toast.fromError(e),
  });
  if (me?.role === 'ADMIN' || inst.traffic <= 0 || inst.trafficResetPrice === null) return null;
  const price = formatMoney(inst.trafficResetPrice, currency);
  return (
    <button
      type="button"
      disabled={reset.isPending}
      className="font-medium text-fg-2 underline decoration-line-strong underline-offset-2 transition-colors hover:text-fg hover:decoration-fg disabled:opacity-50"
      onClick={async () => {
        if (await confirm({ title: t('overview.trafficResetTitle'), description: t('overview.trafficResetDesc', { price, balance: formatMoney(me?.balance ?? 0, currency) }), confirmText: t('overview.trafficResetConfirm', { price }) }))
          reset.mutate();
      }}
    >
      {t('overview.trafficResetButton', { price })}
    </button>
  );
}

function UsageCard({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t, L } = useI18n();
  const available = ['RUNNING', 'STOPPED', 'SUSPENDED', 'ERROR'].includes(inst.status);
  // 刷新节奏参考 incudal：运行中每 5 秒刷新资源，停机 / 暂停时只取一次；标签页隐藏时暂停，切回来立即刷新
  const state = useQuery({
    queryKey: ['instance-state', inst.id],
    queryFn: () => api.get<InstanceStateDTO>(`${instancePath}/state`),
    enabled: available,
    refetchInterval: inst.status === 'RUNNING' ? 5000 : false,
    refetchOnWindowFocus: true,
  });
  const s = state.data;
  // 宿主机上的实际电源状态与页面不一致（例如在实例里执行了关机）：服务端已同步，立即刷新实例信息
  const invalidate = useInvalidateInstance(inst.id);
  const actualRunning = s ? s.status === 'Running' : null;
  useEffect(() => {
    if (actualRunning === null || (inst.status !== 'RUNNING' && inst.status !== 'STOPPED')) return;
    if (actualRunning !== (inst.status === 'RUNNING')) invalidate();
    // 只在实际状态或记录的状态变化时检查
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualRunning, inst.status]);
  const running = s?.status === 'Running';
  const memTotal = inst.memory * 1024 * 1024;
  const diskTotal = inst.disk * 1024 ** 3;
  const trafficTotal = inst.traffic * 1024 ** 3;
  // 本期流量随实时状态每 5 秒更新（含尚未统计入库的增量），状态还没取到时用实例数据
  const traffic = s ? { used: s.trafficUsed, rx: s.trafficIn, tx: s.trafficOut } : { used: inst.trafficUsed, rx: inst.trafficIn, tx: inst.trafficOut };
  const trafficPct = inst.traffic > 0 ? Math.min(100, (traffic.used / trafficTotal) * 100) : null;
  const disk = s?.diskUsage ?? null;
  const cpu = running ? (s?.cpuPercent ?? null) : null;
  // 实时网络速率（字节/秒）
  const rxRate = running ? (s?.netRxRate ?? null) : null;
  const txRate = running ? (s?.netTxRate ?? null) : null;
  const memPct = running && s ? Math.min(100, (s.memoryUsage / memTotal) * 100) : 0;
  const diskPct = disk !== null ? Math.min(100, (disk / diskTotal) * 100) : 0;
  return (
    <Card className="flex flex-col px-4 py-3.5 shadow-xs sm:px-5">
      <CardTitle
        title={t('overview.usage')}
        extra={
          s ? (
            <>
              <span className={cn('size-1.5 shrink-0 rounded-full', running ? 'animate-pulse bg-success' : 'bg-fg-4')} />
              {/* 宿主机 Agent 在线时由 Agent 上报，否则由面板直接查询 Incus */}
              <span title={s.source === 'agent' ? t('overview.liveAgentHint') : undefined}>{s.source === 'agent' ? t('overview.liveAgent') : t('overview.live')}</span>
            </>
          ) : available ? (
            <span className="size-3 animate-spin rounded-full border-2 border-fg-4 border-t-transparent" aria-label={t('common.loading')} />
          ) : (
            t('overview.unavailable')
          )
        }
      />
      <div className="flex flex-1 flex-col justify-between gap-3">
        <UsageRow icon={<Cpu />} label="CPU" note={formatCores(inst.cpu)} value={!running ? '—' : cpu === null ? t('overview.calculating') : pctText(cpu)}>
          <Bar id={`${inst.id}:cpu`} pct={cpu ?? 0} color={usageColor(cpu ?? 0, 'bg-metric-cpu')} />
        </UsageRow>
        <UsageRow
          icon={<MemoryStick />}
          label={t('spec.memory')}
          note={`(${t('overview.includesCache')})`}
          pct={memPct}
          value={
            <>
              {running && s ? `${formatBytes(s.memoryUsage)} / ` : ''}
              {formatMemory(inst.memory)}
            </>
          }
        >
          <Bar id={`${inst.id}:memory`} pct={memPct} color={usageColor(memPct, 'bg-metric-mem')} />
        </UsageRow>
        <UsageRow
          icon={<HardDrive />}
          label={t('spec.disk')}
          pct={diskPct}
          value={
            <>
              {disk !== null ? `${formatBytes(disk)} / ` : ''}
              {inst.disk} GB
            </>
          }
        >
          <Bar id={`${inst.id}:disk`} pct={diskPct} color={usageColor(diskPct, 'bg-metric-disk')} />
        </UsageRow>
        {/* 本期流量：周期从开通时间起按月循环 */}
        <UsageRow
          icon={<ArrowDownUp />}
          label={t('overview.trafficCycle', { mode: L.trafficMode[inst.trafficMode] })}
          value={
            <>
              {formatBytes(traffic.used)} / {inst.traffic > 0 ? formatTraffic(inst.traffic) : t('common.unlimited')}
              <span className="ml-1 text-xs text-fg-3">({(trafficPct ?? 0).toFixed(1)}%)</span>
            </>
          }
        >
          <Bar id={`${inst.id}:traffic`} pct={trafficPct ?? 0} color={trafficColor(trafficPct ?? 0)} />
          <div className="tabular mt-1.5 flex flex-wrap justify-between gap-x-4 gap-y-0.5 text-[11px] text-fg-4">
            <span>
              ↓ {formatBytes(traffic.rx)} · ↑ {formatBytes(traffic.tx)} · {t('overview.trafficPeriod', { start: formatDate(inst.trafficPeriodStart, 'MM-DD HH:mm'), end: formatDate(inst.trafficResetAt, 'MM-DD HH:mm') })}
            </span>
            {inst.traffic > 0 && (
              <span className="flex items-center gap-2">
                {inst.overLimitAction === 'THROTTLE' ? t('overview.overLimitThrottle', { rate: inst.throttleRate }) : t('overview.overLimit', { action: L.overLimitAction[inst.overLimitAction] })}
                <TrafficReset inst={inst} />
              </span>
            )}
          </div>
        </UsageRow>
        {/* 实时网络速率 */}
        <UsageRow
          icon={<Network />}
          label={t('overview.network')}
          value={!running ? '—' : rxRate === null || txRate === null ? t('overview.calculating') : `↓ ${formatRate(rxRate)}  ↑ ${formatRate(txRate)}`}
        />
        {/* 带宽限制 */}
        <div className="border-t border-line pt-2.5">
          <div className="flex justify-between gap-3 text-xs text-fg-3">
            <span className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-metric-mem" />
              {t('overview.ingressLimit')}: {formatBandwidth(inst.bandwidthIn)}
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-metric-cpu" />
              {t('overview.egressLimit')}: {formatBandwidth(inst.bandwidthOut)}
            </span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** 宿主机公告：管理员在宿主机设置中填写，显示在这台宿主机上全部实例的概览顶部 */
function HostAnnouncement({ inst }: { inst: AnyInstance }) {
  const { t } = useI18n();
  if (!inst.hostAnnouncement) return null;
  return (
    <Card className="relative overflow-hidden px-4 py-3.5 shadow-xs sm:px-5 sm:py-4">
      <div className="pointer-events-none absolute -top-8 -right-8 size-28 rounded-full bg-brand-a/10 blur-3xl" aria-hidden />
      <div className="relative flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-2 text-fg-2">
          <Megaphone className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-fg sm:text-[15px]">{t('overview.hostAnnouncement')}</h3>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[11px] font-medium tracking-wide text-fg-3">
              <CountryFlag code={inst.country} />
              {inst.region}
            </span>
          </div>
          <p className="mt-1.5 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{inst.hostAnnouncement}</p>
        </div>
      </div>
    </Card>
  );
}

/** 概览（与 incudal 一致）：宿主机公告（有时）、订阅卡片，下方基本信息与资源占用并排 */
export default function Overview({ inst, admin, onRenew }: { inst: AnyInstance; admin?: boolean; onRenew: () => void }) {
  return (
    <div className="space-y-4">
      <HostAnnouncement inst={inst} />
      <SubscriptionCard inst={inst} admin={admin} onRenew={onRenew} />
      {/* 基本信息与资源占用：md 起两列（与 incudal 一致） */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <BasicsCard inst={inst} />
        <UsageCard inst={inst} />
      </div>
    </div>
  );
}

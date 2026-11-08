import { useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ChevronRight, Disc3, Ellipsis, Play, Plus, RotateCw, ScrollText, Search, Server, Square, Store, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { isNatType, isVmType, type InstanceDTO } from '../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { AddressCell } from '@/components/resource/AddressCell';
import { InstanceStatusBadge, OsIcon } from '@/components/status';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { DropdownMenu } from '@/components/ui/menu';
import { Input } from '@/components/ui/input';
import { Card, Checkbox, Empty, ErrorState, Tag, Tooltip } from '@/components/ui/misc';
import { DataTable, type Column } from '@/components/ui/table';
import { Segmented } from '@/components/ui/tabs';
import { isBusy, useInstances, usePowerAction } from '@/hooks/instances';
import { useI18n, useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { daysLeft, daysLeftText, formatBytes, formatCores, formatDate, formatMemory, formatTraffic, percent } from '@/lib/format';
import { usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';

export function connectAddress(inst: Pick<InstanceDTO, 'publicIp' | 'sshPort' | 'ipv6' | 'ipv6Only'>): string | null {
  if (inst.ipv6Only) return inst.ipv6;
  if (!inst.publicIp) return null;
  return inst.sshPort && inst.sshPort !== 22 ? `${inst.publicIp}:${inst.sshPort}` : inst.publicIp;
}

/** 实例的公网 IP（不带端口）：仅 IPv6 的实例显示 IPv6 */
export const instanceIp = (inst: Pick<InstanceDTO, 'publicIp' | 'ipv6' | 'ipv6Only'>): string | null => (inst.ipv6Only ? inst.ipv6 : inst.publicIp);

/** 电源操作是否可用：暂停、出错、在交易市场挂牌或有进行中任务时不可操作 */
const powerBlocked = (inst: InstanceDTO) => isBusy(inst) || !!inst.marketListing || ['SUSPENDED', 'ERROR', 'CREATING', 'DELETING', 'DELETED'].includes(inst.status);

/** 行内操作：开关机、重启、更多菜单、进入详情 */
function RowActions({ inst }: { inst: InstanceDTO }) {
  const t = useT();
  const navigate = useNavigate();
  const power = usePowerAction(inst.id);
  const confirm = useConfirm();
  const { data: cfg } = usePublicConfig();
  const blocked = powerBlocked(inst) || power.isPending;
  const running = inst.status === 'RUNNING';
  const iconBtn = 'flex size-7 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg disabled:pointer-events-none disabled:opacity-35 [&>svg]:size-3.5';
  // 电源按钮用颜色区分：开机绿色、关机红色、重启橙色
  const colorBtn = 'flex size-7 items-center justify-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-35 [&>svg]:size-3.5';
  const go = (tab?: string) => navigate(`/console/instances/${inst.id}${tab ? `?tab=${tab}` : ''}`);
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      {running ? (
        <Tooltip content={t('power.stop')}>
          <button
            type="button"
            aria-label={t('power.stop')}
            disabled={blocked}
            className={cn(colorBtn, 'text-danger-text hover:bg-danger-soft')}
            onClick={async () => {
              if (await confirm({ title: t('power.stopTitle', { name: inst.hostname }), description: t('power.stopDesc'), danger: true, confirmText: t('power.stop') }))
                power.mutate('stop');
            }}
          >
            <Square className="fill-current" />
          </button>
        </Tooltip>
      ) : (
        <Tooltip content={t('power.start')}>
          <button type="button" aria-label={t('power.start')} disabled={blocked || inst.status !== 'STOPPED'} className={cn(colorBtn, 'text-success-icon hover:bg-success-soft')} onClick={() => power.mutate('start')}>
            <Play className="fill-current" />
          </button>
        </Tooltip>
      )}
      <Tooltip content={t('power.restart')}>
        <button
          type="button"
          aria-label={t('power.restart')}
          disabled={blocked || !running}
          className={cn(colorBtn, 'text-warning-icon hover:bg-warning-soft')}
          onClick={async () => {
            if (await confirm({ title: t('power.restartTitle', { name: inst.hostname }), description: t('power.restartDesc'), confirmText: t('power.restart') }))
              power.mutate('restart');
          }}
        >
          <RotateCw />
        </button>
      </Tooltip>
      <DropdownMenu
        trigger={
          <button type="button" aria-label={t('common.more')} className={iconBtn}>
            <Ellipsis />
          </button>
        }
        items={[
          { label: t('instances.manage'), icon: <Server />, onClick: () => go() },
          { label: t('detail.menu.renew'), icon: <CalendarClock />, onClick: () => go('settings') },
          { label: t('detail.tab.reinstall'), icon: <Disc3 />, onClick: () => go('reinstall') },
          { label: t('detail.tab.tasks'), icon: <ScrollText />, onClick: () => go('tasks') },
          // 交易市场：没挂牌的进入出售窗口（预选该实例），已挂牌的到上架记录里改价或撤销
          ...(cfg?.marketEnabled
            ? [
                {
                  label: inst.marketListing ? t('market.manageListing') : t('market.sell'),
                  icon: <Store />,
                  onClick: () => navigate(inst.marketListing ? '/console/marketplace/mine' : `/console/marketplace/mine?sell=${inst.id}`),
                },
              ]
            : []),
        ]}
      />
      <ChevronRight className="ml-1 size-4 text-fg-4" aria-hidden />
    </div>
  );
}

export function TrafficCell({ inst }: { inst: Pick<InstanceDTO, 'traffic' | 'trafficUsed' | 'trafficThrottled'> }) {
  const t = useT();
  const limit = inst.traffic * 1024 ** 3;
  const pct = inst.traffic > 0 ? percent(inst.trafficUsed, limit) : 0;
  return (
    <div className="w-36 max-w-full">
      <div className="tabular text-xs text-fg-2">
        {formatBytes(inst.trafficUsed)} / {formatTraffic(inst.traffic)}
        {inst.trafficThrottled && <span className="ml-1 text-warning-text">{t('instances.throttled')}</span>}
      </div>
      {inst.traffic > 0 && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
          <div className={cn('h-full origin-left rounded-full transition-transform duration-700 ease-smooth', pct >= 95 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-fg-2')} style={{ transform: `scaleX(${pct / 100})` }} />
        </div>
      )}
    </div>
  );
}

export function ExpiryCell({ expiresAt }: { expiresAt: string }) {
  const left = daysLeft(expiresAt);
  return (
    <div className="text-xs">
      <div className="tabular text-fg">{formatDate(expiresAt, 'YYYY-MM-DD')}</div>
      <div className={left <= 0 ? 'text-danger-text' : left <= 7 ? 'text-warning-text' : 'text-fg-3'}>{daysLeftText(expiresAt)}</div>
    </div>
  );
}

/** 两行单元格：主信息 + 次要信息 */
function TwoLine({ main, sub }: { main: ReactNode; sub: ReactNode }) {
  return (
    <div className="min-w-0 text-xs leading-5">
      <div className="truncate text-fg">{main}</div>
      <div className="truncate text-fg-3">{sub}</div>
    </div>
  );
}

/** 模式：虚拟化方式 + 网络方式 */
function ModeTags({ inst }: { inst: InstanceDTO }) {
  const t = useT();
  const vm = isVmType(inst.type);
  const net = inst.ipv6Only ? 'IPv6 Only' : isNatType(inst.type) ? 'IPv4 NAT' : t('instances.mode.ipv4');
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Tag tone={vm ? 'primary' : 'success'}>{vm ? 'KVM' : 'LXC'}</Tag>
      <Tag tone={inst.ipv6Only ? 'neutral' : isNatType(inst.type) ? 'warning' : 'primary'}>{net}</Tag>
    </div>
  );
}

type StatusFilter = 'all' | 'running' | 'stopped' | 'other';
type PowerAction = 'start' | 'stop' | 'restart';

export default function Instances() {
  const { t } = useI18n();
  const q = useInstances();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkPending, setBulkPending] = useState(false);
  const term = search.trim().toLowerCase();
  const rows = q.data?.filter((i) => {
    if (status === 'running' && i.status !== 'RUNNING') return false;
    if (status === 'stopped' && i.status !== 'STOPPED') return false;
    if (status === 'other' && (i.status === 'RUNNING' || i.status === 'STOPPED')) return false;
    if (!term) return true;
    return [i.hostname, i.name, i.publicIp, i.privateIp, i.region, i.image?.name].some((v) => v?.toLowerCase().includes(term));
  });
  const count = (f: StatusFilter) =>
    (q.data ?? []).filter((i) => (f === 'running' ? i.status === 'RUNNING' : f === 'stopped' ? i.status === 'STOPPED' : i.status !== 'RUNNING' && i.status !== 'STOPPED')).length;

  // 选中项只保留当前列表中仍存在的实例
  const visible = rows ?? [];
  const chosen = visible.filter((i) => selected.has(i.id));
  const allChecked = visible.length > 0 && chosen.length === visible.length;
  const toggle = (id: number, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** 批量电源操作：只对可执行该操作的实例提交，逐个调用接口 */
  const bulk = async (action: PowerAction) => {
    const targets = chosen.filter((i) => !powerBlocked(i) && (action === 'start' ? i.status === 'STOPPED' : i.status === 'RUNNING'));
    if (targets.length === 0) return toast.error(t('instances.bulk.none'));
    if (action !== 'start') {
      const ok = await confirm({
        title: t(action === 'stop' ? 'instances.bulk.stopTitle' : 'instances.bulk.restartTitle', { n: targets.length }),
        description: t(action === 'stop' ? 'power.stopDesc' : 'power.restartDesc'),
        danger: action === 'stop',
        confirmText: t(action === 'stop' ? 'power.stop' : 'power.restart'),
      });
      if (!ok) return;
    }
    setBulkPending(true);
    const results = await Promise.allSettled(targets.map((i) => api.post(`/instances/${i.id}/power`, { action })));
    setBulkPending(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(t('instances.bulk.partial', { ok: targets.length - failed, failed }));
    else toast.success(t('instances.bulk.done', { n: targets.length }));
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ['instances'] });
  };

  const columns: Column<InstanceDTO>[] = [
    {
      key: 'select',
      header: <Checkbox checked={allChecked} onCheckedChange={(v) => setSelected(v ? new Set(visible.map((i) => i.id)) : new Set())} />,
      className: 'w-10',
      mobile: 'hide',
      cell: (i) => (
        <span onClick={(e) => e.stopPropagation()}>
          <Checkbox checked={selected.has(i.id)} onCheckedChange={(v) => toggle(i.id, v)} />
        </span>
      ),
    },
    {
      key: 'name',
      header: t('instances.colName'),
      mobile: 'title',
      cell: (i) => (
        <div className="flex min-w-0 items-center gap-3">
          <OsIcon family={i.image?.family ?? 'linux'} className="size-9 text-xs" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate font-medium text-fg">{i.hostname}</span>
              {i.marketListing && <Tag tone="primary">{t('market.onSale')}</Tag>}
            </div>
            <div className="truncate text-xs text-fg-3">
              {i.image?.name ?? '—'} · {i.region}
            </div>
          </div>
        </div>
      ),
    },
    { key: 'status', header: t('common.status'), cell: (i) => <InstanceStatusBadge status={i.status} reason={i.suspendReason} activeTask={i.activeTask} /> },
    { key: 'addr', header: t('instances.colIp'), mobile: 'full', cell: (i) => <AddressCell address={instanceIp(i)} country={i.country} /> },
    { key: 'mode', header: t('instances.colMode'), headerClassName: 'hidden 2xl:table-cell', className: 'hidden 2xl:table-cell', cell: (i) => <ModeTags inst={i} /> },
    {
      key: 'spec',
      header: t('instances.spec'),
      cell: (i) => (
        <TwoLine
          main={`${formatCores(i.cpu)} / ${formatMemory(i.memory)} / ${i.disk} GB`}
          sub={
            <span className={cn(i.trafficThrottled && 'text-warning-text')}>
              {formatBytes(i.trafficUsed)} / {i.traffic > 0 ? formatTraffic(i.traffic) : t('common.unlimited')}
              {i.trafficThrottled && ` · ${t('instances.throttled')}`}
            </span>
          }
        />
      ),
    },
    {
      key: 'quota',
      header: t('instances.colQuota'),
      headerClassName: 'hidden xl:table-cell',
      className: 'hidden xl:table-cell',
      cell: (i) => {
        const left = daysLeft(i.expiresAt);
        return (
          <TwoLine
            main={
              isNatType(i.type) && !i.ipv6Only
                ? t('instances.quotaNat', { ports: i.portLimit, snapshots: i.snapshotLimit, sites: i.siteLimit })
                : t('instances.quotaSnapshots', { snapshots: i.snapshotLimit })
            }
            sub={
              <>
                {t('instances.expiresOn', { date: formatDate(i.expiresAt, 'YYYY-MM-DD') })}{' '}
                <span className={left <= 0 ? 'text-danger-text' : left <= 7 ? 'text-warning-text' : undefined}>({daysLeftText(i.expiresAt)})</span>
              </>
            }
          />
        );
      },
    },
    { key: 'actions', header: <span className="block text-right">{t('common.actions')}</span>, mobile: 'actions', cell: (i) => <RowActions inst={i} /> },
  ];

  return (
    <>
      <PageHeader
        title={t('nav.instances')}
        description={t('instances.subtitle')}
        actions={
          <LinkButton to="/console/store" variant="primary" icon={<Plus />}>
            {t('nav.store')}
          </LinkButton>
        }
      />
      <Card className="overflow-hidden">
        <Toolbar>
          <Segmented
            value={status}
            onChange={setStatus}
            aria-label={t('common.status')}
            items={[
              { value: 'all', label: `${t('common.all')} ${q.data?.length ?? ''}`.trim() },
              { value: 'running', label: `${t('instances.filterRunning')} ${q.data ? count('running') : ''}`.trim() },
              { value: 'stopped', label: `${t('instances.filterStopped')} ${q.data ? count('stopped') : ''}`.trim() },
              { value: 'other', label: `${t('instances.filterOther')} ${q.data ? count('other') : ''}`.trim() },
            ]}
          />
          <div className="flex items-center gap-2">
            <div className="relative flex-1 sm:w-64 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('instances.search')} className="pl-8" />
            </div>
          </div>
        </Toolbar>
        {/* 选中实例时在筛选栏下方显示批量操作，筛选和搜索保持可用 */}
        {chosen.length > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface-2/60 px-4 py-2">
            <div className="flex items-center gap-2 text-[13px]">
              <button type="button" aria-label={t('common.cancel')} className="rounded p-1 text-fg-3 hover:bg-surface-3 hover:text-fg" onClick={() => setSelected(new Set())}>
                <X className="size-4" />
              </button>
              {t('instances.bulk.selected', { n: chosen.length })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" icon={<Play />} loading={bulkPending} onClick={() => void bulk('start')}>
                {t('power.start')}
              </Button>
              <Button size="sm" icon={<RotateCw />} disabled={bulkPending} onClick={() => void bulk('restart')}>
                {t('power.restart')}
              </Button>
              <Button size="sm" icon={<Square />} disabled={bulkPending} className="text-danger-text" onClick={() => void bulk('stop')}>
                {t('power.stop')}
              </Button>
            </div>
          </div>
        )}
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            loading={q.isLoading}
            rowKey={(i) => i.id}
            onRowClick={(i) => navigate(`/console/instances/${i.id}`)}
            empty={
              <Empty
                title={t('instances.empty')}
                description={t('instances.emptyDesc')}
                icon={<Server />}
                action={
                  <LinkButton to="/console/store" variant="primary">
                    {t('instances.goDeploy')}
                  </LinkButton>
                }
              />
            }
          />
        )}
      </Card>
    </>
  );
}

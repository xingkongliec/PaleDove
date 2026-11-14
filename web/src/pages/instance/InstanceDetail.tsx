import { useMutation } from '@tanstack/react-query';
import {
  Activity,
  Ban,
  Camera,
  CircleCheck,
  ChevronLeft,
  Disc3,
  Ellipsis,
  Gauge,
  HardDrive,
  KeyRound,
  Link2,
  Pencil,
  PowerOff,
  RefreshCw,
  ScrollText,
  Settings2,
  Shield,
  Shuffle,
  SquareTerminal,
  Waypoints,
} from 'lucide-react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { isNatType, type AdminInstanceDTO, type DeleteRefundMode } from '../../shared/index';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { CountryFlag } from '@/components/country';
import { TerminalDockProvider, useTerminalDock } from '@/components/TerminalDock';
import { InstanceStatusBadge, OsIcon } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { DropdownMenu } from '@/components/ui/menu';
import { Alert, ErrorState, PageLoading, type Tone } from '@/components/ui/misc';
import { useInstanceApiPath, isBusy, useInstance, useInvalidateInstance, useMarketLocked, usePowerAction, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import AdminPanel from './AdminPanel';
import { SwitchNodeDialog } from './SwitchNode';
import { DeleteDialog } from '../admin/instances/DeleteDialog';
import { SuspendDialog } from '../admin/instances/SuspendDialog';
import Monitor from './Monitor';
import Overview from './Overview';
import Ports from './Ports';
import Reinstall from './Reinstall';
import SettingsTab from './SettingsTab';
import Sites from './Sites';
import Disks from './Disks';
import Snapshots from './Snapshots';
import Tasks from './Tasks';

const Console = lazy(() => import('./Console'));
type Tab = 'overview' | 'monitor' | 'console' | 'ports' | 'sites' | 'snapshots' | 'disks' | 'reinstall' | 'settings' | 'tasks' | 'admin';

/** 重命名：修改主机名 */
function RenameDialog({ inst, open, onClose }: { inst: AnyInstance; open: boolean; onClose: () => void }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t } = useI18n();
  const invalidate = useInvalidateInstance(inst.id);
  const [hostname, setHostname] = useState(inst.hostname);
  const save = useMutation({
    mutationFn: () => api.patch(instancePath, { hostname }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      invalidate();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  const valid = !!hostname && hostname !== inst.hostname;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('detail.renameTitle')}
      description={t('settings.hostnameDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase())} aria-label={t('store.hostname')} autoFocus />
      </form>
    </Modal>
  );
}

// 按钮尺寸：窄屏 btn-sm（h-7、text-xs），sm 起 btn（h-9、px-4、text-sm）；部分按钮窄屏只显示图标
const compact = 'h-7 rounded-lg px-3 text-xs [&_svg]:size-4 sm:h-9 sm:px-4 sm:text-sm';
const iconOnly = 'max-sm:px-2';

/**
 * 标题栏右侧操作：
 * 重命名、终端、开机/关机、重启（仅运行中）、重装、更多；管理员另有同步状态、封禁/解封、删除
 */
function HeaderActions({ inst, admin, onTab }: { inst: AnyInstance; admin?: boolean; onTab: (t: Tab) => void }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t } = useI18n();
  const power = usePowerAction(inst.id);
  const confirm = useConfirm();
  const [renameOpen, setRenameOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const busy = isBusy(inst) || power.isPending;
  const locked = useMarketLocked(inst);
  const blocked = busy || locked || inst.status === 'SUSPENDED' || inst.status === 'CREATING' || inst.status === 'DELETED';
  const running = inst.status === 'RUNNING';
  const deleting = inst.status === 'DELETED' || inst.status === 'DELETING';
  const dock = useTerminalDock();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* 窄屏只显示图标 */}
      <Button
        variant="ghost"
        icon={<Pencil className="sm:hidden" />}
        className={cn(compact, iconOnly)}
        disabled={deleting || locked}
        aria-label={t('detail.rename')}
        title={t('detail.rename')}
        onClick={() => setRenameOpen(true)}
      >
        <span className="max-sm:hidden">{t('detail.rename')}</span>
      </Button>
      {/* 终端按钮为绿色；窗口由 TerminalDock 管理：关闭时缩小到右下角，连接保持到离开实例管理页面；关机时显示但禁用 */}
      <Button
        variant="success"
        icon={<SquareTerminal />}
        className={cn(compact, iconOnly)}
        disabled={blocked || !running}
        aria-label={t('terminal.open')}
        title={running ? t('terminal.open') : t('terminal.needRunning')}
        onClick={() => dock.open(inst, instancePath)}
      >
        <span className="max-sm:hidden">{t('terminal.open')}</span>
      </Button>
      {/* 电源按钮用颜色区分（与实例列表一致）：开机绿色、关机红色、重启橙色 */}
      {running ? (
        <Button
          className={compact}
          disabled={blocked}
          onClick={async () => {
            if (await confirm({ title: t('power.stopTitle', { name: inst.hostname }), description: t('power.stopDesc'), danger: true, confirmText: t('power.stop') })) power.mutate('stop');
          }}
        >
          {t('power.stop')}
        </Button>
      ) : (
        <Button className={compact} disabled={blocked || deleting} onClick={() => power.mutate('start')}>
          {t('power.start')}
        </Button>
      )}
      {/* 重启只在运行中显示 */}
      {running && (
        <Button
          className={compact}
          disabled={blocked}
          onClick={async () => {
            if (await confirm({ title: t('power.restartTitle', { name: inst.hostname }), description: t('power.restartDesc'), confirmText: t('power.restart') })) power.mutate('restart');
          }}
        >
          {t('power.restart')}
        </Button>
      )}
      <Button className={compact} disabled={blocked} onClick={() => onTab('reinstall')}>
        {t('detail.reinstallShort')}
      </Button>
      {admin && 'node' in inst && <AdminSyncButton inst={inst} />}
      <DropdownMenu
        trigger={<Button size="icon" className="size-7 rounded-lg sm:size-9" icon={<Ellipsis />} aria-label={t('common.more')} title={t('common.more')} />}
        className="min-w-44"
        items={[
          { label: t('detail.menu.resetPassword'), icon: <KeyRound />, disabled: deleting || locked, onClick: () => onTab('settings') },
          // 切换机房：每 30 天免费一次，在同产品的其他机房重装系统
          { label: t('switch.open'), icon: <Shuffle />, disabled: blocked, onClick: () => setSwitchOpen(true) },
          {
            label: t('power.forceStop'),
            icon: <PowerOff />,
            disabled: !running || blocked,
            onClick: async () => {
              if (await confirm({ title: t('power.forceStopTitle'), description: t('power.forceStopDesc'), danger: true, confirmText: t('power.forceStop') })) power.mutate('force_stop');
            },
          },
        ]}
      />
      {/* 用户在概览的订阅卡片里删除；管理员的封禁与删除直接放在标题栏最右侧 */}
      {admin && 'node' in inst && <AdminDangerButtons inst={inst} />}
      {renameOpen && <RenameDialog inst={inst} open onClose={() => setRenameOpen(false)} />}
      {switchOpen && <SwitchNodeDialog inst={inst} open onClose={() => setSwitchOpen(false)} />}
    </div>
  );
}

/** 管理员：从节点同步实例电源状态 */
function AdminSyncButton({ inst }: { inst: AdminInstanceDTO }) {
  const { t } = useI18n();
  const invalidate = useInvalidateInstance(inst.id);
  const sync = useMutation({
    mutationFn: () => api.post(`/admin/instances/${inst.id}/actions`, { action: 'sync' }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Button icon={<RefreshCw />} className={compact} loading={sync.isPending} title={t('adminInst.syncDesc')} onClick={() => sync.mutate()}>
      {t('detail.action.sync')}
    </Button>
  );
}

/** 管理员：封禁/解封、删除（选择退款方式并填写原因，与管理面板一致） */
function AdminDangerButtons({ inst }: { inst: AdminInstanceDTO }) {
  const { t } = useI18n();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const invalidate = useInvalidateInstance(inst.id);
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleting = inst.status === 'DELETED' || inst.status === 'DELETING';
  const suspend = useMutation({
    mutationFn: (note: string) => api.post(`/admin/instances/${inst.id}/actions`, { action: 'suspend', note }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      setSuspendOpen(false);
      invalidate();
    },
  });
  const unsuspend = useMutation({
    mutationFn: () => api.post(`/admin/instances/${inst.id}/actions`, { action: 'unsuspend' }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (v: { refundMode: DeleteRefundMode; note: string }) => api.post(`/admin/instances/${inst.id}/actions`, { action: 'delete', ...v }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      setDeleteOpen(false);
      navigate('/admin/instances');
    },
  });
  return (
    <>
      {inst.status === 'SUSPENDED' ? (
        <Button
          variant="success"
          icon={<CircleCheck />}
          className={compact}
          loading={unsuspend.isPending}
          title={t('adminInst.unsuspendDesc')}
          onClick={async () => {
            if (await confirm({ title: t('adminInst.unsuspendTitle') })) unsuspend.mutate();
          }}
        >
          {t('detail.action.unsuspend')}
        </Button>
      ) : (
        <Button
          icon={<Ban />}
          className={cn(compact, 'border-warning bg-warning text-danger-fg hover:not-disabled:border-warning hover:not-disabled:bg-warning hover:not-disabled:opacity-90')}
          disabled={deleting}
          title={t('adminInst.suspendDesc')}
          onClick={() => {
            suspend.reset();
            setSuspendOpen(true);
          }}
        >
          {t('detail.action.suspend')}
        </Button>
      )}
      <Button
        variant="danger-ghost"
        className={cn(compact, 'border-danger/20 bg-danger-soft hover:not-disabled:bg-danger-soft hover:not-disabled:opacity-80')}
        disabled={deleting}
        title={t('adminInst.deleteDesc')}
        onClick={() => {
          remove.reset();
          setDeleteOpen(true);
        }}
      >
        {t('common.delete')}
      </Button>
      <SuspendDialog
        key={`suspend-${suspendOpen}`}
        open={suspendOpen}
        title={t('adminInst.suspendTitle')}
        pending={suspend.isPending}
        error={suspend.error ? errorText(suspend.error) : null}
        onClose={() => setSuspendOpen(false)}
        onSubmit={(note) => suspend.mutate(note)}
      />
      <DeleteDialog
        key={`delete-${deleteOpen}`}
        open={deleteOpen}
        title={t('settings.deleteConfirm', { name: inst.hostname })}
        confirmText={inst.hostname}
        instanceIds={[inst.id]}
        pending={remove.isPending}
        error={remove.error ? errorText(remove.error) : null}
        onClose={() => setDeleteOpen(false)}
        onSubmit={(v) => remove.mutate(v)}
      />
    </>
  );
}

function Notices({ inst, admin }: { inst: AnyInstance; admin?: boolean }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const locked = useMarketLocked(inst);
  const notices: { tone: Tone; text: ReactNode }[] = [];
  if (locked && inst.marketListing) {
    notices.push({
      tone: 'warning',
      text: (
        <>
          {t('detail.notice.listed', { price: formatMoney(inst.marketListing.price, currency) })}{' '}
          <Link to="/console/marketplace/mine" className="font-medium underline underline-offset-2">
            {t('market.manageListing')}
          </Link>
        </>
      ),
    });
  }
  if (inst.status === 'CREATING') notices.push({ tone: 'primary', text: t('detail.notice.creating') });
  if (inst.status === 'REINSTALLING') notices.push({ tone: 'primary', text: t('detail.notice.reinstalling') });
  if (inst.status === 'MIGRATING') notices.push({ tone: 'primary', text: t('detail.notice.migrating') });
  if (inst.status === 'SUSPENDED') {
    const hint = inst.suspendReason === 'EXPIRED' ? t('detail.notice.suspendedExpired') : inst.suspendReason === 'TRAFFIC' ? t('detail.notice.suspendedTraffic') : t('detail.notice.contactAdmin');
    notices.push({
      tone: 'warning',
      // 管理员填写了封禁原因时显示原因
      text: t('detail.notice.suspended', { reason: inst.suspendNote || (inst.suspendReason ? L.suspendReason[inst.suspendReason] : t('detail.notice.unknownReason')), hint }),
    });
  }
  if (inst.status === 'ERROR') {
    const lastError = 'lastError' in inst ? inst.lastError : null;
    notices.push({ tone: 'danger', text: admin && lastError ? t('detail.notice.errorAdmin', { error: lastError }) : t('detail.notice.error') });
  }
  if (inst.trafficThrottled) notices.push({ tone: 'warning', text: t('detail.notice.throttled') });
  if (notices.length === 0) return null;
  return (
    <div className="mb-4 space-y-2">
      {notices.map((n, i) => (
        <Alert key={i} tone={n.tone}>
          {n.text}
        </Alert>
      ))}
    </div>
  );
}

/** 终端连接只在实例管理页面内保持：离开页面或切换到其他实例时全部断开 */
export default function InstanceDetail({ admin }: { admin?: boolean }) {
  const { id } = useParams();
  return (
    <TerminalDockProvider key={id}>
      <InstanceDetailPage admin={admin} />
    </TerminalDockProvider>
  );
}

function InstanceDetailPage({ admin }: { admin?: boolean }) {
  const { t, L } = useI18n();
  const { id: idParam } = useParams();
  const id = Number(idParam);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const q = useInstance(id);

  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const inst = q.data;
  const nat = isNatType(inst.type);

  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <>
      {/*
        标题栏：返回（无边框小按钮）| 系统图标、名称与状态，下方实例类型 · 镜像 · 地区；右侧操作按钮。窄屏上下排列
      */}
      <div className="mb-4 flex flex-col gap-4 border-b border-line pb-4 sm:mb-6 sm:pb-5 lg:flex-row lg:items-center lg:justify-between lg:gap-6">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to={admin ? '/admin/instances' : '/console/instances'}
            aria-label={t('detail.backToList')}
            title={t('detail.backToList')}
            className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-surface-3 hover:text-fg"
          >
            <ChevronLeft className="size-[18px]" />
          </Link>
          <span className="h-7 w-px shrink-0 bg-line" aria-hidden />
          {inst.image ? (
            <OsIcon family={inst.image.family} className="size-10 rounded-lg text-sm" />
          ) : (
            <span className="block size-10 shrink-0 rounded-lg border border-line bg-surface-2" />
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="truncate text-[17px] leading-6 font-semibold tracking-tight text-fg">{inst.hostname}</h1>
              <InstanceStatusBadge status={inst.status} reason={inst.suspendReason} activeTask={inst.activeTask} />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-3">
              <span className="shrink-0 rounded bg-surface-3 px-1.5 py-px text-[11px] font-medium text-fg-2">{L.instanceType[inst.type]}</span>
              <span className="truncate">{inst.image?.name ?? '—'}</span>
              <span className="text-fg-4">·</span>
              <CountryFlag code={inst.country} />
              <span className="truncate">{inst.region}</span>
            </div>
          </div>
        </div>
        {inst.status !== 'DELETED' && <HeaderActions inst={inst} admin={admin} onTab={setTab} />}
      </div>

      {/* 标签栏：灰底分段（surface-3），选中项白底；窄屏只显示图标 */}
      <div role="tablist" className="scrollbar-none mb-4 flex w-full gap-1 overflow-x-auto rounded-lg bg-surface-3 p-1 sm:mb-6 sm:w-fit">
        {(
          [
            { value: 'overview', label: t('detail.tab.overview'), icon: <Gauge /> },
            { value: 'monitor', label: t('detail.tab.monitor'), icon: <Activity /> },
            { value: 'console', label: t('console.title'), icon: <SquareTerminal /> },
            { value: 'ports', label: t('detail.tab.ports'), icon: <Waypoints />, hidden: !nat || inst.ipv6Only },
            { value: 'sites', label: t('detail.tab.sites'), icon: <Link2 />, hidden: !nat || inst.ipv6Only },
            { value: 'snapshots', label: t('detail.tab.snapshots'), icon: <Camera /> },
            { value: 'disks', label: t('detail.tab.disks'), icon: <HardDrive />, hidden: !admin && inst.counts.volumes === 0 },
            { value: 'reinstall', label: t('detail.tab.reinstall'), icon: <Disc3 /> },
            { value: 'settings', label: t('detail.tab.settings'), icon: <Settings2 /> },
            { value: 'tasks', label: t('detail.tab.tasks'), icon: <ScrollText /> },
            { value: 'admin', label: t('detail.tab.admin'), icon: <Shield />, hidden: !admin },
          ] as { value: Tab; label: string; icon: ReactNode; hidden?: boolean }[]
        )
          .filter((item) => !item.hidden)
          .map((item) => (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={tab === item.value}
              title={item.label}
              onClick={() => setTab(item.value)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium whitespace-nowrap transition-colors sm:gap-2 sm:px-4 sm:text-sm [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]',
                // 选中项：白底 + 细边框与阴影，与灰色底条区分明显（浅色 / 深色主题都清晰）
                tab === item.value ? 'bg-surface text-fg shadow-sm ring-1 ring-line-strong' : 'text-fg-2 hover:bg-surface/60 hover:text-fg',
              )}
            >
              {item.icon}
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          ))}
      </div>
      <Notices inst={inst} admin={admin} />
      {/* 错误边界：某个标签页出错时只影响内容区，头部与其他标签页仍可用；key 在切换标签页时重置 */}
      <div key={tab} className="panel-enter">
        <ErrorBoundary>
          {tab === 'overview' && <Overview inst={inst} admin={admin} onRenew={() => setTab('settings')} />}
          {tab === 'monitor' && <Monitor inst={inst} />}
          {tab === 'console' && <Suspense fallback={<PageLoading />}><Console inst={inst} /></Suspense>}
          {tab === 'ports' && nat && <Ports inst={inst} />}
          {tab === 'sites' && nat && <Sites inst={inst} />}
          {tab === 'snapshots' && <Snapshots inst={inst} />}
          {tab === 'disks' && <Disks inst={inst} admin={admin} />}
          {tab === 'reinstall' && <Reinstall inst={inst} />}
          {tab === 'settings' && <SettingsTab inst={inst} admin={admin} />}
          {tab === 'tasks' && <Tasks inst={inst} />}
          {tab === 'admin' && admin && 'node' in inst && <AdminPanel inst={inst} />}
        </ErrorBoundary>
      </div>
    </>
  );
}

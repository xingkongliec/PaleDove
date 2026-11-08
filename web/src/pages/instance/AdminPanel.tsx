import { useMutation } from '@tanstack/react-query';
import { ArrowRightLeft, Ban, CircleCheck, RefreshCw, RotateCcw, Send, Trash2, UserRoundCog, Zap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { isVmType, type AdminInstanceDTO, type DeleteRefundMode, type OverLimitAction, type TrafficMode } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Alert, Card, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useInvalidateInstance } from '@/hooks/instances';
import { useI18n, type MessageKey } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { MigrateDialog } from '../admin/instances/MigrateDialog';
import { SuspendDialog } from '../admin/instances/SuspendDialog';
import { DeleteDialog } from '../admin/instances/DeleteDialog';
import { TransferDialog } from './TransferDialog';
import { dayjs, formatBytes } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { trafficModeOptions, overLimitOptions } from '@/lib/plans';
import { cn } from '@/lib/cn';
import { LimitFields, limitForm, limitPayload } from '@/components/resource-limits';

type Action = 'unsuspend' | 'reset_traffic' | 'retry_create' | 'apply_limits' | 'sync';

function toForm(inst: AdminInstanceDTO) {
  return {
    cpu: String(inst.cpu),
    limits: limitForm(inst),
    memory: String(inst.memory),
    swap: String(inst.swap),
    disk: String(inst.disk),
    bandwidthIn: String(inst.bandwidthIn),
    bandwidthOut: String(inst.bandwidthOut),
    traffic: String(inst.traffic),
    trafficMode: inst.trafficMode as TrafficMode,
    overLimitAction: inst.overLimitAction as OverLimitAction,
    portLimit: String(inst.portLimit),
    siteLimit: String(inst.siteLimit),
    snapshotLimit: String(inst.snapshotLimit),
    expiresAt: dayjs(inst.expiresAt).format('YYYY-MM-DDTHH:mm'),
    price: inst.price,
    trafficResetPrice: inst.trafficResetPrice ?? '',
    remark: inst.remark ?? '',
  };
}

export default function AdminPanel({ inst }: { inst: AdminInstanceDTO }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const invalidate = useInvalidateInstance(inst.id);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [initial, setInitial] = useState(() => toForm(inst));
  const [form, setForm] = useState(initial);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const set = (k: Exclude<keyof typeof form, 'limits'>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });

  const migrate = useMutation({
    mutationFn: (targetNodeId: number) => api.post(`/admin/instances/${inst.id}/actions`, { action: 'migrate', targetNodeId }),
    onSuccess: () => {
      toast.success(t('common.submitted'), t('adminInst.migrateSubmitted'));
      setMigrateOpen(false);
      invalidate();
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api.patch<AdminInstanceDTO>(`/admin/instances/${inst.id}`, {
        cpu: Number(form.cpu),
        ...limitPayload(form.limits, inst.type),
        memory: Number(form.memory),
        swap: Number(form.swap) || 0,
        disk: Number(form.disk),
        bandwidthIn: Number(form.bandwidthIn),
        bandwidthOut: Number(form.bandwidthOut),
        traffic: Number(form.traffic),
        trafficMode: form.trafficMode,
        overLimitAction: form.overLimitAction,
        portLimit: Number(form.portLimit),
        siteLimit: Number(form.siteLimit),
        snapshotLimit: Number(form.snapshotLimit),
        expiresAt: new Date(form.expiresAt).toISOString(),
        price: form.price,
        trafficResetPrice: form.trafficResetPrice.trim() || null,
        remark: form.remark || null,
      }),
    onSuccess: (updated) => {
      toast.success(t('common.saved'), t('adminInst.savedDesc'));
      // 以保存后的数据作为新的基准，不再显示「有未保存的修改」
      const next = toForm(updated);
      setInitial(next);
      setForm(next);
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });

  const action = useMutation({
    mutationFn: (a: Action) => api.post(`/admin/instances/${inst.id}/actions`, { action: a }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });
  const run = async (a: Action, title: string, danger = false, description?: string) => {
    if (await confirm({ title, danger, description })) action.mutate(a);
  };
  const pending = (a: Action) => action.isPending && action.variables === a;
  // 删除：选择退款方式并填写原因，用户会收到站内信
  const [deleteOpen, setDeleteOpen] = useState(false);
  const remove = useMutation({
    mutationFn: (v: { refundMode: DeleteRefundMode; note: string }) => api.post(`/admin/instances/${inst.id}/actions`, { action: 'delete', ...v }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      setDeleteOpen(false);
      navigate('/admin/instances');
    },
  });
  // 封禁：可填写原因（用户可见）
  const [suspendOpen, setSuspendOpen] = useState(false);
  const suspend = useMutation({
    mutationFn: (note: string) => api.post(`/admin/instances/${inst.id}/actions`, { action: 'suspend', note }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      setSuspendOpen(false);
      invalidate();
    },
  });

  const num = (k: Exclude<keyof typeof form, 'limits'>, label: MessageKey, unit?: string) => (
    <FormField label={t(label)}>
      {unit ? <InputGroup type="number" min={0} value={form[k]} onChange={set(k)} suffix={unit} /> : <Input type="number" min={0} value={form[k]} onChange={set(k)} />}
    </FormField>
  );
  const link = 'font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg';
  const movable = ['RUNNING', 'STOPPED', 'SUSPENDED'].includes(inst.status) && !inst.activeTask;

  // 管理操作：按钮 + 悬停说明，确认框里再写清楚影响
  const tool = (key: string, icon: ReactNode, label: string, desc: string, onClick: () => void, opts: { loading?: boolean; disabled?: boolean } = {}) => (
    <Tooltip key={key} content={desc}>
      <Button size="sm" icon={icon} loading={opts.loading} disabled={opts.disabled} onClick={onClick}>
        {label}
      </Button>
    </Tooltip>
  );

  return (
    <div className="space-y-4">
      {/* 概要与管理操作 */}
      <Card className="overflow-hidden">
        <dl className="flex flex-wrap items-center gap-x-6 gap-y-1.5 px-4 py-3 text-[13px]">
          <div className="flex min-w-0 items-center gap-2">
            <dt className="text-fg-3">{t('common.user')}</dt>
            <dd className="min-w-0 truncate">
              <Link className={link} to={`/admin/users?q=${encodeURIComponent(inst.user.username)}`}>
                {inst.user.username}
              </Link>
              <span className="ml-1.5 text-xs text-fg-3">{inst.user.email}</span>
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-fg-3">{t('common.node')}</dt>
            <dd>
              <Link className={link} to={`/admin/nodes/${inst.node.id}`}>
                {inst.node.name}
              </Link>
            </dd>
          </div>
          <div className="flex items-center gap-2">
            <dt className="text-fg-3">{t('adminInst.trafficTotal')}</dt>
            <dd className="tabular text-fg">
              ↓ {formatBytes(inst.trafficIn)} · ↑ {formatBytes(inst.trafficOut)}
            </dd>
          </div>
        </dl>
        {inst.status === 'SUSPENDED' && inst.suspendNote && (
          <div className="border-t border-line px-4 py-2.5">
            <Alert tone="danger">
              <span className="break-words">{t('suspend.noteShow', { note: inst.suspendNote })}</span>
            </Alert>
          </div>
        )}
        {inst.lastError && (
          <div className="border-t border-line px-4 py-2.5">
            <Alert tone="danger">
              <span className="break-words">{t('adminInst.lastError', { error: inst.lastError })}</span>
            </Alert>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-2/50 px-4 py-2.5">
          {inst.status === 'SUSPENDED'
            ? tool('unsuspend', <CircleCheck />, t('adminInst.unsuspend'), t('adminInst.unsuspendDesc'), () => run('unsuspend', t('adminInst.unsuspendTitle')), { loading: pending('unsuspend') })
            : tool(
                'suspend',
                <Ban />,
                t('adminInst.suspend'),
                t('adminInst.suspendDesc'),
                () => {
                  suspend.reset();
                  setSuspendOpen(true);
                },
                { disabled: inst.status === 'DELETED' },
              )}
          {tool('reset', <RotateCcw />, t('adminInst.resetTraffic'), t('adminInst.resetTrafficDesc'), () => run('reset_traffic', t('adminInst.resetTrafficTitle'), false, t('adminInst.resetTrafficDesc')), {
            loading: pending('reset_traffic'),
          })}
          {tool('apply', <Send />, t('adminInst.apply'), t('adminInst.applyDesc'), () => run('apply_limits', t('adminInst.applyTitle')), { loading: pending('apply_limits') })}
          {tool('sync', <RefreshCw />, t('adminInst.sync'), t('adminInst.syncDesc'), () => action.mutate('sync'), { loading: pending('sync') })}
          {inst.status === 'ERROR' && tool('retry', <Zap />, t('adminInst.retry'), t('adminInst.retryDesc'), () => run('retry_create', t('adminInst.retryTitle')), { loading: pending('retry_create') })}
          {tool(
            'migrate',
            <ArrowRightLeft />,
            t('adminInst.migrate'),
            t('adminInst.migrateDesc', { node: inst.node.name }),
            () => {
              migrate.reset();
              setMigrateOpen(true);
            },
            { disabled: !movable },
          )}
          {tool('transfer', <UserRoundCog />, t('transfer.action'), t('transfer.hintAdmin'), () => setTransferOpen(true), { disabled: !movable })}
          {/* 删除放在最右边：选择退款方式、填写删除原因 */}
          <div className="ml-auto">
            <Tooltip content={t('adminInst.deleteDesc')}>
              <Button
                size="sm"
                variant="danger"
                icon={<Trash2 />}
                disabled={inst.status === 'DELETED'}
                onClick={() => {
                  remove.reset();
                  setDeleteOpen(true);
                }}
              >
                {t('settings.delete')}
              </Button>
            </Tooltip>
          </div>
        </div>
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
        <SuspendDialog
        key={String(suspendOpen)}
        open={suspendOpen}
        title={t('adminInst.suspendTitle')}
        pending={suspend.isPending}
        error={suspend.error ? errorText(suspend.error) : null}
        onClose={() => setSuspendOpen(false)}
        onSubmit={(note) => suspend.mutate(note)}
      />
      <TransferDialog inst={inst} admin open={transferOpen} onClose={() => setTransferOpen(false)} />
        <MigrateDialog
          open={migrateOpen}
          onOpenChange={setMigrateOpen}
          title={t('adminInst.migrateTitle', { name: inst.hostname, node: inst.node.name })}
          currentNodeId={inst.node.id}
          type={inst.type}
          pending={migrate.isPending}
          error={migrate.error ? errorText(migrate.error) : null}
          onSubmit={(id) => migrate.mutate(id)}
        />
      </Card>

      {/* 规格与计费：三行，每行最多 6 个字段 */}
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line px-4 py-3">
          <h3 className="text-[14px] font-semibold text-fg">{t('adminInst.specTitle')}</h3>
          <p className="text-xs text-fg-3">{t('adminInst.specDesc')}</p>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-3 px-4 py-4 sm:grid-cols-3 xl:grid-cols-6">
          {num('cpu', 'adminInst.cpu', t('adminInst.unitCores'))}
          {num('memory', 'spec.memory', 'MiB')}
          {!isVmType(inst.type) && num('swap', 'plans.swap', 'MiB')}
          {num('disk', 'spec.disk', 'GiB')}
          {num('bandwidthIn', 'adminInst.bwIn', 'Mbps')}
          {num('bandwidthOut', 'adminInst.bwOut', 'Mbps')}
          {num('traffic', 'adminInst.traffic', 'GiB')}
          <FormField label={t('adminInst.trafficMode')}>
            <Select value={form.trafficMode} onChange={(v) => setForm({ ...form, trafficMode: v })} options={trafficModeOptions(t, L)} />
          </FormField>
          <FormField label={t('adminInst.overLimit')}>
            <Select value={form.overLimitAction} onChange={(v) => setForm({ ...form, overLimitAction: v })} options={overLimitOptions(t, L)} />
          </FormField>
          {num('portLimit', 'adminInst.portLimit')}
          {num('siteLimit', 'adminInst.siteLimit')}
          {num('snapshotLimit', 'adminInst.snapshotLimit')}
          <FormField label={t('plans.trafficResetPrice')}>
            <InputGroup prefix={currency} value={form.trafficResetPrice} onChange={set('trafficResetPrice')} inputMode="decimal" placeholder={t('plans.trafficResetOff')} />
          </FormField>
          <FormField label={t('instances.expires')} className="sm:col-span-2 xl:col-span-2">
            <Input type="datetime-local" value={form.expiresAt} onChange={set('expiresAt')} />
          </FormField>
          <FormField label={t('overview.renewPrice')}>
            <InputGroup prefix={currency} value={form.price} onChange={set('price')} inputMode="decimal" />
          </FormField>
          <FormField label={t('adminInst.remark')} className="col-span-2 sm:col-span-3 xl:col-span-3">
            <Input value={form.remark} onChange={set('remark')} maxLength={500} />
          </FormField>
        </div>
        {/* 性能限制：CPU 配额与优先级、进程数、磁盘 I/O */}
        <div className={cn('grid grid-cols-2 gap-x-3 gap-y-3 border-t border-line px-4 py-4 sm:grid-cols-4', isVmType(inst.type) ? 'xl:grid-cols-4' : 'xl:grid-cols-5')}>
          <LimitFields value={form.limits} onChange={(limits) => setForm({ ...form, limits })} type={inst.type} hints={false} />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-2/50 px-4 py-2.5">
          {dirty && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-[13px] text-fg-3">
              <span className="size-1.5 rounded-full bg-warning" />
              {t('common.unsaved')}
            </span>
          )}
          <Button size="sm" disabled={!dirty} onClick={() => setForm(initial)}>
            {t('nodeDetail.discard')}
          </Button>
          <Button size="sm" variant="primary" loading={save.isPending} disabled={!dirty} onClick={() => save.mutate()}>
            {t('common.saveChanges')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

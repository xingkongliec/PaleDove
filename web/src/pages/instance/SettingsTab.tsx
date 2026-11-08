import { useMutation } from '@tanstack/react-query';
import { ArrowRightLeft, Store, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useState, type ReactNode } from 'react';
import { isVmType } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge, Card, CodeBlock } from '@/components/ui/misc';
import { useInstanceApiPath, isBusy, useInvalidateInstance, useMarketLocked, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatMemory, formatMoney } from '@/lib/format';
import { useCurrency, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { TransferDialog } from './TransferDialog';
import { EgressCard } from './EgressCard';
import { RenewalCard } from './RenewalCard';

/** 紧凑设置行：左侧名称，右侧控件与一行说明；窄屏上下排列 */
function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[7rem_minmax(0,1fr)] sm:gap-4">
      <div className="text-[13px] font-medium text-fg sm:pt-2">{label}</div>
      <div className="min-w-0">
        <div className="flex max-w-md items-center gap-2">{children}</div>
        {hint && <p className="mt-1 text-xs leading-relaxed text-fg-3">{hint}</p>}
      </div>
    </div>
  );
}

export default function SettingsTab({ inst, admin = false }: { inst: AnyInstance; admin?: boolean }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t } = useI18n();
  const currency = useCurrency();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const invalidate = useInvalidateInstance(inst.id);
  const [hostname, setHostname] = useState(inst.hostname);
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const { data: market } = usePublicConfig();
  const deleted = inst.status === 'DELETED' || inst.status === 'DELETING';
  const locked = useMarketLocked(inst);
  const update = useMutation({
    mutationFn: (body: { hostname: string }) => api.patch(`${instancePath}`, body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(instancePath, { confirm: inst.hostname }),
    onSuccess: () => {
      toast.success(t('settings.deleteSubmitted'), t('settings.deleteSubmittedDesc'));
      invalidate();
      navigate(admin ? '/admin/instances' : '/instances');
    },
    onError: (e) => toast.fromError(e),
  });
  const resetPassword = useMutation({
    mutationFn: () => api.post<{ password: string }>(`${instancePath}/reset-password`, { password }),
    onSuccess: (r) => {
      setNewPassword(r.password);
      setPassword('');
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });

  // SWAP：套餐提供时（仅容器）用户可自行启用或关闭，立即生效
  const swap = useMutation({
    mutationFn: (enabled: boolean) => api.post(`${instancePath}/swap`, { enabled }),
    onSuccess: (_, enabled) => {
      toast.success(enabled ? t('swap.enabledDone') : t('swap.disabledDone'));
      invalidate();
    },
    onError: (e) => toast.fromError(e),
  });
  const hasSwap = !isVmType(inst.type) && inst.swap > 0;

  return (
    // 续费占满一行；下面两张卡片并排（基本设置 | 转移与删除），高度相近，不留大块空白；管理员只有基本设置
    <div className="space-y-4">
      {!admin && <RenewalCard key={inst.id} inst={inst} />}

      <div className={cn('grid gap-4', !admin && 'xl:grid-cols-2')}>
        <Card className="divide-y divide-line overflow-hidden">
          <Row label={t('store.hostname')} hint={t('settings.hostnameDesc')}>
            <form
              className="flex flex-1 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (hostname !== inst.hostname) update.mutate({ hostname });
              }}
            >
              <Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase())} aria-label={t('store.hostname')} />
              <Button type="submit" loading={update.isPending && hostname !== inst.hostname} disabled={deleted || locked || !hostname || hostname === inst.hostname}>
                {t('common.save')}
              </Button>
            </form>
          </Row>
          <Row label={t('overview.rootPassword')} hint={t('settings.resetPasswordDesc')}>
            <form
              className="flex flex-1 gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                // 重置前确认：会立即修改实例内 root 密码，已保存的旧密码失效
                const ok = await confirm({
                  title: t('settings.resetPasswordConfirm', { name: inst.hostname }),
                  description: password ? t('settings.resetPasswordConfirmDesc') : t('settings.resetPasswordConfirmDescAuto'),
                  confirmText: t('settings.reset'),
                  danger: true,
                });
                if (ok) resetPassword.mutate();
              }}
            >
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('common.leaveEmptyToGenerate')}
                autoComplete="new-password"
                aria-label={t('reinstall.newPassword')}
              />
              <Button type="submit" loading={resetPassword.isPending} disabled={inst.status !== 'RUNNING' || isBusy(inst) || (!admin && !!inst.marketListing)}>
                {t('settings.reset')}
              </Button>
            </form>
          </Row>
        </Card>
        {!admin && (
          <Card className="divide-y divide-line overflow-hidden">
            {market?.marketEnabled && (
              <Row
                label={t('market.sellAction')}
                hint={inst.marketListing ? t('market.listedHint', { price: formatMoney(inst.marketListing.price, currency) }) : t('market.sellActionHint')}
              >
                <Button
                  icon={<Store />}
                  disabled={deleted || isBusy(inst)}
                  onClick={() => navigate(inst.marketListing ? '/console/marketplace/mine' : `/console/marketplace/mine?sell=${inst.id}`)}
                >
                  {inst.marketListing ? t('market.manageListing') : t('market.sell')}
                </Button>
              </Row>
            )}
            <Row label={t('transfer.action')} hint={t('transfer.hint')}>
              <Button icon={<ArrowRightLeft />} disabled={deleted || isBusy(inst) || !!inst.marketListing} onClick={() => setTransferOpen(true)}>
                {t('transfer.open')}
              </Button>
            </Row>
            <Row label={<span className="text-danger-text">{t('settings.delete')}</span>} hint={t('settings.deleteDesc')}>
              <Button
                variant="secondary"
                className="text-danger-text"
                icon={<Trash2 />}
                loading={remove.isPending}
                disabled={deleted || !!inst.marketListing}
                onClick={async () => {
                  const ok = await confirm({
                    title: t('settings.deleteConfirm', { name: inst.hostname }),
                    description: t('settings.deleteConfirmDesc'),
                    danger: true,
                    confirmText: t('settings.deleteForever'),
                    requireText: inst.hostname,
                  });
                  if (ok) remove.mutate();
                }}
              >
                {t('settings.delete')}
              </Button>
            </Row>
          </Card>
        )}
      </div>

      <EgressCard inst={inst} />

      {hasSwap && (
        <Card className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5">
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-fg">SWAP</h3>
            <p className="tabular mt-0.5 text-[13px] text-fg-2">{t('swap.size', { size: formatMemory(inst.swap) })}</p>
            <p className="mt-1.5 text-xs text-fg-3">{t('swap.desc')}</p>
            <p className="mt-0.5 text-xs text-fg-3">{t('swap.keep')}</p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={inst.swapEnabled ? 'success' : 'neutral'} dot>
              {inst.swapEnabled ? t('swap.on') : t('swap.off')}
            </Badge>
            <Button
              variant={inst.swapEnabled ? 'secondary' : 'primary'}
              loading={swap.isPending}
              disabled={deleted || isBusy(inst) || inst.status === 'SUSPENDED'}
              onClick={async () => {
                const enabled = !inst.swapEnabled;
                if (!enabled && !(await confirm({ title: t('swap.disableTitle'), description: t('swap.disableDesc'), confirmText: t('swap.disable') }))) return;
                swap.mutate(enabled);
              }}
            >
              {inst.swapEnabled ? t('swap.disable') : t('swap.enable')}
            </Button>
          </div>
        </Card>
      )}

      {!admin && <TransferDialog inst={inst} open={transferOpen} onClose={() => setTransferOpen(false)} />}

      <Modal
        open={!!newPassword}
        onOpenChange={(o) => !o && setNewPassword(null)}
        title={t('settings.passwordSubmitted')}
        description={t('settings.passwordSubmittedDesc')}
        footer={
          <Button variant="primary" onClick={() => setNewPassword(null)}>
            {t('reinstall.saved')}
          </Button>
        }
      >
        {newPassword && <CodeBlock value={newPassword} />}
      </Modal>
    </div>
  );
}

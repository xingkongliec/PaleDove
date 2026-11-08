import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, RefreshCw, SlidersHorizontal, Wallet } from 'lucide-react';
import { useState } from 'react';
import type { AdminInstanceDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, InputGroup } from '@/components/ui/input';
import { DropdownMenu } from '@/components/ui/menu';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { BatchConfigDialog } from './BatchConfigDialog';

/** 修改单个实例的续费价格（每期），下次续费起生效 */
function RenewPriceDialog({ inst, open, onClose }: { inst: AdminInstanceDTO; open: boolean; onClose: () => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const [price, setPrice] = useState(String(inst.price));
  const save = useMutation({
    mutationFn: () => api.patch(`/admin/instances/${inst.id}`, { price: price.trim() }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['admin-instances'] });
      onClose();
    },
  });
  const valid = price.trim() !== '' && Number(price) >= 0 && Number(price) !== Number(inst.price);
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('adminInstances.priceTitle', { name: inst.hostname })}
      description={t('adminInstances.priceDesc', { cycle: L.billingCycle[inst.billingCycle] })}
      footer={
        <>
          {save.error && <span className="mr-auto text-sm text-danger-text">{errorText(save.error)}</span>}
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
        <FormField
          label={t('overview.renewPrice')}
          description={inst.renewCoupon ? t('adminInstances.priceCoupon', { code: inst.renewCoupon.code, amount: formatMoney(inst.renewPrice, currency) }) : undefined}
        >
          <InputGroup prefix={currency} type="number" min={0} step="0.01" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
        </FormField>
      </form>
    </Modal>
  );
}

/**
 * 实例列表每行的「编辑」菜单：修改续费价格、单独配置、刷新状态。
 * 外层阻止点击冒泡（包括弹窗内的点击），避免触发整行跳转到详情页
 */
export function InstanceRowActions({ inst }: { inst: AdminInstanceDTO }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<'price' | 'config' | null>(null);
  const deleted = inst.status === 'DELETED' || inst.status === 'DELETING';
  const refresh = useMutation({
    mutationFn: () => api.post(`/admin/instances/${inst.id}/actions`, { action: 'sync' }),
    onSuccess: () => {
      toast.success(t('adminInstances.refreshSubmitted'));
      void qc.invalidateQueries({ queryKey: ['admin-instances'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const config = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/admin/instances/${inst.id}`, body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['admin-instances'] });
      setDialog(null);
    },
  });
  return (
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <DropdownMenu
        trigger={
          <Button size="sm" variant="ghost" loading={refresh.isPending}>
            {t('adminInstances.edit')}
            <ChevronDown className="size-3.5 text-fg-3" />
          </Button>
        }
        className="min-w-40"
        items={[
          { label: t('adminInstances.editPrice'), icon: <Wallet />, disabled: deleted, onClick: () => setDialog('price') },
          {
            label: t('adminInstances.configOne'),
            icon: <SlidersHorizontal />,
            disabled: deleted,
            onClick: () => {
              config.reset();
              setDialog('config');
            },
          },
          { label: t('adminInstances.refreshStatus'), icon: <RefreshCw />, disabled: deleted, onClick: () => refresh.mutate() },
        ]}
      />
      {dialog === 'price' && <RenewPriceDialog inst={inst} open onClose={() => setDialog(null)} />}
      {dialog === 'config' && (
        <BatchConfigDialog
          open
          count={1}
          current={inst}
          pending={config.isPending}
          error={config.error ? errorText(config.error) : null}
          onClose={() => setDialog(null)}
          onSubmit={(body) => config.mutate(body)}
        />
      )}
    </span>
  );
}

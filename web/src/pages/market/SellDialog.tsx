import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { MarketMineDTO, MarketSellableDTO } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { daysLeftText, formatCores, formatMemory, formatMoney } from '@/lib/format';
import { useCurrency, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';

/** 手续费：成交价 × 费率，四舍五入到分（与服务端一致） */
export const feeOf = (price: number, rate: number) => Math.round(price * rate) / 100;

/** 出售实例：选择实例、定价、交接方式与可见范围，并预估扣除手续费后的到账金额 */
export function SellDialog({ open, presetId, onClose }: { open: boolean; presetId: number | null; onClose: () => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const { data: cfg } = usePublicConfig();
  const qc = useQueryClient();
  const [instanceId, setInstanceId] = useState<number | null>(null);
  const [price, setPrice] = useState('');
  const [scope, setScope] = useState<'PUBLIC' | 'TARGET'>('PUBLIC');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const sellable = useQuery({ queryKey: ['market-sellable'], queryFn: () => api.get<MarketSellableDTO[]>('/market/sellable'), enabled: open });
  const list = sellable.data ?? [];
  const chosen = list.find((i) => i.id === instanceId) ?? null;

  // 每次打开都从空白表单开始；带着实例 ID 打开时预选该实例
  useEffect(() => {
    if (!open) return;
    setInstanceId(presetId);
    setPrice('');
    setScope('PUBLIC');
    setTarget('');
    setError(null);
  }, [open, presetId]);

  const create = useMutation({
    mutationFn: () => api.post<MarketMineDTO>('/market/listings', { instanceId, price, ...(scope === 'TARGET' ? { target } : {}) }),
    onSuccess: () => {
      toast.success(t('market.listed'));
      for (const key of ['market', 'market-mine', 'market-sellable', 'instance']) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });

  const amount = Number(price);
  const valid = chosen && !chosen.blocker && amount > 0 && (scope === 'PUBLIC' || target.trim() !== '');
  const rate = cfg?.marketFeeRate ?? 0;
  const fee = amount > 0 ? feeOf(amount, rate) : 0;

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t('market.sellTitle')}
      description={t('market.sellDesc')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={() => create.mutate()}>
            {t('market.listNow')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {sellable.data && list.length === 0 ? (
          <Alert tone="warning">{t('market.noInstances')}</Alert>
        ) : (
          <>
            <FormField label={t('market.pickInstance')} required>
              <Select
                value={instanceId}
                onChange={setInstanceId}
                placeholder={t('market.pickInstance')}
                options={list.map((i) => ({
                  value: i.id,
                  label: i.hostname,
                  disabled: !!i.blocker,
                  description: i.blocker ?? `${i.plan ?? L.instanceType[i.type]} · ${formatCores(i.cpu)} ${formatMemory(i.memory)} ${i.disk}GB · ${daysLeftText(i.expiresAt)}`,
                }))}
              />
            </FormField>
            {chosen && (
              <p className="-mt-2 text-xs text-fg-3">
                {t('market.renewHint', { price: formatMoney(chosen.renewPrice, currency), cycle: L.billingCycle[chosen.billingCycle] })}
              </p>
            )}
            <FormField label={t('market.price')} required>
              <InputGroup type="number" min={0} step={0.01} prefix={currency} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
            </FormField>
            {amount > 0 && (
              <p className="-mt-2 text-xs text-fg-3">{t('market.feeHint', { rate, fee: formatMoney(fee, currency), income: formatMoney(Math.max(0, amount - fee), currency) })}</p>
            )}
            <FormField label={t('market.scope')}>
              <Select
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'PUBLIC', label: t('market.scope.PUBLIC'), description: t('market.scopeDesc.PUBLIC') },
                  { value: 'TARGET', label: t('market.scope.TARGET'), description: t('market.scopeDesc.TARGET') },
                ]}
              />
            </FormField>
            {scope === 'TARGET' && (
              <FormField label={t('market.targetUser')} required>
                <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('transfer.targetPlaceholder')} autoComplete="off" />
              </FormField>
            )}
            <Alert tone="primary">{t('market.sellNotice')}</Alert>
            <p className="text-xs leading-relaxed text-fg-3">{t('market.ping.sellHint')}</p>
          </>
        )}
      </div>
    </Modal>
  );
}

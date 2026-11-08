// 转移实例（过户）：用户与管理员共用；从“实例转移”页面新建时先选择实例
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import type { ImageDTO, InstanceDTO, TransferCheckDTO, TransferMode } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { isBusy, useInstanceApiPath, useInvalidateInstance, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useCurrency, useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { connectAddress } from '../console/Instances';

/** 可以转移的实例：状态稳定且没有进行中的任务 */
export const canTransfer = (i: Pick<AnyInstance, 'status' | 'activeTask'>) => ['RUNNING', 'STOPPED', 'ERROR'].includes(i.status) && !isBusy(i as AnyInstance);

export function TransferDialog({
  inst,
  instances,
  open,
  onClose,
  onDone,
  admin = false,
}: {
  /** 要转移的实例；不传时在 instances 中选择 */
  inst?: AnyInstance;
  instances?: InstanceDTO[];
  open: boolean;
  onClose: () => void;
  /** 转移成功后的处理；不传时管理员刷新实例，用户返回实例列表 */
  onDone?: () => void;
  admin?: boolean;
}) {
  const { t, L } = useI18n();
  const [pickedId, setPickedId] = useState<number | null>(null);
  const current: AnyInstance | undefined = inst ?? instances?.find((i) => i.id === pickedId);
  const instancePath = useInstanceApiPath(current?.id ?? 0);
  const invalidate = useInvalidateInstance(current?.id ?? 0);
  const navigate = useNavigate();
  const [target, setTarget] = useState('');
  // 默认全新安装：接收方拿到的是干净的系统和只有自己知道的 root 密码
  const [mode, setMode] = useState<TransferMode>('REINSTALL');
  const [imageId, setImageId] = useState<number | null>(null);
  const [remark, setRemark] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const currency = useCurrency();
  const { data: me } = useMe();
  // 输入接收方账号后稍等片刻再检查账号是否存在、能否接收
  const [checked, setChecked] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setChecked(target.trim()), 400);
    return () => clearTimeout(id);
  }, [target]);
  const check = useQuery({
    queryKey: ['transfer-check', current?.id, checked],
    queryFn: () => api.get<TransferCheckDTO>(`${instancePath}/transfer/check`, { target: checked || undefined }),
    enabled: open && !!current,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  });
  const checking = !!target.trim() && (target.trim() !== checked || check.isFetching);
  const recipientOk = !checking && !!check.data?.recipient;
  const fee = Number(check.data?.fee ?? 0);
  // 全新安装时可选的系统：实例所在宿主机提供的镜像
  const images = useQuery({
    queryKey: ['instance-images', current?.id],
    queryFn: () => api.get<ImageDTO[]>(`${instancePath}/images`),
    enabled: open && mode === 'REINSTALL' && !!current,
  });
  useEffect(() => {
    if (!open) return;
    const first = inst ?? instances?.find(canTransfer);
    setPickedId(first?.id ?? null);
    setTarget('');
    setChecked('');
    setMode('REINSTALL');
    setImageId(first?.image?.id ?? null);
    setRemark('');
    setConfirmText('');
    // 只在打开时重置
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const pick = (id: number) => {
    setPickedId(id);
    setImageId(instances?.find((i) => i.id === id)?.image?.id ?? null);
    setConfirmText('');
  };

  const submit = useMutation({
    mutationFn: () =>
      api.post<{ target: { username: string } }>(`${instancePath}/transfer`, {
        target: target.trim(),
        mode,
        imageId: mode === 'REINSTALL' ? (imageId ?? undefined) : undefined,
        remark: remark.trim() || undefined,
        confirm: confirmText,
      }),
    onSuccess: (r) => {
      toast.success(t('transfer.done', { name: r.target.username }));
      onClose();
      // 用户转出后已无权访问该实例
      if (onDone) onDone();
      else if (admin) invalidate();
      else navigate('/instances');
    },
  });
  const ready = !!current && canTransfer(current) && !!recipientOk && confirmText === current.hostname && (mode === 'KEEP' || !!imageId);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={inst ? t('transfer.title', { name: inst.hostname }) : t('transfer.new')}
      description={t('transfer.desc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" disabled={!ready} loading={submit.isPending} onClick={() => submit.mutate()}>
            {t('transfer.submit')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) submit.mutate();
        }}
      >
        {!inst && (
          <FormField label={t('nav.instances')} required>
            <Select<number>
              value={pickedId ?? 0}
              onChange={pick}
              placeholder={t('terminalPage.pick')}
              options={(instances ?? []).map((i) => ({
                value: i.id,
                label: i.hostname,
                description: [i.image?.name, connectAddress(i), L.instanceStatus[i.status]].filter(Boolean).join(' · '),
                disabled: !canTransfer(i),
              }))}
            />
          </FormField>
        )}
        <FormField label={t('transfer.target')} required>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('transfer.targetPlaceholder')} autoComplete="off" autoFocus={!!inst} />
          {target.trim() && (
            <p className="flex items-center gap-1 text-xs">
              {checking ? (
                <span className="inline-flex items-center gap-1 text-fg-3">
                  <LoaderCircle className="size-3.5 animate-spin" />
                  {t('transfer.checking')}
                </span>
              ) : recipientOk ? (
                <span className="inline-flex items-center gap-1 text-success-text">
                  <CircleCheck className="size-3.5" />
                  {t('transfer.targetOk', { name: check.data!.recipient!.username })}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-danger-text">
                  <CircleX className="size-3.5" />
                  {check.data?.error ?? (check.error ? errorText(check.error) : t('transfer.targetNotFound'))}
                </span>
              )}
            </p>
          )}
        </FormField>
        <FormField label={t('transfer.mode')}>
          <Select<TransferMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: 'KEEP', label: t('transfer.mode.KEEP'), description: t('transfer.modeDesc.KEEP') },
              { value: 'REINSTALL', label: t('transfer.mode.REINSTALL'), description: t('transfer.modeDesc.REINSTALL') },
            ]}
          />
        </FormField>
        {mode === 'REINSTALL' && (
          <FormField label={t('transfer.image')}>
            <Select<number>
              value={imageId ?? 0}
              onChange={setImageId}
              placeholder={t('common.loading')}
              options={(images.data ?? []).map((i) => ({ value: i.id, label: i.name }))}
            />
          </FormField>
        )}
        <FormField label={t('transfer.remark')} description={t('transfer.remarkHint')}>
          <Textarea value={remark} onChange={(e) => setRemark(e.target.value.slice(0, 200))} rows={2} placeholder={t('transfer.remarkPlaceholder')} />
        </FormField>
        {/* 转移费用：始终显示，免费时也写明；收费时附上当前余额 */}
        <div className="flex items-center justify-between gap-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[13px]">
          <span className="text-fg-2">{t('transfer.fee')}</span>
          <span className="text-right">
            {!current || !check.data ? (
              <span className="text-fg-4">—</span>
            ) : fee > 0 ? (
              <>
                <span className="tabular font-semibold text-fg">{formatMoney(fee, currency)}</span>
                {!admin && me && (
                  <span className={cn('ml-2 text-xs', Number(me.balance) < fee ? 'text-danger-text' : 'text-fg-3')}>
                    {t('transfer.feeBalance', { balance: formatMoney(me.balance, currency) })}
                  </span>
                )}
              </>
            ) : (
              <span className="font-medium text-fg">{admin ? t('transfer.feeFreeAdmin') : t('transfer.feeFree')}</span>
            )}
          </span>
        </div>
        <Alert tone="warning">{admin ? t('transfer.noticeAdmin') : fee > 0 ? t('transfer.noticeFee', { fee: formatMoney(fee, currency) }) : t('transfer.notice')}</Alert>
        {current && (
          <FormField label={t('transfer.confirmLabel', { name: current.hostname })}>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder={current.hostname} autoComplete="off" />
          </FormField>
        )}
        {submit.error && <Alert tone="danger">{errorText(submit.error)}</Alert>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

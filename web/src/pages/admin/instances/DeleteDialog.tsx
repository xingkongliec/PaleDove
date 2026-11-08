import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { DeleteRefundMode, DeleteRefundPreviewDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';

const NOTE_MAX = 500;

/**
 * 管理员删除实例：选择退款方式（剩余价值 / 全款 / 不退款）、填写删除原因（用户会收到站内信），
 * 并输入确认文本防止误删。打开时从服务端读取退款预览，列出每个实例的退款金额与合计。
 */
export function DeleteDialog({
  open,
  title,
  confirmText,
  instanceIds,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  confirmText: string;
  /** 要删除的实例，用于计算退款金额 */
  instanceIds: number[];
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (v: { refundMode: DeleteRefundMode; note: string }) => void;
}) {
  const t = useT();
  const currency = useCurrency();
  const [mode, setMode] = useState<DeleteRefundMode>('REMAINING');
  const [note, setNote] = useState('');
  const [typed, setTyped] = useState('');
  const preview = useQuery({
    queryKey: ['admin-refund-preview', instanceIds],
    queryFn: () => api.post<DeleteRefundPreviewDTO>('/admin/instances/refund-preview', { ids: instanceIds }),
    enabled: open && instanceIds.length > 0,
    // 剩余价值随时间变化，每次打开都重新计算
    gcTime: 0,
  });
  const p = preview.data;
  const money = (v: string | number) => formatMoney(v, currency);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={t('delete.desc')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={pending} disabled={typed.trim() !== confirmText} onClick={() => onSubmit({ refundMode: mode, note: note.trim() })}>
            {t('common.delete')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('delete.refund')}>
          <Select
            value={mode}
            onChange={setMode}
            options={[
              { value: 'REMAINING', label: p ? t('delete.remainingWith', { amount: money(p.total.REMAINING) }) : t('delete.remaining'), description: t('delete.remainingDesc') },
              { value: 'FULL', label: p ? t('delete.fullWith', { amount: money(p.total.FULL) }) : t('delete.full'), description: t('delete.fullDesc') },
              { value: 'NONE', label: t('delete.none'), description: t('delete.noneDesc') },
            ]}
          />
        </FormField>

        {/* 退款明细：每个实例在当前退款方式下的金额，多个实例时底部显示合计 */}
        <FormField label={t('delete.refundDetail')}>
          {preview.error ? (
            <p className="text-xs text-danger-text">{t('delete.previewFailed', { error: errorText(preview.error) })}</p>
          ) : !p ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="overflow-hidden rounded-lg border border-line">
              <div className="scrollbar-thin max-h-48 divide-y divide-line overflow-y-auto">
                {p.items.map((i) => (
                  <div key={i.id} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-fg">{i.hostname}</div>
                      <div className="truncate text-xs text-fg-3">{i.username}</div>
                    </div>
                    <span className={cn('tabular shrink-0', Number(i.refund[mode]) > 0 ? 'text-fg' : 'text-fg-4')}>{money(i.refund[mode])}</span>
                  </div>
                ))}
              </div>
              {p.items.length > 1 && (
                <div className="flex items-center justify-between gap-3 border-t border-line bg-surface-2/60 px-3 py-2 text-[13px] font-semibold text-fg">
                  <span>{t('delete.refundTotal', { n: p.items.length })}</span>
                  <span className="tabular">{money(p.total[mode])}</span>
                </div>
              )}
            </div>
          )}
        </FormField>

        <FormField label={t('delete.note')} description={`${t('delete.noteHint')} ${note.length}/${NOTE_MAX}`}>
          <Textarea rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('delete.notePlaceholder')} />
        </FormField>
        <FormField label={t('delete.typeToConfirm', { text: confirmText })}>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={confirmText} autoComplete="off" />
        </FormField>
      </div>
    </Modal>
  );
}

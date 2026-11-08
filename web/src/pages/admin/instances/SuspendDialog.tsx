import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Textarea } from '@/components/ui/input';
import { useT } from '@/i18n';

const NOTE_MAX = 500;

/** 封禁实例：可填写封禁原因（选填，用户在实例页和操作提示中可见） */
export function SuspendDialog({
  open,
  title,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  pending: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={title}
      description={t('suspend.desc')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={pending} onClick={() => onSubmit(note.trim())}>
            {t('suspend.confirm')}
          </Button>
        </>
      }
    >
      <FormField label={t('suspend.note')} description={`${t('suspend.noteHint')} ${note.length}/${NOTE_MAX}`}>
        <Textarea rows={3} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('suspend.notePlaceholder')} autoFocus />
      </FormField>
    </Modal>
  );
}

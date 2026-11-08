import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowRightLeft, Ban, Bell, CircleCheck, Gift, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { BatchResultDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';
import { MigrateDialog } from './MigrateDialog';
import { Alert, Checkbox } from '@/components/ui/misc';
import { usePublicConfig } from '@/lib/queries';
import { BatchConfigDialog } from './BatchConfigDialog';
import { SuspendDialog } from './SuspendDialog';
import { DeleteDialog } from './DeleteDialog';

type Action = 'sync' | 'suspend' | 'unsuspend' | 'delete' | 'extend' | 'config' | 'notify' | 'migrate';
type Dialog = 'extend' | 'config' | 'notify' | 'migrate' | 'suspend' | 'delete' | null;

/** 通知标题与内容的长度上限（与服务端一致） */
const TITLE_MAX = 200;
const CONTENT_MAX = 5000;

/** 实例列表多选后的批量操作栏 */
export function InstanceBatchBar({ ids, onClear }: { ids: number[]; onClear: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [days, setDays] = useState('30');
  // 每次打开批量配置都从空白表单开始
  const [configKey, setConfigKey] = useState(0);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [email, setEmail] = useState(false);
  const { data: site } = usePublicConfig();
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: (payload: { action: Action } & Record<string, unknown>) => api.post<BatchResultDTO>('/admin/instances/batch', { ids, ...payload }),
    onSuccess: (r) => {
      if (r.notified) {
        const n = r.notified;
        toast.success(
          t('batch.notified', { n: n.users }),
          n.mailQueued ? t('batch.mailQueued', { n: n.mailQueued }) : n.mailSent ? t('batch.mailSent', { n: n.mailSent }) : undefined,
        );
        setTitle('');
        setContent('');
        setEmail(false);
      } else if (r.failed.length === 0) toast.success(t('batch.done', { n: r.ok }));
      else
        toast.error(
          t('batch.partial', { ok: r.ok, failed: r.failed.length }),
          r.failed
            .slice(0, 3)
            .map((f) => `${f.hostname}：${f.message}`)
            .join('\n'),
        );
      void qc.invalidateQueries({ queryKey: ['admin-instances'] });
      setDialog(null);
      setError(null);
      onClear();
    },
    onError: (e) => (dialog ? setError(errorText(e)) : toast.fromError(e)),
  });

  const confirmUnsuspend = async () => {
    if (await confirm({ title: t('batch.unsuspendTitle', { n: ids.length }) })) run.mutate({ action: 'unsuspend' });
  };

  const close = () => {
    setDialog(null);
    setError(null);
  };
  const footer = (onSubmit: () => void, disabled = false) => (
    <>
      {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
      <Button onClick={close}>{t('common.cancel')}</Button>
      <Button variant="primary" loading={run.isPending} disabled={disabled} onClick={onSubmit}>
        {t('common.confirm')}
      </Button>
    </>
  );

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5 sm:px-5">
      <span className="mr-auto text-[13px] text-fg-2">{t('batch.selected', { n: ids.length })}</span>
      <Button size="sm" variant="ghost" onClick={onClear}>
        {t('common.cancel')}
      </Button>
      <Button size="sm" icon={<RefreshCw />} loading={run.isPending && run.variables?.action === 'sync'} onClick={() => run.mutate({ action: 'sync' })}>
        {t('batch.sync')}
      </Button>
      <Button size="sm" icon={<Ban />} onClick={() => setDialog('suspend')}>
        {t('batch.suspend')}
      </Button>
      <Button size="sm" icon={<CircleCheck />} onClick={confirmUnsuspend}>
        {t('batch.unsuspend')}
      </Button>
      <Button
        size="sm"
        icon={<Settings2 />}
        onClick={() => {
          setConfigKey((k) => k + 1);
          setDialog('config');
        }}
      >
        {t('batch.config')}
      </Button>
      <Button size="sm" icon={<ArrowRightLeft />} onClick={() => setDialog('migrate')}>
        {t('batch.migrate')}
      </Button>
      <Button size="sm" icon={<Gift />} onClick={() => setDialog('extend')}>
        {t('batch.extend')}
      </Button>
      <Button size="sm" icon={<Bell />} onClick={() => setDialog('notify')}>
        {t('batch.notify')}
      </Button>
      <Button size="sm" variant="danger-ghost" icon={<Trash2 />} onClick={() => setDialog('delete')}>
        {t('batch.delete')}
      </Button>

      <Modal open={dialog === 'extend'} onOpenChange={(o) => !o && close()} title={t('batch.extendTitle', { n: ids.length })} description={t('batch.extendDesc')} footer={footer(() => run.mutate({ action: 'extend', days: Number(days) }), !(Number(days) > 0))}>
        <div className="space-y-3">
          <InputGroup type="number" min={1} suffix={t('batch.daysUnit')} value={days} onChange={(e) => setDays(e.target.value)} aria-label={t('batch.extend')} />
          <div className="flex flex-wrap gap-1.5">
            {[7, 30, 90, 365].map((d) => (
              <Button key={d} size="sm" variant={Number(days) === d ? 'primary' : 'secondary'} onClick={() => setDays(String(d))}>
                {t('batch.daysPreset', { n: d })}
              </Button>
            ))}
          </div>
        </div>
      </Modal>

      {/* 批量删除：选择退款方式、填写删除原因 */}
      <DeleteDialog
        key={dialog === 'delete' ? 'delete-open' : 'delete-closed'}
        open={dialog === 'delete'}
        title={t('batch.deleteTitle', { n: ids.length })}
        confirmText={t('batch.deleteConfirmText', { n: ids.length })}
        instanceIds={ids}
        pending={run.isPending}
        error={error}
        onClose={close}
        onSubmit={(v) => run.mutate({ action: 'delete', ...v })}
      />

      {/* 批量封禁：可填写封禁原因 */}
      <SuspendDialog
        key={dialog === 'suspend' ? 'open' : 'closed'}
        open={dialog === 'suspend'}
        title={t('batch.suspendTitle', { n: ids.length })}
        pending={run.isPending}
        error={error}
        onClose={close}
        onSubmit={(note) => run.mutate({ action: 'suspend', note })}
      />

      <BatchConfigDialog
        key={configKey}
        open={dialog === 'config'}
        count={ids.length}
        pending={run.isPending}
        error={error}
        onClose={close}
        onSubmit={(config) => run.mutate({ action: 'config', config })}
      />

      <MigrateDialog
        open={dialog === 'migrate'}
        onOpenChange={(o) => !o && close()}
        title={t('batch.migrateTitle', { n: ids.length })}
        pending={run.isPending}
        error={error}
        onSubmit={(targetNodeId) => run.mutate({ action: 'migrate', targetNodeId })}
      />

      <Modal
        open={dialog === 'notify'}
        onOpenChange={(o) => !o && close()}
        title={t('batch.notify')}
        footer={
          <>
            {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={run.isPending} disabled={!title.trim() || !content.trim()} onClick={() => run.mutate({ action: 'notify', title, content, email })}>
              {t('batch.notifySend')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Alert tone="primary" title={t('batch.notifyInfo', { n: ids.length })}>
            {t('batch.notifyMailInfo')}
          </Alert>
          <FormField label={t('batch.msgTitle')} description={`${title.length}/${TITLE_MAX}`}>
            <Input value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} placeholder={t('batch.msgTitlePlaceholder')} />
          </FormField>
          <FormField label={t('batch.msgContent')} description={`${content.length}/${CONTENT_MAX}`}>
            <Textarea rows={5} maxLength={CONTENT_MAX} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('batch.msgContentPlaceholder')} />
          </FormField>
          <div className="rounded-lg border border-line bg-surface-2/50 px-3.5 py-3">
            <Checkbox checked={email && !!site?.mailEnabled} disabled={!site?.mailEnabled} onCheckedChange={setEmail} label={<span className="font-medium">{t('batch.notifyEmail')}</span>} />
            <p className="mt-1 pl-6 text-xs text-fg-3">{site?.mailEnabled ? t('batch.notifyEmailDesc') : t('batch.notifyEmailOff')}</p>
          </div>
        </div>
      </Modal>

    </div>
  );
}

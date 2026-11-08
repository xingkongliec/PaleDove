import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, History, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import type { SnapshotDTO } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Card, CardHeader, Empty, ErrorState } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useInstanceApiPath, isBusy, useInvalidateInstance, useMarketLocked, type AnyInstance } from '@/hooks/instances';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate, fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';

export default function Snapshots({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const invalidate = useInvalidateInstance(inst.id);
  const [creating, setCreating] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = isBusy(inst);
  const locked = useMarketLocked(inst);
  const q = useQuery({
    queryKey: ['snapshots', inst.id],
    queryFn: () => api.get<SnapshotDTO[]>(`${instancePath}/snapshots`),
    refetchInterval: busy ? 3000 : false,
  });
  const done = () => {
    invalidate();
    void qc.invalidateQueries({ queryKey: ['snapshots', inst.id] });
  };
  const create = useMutation({
    mutationFn: () => api.post(`${instancePath}/snapshots`, { description }),
    onSuccess: () => {
      toast.success(t('snapshots.createStarted'));
      setCreating(false);
      setDescription('');
      done();
    },
    onError: (e) => setError(errorText(e)),
  });
  const restore = useMutation({
    mutationFn: (id: number) => api.post(`${instancePath}/snapshots/${id}/restore`),
    onSuccess: () => {
      toast.success(t('snapshots.restoreStarted'));
      done();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${instancePath}/snapshots/${id}`),
    onSuccess: () => {
      toast.success(t('snapshots.deleteStarted'));
      done();
    },
    onError: (e) => toast.fromError(e),
  });
  const count = q.data?.length ?? 0;
  const blocked = busy || locked || ['SUSPENDED', 'CREATING', 'DELETED', 'REINSTALLING'].includes(inst.status);

  return (
    <Card>
      <CardHeader
        title={t('detail.tab.snapshots')}
        icon={<Camera />}
        description={t('snapshots.desc', { used: count, limit: inst.snapshotLimit })}
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus />}
            disabled={blocked || count >= inst.snapshotLimit}
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            {t('snapshots.create')}
          </Button>
        }
      />
      {inst.snapshotLimit === 0 ? (
        <Empty title={t('snapshots.unsupported')} icon={<Camera />} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(s) => s.id}
          empty={<Empty title={t('snapshots.empty')} description={t('snapshots.emptyDesc')} icon={<Camera />} />}
          columns={[
            { key: 'name', header: t('common.name'), cell: (s) => <span className="font-mono text-xs text-fg">{s.name}</span> },
            { key: 'desc', header: t('common.remark'), cell: (s) => <span className="text-fg-2">{s.description || '—'}</span> },
            {
              key: 'time',
              header: t('common.createdAt'),
              cell: (s) => (
                <span className="text-xs">
                  {formatDate(s.createdAt)} <span className="text-fg-3">· {fromNow(s.createdAt)}</span>
                </span>
              ),
            },
            {
              key: 'actions',
              header: '',
              className: 'w-44 text-right',
              cell: (s) => (
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<History />}
                    disabled={blocked}
                    onClick={async () => {
                      if (await confirm({ title: t('snapshots.restoreTitle', { name: s.name }), description: t('snapshots.restoreDesc'), danger: true, confirmText: t('snapshots.restore') }))
                        restore.mutate(s.id);
                    }}
                  >
                    {t('snapshots.restore')}
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={t('common.delete')}
                    disabled={blocked}
                    onClick={async () => {
                      if (await confirm({ title: t('snapshots.deleteTitle', { name: s.name }), danger: true, confirmText: t('common.delete') })) remove.mutate(s.id);
                    }}
                  >
                    <Trash />
                  </Button>
                </div>
              ),
            },
          ]}
        />
      )}
      <Modal
        open={creating}
        onOpenChange={setCreating}
        title={t('snapshots.create')}
        description={t('snapshots.createDesc')}
        footer={
          <>
            <Button onClick={() => setCreating(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
              {t('common.create')}
            </Button>
          </>
        }
      >
        <FormField label={`${t('common.remark')}${t('common.optionalSuffix')}`}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={100} placeholder={t('snapshots.remarkPlaceholder')} />
        </FormField>
        {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      </Modal>
    </Card>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HardDrive, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import { isVmType, type StoragePoolDTO, type VolumeDTO } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Alert, Card, CardHeader, Empty, ErrorState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { useInstanceApiPath, useInvalidateInstance, type AnyInstance } from '@/hooks/instances';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatBytes, formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

/** 添加数据盘：只列出该宿主机上「存储盘」用途的存储池 */
function AddDiskDialog({ inst, nodeId, onClose }: { inst: AnyInstance; nodeId: number; onClose: () => void }) {
  const instancePath = useInstanceApiPath(inst.id);
  const t = useT();
  const qc = useQueryClient();
  const invalidate = useInvalidateInstance(inst.id);
  const vm = isVmType(inst.type);
  const pools = useQuery({
    queryKey: ['node-pools', nodeId],
    queryFn: () => api.get<StoragePoolDTO[]>(`/admin/nodes/${nodeId}/storage-pools`),
  });
  const dataPools = (pools.data ?? []).filter((p) => p.usage === 'data');
  const [pool, setPool] = useState<string | null>(null);
  const [size, setSize] = useState('20');
  const [path, setPath] = useState('/mnt/data');
  const [error, setError] = useState<string | null>(null);
  const selected = pool ?? dataPools[0]?.name ?? null;
  const add = useMutation({
    mutationFn: () => api.post(`${instancePath}/volumes`, { pool: selected, size: Number(size), path: vm ? undefined : path }),
    onSuccess: () => {
      toast.success(t('disks.added'));
      invalidate();
      void qc.invalidateQueries({ queryKey: ['volumes', inst.id] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('disks.add')}
      description={vm ? t('disks.addDescVm') : t('disks.addDescCt')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={add.isPending} disabled={!selected || !(Number(size) > 0) || (!vm && !path.trim())} onClick={() => add.mutate()}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      {pools.isLoading ? null : dataPools.length === 0 ? (
        <Alert tone="warning">{t('disks.noDataPool')}</Alert>
      ) : (
        <div className="space-y-4">
          <FormField label={t('disks.pool')}>
            <Select
              value={selected}
              onChange={setPool}
              options={dataPools.map((p) => ({
                value: p.name,
                label: `${p.name} · ${p.driver}`,
                description: p.space ? t('disks.poolFree', { free: formatBytes(p.space.total - p.space.used) }) : undefined,
              }))}
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label={t('disks.size')}>
              <InputGroup type="number" min={1} suffix="GiB" value={size} onChange={(e) => setSize(e.target.value)} />
            </FormField>
            {!vm && (
              <FormField label={t('disks.path')}>
                <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" placeholder="/mnt/data" />
              </FormField>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 实例数据盘：用户可查看，管理员可添加与删除 */
export default function Disks({ inst, admin }: { inst: AnyInstance; admin?: boolean }) {
  const instancePath = useInstanceApiPath(inst.id);
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const invalidate = useInvalidateInstance(inst.id);
  const [adding, setAdding] = useState(false);
  const vm = isVmType(inst.type);
  const q = useQuery({ queryKey: ['volumes', inst.id], queryFn: () => api.get<VolumeDTO[]>(`${instancePath}/volumes`) });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${instancePath}/volumes/${id}`),
    onSuccess: () => {
      toast.success(t('disks.removed'));
      invalidate();
      void qc.invalidateQueries({ queryKey: ['volumes', inst.id] });
    },
    onError: (e) => toast.fromError(e),
  });
  const nodeId = admin && 'node' in inst ? inst.node.id : null;
  return (
    <Card>
      <CardHeader
        title={t('disks.title')}
        icon={<HardDrive />}
        description={vm ? t('disks.descVm') : t('disks.descCt')}
        actions={
          nodeId !== null && (
            <Button variant="primary" size="sm" icon={<Plus />} disabled={inst.status === 'CREATING'} onClick={() => setAdding(true)}>
              {t('disks.add')}
            </Button>
          )
        }
      />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(v) => v.id}
          empty={<Empty title={t('disks.empty')} description={admin ? undefined : t('disks.emptyUser')} icon={<HardDrive />} />}
          columns={[
            { key: 'device', header: t('disks.device'), cell: (v) => <span className="font-mono text-xs text-fg">{v.device}</span> },
            { key: 'size', header: t('disks.size'), cell: (v) => <span className="tabular">{v.size} GiB</span> },
            {
              key: 'path',
              header: vm ? t('disks.attachedAs') : t('disks.path'),
              cell: (v) => (v.path ? <span className="font-mono text-xs">{v.path}</span> : <span className="text-xs text-fg-3">{t('disks.blockDevice')}</span>),
            },
            ...(admin ? [{ key: 'pool', header: t('disks.pool'), cell: (v: VolumeDTO) => <span className="font-mono text-xs text-fg-2">{`${v.pool}/${v.name}`}</span> }] : []),
            { key: 'created', header: t('common.createdAt'), cell: (v) => <span className="text-xs text-fg-2">{formatDate(v.createdAt)}</span> },
            ...(admin
              ? [
                  {
                    key: 'actions',
                    header: '',
                    className: 'w-12',
                    cell: (v: VolumeDTO) => (
                      <Button
                        size="icon-sm"
                        variant="danger-ghost"
                        aria-label={t('common.delete')}
                        onClick={async () => {
                          if (await confirm({ title: t('disks.removeTitle', { device: v.device }), description: t('disks.removeDesc'), danger: true, requireText: v.device })) remove.mutate(v.id);
                        }}
                      >
                        <Trash />
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {adding && nodeId !== null && <AddDiskDialog inst={inst} nodeId={nodeId} onClose={() => setAdding(false)} />}
    </Card>
  );
}

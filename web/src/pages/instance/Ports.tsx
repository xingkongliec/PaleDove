import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Network, Pencil, Plus, Trash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PORT_PROTOCOLS, portQuotaCost, portQuotaUsed, type PortMappingDTO, type PortProtocol } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Badge, Card, CardHeader, CopyButton, Empty, ErrorState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { useInstanceApiPath, useMarketLocked, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { toast } from '@/lib/toast';

/** 添加端口映射；传入 choices 时在顶部选择实例（端口映射汇总页） */
export function AddPortDialog({ inst: initial, choices, onClose }: { inst: AnyInstance; choices?: AnyInstance[]; onClose: () => void }) {
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const [instId, setInstId] = useState(initial.id);
  const inst = choices?.find((c) => c.id === instId) ?? initial;
  const instancePath = useInstanceApiPath(inst.id);
  const [protocol, setProtocol] = useState<PortProtocol>('TCP_UDP');
  const [privatePort, setPrivatePort] = useState('');
  const [publicPort, setPublicPort] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  // 剩余配额：TCP+UDP 占 2 个，剩 1 个时只能选单一协议
  const existing = useQuery({ queryKey: ['ports', inst.id], queryFn: () => api.get<PortMappingDTO[]>(`${instancePath}/ports`) });
  const left = existing.data ? inst.portLimit - portQuotaUsed(existing.data) : null;
  const fits = (p: PortProtocol) => left === null || portQuotaCost(p) <= left;
  useEffect(() => {
    if (left !== null && !fits(protocol)) setProtocol('TCP');
    // 配额数据到达后检查一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);
  const add = useMutation({
    mutationFn: () =>
      api.post<PortMappingDTO>(`${instancePath}/ports`, {
        protocol,
        privatePort: Number(privatePort),
        publicPort: publicPort ? Number(publicPort) : undefined,
        description: description || undefined,
      }),
    onSuccess: (m) => {
      toast.success(t('ports.added'), `${inst.publicIp}:${m.publicPort} → ${m.privatePort}`);
      void qc.invalidateQueries({ queryKey: ['ports', inst.id] });
      void qc.invalidateQueries({ queryKey: ['instance', inst.id] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('ports.addTitle')}
      description={inst.portRange ? t('ports.range', { start: inst.portRange.start, end: inst.portRange.end }) : undefined}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={add.isPending} disabled={!privatePort} onClick={() => add.mutate()}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {choices && (
          <FormField label={t('common.instance')}>
            <Select value={instId} onChange={setInstId} options={choices.map((c) => ({ value: c.id, label: `${c.hostname} · ${c.name}` }))} />
          </FormField>
        )}
        <FormField label={t('ports.protocol')} description={left !== null ? t('ports.quotaLeft', { n: left }) : undefined}>
          <Select
            value={protocol}
            onChange={setProtocol}
            options={PORT_PROTOCOLS.map((p) => ({ value: p, label: L.portProtocol[p], description: t('ports.quotaCost', { n: portQuotaCost(p) }), disabled: !fits(p) }))}
          />
        </FormField>
        <div className="grid grid-cols-2 gap-4">
          <FormField label={t('ports.privatePort')} required description={t('ports.privatePortHint')}>
            <Input type="number" min={1} max={65535} value={privatePort} onChange={(e) => setPrivatePort(e.target.value)} placeholder="80" />
          </FormField>
          <FormField label={t('ports.publicPort')} description={t('ports.publicPortHint')}>
            <Input type="number" value={publicPort} onChange={(e) => setPublicPort(e.target.value)} placeholder={t('ports.auto')} />
          </FormField>
        </div>
        <FormField label={t('common.remark')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={64} placeholder={t('ports.remarkPlaceholder')} />
        </FormField>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

/** 修改端口映射的备注 */
function EditRemarkDialog({ inst, mapping, onClose }: { inst: AnyInstance; mapping: PortMappingDTO; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const instancePath = useInstanceApiPath(inst.id);
  const [description, setDescription] = useState(mapping.description ?? '');
  const save = useMutation({
    mutationFn: () => api.patch<PortMappingDTO>(`${instancePath}/ports/${mapping.id}`, { description: description.trim() || null }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void qc.invalidateQueries({ queryKey: ['ports', inst.id] });
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(o) => !o && onClose()}
      title={t('ports.editRemark')}
      description={`${inst.publicIp ?? ''}:${mapping.publicPort} → ${mapping.privatePort}`}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={64} placeholder={t('ports.remarkPlaceholder')} autoFocus />
    </Modal>
  );
}

export default function Ports({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<PortMappingDTO | null>(null);
  const q = useQuery({ queryKey: ['ports', inst.id], queryFn: () => api.get<PortMappingDTO[]>(`${instancePath}/ports`) });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${instancePath}/ports/${id}`),
    onSuccess: () => {
      toast.success(t('ports.deleted'));
      void qc.invalidateQueries({ queryKey: ['ports', inst.id] });
      void qc.invalidateQueries({ queryKey: ['instance', inst.id] });
    },
    onError: (e) => toast.fromError(e),
  });
  // 已用配额：TCP+UDP 计 2 个
  const used = portQuotaUsed(q.data ?? []);
  const locked = useMarketLocked(inst);
  const blocked = locked || inst.status === 'SUSPENDED' || inst.status === 'DELETED' || inst.status === 'CREATING';

  return (
    <Card>
      <CardHeader
        title={t('detail.tab.ports')}
        icon={<Network />}
        description={t('ports.desc', { ip: inst.publicIp ?? '', used, limit: inst.portLimit })}
        actions={
          <Button variant="primary" size="sm" icon={<Plus />} disabled={blocked || used >= inst.portLimit} onClick={() => setAdding(true)}>
            {t('ports.add')}
          </Button>
        }
      />
      {q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(m) => m.id}
          empty={<Empty title={t('ports.empty')} description={t('ports.emptyDesc')} icon={<Network />} />}
          columns={[
            {
              key: 'rule',
              header: t('ports.rule'),
              mobile: 'title',
              cell: (m) => (
                <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs">
                  <span className="inline-flex items-center gap-1 text-fg">
                    {inst.publicIp}:{m.publicPort}
                    <CopyButton value={`${inst.publicIp}:${m.publicPort}`} />
                  </span>
                  <ArrowRight className="size-3 text-fg-3" />
                  <span className="text-fg-2">
                    {inst.privateIp}:{m.privatePort}
                  </span>
                </span>
              ),
            },
            { key: 'proto', header: t('ports.protocol'), cell: (m) => <Badge>{L.portProtocol[m.protocol]}</Badge> },
            {
              key: 'desc',
              header: t('common.remark'),
              cell: (m) => (
                <span className="text-fg-2">
                  {m.description || '—'}
                  {m.system && (
                    <Badge tone="primary" className="ml-2">
                      {t('common.system')}
                    </Badge>
                  )}
                </span>
              ),
            },
            { key: 'created', header: t('common.createdAt'), cell: (m) => <span className="text-xs text-fg-3">{formatDate(m.createdAt)}</span> },
            {
              key: 'actions',
              header: '',
              className: 'w-20',
              cell: (m) =>
                !m.system && (
                  <div className="flex justify-end gap-0.5">
                  <Button size="icon-sm" variant="ghost" aria-label={t('ports.editRemark')} disabled={blocked} onClick={() => setEditing(m)}>
                    <Pencil />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="danger-ghost"
                    aria-label={t('common.delete')}
                    disabled={blocked || remove.isPending}
                    onClick={async () => {
                      if (await confirm({ title: t('ports.deleteTitle', { from: m.publicPort, to: m.privatePort }), danger: true, confirmText: t('common.delete') }))
                        remove.mutate(m.id);
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
      {adding && <AddPortDialog inst={inst} onClose={() => setAdding(false)} />}
      {editing && <EditRemarkDialog inst={inst} mapping={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

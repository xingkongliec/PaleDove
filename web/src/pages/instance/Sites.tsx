import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Globe, Plus, Trash } from 'lucide-react';
import { useState } from 'react';
import type { SiteBindingDTO } from '../../shared/index';
import { SiteStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Card, CardHeader, Empty, ErrorState, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { useInstanceApiPath, useMarketLocked, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';

/** 绑定网站；传入 choices 时在顶部选择实例（网站绑定汇总页） */
export function AddSiteDialog({ inst: initial, choices, onClose }: { inst: AnyInstance; choices?: AnyInstance[]; onClose: () => void }) {
  const { t, rich } = useI18n();
  const qc = useQueryClient();
  const [instId, setInstId] = useState(initial.id);
  const inst = choices?.find((c) => c.id === instId) ?? initial;
  const instancePath = useInstanceApiPath(inst.id);
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState('80');
  const [https, setHttps] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => api.post<SiteBindingDTO>(`${instancePath}/sites`, { domain, targetPort: Number(port), https }),
    onSuccess: (s) => {
      if (s.status === 'ACTIVE') toast.success(t('sites.bound'), s.domain);
      else toast.info(t('sites.added'), s.lastError ?? t('sites.pendingHint'));
      void qc.invalidateQueries({ queryKey: ['sites', inst.id] });
      void qc.invalidateQueries({ queryKey: ['instance', inst.id] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('sites.addTitle')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={add.isPending} disabled={!domain} onClick={() => add.mutate()}>
            {t('sites.bind')}
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
        <Alert tone="primary">{rich('sites.dnsHint', { ip: <b className="font-mono">{inst.publicIp}</b> })}</Alert>
        <FormField label={t('common.domain')} required>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="www.example.com" autoFocus />
        </FormField>
        <FormField label={t('sites.targetPort')} description={t('sites.targetPortHint')}>
          <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} />
        </FormField>
        <Switch checked={https} onCheckedChange={setHttps} label={t('sites.https')} description={t('sites.httpsHint')} />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

export default function Sites({ inst }: { inst: AnyInstance }) {
  const instancePath = useInstanceApiPath(inst.id);
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: ['sites', inst.id],
    queryFn: () => api.get<SiteBindingDTO[]>(`${instancePath}/sites`),
    refetchInterval: (query) => (query.state.data?.some((s) => s.status === 'PENDING') ? 5000 : false),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`${instancePath}/sites/${id}`),
    onSuccess: () => {
      toast.success(t('sites.deleted'));
      void qc.invalidateQueries({ queryKey: ['sites', inst.id] });
    },
    onError: (e) => toast.fromError(e),
  });
  const toggleHttps = useMutation({
    mutationFn: (s: SiteBindingDTO) => api.patch(`${instancePath}/sites/${s.id}`, { https: !s.https }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['sites', inst.id] }),
    onError: (e) => toast.fromError(e),
  });
  const count = q.data?.length ?? 0;
  const locked = useMarketLocked(inst);
  const blocked = locked || inst.status === 'SUSPENDED' || inst.status === 'DELETED';

  return (
    <Card>
      <CardHeader
        title={t('detail.tab.sites')}
        icon={<Globe />}
        description={t('sites.desc', { used: count, limit: inst.siteLimit })}
        actions={
          <Button variant="primary" size="sm" icon={<Plus />} disabled={blocked || count >= inst.siteLimit} onClick={() => setAdding(true)}>
            {t('sites.addTitle')}
          </Button>
        }
      />
      {inst.siteLimit === 0 ? (
        <Empty title={t('sites.unsupported')} icon={<Globe />} />
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(s) => s.id}
          empty={<Empty title={t('sites.empty')} description={t('sites.emptyDesc', { ip: inst.publicIp ?? '' })} icon={<Globe />} />}
          columns={[
            {
              key: 'domain',
              header: t('common.domain'),
              cell: (s) => (
                <a
                  href={`${s.https ? 'https' : 'http'}://${s.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 font-medium break-all text-fg hover:underline hover:underline-offset-4"
                >
                  {s.domain}
                  <ExternalLink className="size-3 shrink-0" />
                </a>
              ),
            },
            {
              key: 'target',
              header: t('sites.target'),
              cell: (s) => (
                <span className="font-mono text-xs">
                  {inst.privateIp}:{s.targetPort}
                </span>
              ),
            },
            {
              key: 'https',
              header: 'HTTPS',
              cell: (s) => <Switch checked={s.https} disabled={blocked || toggleHttps.isPending} onCheckedChange={() => toggleHttps.mutate(s)} />,
            },
            {
              key: 'status',
              header: t('common.status'),
              mobile: 'full',
              cell: (s) => (
                <div className="max-w-72">
                  <SiteStatusBadge status={s.status} />
                  {s.lastError && <p className="mt-1 text-xs break-words text-fg-3">{s.lastError}</p>}
                </div>
              ),
            },
            {
              key: 'actions',
              header: '',
              className: 'w-12',
              cell: (s) => (
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  aria-label={t('common.delete')}
                  onClick={async () => {
                    if (await confirm({ title: t('sites.deleteTitle', { domain: s.domain }), danger: true, confirmText: t('sites.unbind') })) remove.mutate(s.id);
                  }}
                >
                  <Trash />
                </Button>
              ),
            },
          ]}
        />
      )}
      {adding && <AddSiteDialog inst={inst} onClose={() => setAdding(false)} />}
    </Card>
  );
}

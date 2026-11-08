import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import type { NodeDTO, ProxySiteDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';

/** 新建或编辑宿主机上的站点反代（宿主机详情页使用） */
export function SiteDialog({ site, nodes, defaultNode, onClose }: { site?: ProxySiteDTO; nodes: NodeDTO[]; defaultNode?: number; onClose: () => void }) {
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const [nodeId, setNodeId] = useState<number | null>(site?.node.id ?? defaultNode ?? nodes[0]?.id ?? null);
  const [domain, setDomain] = useState(site?.domain ?? '');
  const [upstream, setUpstream] = useState(site?.upstream ?? '');
  const [https, setHttps] = useState(site?.https ?? true);
  const [remark, setRemark] = useState(site?.remark ?? '');
  const [error, setError] = useState<string | null>(null);
  const node = nodes.find((n) => n.id === nodeId);
  const save = useMutation({
    mutationFn: () =>
      site
        ? api.patch<ProxySiteDTO>(`/admin/proxy-sites/${site.id}`, { domain, upstream, https, remark: remark || null })
        : api.post<ProxySiteDTO>('/admin/proxy-sites', { nodeId, domain, upstream, https, remark: remark || undefined }),
    onSuccess: (s) => {
      if (s.status === 'ACTIVE') toast.success(t('sitesAdmin.saved'), s.domain);
      else toast.info(t('sitesAdmin.savedPending'), s.lastError ?? undefined);
      void qc.invalidateQueries({ queryKey: ['proxy-sites'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={site ? t('sitesAdmin.editTitle', { domain: site.domain }) : t('sitesAdmin.add')}
      description={t('sitesAdmin.dialogDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!nodeId || !domain || !upstream} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('common.node')} required>
          <Select
            value={nodeId}
            onChange={setNodeId}
            disabled={!!site}
            options={nodes.map((n) => ({ value: n.id, label: `${n.name} · ${L.caddyStatus[n.caddyStatus]}` }))}
          />
        </FormField>
        {node && node.caddyStatus !== 'READY' && (
          <Alert tone="warning">
            {t('sitesAdmin.caddyNotReady')}{' '}
            <Link to={`/admin/nodes/${node.id}`} className="font-medium underline underline-offset-2">
              {t('sitesAdmin.goInstallCaddy')}
            </Link>
          </Alert>
        )}
        {node?.publicIp && <Alert tone="primary">{t('sitesAdmin.dnsHint', { ip: node.publicIp })}</Alert>}
        <FormField label={t('common.domain')} required>
          <Input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="app.example.com" />
        </FormField>
        <FormField label={t('common.upstream')} required description={t('sitesAdmin.upstreamHint')}>
          <Input value={upstream} onChange={(e) => setUpstream(e.target.value)} className="font-mono text-xs" placeholder="10.88.0.20:8080" />
        </FormField>
        <Switch checked={https} onCheckedChange={setHttps} label={t('sites.https')} description={t('sites.httpsHint')} />
        <FormField label={t('common.remark')}>
          <Input value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={200} />
        </FormField>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Terminal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { InstallCommandDTO, NodeDTO } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';
import { NodeInstallSteps } from './InstallCommand';
import { FormFooter, HostFields, hostPayload, NetworkFields, NODE_NAME, nodeToForm } from './NodeForm';

/** 生成安装脚本后：执行脚本 → 验证并连接；等待期间轮询安装脚本的回调结果 */
function InstallStage({ created }: { created: { node: NodeDTO; install: InstallCommandDTO } }) {
  const { t } = useI18n();
  const [install, setInstall] = useState<InstallCommandDTO | null>(created.install);
  const poll = useQuery({
    queryKey: ['admin-node', created.node.id],
    queryFn: () => api.get<NodeDTO>(`/admin/nodes/${created.node.id}`),
    initialData: created.node,
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? 3000 : false),
  });
  const regen = useMutation({
    mutationFn: (regenerate: boolean) => api.post<InstallCommandDTO>(`/admin/nodes/${created.node.id}/install-command`, { regenerate }),
    onMutate: () => setInstall(null),
    onSuccess: setInstall,
    onError: (e) => toast.fromError(e),
  });
  const node = poll.data;
  const connected = node.status !== 'PENDING';
  return (
    <div>
      <Card>
        <CardHeader title={t('nodes.installScript')} icon={<Terminal />} description={t('nodes.installScriptDesc', { name: node.name })} />
        <CardBody>
          <NodeInstallSteps node={node} install={install} onGenerate={(r) => regen.mutate(r)} regenerating={regen.isPending} error={regen.error} />
        </CardBody>
      </Card>
      <div className="mt-5 flex justify-end gap-2">
        <LinkButton to="/admin/nodes">{t('nodes.backToList')}</LinkButton>
        <LinkButton to={`/admin/nodes/${node.id}`} variant={connected ? 'primary' : 'secondary'}>
          {t('nodes.viewHost')}
        </LinkButton>
      </div>
    </div>
  );
}

export default function AdminNodeCreate() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [form, setForm] = useState(nodeToForm());
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ node: NodeDTO; install: InstallCommandDTO } | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ node: NodeDTO; install: InstallCommandDTO }>('/admin/nodes', hostPayload(form)),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
      setCreated(r);
      // 桌面端在内容面板内滚动，手机端滚动窗口
      document.querySelector('main')?.parentElement?.scrollTo({ top: 0, behavior: 'smooth' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },
    onError: (e) => setError(errorText(e)),
  });

  const missing = !form.name || !form.address.trim() || !form.country;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!NODE_NAME.test(form.name)) return setError(t('nodeForm.nameHint'));
    create.mutate();
  };

  const back = { to: '/admin/nodes', label: t('nav.admin.nodes') };

  if (created) {
    return (
      <>
        <PageHeader back={back} title={t('nodes.installTitle', { name: created.node.name })} description={t('nodes.installDesc')} />
        <InstallStage created={created} />
      </>
    );
  }

  return (
    <>
      <PageHeader back={back} title={t('nodes.add')} description={t('nodes.addDesc')} />
      <form onSubmit={submit}>
        <Card className="overflow-hidden">
          <HostFields value={form} onChange={setForm} />
          <NetworkFields value={form} onChange={setForm} />
          <FormFooter>
            {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
            <LinkButton to="/admin/nodes">{t('common.cancel')}</LinkButton>
            <Button type="submit" variant="primary" icon={<Terminal />} loading={create.isPending} disabled={missing}>
              {t('nodes.generateScript')}
            </Button>
          </FormFooter>
        </Card>
      </form>
    </>
  );
}

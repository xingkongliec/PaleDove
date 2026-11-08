import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Trash } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import type { NodeDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Card, CardBody } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { AdvancedFields, FormFooter, formToPayload, HostFields, NetworkFields, nodeToForm } from './NodeForm';

/** 宿主机详情页的「编辑」标签：保存后停留在本页 */
export function NodeSettings({ node }: { node: NodeDTO }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [initial, setInitial] = useState(() => nodeToForm(node));
  const [form, setForm] = useState(initial);
  // 只有内容变化后才允许保存
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  const save = useMutation({
    mutationFn: () => api.patch<NodeDTO>(`/admin/nodes/${node.id}`, formToPayload(form)),
    onSuccess: (dto) => {
      toast.success(t('nodeDetail.saved'));
      // 以服务端规范化后的值（如对齐后的子网、默认地区名）作为新的初始值
      const next = nodeToForm(dto);
      setInitial(next);
      setForm(next);
      qc.setQueryData(['admin-node', node.id], dto);
      void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/nodes/${node.id}`),
    onSuccess: () => {
      toast.success(t('nodeDetail.deleted'));
      void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
      navigate('/admin/nodes', { replace: true });
    },
    onError: (e) => toast.fromError(e),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty) save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Card className="overflow-hidden">
        <HostFields value={form} onChange={setForm} />
        <NetworkFields value={form} onChange={setForm} />
        <AdvancedFields value={form} onChange={setForm} endpoint={node.endpoint} />
        <FormFooter>
          {dirty && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-fg-3">
              <span className="size-1.5 rounded-full bg-warning" />
              {t('common.unsaved')}
            </span>
          )}
          <Button disabled={!dirty} onClick={() => setForm(initial)}>
            {t('nodeDetail.discard')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!dirty}>
            {t('common.saveChanges')}
          </Button>
        </FormFooter>
      </Card>

      {/* 危险操作 */}
      <Card className="border-danger/30">
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h4 className="text-sm font-semibold text-fg">{t('common.dangerZone')}</h4>
            <p className="mt-1 text-xs leading-relaxed text-fg-3">{t('nodeDetail.deleteDesc')}</p>
          </div>
          <Button
            variant="danger-ghost"
            icon={<Trash />}
            loading={remove.isPending}
            className="shrink-0 self-start sm:self-auto"
            onClick={async () => {
              if (await confirm({ title: t('nodeDetail.deleteTitle', { name: node.name }), description: t('nodeDetail.deleteDesc'), danger: true, requireText: node.name })) {
                remove.mutate();
              }
            }}
          >
            {t('nodeDetail.delete')}
          </Button>
        </CardBody>
      </Card>
    </form>
  );
}

/** 旧的独立编辑页地址：跳转到详情页的「编辑」标签 */
export default function AdminNodeEdit() {
  const { id } = useParams();
  return <Navigate to={`/admin/nodes/${id}?tab=edit`} replace />;
}

// 个人 API 令牌：从脚本、CI 调用控制台接口，权限为完整（与账号相同）或只读；明文只在创建时显示一次
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { ApiTokenDTO } from '../shared/index';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Card, CardBody, CardHeader, CodeBlock, CopyButton, Empty, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { formatDate, fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';

export function ApiTokensCard() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get<ApiTokenDTO[]>('/tokens') });
  const [form, setForm] = useState<{ name: string; expiresInDays: string; access: 'full' | 'read' } | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const origin = window.location.origin;
  const reload = () => void qc.invalidateQueries({ queryKey: ['api-tokens'] });
  const create = useMutation({
    mutationFn: () =>
      api.post<ApiTokenDTO & { token: string }>('/tokens', {
        name: form!.name.trim(),
        expiresInDays: form!.expiresInDays === 'never' ? null : Number(form!.expiresInDays),
        readOnly: form!.access === 'read',
      }),
    onSuccess: (r) => {
      setForm(null);
      setCreated(r.token);
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = async (tk: ApiTokenDTO) => {
    if (!(await confirm({ title: t('account.tokens.deleteTitle', { name: tk.name }), description: t('account.tokens.deleteDesc'), danger: true, confirmText: t('common.delete') }))) return;
    try {
      await api.delete(`/tokens/${tk.id}`);
      toast.success(t('account.tokens.deleted'));
      reload();
    } catch (e) {
      toast.fromError(e);
    }
  };
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title={t('account.nav.tokens')}
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setForm({ name: '', expiresInDays: '90', access: 'read' })}>
              {t('account.tokens.create')}
            </Button>
          }
        />
        <p className="border-b border-line px-5 py-3 text-xs leading-relaxed text-fg-3">{t('account.tokens.desc')}</p>
        <DataTable
          rows={q.data}
          loading={q.isLoading}
          rowKey={(tk) => tk.id}
          empty={<Empty icon={<KeyRound />} title={t('account.tokens.empty')} />}
          columns={[
            {
              key: 'name',
              header: t('account.tokens.name'),
              cell: (tk) => (
                <div>
                  <div className="flex items-center gap-1.5 font-medium">
                    {tk.name}
                    <Tag tone={tk.readOnly ? 'neutral' : 'warning'}>{tk.readOnly ? t('account.tokens.readOnly') : t('account.tokens.fullAccess')}</Tag>
                  </div>
                  <div className="font-mono text-xs text-fg-3" translate="no">
                    {tk.prefix}…
                  </div>
                </div>
              ),
            },
            {
              key: 'used',
              header: t('account.tokens.lastUsed'),
              cell: (tk) =>
                tk.lastUsedAt ? (
                  <span className="text-xs">
                    {fromNow(tk.lastUsedAt)}
                    <div className="font-mono text-fg-3">{tk.lastUsedIp}</div>
                  </span>
                ) : (
                  <span className="text-xs text-fg-3">{t('account.tokens.neverUsed')}</span>
                ),
            },
            { key: 'exp', header: t('account.tokens.expiresAt'), cell: (tk) => <span className="text-xs tabular-nums">{tk.expiresAt ? formatDate(tk.expiresAt) : t('account.tokens.forever')}</span> },
            { key: 'created', header: t('account.tokens.createdAt'), cell: (tk) => <span className="text-xs tabular-nums">{formatDate(tk.createdAt)}</span> },
            {
              key: 'actions',
              header: '',
              className: 'text-right',
              cell: (tk) => (
                <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => remove(tk)}>
                  {t('common.delete')}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card>
        <CardHeader
          title={t('account.tokens.example')}
          actions={
            <LinkButton to="/docs/api" size="sm" icon={<BookOpen className="size-3.5" />}>
              {t('apiDocs.open')}
            </LinkButton>
          }
        />
        <CardBody className="space-y-3 text-[13px]">
          <p className="text-fg-3">{t('account.tokens.exampleHeader')}</p>
          <CodeBlock value={`curl -H "Authorization: Bearer pd_${t('account.tokens.yourToken')}" ${origin}/api/instances`} />
          <p className="text-fg-3">{t('account.tokens.exampleRestart')}</p>
          <CodeBlock value={`curl -X POST -H "Authorization: Bearer pd_${t('account.tokens.yourToken')}" -H "Content-Type: application/json" \\\n  -d '{"action":"restart"}' ${origin}/api/instances/${t('account.tokens.instanceId')}/power`} />
        </CardBody>
      </Card>

      <Modal
        open={!!form}
        onOpenChange={(o) => !o && setForm(null)}
        title={t('account.tokens.createTitle')}
        footer={
          <>
            <Button onClick={() => setForm(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={create.isPending} disabled={!form?.name.trim()} onClick={() => create.mutate()}>
              {t('account.tokens.create')}
            </Button>
          </>
        }
      >
        {form && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (form.name.trim()) create.mutate();
            }}
          >
            <FormField label={t('account.tokens.name')} required description={t('account.tokens.nameHint')}>
              <Input value={form.name} maxLength={40} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="github-actions" autoFocus />
            </FormField>
            <FormField label={t('account.tokens.access')}>
              <Select<'full' | 'read'>
                value={form.access}
                onChange={(v) => setForm({ ...form, access: v })}
                options={[
                  { value: 'read', label: t('account.tokens.readOnly'), description: t('account.tokens.readOnlyDesc') },
                  { value: 'full', label: t('account.tokens.fullAccess'), description: t('account.tokens.fullAccessDesc') },
                ]}
              />
            </FormField>
            <FormField label={t('account.tokens.validity')}>
              <Select
                value={form.expiresInDays}
                onChange={(v) => setForm({ ...form, expiresInDays: v })}
                options={[
                  { value: '30', label: t('account.tokens.days', { n: 30 }) },
                  { value: '90', label: t('account.tokens.days', { n: 90 }) },
                  { value: '365', label: t('account.tokens.oneYear') },
                  { value: 'never', label: t('account.tokens.forever') },
                ]}
              />
            </FormField>
          </form>
        )}
      </Modal>

      <Modal
        open={!!created}
        onOpenChange={(o) => !o && setCreated(null)}
        title={t('account.tokens.createdTitle')}
        footer={
          <Button variant="primary" onClick={() => setCreated(null)}>
            {t('account.twofa.saved')}
          </Button>
        }
      >
        <div className="space-y-3">
          <Alert tone="warning">{t('account.tokens.createdNote')}</Alert>
          <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 ring-1 ring-line">
            <KeyRound className="size-4 shrink-0 text-fg-4" />
            <code className="min-w-0 flex-1 font-mono text-[13px] break-all">{created}</code>
            <CopyButton value={created ?? ''} />
          </div>
        </div>
      </Modal>
    </div>
  );
}

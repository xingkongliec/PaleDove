import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MailSettingsDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { Input, PasswordInput } from '@/components/ui/input';
import { Card, CardBody, ErrorState, FormRow, PageLoading, Switch } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';

type MailForm = MailSettingsDTO & { password: string };

export function MailSettingsCard() {
  const t = useT();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['mail-settings'], queryFn: () => api.get<MailSettingsDTO>('/admin/settings/mail') });
  const [form, setForm] = useState<MailForm | null>(null);
  const [to, setTo] = useState('');
  useEffect(() => { if (q.data) setForm({ ...q.data, password: '' }); }, [q.data]);
  const set = <K extends keyof MailForm>(key: K, value: MailForm[K]) => setForm((f) => f ? { ...f, [key]: value } : f);
  const body = () => form && ({
    enabled: form.enabled, host: form.host, port: form.port, secure: form.secure,
    user: form.user, password: form.password || undefined, fromName: form.fromName, fromEmail: form.fromEmail,
  });
  const save = useMutation({
    mutationFn: () => api.put<MailSettingsDTO>('/admin/settings/mail', body()),
    onSuccess: (data) => {
      setForm({ ...data, password: '' });
      qc.setQueryData(['mail-settings'], data);
      void qc.invalidateQueries({ queryKey: ['admin-settings'] });
      void qc.invalidateQueries({ queryKey: ['public-config'] });
      toast.success(t('adminSettings.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; to: string }>('/admin/settings/mail/test', { ...body(), to: to.trim() || undefined }),
    onSuccess: (data) => toast.success(t('mailSettings.testSent', { to: data.to })),
    onError: (e) => toast.fromError(e),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!form) return <PageLoading />;
  const busy = save.isPending || test.isPending;
  return (
    <Card>
      <CardBody>
        <FormRow label={t('mailSettings.enabled')}>
          <Switch checked={form.enabled} onCheckedChange={(v) => set('enabled', v)} label={t('mailSettings.enabledLabel')} />
        </FormRow>
        <FormRow label={t('mailSettings.server')} hint={t('mailSettings.serverHint')}>
          <div className="flex max-w-xl flex-wrap gap-2">
            <Input className="min-w-40 flex-1" value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" aria-label={t('mailSettings.server')} />
            <Input className="w-24" type="number" min={1} max={65535} value={String(form.port)} onChange={(e) => set('port', Number(e.target.value))} aria-label={t('mailSettings.port')} />
          </div>
        </FormRow>
        <FormRow label={t('mailSettings.secure')} hint={t('mailSettings.secureHint')}>
          <Switch checked={form.secure} onCheckedChange={(v) => set('secure', v)} label="SSL / TLS" />
        </FormRow>
        <FormRow label={t('mailSettings.user')}>
          <Input className="max-w-sm" value={form.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" aria-label={t('mailSettings.user')} />
        </FormRow>
        <FormRow label={t('mailSettings.password')} hint={form.hasPassword ? t('mailSettings.passwordSaved') : t('mailSettings.passwordHint')}>
          <div className="max-w-sm"><PasswordInput value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" aria-label={t('mailSettings.password')} /></div>
        </FormRow>
        <FormRow label={t('mailSettings.sender')}>
          <div className="flex max-w-xl flex-wrap gap-2">
            <Input className="min-w-32 flex-1" value={form.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder={t('mailSettings.senderName')} aria-label={t('mailSettings.senderName')} />
            <Input className="min-w-40 flex-1" type="email" value={form.fromEmail} onChange={(e) => set('fromEmail', e.target.value)} placeholder={t('mailSettings.senderEmail')} aria-label={t('mailSettings.senderEmail')} />
          </div>
        </FormRow>
        <FormRow label={t('mailSettings.test')} hint={t('mailSettings.testHint')}>
          <div className="flex max-w-xl flex-wrap gap-2">
            <Input className="min-w-40 flex-1" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('mailSettings.recipient')} aria-label={t('mailSettings.recipient')} />
            <Button loading={test.isPending} disabled={busy || !form.host.trim() || !form.fromEmail.trim()} onClick={() => test.mutate()}>{t('mailSettings.testButton')}</Button>
          </div>
          {me?.email && <p className="mt-1.5 text-xs text-fg-3">{t('mailSettings.defaultRecipient', { email: me.email })}</p>}
        </FormRow>
        <div className="mt-4 flex justify-end border-t border-line pt-4">
          <Button variant="primary" loading={save.isPending} disabled={test.isPending} onClick={() => save.mutate()}>{t('common.save')}</Button>
        </div>
      </CardBody>
    </Card>
  );
}

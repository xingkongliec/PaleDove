import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { AdminUserDTO, Role } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Alert, Card, CardBody, CardHeader } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

export default function AdminUserCreate() {
  const t = useT();
  const currency = useCurrency();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const listSearch = typeof location.state?.userListSearch === 'string' ? new URLSearchParams(location.state.userListSearch).toString() : '';
  const back = { to: `/admin/users${listSearch ? `?${listSearch}` : ''}`, label: t('nav.admin.users') };
  const [form, setForm] = useState({ email: '', username: '', password: '', role: 'USER' as Role, remark: '', balance: '' });
  const set = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: event.target.value });
  const save = useMutation({
    mutationFn: () => api.post<AdminUserDTO>('/admin/users', { ...form, balance: form.balance || undefined }),
    onSuccess: (user) => {
      toast.success(t('users.created'));
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      navigate(`/admin/users/${user.id}`, { replace: true, state: location.state });
    },
  });

  return (
    <>
      <PageHeader back={back} title={t('users.create')} />
      <form className="max-w-4xl" onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate();
      }}>
        <Card>
          <CardHeader title={t('users.tab.info')} />
          <CardBody className="grid gap-5 sm:grid-cols-2">
            <FormField label={t('common.username')} required description={t('login.usernameHint')}>
              <Input required minLength={3} maxLength={32} pattern="[a-zA-Z][a-zA-Z0-9_]{2,31}" autoComplete="off" value={form.username} onChange={set('username')} />
            </FormField>
            <FormField label={t('common.email')} required>
              <Input required type="email" autoComplete="off" value={form.email} onChange={set('email')} />
            </FormField>
            <FormField label={t('common.password')} required description={t('login.passwordHint')}>
              <Input required minLength={8} type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
            </FormField>
            <FormField label={t('account.role')}>
              <Select value={form.role} onChange={(role) => setForm({ ...form, role })} options={[
                { value: 'USER', label: t('shell.roleUser') },
                { value: 'ADMIN', label: t('shell.roleAdmin'), description: t('users.adminHint') },
              ]} />
            </FormField>
            <FormField label={t('users.initialBalance')}>
              <InputGroup prefix={currency} type="number" min="0" step="0.01" value={form.balance} onChange={set('balance')} placeholder="0.00" />
            </FormField>
            <FormField label={t('common.remark')} description={t('users.remarkHint')}>
              <Input maxLength={200} value={form.remark} onChange={set('remark')} />
            </FormField>
          </CardBody>
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">
            {save.error && <Alert tone="danger" className="mb-2 w-full">{errorText(save.error)}</Alert>}
            <LinkButton to={back.to}>{t('common.cancel')}</LinkButton>
            <Button type="submit" variant="primary" loading={save.isPending}>{t('common.create')}</Button>
          </div>
        </Card>
      </form>
    </>
  );
}

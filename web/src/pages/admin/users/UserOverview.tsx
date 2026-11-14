import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, CalendarDays, CreditCard, Globe, KeyRound, Languages, LogIn, NotebookPen, Pencil, Server, Settings2, ShieldCheck, ShieldOff, UserCog, UserRound, Wallet } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdminUserDetailDTO } from '../../../shared/index';
import { CountryLabel } from '@/components/country';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { FormField, Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMemory, formatMoney } from '@/lib/format';
import { useCurrency, useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { useT } from '@/i18n';

export function useUserRefresh(id: number) {
  const qc = useQueryClient();
  return () => {
    for (const key of ['admin-user', 'admin-user-security']) void qc.invalidateQueries({ queryKey: [key, id] });
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  };
}

function Field({ icon, label, children, className }: { icon: ReactNode; label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('user-detail-field', className)}>
      <dt className="flex items-center gap-1.5 text-xs text-fg-3">{icon}{label}</dt>
      <dd className="mt-1 text-[13px] leading-5 break-words text-fg">{children}</dd>
    </div>
  );
}

export function UserOverview({ data, onTab, onImpersonate, impersonating }: {
  data: AdminUserDetailDTO;
  onTab: (tab: 'balance' | 'instances') => void;
  onImpersonate: (id: number) => void;
  impersonating: boolean;
}) {
  const t = useT();
  const currency = useCurrency();
  const confirm = useConfirm();
  const { data: me } = useMe();
  const u = data.user;
  const self = u.id === me?.id;
  const refresh = useUserRefresh(u.id);
  const [editor, setEditor] = useState<'profile' | 'password' | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [profile, setProfile] = useState({ email: u.email, name: u.name ?? '', remark: u.remark ?? '' });
  const [password, setPassword] = useState('');
  useEffect(() => setProfile({ email: u.email, name: u.name ?? '', remark: u.remark ?? '' }), [u.email, u.name, u.remark]);
  useEffect(() => {
    if (editor) editorRef.current?.querySelector<HTMLInputElement>('input')?.focus();
  }, [editor]);
  const dirty = profile.email !== u.email || profile.name !== (u.name ?? '') || profile.remark !== (u.remark ?? '');
  const patch = useMutation({
    mutationFn: (body: object) => api.patch(`/admin/users/${u.id}`, body),
    onSuccess: (_result, body) => {
      toast.success('password' in body ? t('users.passwordReset') : t('users.updated'));
      if ('password' in body) setPassword('');
      if ('password' in body || 'email' in body) setEditor(null);
      refresh();
    },
    onError: (error) => toast.fromError(error),
  });
  const reset2fa = useMutation({
    mutationFn: () => api.post(`/admin/users/${u.id}/reset-2fa`),
    onSuccess: () => { toast.success(t('users.reset2faDone')); refresh(); },
    onError: (error) => toast.fromError(error),
  });
  const pending = (key: string) => patch.isPending && !!patch.variables && key in patch.variables;
  const stats = [
    { label: t('common.balance'), value: formatMoney(u.balance, currency), icon: <Wallet />, tone: Number(u.balance) < 0 ? 'danger' : undefined },
    { label: t('billing.totalSpend'), value: data.billing ? formatMoney(data.billing.totalSpend, currency) : '—', icon: <CreditCard /> },
    { label: t('billing.totalRecharge'), value: data.billing ? formatMoney(data.billing.totalRecharge, currency) : '—', icon: <Wallet /> },
    { label: t('users.roleLabel'), value: t(u.role === 'ADMIN' ? 'shell.roleAdmin' : 'users.state.user'), icon: <UserCog /> },
  ];
  const usage = data.usage;

  return (
    <section className="user-detail-panel">
      <h2 className="user-detail-section-title"><UserRound />{t('users.overviewTitle')}</h2>
      <div className="space-y-3 p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label} className="user-detail-stat" data-tone={stat.tone}>
              <div className="flex items-center gap-1.5 text-xs text-fg-3">{stat.icon}{stat.label}</div>
              <div className="tabular mt-1 text-lg leading-6 font-semibold break-words sm:text-xl">{stat.value}</div>
            </div>
          ))}
        </div>

        <button type="button" onClick={() => onTab('instances')} className="user-detail-resources group">
          <span className="flex items-center gap-2 text-[13px]"><Server className="size-3.5 text-fg-3" />{t('users.resources')}</span>
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-3">
            <span>{usage.cpu} CPU · {formatMemory(usage.memory)} · {usage.disk} GB</span>
            <span>{t('users.ports')} {usage.ports} · {t('users.sites')} {usage.sites} · {t('detail.tab.snapshots')} {usage.snapshots}</span>
            <span className="font-medium text-fg"><span className="user-detail-accent tabular">{usage.instances}</span> {t('nav.instances')} · {usage.running} {t('users.running')}</span>
          </span>
        </button>

        <dl className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <Field icon={<CalendarDays />} label={t('account.registeredAt')}>{formatDate(u.createdAt, 'YYYY-MM-DD')}</Field>
          <Field icon={<Globe />} label={t('users.registrationIp')}><span className="font-mono text-xs break-all">{data.profile?.registrationIp ?? '—'}</span></Field>
          <Field icon={<CalendarDays />} label={t('users.lastLogin')}>{u.lastLoginAt ? formatDate(u.lastLoginAt, 'YYYY-MM-DD HH:mm') : t('users.neverLogin')}</Field>
          <Field icon={<LogIn />} label={t('users.loginIp')}><span className="font-mono text-xs break-all">{u.lastLoginIp ?? '—'}</span></Field>
          <Field icon={<UserRound />} label={t('account.nickname')} className="col-span-2 lg:col-span-2">{u.name || u.username}</Field>
          <Field icon={<Languages />} label={t('account.nav.locale')} className="col-span-2 lg:col-span-2">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{data.profile?.locale ?? t('common.system')}</span>
              {data.profile?.country && <CountryLabel code={data.profile.country} />}
            </span>
          </Field>
          <Field icon={<NotebookPen />} label={t('common.remark')} className="col-span-2 lg:col-span-4"><span className="whitespace-pre-wrap">{u.remark || '—'}</span></Field>
        </dl>

        <section className="border-t border-line pt-3">
          <h3 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold"><Settings2 className="user-detail-accent size-3.5" />{t('users.operationsTitle')}</h3>
          <div className="user-detail-actions grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Button size="sm" icon={<Wallet />} onClick={() => onTab('balance')}>{t('users.adjustBalance')}</Button>
            <Button size="sm" icon={<Pencil />} aria-expanded={editor === 'profile'} aria-controls="user-detail-editor" onClick={() => setEditor(editor === 'profile' ? null : 'profile')}>{t('users.editProfile')}</Button>
            <Button size="sm" icon={<KeyRound />} aria-expanded={editor === 'password'} aria-controls="user-detail-editor" onClick={() => setEditor(editor === 'password' ? null : 'password')}>{t('users.resetPassword')}</Button>
            <Button size="sm" icon={<ShieldOff />} disabled={!u.twoFactorEnabled} loading={reset2fa.isPending} onClick={async () => {
              if (await confirm({ title: t('users.reset2faTitle', { name: u.username }), description: t('users.reset2faDesc'), danger: true })) reset2fa.mutate();
            }}>{t('users.reset2fa')}</Button>
            <Button size="sm" icon={<LogIn />} disabled={self || u.role === 'ADMIN'} loading={impersonating} onClick={async () => {
              if (await confirm({ title: t('users.impersonateTitle', { name: u.username }), description: t('users.impersonateDesc') })) onImpersonate(u.id);
            }}>{t('users.impersonate')}</Button>
            <Button size="sm" icon={<ShieldCheck />} className={u.status === 'ACTIVE' ? 'text-danger-text' : 'user-detail-accent'} disabled={self || patch.isPending} loading={pending('status')} title={self ? t('users.selfLocked') : undefined} onClick={async () => {
              if (u.status === 'ACTIVE' && !(await confirm({ title: t('users.disableTitle', { name: u.username }), description: t('users.disableDesc'), danger: true, confirmText: t('users.disable') }))) return;
              patch.mutate({ status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' });
            }}>{t(u.status === 'ACTIVE' ? 'users.disable' : 'users.enable')}</Button>
            <Button size="sm" icon={<BadgeCheck />} disabled={patch.isPending} loading={pending('emailVerified')} onClick={async () => {
              const verified = !u.emailVerifiedAt;
              const ok = await confirm(verified
                ? { title: t('users.verifyTitle', { name: u.username }), description: t('users.verifyDesc', { email: u.email }), confirmText: t('users.action.verify') }
                : { title: t('users.unverifyTitle', { name: u.username }), description: t('users.unverifyDesc'), danger: true, confirmText: t('users.action.unverify') });
              if (ok) patch.mutate({ emailVerified: verified });
            }}>{t(u.emailVerifiedAt ? 'users.action.unverify' : 'users.action.verify')}</Button>
            <Button size="sm" icon={<UserCog />} disabled={self || patch.isPending} loading={pending('role')} title={self ? t('users.selfLocked') : undefined} onClick={async () => {
              const admin = u.role !== 'ADMIN';
              if (await confirm({ title: t(admin ? 'users.promoteTitle' : 'users.demoteTitle', { name: u.username }), description: t(admin ? 'users.promoteDesc' : 'users.demoteDesc'), danger: admin })) patch.mutate({ role: admin ? 'ADMIN' : 'USER' });
            }}>{t(u.role === 'ADMIN' ? 'users.action.demote' : 'users.action.promote')}</Button>
          </div>
        </section>

        {editor && <div key={editor} id="user-detail-editor" ref={editorRef} className="user-detail-editor panel-enter">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-[13px] font-semibold">{t(editor === 'profile' ? 'users.editProfile' : 'users.resetPassword')}</h3>
            <Button size="sm" variant="ghost" onClick={() => setEditor(null)}>{t('common.close')}</Button>
          </div>
          {editor === 'profile' ? <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1.5fr_auto]" onSubmit={(event) => {
            event.preventDefault();
            if (dirty && !patch.isPending) patch.mutate({ email: profile.email, name: profile.name || null, remark: profile.remark || null });
          }}>
            <FormField label={t('common.email')} required><Input type="email" required value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} /></FormField>
            <FormField label={t('account.nickname')}><Input value={profile.name} maxLength={32} placeholder={u.username} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></FormField>
            <FormField label={t('common.remark')}><Input value={profile.remark} maxLength={200} onChange={(event) => setProfile({ ...profile, remark: event.target.value })} /></FormField>
            <div className="flex items-end justify-end"><Button type="submit" variant="primary" disabled={!dirty || patch.isPending} loading={pending('email')}>{t('users.saveProfile')}</Button></div>
          </form> : <form className="flex max-w-xl flex-wrap items-end gap-3" onSubmit={(event) => {
            event.preventDefault();
            if (password.length >= 8 && !patch.isPending) patch.mutate({ password });
          }}>
            <FormField label={t('users.resetPassword')} description={t(data.hasPassword ? 'users.resetPasswordHint' : 'users.noPasswordHint')} className="min-w-0 flex-1">
              <Input type="password" required minLength={8} autoComplete="new-password" value={password} placeholder={t('users.newPasswordPlaceholder')} onChange={(event) => setPassword(event.target.value)} />
            </FormField>
            <Button type="submit" variant="primary" disabled={password.length < 8 || patch.isPending} loading={pending('password')}>{t('users.reset')}</Button>
          </form>}
        </div>}
      </div>
    </section>
  );
}

import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { AuthShell } from '@/components/landing/AuthShell';
import { Button, LinkButton } from '@/components/ui/button';
import { FormField, Input, PasswordInput } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';

export default function PasswordResetPage({ reset = false }: { reset?: boolean }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''), [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null), [cooldown, setCooldown] = useState(0);
  const [token] = useState(() => new URLSearchParams(location.hash.slice(1)).get('token') ?? new URLSearchParams(location.search).get('token') ?? '');
  useEffect(() => { if (reset) history.replaceState(null, '', location.pathname); }, [reset]);
  useEffect(() => { if (!cooldown) return; const timer = setTimeout(() => setCooldown((n) => n-1), 1000); return () => clearTimeout(timer); }, [cooldown]);
  const action = useMutation({
    mutationFn: () => reset ? api.post('/auth/reset-password', { token, password }) : api.post('/auth/forgot-password', { email }),
    onSuccess: () => { setPassword(''); setConfirm(''); if (!reset) setCooldown(60); },
    onError: (e) => setError(errorText(e)),
  });
  return <AuthShell>
    <h1 className="mb-3 text-xl font-semibold">{t(reset ? 'reset.newTitle' : 'reset.title')}</h1>
    {reset && action.isSuccess ? <><Alert tone="success">{t('reset.success')}</Alert><LinkButton to="/login" variant="primary" className="mt-5 w-full">{t('login.signIn')}</LinkButton></> : <>
      {!reset && <p className="mb-5 text-sm leading-relaxed text-fg-2">{t('reset.description')}</p>}
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setError(null); if (reset && password !== confirm) return setError(t('login.passwordMismatch')); action.mutate(); }}>
        {reset ? <><FormField label={t('account.newPassword')}><PasswordInput required minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></FormField><FormField label={t('login.confirmPassword')}><PasswordInput required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></FormField></> : <FormField label={t('common.email')}><Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></FormField>}
        {(error || (reset && !token)) && <Alert tone="danger">{error || t('reset.invalid')}</Alert>}
        {!reset && action.isSuccess && <Alert tone="success">{t('reset.sent')}</Alert>}
        <Button type="submit" variant="primary" className="w-full" loading={action.isPending} disabled={reset ? !token : cooldown > 0}>{t(reset ? 'reset.submit' : cooldown ? 'reset.wait' : 'reset.send', { seconds: cooldown })}</Button>
      </form><Link to="/login" className="mt-5 block text-center text-sm text-fg-3 hover:text-fg">{t('reset.back')}</Link>
    </>}
  </AuthShell>;
}

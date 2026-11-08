import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AuthShell } from '@/components/landing/AuthShell';
import { Button, LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';

/** 外壳与登录页一致（悬浮顶栏 + 粒子背景 + 居中卡片） */
function Shell({ children }: { children: React.ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}

export default function VerifyEmailPage() {
  const t = useT();
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  useEffect(() => { window.history.replaceState(null, '', window.location.pathname); }, []);
  const verify = useMutation({ mutationFn: () => api.post('/auth/verify-email', { token }) });
  return <Shell><h1 className="mb-3 text-xl font-semibold">{t('emailVerify.title')}</h1>
    {verify.isSuccess ? <><Alert tone="success">{t('emailVerify.success')}</Alert><LinkButton to="/login" variant="primary" className="mt-5 w-full">{t('login.signIn')}</LinkButton></>
      : <><p className="mb-5 text-sm leading-relaxed text-fg-2">{t('emailVerify.confirmHint')}</p>{(verify.error || !token) && <Alert tone="danger" className="mb-4">{verify.error ? errorText(verify.error) : t('emailVerify.invalid')}</Alert>}
        <Button variant="primary" className="w-full" disabled={!token} loading={verify.isPending} onClick={() => verify.mutate()}>{t('emailVerify.confirm')}</Button><Link to="/login" className="mt-4 block text-center text-sm text-fg-3">{t('emailVerify.back')}</Link></>}
  </Shell>;
}

export function VerificationNotice({ initialEmail, mailSent, onBack, initialCooldown = 60 }: { initialEmail: string; mailSent: boolean; onBack: () => void; initialCooldown?: number }) {
  const t = useT(); const [email, setEmail] = useState(initialEmail); const [cooldown, setCooldown] = useState(initialCooldown);
  useEffect(() => { if (!cooldown) return; const timer = window.setTimeout(() => setCooldown((n) => n - 1), 1000); return () => window.clearTimeout(timer); }, [cooldown]);
  const resend = useMutation({ mutationFn: () => api.post('/auth/resend-verification', { email }), onSuccess: () => setCooldown(60) });
  return <Shell><h1 className="mb-3 text-xl font-semibold">{t('emailVerify.title')}</h1>
    <p className="mb-5 text-sm leading-relaxed text-fg-2">{mailSent ? t('emailVerify.sent', { email: initialEmail }) : t('emailVerify.notSent')}</p>
    <form onSubmit={(e) => { e.preventDefault(); resend.mutate(); }} className="space-y-4"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label={t('common.email')} />
      {resend.error && <Alert tone="danger">{errorText(resend.error)}</Alert>}{resend.isSuccess && <Alert tone="success">{t('emailVerify.resendSuccess')}</Alert>}
      <Button type="submit" variant="primary" className="w-full" loading={resend.isPending} disabled={cooldown > 0}>{cooldown ? t('emailVerify.wait', { seconds: cooldown }) : t('emailVerify.resend')}</Button>
    </form><button className="mt-5 w-full text-center text-sm text-fg-3 hover:text-fg" onClick={onBack}>{t('emailVerify.back')}</button>
  </Shell>;
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Camera, Cpu, Globe, KeyRound, Network } from 'lucide-react';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { emailDomainAllowed, emailDomainOf, loginLanding, type LoginResultDTO, type MeDTO, type RegisterResultDTO } from '../../shared/index';
import { AuthShell } from '@/components/landing/AuthShell';
import { oauthIcon } from '@/components/oauth-icon';
import { Button } from '@/components/ui/button';
import { FormField, Input, PasswordInput } from '@/components/ui/input';
import { Alert, Checkbox, FullPageLoading } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { ApiError, api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { loginWithPasskey, passkeyError, passkeySupported } from '@/lib/passkey';
import { VerificationNotice } from './VerifyEmail';
import { storedAff } from '@/lib/aff';
import { useMe, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';

type Mode = 'login' | 'register';

/** 根据角色决定登录后的落地页 */
function landing(user: MeDTO, redirect: string | null): string {
  return loginLanding(user.role, redirect);
}

/** 第三方登录按钮：只显示管理员在后台启用的 */
function OAuthButtons({ next, label }: { next?: string; label: string }) {
  const { data: cfg } = usePublicConfig();
  const items = (cfg?.oauth ?? []).map((p) => ({ key: p.id, label: p.name, icon: oauthIcon(p.id, p.name, p.icon) }));
  if (!items.length) return null;
  const aff = storedAff();
  const q = new URLSearchParams({ ...(next ? { next } : {}), ...(aff ? { aff } : {}) }).toString();
  return (
    <div className="mt-8">
      <div className="flex items-center gap-3 text-xs text-fg-3">
        <span className="h-px flex-1 bg-gradient-to-r from-transparent to-line" />
        {label}
        <span className="h-px flex-1 bg-gradient-to-l from-transparent to-line" />
      </div>
      {/* 一行最多 3 个，放不下时换行，落单的占满整行 */}
      <div className="mt-5 flex flex-wrap gap-2.5">
        {items.map((i) => (
          // 必须整页跳转到后端，由后端重定向到提供商
          <a
            key={i.key}
            href={`/api/auth/oauth/${encodeURIComponent(i.key)}/start${q ? `?${q}` : ''}`}
            title={i.label}
            className="group/oauth inline-flex h-10 min-w-[118px] flex-1 basis-[30%] items-center justify-center gap-2 rounded-lg border border-line bg-surface px-3 text-[13px] font-medium text-fg-2 transition-[background-color,border-color,color,scale] duration-150 hover:border-line-strong hover:bg-surface-2 hover:text-fg active:scale-[0.98]"
          >
            <span className="flex shrink-0 transition-[scale] duration-200 group-hover/oauth:scale-110">{i.icon}</span>
            <span className="truncate" translate="no">
              {i.label}
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}

/** 登录页（/login）与注册页（/register）：顶部的切换选项在两个路由之间切换，保留 ?redirect= 等参数 */
export default function LoginPage({ mode = 'login' }: { mode?: Mode }) {
  const { t } = useI18n();
  const { data: me, isLoading } = useMe();
  const { data: cfg } = usePublicConfig();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password2, setPassword2] = useState('');
  // 第三方登录失败时后端会带 ?error= 回到这里
  const [error, setError] = useState<string | null>(() => params.get('error'));
  // 第三方登录的账号启用了两步验证时，后端带 ?challenge= 回来，直接进入验证码步骤
  const [challenge, setChallenge] = useState(() => params.get('challenge') ?? '');
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [verificationNotice, setVerificationNotice] = useState<{ email: string; mailSent: boolean; cooldown: number } | null>(null);

  // 读取后从地址栏移除，刷新页面时不再重复提示
  useEffect(() => {
    if (!params.has('error') && !params.has('challenge')) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('error');
        next.delete('challenge');
        return next;
      },
      { replace: true },
    );
  }, [params, setParams]);

  const setMode = (m: Mode) => {
    setError(null);
    const next = new URLSearchParams(params);
    next.delete('mode');
    const qs = next.toString();
    navigate(`${m === 'register' ? '/register' : '/login'}${qs ? `?${qs}` : ''}`, { replace: true });
  };

  const onAuthed = (user: MeDTO, registered = false) => {
    qc.clear();
    qc.setQueryData(['me'], user);
    toast.success(registered ? t('login.registeredToast') : t('login.signedInToast'), t('login.welcome', { name: user.name || user.username }));
    navigate(landing(user, params.get('redirect') ?? params.get('next')), { replace: true });
  };

  const login = useMutation({
    mutationFn: () => api.post<LoginResultDTO>('/auth/login', { account, password }),
    onSuccess: (r) => {
      // 已启用两步验证：凭挑战令牌 + 验证码完成登录
      if (r.needTotp && r.challenge) {
        setChallenge(r.challenge);
        setCode('');
      } else if (r.user) onAuthed(r.user);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'EMAIL_NOT_VERIFIED') setVerificationNotice({ email: account.includes('@') ? account : '', mailSent: false, cooldown: 0 });
      else setError(errorText(e));
    },
  });

  const verify = useMutation({
    mutationFn: () => api.post<LoginResultDTO>('/auth/login/2fa', { challenge, code }),
    onSuccess: (r) => r.user && onAuthed(r.user),
    onError: (e) => {
      setError(errorText(e));
      setCode('');
    },
  });

  // 通行密钥登录：不需要账号和密码，也不再要求两步验证码
  const supportsPasskey = useMemo(passkeySupported, []);
  const passkey = useMutation({
    mutationFn: loginWithPasskey,
    onSuccess: (r) => r.user && onAuthed(r.user),
    onError: (e) => setError(passkeyError(e, t)),
  });

  const register = useMutation({
    mutationFn: () => api.post<RegisterResultDTO>('/auth/register', { email, username, password, agreeTerms: agree, aff: storedAff() }),
    onSuccess: (r) => {
      if (r.needVerify) { setVerificationNotice({ email, mailSent: !!r.mailSent, cooldown: 60 }); setPassword(''); setPassword2(''); }
      else if (r.user) onAuthed(r.user, true);
    },
    onError: (e) => setError(errorText(e)),
  });

  if (isLoading) return <FullPageLoading />;
  if (me) return <Navigate to={landing(me, params.get('redirect'))} replace />;
  // 旧链接 /login?mode=register 跳到注册页
  if (mode === 'login' && params.get('mode') === 'register') {
    const next = new URLSearchParams(params);
    next.delete('mode');
    const qs = next.toString();
    return <Navigate to={`/register${qs ? `?${qs}` : ''}`} replace />;
  }
  if (mode === 'register' && cfg && !cfg.allowRegister) return <RegisterClosed />;
  if (verificationNotice) return <VerificationNotice initialEmail={verificationNotice.email} mailSent={verificationNotice.mailSent} initialCooldown={verificationNotice.cooldown} onBack={() => { setVerificationNotice(null); setMode('login'); }} />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (challenge) verify.mutate();
    else if (mode === 'login') login.mutate();
    else {
      if (password !== password2) return setError(t('login.passwordMismatch'));
      if (cfg?.legalRequireAgree && !agree) return setError(t('legal.agreeRequired'));
      register.mutate();
    }
  };

  const features = [
    { icon: <Cpu />, title: t('login.feature.instances') },
    { icon: <Network />, title: t('login.feature.ports') },
    { icon: <Globe />, title: t('login.feature.sites') },
    { icon: <Camera />, title: t('login.feature.snapshots') },
  ];

  // 左侧介绍：与首页首屏同样的徽标、大标题（后半句渐变）、说明与要点
  const aside = (
    <div className="max-w-xl">
      <Link
        to="/#servers"
        className="page-enter inline-flex items-center gap-2.5 rounded-full border border-line bg-surface/70 py-1.5 pr-3 pl-3.5 text-[13px] text-fg-2 backdrop-blur transition-colors hover:border-line-strong hover:text-fg"
      >
        <span className="size-2 rounded-full bg-success" />
        {t('home.badge')}
        <ArrowUpRight className="size-3.5 text-fg-3" />
      </Link>
      <h2 className="page-enter mt-7 text-[44px] leading-[1.08] font-medium tracking-tight text-fg [animation-delay:80ms] xl:text-[56px]">
        {t('login.heroLead')}
        <br />
        <span className="text-gradient">{t('login.heroEmphasis')}</span>
      </h2>
      <p className="page-enter mt-6 max-w-lg text-base leading-relaxed text-fg-3 [animation-delay:160ms]">{t('login.heroDesc')}</p>
      <ul className="page-enter mt-8 grid max-w-md grid-cols-2 gap-x-6 gap-y-3 [animation-delay:240ms]">
        {features.map((f) => (
          <li key={f.title} className="flex items-center gap-2.5 text-[13px] text-fg-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-line bg-surface/70 text-fg-2 backdrop-blur [&>svg]:size-3.5">{f.icon}</span>
            {f.title}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <AuthShell aside={aside}>
      <div key={`head-${challenge ? 'twofa' : mode}`} className="panel-enter">
        <h1 className="text-[26px] font-semibold tracking-tight text-fg">{challenge ? t('login.twofaTitle') : mode === 'login' ? t('login.title') : t('login.registerTitle')}</h1>
        <p className="mt-1.5 text-sm text-fg-2">{challenge ? t('login.twofaDesc') : mode === 'login' ? t('login.subtitle') : cfg?.requireEmailVerification ? t('emailVerify.registerHint') : t('login.registerSubtitle')}</p>
        {!challenge && mode === 'register' && (cfg?.signupBonus ?? 0) > 0 && <p className="mt-3 text-sm text-fg-2">{t('emailVerify.signupBonus', { amount: cfg!.signupBonus, currency: cfg!.currency })}</p>}
      </div>

      {!challenge && cfg?.allowRegister && (
        <Segmented
          className="mt-7 flex w-full [&>button]:flex-1"
          value={mode}
          onChange={setMode}
          items={[
            { value: 'login', label: t('login.signIn') },
            { value: 'register', label: t('login.signUp') },
          ]}
        />
      )}

      <form key={`form-${challenge ? 'twofa' : mode}`} onSubmit={submit} className="panel-enter mt-6 space-y-4">
        {challenge ? (
          <>
            <FormField label={t('login.twofaCode')}>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                placeholder="000000"
                className="tabular h-10 font-mono tracking-[0.2em]"
              />
            </FormField>
          </>
        ) : mode === 'login' ? (
          <>
            <FormField label={t('login.account')}>
              <Input value={account} onChange={(e) => setAccount(e.target.value)} autoComplete="username" autoFocus required className="h-10" />
            </FormField>
            <FormField label={t('common.password')}>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required className="h-10" />
            </FormField>
          </>
        ) : (
          <>
            {/* 邮箱后缀规则：白名单时列出可用后缀（点击补全），输入完整后即时校验（白名单 / 黑名单） */}
            <FormField
              label={t('common.email')}
              error={
                cfg && cfg.emailDomainMode !== 'OFF' && /@[^@]+\.[^@]+$/.test(email) && !emailDomainAllowed(email, { mode: cfg.emailDomainMode, domains: cfg.emailDomains })
                  ? t(cfg.emailDomainMode === 'ALLOW' ? 'login.emailDomainNotAllowed' : 'login.emailDomainBlocked')
                  : null
              }
            >
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required className="h-10" />
              {cfg?.emailDomainMode === 'ALLOW' && cfg.emailDomains.length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-fg-3">{t('login.emailDomainsPick')}</span>
                  {cfg.emailDomains.slice(0, 12).map((d) => {
                    const local = email.split('@')[0] ?? '';
                    const active = emailDomainOf(email) === d;
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setEmail(`${local}@${d}`)}
                        className={cn(
                          'rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors',
                          active ? 'border-line-strong bg-surface-3 text-fg' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg',
                        )}
                      >
                        @{d}
                      </button>
                    );
                  })}
                  {cfg.emailDomains.length > 12 && <span className="text-xs text-fg-4">{t('login.emailDomainsMore', { n: cfg.emailDomains.length - 12 })}</span>}
                </div>
              )}
            </FormField>
            <FormField label={t('common.username')} description={t('login.usernameHint')}>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required className="h-10" />
            </FormField>
            <FormField label={t('common.password')} description={t('login.passwordHint')}>
              <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} className="h-10" />
            </FormField>
            <FormField label={t('login.confirmPassword')}>
              <PasswordInput value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" required className="h-10" />
            </FormField>
          </>
        )}
        {!challenge && mode === 'register' && cfg?.legalRequireAgree && <Checkbox checked={agree} onCheckedChange={setAgree} label={<span>{t('legal.agree')} <LegalLinks /></span>} />}
        {!challenge && mode === 'login' && cfg?.mailEnabled && <div className="text-right"><Link to="/forgot-password" className="text-xs text-fg-3 hover:text-fg">{t('reset.forgot')}</Link></div>}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" variant="primary" size="lg" className="mt-2 w-full" loading={login.isPending || register.isPending || verify.isPending} disabled={passkey.isPending}>
          {challenge ? t('login.twofaVerify') : mode === 'login' ? t('login.signIn') : cfg?.requireEmailVerification ? t('login.signUp') : t('login.signUpAndSignIn')}
        </Button>
        {!challenge && mode === 'login' && supportsPasskey && (
          <Button
            type="button"
            size="lg"
            className="w-full"
            icon={<KeyRound className="size-4" />}
            loading={passkey.isPending}
            disabled={login.isPending}
            onClick={() => {
              setError(null);
              passkey.mutate();
            }}
          >
            {t('passkey.signIn')}
          </Button>
        )}
        {!challenge && mode === 'register' && !cfg?.legalRequireAgree && <p className="text-center text-xs leading-5 text-fg-3">{t('legal.signUpNotice')} <LegalLinks /></p>}
        {challenge && (
          <button
            type="button"
            onClick={() => {
              setChallenge('');
              setCode('');
              setError(null);
            }}
            className="w-full text-center text-sm text-fg-3 hover:text-fg"
          >
            {t('login.twofaBack')}
          </button>
        )}
      </form>

      <div className="mt-6 flex justify-center gap-4 text-xs text-fg-3"><Link to="/terms" className="hover:text-fg">{t('legal.terms')}</Link><Link to="/privacy" className="hover:text-fg">{t('legal.privacy')}</Link></div>
      {!challenge && <OAuthButtons next={params.get('redirect') ?? undefined} label={mode === 'login' ? t('login.otherLogin') : t('login.otherRegister')} />}

      {!challenge && cfg?.allowRegister && (
        <p className="mt-6 text-center text-sm text-fg-3">
          {mode === 'login' ? t('login.noAccount') : t('login.haveAccount')}{' '}
          <button
            type="button"
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="font-medium text-fg underline-offset-4 hover:underline"
          >
            {mode === 'login' ? t('login.signUp') : t('login.signIn')}
          </button>
        </p>
      )}
    </AuthShell>
  );
}

function LegalLinks() {
  const { t } = useI18n();
  return <><a href="/terms" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{t('legal.terms')}</a> {t('legal.and')} <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{t('legal.privacy')}</a></>;
}

/** 注册已关闭：提示联系管理员，并可返回登录 */
function RegisterClosed() {
  const { t } = useI18n();
  return (
    <AuthShell className="space-y-5">
      <h1 className="text-[26px] font-semibold tracking-tight text-fg">{t('login.registerClosedTitle')}</h1>
      <Alert tone="neutral">{t('login.registerClosedDesc')}</Alert>
      <Link to="/login" className="block text-center text-[13px] text-fg-3 transition-colors hover:text-fg hover:underline">
        {t('login.backToLogin')}
      </Link>
    </AuthShell>
  );
}

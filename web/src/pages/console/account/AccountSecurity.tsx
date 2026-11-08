import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Download, KeyRound, LogOut, Monitor, Pencil, Plus, ShieldCheck, ShieldOff, Smartphone, Trash } from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { LOCALE_NAMES, LOCALES, type Locale, type PasskeyDTO, type SessionDTO, type ThemePreference } from '../../../shared/index';
import { OAUTH_CHANGED } from '@/components/OAuthBindBanner';
import { CountryLabel, useCountryName } from '@/components/country';
import { oauthIcon } from '@/components/oauth-icon';
import { Button, buttonClass } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, PasswordInput } from '@/components/ui/input';
import { Alert, Card, CardBody, CardHeader, Empty, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { copyText, formatDate, fromNow } from '@/lib/format';
import { passkeyError, passkeySupported, registerPasskey } from '@/lib/passkey';
import { saveProfile } from '@/lib/preferences';
import { useMe } from '@/lib/queries';
import { applyTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';

// ───────────────────────── 区域与语言 ─────────────────────────

/** 常见国家 / 地区（ISO 3166-1 alpha-2），名称用浏览器的 Intl 按当前语言显示 */
const COUNTRIES = [
  'CN', 'HK', 'MO', 'TW', 'US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'IE', 'PT', 'PL', 'CZ', 'RU', 'UA', 'TR',
  'JP', 'KR', 'SG', 'MY', 'TH', 'VN', 'ID', 'PH', 'IN', 'PK', 'BD', 'AE', 'SA', 'IL', 'EG', 'ZA', 'NG', 'KE', 'AU', 'NZ', 'BR', 'MX', 'AR', 'CL', 'CO', 'PE',
];

export function RegionLanguageCard() {
  const { t, locale: uiLocale, setLocale: setUiLocale } = useI18n();
  const qc = useQueryClient();
  const { data: user } = useMe();
  const countryName = useCountryName();
  const [country, setCountry] = useState(user?.country ?? 'CN');
  const [locale, setLocale] = useState<Locale>(user?.locale ?? uiLocale);
  const [theme, setTheme] = useState<ThemePreference>(user?.theme ?? 'system');
  const save = useMutation({
    mutationFn: () => saveProfile({ country, locale, theme }),
    onSuccess: (u) => {
      qc.setQueryData(['me'], u);
      setUiLocale(locale);
      applyTheme(theme);
      toast.success(t('account.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  const countries = useMemo(
    () => COUNTRIES.map((c) => ({ value: c, label: <CountryLabel code={c} /> })).sort((a, b) => (a.value === 'CN' ? -1 : b.value === 'CN' ? 1 : 0)),
    // 国家名称随界面语言变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [countryName],
  );
  if (!user) return null;
  const dirty = country !== user.country || locale !== user.locale || theme !== (user.theme ?? 'system');
  return (
    <Card>
      <CardHeader title={t('account.nav.locale')} />
      <CardBody>
        <p className="-mt-1 mb-4 text-[13px] text-fg-3">{t('account.locale.desc')}</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField label={t('account.locale.country')}>
            <Select value={country} onChange={setCountry} options={countries} />
          </FormField>
          <FormField label={t('shell.language')}>
            <span translate="no" className="block">
              <Select value={locale} onChange={setLocale} options={LOCALES.map((l) => ({ value: l, label: LOCALE_NAMES[l] }))} />
            </span>
          </FormField>
          <FormField label={t('shell.theme')}>
            <Select
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: t('shell.themeLight'), description: t('account.locale.themeLightDesc') },
                { value: 'dark', label: t('shell.themeDark'), description: t('account.locale.themeDarkDesc') },
                { value: 'system', label: t('shell.themeSystem'), description: t('account.locale.themeSystemDesc') },
              ]}
            />
          </FormField>
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// ───────────────────────── 两步验证 ─────────────────────────

interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: string | null;
  recoveryRemaining: number;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  const { t } = useI18n();
  const text = codes.join('\n');
  return (
    <div>
      <Alert tone="warning" className="mb-3">
        {t('account.twofa.codesNote')}
      </Alert>
      <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-2 p-3 font-mono text-[13px]">
        {codes.map((c) => (
          <span key={c} className="rounded bg-surface px-2 py-1 text-center ring-1 ring-line">
            {c}
          </span>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          icon={<Copy className="size-3.5" />}
          onClick={async () => {
            if (await copyText(text)) toast.success(t('common.copied'));
          }}
        >
          {t('common.copy')}
        </Button>
        <Button
          size="sm"
          icon={<Download className="size-3.5" />}
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([text + '\n'], { type: 'text/plain' }));
            a.download = 'paledove-recovery-codes.txt';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          {t('account.twofa.download')}
        </Button>
      </div>
    </div>
  );
}

export function TwoFactorCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['2fa'], queryFn: () => api.get<TwoFactorStatus>('/auth/2fa') });
  const [setup, setSetup] = useState<{ secret: string; url: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<'disable' | 'recovery' | null>(null);
  const [form, setForm] = useState({ password: '', code: '' });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['2fa'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };

  const start = useMutation({
    mutationFn: async () => {
      const r = await api.post<{ secret: string; otpauthUrl: string }>('/auth/2fa/setup');
      const qr = await QRCode.toDataURL(r.otpauthUrl, { width: 200, margin: 1, color: { dark: '#111111', light: '#ffffff' } });
      return { secret: r.secret, url: r.otpauthUrl, qr };
    },
    onSuccess: (s) => {
      setSetup(s);
      setCode('');
    },
    onError: (e) => toast.fromError(e),
  });
  const enable = useMutation({
    mutationFn: () => api.post<{ recoveryCodes: string[] }>('/auth/2fa/enable', { code }),
    onSuccess: (r) => {
      setSetup(null);
      setCodes(r.recoveryCodes);
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  const submitConfirm = useMutation({
    mutationFn: async () => {
      if (confirm === 'disable') {
        await api.post('/auth/2fa/disable', form);
        return null;
      }
      return (await api.post<{ recoveryCodes: string[] }>('/auth/2fa/recovery', form)).recoveryCodes;
    },
    onSuccess: (r) => {
      if (r) setCodes(r);
      else toast.success(t('account.twofa.disabled'));
      setConfirm(null);
      setForm({ password: '', code: '' });
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  const s = status.data;

  return (
    <Card>
      <CardHeader
        title={t('account.twofa.title')}
        actions={
          s && (
            <span className={cn('inline-flex items-center gap-1.5 text-[13px]', s.enabled ? 'text-success-text' : 'text-fg-3')}>
              {s.enabled ? <ShieldCheck className="size-4" /> : <ShieldOff className="size-4" />}
              {s.enabled ? t('account.twofa.on') : t('account.twofa.off')}
            </span>
          )
        }
      />
      <CardBody>
        <p className="-mt-1 mb-4 max-w-2xl text-[13px] leading-relaxed text-fg-3">{t('account.twofa.desc')}</p>
        {!s ? null : s.enabled ? (
          <div className="space-y-4">
            <div className="text-[13px] text-fg-2">
              {t('account.twofa.status', { time: formatDate(s.enabledAt) })} <span className="font-medium text-fg tabular-nums">{s.recoveryRemaining}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setConfirm('recovery')}>{t('account.twofa.regenerate')}</Button>
              <Button variant="danger" onClick={() => setConfirm('disable')}>
                {t('account.twofa.disable')}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="primary" loading={start.isPending} onClick={() => start.mutate()} icon={<ShieldCheck className="size-4" />}>
            {t('account.twofa.enable')}
          </Button>
        )}
      </CardBody>

      <Modal
        open={!!setup}
        onOpenChange={(o) => !o && setSetup(null)}
        title={t('account.twofa.enable')}
        size="lg"
        footer={
          <>
            <Button onClick={() => setSetup(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={enable.isPending} disabled={code.length !== 6} onClick={() => enable.mutate()}>
              {t('account.twofa.verifyEnable')}
            </Button>
          </>
        }
      >
        {setup && (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === 6) enable.mutate();
            }}
          >
            <div className="grid items-start gap-5 sm:grid-cols-[176px_1fr] sm:gap-6">
              {/* 二维码始终是白底，深色模式下也要保证能被扫描 */}
              <div className="mx-auto w-44 rounded-xl border border-line bg-[#ffffff] p-1.5 sm:mx-0">
                <img src={setup.qr} alt={t('account.twofa.qrAlt')} className="block size-full" />
              </div>
              <div className="min-w-0 space-y-4">
                <ol className="space-y-2.5 text-[13px] text-fg-2">
                  {[t('account.twofa.step1'), t('account.twofa.step2'), t('account.twofa.step3')].map((s, i) => (
                    <li key={i} className="flex gap-2.5">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-medium text-fg tabular-nums">{i + 1}</span>
                      <span className="leading-5">{s}</span>
                    </li>
                  ))}
                </ol>
                <div>
                  <div className="mb-1.5 text-xs text-fg-3">{t('account.twofa.manual')}</div>
                  <button
                    type="button"
                    translate="no"
                    title={t('common.copy')}
                    onClick={async () => (await copyText(setup.secret)) && toast.success(t('common.copied'))}
                    className="group flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-surface-3"
                  >
                    <span className="grid grid-cols-4 gap-x-3 gap-y-0.5 font-mono text-[13px] leading-5">
                      {(setup.secret.match(/.{1,4}/g) ?? []).map((g, i) => (
                        <span key={i}>{g}</span>
                      ))}
                    </span>
                    <Copy className="size-3.5 shrink-0 text-fg-4 transition-colors group-hover:text-fg" />
                  </button>
                </div>
              </div>
            </div>
            <FormField label={t('account.twofa.codeLabel')}>
              <Input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="000000"
                className="h-11 text-center font-mono text-xl tracking-[0.6em] placeholder:tracking-[0.6em]"
              />
            </FormField>
          </form>
        )}
      </Modal>

      <Modal
        open={!!codes}
        onOpenChange={(o) => !o && setCodes(null)}
        title={t('account.twofa.codesTitle')}
        footer={
          <Button variant="primary" icon={<Check className="size-4" />} onClick={() => setCodes(null)}>
            {t('account.twofa.saved')}
          </Button>
        }
      >
        {codes && <RecoveryCodes codes={codes} />}
      </Modal>

      <Modal
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'disable' ? t('account.twofa.disable') : t('account.twofa.regenerate')}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
            <Button variant={confirm === 'disable' ? 'danger' : 'primary'} loading={submitConfirm.isPending} disabled={!form.password || !form.code} onClick={() => submitConfirm.mutate()}>
              {t('common.confirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-[13px] text-fg-3">{confirm === 'disable' ? t('account.twofa.disableHint') : t('account.twofa.regenerateHint')}</p>
          <FormField label={t('account.twofa.password')}>
            <PasswordInput autoComplete="current-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </FormField>
          <FormField label={t('account.twofa.codeOrRecovery')}>
            <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="123456" className="font-mono" />
          </FormField>
        </div>
      </Modal>
    </Card>
  );
}

// ───────────────────────── 通行密钥 ─────────────────────────

export function PasskeysCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const supported = useMemo(passkeySupported, []);
  const list = useQuery({ queryKey: ['passkeys'], queryFn: async () => (await api.get<{ items: PasskeyDTO[] }>('/auth/passkeys')).items });
  const [renaming, setRenaming] = useState<PasskeyDTO | null>(null);
  const [name, setName] = useState('');
  const reload = () => void qc.invalidateQueries({ queryKey: ['passkeys'] });

  const add = useMutation({
    mutationFn: () => registerPasskey(),
    onSuccess: (p) => {
      toast.success(t('passkey.added', { name: p.name }));
      reload();
    },
    onError: (e) => {
      const text = passkeyError(e, t);
      if (text) toast.error(text);
    },
  });
  const rename = useMutation({
    mutationFn: () => api.patch<PasskeyDTO>(`/auth/passkeys/${renaming!.id}`, { name }),
    onSuccess: () => {
      setRenaming(null);
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/auth/passkeys/${id}`),
    onSuccess: () => {
      toast.success(t('passkey.removed'));
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  const rows = list.data;

  return (
    <Card>
      <CardHeader
        title={t('passkey.title')}
        actions={
          <Button size="sm" icon={<Plus className="size-3.5" />} disabled={!supported} loading={add.isPending} onClick={() => add.mutate()}>
            {t('passkey.add')}
          </Button>
        }
      />
      <CardBody>
        <p className="-mt-1 mb-3 text-[13px] leading-relaxed text-fg-3">{supported ? t('passkey.desc') : t('passkey.unsupported')}</p>
        {rows && rows.length === 0 && <p className="rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-fg-3">{t('passkey.empty')}</p>}
        {rows && rows.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {rows.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-3 py-2.5">
                <KeyRound className="size-4 shrink-0 text-fg-4" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-fg">{p.name}</span>
                    {p.deviceType === 'multiDevice' && <Tag>{t('passkey.synced')}</Tag>}
                  </div>
                  <div className="truncate text-xs text-fg-3">
                    {t('passkey.addedAt', { time: formatDate(p.createdAt) })} · {p.lastUsedAt ? t('passkey.lastUsed', { time: fromNow(p.lastUsedAt) }) : t('passkey.neverUsed')}
                  </div>
                </div>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t('passkey.rename')}
                  title={t('passkey.rename')}
                  onClick={() => {
                    setName(p.name);
                    setRenaming(p);
                  }}
                >
                  <Pencil />
                </Button>
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                  onClick={async () => {
                    if (await confirm({ title: t('passkey.removeTitle', { name: p.name }), description: t('passkey.removeDesc'), danger: true })) remove.mutate(p.id);
                  }}
                >
                  <Trash />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>

      <Modal
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title={t('passkey.rename')}
        footer={
          <>
            <Button onClick={() => setRenaming(null)}>{t('common.cancel')}</Button>
            <Button variant="primary" loading={rename.isPending} disabled={!name.trim()} onClick={() => rename.mutate()}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) rename.mutate();
          }}
        >
          <FormField label={t('passkey.name')}>
            <Input autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
        </form>
      </Modal>
    </Card>
  );
}

// ───────────────────────── 第三方账号 ─────────────────────────

interface Requirement {
  mode: 'any' | 'all';
  required: Array<{ id: string; name: string }>;
  missing: Array<{ id: string; name: string }>;
  satisfied: boolean;
}

interface Linked {
  providers: Array<{ id: string; name: string; icon: string | null; active: boolean; required: boolean; account: { email: string | null; name: string | null; createdAt: string } | null }>;
  requirement: Requirement;
  hasPassword: boolean;
}

export function ConnectedAccountsCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['oauth-accounts'], queryFn: () => api.get<Linked>('/auth/oauth/accounts') });
  const data = q.data;
  useEffect(() => {
    if (data) window.dispatchEvent(new Event(OAUTH_CHANGED));
  }, [data]);
  useEffect(() => {
    // 从提供商授权页回来后，根据参数提示结果
    const linked = params.get('linked');
    const err = params.get('oauth_error');
    if (linked) toast.success(t('account.connections.linked'));
    if (err) toast.error(t('account.connections.linkFailed'), err);
    if (linked || err) setParams({ tab: 'connections' }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const unbind = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/oauth/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success(t('account.connections.unlinked'));
      void qc.invalidateQueries({ queryKey: ['oauth-accounts'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const req = data?.requirement;
  const names = (list: Array<{ name: string }>) => list.map((p) => p.name).join(req?.mode === 'all' ? t('account.connections.joinAll') : t('account.connections.joinAny'));
  return (
    <Card>
      <CardHeader title={t('account.nav.connections')} />
      <CardBody>
        <p className="-mt-1 mb-4 text-[13px] text-fg-3">{t('account.connections.desc')}</p>
        {/* 只在未满足绑定要求时提示 */}
        {req && !req.satisfied && (
          <Alert tone="warning" className="mb-4">
            {t('account.connections.required', { names: names(req.missing) })}
          </Alert>
        )}
        {!data ? (
          <div className="skeleton fade-in-delay h-16 rounded-lg" />
        ) : !data.providers.length ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-fg-3">{t('account.connections.none')}</div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {data.providers.map((p) => {
              const acc = p.account;
              return (
                <div key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[14px] font-medium">
                      {oauthIcon(p.id, p.name, p.icon)}
                      <span className="truncate" translate="no">
                        {p.name}
                      </span>
                      {p.required && <Tag tone={acc ? 'neutral' : 'warning'}>{t('account.connections.mustBind')}</Tag>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-fg-3" title={acc?.email ?? undefined}>
                      {acc ? (acc.email ?? acc.name ?? t('account.connections.bound')) : p.active ? t('account.connections.notBound') : t('account.connections.inactive')}
                    </div>
                  </div>
                  {acc ? (
                    <Button
                      size="sm"
                      className="shrink-0"
                      loading={unbind.isPending && unbind.variables === p.id}
                      onClick={async () => {
                        const content = p.required ? t('account.connections.unbindRequiredDesc', { name: p.name }) : t('account.connections.unbindDesc');
                        if (await confirm({ title: t('account.connections.unbindTitle', { name: p.name }), description: content, danger: true, confirmText: t('account.connections.unbind') }))
                          unbind.mutate(p.id);
                      }}
                    >
                      {t('account.connections.unbind')}
                    </Button>
                  ) : p.active ? (
                    // 整页跳转到后端，由后端重定向到提供商
                    <a href={`/api/auth/oauth/${encodeURIComponent(p.id)}/start?link=1`} className={buttonClass('secondary', 'sm', 'shrink-0')}>
                      {t('account.connections.bind')}
                    </a>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// ───────────────────────── 登录设备 ─────────────────────────

/** 默认展示的设备数（含本机），其余折叠 */
const SESSIONS_FOLDED = 5;

/** 当前账号已登录的浏览器：设备、IP、最后活动，可以单独退出或退出其他全部设备 */
export function SessionsCard() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const q = useQuery({ queryKey: ['sessions'], queryFn: async () => (await api.get<{ items: SessionDTO[] }>('/auth/sessions')).items });
  const rows = q.data ?? null;
  const reload = () => void qc.invalidateQueries({ queryKey: ['sessions'] });
  const revoke = useMutation({
    mutationFn: (id: string) => api.delete(`/auth/sessions/${id}`),
    onSuccess: () => {
      toast.success(t('account.sessions.revoked'));
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api.post('/auth/sessions/revoke-others'),
    onSuccess: () => {
      toast.success(t('account.sessions.revokedOthers'));
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  const others = (rows ?? []).filter((r) => !r.current).length;
  // 本机置顶，其余按最后活动排序
  const sorted = useMemo(
    () => (rows ? [...rows].sort((a, b) => Number(b.current) - Number(a.current) || +new Date(b.lastActiveAt) - +new Date(a.lastActiveAt)) : undefined),
    [rows],
  );
  const hidden = sorted ? Math.max(0, sorted.length - SESSIONS_FOLDED) : 0;
  const visible = sorted && !expanded ? sorted.slice(0, SESSIONS_FOLDED) : sorted;
  return (
    <Card>
      <CardHeader
        title={t('account.nav.sessions')}
        actions={
          <Button
            size="sm"
            disabled={!others}
            loading={revokeOthers.isPending}
            icon={<LogOut className="size-3.5" />}
            onClick={async () => {
              if (await confirm({ title: t('account.sessions.revokeOthersTitle'), description: t('account.sessions.revokeOthersDesc'), confirmText: t('account.sessions.revokeOthers') }))
                revokeOthers.mutate();
            }}
          >
            {t('account.sessions.revokeOthers')}
          </Button>
        }
      />
      <p className="px-5 pt-4 pb-3 text-[13px] text-fg-3">
        {rows ? t('account.sessions.count', { n: rows.length }) : ''}
        {t('account.sessions.hint')}
      </p>
      <DataTable
        rows={visible}
        loading={q.isLoading}
        rowKey={(r) => r.id}
        empty={<Empty icon={<Monitor />} title={t('account.sessions.empty')} />}
        columns={[
          {
            key: 'device',
            header: t('account.sessions.device'),
            cell: (r) => (
              <span className="inline-flex items-center gap-2.5">
                {r.device === 'mobile' ? <Smartphone className="size-4 text-fg-4" /> : <Monitor className="size-4 text-fg-4" />}
                <span className="font-medium" translate="no">
                  {r.os} · {r.browser}
                </span>
                {r.current && <Tag>{t('account.sessions.current')}</Tag>}
              </span>
            ),
          },
          { key: 'ip', header: t('account.sessions.ip'), cell: (r) => <span className="font-mono text-[13px]">{r.ip ?? '-'}</span> },
          { key: 'active', header: t('account.sessions.lastActive'), cell: (r) => (r.current ? <span className="text-success-text">{t('account.sessions.justNow')}</span> : fromNow(r.lastActiveAt)) },
          { key: 'at', header: t('account.sessions.signedIn'), cell: (r) => <span className="tabular-nums">{formatDate(r.createdAt)}</span> },
          {
            key: 'actions',
            header: '',
            className: 'text-right',
            cell: (r) =>
              r.current ? null : (
                <button type="button" className="text-[13px] transition-colors hover:text-danger-text" onClick={() => revoke.mutate(r.id)}>
                  {t('account.sessions.revoke')}
                </button>
              ),
          },
        ]}
      />
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center justify-center gap-1.5 border-t border-line py-3 text-[13px] text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg"
        >
          {expanded ? t('account.sessions.collapse') : t('account.sessions.showMore', { n: hidden })}
          <ChevronDown className={cn('size-4 transition-transform duration-200', expanded && 'rotate-180')} />
        </button>
      )}
    </Card>
  );
}

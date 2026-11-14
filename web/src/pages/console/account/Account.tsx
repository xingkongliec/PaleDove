import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, Globe, IdCard, KeyRound, KeySquare, Link2, MonitorSmartphone, RefreshCw, ShieldCheck, UserRound } from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { AVATAR_STYLES, AVATAR_VARIANTS, type AvatarStyle, type MeDTO } from '../../../shared/index';
import { ApiTokensCard } from '@/components/ApiTokens';
import { PageHeader } from '@/components/page';
import { RealNameCard } from '@/components/RealName';
import { SshKeysCard } from '@/components/SshKeys';
import { UserAvatar } from '@/components/UserAvatar';
import { Button } from '@/components/ui/button';
import { FormField, Input, PasswordInput } from '@/components/ui/input';
import { Card, CardBody, CardHeader, InfoList, SwitchRow } from '@/components/ui/misc';
import { TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/format';
import { saveProfile } from '@/lib/preferences';
import { useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { ConnectedAccountsCard, PasskeysCard, RegionLanguageCard, SessionsCard, TwoFactorCard } from './AccountSecurity';

/** 账号设置：顶部分类标签，下方显示所选分类；分类写在地址栏（?tab=），可直接链接 */
export default function AccountPage() {
  const t = useT();
  const { data: user } = useMe();
  const [params, setParams] = useSearchParams();
  if (!user) return null;
  const sections: Array<{ value: string; label: string; icon: ReactNode; content: ReactNode }> = [
    {
      value: 'profile',
      label: t('account.nav.profile'),
      icon: <UserRound className="size-4" />,
      content: (
        // 两张卡片拉成同样高度
        <div className="grid gap-4 xl:grid-cols-2">
          <ProfileCard user={user} />
          <EmailNotifyCard user={user} />
          <div className="xl:col-span-2">
            <AvatarCard user={user} />
          </div>
        </div>
      ),
    },
    ...(user.role !== 'ADMIN' ? [{ value: 'realname', label: t('account.nav.realname'), icon: <IdCard className="size-4" />, content: <RealNameCard /> }] : []),
    {
      value: 'security',
      label: t('account.nav.security'),
      icon: <ShieldCheck className="size-4" />,
      content: (
        // 两列各自往下排：左边修改密码，右边两步验证与通行密钥，高度相近，不会留出大块空白
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <PasswordCard user={user} />
          <div className="space-y-4">
            <TwoFactorCard />
            <PasskeysCard />
          </div>
        </div>
      ),
    },
    ...(user.role !== 'ADMIN' ? [{ value: 'ssh', label: t('account.nav.ssh'), icon: <KeySquare className="size-4" />, content: <SshKeysCard /> }] : []),
    { value: 'sessions', label: t('account.nav.sessions'), icon: <MonitorSmartphone className="size-4" />, content: <SessionsCard /> },
    { value: 'connections', label: t('account.nav.connections'), icon: <Link2 className="size-4" />, content: <ConnectedAccountsCard /> },
    ...(user.role !== 'ADMIN' ? [{ value: 'tokens', label: t('account.nav.tokens'), icon: <KeyRound className="size-4" />, content: <ApiTokensCard /> }] : []),
    { value: 'locale', label: t('account.nav.locale'), icon: <Globe className="size-4" />, content: <RegionLanguageCard /> },
  ];
  const cur = sections.find((x) => x.value === params.get('tab')) ?? sections[0]!;
  const go = (v: string) => setParams(v === 'profile' ? {} : { tab: v }, { replace: true });
  return (
    <div>
      <PageHeader title={t('nav.account')} />
      <TabBar
        value={cur.value}
        onChange={go}
        className="mb-4"
        items={sections.map((x) => ({ value: x.value, label: x.label, icon: x.icon }))}
      />
      <section key={cur.value} className="panel-enter min-w-0">
        {cur.content}
      </section>
    </div>
  );
}

function ProfileCard({ user }: { user: MeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(user.name ?? '');
  const save = useMutation({
    mutationFn: () => saveProfile({ name }),
    onSuccess: (u) => {
      qc.setQueryData(['me'], u);
      toast.success(t('account.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Card>
      <CardHeader title={t('account.nav.profile')} actions={<UserAvatar avatar={user.avatar} name={user.name || user.username} size={40} />} />
      <CardBody>
        <InfoList
          items={[
            { label: t('common.email'), value: user.email },
            { label: t('account.userId'), value: <span className="font-mono text-xs">{user.id}</span> },
            { label: t('common.username'), value: user.username },
            { label: t('account.role'), value: user.role === 'ADMIN' ? t('shell.roleAdmin') : t('shell.roleUser') },
            { label: t('account.registeredAt'), value: formatDate(user.createdAt) },
            {
              label: t('account.nickname'),
              value: (
                <form
                  className="flex max-w-sm gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    save.mutate();
                  }}
                >
                  <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder={user.username} aria-label={t('account.nickname')} />
                  <Button type="submit" loading={save.isPending} disabled={name === (user.name ?? '')}>
                    {t('common.save')}
                  </Button>
                </form>
              ),
            },
          ]}
        />
      </CardBody>
    </Card>
  );
}

/** 一批显示的形象数量 */
const VARIANT_PAGE = 8;

/**
 * 头像：左侧大图预览；右侧上面选择风格，下面选择该风格下的形象（可换一批），保存后全站生效
 */
function AvatarCard({ user }: { user: MeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<AvatarStyle>(user.avatar.style);
  const [variant, setVariant] = useState(user.avatar.variant);
  // 从当前形象所在的那一批开始显示
  const [page, setPage] = useState(() => Math.floor(user.avatar.variant / VARIANT_PAGE));
  const name = user.name || user.username;
  const changed = style !== user.avatar.style || variant !== user.avatar.variant;
  const save = useMutation({
    mutationFn: () => saveProfile({ avatarStyle: style, avatarVariant: variant }),
    onSuccess: (u) => {
      qc.setQueryData(['me'], u);
      toast.success(t('avatar.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  const pages = Math.ceil(AVATAR_VARIANTS / VARIANT_PAGE);
  const tile = (selected: boolean) =>
    cn(
      'flex aspect-square items-center justify-center rounded-lg border outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring',
      selected ? 'border-fg bg-surface-3' : 'border-transparent hover:border-line-strong hover:bg-surface-2',
    );
  return (
    <Card>
      <CardHeader
        title={t('avatar.title')}
        description={t('avatar.desc')}
        actions={
          <>
            <Button variant="primary" size="sm" loading={save.isPending} disabled={!changed} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-expanded={open}
              aria-label={t(open ? 'avatar.collapse' : 'avatar.expand')}
              title={t(open ? 'avatar.collapse' : 'avatar.expand')}
              onClick={() => setOpen((value) => !value)}
            >
              <ChevronDown className={cn('transition-transform duration-200', open && 'rotate-180')} />
            </Button>
          </>
        }
      />
      {open && (
        <CardBody className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="flex shrink-0 flex-col items-center gap-2 sm:w-28">
            <UserAvatar avatar={{ ...user.avatar, style, variant }} name={name} size={88} />
            <span className="text-[13px] text-fg-2">{t(`avatar.style.${style}`)}</span>
          </div>
          <div className="min-w-0 flex-1 space-y-4">
            {/* 风格 */}
            <div role="radiogroup" aria-label={t('avatar.title')} className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5">
              {AVATAR_STYLES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={s === style} title={t(`avatar.style.${s}`)} onClick={() => setStyle(s)} className={tile(s === style)}>
                  <UserAvatar avatar={{ ...user.avatar, style: s, variant }} name={name} size={32} />
                </button>
              ))}
            </div>
            {/* 形象：当前风格下的一批形象，可前后翻 */}
            <div className="border-t border-line pt-3.5">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-fg">{t('avatar.variant')}</div>
                  <div className="text-xs text-fg-3">{t('avatar.variantDesc')}</div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="icon-sm" variant="ghost" aria-label={t('avatar.prev')} title={t('avatar.prev')} disabled={page === 0} onClick={() => setPage(page - 1)}>
                    <ChevronLeft />
                  </Button>
                  <Button size="sm" icon={<RefreshCw />} onClick={() => setPage((page + 1) % pages)}>
                    {t('avatar.more')}
                  </Button>
                </div>
              </div>
              <div role="radiogroup" aria-label={t('avatar.variant')} className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
                {Array.from({ length: VARIANT_PAGE }, (_, i) => page * VARIANT_PAGE + i).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={v === variant} onClick={() => setVariant(v)} className={tile(v === variant)}>
                    <UserAvatar avatar={{ ...user.avatar, style, variant: v }} name={name} size={44} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        </CardBody>
      )}
    </Card>
  );
}

/** 邮件通知：每项一行，左侧说明、右侧开关，切换即保存；管理员没有余额和实例，只显示公告邮件 */
function EmailNotifyCard({ user }: { user: MeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (patch: Partial<Pick<MeDTO, 'announceEmail' | 'balanceAlert' | 'alertEmail'>>) => saveProfile(patch),
    onSuccess: (u) => {
      qc.setQueryData(['me'], u);
      toast.success(t('account.saved'));
    },
    onError: (e) => toast.fromError(e),
  });
  const disabled = save.isPending || !!user.impersonatedBy;
  const rows: Array<{ key: 'announceEmail' | 'balanceAlert' | 'alertEmail'; title: string; desc: string; hidden?: boolean }> = [
    { key: 'alertEmail', title: t('reset.alertEmail'), desc: t('reset.alertHint'), hidden: user.role === 'ADMIN' },
    { key: 'balanceAlert', title: t('reset.balanceAlert'), desc: t('reset.balanceHint'), hidden: user.role === 'ADMIN' },
    { key: 'announceEmail', title: t('legal.emailPreference'), desc: t('legal.emailPreferenceHint') },
  ];
  return (
    <Card>
      <CardHeader title={t('account.emailNotify')} description={t('account.emailNotifyDesc')} />
      <CardBody className="divide-y divide-line/70">
        {rows
          .filter((r) => !r.hidden)
          .map((r) => (
            <SwitchRow key={r.key} checked={user[r.key]} onCheckedChange={(v) => save.mutate({ [r.key]: v })} disabled={disabled} title={r.title} description={r.desc} />
          ))}
      </CardBody>
    </Card>
  );
}

function PasswordCard({ user }: { user: MeDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const [pw, setPw] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const change = useMutation({
    mutationFn: () => api.put('/auth/password', { oldPassword: user.hasPassword ? pw.oldPassword : undefined, newPassword: pw.newPassword }),
    onSuccess: () => {
      toast.success(t('account.passwordChanged'));
      setPw({ oldPassword: '', newPassword: '', confirm: '' });
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.fromError(e),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pw.newPassword !== pw.confirm) return toast.error(t('account.passwordMismatch'));
    change.mutate();
  };
  return (
    <Card>
      <CardHeader title={user.hasPassword ? t('account.changePassword') : t('account.setPassword')} description={user.hasPassword ? undefined : t('account.setPasswordDesc')} />
      <CardBody>
        <form className="space-y-4" onSubmit={submit}>
          {user.hasPassword && (
            <FormField label={t('account.oldPassword')}>
              <PasswordInput value={pw.oldPassword} autoComplete="current-password" onChange={(e) => setPw({ ...pw, oldPassword: e.target.value })} />
            </FormField>
          )}
          <FormField label={t('account.newPassword')} description={t('login.passwordHint')}>
            <PasswordInput value={pw.newPassword} autoComplete="new-password" onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          </FormField>
          <FormField label={t('account.confirmNewPassword')}>
            <PasswordInput value={pw.confirm} autoComplete="new-password" onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </FormField>
          <div className="flex justify-end">
            <Button type="submit" variant="primary" loading={change.isPending} disabled={!!user.impersonatedBy}>
              {user.hasPassword ? t('account.changePassword') : t('account.setPassword')}
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

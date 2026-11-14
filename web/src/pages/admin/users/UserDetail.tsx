import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CircleHelp, KeyRound, LogOut, MoonStar, Network, RefreshCw, Server, ShieldCheck, Trash2, UserRound, UsersRound, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import type {
  AdminUserDetailDTO,
  AdminUserDTO,
  AdminUserInstanceDTO,
  AdminUserOAuthAccountDTO,
  AdminUserSecurityDTO,
  AdminUserSessionDTO,
} from '../../../shared/index';
import { oauthIcon } from '@/components/oauth-icon';
import { InstanceStatusBadge, OsIcon, TypeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input, InputGroup } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, CopyButton, Empty, ErrorState, PageLoading, Tag, Tooltip } from '@/components/ui/misc';
import { Segmented, TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMemory, formatMoney, fromNow } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { AdminUserVpcs } from '@/pages/console/Vpcs';
import { UserAvatar } from '@/components/UserAvatar';
import { UserOverview, useUserRefresh } from './UserOverview';
import { UserNightMarket } from './UserNightMarket';
import './UserDetail.css';

const DETAIL_TABS = ['info', 'balance', 'instances', 'vpc', 'night', 'security', 'sessions', 'oauth'] as const;
type DetailTab = (typeof DETAIL_TABS)[number];

export default function AdminUserDetail() {
  const t = useT();
  const qc = useQueryClient();
  const { id: userId = '' } = useParams();
  const id = Number(userId);
  const validId = /^\d+$/.test(userId) && Number.isSafeInteger(id) && id > 0;
  const location = useLocation();
  const listSearch = typeof location.state?.userListSearch === 'string' ? new URLSearchParams(location.state.userListSearch).toString() : '';
  const back = { to: `/admin/users${listSearch ? `?${listSearch}` : ''}`, label: t('nav.admin.users') };
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab') as DetailTab | null;
  const tab = requestedTab && DETAIL_TABS.includes(requestedTab) ? requestedTab : 'info';
  const q = useQuery({ queryKey: ['admin-user', id], queryFn: () => api.get<AdminUserDetailDTO>(`/admin/users/${id}`), enabled: validId });
  const data = validId ? q.data : undefined;
  const u = data?.user;
  const impersonate = useMutation({
    mutationFn: (targetId: number) => api.post(`/admin/users/${targetId}/impersonate`),
    onSuccess: () => window.location.assign('/console/dashboard'),
    onError: (e) => toast.fromError(e),
  });
  const refresh = () => {
    for (const key of ['admin-user', 'admin-user-instances', 'admin-user-vpcs', 'admin-user-night-market', 'admin-user-security', 'admin-user-sessions', 'admin-user-oauth']) {
      void qc.invalidateQueries({ queryKey: [key, id] });
    }
  };
  const setTab = (value: DetailTab) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value === 'info') next.delete('tab');
    else next.set('tab', value);
    return next;
  }, { state: location.state, preventScrollReset: true });
  const content = data && u ? {
    info: <UserOverview data={data} onTab={setTab} onImpersonate={(targetId) => impersonate.mutate(targetId)} impersonating={impersonate.isPending} />,
    balance: <UserBalance user={u} />,
    instances: <UserInstances userId={u.id} />,
    vpc: <AdminUserVpcs userId={u.id} />,
    night: <UserNightMarket userId={u.id} />,
    security: <UserSecurity userId={u.id} />,
    sessions: <UserSessions userId={u.id} />,
    oauth: <UserOAuth userId={u.id} />,
  } : null;

  return (
    <div className="user-detail-page">
      <Link to={back.to} aria-label={back.label} className="mb-4 inline-flex items-center gap-2 text-xs text-fg-3 transition-colors hover:text-fg">
        <ArrowLeft className="size-3.5" />{t('users.backToList')}
      </Link>
      <header className="mb-5 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {u && <UserAvatar avatar={u.avatar} name={u.name || u.username} size={44} />}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl leading-8 font-bold tracking-tight break-all">{u ? u.name || u.username : t('users.manage')}</h1>
              {u && <>
                <Badge tone={u.status === 'ACTIVE' ? 'success' : 'danger'} dot>{t(u.status === 'ACTIVE' ? 'users.active' : 'users.disabled')}</Badge>
                {u.role === 'ADMIN' && <Badge tone="primary">{t('shell.roleAdmin')}</Badge>}
                {!u.emailVerifiedAt && <Badge tone="warning">{t('users.emailUnverified')}</Badge>}
              </>}
            </div>
            {u && <p className="mt-0.5 text-xs break-all text-fg-3">#{u.id} · {u.email}</p>}
          </div>
        </div>
        {validId && <Button size="sm" className="shrink-0" icon={<RefreshCw />} loading={q.isFetching} onClick={refresh}>{t('common.refresh')}</Button>}
      </header>
      {!validId ? <Empty title={t('users.notFound')} /> : !data || !u || !content ? (
        q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <PageLoading />
      ) : (
        <div key={id}>
          <TabBar<DetailTab>
            value={tab}
            onChange={setTab}
            variant="pill"
            className="user-detail-tabs mb-2"
            listClassName="w-full max-w-none rounded-md border-0"
            items={[
              { value: 'info', label: t('users.overviewTitle'), icon: <UserRound /> },
              { value: 'balance', label: t('users.tab.balance'), icon: <Wallet /> },
              { value: 'instances', label: t('users.tab.instances'), icon: <Server />, count: data.usage.instances },
              { value: 'vpc', label: t('users.tab.vpc'), icon: <Network /> },
              { value: 'night', label: t('users.tab.night'), icon: <MoonStar /> },
              { value: 'security', label: t('users.tab.security'), icon: <ShieldCheck /> },
              { value: 'sessions', label: t('users.tab.sessions'), icon: <UsersRound /> },
              { value: 'oauth', label: t('users.tab.oauth'), icon: <KeyRound />, count: u.oauth.length },
            ]}
          />
          <div key={tab} className="panel-enter">
            {tab === 'info' || tab === 'vpc' ? content[tab] : (
              <Card className="user-detail-panel">
                <CardHeader title={t(`users.tab.${tab}`)} />
                <CardBody>{content[tab]}</CardBody>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-12 flex-col items-start gap-2 py-3 sm:flex-row sm:items-center sm:gap-3">
      <span className="flex shrink-0 items-center gap-1 text-fg-2 sm:w-24">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <CircleHelp className="size-3.5 text-fg-4" aria-label={typeof hint === 'string' ? hint : undefined} />
          </Tooltip>
        )}
      </span>
      <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 sm:w-auto sm:justify-end">{children}</div>
    </div>
  );
}

/** 余额调整：增加 / 扣除，金额始终填正数（紧凑排列） */
function UserBalance({ user: u }: { user: AdminUserDTO }) {
  const t = useT();
  const currency = useCurrency();
  const refresh = useUserRefresh(u.id);
  const [mode, setMode] = useState<'add' | 'deduct'>('add');
  const [amount, setAmount] = useState('100');
  const [desc, setDesc] = useState('');
  const n = Math.abs(Number(amount));
  const valid = Number.isFinite(n) && n > 0;
  const after = Number(u.balance) + (mode === 'add' ? n : -n);
  const save = useMutation({
    mutationFn: () => api.post<{ balance: string }>(`/admin/users/${u.id}/balance`, { amount: mode === 'add' ? n : -n, type: mode === 'add' ? 'RECHARGE' : 'ADJUST', description: desc || undefined }),
    onSuccess: (r) => {
      toast.success(mode === 'add' ? t('users.balanceAdded', { amount: formatMoney(n, currency) }) : t('users.balanceDeducted', { amount: formatMoney(n, currency) }), t('billing.currentBalance', { balance: formatMoney(r.balance, currency) }));
      setDesc('');
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <form
      className="text-[13px]"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !save.isPending) save.mutate();
      }}
    >
      <div className="divide-y divide-line/70">
        <Row label={t('billing.currentBalanceLabel')}>
          <span className={cn('tabular text-[15px] font-semibold', Number(u.balance) < 0 && 'text-danger-text')}>{formatMoney(u.balance, currency)}</span>
        </Row>
        <Row label={t('common.type')}>
          <Segmented
            value={mode}
            onChange={setMode}
            items={[
              { value: 'add', label: t('users.addBalance') },
              { value: 'deduct', label: t('users.deductBalance') },
            ]}
          />
        </Row>
        <Row label={t('common.amount')}>
          <div className="w-44">
            <InputGroup className="tabular h-8" prefix={currency} value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} aria-label={t('common.amount')} />
          </div>
        </Row>
        <Row label={t('common.remark')}>
          <Input className="h-8" value={desc} maxLength={200} onChange={(e) => setDesc(e.target.value)} placeholder={mode === 'add' ? t('users.addPlaceholder') : t('users.deductPlaceholder')} />
        </Row>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <span className={cn('text-xs', valid && after < 0 ? 'text-danger-text' : 'text-fg-3')}>
          {valid && t('users.balanceAfter', { balance: formatMoney(after, currency) })}
          {valid && after < 0 && ` ${t('users.negativeHint')}`}
        </span>
        <Button type="submit" size="sm" variant={mode === 'add' ? 'primary' : 'danger'} disabled={!valid} loading={save.isPending}>
          {mode === 'add' ? t('users.confirmAdd', { amount: valid ? formatMoney(n, currency) : '' }) : t('users.confirmDeduct', { amount: valid ? formatMoney(n, currency) : '' })}
        </Button>
      </div>
    </form>
  );
}

/** 用户的实例：点击跳到实例管理 */
function UserInstances({ userId }: { userId: number }) {
  const t = useT();
  const q = useQuery({ queryKey: ['admin-user-instances', userId], queryFn: () => api.get<{ items: AdminUserInstanceDTO[] }>(`/admin/users/${userId}/instances`) });
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <PageLoading />;
  if (!q.data.items.length) return <Empty title={t('users.noInstances')} />;
  return (
    <div>
      <div className="divide-y divide-line rounded-lg border border-line">
        {q.data.items.map((i) => (
          <Link key={i.id} to={`/admin/instances/${i.id}`} className="flex flex-wrap items-center gap-3 px-3.5 py-3 transition-colors hover:bg-surface-2">
            <OsIcon family={i.family ?? 'linux'} className="size-8 text-xs" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="truncate text-[13px] font-medium text-fg">{i.hostname}</span>
                <TypeBadge type={i.type} />
              </div>
              <div className="truncate text-xs text-fg-3">
                {[i.nodeName, i.planName, `${i.cpu}C / ${formatMemory(i.memory)} / ${i.disk}G`, i.ip].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <InstanceStatusBadge status={i.status} reason={i.suspendReason} />
              <div className="mt-1 text-[11px] text-fg-3">{t('users.expires', { date: formatDate(i.expiresAt, 'YYYY-MM-DD') })}</div>
            </div>
          </Link>
        ))}
      </div>
      <div className="mt-3 text-right">
        <Link to={`/admin/instances?userId=${userId}`} className="text-xs text-fg-2 underline underline-offset-2 hover:text-fg">
          {t('users.allInstances')}
        </Link>
      </div>
    </div>
  );
}

/** 用户的登录设备：可退出单个设备或全部 */
function UserSessions({ userId }: { userId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['admin-user-sessions', userId], queryFn: () => api.get<{ items: AdminUserSessionDTO[] }>(`/admin/users/${userId}/sessions`) });
  const revoke = useMutation({
    mutationFn: (sessionId?: string) => api.post<{ count: number }>(`/admin/users/${userId}/sessions/revoke`, sessionId ? { sessionId } : {}),
    onSuccess: (r, sessionId) => {
      toast.success(sessionId ? t('users.sessionRevoked') : t('users.kicked', { n: r.count }));
      void qc.invalidateQueries({ queryKey: ['admin-user-sessions', userId] });
    },
    onError: (e) => toast.fromError(e),
  });
  const items = q.data?.items;
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-[13px] text-fg-3">{items ? t('users.sessionCount', { n: items.length }) : ''}</span>
        <Button
          size="sm"
          icon={<LogOut />}
          disabled={!items?.length}
          onClick={async () => {
            if (await confirm({ title: t('users.kickAllTitle'), description: t('users.kickDesc'), confirmText: t('users.kick') })) revoke.mutate(undefined);
          }}
        >
          {t('users.kickAll')}
        </Button>
      </div>
      {!items ? (
        q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <PageLoading />
      ) : !items.length ? (
        <Empty title={t('users.noSessions')} />
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {items.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-fg" translate="no">
                    {s.os} · {s.browser}
                  </span>
                  {s.impersonatedBy && <Tag tone="warning">{t('users.impersonatedBy', { name: s.impersonatedBy })}</Tag>}
                </div>
                <div className="mt-0.5 text-xs text-fg-3">
                  <span className="font-mono">{s.ip ?? '—'}</span> · {t('users.lastActive', { time: fromNow(s.lastActiveAt) })} · {t('users.signedInAt', { time: formatDate(s.createdAt) })}
                </div>
              </div>
              <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === s.id} onClick={() => revoke.mutate(s.id)}>
                {t('users.signOut')}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 两步验证与通行密钥：查看状态；用户丢失认证器时关闭两步验证（清除密钥与恢复码，用户可重新设置），
 * 删除单个或全部通行密钥。管理员不能替用户添加
 */
function UserSecurity({ userId }: { userId: number }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ['admin-user-security', userId];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<AdminUserSecurityDTO>(`/admin/users/${userId}/security`) });
  const done = (msg: string) => {
    toast.success(msg);
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ['admin-user', userId] });
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  };
  const disable2fa = useMutation({
    mutationFn: () => api.post(`/admin/users/${userId}/2fa/disable`),
    onSuccess: () => done(t('users.twofaDisabled')),
    onError: (e) => toast.fromError(e),
  });
  const removePasskey = useMutation({
    mutationFn: (pid?: number) => api.delete<{ count?: number }>(pid ? `/admin/users/${userId}/passkeys/${pid}` : `/admin/users/${userId}/passkeys`),
    onSuccess: (r, pid) => done(pid ? t('users.passkeyRemoved') : t('users.passkeysRemoved', { n: r.count ?? 0 })),
    onError: (e) => toast.fromError(e),
  });
  const d = q.data;
  if (!d) return q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <PageLoading />;
  return (
    <div className="space-y-4">
      {/* 两步验证 */}
      <div className="rounded-lg border border-line">
        <div className="flex flex-wrap items-center gap-3 px-3.5 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 text-fg-2">
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium text-fg">{t('users.twofa')}</span>
              <Badge tone={d.twofa.enabled ? 'success' : 'neutral'} dot>
                {d.twofa.enabled ? t('users.twofaOn') : t('users.twofaOff')}
              </Badge>
            </div>
            <div className="mt-0.5 text-xs text-fg-3">
              {d.twofa.enabled
                ? t('users.twofaDetail', { time: formatDate(d.twofa.enabledAt), n: d.twofa.recoveryRemaining })
                : t('users.twofaOffDesc')}
            </div>
          </div>
          <Button
            size="sm"
            variant="danger-ghost"
            disabled={!d.twofa.enabled}
            loading={disable2fa.isPending}
            onClick={async () => {
              if (await confirm({ title: t('users.twofaDisableTitle'), description: t('users.twofaDisableDesc'), danger: true, confirmText: t('users.twofaDisable') })) disable2fa.mutate();
            }}
          >
            {t('users.twofaDisable')}
          </Button>
        </div>
      </div>

      {/* 通行密钥 */}
      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[13px] text-fg-3">{t('users.passkeyCount', { n: d.passkeys.length })}</span>
          <Button
            size="sm"
            variant="danger-ghost"
            icon={<Trash2 />}
            disabled={!d.passkeys.length}
            loading={removePasskey.isPending && removePasskey.variables === undefined}
            onClick={async () => {
              if (await confirm({ title: t('users.passkeysRemoveTitle'), description: t('users.passkeysRemoveDesc'), danger: true, confirmText: t('users.passkeysRemove') }))
                removePasskey.mutate(undefined);
            }}
          >
            {t('users.passkeysRemove')}
          </Button>
        </div>
        {!d.passkeys.length ? (
          <Empty title={t('users.noPasskeys')} />
        ) : (
          <div className="divide-y divide-line rounded-lg border border-line">
            {d.passkeys.map((pk) => (
              <div key={pk.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
                <KeyRound className="size-4 shrink-0 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate font-medium text-fg">{pk.name}</span>
                    <Tag>{pk.deviceType === 'multiDevice' ? t('users.passkeySynced') : t('users.passkeyDevice')}</Tag>
                  </div>
                  <div className="mt-0.5 text-xs text-fg-3">
                    {t('users.passkeyAdded', { time: formatDate(pk.createdAt) })} · {pk.lastUsedAt ? t('users.lastActive', { time: fromNow(pk.lastUsedAt) }) : t('users.passkeyNeverUsed')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={removePasskey.isPending && removePasskey.variables === pk.id}
                  onClick={async () => {
                    if (await confirm({ title: t('users.passkeyRemoveTitle', { name: pk.name }), description: t('users.passkeyRemoveDesc'), danger: true, confirmText: t('common.delete') }))
                      removePasskey.mutate(pk.id);
                  }}
                >
                  {t('common.delete')}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** 用户绑定的第三方登录账号（只读） */
function UserOAuth({ userId }: { userId: number }) {
  const t = useT();
  const q = useQuery({ queryKey: ['admin-user-oauth', userId], queryFn: () => api.get<{ hasPassword: boolean; items: AdminUserOAuthAccountDTO[] }>(`/admin/users/${userId}/oauth`) });
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <PageLoading />;
  return (
    <div>
      <div className="mb-3 text-[13px] text-fg-3">
        {t('users.oauthCount', { n: q.data.items.length })}
        {!q.data.hasPassword && t('users.oauthOnly')}
      </div>
      {!q.data.items.length ? (
        <Empty title={t('users.noOauth')} />
      ) : (
        <div className="divide-y divide-line rounded-lg border border-line">
          {q.data.items.map((a) => (
            <div key={a.id} className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line">{oauthIcon(a.provider, a.providerName, a.icon)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-fg">{a.providerName}</span>
                  {a.removed ? <Tag tone="danger">{t('users.providerRemoved')}</Tag> : !a.active && <Tag>{t('users.providerOff')}</Tag>}
                </div>
                <div className="truncate text-xs text-fg-3" translate="no">
                  {[a.name, a.email].filter(Boolean).join(' · ') || '—'}
                </div>
                <div className="flex items-center gap-1 text-[11px] text-fg-4">
                  ID <span className="font-mono">{a.providerId}</span>
                  <CopyButton value={a.providerId} />
                </div>
              </div>
              <span className="shrink-0 text-xs text-fg-3">{t('users.boundAt', { time: formatDate(a.createdAt, 'YYYY-MM-DD') })}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

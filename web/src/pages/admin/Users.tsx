import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleHelp, Ellipsis, KeyRound, LogIn, LogOut, Plus, Search, ShieldCheck, ShieldOff, Trash2, UserCog, Users as UsersIcon, Wallet } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type {
  AdminUserDetailDTO,
  AdminUserDTO,
  AdminUserInstanceDTO,
  AdminUserOAuthAccountDTO,
  AdminUserSecurityDTO,
  AdminUserSessionDTO,
  Paginated,
  Role,
  UserStatus,
} from '../../shared/index';
import { oauthIcon } from '@/components/oauth-icon';
import { PageHeader, Toolbar } from '@/components/page';
import { InstanceStatusBadge, OsIcon, TypeBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { DropdownMenu } from '@/components/ui/menu';
import { Alert, Badge, Card, CopyButton, Empty, ErrorState, PageLoading, Tag, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { Segmented, TabBar } from '@/components/ui/tabs';
import { useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMemory, formatMoney, fromNow } from '@/lib/format';
import { useCurrency, useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { AdminUserVpcs } from '@/pages/console/Vpcs';
import { UserAvatar } from '@/components/UserAvatar';

type DetailTab = 'info' | 'balance' | 'instances' | 'vpc' | 'security' | 'sessions' | 'oauth';

/** 新建用户 */
function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const currency = useCurrency();
  const qc = useQueryClient();
  const [f, setF] = useState({ email: '', username: '', password: '', role: 'USER' as Role, remark: '', balance: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = useMutation({
    mutationFn: () => api.post('/admin/users', { ...f, balance: f.balance || undefined }),
    onSuccess: () => {
      toast.success(t('users.created'));
      void qc.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('users.create')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('common.username')} required>
          <Input value={f.username} onChange={set('username')} />
        </FormField>
        <FormField label={t('common.email')} required>
          <Input type="email" value={f.email} onChange={set('email')} />
        </FormField>
        <FormField label={t('common.password')} required description={t('login.passwordHint')}>
          <Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
        </FormField>
        <FormField label={t('account.role')}>
          <Select
            value={f.role}
            onChange={(v) => setF({ ...f, role: v })}
            options={[
              { value: 'USER', label: t('shell.roleUser') },
              { value: 'ADMIN', label: t('shell.roleAdmin'), description: t('users.adminHint') },
            ]}
          />
        </FormField>
        <FormField label={t('users.initialBalance')}>
          <InputGroup prefix={currency} value={f.balance} onChange={set('balance')} placeholder="0" inputMode="decimal" />
        </FormField>
        <FormField label={t('common.remark')}>
          <Input value={f.remark} onChange={set('remark')} />
        </FormField>
      </div>
    </Modal>
  );
}

export default function AdminUsers() {
  const t = useT();
  const currency = useCurrency();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<UserStatus | 'ALL'>('ALL');
  const [role, setRole] = useState<Role | 'ALL'>('ALL');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<{ id: number; tab: DetailTab } | null>(null);
  const open = (id: number, tab: DetailTab = 'info') => setDetail({ id, tab });
  const list = useQuery({
    queryKey: ['admin-users', q, status, role, page],
    queryFn: () => api.get<Paginated<AdminUserDTO>>('/admin/users', { q, status: status === 'ALL' ? undefined : status, role: role === 'ALL' ? undefined : role, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-users'] });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: object }) => api.patch(`/admin/users/${id}`, body),
    onSuccess: () => {
      toast.success(t('users.updated'));
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  const impersonate = useMutation({
    mutationFn: (id: number) => api.post(`/admin/users/${id}/impersonate`),
    // 整页跳转：会话已切换为该用户，避免仍打开的管理页面（如用户详情）用新会话重新请求管理接口而报无权限
    onSuccess: () => window.location.assign('/dashboard'),
    onError: (e) => toast.fromError(e),
  });
  const kickAll = async (u: AdminUserDTO) => {
    if (!(await confirm({ title: t('users.kickTitle', { name: u.username }), description: t('users.kickDesc'), confirmText: t('users.kick') }))) return;
    api.post<{ count: number }>(`/admin/users/${u.id}/sessions/revoke`, {}).then((r) => toast.success(t('users.kicked', { n: r.count })), (e) => toast.fromError(e));
  };

  return (
    <>
      <PageHeader
        title={t('nav.admin.users')}
        description={t('users.subtitle')}
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            {t('users.create')}
          </Button>
        }
      />
      <Card>
        <Toolbar>
          <div className="relative min-w-0 sm:w-72">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
            <Input
              className="pl-9"
              placeholder={t('users.search')}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <Select<UserStatus | 'ALL'>
            className="sm:w-32"
            value={status}
            onChange={(v) => {
              setStatus(v);
              setPage(1);
            }}
            options={[
              { value: 'ALL', label: t('users.allStatus') },
              { value: 'ACTIVE', label: t('users.active') },
              { value: 'DISABLED', label: t('users.disabled') },
            ]}
          />
          <Select<Role | 'ALL'>
            className="sm:w-32"
            value={role}
            onChange={(v) => {
              setRole(v);
              setPage(1);
            }}
            options={[
              { value: 'ALL', label: t('users.allRoles') },
              { value: 'USER', label: t('shell.roleUser') },
              { value: 'ADMIN', label: t('shell.roleAdmin') },
            ]}
          />
        </Toolbar>
        <DataTable
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(u) => u.id}
          empty={<Empty title={t('users.empty')} icon={<UsersIcon />} />}
          columns={[
            {
              key: 'name',
              header: t('common.user'),
              mobile: 'title',
              cell: (u) => (
                <button type="button" onClick={() => open(u.id)} className="group flex min-w-0 items-center gap-3 text-left">
                  <UserAvatar avatar={u.avatar} name={u.name || u.username} size={32} />
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-center gap-1.5 font-medium text-fg group-hover:underline">
                      {u.name || u.username}
                      {u.role === 'ADMIN' && <Badge tone="primary">{t('shell.roleAdmin')}</Badge>}
                    </span>
                    <span className="block truncate text-xs text-fg-3">
                      #{u.id} · {u.username} · {u.email}
                    </span>
                  </span>
                </button>
              ),
            },
            {
              key: 'status',
              header: t('common.status'),
              cell: (u) => (
                <div className="flex flex-wrap gap-1">
                  {u.status === 'ACTIVE' ? <Tag tone="success">{t('users.active')}</Tag> : <Tag tone="danger">{t('users.disabled')}</Tag>}
                  {!u.emailVerifiedAt && <Tag tone="warning">{t('users.emailUnverified')}</Tag>}
                </div>
              ),
            },
            {
              key: 'oauth',
              header: t('users.oauth'),
              mobile: 'hide',
              cell: (u) =>
                u.oauth.length ? (
                  <button type="button" onClick={() => open(u.id, 'oauth')} className="flex items-center gap-1.5" aria-label={t('users.oauth')}>
                    {u.oauth.map((o) => (
                      <span key={o.provider} title={o.providerName} className={cn('flex', !o.active && 'opacity-40')}>
                        {oauthIcon(o.provider, o.providerName, o.icon)}
                      </span>
                    ))}
                  </button>
                ) : (
                  <span className="text-fg-4">—</span>
                ),
            },
            {
              key: 'balance',
              header: t('common.balance'),
              cell: (u) => <span className={cn('tabular', Number(u.balance) < 0 && 'text-danger-text')}>{formatMoney(u.balance, currency)}</span>,
            },
            {
              key: 'inst',
              header: t('nav.instances'),
              cell: (u) => (
                <button type="button" className="tabular font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg" onClick={() => open(u.id, 'instances')}>
                  {u.instanceCount}
                </button>
              ),
            },
            {
              key: 'login',
              header: t('users.lastLogin'),
              cell: (u) => (
                <div className="text-xs">
                  <div>{u.lastLoginAt ? fromNow(u.lastLoginAt) : t('users.neverLogin')}</div>
                  <div className="font-mono text-fg-3">{u.lastLoginIp}</div>
                </div>
              ),
            },
            { key: 'created', header: t('account.registeredAt'), mobile: 'hide', cell: (u) => <span className="text-xs">{formatDate(u.createdAt, 'YYYY-MM-DD')}</span> },
            {
              key: 'actions',
              header: '',
              className: 'w-12',
              mobile: 'actions',
              cell: (u) => (
                <DropdownMenu
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={t('common.actions')}>
                      <Ellipsis />
                    </Button>
                  }
                  items={[
                    { label: t('users.manage'), icon: <UserCog />, onClick: () => open(u.id) },
                    { label: t('users.adjustBalance'), icon: <Wallet />, onClick: () => open(u.id, 'balance') },
                    { label: t('adminUsers.verifyEmail'), hidden: !!u.emailVerifiedAt, onClick: () => patch.mutate({ id: u.id, body: { emailVerified: true } }) },
                    { label: t('users.kick'), icon: <LogOut />, onClick: () => kickAll(u) },
                    {
                      label: t('users.impersonate'),
                      icon: <LogIn />,
                      hidden: u.id === me?.id || u.role === 'ADMIN',
                      onClick: async () => {
                        if (await confirm({ title: t('users.impersonateTitle', { name: u.username }), description: t('users.impersonateDesc') })) impersonate.mutate(u.id);
                      },
                    },
                    {
                      label: u.status === 'ACTIVE' ? t('users.disable') : t('users.enable'),
                      danger: u.status === 'ACTIVE',
                      hidden: u.id === me?.id,
                      onClick: async () => {
                        if (u.status === 'ACTIVE' && !(await confirm({ title: t('users.disableTitle', { name: u.username }), description: t('users.disableDesc'), danger: true, confirmText: t('users.disable') }))) return;
                        patch.mutate({ id: u.id, body: { status: u.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' } });
                      },
                    },
                  ]}
                />
              ),
            },
          ]}
        />
        {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
      </Card>
      {creating && <CreateUserDialog onClose={() => setCreating(false)} />}
      <UserDetailModal detail={detail} onClose={() => setDetail(null)} onImpersonate={(id) => impersonate.mutate(id)} />
    </>
  );
}

/** 用户管理弹窗：基本信息与账号设置、余额调整、实例、登录设备、第三方登录 */
function UserDetailModal({ detail, onClose, onImpersonate }: { detail: { id: number; tab: DetailTab } | null; onClose: () => void; onImpersonate: (id: number) => void }) {
  const t = useT();
  const id = detail?.id ?? null;
  const [tab, setTab] = useState<DetailTab>('info');
  useEffect(() => {
    if (detail) setTab(detail.tab);
  }, [detail]);
  const q = useQuery({ queryKey: ['admin-user', id], queryFn: () => api.get<AdminUserDetailDTO>(`/admin/users/${id}`), enabled: id != null });
  const data = id != null ? q.data : undefined;
  const u = data?.user;
  return (
    <Modal open={id != null} onOpenChange={(o) => !o && onClose()} size="lg" title={u ? u.name || u.username : t('common.user')} description={u?.email}>
      {!data || !u ? (
        q.error ? <Alert tone="danger">{errorText(q.error)}</Alert> : <PageLoading />
      ) : (
        <div className="-mt-1">
          <TabBar<DetailTab>
            value={tab}
            onChange={setTab}
            className="mb-3"
            items={[
              { value: 'info', label: t('users.tab.info') },
              { value: 'balance', label: t('users.tab.balance') },
              { value: 'instances', label: `${t('users.tab.instances')} ${data.usage.instances}` },
              { value: 'vpc', label: t('users.tab.vpc') },
              { value: 'security', label: t('users.tab.security') },
              { value: 'sessions', label: t('users.tab.sessions') },
              { value: 'oauth', label: `${t('users.tab.oauth')} ${u.oauth.length}` },
            ]}
          />
          <div key={tab} className="panel-enter">
            {tab === 'info' && <UserInfo data={data} onClose={onClose} onImpersonate={onImpersonate} />}
            {tab === 'balance' && <UserBalance user={u} />}
            {tab === 'instances' && <UserInstances userId={u.id} onClose={onClose} />}
            {tab === 'vpc' && <AdminUserVpcs userId={u.id} onNavigate={onClose} />}
            {tab === 'security' && <UserSecurity userId={u.id} />}
            {tab === 'sessions' && <UserSessions userId={u.id} />}
            {tab === 'oauth' && <UserOAuth userId={u.id} />}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** 修改用户后刷新列表和详情 */
function useUserRefresh(id: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['admin-user', id] });
    void qc.invalidateQueries({ queryKey: ['admin-users'] });
  };
}

/** 紧凑的设置行：左侧标签（悬停图标看说明），右侧控件 */
/** 状态行的右侧：当前状态标签 + 切换操作按钮（替代开关） */
function StateAction({
  on,
  onLabel,
  offLabel,
  onTone = 'success',
  actionLabel,
  danger,
  disabled,
  loading,
  onClick,
}: {
  on: boolean;
  onLabel: string;
  offLabel: string;
  onTone?: 'success' | 'primary';
  actionLabel: string;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Badge tone={on ? onTone : 'neutral'} dot>
        {on ? onLabel : offLabel}
      </Badge>
      <Button size="sm" variant={danger ? 'danger-ghost' : 'secondary'} className={cn('min-w-24', danger && 'border-danger/20 bg-danger-soft')} disabled={disabled} loading={loading} onClick={onClick}>
        {actionLabel}
      </Button>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 py-1.5">
      <span className="flex w-24 shrink-0 items-center gap-1 text-fg-2">
        {label}
        {hint && (
          <Tooltip content={hint}>
            <CircleHelp className="size-3.5 text-fg-4" aria-label={typeof hint === 'string' ? hint : undefined} />
          </Tooltip>
        )}
      </span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

/** 基本信息：概要（含余额）、资源、账号信息，以及资料、账号开关、重置密码等设置（紧凑排列） */
function UserInfo({ data, onClose, onImpersonate }: { data: AdminUserDetailDTO; onClose: () => void; onImpersonate: (id: number) => void }) {
  const t = useT();
  const currency = useCurrency();
  const confirm = useConfirm();
  const { data: me } = useMe();
  const refresh = useUserRefresh(data.user.id);
  const u = data.user;
  const self = u.id === me?.id;
  const [profile, setProfile] = useState({ email: u.email, name: u.name ?? '', remark: u.remark ?? '' });
  const [password, setPassword] = useState('');
  useEffect(() => setProfile({ email: u.email, name: u.name ?? '', remark: u.remark ?? '' }), [u.email, u.name, u.remark]);
  const dirty = profile.email !== u.email || profile.name !== (u.name ?? '') || profile.remark !== (u.remark ?? '');
  const patch = useMutation({
    mutationFn: (body: object) => api.patch(`/admin/users/${u.id}`, body),
    onSuccess: (_r, body) => {
      toast.success('password' in body ? t('users.passwordReset') : t('users.updated'));
      if ('password' in body) setPassword('');
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  const reset2fa = useMutation({
    mutationFn: () => api.post(`/admin/users/${u.id}/reset-2fa`),
    onSuccess: () => {
      toast.success(t('users.reset2faDone'));
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });

  const usage = data.usage;
  const resources: Array<[string, number, string?, string?]> = [
    [t('nav.instances'), usage.instances, usage.instances ? `${usage.cpu}C / ${formatMemory(usage.memory)} / ${usage.disk}G` : undefined, `/admin/instances?userId=${u.id}`],
    [t('users.running'), usage.running],
    [t('users.ports'), usage.ports],
    [t('users.sites'), usage.sites],
  ];
  const info: Array<[string, ReactNode]> = [
    [t('users.userId'), <span className="font-mono text-xs">#{u.id}</span>],
    [t('common.username'), u.username],
    [t('account.registeredAt'), formatDate(u.createdAt)],
    [t('users.lastLogin'), u.lastLoginAt ? <span title={formatDate(u.lastLoginAt, 'YYYY-MM-DD HH:mm:ss')}>{fromNow(u.lastLoginAt)}</span> : t('users.neverLogin')],
    [t('users.loginIp'), <span className="font-mono text-xs">{u.lastLoginIp ?? '—'}</span>],
    [t('users.twoFactor'), u.twoFactorEnabled ? t('users.twoFactorOn') : t('users.twoFactorOff')],
  ];

  // 正在提交的是哪一项（只在对应按钮上显示加载中）
  const pending = (key: string) => patch.isPending && !!patch.variables && key in (patch.variables as Record<string, unknown>);
  return (
    <div className="space-y-3 text-[13px]">
      {/* 概要 */}
      <div className="flex items-center gap-3">
        <UserAvatar avatar={u.avatar} name={u.name || u.username} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate font-semibold text-fg">{u.name || u.username}</span>
            {u.status === 'ACTIVE' ? <Tag tone="success">{t('users.active')}</Tag> : <Tag tone="danger">{t('users.disabled')}</Tag>}
            {u.role === 'ADMIN' && <Tag tone="primary">{t('shell.roleAdmin')}</Tag>}
            {!u.emailVerifiedAt && <Tag tone="warning">{t('users.emailUnverified')}</Tag>}
          </div>
          <div className="truncate text-xs text-fg-3">{u.email}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-xs text-fg-3">{t('common.balance')}</div>
          <div className={cn('tabular text-[15px] font-semibold', Number(u.balance) < 0 ? 'text-danger-text' : 'text-fg')}>{formatMoney(u.balance, currency)}</div>
        </div>
      </div>

      {/* 资源 */}
      <div className="grid grid-cols-4 divide-x divide-line rounded-lg border border-line">
        {resources.map(([label, n, sub, to]) => {
          const body = (
            <>
              <div className="truncate text-xs text-fg-3">{label}</div>
              <div className="tabular font-semibold text-fg group-hover:underline">{n}</div>
            </>
          );
          return to ? (
            <Link key={label} to={to} onClick={onClose} title={sub} className="group min-w-0 px-3 py-1.5 transition-colors first:rounded-l-lg hover:bg-surface-2">
              {body}
            </Link>
          ) : (
            <div key={label} className="min-w-0 px-3 py-1.5">
              {body}
            </div>
          );
        })}
      </div>

      {/* 账号信息 */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
        {info.map(([k, v]) => (
          <div key={k} className="flex min-w-0 items-center gap-3">
            <dt className="w-16 shrink-0 text-fg-3">{k}</dt>
            <dd className="min-w-0 truncate text-fg">{v}</dd>
          </div>
        ))}
      </dl>

      {/* 资料：邮箱、昵称、备注一行编辑 */}
      <form
        className="grid grid-cols-1 gap-2 border-t border-line pt-3 sm:grid-cols-[1.4fr_1fr_1fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) patch.mutate({ email: profile.email, name: profile.name || null, remark: profile.remark || null });
        }}
      >
        <Input className="h-8" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} aria-label={t('common.email')} title={t('common.email')} placeholder={t('common.email')} />
        <Input className="h-8" value={profile.name} maxLength={32} onChange={(e) => setProfile({ ...profile, name: e.target.value })} aria-label={t('account.nickname')} title={t('account.nickname')} placeholder={`${t('account.nickname')}（${u.username}）`} />
        <Input className="h-8" value={profile.remark} maxLength={200} onChange={(e) => setProfile({ ...profile, remark: e.target.value })} aria-label={t('common.remark')} title={t('users.remarkHint')} placeholder={t('common.remark')} />
        <Button type="submit" size="sm" variant={dirty ? 'primary' : 'secondary'} disabled={!dirty} loading={patch.isPending && dirty}>
          {t('common.save')}
        </Button>
      </form>

      {/* 账号开关、重置密码、其他操作 */}
      <div className="divide-y divide-line/70 border-t border-line">
        {/* 账号状态、邮箱验证、角色：当前状态 + 操作按钮（都需要确认） */}
        <Row label={t('users.enabled')} hint={self ? t('users.selfLocked') : t('users.enabledHint')}>
          <StateAction
            on={u.status === 'ACTIVE'}
            onLabel={t('users.state.active')}
            offLabel={t('users.state.disabled')}
            actionLabel={u.status === 'ACTIVE' ? t('users.disable') : t('users.enable')}
            danger={u.status === 'ACTIVE'}
            disabled={self || patch.isPending}
            loading={patch.isPending && pending('status')}
            onClick={async () => {
              const v = u.status !== 'ACTIVE';
              if (!v && !(await confirm({ title: t('users.disableTitle', { name: u.username }), description: t('users.disableDesc'), danger: true, confirmText: t('users.disable') }))) return;
              patch.mutate({ status: v ? 'ACTIVE' : 'DISABLED' });
            }}
          />
        </Row>
        <Row label={t('users.emailVerifiedLabel')} hint={t('users.emailVerifiedHint')}>
          <StateAction
            on={!!u.emailVerifiedAt}
            onLabel={t('users.state.verified')}
            offLabel={t('users.state.unverified')}
            actionLabel={u.emailVerifiedAt ? t('users.action.unverify') : t('users.action.verify')}
            disabled={patch.isPending}
            loading={patch.isPending && pending('emailVerified')}
            onClick={async () => {
              const v = !u.emailVerifiedAt;
              const ok = await confirm(
                v
                  ? { title: t('users.verifyTitle', { name: u.username }), description: t('users.verifyDesc', { email: u.email }), confirmText: t('users.action.verify') }
                  : { title: t('users.unverifyTitle', { name: u.username }), description: t('users.unverifyDesc'), danger: true, confirmText: t('users.action.unverify') },
              );
              if (ok) patch.mutate({ emailVerified: v });
            }}
          />
        </Row>
        <Row label={t('users.roleLabel')} hint={self ? t('users.selfLocked') : t('users.adminHint')}>
          <StateAction
            on={u.role === 'ADMIN'}
            onLabel={t('shell.roleAdmin')}
            offLabel={t('users.state.user')}
            onTone="primary"
            actionLabel={u.role === 'ADMIN' ? t('users.action.demote') : t('users.action.promote')}
            disabled={self || patch.isPending}
            loading={patch.isPending && pending('role')}
            onClick={async () => {
              const v = u.role !== 'ADMIN';
              if (!(await confirm({ title: v ? t('users.promoteTitle', { name: u.username }) : t('users.demoteTitle', { name: u.username }), description: v ? t('users.promoteDesc') : t('users.demoteDesc'), danger: v }))) return;
              patch.mutate({ role: v ? 'ADMIN' : 'USER' });
            }}
          />
        </Row>
        <Row label={t('users.resetPassword')} hint={data.hasPassword ? t('users.resetPasswordHint') : t('users.noPasswordHint')}>
          <form
            className="flex w-full max-w-sm gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (password.length >= 8) patch.mutate({ password });
            }}
          >
            <Input className="h-8" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('users.newPasswordPlaceholder')} aria-label={t('users.resetPassword')} />
            <Button type="submit" size="sm" disabled={password.length < 8}>
              {t('users.reset')}
            </Button>
          </form>
        </Row>
        {(u.twoFactorEnabled || (!self && u.role !== 'ADMIN')) && (
          <Row label={t('users.moreActions')}>
            {u.twoFactorEnabled && (
              <Button
                size="sm"
                icon={<ShieldOff />}
                loading={reset2fa.isPending}
                onClick={async () => {
                  if (await confirm({ title: t('users.reset2faTitle', { name: u.username }), description: t('users.reset2faDesc'), danger: true })) reset2fa.mutate();
                }}
              >
                {t('users.reset2fa')}
              </Button>
            )}
            {!self && u.role !== 'ADMIN' && (
              <Button
                size="sm"
                icon={<LogIn />}
                onClick={async () => {
                  if (await confirm({ title: t('users.impersonateTitle', { name: u.username }), description: t('users.impersonateDesc') })) onImpersonate(u.id);
                }}
              >
                {t('users.impersonate')}
              </Button>
            )}
          </Row>
        )}
      </div>
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
        if (valid) save.mutate();
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
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-3">
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
function UserInstances({ userId, onClose }: { userId: number; onClose: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['admin-user-instances', userId], queryFn: () => api.get<{ items: AdminUserInstanceDTO[] }>(`/admin/users/${userId}/instances`) });
  if (!q.data) return <PageLoading />;
  if (!q.data.items.length) return <Empty title={t('users.noInstances')} />;
  return (
    <div>
      <div className="max-h-[360px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
        {q.data.items.map((i) => (
          <Link key={i.id} to={`/admin/instances/${i.id}`} onClick={onClose} className="flex items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-surface-2">
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
        <Link to={`/admin/instances?userId=${userId}`} onClick={onClose} className="text-xs text-fg-2 underline underline-offset-2 hover:text-fg">
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
        <PageLoading />
      ) : !items.length ? (
        <Empty title={t('users.noSessions')} />
      ) : (
        <div className="max-h-[360px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
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
          <div className="max-h-[300px] divide-y divide-line overflow-y-auto rounded-lg border border-line">
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
  if (!q.data) return <PageLoading />;
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

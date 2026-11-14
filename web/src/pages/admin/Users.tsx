import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, LogIn, LogOut, Plus, Search, UserCog, Users as UsersIcon, Wallet } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { AdminUserDTO, Paginated, Role, UserStatus } from '../../shared/index';
import { oauthIcon } from '@/components/oauth-icon';
import { PageHeader, Toolbar } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { DropdownMenu } from '@/components/ui/menu';
import { Badge, Card, Empty, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney, fromNow } from '@/lib/format';
import { useCurrency, useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { UserAvatar } from '@/components/UserAvatar';

export default function AdminUsers() {
  const t = useT();
  const currency = useCurrency();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = (['ACTIVE', 'DISABLED'].includes(params.get('status') ?? '') ? params.get('status') : 'ALL') as UserStatus | 'ALL';
  const role = (['USER', 'ADMIN'].includes(params.get('role') ?? '') ? params.get('role') : 'ALL') as Role | 'ALL';
  const pageValue = Number(params.get('page') ?? 1);
  const page = Number.isSafeInteger(pageValue) && pageValue > 0 ? pageValue : 1;
  const navigationState = { userListSearch: params.toString() };
  const open = (id: number, tab?: string) => navigate(`/admin/users/${id}${tab ? `?tab=${tab}` : ''}`, { state: navigationState });
  const filter = (key: 'q' | 'status' | 'role', value: string) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value && (key === 'q' || value !== 'ALL')) next.set(key, value);
    else next.delete(key);
    next.delete('page');
    return next;
  }, { replace: true });
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
    onSuccess: () => window.location.assign('/console/dashboard'),
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
          <LinkButton variant="primary" icon={<Plus />} to="/admin/users/new" state={navigationState}>
            {t('users.create')}
          </LinkButton>
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
              onChange={(e) => filter('q', e.target.value)}
            />
          </div>
          <Select<UserStatus | 'ALL'>
            className="sm:w-32"
            value={status}
            onChange={(v) => filter('status', v)}
            options={[
              { value: 'ALL', label: t('users.allStatus') },
              { value: 'ACTIVE', label: t('users.active') },
              { value: 'DISABLED', label: t('users.disabled') },
            ]}
          />
          <Select<Role | 'ALL'>
            className="sm:w-32"
            value={role}
            onChange={(v) => filter('role', v)}
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
                <Link to={`/admin/users/${u.id}`} state={navigationState} className="group flex min-w-0 items-center gap-3 text-left">
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
                </Link>
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
                  <Link to={`/admin/users/${u.id}?tab=oauth`} state={navigationState} className="flex items-center gap-1.5" aria-label={t('users.oauth')}>
                    {u.oauth.map((o) => (
                      <span key={o.provider} title={o.providerName} className={cn('flex', !o.active && 'opacity-40')}>
                        {oauthIcon(o.provider, o.providerName, o.icon)}
                      </span>
                    ))}
                  </Link>
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
                <Link to={`/admin/users/${u.id}?tab=instances`} state={navigationState} className="tabular font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
                  {u.instanceCount}
                </Link>
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
        {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={(value) => setParams((prev) => {
          const next = new URLSearchParams(prev);
          if (value > 1) next.set('page', String(value));
          else next.delete('page');
          return next;
        })} />}
      </Card>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network, Pencil, Plus, Trash, X } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { VpcDTO, VpcListDTO, VpcLocationDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { PageHeader } from '@/components/page';
import { InstanceStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Card, CopyButton, Empty, ErrorState, PageLoading, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { toast } from '@/lib/toast';

/**
 * 使用范围：用户管理自己的 VPC（/vpcs），或管理员在用户管理里代该用户管理（/admin/users/:id/vpcs，
 * 不受数量上限限制）。接口前缀、缓存键与实例链接随范围变化
 */
interface VpcScope {
  base: string;
  queryKey: readonly unknown[];
  admin: boolean;
  instanceHref: (id: number) => string;
  /** 点击实例链接时（管理员在弹窗里需要先关闭弹窗） */
  onNavigate?: () => void;
}
const USER_SCOPE: VpcScope = { base: '/vpcs', queryKey: ['vpcs'], admin: false, instanceHref: (id) => `/console/instances/${id}` };
const ScopeContext = createContext<VpcScope>(USER_SCOPE);

/** 位置说明：与哪些实例在同一台宿主机 */
const locationText = (loc: VpcLocationDTO) => loc.instances.map((i) => i.hostname).join('、');

function CreateDialog({ data, onClose }: { data: VpcListDTO; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const scope = useContext(ScopeContext);
  const [name, setName] = useState('');
  // 网段默认留空，由服务端自动分配不冲突的网段
  const [cidr, setCidr] = useState('');
  const [nodeId, setNodeId] = useState<number | null>(data.locations[0]?.nodeId ?? null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<VpcDTO>(scope.base, { name: name.trim(), cidr: cidr.trim() || undefined, nodeId }),
    onSuccess: (v) => {
      toast.success(t('vpc.created', { name: v.name }), t('vpc.createdCidr', { cidr: v.cidr }));
      void qc.invalidateQueries({ queryKey: scope.queryKey });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('vpc.create')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!name.trim() || !nodeId} onClick={() => create.mutate()}>
            {t('vpc.create')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && nodeId) create.mutate();
        }}
      >
        <FormField label={t('vpc.name')} required>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder={t('vpc.namePlaceholder')} />
        </FormField>
        <FormField label={t('vpc.location')} description={t('vpc.locationHint')}>
          <Select<number>
            value={nodeId}
            onChange={setNodeId}
            options={data.locations.map((l) => ({ value: l.nodeId, label: t('vpc.locationLabel', { region: l.region, n: l.instances.length }), description: locationText(l) }))}
          />
        </FormField>
        <FormField label={`${t('vpc.cidr')}${t('common.optionalSuffix')}`} description={t('vpc.cidrHint')}>
          <Input value={cidr} onChange={(e) => setCidr(e.target.value)} className="font-mono" placeholder={t('vpc.cidrAuto')} />
        </FormField>
      </form>
    </Modal>
  );
}

function JoinDialog({ vpc, location, onClose }: { vpc: VpcDTO; location: VpcLocationDTO | undefined; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const scope = useContext(ScopeContext);
  const candidates = (location?.instances ?? []).filter((i) => i.vpcId === null);
  const [instanceId, setInstanceId] = useState<number | null>(candidates[0]?.id ?? null);
  const [ip, setIp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const join = useMutation({
    mutationFn: () => api.post<{ ip: string; configured: boolean }>(`${scope.base}/${vpc.id}/instances`, { instanceId, ip: ip.trim() || undefined }),
    onSuccess: (r) => {
      if (r.configured) toast.success(t('vpc.joined', { ip: r.ip }));
      else toast.success(t('vpc.joined', { ip: r.ip }), t('vpc.joinedPending'));
      void qc.invalidateQueries({ queryKey: scope.queryKey });
      void qc.invalidateQueries({ queryKey: ['instances'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('vpc.joinTitle', { name: vpc.name })}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={join.isPending} disabled={!instanceId} onClick={() => join.mutate()}>
            {t('vpc.join')}
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <Alert tone="neutral">{t('vpc.noCandidates')}</Alert>
      ) : (
        <div className="space-y-4">
          <FormField label={t('common.instance')} description={t('vpc.sameHostOnly')}>
            <Select<number> value={instanceId} onChange={setInstanceId} options={candidates.map((i) => ({ value: i.id, label: i.hostname, description: i.name }))} />
          </FormField>
          <FormField label={`${t('vpc.ip')}${t('common.optionalSuffix')}`} description={t('vpc.ipHint', { cidr: vpc.cidr })}>
            <Input value={ip} onChange={(e) => setIp(e.target.value)} className="font-mono" placeholder={t('vpc.ipAuto')} />
          </FormField>
        </div>
      )}
    </Modal>
  );
}

function RenameDialog({ vpc, onClose }: { vpc: VpcDTO; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const scope = useContext(ScopeContext);
  const [name, setName] = useState(vpc.name);
  const save = useMutation({
    mutationFn: () => api.patch(`${scope.base}/${vpc.id}`, { name: name.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scope.queryKey });
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('vpc.rename')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!name.trim()} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate();
        }}
      >
        <FormField label={t('vpc.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        </FormField>
      </form>
    </Modal>
  );
}

function VpcCard({ vpc, location }: { vpc: VpcDTO; location: VpcLocationDTO | undefined }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [joining, setJoining] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const scope = useContext(ScopeContext);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: scope.queryKey });
    void qc.invalidateQueries({ queryKey: ['instances'] });
  };
  const leave = useMutation({
    mutationFn: (instanceId: number) => api.delete(`${scope.base}/${vpc.id}/instances/${instanceId}`),
    onSuccess: () => {
      toast.success(t('vpc.left'));
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`${scope.base}/${vpc.id}`),
    onSuccess: () => {
      toast.success(t('vpc.deleted'));
      reload();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <Network className="size-4 shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[15px] font-semibold text-fg">{vpc.name}</span>
            <Tag className="font-mono">{vpc.cidr}</Tag>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-3">
            {vpc.country && <CountryFlag code={vpc.country} className="h-3 w-4.5" />}
            {vpc.region}
            {location && <span className="truncate">· {t('vpc.sameHostAs', { names: locationText(location) })}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="primary" icon={<Plus />} onClick={() => setJoining(true)}>
            {t('vpc.join')}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t('vpc.rename')} title={t('vpc.rename')} onClick={() => setRenaming(true)}>
            <Pencil />
          </Button>
          <Button
            size="icon-sm"
            variant="danger-ghost"
            aria-label={t('common.delete')}
            title={vpc.members.length ? t('vpc.deleteNeedEmpty') : t('common.delete')}
            disabled={vpc.members.length > 0 || remove.isPending}
            onClick={async () => {
              if (await confirm({ title: t('vpc.deleteTitle', { name: vpc.name }), description: t('vpc.deleteDesc'), danger: true })) remove.mutate();
            }}
          >
            <Trash />
          </Button>
        </div>
      </div>
      {vpc.members.length === 0 ? (
        <p className="px-4 py-5 text-center text-[13px] text-fg-3">{t('vpc.noMembers')}</p>
      ) : (
        <ul className="divide-y divide-line/70">
          {vpc.members.map((m) => (
            <li key={m.instanceId} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-[13px]">
              <Link to={scope.instanceHref(m.instanceId)} onClick={scope.onNavigate} className="min-w-0 flex-1 truncate font-medium text-fg hover:underline">
                {m.hostname}
                <span className="ml-2 font-mono text-xs font-normal text-fg-3">{m.name}</span>
              </Link>
              <span className="inline-flex items-center gap-1 font-mono text-fg">
                {m.ip}
                <CopyButton value={m.ip} />
              </span>
              <InstanceStatusBadge status={m.status} />
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-fg-3 transition-colors hover:text-danger-text disabled:opacity-50"
                disabled={leave.isPending}
                onClick={async () => {
                  if (await confirm({ title: t('vpc.leaveTitle', { name: m.hostname }), description: t('vpc.leaveDesc'), danger: true })) leave.mutate(m.instanceId);
                }}
              >
                <X className="size-3.5" />
                {t('vpc.leave')}
              </button>
            </li>
          ))}
        </ul>
      )}
      {joining && <JoinDialog vpc={vpc} location={location} onClose={() => setJoining(false)} />}
      {renaming && <RenameDialog vpc={vpc} onClose={() => setRenaming(false)} />}
    </Card>
  );
}

/** VPC 列表（用户页面与管理员的用户详情共用） */
function VpcList({ data }: { data: VpcListDTO }) {
  return (
    <div className="space-y-4">
      {data.items.map((v) => (
        <VpcCard key={v.id} vpc={v} location={data.locations.find((l) => l.nodeId === v.nodeId)} />
      ))}
    </div>
  );
}

/** 私有网络（VPC）：同一台宿主机上的实例通过内网互联 */
export default function VpcsPage() {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const q = useQuery({ queryKey: USER_SCOPE.queryKey, queryFn: () => api.get<VpcListDTO>(USER_SCOPE.base) });
  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  const full = data.items.length >= data.limit;
  return (
    <ScopeContext.Provider value={USER_SCOPE}>
      <PageHeader
        title={t('nav.vpc')}
        description={t('vpc.subtitle')}
        actions={
          data.limit > 0 && (
            <Button variant="primary" icon={<Plus />} disabled={full || data.locations.length === 0} onClick={() => setCreating(true)} title={full ? t('vpc.limitReached', { n: data.limit }) : undefined}>
              {t('vpc.create')}
            </Button>
          )
        }
      />
      {data.limit === 0 ? (
        <Alert tone="neutral">{t('vpc.notOpen')}</Alert>
      ) : data.items.length === 0 ? (
        <Card>
          <Empty title={t('vpc.empty')} description={data.locations.length ? t('vpc.emptyDesc') : t('vpc.needInstance')} icon={<Network />} />
        </Card>
      ) : (
        <>
          <p className="mb-4 text-xs text-fg-3">{t('vpc.count', { n: data.items.length, limit: data.limit })}</p>
          <VpcList data={data} />
        </>
      )}
      {creating && <CreateDialog data={data} onClose={() => setCreating(false)} />}
    </ScopeContext.Provider>
  );
}

/** 管理员：用户管理里代该用户管理 VPC（创建、改名、删除、加入 / 移出实例），不受数量上限限制 */
export function AdminUserVpcs({ userId, onNavigate }: { userId: number; onNavigate?: () => void }) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const scope: VpcScope = {
    base: `/admin/users/${userId}/vpcs`,
    queryKey: ['admin-user-vpcs', userId],
    admin: true,
    instanceHref: (id) => `/admin/instances/${id}`,
    onNavigate,
  };
  const q = useQuery({ queryKey: scope.queryKey, queryFn: () => api.get<VpcListDTO>(scope.base) });
  if (q.isLoading) return <PageLoading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  return (
    <ScopeContext.Provider value={scope}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-fg-3">{t('vpc.adminCount', { n: data.items.length, limit: data.limit })}</p>
        <Button size="sm" variant="primary" icon={<Plus />} disabled={data.locations.length === 0} title={data.locations.length ? undefined : t('vpc.adminNeedInstance')} onClick={() => setCreating(true)}>
          {t('vpc.create')}
        </Button>
      </div>
      {data.items.length === 0 ? (
        <Card>
          <Empty title={t('vpc.adminEmpty')} description={data.locations.length ? t('vpc.adminEmptyDesc') : t('vpc.adminNeedInstance')} icon={<Network />} />
        </Card>
      ) : (
        <VpcList data={data} />
      )}
      {creating && <CreateDialog data={data} onClose={() => setCreating(false)} />}
    </ScopeContext.Provider>
  );
}

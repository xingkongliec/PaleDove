import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Boxes, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { INSTANCE_STATUSES, INSTANCE_TYPES, type AdminInstanceDTO, type InstanceStatus, type InstanceType, type NodeDTO, type Paginated } from '../../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { InstanceStatusBadge, OsIcon, TypeBadge } from '@/components/status';
import { LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, Checkbox, Empty, ErrorState } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatMemory } from '@/lib/format';
import { connectAddress, ExpiryCell, TrafficCell } from '../../console/Instances';
import { InstanceBatchBar } from './InstanceBatchBar';
import { InstanceRowActions } from './InstanceRowActions';

/**
 * 实例列表（搜索、筛选、分页）。传入 nodeId 时固定为该宿主机的实例（宿主机详情页的「实例」标签），
 * 不显示宿主机筛选与宿主机列。
 */
export function InstanceTable({ nodeId: fixedNodeId }: { nodeId?: number }) {
  const { t, L } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [status, setStatus] = useState<InstanceStatus | 'ALL'>(() => (params.get('status') as InstanceStatus | null) ?? 'ALL');
  const [type, setType] = useState<InstanceType | 'ALL'>('ALL');
  const [nodeFilter, setNodeId] = useState<number>(Number(params.get('nodeId')) || 0);
  const nodeId = fixedNodeId ?? nodeFilter;
  const [page, setPage] = useState(1);
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes'), enabled: !fixedNodeId });
  const list = useQuery({
    queryKey: ['admin-instances', q, status, type, nodeId, page, params.get('userId')],
    queryFn: () =>
      api.get<Paginated<AdminInstanceDTO>>('/admin/instances', {
        q,
        status: status === 'ALL' ? undefined : status,
        type: type === 'ALL' ? undefined : type,
        nodeId: nodeId || undefined,
        userId: fixedNodeId ? undefined : (params.get('userId') ?? undefined),
        page,
        pageSize: 20,
      }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  // 多选：跨页保留，批量操作完成或取消后清空
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const pageIds = (list.data?.items ?? []).map((i) => i.id);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (ids: number[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const reset = <T,>(fn: (v: T) => void) => (v: T) => {
    fn(v);
    setPage(1);
  };

  return (
    <Card>
      <Toolbar>
        <div className="relative min-w-0 sm:min-w-56 sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-3" />
          <Input className="pl-9" placeholder={t('adminInstances.search')} value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        </div>
        <div className={cn('grid gap-2 sm:flex', fixedNodeId ? 'grid-cols-2' : 'grid-cols-3')}>
          <Select<InstanceStatus | 'ALL'>
            className="sm:w-32"
            value={status}
            onChange={reset(setStatus)}
            options={[{ value: 'ALL', label: t('adminInstances.allStatus') }, ...INSTANCE_STATUSES.map((s) => ({ value: s, label: L.instanceStatus[s] }))]}
          />
          <Select<InstanceType | 'ALL'>
            className="sm:w-40"
            value={type}
            onChange={reset(setType)}
            options={[{ value: 'ALL', label: t('adminInstances.allTypes') }, ...INSTANCE_TYPES.map((ty) => ({ value: ty, label: L.instanceType[ty] }))]}
          />
          {!fixedNodeId && (
            <Select<number>
              className="sm:w-40"
              value={nodeId}
              onChange={reset(setNodeId)}
              options={[{ value: 0, label: t('sitesAdmin.allNodes') }, ...(nodes.data ?? []).map((n) => ({ value: n.id, label: n.name }))]}
            />
          )}
        </div>
      </Toolbar>
      {selected.size > 0 && <InstanceBatchBar ids={[...selected]} onClear={() => setSelected(new Set())} />}
      {list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <DataTable
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(i) => i.id}
          onRowClick={(i) => navigate(`/admin/instances/${i.id}`)}
          empty={<Empty title={t('adminInstances.empty')} icon={<Boxes />} />}
          columns={[
            {
              key: 'select',
              header: <Checkbox checked={allOnPage} onCheckedChange={(v) => toggle(pageIds, v)} />,
              className: 'w-10',
              headerClassName: 'w-10',
              mobile: 'actions',
              // 勾选不触发整行跳转
              cell: (i) => (
                <span onClick={(e) => e.stopPropagation()}>
                  <Checkbox checked={selected.has(i.id)} onCheckedChange={(v) => toggle([i.id], v)} />
                </span>
              ),
            },
            {
              key: 'name',
              header: t('common.instance'),
              mobile: 'title',
              cell: (i) => (
                <div className="flex min-w-0 items-center gap-2.5">
                  <OsIcon family={i.image?.family ?? 'linux'} className="size-7 text-[11px]" />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-fg">{i.hostname}</div>
                    <div className="truncate font-mono text-xs text-fg-3">
                      #{i.id} · {i.name}
                    </div>
                  </div>
                </div>
              ),
            },
            { key: 'user', header: t('common.user'), cell: (i) => <span className="text-fg-2">{i.user.username}</span> },
            { key: 'status', header: t('common.status'), cell: (i) => <InstanceStatusBadge status={i.status} reason={i.suspendReason} activeTask={i.activeTask} /> },
            {
              key: 'type',
              header: fixedNodeId ? t('common.type') : t('adminInstances.typeNode'),
              cell: (i) => (
                <div className="space-y-1">
                  <TypeBadge type={i.type} />
                  {!fixedNodeId && <div className="text-xs text-fg-3">{i.node.name}</div>}
                </div>
              ),
            },
            {
              key: 'addr',
              header: t('instances.address'),
              cell: (i) => (
                <div className="font-mono text-xs">
                  <div>{connectAddress(i) ?? '—'}</div>
                  {i.privateIp && <div className="text-fg-3">{i.privateIp}</div>}
                </div>
              ),
            },
            {
              key: 'spec',
              header: t('instances.spec'),
              cell: (i) => (
                <span className="text-xs whitespace-nowrap text-fg-2">
                  {i.cpu}C / {formatMemory(i.memory)} / {i.disk}G
                </span>
              ),
            },
            { key: 'traffic', header: t('spec.traffic'), cell: (i) => <TrafficCell inst={i} /> },
            { key: 'expires', header: t('instances.expires'), cell: (i) => <ExpiryCell expiresAt={i.expiresAt} /> },
            // 编辑菜单：修改续费价格、单独配置、刷新状态
            { key: 'actions', header: '', className: 'w-px text-right', cell: (i) => <InstanceRowActions inst={i} /> },
          ]}
        />
      )}
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
    </Card>
  );
}

export default function AdminInstances() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader
        title={t('nav.admin.instances')}
        description={t('adminInstances.subtitle')}
        actions={
          <LinkButton to="/admin/instances/new" variant="primary" icon={<Plus />}>
            {t('instCreate.title')}
          </LinkButton>
        }
      />
      <InstanceTable />
    </>
  );
}

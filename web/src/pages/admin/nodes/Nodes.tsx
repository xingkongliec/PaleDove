import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, Plus, Server, Terminal } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { hasIpv6Mode, type NodeDTO } from '../../../shared/index';
import { CountryFlag } from '@/components/country';
import { PageHeader } from '@/components/page';
import { CaddyStatusBadge, NodeStatusBadge } from '@/components/status';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, Empty, ErrorState } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';
import { MODE_LABEL } from './NodeForm';

/** 测试连接：确认面板证书仍被信任，并刷新状态、Incus 版本与 NAT 网段（只读取宿主机信息） */
function TestButton({ node }: { node: NodeDTO }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-nodes'] });
    void qc.invalidateQueries({ queryKey: ['admin-node', node.id] });
  };
  const test = useMutation({
    mutationFn: () => api.post<{ version: string; warnings: string[] }>(`/admin/nodes/${node.id}/connect`, {}),
    onSuccess: (r) => {
      toast.success(t('nodes.testOk', { name: node.name, version: r.version }), r.warnings.join('; ') || undefined);
      refresh();
    },
    onError: (e) => {
      toast.fromError(e, t('nodes.testFailed', { name: node.name }));
      refresh();
    },
  });
  return (
    <Button
      size="sm"
      icon={<Plug />}
      loading={test.isPending}
      onClick={(e) => {
        e.stopPropagation();
        test.mutate();
      }}
    >
      {t('nodes.test')}
    </Button>
  );
}

export default function AdminNodes() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // 兼容旧链接 /admin/nodes?new=1：跳转到独立的添加页面
  useEffect(() => {
    if (params.get('new') === '1') navigate('/admin/nodes/new', { replace: true });
  }, [params, navigate]);
  const q = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes'), refetchInterval: 30_000 });
  return (
    <>
      <PageHeader
        title={t('nav.admin.nodes')}
        description={t('nodes.subtitle')}
        actions={
          <LinkButton to="/admin/nodes/new" variant="primary" icon={<Plus />}>
            {t('nodes.add')}
          </LinkButton>
        }
      />
      <Card>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <DataTable
            rows={q.data}
            loading={q.isLoading}
            refreshing={q.isFetching}
            rowKey={(n) => n.id}
            onRowClick={(n) => navigate(`/admin/nodes/${n.id}`)}
            empty={
              <Empty
                title={t('nodes.empty')}
                description={t('nodes.emptyDesc')}
                icon={<Server />}
                action={
                  <LinkButton to="/admin/nodes/new" variant="primary" icon={<Terminal />}>
                    {t('nodes.add')}
                  </LinkButton>
                }
              />
            }
            columns={[
              {
                key: 'name',
                header: t('common.node'),
                cell: (n) => (
                  <div className="flex min-w-0 items-center gap-3">
                    <CountryFlag code={n.country} className="h-4 w-6" />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium text-fg">
                        <span className="truncate">{n.name}</span>
                        {!n.enabled && <Badge>{t('common.disabled')}</Badge>}
                      </div>
                      <div className="truncate text-xs text-fg-3">{[n.region, n.description].filter(Boolean).join(' · ')}</div>
                    </div>
                  </div>
                ),
              },
              {
                key: 'status',
                header: t('common.status'),
                cell: (n) => (
                  <div>
                    <NodeStatusBadge status={n.status} />
                    {n.lastCheckedAt && <div className="mt-1 text-xs text-fg-3">{t('fmt.checkedAgo', { time: fromNow(n.lastCheckedAt) })}</div>}
                  </div>
                ),
              },
              {
                key: 'mode',
                header: t('nodeForm.networkMode'),
                cell: (n) => (
                  <div>
                    <div className="text-[13px] whitespace-nowrap text-fg-2">{t(MODE_LABEL[n.networkMode])}</div>
                    {/* IPv6 模式显示子网；未设置时提示，此时不会分配新的 IPv6 实例 */}
                    {hasIpv6Mode(n.networkMode) &&
                      (n.ipv6Subnet ? (
                        <div className="mt-0.5 font-mono text-[11px] text-fg-3">{n.ipv6Subnet}</div>
                      ) : (
                        <div className="mt-0.5 text-xs text-warning-text">{t('nodes.ipv6Missing')}</div>
                      ))}
                  </div>
                ),
              },
              { key: 'ip', header: t('nodes.publicIp'), cell: (n) => <span className="font-mono text-xs">{n.publicIp || '—'}</span> },
              {
                key: 'ver',
                header: 'Incus',
                cell: (n) => (
                  <div>
                    <div className="text-xs text-fg-2">{n.incusVersion ?? '—'}</div>
                    {n.arch && <div className="mt-0.5 font-mono text-[11px] text-fg-3">{n.arch}</div>}
                  </div>
                ),
              },
              {
                key: 'inst',
                header: t('nodes.instances'),
                cell: (n) => (
                  <span className="tabular">
                    {n.instanceCount} / {n.maxInstances}
                  </span>
                ),
              },
              {
                key: 'ips',
                header: t('nodes.ipPool'),
                cell: (n) => (
                  <span className="tabular">
                    {n.ipStats.used} / {n.ipStats.total}
                  </span>
                ),
              },
              { key: 'caddy', header: 'Caddy', cell: (n) => <CaddyStatusBadge status={n.caddyStatus} /> },
              {
                key: 'actions',
                header: '',
                className: 'w-24 text-right',
                cell: (n) =>
                  n.status === 'PENDING' ? (
                    <LinkButton size="sm" variant="soft" to={`/admin/nodes/${n.id}`} onClick={(e) => e.stopPropagation()}>
                      {t('nodes.install')}
                    </LinkButton>
                  ) : (
                    <TestButton node={n} />
                  ),
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}

// 「节点测试」按钮与弹窗：购买页选中产品后显示，打开时按产品 + 地区查询公开结果（没有结果时提示未开启或等待结果）；宿主机详情由管理员查看并可立即测试
import { useMutation, useQuery } from '@tanstack/react-query';
import { CirclePlay, Radar } from 'lucide-react';
import { useState } from 'react';
import type { NodePingDTO } from '../../shared/index';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { Empty, Skeleton } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { NodeTestView } from './NodeTest';

/** 购买页：产品在所选地区的节点测试（选中产品后总是显示按钮，打开时才查询） */
export function ProductNodeTestButton({ productId, region, productName }: { productId: number; region: string; productName: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['product-ping', productId, region],
    queryFn: () => api.get<{ enabled: boolean; nodes: NodePingDTO[] }>(`/public/products/${productId}/ping`, { region }),
    enabled: open,
    staleTime: 5 * 60_000,
  });
  return (
    <>
      <Button size="sm" icon={<CirclePlay />} onClick={() => setOpen(true)}>
        {t('ping.open')}
      </Button>
      <Modal open={open} onOpenChange={setOpen} size="2xl" title={t('ping.title', { name: `${productName} · ${region}` })} description={t('ping.desc')}>
        {!q.data ? (
          <Skeleton className="h-96 w-full" />
        ) : q.data.nodes.length ? (
          <NodeTestView nodes={q.data.nodes} />
        ) : (
          <Empty icon={<Radar />} title={t(q.data.enabled ? 'ping.pending' : 'ping.notEnabled')} description={t(q.data.enabled ? 'ping.pendingDesc' : 'ping.notEnabledDesc')} />
        )}
      </Modal>
    </>
  );
}

/** 宿主机详情（管理员）：查看结果，立即测试 */
export function AdminNodeTestButton({ nodeId, nodeName }: { nodeId: number; nodeName: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ['admin-node-ping', nodeId],
    queryFn: () => api.get<{ enabled: boolean; result: NodePingDTO | null }>(`/admin/nodes/${nodeId}/ping`),
    enabled: open,
  });
  const run = useMutation({
    mutationFn: () => api.post(`/admin/nodes/${nodeId}/ping-run`),
    onSuccess: () => toast.success(t('nodeDetail.pingRunDone')),
    onError: (e) => toast.fromError(e),
  });
  return (
    <>
      <Button size="sm" variant="ghost" icon={<Radar />} onClick={() => setOpen(true)}>
        {t('nodeDetail.pingTitle')}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        size="2xl"
        title={t('ping.title', { name: nodeName })}
        description={t('ping.desc')}
        footer={
          <>
            <Button variant="ghost" loading={q.isFetching} onClick={() => void q.refetch()}>
              {t('common.refresh')}
            </Button>
            <Button variant="primary" icon={<CirclePlay />} disabled={!q.data?.enabled} loading={run.isPending} onClick={() => run.mutate()}>
              {t('nodeDetail.pingRun')}
            </Button>
          </>
        }
      >
        {!q.data ? <Skeleton className="h-96 w-full" /> : <NodeTestView nodes={q.data.result ? [q.data.result] : []} />}
      </Modal>
    </>
  );
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AdminInstanceDTO, InstanceDTO, TaskDTO } from '../shared/index';
import { api } from '@/lib/api';
import { t, type MessageKey } from '@/i18n';
import { toast } from '@/lib/toast';
import { useMe } from '@/lib/queries';

export type AnyInstance = InstanceDTO | AdminInstanceDTO;

export function isBusy(inst: Pick<InstanceDTO, 'status' | 'activeTask'>): boolean {
  return !!inst.activeTask || ['CREATING', 'REINSTALLING', 'MIGRATING', 'DELETING'].includes(inst.status);
}

/** 正在交易市场挂牌：实例已关机并锁定，用户只能查看与续费（管理员不受限，见服务端 routes/instances.ts） */
export function useMarketLocked(inst: Pick<InstanceDTO, 'marketListing'>): boolean {
  const { data: me } = useMe();
  return me?.role !== 'ADMIN' && !!inst.marketListing;
}

/** 按当前会话角色使用各自的实例接口；代登录会话属于普通用户。 */
export function useInstanceApiPath(id: number): string {
  const { data: me } = useMe();
  return `${me?.role === 'ADMIN' ? '/admin' : ''}/instances/${id}`;
}

export function useInstance(id: number) {
  const path = useInstanceApiPath(id);
  return useQuery({
    queryKey: ['instance', id, path],
    queryFn: () => api.get<AnyInstance>(path),
    // 有进行中的任务时加快轮询
    refetchInterval: (q) => (q.state.data && isBusy(q.state.data) ? 2000 : 15_000),
    // 切回标签页时立即刷新（轮询在页面隐藏时暂停）
    refetchOnWindowFocus: true,
  });
}

export function useInstances() {
  return useQuery({
    queryKey: ['instances'],
    queryFn: () => api.get<InstanceDTO[]>('/instances'),
    refetchInterval: (q) => (q.state.data?.some(isBusy) ? 3000 : 20_000),
  });
}

export type PowerAction = 'start' | 'stop' | 'restart' | 'force_stop';
const POWER_LABEL: Record<PowerAction, MessageKey> = { start: 'power.start', stop: 'power.stop', restart: 'power.restart', force_stop: 'power.forceStop' };

export function usePowerAction(id: number) {
  const path = useInstanceApiPath(id);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: PowerAction) => api.post<TaskDTO>(`${path}/power`, { action }),
    onSuccess: (_t, action) => {
      toast.success(t('power.submitted', { action: t(POWER_LABEL[action]) }));
      void qc.invalidateQueries({ queryKey: ['instance', id] });
      void qc.invalidateQueries({ queryKey: ['instances'] });
      void qc.invalidateQueries({ queryKey: ['instance-tasks', id] });
    },
    onError: (e) => toast.fromError(e),
  });
}

/** 使实例相关的所有查询失效 */
export function useInvalidateInstance(id: number) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['instance', id] });
    void qc.invalidateQueries({ queryKey: ['instances'] });
    void qc.invalidateQueries({ queryKey: ['instance-tasks', id] });
    void qc.invalidateQueries({ queryKey: ['me'] });
  };
}

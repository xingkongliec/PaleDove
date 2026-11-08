// 网络出口（智能分流）：宿主机开启智能分流时，NAT 实例可在宿主机配置的出口之间切换；
// 宿主机 Agent 约 10 秒内应用。WireGuard 出口为宿主机隧道（全协议，私钥不会下发到实例），SOCKS5 / HTTP 只转发 TCP。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Route } from 'lucide-react';
import type { InstanceEgressDTO } from '../../shared/index';
import { Badge, Card } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useInstanceApiPath, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';

/** 0 表示宿主机默认线路 */
const DIRECT = 0;

export function EgressCard({ inst }: { inst: AnyInstance }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const path = useInstanceApiPath(inst.id);
  const key = ['instance-egress', inst.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<InstanceEgressDTO>(`${path}/egress`), staleTime: 30_000 });
  const save = useMutation({
    mutationFn: (egressId: number | null) => api.put<InstanceEgressDTO>(`${path}/egress`, { egressId }),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      toast.success(t('egress.switched'), t('egress.switchedDesc'));
    },
    onError: (e) => toast.fromError(e),
  });
  const d = q.data;
  if (!d?.available) return null;
  const current = d.options.find((o) => o.id === d.current) ?? null;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 py-3.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Route className="size-4 text-fg-3" />
          <h3 className="text-[15px] font-semibold text-fg">{t('egress.userTitle')}</h3>
          {current && current.ok !== null && (
            <Badge tone={current.ok ? 'success' : 'danger'} dot>
              {current.ok ? t('egress.statusOk') : t('egress.statusDown')}
            </Badge>
          )}
        </div>
        <p className="mt-1 max-w-xl text-xs leading-relaxed text-fg-3">{current?.type === 'WIREGUARD' || !current ? t('egress.userDescWg') : t('egress.userDescProxy')}</p>
      </div>
      <Select<number>
        className="w-full sm:w-72"
        aria-label={t('egress.userTitle')}
        value={d.current ?? DIRECT}
        disabled={save.isPending}
        onChange={(v) => save.mutate(v === DIRECT ? null : v)}
        options={[
          { value: DIRECT, label: t('egress.direct'), description: t('egress.directDesc') },
          ...d.options.map((o) => ({
            value: o.id,
            label: o.name,
            description: [t(`egress.typeName.${o.type}`), o.remark, o.ok === false ? t('egress.statusDown') : null].filter(Boolean).join(' · '),
          })),
        ]}
      />
    </Card>
  );
}

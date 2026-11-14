// 切换机房：规则说明（购买页与实例管理共用）与实例的切换弹窗。
// 每台实例 30 天免费切换一次（所有用户相同，不分等级）；免费次数用完后按系统设置的费用额外切换。
// 切换在目标机房全新安装系统，原数据不迁移，公网 IP 会变化；保留到期时间、计费周期、套餐与已用流量。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, Check, Clock, Gauge, Globe, RefreshCw, Server, ShieldCheck, Shuffle, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { formatMultiplier, type ImageDTO, type InstanceIpv4CheckDTO } from '../../shared/index';
import { combineSshKeys, SshKeyField, useSshKeys } from '@/components/SshKeys';
import { ImagePicker } from '@/components/ImagePicker';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Badge, CodeBlock, Skeleton } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useInstanceApiPath, useInvalidateInstance, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney, formatTraffic } from '@/lib/format';
import { useCurrency, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';

interface SwitchTarget {
  id: number;
  name: string;
  region: string;
  country: string;
  available: boolean;
  /** 产品在该机房的流量倍率与切换后的流量额度（GB，0 为不限） */
  trafficMultiplier: number;
  traffic: number;
}

interface SwitchInfo {
  current: { id: number; name: string; region: string; country: string; trafficMultiplier: number; traffic: number };
  targets: SwitchTarget[];
  free: boolean;
  nextFreeAt: string | null;
  fee: string;
  cooldownUntil: string | null;
  blocked: string | null;
}

/** 规则中的一行：图标、标题与副标题、说明 */
function RuleRow({ icon, title, sub, desc }: { icon: ReactNode; title: string; sub: string; desc: string }) {
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,10rem)_1fr] items-start gap-3 py-2.5 text-[13px]">
      <span className="mt-0.5 text-fg-3 [&>svg]:size-4">{icon}</span>
      <div>
        <div className="font-medium text-fg">{title}</div>
        <div className="text-xs text-fg-3">{sub}</div>
      </div>
      <div className="text-fg-2">{desc}</div>
    </div>
  );
}

/**
 * 切换机房规则：当前与可切换的机房、保留项、周期免费与额外切换费用、注意事项与切换条件。
 * from / to 为机房名称（购买页为所选节点与其他节点，实例管理为当前与目标机房）
 */
export function SwitchRules({ from, to, fee, compact = false }: { from?: string; to?: string[]; fee: number; compact?: boolean }) {
  const { t } = useI18n();
  const currency = useCurrency();
  return (
    <div className={compact ? 'space-y-3' : 'space-y-4'}>
      {from && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line bg-surface-2/60 px-4 py-3">
          <div>
            <div className="text-xs text-fg-3">{t('switch.current')}</div>
            <div className="font-semibold text-fg">{from}</div>
          </div>
          <ArrowRight className="size-4 text-fg-4" />
          <div>
            <div className="text-xs text-fg-3">{t('switch.to')}</div>
            <div className="font-semibold text-fg">{to?.length ? to.join(' / ') : '—'}</div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-fg-2">
        {(['switch.keepExpiry', 'switch.keepCycle', 'switch.samePlan'] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <Check className="size-3.5 text-success-icon" />
            {t(k)}
          </span>
        ))}
      </div>

      {/* 周期免费（所有人相同，不分等级）与额外切换 */}
      <div className="grid overflow-hidden rounded-lg border border-line sm:grid-cols-2">
        <div className={compact ? 'p-3' : 'p-4'}>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
            <CalendarDays className="size-4 text-fg-3" />
            {t('switch.freeTitle')}
          </div>
          <div className={cn('flex items-baseline gap-1', compact ? 'mt-1' : 'mt-3')}>
            <span className={cn('tabular font-bold text-fg', compact ? 'text-xl' : 'text-3xl')}>30</span>
            <span className="text-[13px] text-fg-3">{t('switch.perDays')}</span>
          </div>
          <p className="mt-2 text-xs text-fg-3">{t('switch.freeNote')}</p>
        </div>
        <div className={cn('border-t border-line sm:border-t-0 sm:border-l', compact ? 'p-3' : 'p-4')}>
          <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
            <Wallet className="size-4 text-fg-3" />
            {t('switch.extraTitle')}
          </div>
          {fee > 0 ? (
            <>
              <div className={cn('tabular font-bold text-fg', compact ? 'mt-1 text-xl' : 'mt-3 text-3xl')}>{formatMoney(fee, currency)}</div>
              <p className="mt-2 text-xs text-fg-3">{t('switch.extraNote')}</p>
            </>
          ) : (
            <p className="mt-3 text-[13px] text-fg-3">{t('switch.extraOff')}</p>
          )}
        </div>
      </div>

      <div className="divide-y divide-line">
        <RuleRow icon={<ShieldCheck />} title={t('switch.rulePlan')} sub={t('switch.rulePlanSub')} desc={t('switch.rulePlanDesc')} />
        <RuleRow icon={<Gauge />} title={t('switch.ruleTraffic')} sub={t('switch.ruleTrafficSub')} desc={t('switch.ruleTrafficDesc')} />
      </div>

      <div className={compact ? 'grid items-start gap-3 sm:grid-cols-2' : 'space-y-4'}>
        <Alert tone="warning" title={t('switch.reinstallTitle')}>
          {t('switch.reinstallDesc')}
        </Alert>
        <Alert tone="danger" title={t('switch.abuseTitle')}>
          {t('switch.abuseDesc')}
        </Alert>
      </div>

      <div className="border-t border-line pt-3">
        <div className="mb-2 text-xs text-fg-3">{t('switch.requires')}</div>
        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-[13px] text-fg-2">
          {(
            [
              [<Globe key="g" />, 'switch.reqIpv4'],
              [<Server key="s" />, 'switch.reqCapacity'],
              [<Shuffle key="t" />, 'switch.reqState'],
              [<ShieldCheck key="v" />, 'switch.reqVolumes'],
              [<Clock key="c" />, 'switch.reqCooldown'],
            ] as const
          ).map(([icon, k]) => (
            <span key={k} className="inline-flex items-center gap-1.5 [&>svg]:size-3.5 [&>svg]:text-fg-3">
              {icon}
              {t(k)}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-fg-3">{t('switch.footnote')}</p>
      </div>
    </div>
  );
}

/** 购买页「切换机房」：只展示规则 */
export function SwitchRulesButton({ from, to }: { from?: string; to?: string[] }) {
  const { t } = useI18n();
  const { data: cfg } = usePublicConfig();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" icon={<Shuffle />} onClick={() => setOpen(true)}>
        {t('switch.open')}
      </Button>
      <Modal open={open} onOpenChange={setOpen} size="lg" title={t('switch.rulesTitle')}>
        <SwitchRules from={from} to={to} fee={cfg?.nodeSwitchFee ?? 0} />
      </Modal>
    </>
  );
}

/** 实例管理：选择目标机房与系统，确认后切换；成功提交后显示新的 root 密码 */
export function SwitchNodeDialog({ inst, open, onClose }: { inst: AnyInstance; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const currency = useCurrency();
  const { data: cfg } = usePublicConfig();
  const path = useInstanceApiPath(inst.id);
  const invalidate = useInvalidateInstance(inst.id);
  const info = useQuery({ queryKey: ['switch-node', inst.id], queryFn: () => api.get<SwitchInfo>(`${path}/switch-node`), enabled: open });
  const images = useQuery({ queryKey: ['instance-images', inst.id], queryFn: () => api.get<ImageDTO[]>(`${path}/images`), enabled: open });
  // 即时 Agent 检测：只在任务进行中轮询，重新检测时显式创建新任务。
  const ipCheck = useQuery({
    queryKey: ['switch-ipcheck', inst.id],
    queryFn: () => api.get<InstanceIpv4CheckDTO>(`${path}/switch-node/check`),
    enabled: open,
    refetchInterval: (query) => query.state.data?.status === 'pending' ? 3000 : false,
  });
  const recheck = useMutation({
    onMutate: () => qc.cancelQueries({ queryKey: ['switch-ipcheck', inst.id] }),
    mutationFn: () => api.get<InstanceIpv4CheckDTO>(`${path}/switch-node/check`, { fresh: 1 }),
    onSuccess: (data) => qc.setQueryData(['switch-ipcheck', inst.id], data),
    onError: (e) => toast.fromError(e),
  });
  const savedKeys = useSshKeys().data;
  const [targetId, setTargetId] = useState<number | null>(null);
  const [imageId, setImageId] = useState<number | null>(inst.image?.id ?? null);
  const [password, setPassword] = useState('');
  const [keyIds, setKeyIds] = useState<number[]>([]);
  const [extraKeys, setExtraKeys] = useState('');
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const d = info.data;
  const target = d?.targets.find((n) => n.id === targetId) ?? d?.targets.find((n) => n.available) ?? null;
  const fee = Number(d?.fee ?? cfg?.nodeSwitchFee ?? 0);
  const canPay = !!d && (d.free || fee > 0);
  const cooling = !!d?.cooldownUntil;
  const submit = useMutation({
    mutationFn: () =>
      api.post<{ password: string; free: boolean; fee: string }>(`${path}/switch-node`, {
        targetNodeId: target!.id,
        imageId,
        password,
        sshKeys: combineSshKeys(savedKeys, keyIds, extraKeys),
      }),
    onSuccess: (r) => {
      setResult(r.password);
      invalidate();
      void qc.invalidateQueries({ queryKey: ['me'] });
      toast.success(t('switch.submitted'));
    },
    onError: (e) => toast.fromError(e),
  });
  const ipBlocked = ipCheck.data?.status === 'blocked';
  const ipPending = ipCheck.isLoading || recheck.isPending || (!ipCheck.isError && ipCheck.data?.status === 'pending');
  const ipStatus = ipPending ? 'pending' : ipCheck.isError ? 'unknown' : ipCheck.data?.status ?? 'unknown';
  const ready = !!target?.available && !!imageId && !d?.blocked && !cooling && !ipBlocked && !ipPending && canPay && confirm.trim() === inst.hostname;

  const close = () => {
    setResult(null);
    setConfirm('');
    onClose();
  };

  if (result) {
    return (
      <Modal open={open} onOpenChange={(o) => !o && close()} title={t('switch.submitted')} description={t('switch.submittedDesc')} footer={<Button variant="primary" onClick={close}>{t('reinstall.saved')}</Button>}>
        <CodeBlock value={result} />
      </Modal>
    );
  }
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && close()}
      size="xl"
      title={t('switch.title', { name: inst.hostname })}
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="danger" icon={<Shuffle />} loading={submit.isPending} disabled={!ready} onClick={() => submit.mutate()}>
            {d?.free ? t('switch.submitFree') : t('switch.submitPaid', { fee: formatMoney(fee, currency) })}
          </Button>
        </>
      }
    >
      {!d ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="space-y-4">
          <SwitchRules from={d.current.name} to={target ? [target.name] : undefined} fee={fee} compact />
          <div className="space-y-4">
            {/* 当前状态：本周期是否免费、冷却、不能切换的原因 */}
            {d.blocked ? (
              <Alert tone="danger">{d.blocked}</Alert>
            ) : cooling ? (
              <Alert tone="warning">{t('switch.coolingUntil', { time: formatDate(d.cooldownUntil!, 'MM-DD HH:mm') })}</Alert>
            ) : d.free ? (
              <Alert tone="success">{t('switch.freeAvailable')}</Alert>
            ) : (
              <Alert tone={fee > 0 ? 'warning' : 'danger'}>
                {t(fee > 0 ? 'switch.freeUsedPaid' : 'switch.freeUsedOff', { time: formatDate(d.nextFreeAt!, 'YYYY-MM-DD HH:mm'), fee: formatMoney(fee, currency) })}
              </Alert>
            )}
            {/* 原 IPv4 检测 */}
            <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5 text-[13px]">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg">{t('switch.ipCheck')}</span>
                  {(ipPending || ipCheck.data) && (
                    <Badge tone={ipStatus === 'ok' ? 'success' : ipStatus === 'blocked' ? 'danger' : 'neutral'} dot>
                      {t(`switch.ip.${ipStatus}`)}
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-fg-3">
                  {ipPending
                    ? t('switch.ipChecking')
                    : ipCheck.isError
                      ? t('switch.ipUnknownDesc')
                      : ipCheck.data?.reason
                      ? t(`switch.ipReason.${ipCheck.data.reason}`)
                      : ipCheck.data?.method
                        ? t('switch.ipDetail', { n: ipCheck.data.reachable, total: ipCheck.data.total, method: t('switch.ipMethodIcmp') })
                        : t('switch.ipUnknownDesc')}
                </div>
                {ipCheck.data?.ipv4 && <div className="mt-0.5 text-xs text-fg-3 tabular">{ipCheck.data.ipv4}</div>}
              </div>
              <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={ipPending} disabled={ipPending || submit.isPending} onClick={() => recheck.mutate()}>
                {t('switch.ipRecheck')}
              </Button>
            </div>
            {ipBlocked && <Alert tone="danger">{t('switch.ipBlockedDesc')}</Alert>}
            <p className="text-xs leading-relaxed text-fg-3">{t('market.ping.policy')}</p>
            <FormField label={t('switch.target')}>
              {d.targets.length ? (
                <Select<number>
                  value={target?.id ?? 0}
                  onChange={setTargetId}
                  aria-label={t('switch.target')}
                  options={d.targets.map((n) => ({
                    value: n.id,
                    label: `${n.name}${n.available ? '' : ` · ${t('store.nodeOut')}`}`,
                    // 说明：地区 · 流量倍率与切换后的额度
                    description: `${n.region} · ${t('switch.trafficAfter', { multiplier: formatMultiplier(n.trafficMultiplier), traffic: formatTraffic(n.traffic) })}`,
                  }))}
                />
              ) : (
                <p className="text-[13px] text-fg-3">{t('switch.noTargets')}</p>
              )}
            </FormField>
            {/* 流量倍率不同：额度按目标机房倍率换算 */}
            {target && target.traffic !== d.current.traffic && (
              <Alert tone="primary">
                {t('switch.trafficChange', {
                  from: `${formatTraffic(d.current.traffic)}（${formatMultiplier(d.current.trafficMultiplier)}）`,
                  to: `${formatTraffic(target.traffic)}（${formatMultiplier(target.trafficMultiplier)}）`,
                })}
              </Alert>
            )}
            <FormField label={t('reinstall.choose')}>
              {images.data ? (
                <ImagePicker aria-label={t('reinstall.choose')} images={images.data} value={imageId} onChange={setImageId} current={inst.image?.id} currentLabel={t('reinstall.current')} />
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </FormField>
            <FormField label={t('reinstall.newPassword')} description={t('common.leaveEmptyToGenerate')}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('common.autoGenerate')} autoComplete="new-password" />
            </FormField>
            <SshKeyField selected={keyIds} onSelected={setKeyIds} extra={extraKeys} onExtra={setExtraKeys} />
            <FormField label={t('switch.confirm', { name: inst.hostname })}>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={inst.hostname} autoComplete="off" className={cn(confirm && confirm !== inst.hostname && 'border-danger')} />
            </FormField>
          </div>
        </div>
      )}
    </Modal>
  );
}

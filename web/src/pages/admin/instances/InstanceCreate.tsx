// 管理员创建实例：优先选择套餐直接开通，按需展开配置调整；可免费开通或扣除用户余额。
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, Cpu, HardDrive, Search, Server, WalletCards, X } from 'lucide-react';
import { useEffect, useId, useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  BILLING_CYCLES,
  CPU_PRIORITY_MAX,
  CYCLE_MONTHS,
  isPublicIpv4Mode,
  hasIpv6Mode,
  IPV6_COUNT_MAX,
  PROCESS_LIMIT_MIN,
  isVmType,
  nodeAllowsImage,
  type AdminImageDTO,
  type AdminPlanDTO,
  type AdminProductDTO,
  type AdminUserDTO,
  type BillingCycle,
  type InstanceType,
  type NodeDTO,
  type OverLimitAction,
  type Paginated,
  type StoragePoolDTO,
  type TrafficMode,
} from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { OsIcon } from '@/components/status';
import { Button, LinkButton } from '@/components/ui/button';
import { FormField, Input, InputGroup, PasswordInput, Textarea } from '@/components/ui/input';
import { Alert, Card, CardBody, FormSection, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n, type MessageKey } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dayjs, formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { MODE_LABEL } from '../nodes/NodeForm';
import { trafficModeOptions, overLimitOptions } from '@/lib/plans';
import { LimitFields, limitForm, limitPayload, type LimitForm } from '@/components/resource-limits';
import { instancePlanDefaults } from './instance-create-plan';

/** 各实例类型的说明 */
const TYPE_DESC: Record<InstanceType, MessageKey> = {
  LXC_NAT: 'instCreate.typeLxcNat',
  KVM_NAT: 'instCreate.typeKvmNat',
  KVM_IPV4: 'instCreate.typeKvmIpv4',
};

interface CreateForm {
  hostname: string;
  remark: string;
  nodeId: number;
  type: InstanceType;
  imageId: number;
  storagePool: string;
  ipv6Count: string;
  privileged: boolean;
  nesting: boolean;
  planId: number | null;
  cpu: string;
  limits: LimitForm;
  memory: string;
  swap: string;
  disk: string;
  bandwidthIn: string;
  bandwidthOut: string;
  traffic: string;
  trafficMode: TrafficMode;
  overLimitAction: OverLimitAction;
  throttleRate: string;
  trafficResetPrice: string;
  portLimit: string;
  siteLimit: string;
  snapshotLimit: string;
  password: string;
  sshKeys: string;
  billingCycle: BillingCycle;
  price: string;
  expiresAt: string;
  autoRenew: boolean;
  charge: 'free' | 'charge';
}

/** 存储池选择「宿主机默认」时的取值（空字符串在下拉框里表示未选择） */
const DEFAULT_POOL = '__default__';

const expiryFor = (cycle: BillingCycle) => dayjs().add(CYCLE_MONTHS[cycle], 'month').format('YYYY-MM-DDTHH:mm');

const INITIAL: CreateForm = {
  hostname: '',
  remark: '',
  nodeId: 0,
  type: 'LXC_NAT',
  imageId: 0,
  storagePool: '',
  ipv6Count: '1',
  privileged: false,
  nesting: true,
  planId: null,
  cpu: '1',
  limits: limitForm(),
  memory: '1024',
  swap: '0',
  disk: '20',
  bandwidthIn: '100',
  bandwidthOut: '100',
  traffic: '500',
  trafficMode: 'OUT',
  overLimitAction: 'THROTTLE',
  throttleRate: '1',
  trafficResetPrice: '',
  portLimit: '10',
  siteLimit: '2',
  snapshotLimit: '1',
  password: '',
  sshKeys: '',
  billingCycle: 'MONTHLY',
  price: '0',
  expiresAt: expiryFor('MONTHLY'),
  autoRenew: false,
  charge: 'free',
};

/** 按用户名 / 邮箱 / ID 搜索并选择所属用户 */
function UserPicker({ value, onChange }: { value: AdminUserDTO | null; onChange: (u: AdminUserDTO | null) => void }) {
  const { t } = useI18n();
  const [kw, setKw] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(kw.trim()), 250);
    return () => clearTimeout(timer);
  }, [kw]);
  const q = useQuery({
    queryKey: ['admin-users-pick', debounced],
    queryFn: () => api.get<Paginated<AdminUserDTO>>('/admin/users', { q: debounced, role: 'USER', pageSize: 8 }),
    enabled: !value && !!debounced,
  });
  if (value)
    return (
      <div className="flex h-8.5 items-center gap-2 rounded-md border border-line bg-surface-2 px-3 text-sm">
        <span className="truncate font-medium text-fg">{value.name || value.username}</span>
        <span className="truncate text-xs text-fg-3">
          {value.email} · #{value.id}
        </span>
        <button type="button" className="ml-auto shrink-0 rounded p-0.5 text-fg-4 hover:text-fg" aria-label={t('instCreate.changeUser')} onClick={() => onChange(null)}>
          <X className="size-3.5" />
        </button>
      </div>
    );
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-4" />
      <Input className="pl-8" value={kw} onChange={(e) => setKw(e.target.value)} placeholder={t('instCreate.userSearch')} />
      {!!debounced && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-card">
          {q.data?.items.length ? (
            q.data.items.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => {
                  onChange(u);
                  setKw('');
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-3"
              >
                <span className="truncate font-medium text-fg">{u.name || u.username}</span>
                <span className="truncate text-xs text-fg-3">{u.email}</span>
                <span className="ml-auto shrink-0 text-xs text-fg-4 tabular-nums">#{u.id}</span>
              </button>
            ))
          ) : (
            <div className="px-2.5 py-2 text-xs text-fg-3">{q.isFetching ? t('common.loading') : t('instCreate.userNone')}</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 创建实例表单。传入 fixedNodeId 时固定在该宿主机上创建（宿主机详情页的「创建」标签），
 * 否则可选择宿主机（initialNodeId 为初始选择）。
 */
export function InstanceCreateForm({ fixedNodeId, initialNodeId = 0, cancelTo }: { fixedNodeId?: number; initialNodeId?: number; cancelTo: string }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const navigate = useNavigate();
  const [f, setF] = useState<CreateForm>(() => ({ ...INITIAL, nodeId: fixedNodeId ?? initialNodeId }));
  const [user, setUser] = useState<AdminUserDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const configId = useId();
  const update = (values: Partial<CreateForm>) => setF((current) => ({ ...current, ...values }));
  const set = (k: keyof CreateForm) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((current) => ({ ...current, [k]: e.target.value }));
  useEffect(() => {
    if (error) setError(null);
  }, [f, user]);

  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes') });
  const images = useQuery({ queryKey: ['admin-images'], queryFn: () => api.get<AdminImageDTO[]>('/admin/images') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<AdminPlanDTO[]>('/admin/plans') });
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const node = nodes.data?.find((n) => n.id === f.nodeId) ?? null;
  const pools = useQuery({
    queryKey: ['node-pools', f.nodeId],
    queryFn: () => api.get<StoragePoolDTO[]>(`/admin/nodes/${f.nodeId}/storage-pools`),
    enabled: !!node && node.status !== 'PENDING',
  });
  const rootPools = (pools.data ?? []).filter((p) => p.usage === 'root');

  // 宿主机决定可用的实例类型（NAT ↔ NAT / IPv6 宿主机，独立 IPv4 ↔ 独立 IPv4 宿主机）与镜像
  const types: InstanceType[] = node ? (isPublicIpv4Mode(node.networkMode) ? ['KVM_IPV4'] : ['LXC_NAT', 'KVM_NAT']) : [];
  const imageList = (images.data ?? []).filter((i) => i.enabled && (isVmType(f.type) ? i.forVm : i.forContainer) && (!node || nodeAllowsImage(node, i)));
  const planList = (plans.data ?? []).filter((p) => types.includes(p.type));
  useEffect(() => {
    if (node && !types.includes(f.type)) setF((v) => ({ ...v, type: types[0], planId: null, imageId: 0 }));
  }, [node?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (images.data && !imageList.some((i) => i.id === f.imageId)) setF((v) => ({ ...v, imageId: imageList[0]?.id ?? 0 }));
  }, [images.data, f.type, node]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 从套餐带入规格与对应周期的价格 */
  const applyPlan = (id: number) => {
    const p = plans.data?.find((x) => x.id === id);
    if (!p || !node) {
      update({ planId: 0 });
      setConfigOpen(true);
      return;
    }
    const defaults = instancePlanDefaults(p, f.billingCycle, node, products.data?.find((product) => product.id === p.productId));
    setF((current) => ({
      ...current,
      ...defaults,
      cpu: String(defaults.cpu),
      limits: limitForm(defaults),
      memory: String(defaults.memory),
      swap: String(defaults.swap),
      disk: String(defaults.disk),
      bandwidthIn: String(defaults.bandwidthIn),
      bandwidthOut: String(defaults.bandwidthOut),
      traffic: String(defaults.traffic),
      throttleRate: String(defaults.throttleRate),
      trafficResetPrice: defaults.trafficResetPrice ?? '',
      portLimit: String(defaults.portLimit),
      siteLimit: String(defaults.siteLimit),
      snapshotLimit: String(defaults.snapshotLimit),
      ipv6Count: String(defaults.ipv6Count),
      expiresAt: expiryFor(defaults.billingCycle),
    }));
    setConfigOpen(false);
  };
  const plan = plans.data?.find((p) => p.id === f.planId);
  const supportedCycles = plan ? BILLING_CYCLES.filter((cycle) => plan.prices[cycle] != null) : [];
  const cycles = supportedCycles.length ? supportedCycles : BILLING_CYCLES;

  const create = useMutation({
    mutationFn: () =>
      api.post<{ instanceId: number }>('/admin/instances', {
        userId: user!.id,
        nodeId: f.nodeId,
        planId: f.planId || null,
        type: f.type,
        imageId: f.imageId,
        hostname: f.hostname.trim().toLowerCase(),
        password: f.password,
        sshKeys: f.sshKeys,
        cpu: Number(f.cpu),
        ...limitPayload(f.limits, f.type),
        memory: Number(f.memory),
        swap: isVmType(f.type) ? 0 : Number(f.swap) || 0,
        disk: Number(f.disk),
        bandwidthIn: Number(f.bandwidthIn),
        bandwidthOut: Number(f.bandwidthOut),
        traffic: Number(f.traffic),
        trafficMode: f.trafficMode,
        overLimitAction: f.overLimitAction,
        throttleRate: Number(f.throttleRate),
        trafficResetPrice: f.trafficResetPrice.trim() || null,
        portLimit: f.type === 'KVM_IPV4' ? 0 : Number(f.portLimit),
        siteLimit: f.type === 'KVM_IPV4' ? 0 : Number(f.siteLimit),
        snapshotLimit: Number(f.snapshotLimit),
        storagePool: f.storagePool || null,
        ipv6Count: node && hasIpv6Mode(node.networkMode) ? Number(f.ipv6Count) || 0 : 0,
        privileged: f.type === 'LXC_NAT' && f.privileged,
        nesting: f.nesting,
        billingCycle: f.billingCycle,
        price: f.price.trim() || '0',
        expiresAt: new Date(f.expiresAt).toISOString(),
        autoRenew: f.autoRenew,
        remark: f.remark,
        charge: f.charge === 'charge',
      }),
    onSuccess: (r) => {
      toast.success(t('instCreate.created'));
      navigate(`/admin/instances/${r.instanceId}`);
    },
    onError: (e) => {
      setError(errorText(e));
      setConfigOpen(true);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    setError(null);
    if (!user) return setError(t('instCreate.userRequired'));
    if (!node) return setError(t('instCreate.nodeRequired'));
    if (node.status === 'PENDING') return setError(t('instCreate.nodePending'));
    if (f.planId === null) return setError(t('instCreate.planRequired'));
    if (f.planId && (!plan || !types.includes(plan.type) || plan.type !== f.type)) return setError(t('instCreate.planRequired'));
    if (!imageList.some((image) => image.id === f.imageId)) return setError(t('instCreate.imageRequired'));
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(f.hostname.trim())) return setError(t('instCreate.invalidHostname'));
    const configError = (message: MessageKey) => {
      setConfigOpen(true);
      setError(t(message));
    };
    if (!Number.isFinite(Number(f.price)) || Number(f.price) < 0) return configError('instCreate.invalidPrice');
    if (!Number.isFinite(new Date(f.expiresAt).getTime()) || new Date(f.expiresAt).getTime() <= Date.now()) return configError('instCreate.invalidExpiry');
    if (f.trafficResetPrice.trim() && (!Number.isFinite(Number(f.trafficResetPrice)) || Number(f.trafficResetPrice) < 0)) return configError('instCreate.invalidPrice');
    if (planPoolMissing) return configError('instCreate.planPoolMissing');
    const numericFields: [string, number, number?][] = [
      [f.cpu, 1, 256],
      [f.memory, 64],
      [f.disk, 1],
      [f.bandwidthIn, 0],
      [f.bandwidthOut, 0],
      [f.traffic, 0],
      [f.throttleRate, 1],
      [f.snapshotLimit, 0],
    ];
    if (!isVmType(f.type)) numericFields.push([f.swap, 0, 65536]);
    if (f.type !== 'KVM_IPV4') numericFields.push([f.portLimit, 0], [f.siteLimit, 0]);
    if (hasIpv6Mode(node.networkMode)) numericFields.push([f.ipv6Count, node.networkMode === 'IPV6_ONLY' ? 1 : 0, IPV6_COUNT_MAX]);
    const optionalLimits: [string, number, number][] = [
      [f.limits.cpuAllowance, 1, 100],
      [f.limits.cpuPriority, 0, CPU_PRIORITY_MAX],
      [f.limits.diskRead, 0, f.limits.diskReadUnit === 'MB' ? 100_000 : 10_000_000],
      [f.limits.diskWrite, 0, f.limits.diskWriteUnit === 'MB' ? 100_000 : 10_000_000],
    ];
    if (!isVmType(f.type)) optionalLimits.push([f.limits.processLimit, PROCESS_LIMIT_MIN, 1_000_000]);
    numericFields.push(...optionalLimits.filter(([value]) => !!value.trim()));
    if (numericFields.some(([value, min, max]) => !value.trim() || !Number.isInteger(Number(value)) || Number(value) < min || (max != null && Number(value) > max)))
      return configError('instCreate.invalidNumber');
    if (noFreeIp) return setError(t('instCreate.noFreeIp'));
    if (short) return setError(t('instCreate.balanceShort', { balance: formatMoney(user.balance, currency) }));
    create.mutate();
  };

  const nat = f.type !== 'KVM_IPV4';
  const num = (k: keyof CreateForm, label: MessageKey, unit?: string, desc?: MessageKey, min = 0, max?: number) => (
    <FormField label={t(label)} description={desc ? t(desc) : undefined}>
      {unit ? <InputGroup type="number" min={min} max={max} step={1} value={f[k] as string} onChange={set(k)} suffix={unit} /> : <Input type="number" min={min} max={max} step={1} value={f[k] as string} onChange={set(k)} />}
    </FormField>
  );
  const defaultPool = rootPools.find((p) => p.isDefault)?.name ?? node?.storagePool;
  const short = f.charge === 'charge' && !!user && Number(user.balance) < Number(f.price || 0);
  const selectedImage = imageList.find((image) => image.id === f.imageId);
  const noFreeIp = node && f.type === 'KVM_IPV4' && node.ipStats.total - node.ipStats.used <= 0;
  const expiresMin = dayjs().format('YYYY-MM-DDTHH:mm');
  const planPoolMissing = !!f.storagePool && pools.isSuccess && !rootPools.some((pool) => pool.name === f.storagePool);

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className={fixedNodeId ? 'grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]' : 'space-y-4'}>
        <div className="min-w-0 space-y-4">
          <Card>
            <CardBody className="space-y-4">
              <FormSection title={t('instCreate.basic')} description={t('instCreate.quickDesc')} className="lg:grid-cols-1 lg:gap-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label={t('instCreate.user')} required>
                    <UserPicker value={user} onChange={setUser} />
                  </FormField>
                  <FormField label={t('instCreate.hostname')} required description={t('instCreate.hostnameHint')}>
                    <Input value={f.hostname} onChange={set('hostname')} required maxLength={63} autoCapitalize="off" autoCorrect="off" className="font-mono" placeholder="my-server" />
                  </FormField>
                  {!fixedNodeId && (
                    <FormField label={t('instCreate.node')} required className="sm:col-span-2">
                      <Select
                        value={f.nodeId || null}
                        onChange={(v) => {
                          const nodeId = Number(v);
                          const nextNode = nodes.data?.find((n) => n.id === nodeId);
                          const nextType = nextNode && isPublicIpv4Mode(nextNode.networkMode) ? 'KVM_IPV4' : 'LXC_NAT';
                          update({ nodeId, storagePool: '', planId: null, imageId: 0, type: nextType, ipv6Count: nextNode && hasIpv6Mode(nextNode.networkMode) ? '1' : '0' });
                          setConfigOpen(false);
                        }}
                        placeholder={t('instCreate.nodePlaceholder')}
                        options={(nodes.data ?? []).map((n) => ({
                          value: n.id,
                          label: `${n.name} · ${n.region}`,
                          description: `${t(MODE_LABEL[n.networkMode])} · ${t('instCreate.nodeLoad', { n: n.instanceCount, max: n.maxInstances })}`,
                          disabled: n.status === 'PENDING',
                        }))}
                      />
                    </FormField>
                  )}
                  <FormField label={t('instCreate.fromPlan')} required description={t('instCreate.planHint')}>
                    <Select
                      value={f.planId}
                      disabled={!node || plans.isLoading || products.isLoading}
                      onChange={applyPlan}
                      placeholder={node ? t('instCreate.planPlaceholder') : t('instCreate.nodeFirst')}
                      options={[
                        ...planList.map((p) => ({
                          value: p.id,
                          label: [products.data?.find((product) => product.id === p.productId)?.name, p.name].filter(Boolean).join(' / '),
                          description: `${L.instanceType[p.type]} · ${p.cpu} ${t('adminInst.unitCores')} · ${p.memory} MiB · ${p.disk} GiB${p.enabled ? '' : ` · ${t('instCreate.planOffSale')}`}`,
                          disabled: products.isError,
                        })),
                        { value: 0, label: t('instCreate.noPlan'), description: t('instCreate.noPlanDesc') },
                      ]}
                    />
                  </FormField>
                  <FormField label={t('instCreate.image')} required>
                    <Select
                      value={f.imageId || null}
                      disabled={!node || f.planId === null}
                      onChange={(v) => update({ imageId: Number(v) })}
                      placeholder={node ? (imageList.length ? undefined : t('instCreate.noImage')) : t('instCreate.nodeFirst')}
                      options={imageList.map((i) => ({
                        value: i.id,
                        label: <span className="flex items-center gap-2"><OsIcon family={i.family} className="size-5 text-[9px]" />{i.name}</span>,
                      }))}
                    />
                  </FormField>
                  <FormField label={t('instCreate.cycle')}>
                    <Select
                      value={f.billingCycle}
                      disabled={f.planId === null}
                      onChange={(v) => update({ billingCycle: v, expiresAt: expiryFor(v), price: plan ? plan.prices[v] ?? '0' : f.price })}
                      options={cycles.map((c) => ({ value: c, label: L.billingCycle[c], description: plan && plan.prices[c] != null ? formatMoney(plan.prices[c]!, currency) : undefined }))}
                    />
                  </FormField>
                  <FormField label={t('instCreate.charge')}>
                    <Select
                      value={f.charge}
                      onChange={(v) => update({ charge: v })}
                      options={[
                        { value: 'free', label: t('instCreate.chargeFree'), description: t('instCreate.chargeFreeDesc') },
                        { value: 'charge', label: t('instCreate.chargeBalance'), description: user ? t('instCreate.chargeBalanceDescUser', { balance: formatMoney(user.balance, currency) }) : t('instCreate.chargeBalanceDesc') },
                      ]}
                    />
                  </FormField>
                </div>
              </FormSection>

              {f.planId !== null && (
                <div className="space-y-3 border-t border-line pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="font-medium text-fg">{t('instCreate.effectiveConfig')}</span>
                    <span className="text-fg-3">{L.instanceType[f.type]}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:grid-cols-3">
                    {([
                      [t('adminInst.cpu'), `${f.cpu} ${t('adminInst.unitCores')}`],
                      [t('spec.memory'), `${f.memory} MiB`],
                      [t('spec.disk'), `${f.disk} GiB`],
                      [t('adminInst.bwIn'), Number(f.bandwidthIn) ? `${f.bandwidthIn} Mbps` : t('common.unlimited')],
                      [t('adminInst.bwOut'), Number(f.bandwidthOut) ? `${f.bandwidthOut} Mbps` : t('common.unlimited')],
                      [t('plans.traffic'), Number(f.traffic) ? `${f.traffic} GiB` : t('common.unlimited')],
                    ]).map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-2 gap-y-0.5"><dt className="text-fg-3">{label}</dt><dd className="font-medium tabular-nums text-fg">{value}</dd></div>)}
                  </dl>
                  <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line pt-3 text-xs">
                    <span className="text-fg-3">{t('instCreate.price')}: <strong className="font-semibold text-fg">{formatMoney(f.price || 0, currency)}</strong> / {L.billingCycle[f.billingCycle]}</span>
                    <span className="text-fg-3">{t('instCreate.expiresAt')}: <span className="tabular-nums text-fg-2">{formatDate(f.expiresAt)}</span></span>
                  </div>
                </div>
              )}
              {(nodes.error || images.error || plans.error || products.error) && (
                <Alert tone="danger">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{errorText(nodes.error || images.error || plans.error || products.error)}</span>
                    <Button size="sm" onClick={() => { void nodes.refetch(); void images.refetch(); void plans.refetch(); void products.refetch(); }}>{t('common.retry')}</Button>
                  </div>
                </Alert>
              )}
              {plan && !supportedCycles.length && <Alert tone="warning">{t('instCreate.planNoPrice')}</Alert>}
              {planPoolMissing && <Alert tone="warning">{t('instCreate.planPoolMissing')}</Alert>}
              {noFreeIp && <Alert tone="warning">{t('instCreate.noFreeIp')}</Alert>}
              {node && node.instanceCount >= node.maxInstances && <Alert tone="warning">{t('instCreate.nodeFull')}</Alert>}
              {short && <Alert tone="warning">{t('instCreate.balanceShort', { balance: formatMoney(user!.balance, currency) })}</Alert>}
            </CardBody>
          </Card>

          <Card>
            <button
              type="button"
              aria-expanded={configOpen}
              aria-controls={configId}
              disabled={f.planId === null}
              onClick={() => setConfigOpen((open) => !open)}
              className="flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left outline-none transition-colors hover:enabled:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
            >
              <ChevronDown className={cn('size-4 shrink-0 text-fg-3 transition-transform', !configOpen && '-rotate-90')} />
              <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-fg">{t('instCreate.editConfig')}</span><span className="mt-0.5 block text-xs text-fg-3">{t(plan ? 'instCreate.editConfigHint' : 'instCreate.customConfigHint')}</span></span>
              <span className="shrink-0 text-xs text-fg-3">{t(configOpen ? 'instCreate.collapse' : 'instCreate.expand')}</span>
            </button>
            {configOpen && (
              <div id={configId} className="space-y-5 border-t border-line p-4 sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-fg-3">{t('instCreate.configPersistHint')}</p>
                  {plan && <Button size="sm" onClick={() => applyPlan(plan.id)}>{t('instCreate.restorePlan')}</Button>}
                </div>
                <FormSection title={t('instCreate.spec')} className="lg:grid-cols-1 lg:gap-3">
                  {f.planId === 0 && (
                    <FormField label={t('instCreate.type')} required className="sm:max-w-sm">
                      <Select value={f.type} onChange={(v) => update({ type: v, imageId: 0 })} options={types.map((ty) => ({ value: ty, label: L.instanceType[ty], description: t(TYPE_DESC[ty]) }))} />
                    </FormField>
                  )}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {num('cpu', 'adminInst.cpu', t('adminInst.unitCores'), undefined, 1, 256)}
                    {num('memory', 'spec.memory', 'MiB', undefined, 64)}
                    {num('disk', 'spec.disk', 'GiB', undefined, 1)}
                    {!isVmType(f.type) && num('swap', 'plans.swap', 'MiB', undefined, 0, 65536)}
                    {num('bandwidthIn', 'adminInst.bwIn', 'Mbps')}
                    {num('bandwidthOut', 'adminInst.bwOut', 'Mbps')}
                    {num('traffic', 'plans.traffic', 'GiB', 'plans.trafficHint')}
                    <FormField label={t('adminInst.trafficMode')}><Select value={f.trafficMode} onChange={(v) => update({ trafficMode: v })} options={trafficModeOptions(t, L)} /></FormField>
                    <FormField label={t('adminInst.overLimit')}><Select value={f.overLimitAction} onChange={(v) => update({ overLimitAction: v })} options={overLimitOptions(t, L)} /></FormField>
                    {f.overLimitAction === 'THROTTLE' && num('throttleRate', 'plans.throttle', 'Mbps', undefined, 1)}
                    <FormField label={t('plans.trafficResetPrice')}><InputGroup type="number" min={0} step={0.01} value={f.trafficResetPrice} onChange={set('trafficResetPrice')} prefix={currency} placeholder={t('plans.trafficResetOff')} /></FormField>
                    {nat && num('portLimit', 'adminInst.portLimit')}
                    {nat && num('siteLimit', 'adminInst.siteLimit')}
                    {num('snapshotLimit', 'adminInst.snapshotLimit')}
                  </div>
                </FormSection>

                <FormSection title={t('plans.section.limits')} description={t('plans.section.limitsDesc')} className="lg:grid-cols-1 lg:gap-3">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3"><LimitFields value={f.limits} onChange={(limits) => update({ limits })} type={f.type} hints={false} /></div>
                </FormSection>

                <FormSection title={t('instCreate.placement')} className="lg:grid-cols-1 lg:gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('plans.storagePool')}>
                      <Select
                        value={f.storagePool || DEFAULT_POOL}
                        onChange={(v) => update({ storagePool: v === DEFAULT_POOL ? '' : v })}
                        options={[
                          { value: DEFAULT_POOL, label: t('instCreate.poolDefault'), description: defaultPool ? t('instCreate.poolDefaultDesc', { name: defaultPool }) : undefined },
                          ...rootPools.map((p) => ({ value: p.name, label: p.name, description: `${p.driver}${p.isDefault ? ` · ${t('instCreate.poolIsDefault')}` : ''}` })),
                          ...(planPoolMissing ? [{ value: f.storagePool, label: f.storagePool, description: t('instCreate.planPoolMissing'), disabled: true }] : []),
                        ]}
                      />
                    </FormField>
                    {node && hasIpv6Mode(node.networkMode) && <FormField label={t('plans.ipv6Count')} description={t('instCreate.ipv6CountHint')}><InputGroup type="number" min={node.networkMode === 'IPV6_ONLY' ? 1 : 0} max={IPV6_COUNT_MAX} step={1} value={f.ipv6Count} onChange={set('ipv6Count')} suffix={t('plans.ipv6Unit')} /></FormField>}
                  </div>
                  {f.type === 'LXC_NAT' && <div className="grid gap-3 sm:grid-cols-2"><Switch checked={f.nesting} onCheckedChange={(v) => update({ nesting: v })} label={t('products.nesting')} description={t('products.nestingDesc')} /><Switch checked={f.privileged} onCheckedChange={(v) => update({ privileged: v })} label={t('products.privileged')} description={t('products.privilegedDesc')} /></div>}
                </FormSection>

                <FormSection title={t('instCreate.billing')} className="lg:grid-cols-1 lg:gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('instCreate.price')} description={t('instCreate.priceHint')}><InputGroup type="number" min={0} step={0.01} prefix={currency} inputMode="decimal" value={f.price} onChange={set('price')} /></FormField>
                    <FormField label={t('instCreate.expiresAt')}><Input type="datetime-local" min={expiresMin} value={f.expiresAt} onChange={set('expiresAt')} required /></FormField>
                    <div className="sm:col-span-2"><Switch checked={f.autoRenew} onCheckedChange={(v) => update({ autoRenew: v })} label={t('instCreate.autoRenew')} description={t('instCreate.autoRenewDesc')} /></div>
                  </div>
                </FormSection>

                <FormSection title={t('instCreate.login')} className="lg:grid-cols-1 lg:gap-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <FormField label={t('instCreate.password')} description={t('instCreate.passwordHint')}><PasswordInput value={f.password} onChange={set('password')} autoComplete="new-password" minLength={8} maxLength={64} placeholder={t('instCreate.passwordRandom')} /></FormField>
                    <FormField label={t('instCreate.sshKeys')} description={t('instCreate.sshKeysHint')}><Textarea rows={2} maxLength={16000} value={f.sshKeys} onChange={set('sshKeys')} className="font-mono text-xs" placeholder="ssh-ed25519 AAAA…" /></FormField>
                    <FormField label={t('adminInst.remark')} className="sm:col-span-2"><Input value={f.remark} onChange={set('remark')} maxLength={500} /></FormField>
                  </div>
                </FormSection>
              </div>
            )}
          </Card>
        </div>
        {fixedNodeId && (
          <aside className="space-y-3 xl:sticky xl:top-4">
            <Card>
              <CardBody className="space-y-2.5 p-3 sm:p-3">
                <div className="flex items-center gap-2">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Server className="size-4" /></span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-fg">{t('instCreate.hostSummary')}</h3>
                    <p className="truncate text-xs text-fg-3">{node?.name ?? t('common.loading')}</p>
                  </div>
                </div>
                {node ? (
                  <>
                    <div className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-3 py-1.5 text-xs">
                      <span className="text-fg-3">{t(MODE_LABEL[node.networkMode])}</span>
                      <span className="font-medium text-fg-2">{L.nodeStatus[node.status]}</span>
                    </div>
                    <div className={node.ipStats.total > 0 ? 'grid grid-cols-2 gap-2' : 'grid gap-2'}>
                      <div className="rounded-md border border-line px-3 py-2">
                        <div className="text-[11px] text-fg-3">{t('nodeDetail.tabInstances')}</div>
                        <div className="mt-0.5 text-sm font-semibold tabular-nums text-fg">{node.instanceCount}<span className="font-normal text-fg-4"> / {node.maxInstances}</span></div>
                      </div>
                      {node.ipStats.total > 0 && (
                        <div className="rounded-md border border-line px-3 py-2">
                          <div className="text-[11px] text-fg-3">{t('instCreate.ipAvailable')}</div>
                          <div className="mt-0.5 text-sm font-semibold tabular-nums text-fg">{Math.max(node.ipStats.total - node.ipStats.used, 0)}<span className="font-normal text-fg-4"> / {node.ipStats.total}</span></div>
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line pt-2 text-xs text-fg-3">
                      <div className="flex justify-between gap-3"><span>{t('common.region')}</span><span className="truncate text-right text-fg-2">{node.region || '—'}</span></div>
                      <div className="flex justify-between gap-3"><span>{t('nodeForm.publicIp')}</span><span className="truncate font-mono text-right text-fg-2">{node.publicIp || '—'}</span></div>
                      <div className="flex justify-between gap-3"><span>{t('plans.storagePool')}</span><span className="truncate text-right text-fg-2">{f.storagePool || defaultPool || '—'}</span></div>
                    </div>
                  </>
                ) : <div className="h-20 animate-pulse rounded-md bg-surface-2" />}
              </CardBody>
            </Card>

            <Card>
              <CardBody className="space-y-2.5 p-3 sm:p-3">
                <h3 className="text-sm font-semibold text-fg">{t('instCreate.summaryTitle')}</h3>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <div className="flex items-start justify-between gap-3"><span className="text-fg-3">{t('instCreate.user')}</span><span className="max-w-[11rem] truncate text-right font-medium text-fg">{user?.name || user?.username || t('common.notSet')}</span></div>
                  <div className="flex items-start justify-between gap-3"><span className="text-fg-3">{t('instCreate.hostname')}</span><span className="max-w-[11rem] truncate text-right font-mono text-fg">{f.hostname || '—'}</span></div>
                  <div className="flex items-start justify-between gap-3"><span className="text-fg-3">{t('instCreate.type')}</span><span className="max-w-[11rem] truncate text-right text-fg-2">{L.instanceType[f.type]}</span></div>
                  <div className="flex items-start justify-between gap-3"><span className="text-fg-3">{t('instCreate.image')}</span><span className="max-w-[11rem] truncate text-right text-fg-2">{selectedImage?.name || t('common.notSet')}</span></div>
                </div>
                <div className="grid grid-cols-3 gap-2 border-y border-line py-2 text-center">
                  <div><Cpu className="mx-auto size-3.5 text-fg-4" /><div className="mt-1 text-xs font-semibold tabular-nums text-fg">{f.cpu}</div><div className="text-[10px] text-fg-4">{t('adminInst.unitCores')}</div></div>
                  <div><Server className="mx-auto size-3.5 text-fg-4" /><div className="mt-1 text-xs font-semibold tabular-nums text-fg">{f.memory}</div><div className="text-[10px] text-fg-4">MiB</div></div>
                  <div><HardDrive className="mx-auto size-3.5 text-fg-4" /><div className="mt-1 text-xs font-semibold tabular-nums text-fg">{f.disk}</div><div className="text-[10px] text-fg-4">GiB</div></div>
                </div>
                <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2">
                  <WalletCards className="mt-0.5 size-3.5 shrink-0 text-fg-4" />
                  <div className="min-w-0 text-xs">
                    <div className="text-fg-3">{f.charge === 'charge' ? t('instCreate.chargeBalance') : t('instCreate.chargeFree')}</div>
                    <div className="mt-1 font-semibold text-fg">{formatMoney(f.charge === 'charge' ? f.price || 0 : 0, currency)}</div>
                    <div className="mt-0.5 text-[11px] text-fg-4">{L.billingCycle[f.billingCycle]} · {t('instCreate.price')}: {formatMoney(f.price || 0, currency)}</div>
                  </div>
                </div>
              </CardBody>
            </Card>
          </aside>
        )}
      </div>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/85 px-4 py-3 backdrop-blur lg:-mx-6 lg:px-6">
        {error && <span className={cn('mr-auto text-sm text-danger-text')}>{error}</span>}
        {f.charge === 'charge' && <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-fg-3"><WalletCards className="size-3.5" />{t('instCreate.charge')}: <strong className="font-semibold text-fg">{formatMoney(f.price || 0, currency)}</strong></span>}
        <LinkButton to={cancelTo}>{t('common.cancel')}</LinkButton>
        <Button type="submit" variant="primary" loading={create.isPending} disabled={f.planId === null || !!noFreeIp || short}>
          {t('instCreate.submit')}
        </Button>
      </div>
    </form>
  );
}

export default function AdminInstanceCreate() {
  const { t } = useI18n();
  const [params] = useSearchParams();
  return (
    <>
      <PageHeader back={{ to: '/admin/instances', label: t('nav.admin.instances') }} title={t('instCreate.title')} description={t('instCreate.desc')} />
      <InstanceCreateForm initialNodeId={Number(params.get('nodeId')) || 0} cancelTo="/admin/instances" />
    </>
  );
}

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Trash } from 'lucide-react';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  BILLING_CYCLES,
  CYCLE_MONTHS,
  hasIpv6Mode,
  IPV6_COUNT_MAX,
  isNatType,
  isPublicIpv4Mode,
  isVmType,
  type AdminPlanDTO,
  type AdminProductDTO,
  type BillingCycle,
  type InstanceType,
  type NodeDTO,
  type OverLimitAction,
  type StoragePoolDTO,
  type TrafficMode,
} from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Alert, Card, Empty, ErrorState, PageLoading, Switch, SwitchRow } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n, type MessageKey } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { trafficModeOptions, overLimitOptions } from '@/lib/plans';
import { Block, GRID, ToggleGroup, toggleRow } from './product-ui';
import { LimitFields, limitForm, limitPayload, type LimitForm } from '@/components/resource-limits';

const PRICE_FIELD: Record<BillingCycle, 'priceMonthly' | 'priceQuarterly' | 'priceSemiannual' | 'priceAnnual'> = {
  MONTHLY: 'priceMonthly',
  QUARTERLY: 'priceQuarterly',
  SEMIANNUAL: 'priceSemiannual',
  ANNUAL: 'priceAnnual',
};

/** 一个计费周期：启用后才填写价格，0 表示免费 */
type CyclePrice = { enabled: boolean; price: string };

interface PlanForm {
  productId: number | null;
  name: string;
  description: string;
  type: InstanceType;
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
  ipv6Count: string;
  storagePool: string;
  prices: Record<BillingCycle, CyclePrice>;
  stock: string;
  enabled: boolean;
  sortOrder: string;
}

function toForm(p?: AdminPlanDTO, productId?: number): PlanForm {
  return {
    productId: p?.productId ?? productId ?? null,
    name: p?.name ?? '',
    description: p?.description ?? '',
    type: p?.type ?? 'LXC_NAT',
    cpu: String(p?.cpu ?? 1),
    limits: limitForm(p),
    memory: String(p?.memory ?? 512),
    swap: String(p?.swap ?? 0),
    disk: String(p?.disk ?? 10),
    bandwidthIn: String(p?.bandwidthIn ?? 100),
    bandwidthOut: String(p?.bandwidthOut ?? 100),
    traffic: String(p?.traffic ?? 500),
    trafficMode: p?.trafficMode ?? 'OUT',
    overLimitAction: p?.overLimitAction ?? 'THROTTLE',
    throttleRate: String(p?.throttleRate ?? 1),
    trafficResetPrice: p?.trafficResetPrice ?? '',
    portLimit: String(p?.portLimit ?? 10),
    siteLimit: String(p?.siteLimit ?? 2),
    snapshotLimit: String(p?.snapshotLimit ?? 1),
    ipv6Count: String(p?.ipv6Count ?? 0),
    storagePool: p?.storagePool ?? '',
    // 新建时默认只启用月付
    prices: Object.fromEntries(
      BILLING_CYCLES.map((c) => [c, p ? { enabled: p.prices[c] !== undefined, price: p.prices[c] ?? '' } : { enabled: c === 'MONTHLY', price: '' }]),
    ) as Record<BillingCycle, CyclePrice>,
    stock: p?.stock !== null && p?.stock !== undefined ? String(p.stock) : '',
    enabled: p?.enabled ?? true,
    sortOrder: String(p?.sortOrder ?? 0),
  };
}

function toPayload(f: PlanForm, type: InstanceType) {
  return {
    productId: f.productId,
    name: f.name,
    description: f.description || null,
    cpu: Number(f.cpu),
    ...limitPayload(f.limits, type),
    memory: Number(f.memory),
    // SWAP 只对容器有效
    swap: isVmType(type) ? 0 : Number(f.swap) || 0,
    disk: Number(f.disk),
    bandwidthIn: Number(f.bandwidthIn),
    bandwidthOut: Number(f.bandwidthOut),
    traffic: Number(f.traffic),
    trafficMode: f.trafficMode,
    overLimitAction: f.overLimitAction,
    throttleRate: Number(f.throttleRate),
    // 留空表示不开放自助重置
    trafficResetPrice: f.trafficResetPrice.trim() || null,
    portLimit: Number(f.portLimit),
    siteLimit: Number(f.siteLimit),
    snapshotLimit: Number(f.snapshotLimit),
    ipv6Count: Number(f.ipv6Count) || 0,
    storagePool: f.storagePool || null,
    // 未启用的周期为 null（不提供），启用的周期 0 即免费
    ...Object.fromEntries(BILLING_CYCLES.map((c) => [PRICE_FIELD[c], f.prices[c].enabled ? f.prices[c].price.trim() : null])),
    stock: f.stock === '' ? null : Number(f.stock),
    enabled: f.enabled,
    sortOrder: Number(f.sortOrder),
  };
}

/** 套餐所属产品的管理页；没有产品时回到产品列表 */
const productPath = (id: number | null | undefined) => (id ? `/admin/products/${id}?tab=plans` : '/admin/plans');


const DEFAULT_POOL = '__default__';

/** 套餐级存储池：只能选所属产品的宿主机都具备的系统盘存储池（各宿主机按名称使用同名存储池） */
function PoolSelect({ nodes, value, onChange }: { nodes: NodeDTO[]; value: string; onChange: (v: string) => void }) {
  const { t } = useI18n();
  const ready = nodes.filter((n) => n.status !== 'PENDING');
  const results = useQueries({
    queries: ready.map((n) => ({
      queryKey: ['node-pools', n.id],
      queryFn: () => api.get<StoragePoolDTO[]>(`/admin/nodes/${n.id}/storage-pools`),
      retry: false,
    })),
  });
  const loading = results.some((r) => r.isLoading);
  const lists = results.filter((r) => r.data).map((r) => r.data!.filter((p) => p.usage === 'root').map((p) => p.name));
  // 所有宿主机共有的存储池
  const common = lists.length ? lists.reduce((acc, l) => acc.filter((x) => l.includes(x))) : [];
  return (
    <Select
      value={value || DEFAULT_POOL}
      onChange={(v) => onChange(v === DEFAULT_POOL ? '' : v)}
      disabled={loading}
      placeholder={loading ? t('common.loading') : undefined}
      options={[
        { value: DEFAULT_POOL, label: t('instCreate.poolDefault'), description: t('plans.poolDefaultDesc') },
        ...common.map((name) => ({ value: name, label: name, description: t('plans.poolCommon', { n: lists.length }) })),
        // 已保存但当前不在共有列表中的存储池仍保留为选项，提示可能无法开通
        ...(value && !common.includes(value) ? [{ value, label: value, description: t('plans.poolMissing') }] : []),
      ]}
    />
  );
}

/** 新建（plan 为空）或编辑套餐的表单 */
function PlanEditor({ plan, productId }: { plan?: AdminPlanDTO; productId?: number }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const [initial] = useState(() => toForm(plan, productId));
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  // 编辑时只有内容变化后才允许保存；新建时始终可提交
  const dirty = JSON.stringify(f) !== JSON.stringify(initial);
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes') });
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const product = products.data?.find((p) => p.id === f.productId);
  // 实例类型跟随所属产品
  const type = product?.type ?? f.type;
  // 产品绑定的宿主机中与类型网络模式匹配的数量（NAT 类型 ↔ NAT / IPv6，独立 IPv4 ↔ IPv4）
  const wantIpv6 = Number(f.ipv6Count) > 0;
  const fitting = (nodes.data ?? []).filter(
    (n) =>
      product?.nodeIds.includes(n.id) &&
      isPublicIpv4Mode(n.networkMode) === !isNatType(type) &&
      (wantIpv6 ? hasIpv6Mode(n.networkMode) && !!n.ipv6Subnet : n.networkMode !== 'IPV6_ONLY'),
  );
  const set = (k: keyof PlanForm) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const setCycle = (c: BillingCycle, v: Partial<CyclePrice>) => setF({ ...f, prices: { ...f.prices, [c]: { ...f.prices[c], ...v } } });

  const save = useMutation({
    mutationFn: () => (plan ? api.patch(`/admin/plans/${plan.id}`, toPayload(f, type)) : api.post('/admin/plans', toPayload(f, type))),
    onSuccess: () => {
      toast.success(plan ? t('plans.updated') : t('plans.created'));
      void qc.invalidateQueries({ queryKey: ['admin-plans'] });
      void qc.invalidateQueries({ queryKey: ['admin-products'] });
      navigate(productPath(f.productId));
    },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/plans/${plan!.id}`),
    onSuccess: () => {
      toast.success(t('plans.deleted'));
      void qc.invalidateQueries({ queryKey: ['admin-plans'] });
      navigate(productPath(plan!.productId), { replace: true });
    },
    onError: (e) => toast.fromError(e),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    // 启用的周期必须填写有效价格（0 为免费）
    const bad = BILLING_CYCLES.find((c) => f.prices[c].enabled && !/^\d+(\.\d{1,2})?$/.test(f.prices[c].price.trim()));
    if (bad) return setError(t('plans.priceRequired', { cycle: L.billingCycle[bad] }));
    if (!plan || dirty) save.mutate();
  };

  const nat = type !== 'KVM_IPV4';
  const num = (k: keyof PlanForm, label: MessageKey, unit?: string, desc?: MessageKey) => (
    <FormField label={t(label)} description={desc ? t(desc) : undefined}>
      {unit ? <InputGroup type="number" value={f[k] as string} onChange={set(k)} suffix={unit} /> : <Input type="number" value={f[k] as string} onChange={set(k)} />}
    </FormField>
  );
  const enabledCycles = BILLING_CYCLES.filter((c) => f.prices[c].enabled);

  return (
    <form onSubmit={submit} className="space-y-4">
      <Block title={t('plans.basic')}>
        <div className={GRID}>
          <FormField label={t('plans.product')} required>
            <Select
              value={f.productId}
              onChange={(v) => setF({ ...f, productId: v })}
              placeholder={t('plans.productPlaceholder')}
              options={(products.data ?? []).map((p) => ({
                value: p.id,
                label: p.name,
                description: [p.tags.join(' · '), p.regions.join('、') || t('products.noNodes')].filter(Boolean).join(' — '),
              }))}
            />
          </FormField>
          <FormField label={t('plans.name')} required>
            <Input value={f.name} onChange={set('name')} required autoFocus={!plan} placeholder={t('plans.namePlaceholder')} />
          </FormField>
          <FormField label={t('plans.type')} description={t('plans.typeFollows')}>
            <Input value={product ? L.instanceType[type] : ''} placeholder={t('plans.productPlaceholder')} disabled readOnly />
          </FormField>
        </div>
        <FormField label={t('plans.descriptionLabel')}>
          <Input value={f.description} onChange={set('description')} placeholder={t('plans.descriptionPlaceholder')} maxLength={500} />
        </FormField>
        {product && (
          <p className="text-xs text-fg-3">{t('plans.productNodes', { regions: product.regions.join('、') || '-', n: fitting.length })}</p>
        )}
        {product && fitting.length === 0 && <Alert tone="warning">{wantIpv6 ? t('plans.productNoIpv6') : t('plans.productNoFit', { type: L.instanceType[type] })}</Alert>}
      </Block>

      <Block title={t('plans.section.resources')}>
        <div className={GRID}>
          {num('cpu', 'adminInst.cpu', t('adminInst.unitCores'))}
          {num('memory', 'spec.memory', 'MiB')}
          {!isVmType(type) && num('swap', 'plans.swap', 'MiB', 'plans.swapHint')}
          {num('disk', 'spec.disk', 'GiB')}
          <FormField label={t('plans.storagePool')} description={t('plans.storagePoolHint')}>
            <PoolSelect nodes={fitting} value={f.storagePool} onChange={(storagePool) => setF({ ...f, storagePool })} />
          </FormField>
        </div>
      </Block>

      <Block title={t('plans.section.limits')} description={t('plans.section.limitsDesc')}>
        <div className={GRID}>
          <LimitFields value={f.limits} onChange={(limits) => setF({ ...f, limits })} type={type} />
        </div>
      </Block>

      <Block title={t('plans.section.network')}>
        <div className={GRID}>
          {num('bandwidthIn', 'adminInst.bwIn', 'Mbps')}
          {num('bandwidthOut', 'adminInst.bwOut', 'Mbps')}
          {num('traffic', 'plans.traffic', 'GiB', 'plans.trafficHint')}
          <FormField label={t('adminInst.trafficMode')}>
            <Select value={f.trafficMode} onChange={(v) => setF({ ...f, trafficMode: v })} options={trafficModeOptions(t, L)} />
          </FormField>
          <FormField label={t('adminInst.overLimit')}>
            <Select value={f.overLimitAction} onChange={(v) => setF({ ...f, overLimitAction: v })} options={overLimitOptions(t, L)} />
          </FormField>
          {f.overLimitAction === 'THROTTLE' && num('throttleRate', 'plans.throttle', 'Mbps')}
          <FormField label={t('plans.trafficResetPrice')} description={t('plans.trafficResetPriceHint')}>
            <InputGroup type="number" min={0} step={0.01} value={f.trafficResetPrice} onChange={set('trafficResetPrice')} prefix={currency} placeholder={t('plans.trafficResetOff')} />
          </FormField>
          <FormField label={t('plans.ipv6Count')} description={t('plans.ipv6CountHint')}>
            <InputGroup type="number" min={0} max={IPV6_COUNT_MAX} value={f.ipv6Count} onChange={set('ipv6Count')} suffix={t('plans.ipv6Unit')} />
          </FormField>
        </div>
      </Block>

      <Block title={t('plans.section.quota')}>
        <div className={GRID}>
          {nat && num('portLimit', 'adminInst.portLimit')}
          {num('snapshotLimit', 'adminInst.snapshotLimit')}
          {nat && num('siteLimit', 'adminInst.siteLimit')}
          {num('stock', 'plans.stock', undefined, 'plans.stockHint')}
          {num('sortOrder', 'common.sortOrder')}
        </div>
      </Block>

      <Block title={t('plans.section.billing')} description={t('plans.billingHint')}>
        {/* 每个周期一行：左侧按钮开启 / 关闭，中间价格，右侧折合每月或说明 */}
        <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
          {BILLING_CYCLES.map((c) => {
            const v = f.prices[c];
            const amount = Number(v.price);
            const valid = v.price.trim() !== '' && Number.isFinite(amount);
            const hint = !v.enabled
              ? t('plans.cycleOffHint')
              : !valid
                ? t('plans.cycleFreeHint')
                : amount === 0
                  ? t('common.priceFree')
                  : CYCLE_MONTHS[c] > 1
                    ? t('plans.perMonthEq', { amount: formatMoney(amount / CYCLE_MONTHS[c], currency) })
                    : '';
            return (
              <div key={c} className={cn('grid items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,16rem)_1fr]', !v.enabled && 'bg-surface-2/40')}>
                <button
                  type="button"
                  aria-pressed={v.enabled}
                  onClick={() => setCycle(c, { enabled: !v.enabled })}
                  className={cn(
                    'inline-flex h-8 w-fit items-center gap-2 rounded-md border px-2.5 text-[13px] transition-colors',
                    v.enabled ? 'border-line-strong bg-surface font-medium text-fg shadow-xs' : 'border-line bg-transparent text-fg-3 hover:border-line-strong hover:text-fg',
                  )}
                >
                  <span className={cn('flex size-4 items-center justify-center rounded border', v.enabled ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong bg-surface')}>
                    {v.enabled && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  {L.billingCycle[c]}
                </button>
                {v.enabled ? (
                  <InputGroup prefix={currency} inputMode="decimal" value={v.price} onChange={(e) => setCycle(c, { price: e.target.value })} placeholder="0.00" aria-label={L.billingCycle[c]} />
                ) : (
                  <span className="text-[13px] text-fg-4">{t('plans.cycleOff')}</span>
                )}
                <span className="truncate text-xs text-fg-3">{hint}</span>
              </div>
            );
          })}
        </div>
        {enabledCycles.length === 0 && <Alert tone="warning">{t('plans.noCycle')}</Alert>}
        <ToggleGroup>
          <SwitchRow checked={f.enabled} onCheckedChange={(v) => setF({ ...f, enabled: v })} title={t('plans.onSale')} description={t('plans.onSaleDesc')} className={toggleRow} />
        </ToggleGroup>
      </Block>

      {plan && (
        <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
          <div>
            <h3 className="text-[15px] font-semibold text-fg">{t('common.dangerZone')}</h3>
            <p className="mt-0.5 text-xs text-fg-3">{t('plans.deleteDesc')}</p>
          </div>
          <Button
            variant="danger-ghost"
            icon={<Trash />}
            loading={remove.isPending}
            className="shrink-0 self-start sm:self-auto"
            onClick={async () => {
              if (await confirm({ title: t('plans.deleteTitle', { name: plan.name }), description: t('plans.deleteDesc'), danger: true })) remove.mutate();
            }}
          >
            {t('plans.delete')}
          </Button>
        </Card>
      )}

      {/* 底部操作栏：表单较长时始终可见 */}
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/85 px-4 py-2.5 backdrop-blur lg:-mx-6 lg:px-6">
        {error ? (
          <span className="mr-auto text-sm text-danger-text">{error}</span>
        ) : (
          plan &&
          dirty && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-fg-3">
              <span className="size-1.5 rounded-full bg-warning" />
              {t('common.unsaved')}
            </span>
          )
        )}
        <LinkButton to={productPath(initial.productId)}>{t('common.cancel')}</LinkButton>
        <Button type="submit" variant="primary" loading={save.isPending} disabled={!!plan && !dirty}>
          {plan ? t('common.saveChanges') : t('plans.create')}
        </Button>
      </div>
    </form>
  );
}

export default function AdminPlanEdit() {
  const { t } = useI18n();
  const params = useParams();
  const [search] = useSearchParams();
  const id = params.id ? Number(params.id) : null;
  // 后台没有单个套餐的接口，从列表中查找（通常已缓存）
  const q = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<AdminPlanDTO[]>('/admin/plans'), enabled: id !== null });
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const backTo = (productId: number | null | undefined) => ({
    to: productPath(productId),
    label: products.data?.find((p) => p.id === productId)?.name ?? t(productId ? 'products.back' : 'nav.admin.plans'),
  });

  if (id === null) {
    const productId = Number(search.get('product')) || undefined;
    const product = products.data?.find((p) => p.id === productId);
    return (
      <>
        <PageHeader back={backTo(productId)} title={t('plans.create')} description={product ? t('plans.createIn', { name: product.name }) : undefined} />
        <PlanEditor productId={productId} />
      </>
    );
  }
  if (q.isLoading) return <PageLoading />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const plan = q.data?.find((p) => p.id === id);
  if (!plan) return <Empty title={t('plans.notFound')} />;
  return (
    <>
      <PageHeader back={backTo(plan.productId)} title={t('plans.editTitle', { name: plan.name })} description={t('plans.editDesc')} />
      {/* 以套餐 id 为 key：切换套餐时重新以其数据初始化表单 */}
      <PlanEditor key={plan.id} plan={plan} />
    </>
  );
}

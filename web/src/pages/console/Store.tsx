import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Circle, CircleCheck, Dices, FileText, Info, Link2, ShoppingCart, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { BILLING_CYCLES, isNatType, isVmType, scaleTraffic, type AffSummaryDTO, type BillingCycle, type CouponQuoteDTO, type ImageDTO, type InvoiceDTO, type NightOfferDTO, type NodeStatus, type PlanDTO, type ProductDTO } from '../../shared/index';
import { CountryFlag, useCountryArea, useCountryName } from '@/components/country';
import { CouponInput } from '@/components/CouponInput';
import { ProductNodeTestButton } from '@/components/ping/NodeTestButton';
import { SwitchRulesButton } from '@/pages/instance/SwitchNode';
import { PageHeader } from '@/components/page';
import { ImagePicker } from '@/components/ImagePicker';
import { combineSshKeys, SshKeyField, useSshKeys } from '@/components/SshKeys';
import { OsIcon } from '@/components/status';
import { Button } from '@/components/ui/button';
import { FormField, Input } from '@/components/ui/input';
import { Alert, Card, Empty, ErrorState, PageLoading, Tag, Tooltip } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n, type TFunction } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBandwidth, formatCores, formatMemory, formatMoney, formatPrice, formatTraffic } from '@/lib/format';
import { cheapest } from '@/lib/plans';
import { useCurrency, useMe, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { useCreateInvoice } from '@/hooks/create-invoice';

function randomHostname() {
  return `vps-${Math.random().toString(36).slice(2, 7)}`;
}

const spec = (p: PlanDTO) => `${formatCores(p.cpu)} ${formatMemory(p.memory)} ${p.disk} GB`;
const bandwidth = (p: PlanDTO) => (p.bandwidthIn === p.bandwidthOut ? formatBandwidth(p.bandwidthIn) : `${formatBandwidth(p.bandwidthIn)} / ${formatBandwidth(p.bandwidthOut)}`);

/** 套餐在某地区的实例流量：按该地区宿主机的流量倍率换算 */
/** 套餐流量：选了宿主机时按该宿主机的倍率，否则按地区（地区内各宿主机倍率的最小值） */
const trafficOf = (p: PlanDTO, region: string, multiplier?: number) => scaleTraffic(p.traffic, multiplier ?? p.regionInfo[region]?.trafficMultiplier ?? 1);

/** 网络：NAT 写明端口数，独立 IP 写 IPv4 个数，另附 IPv6 个数 */
const networkOf = (p: PlanDTO, t: TFunction) =>
  [isNatType(p.type) ? t('store.natPorts', { n: p.portLimit }) : t('store.ipv4One'), p.ipv6Count > 0 && t('store.ipv6N', { n: p.ipv6Count })].filter(Boolean).join(' · ');

/** 产品的类型标签（排在自定义标签前面）：虚拟化 LXC / KVM，网络 NAT 共享 IPv4 / 独立 IPv4，所选地区有套餐提供 IPv6 时再加 IPv6 */
const networkTags = (p: ProductDTO, plans: PlanDTO[], t: TFunction) => [isVmType(p.type) ? 'KVM' : 'LXC', isNatType(p.type) ? t('store.tagNat') : t('store.tagIpv4'), plans.some((x) => x.ipv6Count > 0) && t('store.tagIpv6')].filter((x): x is string => !!x);

/** 长方形旗帜 */
function FlagTile({ code, className }: { code: string; className?: string }) {
  return <CountryFlag code={code} className={cn('h-[18px] w-[27px] shrink-0 rounded-[3px]', className)} />;
}

/** 页面分节：标题 + 内容，节之间细线分隔 */
function Section({ title, extra, children }: { title: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line py-5 first:pt-0 last:border-0 last:pb-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold text-fg">{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  );
}

interface SaleNode {
  id: number;
  name: string;
  status: NodeStatus;
  /** 产品在这台宿主机上的流量倍率 */
  trafficMultiplier: number;
  /** 这台宿主机提供的镜像；null 为全部 */
  imageIds: number[] | null;
  /** 这台宿主机现在能开通的套餐 */
  plans: number[];
}

/** 选择节点：分别显示离线与缺货状态。 */
function NodeTabs({ nodes, value, onChange, planId }: { nodes: SaleNode[]; value: number | null; onChange: (id: number) => void; planId: number | null }) {
  const { t } = useI18n();
  return (
    <div className="mb-3 inline-flex max-w-full flex-wrap gap-1 rounded-lg border border-line bg-surface-2 p-1" role="radiogroup" aria-label={t('store.node')}>
      {nodes.map((n) => {
        const out = planId ? !n.plans.includes(planId) : !n.plans.length;
        const status = n.status === 'OFFLINE' ? t('store.nodeOffline') : out ? t('store.nodeOut') : null;
        const on = value === n.id;
        return (
          <button
            key={n.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(n.id)}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] transition-colors',
              on ? 'bg-surface font-medium text-fg shadow-xs ring-1 ring-line' : 'text-fg-2 hover:text-fg',
            )}
          >
            {n.name}
            {status && <span className="rounded bg-surface-3 px-1 text-[10px] leading-4 text-fg-3">{status}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 可选卡片：选中时描边高亮并显示勾 */
function Choice({ checked, onClick, className, children }: { checked: boolean; onClick: () => void; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        'relative min-w-0 rounded-lg border bg-surface text-left transition-[border-color,background-color,box-shadow] duration-150',
        checked ? 'border-primary bg-surface-2' : 'border-line hover:border-line-strong hover:bg-surface-2/60',
        className,
      )}
    >
      {children}
      {checked && <CircleCheck className="absolute top-1.5 right-1.5 size-3.5 text-fg-2" />}
    </button>
  );
}

const PLAN_COLS = 'grid-cols-[minmax(0,1.4fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_4.5rem_minmax(0,0.9fr)]';

/** 流量：限量时悬停显示超量后的处理（限速多少 / 停机）和重置流量的价格 */
function TrafficCell({ plan, traffic }: { plan: PlanDTO; traffic: number }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  if (traffic <= 0) return <span className="tabular truncate text-fg-2">{t('store.unlimitedTraffic')}</span>;
  return (
    <Tooltip
      content={
        <span className="block space-y-0.5">
          <span className="block">
            {t('store.overLimit')}：{plan.overLimitAction === 'THROTTLE' ? t('store.throttleTo', { rate: plan.throttleRate }) : L.overLimitAction.STOP}
          </span>
          <span className="block">
            {t('store.trafficReset')}：{plan.trafficResetPrice !== null ? <span className="font-semibold">{t('store.perReset', { price: formatMoney(plan.trafficResetPrice, currency) })}</span> : t('store.noTrafficReset')}
          </span>
        </span>
      }
    >
      <span className="tabular cursor-help truncate text-fg-2 underline decoration-line-strong decoration-dotted underline-offset-4">{formatTraffic(traffic)}</span>
    </Tooltip>
  );
}

/** 套餐：宽屏为表格，窄屏一行一个卡片（标题 + 规格摘要 + 硬盘 / 流量 / 网络 / 价格） */
function PlanTable({ plans, region, value, onChange, unavailable, offline, trafficMultiplier }: { plans: PlanDTO[]; region: string; value: number | null; onChange: (id: number) => void; unavailable?: Set<number>; offline: boolean; trafficMultiplier?: number }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const view = plans.map((p) => {
    const best = cheapest(p);
    const monthly = p.prices.MONTHLY ?? best?.perMonth ?? 0;
    // 套餐库存用完，或所选节点开不了这个套餐
    const soldOut = p.stockLeft === 0 || !!unavailable?.has(p.id);
    const disabled = offline || soldOut;
    const stock = offline ? (
      <Tag>{t('store.nodeOffline')}</Tag>
    ) : soldOut ? (
      <Tag>{t('store.soldOut')}</Tag>
    ) : p.stockLeft !== null && p.stockLeft <= 5 ? (
      <Tag tone="warning">{t('store.stockLeft', { n: p.stockLeft })}</Tag>
    ) : (
      <Tag tone="success">{t('store.onSale')}</Tag>
    );
    const price = (
      <span className="tabular whitespace-nowrap">
        <span className="font-semibold text-fg">{formatPrice(monthly, currency)}</span>
        {Number(monthly) > 0 && <span className="text-xs text-fg-3">{p.prices.MONTHLY ? t('store.perMonth') : t('store.perMonthEquivalent')}</span>}
      </span>
    );
    return { p, disabled, stock, price, checked: value === p.id, traffic: trafficOf(p, region, trafficMultiplier) };
  });
  const radio = (checked: boolean) => (checked ? <CircleCheck className="size-4 shrink-0 text-fg" /> : <Circle className="size-4 shrink-0 text-fg-4" />);

  return (
    <div className="@container" role="radiogroup" aria-label={t('store.step.plan')}>
      {/* 宽屏：表格 */}
      <div className="hidden overflow-hidden rounded-lg border border-line bg-surface @2xl:block">
        <div className={cn('grid gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5 text-xs text-fg-3', PLAN_COLS)}>
          <span>{t('store.colPlan')}</span>
          <span>{t('store.colConfig')}</span>
          <span>{t('spec.bandwidth')}</span>
          <span>{t('spec.traffic')}</span>
          <span>{t('store.colNetwork')}</span>
          <span>{t('store.colStock')}</span>
          <span>{t('store.colPrice')}</span>
        </div>
        {view.map(({ p, disabled, stock, price, checked, traffic }) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(p.id)}
            className={cn(
              'grid w-full items-center gap-3 border-b border-line/70 px-4 py-3 text-left text-[13px] transition-colors last:border-0 disabled:cursor-not-allowed disabled:opacity-45',
              PLAN_COLS,
              checked ? 'bg-surface-2 shadow-[inset_2px_0_0_var(--color-primary)]' : 'hover:not-disabled:bg-surface-2/50',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {radio(checked)}
              <span className={cn('truncate', checked ? 'font-semibold text-fg' : 'text-fg')}>{p.name}</span>
            </span>
            <span className="tabular min-w-0 truncate text-fg-2">{spec(p)}</span>
            <span className="tabular truncate text-fg-2">{bandwidth(p)}</span>
            <TrafficCell plan={p} traffic={traffic} />
            <span className="truncate text-fg-2" title={networkOf(p, t)}>
              {networkOf(p, t)}
            </span>
            <span>{stock}</span>
            {price}
          </button>
        ))}
      </div>

      {/* 窄屏：一行一个卡片 */}
      <div className="space-y-2 @2xl:hidden">
        {view.map(({ p, disabled, stock, price, checked, traffic }) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(p.id)}
            className={cn(
              'block w-full rounded-lg border px-3.5 py-3 text-left text-[13px] transition-[border-color,background-color] duration-150 disabled:cursor-not-allowed disabled:opacity-45',
              checked ? 'border-primary bg-surface-2' : 'border-line bg-surface hover:not-disabled:border-line-strong',
            )}
          >
            <span className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                {radio(checked)}
                <span className={cn('truncate text-[14px]', checked ? 'font-semibold text-fg' : 'font-medium text-fg')}>{p.name}</span>
              </span>
              {stock}
            </span>
            <span className="tabular mt-0.5 block truncate pl-6 text-xs text-fg-3">
              {formatCores(p.cpu)} · {formatMemory(p.memory)} · {bandwidth(p)}
            </span>
            <span className="mt-2.5 block space-y-1.5 border-t border-line/70 pt-2.5">
              <span className="flex items-center justify-between gap-3">
                <span className="text-fg-3">{t('spec.disk')}</span>
                <span className="tabular text-fg">{p.disk} GB</span>
              </span>
              {p.swap > 0 && (
                <span className="flex items-center justify-between gap-3">
                  <span className="text-fg-3">SWAP</span>
                  <span className="tabular text-fg">{t('store.swapValue', { size: formatMemory(p.swap) })}</span>
                </span>
              )}
              <span className="flex items-center justify-between gap-3">
                <span className="text-fg-3">{t('spec.traffic')}</span>
                <TrafficCell plan={p} traffic={traffic} />
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="shrink-0 text-fg-3">{t('store.colNetwork')}</span>
                <span className="truncate text-fg">{networkOf(p, t)}</span>
              </span>
              <span className="flex items-center justify-between gap-3">
                <span className="text-fg-3">{t('store.colPrice')}</span>
                {price}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-[13px]">
      <span className="shrink-0 text-fg-3">{label}</span>
      <span className="flex min-w-0 items-center justify-end gap-1.5 text-right break-words text-fg">{children || '-'}</span>
    </div>
  );
}

export default function Store() {
  const { t, L } = useI18n();
  const { data: me } = useMe();
  const { data: site } = usePublicConfig();
  const currency = useCurrency();
  const countryName = useCountryName();
  const countryArea = useCountryArea();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const nightOfferId = Number(params.get('nightOffer')) || null;
  const nightOffer = useQuery({
    queryKey: ['night-offer', nightOfferId], queryFn: () => api.get<{ offer: NightOfferDTO; closesAt: string }>(`/night-market/offers/${nightOfferId}`),
    enabled: !!nightOfferId && !!me, staleTime: 0, refetchInterval: 30_000,
  });
  const plans = useQuery({ queryKey: ['store-plans'], queryFn: () => api.get<PlanDTO[]>('/public/plans') });
  const products = useQuery({ queryKey: ['store-products'], queryFn: () => api.get<ProductDTO[]>('/public/products') });
  const images = useQuery({ queryKey: ['store-images'], queryFn: () => api.get<ImageDTO[]>('/public/images') });

  const [region, setRegion] = useState<string | null>(null);
  const [productId, setProductId] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  // 选择的节点（产品在所选地区有多台宿主机时）
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [cycle, setCycle] = useState<BillingCycle | null>(null);
  const [imageId, setImageId] = useState<number | null>(null);
  const [hostname, setHostname] = useState(randomHostname);
  const [password, setPassword] = useState('');
  const [sshKeys, setSshKeys] = useState('');
  const [keyIds, setKeyIds] = useState<number[]>([]);
  const savedKeys = useSshKeys().data;
  // 账号里保存了公钥时直接显示选择框
  const [showKeysRaw, setShowKeys] = useState(false);
  const showKeys = showKeysRaw || !!savedKeys?.length;
  const [error, setError] = useState<string | null>(null);
  const [coupon, setCoupon] = useState<CouponQuoteDTO | null>(null);

  const allPlans = useMemo(() => plans.data ?? [], [plans.data]);
  // 地区：所有在售套餐覆盖的地区，旗帜取自产品绑定的宿主机
  const regions = useMemo(() => {
    const out: Array<{ name: string; country: string }> = [];
    for (const p of products.data ?? []) {
      for (const r of p.regions) {
        if (!allPlans.some((x) => x.productId === p.id && x.regions.includes(r))) continue;
        if (!out.some((x) => x.name === r)) out.push({ name: r, country: p.regionCountry[r] ?? '' });
      }
    }
    return out;
  }, [products.data, allPlans]);
  const regionProducts = (products.data ?? []).filter((p) => region && allPlans.some((x) => x.productId === p.id && x.regions.includes(region)));
  const product = regionProducts.find((p) => p.id === productId) ?? null;
  const productPlans = allPlans.filter((x) => x.productId === productId && !!region && x.regions.includes(region));
  const plan = productPlans.find((p) => p.id === planId) ?? null;
  const cycles = plan ? BILLING_CYCLES.filter((c) => plan.prices[c]) : [];
  // 该地区是否需要实名认证等地区信息
  const info = plan && region ? plan.regionInfo[region] : undefined;
  const regionCountry = regions.find((r) => r.name === region)?.country ?? '';
  // 产品在所选地区的宿主机：多于一台时可以选择，区分离线与库存不足。
  const saleNodes = useQuery({
    queryKey: ['sale-nodes', productId, region],
    queryFn: () => api.get<{ nodes: SaleNode[] }>(`/public/products/${productId}/nodes`, { region: region! }),
    enabled: !!productId && !!region,
    refetchInterval: 15_000,
  });
  const nodes = saleNodes.data?.nodes ?? [];
  const multiNode = nodes.length > 1;
  const node = nodes.find(n => n.id === nodeId) ?? nodes.find(n => planId && n.plans.includes(planId)) ?? nodes.find(n => n.plans.length) ?? nodes[0] ?? null;
  const nodeOffline = node?.status === 'OFFLINE';
  // 单台和离线宿主机也按自己的镜像列表筛选；节点信息加载前不回退到地区镜像并集。
  const allowedImages = node ? node.imageIds : [];
  const usable = (images.data ?? []).filter((i) => (plan && isVmType(plan.type) ? i.forVm : i.forContainer) && (allowedImages === null || allowedImages.includes(i.id)));
  const image = usable.find((i) => i.id === imageId) ?? null;
  const nodeUnavailable = useMemo(() => (node ? new Set(productPlans.filter((p) => !node.plans.includes(p.id)).map((p) => p.id)) : undefined), [node, productPlans]);

  // 首次加载：按地址栏 ?plan=&cycle=、?product= 或第一个地区初始化
  useEffect(() => {
    if (!plans.data || !products.data || region) return;
    const wanted = plans.data.find((p) => String(p.id) === params.get('plan'));
    const wantedProduct = plans.data.find((p) => String(p.productId) === params.get('product') && p.regions.length);
    if (wanted?.regions[0]) {
      // 首页点「立即购买」时带上所选地区
      const wantedRegion = params.get('region');
      setRegion(wantedRegion && wanted.regions.includes(wantedRegion) ? wantedRegion : wanted.regions[0]);
      setProductId(wanted.productId);
      setPlanId(wanted.id);
      const wantedCycle = BILLING_CYCLES.find((c) => c === params.get('cycle'));
      if (wantedCycle && wanted.prices[wantedCycle]) setCycle(wantedCycle);
    } else if (wantedProduct) {
      setRegion(wantedProduct.regions[0]!);
      setProductId(wantedProduct.productId);
    } else {
      // 顶栏「云服务器」菜单带 ?region= 进来时，直接选中该地区
      const wantedRegion = regions.find((r) => r.name === params.get('region'));
      if (wantedRegion) setRegion(wantedRegion.name);
      else if (regions[0]) setRegion(regions[0].name);
    }
  }, [plans.data, products.data, regions, region, params]);

  // 已在购买页时再从菜单选择其他地区：切换到该地区
  const regionParam = params.get('region');
  useEffect(() => {
    if (regionParam && regions.some((r) => r.name === regionParam)) setRegion(regionParam);
  }, [regionParam, regions]);

  // 地区 / 产品 / 套餐变化时修正依赖的选项
  useEffect(() => {
    if (region && !regionProducts.some((p) => p.id === productId)) setProductId(regionProducts[0]?.id ?? null);
  }, [region, regionProducts, productId]);
  useEffect(() => {
    if (productId && !productPlans.some((p) => p.id === planId)) setPlanId((productPlans.find((p) => p.stockLeft !== 0) ?? productPlans[0])?.id ?? null);
  }, [productId, productPlans, planId]);
  useEffect(() => {
    if (plan && (!cycle || !plan.prices[cycle])) setCycle(BILLING_CYCLES.find((c) => plan.prices[c]) ?? null);
  }, [plan, cycle]);
  useEffect(() => {
    if (node && node.id !== nodeId) setNodeId(node.id);
  }, [node, nodeId]);
  const selectNode = (id: number) => {
    setNodeId(id);
    const target = nodes.find((n) => n.id === id);
    if (target && planId && !target.plans.includes(planId)) {
      const next = productPlans.find((p) => p.stockLeft !== 0 && target.plans.includes(p.id));
      if (next) setPlanId(next.id);
    }
  };
  useEffect(() => {
    // 默认选排序第一的镜像
    if (usable.length && !usable.some((i) => i.id === imageId)) setImageId(usable[0]!.id);
  }, [usable, imageId]);

  const price = plan && cycle ? Number(plan.prices[cycle] ?? 0) : 0;
  const night = nightOffer.data?.offer;
  const nightMatches = !!night?.prize && night.prize.planId === planId && night.prize.cycle === cycle;
  // 应付金额：使用优惠码后为减免后的金额（只抵扣首期）
  const due = nightMatches ? Number(night!.amount) : coupon ? Number(coupon.total) : price;
  const balance = Number(me?.balance ?? 0);
  // 游客可以浏览并选好配置，购买时再登录 / 注册
  const guest = !me;
  const missing = [
    !region && t('store.need.region'),
    !plan && t('store.need.plan'),
    plan && (nodeOffline ? t('store.nodeOffline') : (plan.stockLeft === 0 || !node || !node.plans.includes(plan.id)) && t('store.nodeOut')),
    !image && t('store.need.image'),
    !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname) && t('store.need.hostname'),
    nightOfferId && !guest && nightOffer.isPending && t('night.checkoutLoading'),
    nightOfferId && !guest && nightOffer.error && errorText(nightOffer.error),
  ].filter(Boolean) as string[];

  const order = useCreateInvoice({
    mutationFn: () => api.post<{ invoice: InvoiceDTO }>('/store/orders', { planId, region, imageId, cycle, hostname, password, sshKeys: combineSshKeys(savedKeys, keyIds, sshKeys), couponCode: nightMatches ? undefined : coupon?.code, nightMarketOfferId: nightMatches ? nightOfferId : undefined, nodeId: node?.id }),
    onCreated: () => { void qc.invalidateQueries({ queryKey: ['night-market'] }); void qc.invalidateQueries({ queryKey: ['night-offer'] }); },
    onError: (e) => setError(errorText(e)),
  });

  // 生成并复制当前套餐的推广链接：/store?plan=&cycle=&aff=，好友打开后直接选中该套餐
  const affLink = useMutation({
    mutationFn: async () => {
      const aff = await qc.fetchQuery({ queryKey: ['aff'], queryFn: () => api.get<AffSummaryDTO>('/aff'), staleTime: 30_000 });
      if (!aff.enabled || !aff.code) throw new Error(t('store.affOff'));
      const link = `${location.origin}/store?plan=${planId}${cycle ? `&cycle=${cycle}` : ''}&aff=${aff.code}`;
      await navigator.clipboard.writeText(link);
      return link;
    },
    onSuccess: (link) => toast.success(t('store.affCopied'), link),
    onError: (e) => toast.fromError(e),
  });

  if (plans.isLoading || products.isLoading) return <PageLoading />;
  if (plans.error || products.error) return <ErrorState error={plans.error ?? products.error} onRetry={() => void Promise.all([plans.refetch(), products.refetch()])} />;

  return (
    <div>
      <PageHeader title={t('nav.store')} description={t('store.subtitle')} />
      {nightOfferId && <Alert className="mb-4" tone={nightOffer.error || (night && !nightMatches) ? 'warning' : 'primary'} title={t('night.checkout')}>
        {nightOffer.error ? errorText(nightOffer.error) : !night ? t('night.checkoutLoading') : nightMatches ? t('night.checkoutHint') : t('night.checkoutMismatch')}
      </Alert>}
      {!regions.length ? (
        <Card>
          <Empty title={t('store.empty')} description={t('store.emptyDesc')} />
        </Card>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0">
            <Section title={t('store.step.region')}>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4" role="radiogroup" aria-label={t('common.region')}>
                {regions.map((r) => (
                  <Choice key={r.name} checked={region === r.name} onClick={() => setRegion(r.name)} className="flex items-center gap-3 px-3.5 py-3">
                    <FlagTile code={r.country} className="h-6 w-9 rounded" />
                    <span className="min-w-0 pr-4">
                      <span className="block truncate text-[15px] leading-6 font-medium text-fg">{r.name}</span>
                      {/* 第二行显示所在区域（如欧洲西部）；没有归类时显示国家名称 */}
                      <span className="block truncate text-xs leading-4 text-fg-3">{r.country ? (countryArea(r.country) ?? countryName(r.country)) : '-'}</span>
                    </span>
                  </Choice>
                ))}
              </div>
              {info?.realName && (
                <p className="mt-2.5 text-xs text-fg-3">
                  {t('store.realNameHint')}{' '}
                  <Link to="/console/account?tab=realname" className="text-fg underline underline-offset-2">
                    {t('store.realNameGo')}
                  </Link>
                </p>
              )}
            </Section>

            {/* 右上角：产品在所选地区有节点测试结果时显示「节点测试」 */}
            <Section title={t('store.step.product')} extra={product && region ? <ProductNodeTestButton productId={product.id} region={region} productName={product.name} /> : undefined}>
              {/* 手机端一行一个产品，宽屏最多一行四个 */}
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t('store.step.product')}>
                {regionProducts.map((p) => (
                  <Choice key={p.id} checked={productId === p.id} onClick={() => setProductId(p.id)} className="px-3.5 py-3">
                    <span className="flex min-w-0 items-center gap-3 pr-5">
                      <FlagTile code={(region && p.regionCountry[region]) || regionCountry} className="h-6 w-9 rounded" />
                      <span className={cn('truncate text-[15px] leading-6', productId === p.id ? 'font-semibold text-fg' : 'font-medium text-fg-2')}>{p.name}</span>
                    </span>
                    <span className="mt-2.5 flex flex-wrap gap-1.5">
                      {networkTags(
                        p,
                        allPlans.filter((x) => x.productId === p.id && !!region && x.regions.includes(region)),
                        t,
                      ).map((tag) => (
                        <Tag key={tag}>{tag}</Tag>
                      ))}
                      {p.tags.map((tag) => (
                        <Tag key={tag} tone="primary">
                          {tag}
                        </Tag>
                      ))}
                    </span>
                  </Choice>
                ))}
              </div>
              {product?.description && (
                <div className="mt-2.5 flex gap-2 rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-fg-2">
                  <Info className="mt-0.5 size-4 shrink-0 text-fg-3" />
                  <p className="whitespace-pre-line">{product.description}</p>
                </div>
              )}
            </Section>

            {/* 右上角：切换机房规则（当前选择的节点 → 同产品的其他节点） */}
            <Section title={t('store.step.plan')} extra={<SwitchRulesButton from={node?.name} to={nodes.filter(n => n.id !== node?.id).map(n => n.name)} />}>
              {/* 只有一台宿主机时不显示节点选择 */}
              {multiNode && <NodeTabs nodes={nodes} value={node?.id ?? null} onChange={selectNode} planId={planId} />}
              {productPlans.length ? <PlanTable plans={productPlans} region={region!} value={planId} onChange={setPlanId} unavailable={nodeUnavailable} offline={nodeOffline} trafficMultiplier={node?.trafficMultiplier} /> : <Empty title={t('store.empty')} />}
            </Section>

            <Section title={t('store.os')}>
              {usable.length === 0 ? <p className="text-[13px] text-fg-3">{t('store.noImages')}</p> : <ImagePicker aria-label={t('store.os')} images={usable} value={imageId} onChange={setImageId} />}
            </Section>

            <Section
              title={t('store.step.settings')}
              extra={
                !showKeys && (
                  <button type="button" className="text-xs text-fg-3 transition-colors hover:text-fg" onClick={() => setShowKeys(true)}>
                    + {t('store.addSshKey')}
                  </button>
                )
              }
            >
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField label={t('store.cycle')} required>
                  <Select
                    aria-label={t('store.cycle')}
                    value={cycle}
                    onChange={setCycle}
                    options={cycles.map((c) => ({
                      value: c,
                      label: `${L.billingCycle[c]} · ${formatPrice(plan!.prices[c]!, currency)}`,
                    }))}
                  />
                </FormField>
                <FormField label={t('store.hostname')} required description={t('store.hostnameHint')}>
                  <div className="flex gap-1.5">
                    <Input value={hostname} onChange={(e) => setHostname(e.target.value.toLowerCase())} />
                    <Button size="icon" aria-label={t('common.random')} title={t('common.random')} onClick={() => setHostname(randomHostname())}>
                      <Dices />
                    </Button>
                  </div>
                </FormField>
                <FormField label={t('store.rootPassword')} description={t('store.rootPasswordHint')}>
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('common.autoGenerate')} autoComplete="new-password" />
                </FormField>
                {showKeys && (
                  <SshKeyField selected={keyIds} onSelected={setKeyIds} extra={sshKeys} onExtra={setSshKeys} className="sm:col-span-3" />
                )}
              </div>
            </Section>
          </div>

          {/* 订单详情：宽屏吸附在右侧 */}
          <Card className="overflow-hidden lg:sticky lg:top-[calc(var(--header-h,4.5rem)+1rem)]">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <FileText className="size-4 text-fg-3" />
              <h3 className="text-[15px] font-semibold text-fg">{t('store.orderDetail')}</h3>
              {/* 推广返利开启时：一键复制当前套餐（含周期）的推广链接 */}
              {site?.affEnabled && plan && !guest && (
                <Button size="sm" icon={<Link2 />} className="ml-auto" loading={affLink.isPending} title={t('store.affHint')} onClick={() => affLink.mutate()}>
                  AFF
                </Button>
              )}
            </div>
            <div className="px-4 py-2">
              <Row label={t('common.region')}>
                {region && <CountryFlag code={regionCountry} className="h-3.5 w-5" />}
                {region}
              </Row>
              <Row label={t('store.productLabel')}>{product?.name}</Row>
              <Row label={t('store.colPlan')}>{plan?.name}</Row>
              <Row label={t('store.colConfig')}>{plan && spec(plan)}</Row>
              <Row label={t('spec.bandwidth')}>{plan && bandwidth(plan)}</Row>
              <Row label={t('spec.traffic')}>
                {plan && region && (plan.traffic > 0 ? `${formatTraffic(trafficOf(plan, region, node?.trafficMultiplier))} · ${L.trafficMode[plan.trafficMode]}` : t('common.unlimited'))}
              </Row>
              {plan && plan.traffic > 0 && (
                <Row label={t('store.overLimit')}>{plan.overLimitAction === 'THROTTLE' ? t('store.throttleTo', { rate: plan.throttleRate }) : L.overLimitAction[plan.overLimitAction]}</Row>
              )}
              {plan && plan.traffic > 0 && plan.trafficResetPrice !== null && (
                <Row label={t('store.trafficReset')}>{t('store.perReset', { price: formatMoney(plan.trafficResetPrice, currency) })}</Row>
              )}
              <Row label={t('store.colNetwork')}>{plan && networkOf(plan, t)}</Row>
              <Row label={t('store.os')}>
                {image && <OsIcon family={image.family} className="size-7 border-0 bg-transparent text-[11px] [&_svg]:size-[70%]" />}
                {image?.name}
              </Row>
              <Row label={t('store.cycle')}>{cycle && L.billingCycle[cycle]}</Row>
            </div>
            <div className="px-4 pb-4">
              <div className="pt-1">
                {price > 0 && !guest && !nightMatches && (
                  <div className="py-1.5">
                    <CouponInput target={plan && cycle ? { kind: 'NEW', planId: plan.id, cycle } : null} value={coupon} onChange={setCoupon} currency={currency} />
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3 pt-1">
                  <span className="text-[13px] text-fg-3">{t('store.amountDue')}</span>
                  <span className="tabular text-2xl font-semibold tracking-tight text-fg">
                    {(coupon || nightMatches) && <span className="mr-1.5 text-sm font-normal text-fg-4 line-through">{formatMoney(nightMatches ? night!.prize!.originalPrice : price, currency)}</span>}
                    {formatPrice(due, currency)}
                    {cycle && price > 0 && !coupon && !nightMatches && <span className="ml-0.5 text-sm font-normal text-fg-3">/{L.billingCycle[cycle]}</span>}
                  </span>
                </div>
                {nightMatches && <p className="mt-1 text-right text-xs text-fg-3">{t('night.savePercent', { percent: night!.discountPercent! })} · {night!.prize!.discountMode === 'RECURRING' ? t('night.recurringPrice', { amount: formatMoney(night!.amount!, currency), cycle: L.billingCycle[cycle!] }) : t('coupon.firstPeriodOnly', { amount: formatMoney(price, currency) })}</p>}
                {coupon && !nightMatches && (
                  <p className="text-right text-xs text-fg-3">
                    {coupon.mode === 'RECURRING' ? t('coupon.recurringNote', { amount: formatMoney(coupon.total, currency) }) : t('coupon.firstPeriodOnly', { amount: formatMoney(price, currency) })}
                  </p>
                )}
              </div>
              {!guest && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-fg-3">
                  <Wallet className="size-3.5" />
                  {t('store.balanceLine', { balance: formatMoney(balance, currency) })}
                </div>
              )}
              {missing.length > 0 && <p className="mt-2 text-xs text-warning-text">{missing.join('、')}</p>}
              {error && (
                <Alert tone="danger" className="mt-2">
                  {error}
                </Alert>
              )}
              {guest ? (
                <div className="mt-3 flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={!plan}
                    onClick={() => navigate(`/login?redirect=${encodeURIComponent(`/store?plan=${planId}${cycle ? `&cycle=${cycle}` : ''}${region ? `&region=${encodeURIComponent(region)}` : ''}`)}`)}
                  >
                    {t('login.signIn')}
                  </Button>
                  <Button
                    variant="primary"
                    className="flex-1"
                    disabled={!plan}
                    onClick={() => navigate(`${site?.allowRegister === false ? '/login' : '/register'}?redirect=${encodeURIComponent(`/store?plan=${planId}${cycle ? `&cycle=${cycle}` : ''}${region ? `&region=${encodeURIComponent(region)}` : ''}`)}`)}
                  >
                    {t('store.registerToBuy')}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="primary"
                  icon={<ShoppingCart />}
                  className="mt-3 w-full"
                  loading={order.isPending}
                  loadingText={order.loadingText}
                  disabled={missing.length > 0}
                  onClick={() => {
                    setError(null);
                    order.mutate();
                  }}
                >
                  {t('store.buyNow')}
                </Button>
              )}
              <p className="mt-2 text-[11px] leading-relaxed text-fg-4">{t('store.deliveryHint')}</p>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ArrowUpRight, CircleCheck, Gift, ShoppingCart, Store, TicketPercent, UserRoundCog } from 'lucide-react';
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import { isVmType, type BillingCycle, type ImageDTO, type MarketListingDTO, type PlanDTO, type ProductDTO } from '../shared/index';
import { GalaxyParticles } from '@/components/landing/GalaxyParticles';
import { Reveal } from '@/components/landing/motion';
import { PublicFooter, PublicHeader, scrollToId } from '@/components/landing/PublicShell';
import { CountryFlag } from '@/components/country';
import { OsIcon } from '@/components/status';
import { buttonClass, LinkButton } from '@/components/ui/button';
import { Tag } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBandwidth, formatDate, formatMemory, formatMoney, formatTraffic } from '@/lib/format';
import { cheapest } from '@/lib/plans';

/** 库存标签：售罄 / 剩 5 台及以下显示剩余数量 / 在售 */
function StockTag({ left }: { left: number | null }) {
  const { t } = useI18n();
  if (left === 0) return <Tag>{t('lp.soldOut')}</Tag>;
  if (left !== null && left <= 5) return <Tag tone="warning">{t('store.stockLeft', { n: left })}</Tag>;
  return <Tag tone="success">{t('lp.onSale')}</Tag>;
}
import { useCurrency, useMe, usePublicConfig } from '@/lib/queries';

/** 页内锚点：平滑滚动到板块，不改变地址栏 */
const goTo = (id: string) => (e: MouseEvent) => {
  e.preventDefault();
  scrollToId(id);
};

/** 一行「地区 × 套餐」：热门云服务器表格的行 */
interface Row {
  key: string;
  plan: PlanDTO;
  region: string;
  country: string;
  product: ProductDTO | undefined;
}

function SectionHead({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-[26px] leading-tight font-medium tracking-tight text-fg sm:text-[30px]">{title}</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-3 sm:text-[15px]">{subtitle}</p>
      </div>
      {actions}
    </div>
  );
}

// ───────── 热门云服务器 ─────────

const COLS = 'lg:grid-cols-[1.25fr_1.15fr_1.35fr_.8fr_.8fr_1.1fr_.7fr_1fr_.95fr]';

function ipText(plan: PlanDTO, t: (k: 'lp.ip.nat' | 'lp.ip.dedicated' | 'lp.ip.v6') => string) {
  return [plan.type === 'KVM_IPV4' ? t('lp.ip.dedicated') : t('lp.ip.nat'), plan.ipv6Count > 0 ? t('lp.ip.v6') : null].filter(Boolean).join(' / ');
}

function PopularServers({ rows, regions, buyHref, allHref, loading }: { rows: Row[]; regions: { name: string; country: string }[]; buyHref: (r: Row) => string; allHref: string; loading: boolean }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const [region, setRegion] = useState<string | null>(null);
  const shown = rows.filter((r) => !region || r.region === region).slice(0, 8);
  const price = (p: PlanDTO) => {
    const best = cheapest(p);
    const monthly = p.prices.MONTHLY ?? best?.perMonth ?? 0;
    return (
      <span className="tabular whitespace-nowrap">
        <span className="font-semibold text-fg">{formatMoney(monthly, currency)}</span>
        <span className="text-xs text-fg-3"> / {t('lp.perMonth')}</span>
      </span>
    );
  };
  const stock = (p: PlanDTO) => <StockTag left={p.stockLeft} />;
  const sub = (r: Row) => r.product?.tags.slice(0, 2).join(' / ') || r.product?.name || '';
  return (
    <div>
      <SectionHead
        title={t('lp.popular.title')}
        subtitle={t('lp.popular.subtitle')}
        actions={
          <Link to={allHref} className={buttonClass('secondary', 'md', 'group')}>
            {t('lp.popular.all')}
            <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        }
      />
      {regions.length > 1 && (
        <div className="mt-6 flex flex-wrap gap-2" role="tablist">
          {[{ name: '', country: '' }, ...regions].map((r) => {
            const on = (region ?? '') === r.name;
            return (
              <button
                key={r.name || 'all'}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => setRegion(r.name || null)}
                className={cn(
                  'inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-[13px] transition-colors',
                  on ? 'border-line-strong bg-surface-3 font-medium text-fg' : 'border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg',
                )}
              >
                {r.name && <CountryFlag code={r.country} />}
                {r.name || t('lp.popular.allRegions')}
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
        <div className={cn('hidden gap-3 border-b border-line bg-surface-2/60 px-4 py-2.5 text-xs text-fg-3 lg:grid', COLS)}>
          <span>{t('lp.col.region')}</span>
          <span>{t('lp.col.plan')}</span>
          <span>{t('lp.col.config')}</span>
          <span>{t('lp.col.bandwidth')}</span>
          <span>{t('lp.col.traffic')}</span>
          <span>{t('lp.col.ip')}</span>
          <span>{t('lp.col.stock')}</span>
          <span>{t('lp.col.price')}</span>
          <span className="text-right">{t('lp.col.action')}</span>
        </div>
        {loading ? (
          Array.from({ length: 5 }, (_, i) => <div key={i} className="h-[62px] animate-pulse border-b border-line/70 bg-surface-2/40 last:border-0" />)
        ) : shown.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-fg-3">{t('lp.popular.empty')}</p>
        ) : (
          shown.map((r) => {
            const p = r.plan;
            const sold = p.stockLeft === 0;
            const config = `${p.cpu} vCPU / ${formatMemory(p.memory)} / ${p.disk} GB`;
            const buy = (
              <Link to={buyHref(r)} className={buttonClass(sold ? 'secondary' : 'primary', 'sm', 'whitespace-nowrap')} aria-disabled={sold}>
                {t('lp.buy')}
                <ShoppingCart />
              </Link>
            );
            return (
              <div key={r.key} className="border-b border-line/70 px-4 py-3 text-[13px] transition-colors last:border-0 hover:bg-surface-2/50">
                {/* 宽屏：表格行 */}
                <div className={cn('hidden items-center gap-3 lg:grid', COLS)}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <CountryFlag code={r.country} className="h-4 w-6" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-fg">{r.region}</span>
                      <span className="block truncate text-xs text-fg-3">{sub(r)}</span>
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-fg">{p.name}</span>
                    <span className="block truncate text-xs text-fg-3">{r.product?.name}</span>
                  </span>
                  <span className="tabular truncate text-fg-2">{config}</span>
                  <span className="tabular text-fg-2">{formatBandwidth(Math.max(p.bandwidthIn, p.bandwidthOut))}</span>
                  <span className="tabular text-fg-2">{p.traffic > 0 ? formatTraffic(p.traffic) : t('lp.unlimited')}</span>
                  <span className="truncate text-fg-2">{ipText(p, t)}</span>
                  <span>{stock(p)}</span>
                  {price(p)}
                  <span className="text-right">{buy}</span>
                </div>
                {/* 窄屏：卡片 */}
                <div className="space-y-2.5 lg:hidden">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <CountryFlag code={r.country} className="h-4 w-6" />
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-fg">{p.name}</span>
                        <span className="block truncate text-xs text-fg-3">
                          {r.region} · {sub(r)}
                        </span>
                      </span>
                    </span>
                    {stock(p)}
                  </div>
                  <div className="tabular flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-2">
                    <span>{config}</span>
                    <span>{formatBandwidth(Math.max(p.bandwidthIn, p.bandwidthOut))}</span>
                    <span>{p.traffic > 0 ? formatTraffic(p.traffic) : t('lp.unlimited')}</span>
                    <span>{ipText(p, t)}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    {price(p)}
                    {buy}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ───────── 系统镜像 ─────────

function ImageCards({ images, plans, shopHref }: { images: ImageDTO[]; plans: PlanDTO[]; shopHref: string }) {
  const { t } = useI18n();
  const currency = useCurrency();
  // 同一发行版的多个版本 / 架构合并成一张卡片
  const families = useMemo(() => {
    const map = new Map<string, ImageDTO[]>();
    for (const img of images) map.set(img.family, [...(map.get(img.family) ?? []), img]);
    return [...map.entries()].map(([family, list]) => ({ family, list }));
  }, [images]);
  // 起价：能运行该发行版的类型里最便宜的月付价（容器套餐 / 虚拟机套餐）
  const from = (list: ImageDTO[]) => {
    const container = list.some((i) => i.forContainer);
    const vm = list.some((i) => i.forVm);
    const prices = plans
      .filter((p) => (isVmType(p.type) ? vm : container))
      .map((p) => Number(p.prices.MONTHLY ?? cheapest(p)?.perMonth ?? NaN))
      .filter((n) => Number.isFinite(n));
    return prices.length ? Math.min(...prices) : null;
  };
  const row = (label: string, value: ReactNode) => (
    <div className="flex items-center justify-between gap-3 border-t border-line/70 py-2 first:border-0">
      <span className="shrink-0 text-xs text-fg-3">{label}</span>
      <span className="tabular truncate text-[13px] text-fg">{value}</span>
    </div>
  );
  return (
    <div>
      <SectionHead
        title={t('lp.images.title')}
        subtitle={t('lp.images.subtitle')}
        actions={
          <Link to={shopHref} className={buttonClass('secondary', 'md', 'group')}>
            {t('lp.images.shop')}
            <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
          </Link>
        }
      />
      <div className="mt-6 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3">
        <span className="mr-1 text-xs text-fg-3">{t('lp.images.capability')}</span>
        {[t('lp.images.cap1'), t('lp.images.cap2'), t('lp.images.cap3')].map((c) => (
          <span key={c} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2/60 px-2.5 py-1 text-xs text-fg-2">
            <CircleCheck className="size-3.5 text-fg-3" />
            {c}
          </span>
        ))}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {families.slice(0, 8).map(({ family, list }) => {
          const price = from(list);
          const types = [list.some((i) => i.forContainer) ? t('lp.images.container') : null, list.some((i) => i.forVm) ? t('lp.images.vm') : null].filter(Boolean).join(' / ');
          const arches = [...new Set(list.map((i) => i.arch))].join(' / ');
          return (
            <div key={family} className="rounded-xl border border-line bg-surface p-4 transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-card">
              <div className="flex items-center gap-3">
                <OsIcon family={family} className="size-10 rounded-lg text-sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-fg capitalize">{family}</div>
                  <div className="truncate text-xs text-fg-3">{t('lp.images.versions', { n: list.length })}</div>
                </div>
              </div>
              <div className="mt-3">
                {row(t('lp.images.types'), types)}
                {row(t('lp.images.arch'), arches)}
                {row(t('lp.images.from'), price === null ? '—' : `${formatMoney(price, currency)} / ${t('lp.perMonth')}`)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ───────── 优惠与推广 ─────────

/** 市场资源卡片：每日随机推荐的交易市场商品，点击跳到交易市场并按挂牌编号筛选出来购买 */
function FeaturedListing({ listing: l }: { listing: MarketListingDTO }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const name = [l.product?.name, l.plan].filter(Boolean).join(' - ') || `#${l.id}`;
  const rows: [string, string][] = [
    [t('lp.perks.fConfig'), `${l.cpu} vCPU / ${formatMemory(l.memory)} / ${l.disk} GB`],
    [t('lp.perks.fNet'), `${formatBandwidth(Math.max(l.bandwidthIn, l.bandwidthOut))} / ${l.traffic > 0 ? formatTraffic(l.traffic) : t('lp.unlimited')}`],
    [t('lp.perks.fExpires'), formatDate(l.expiresAt, 'YYYY/MM/DD HH:mm')],
  ];
  return (
    <Link to={`/market?q=${l.id}`} className="group block rounded-xl border border-line bg-surface p-4 transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-card sm:p-5" title={t('lp.perks.featuredHint')}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-medium text-fg">{t('lp.perks.featured')}</h3>
          <p className="mt-0.5 text-xs text-fg-3">{t('lp.perks.featuredSub')}</p>
        </div>
        <Store className="size-[18px] text-fg-3 transition-colors group-hover:text-brand-a" />
      </div>
      <div className="mt-4 rounded-lg border border-line bg-surface-2/50 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[14px] font-medium text-fg">{name}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-3">
              {l.country && <CountryFlag code={l.country} />}
              <span className="truncate">
                {l.region} · {L.instanceType[l.type]}
              </span>
            </div>
          </div>
          <Tag tone="success">{t('lp.perks.featuredTag')}</Tag>
        </div>
        <dl className="mt-3 text-[13px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-3 border-t border-line/70 py-2 first:border-0">
              <dt className="text-xs text-fg-3">{k}</dt>
              <dd className="tabular truncate font-medium text-fg">{v}</dd>
            </div>
          ))}
          <div className="flex items-center justify-between gap-3 border-t border-line/70 pt-2.5">
            <dt className="text-xs text-fg-3">{t('lp.perks.fPrice')}</dt>
            <dd className="tabular text-[17px] font-semibold text-fg">{formatMoney(l.price, currency)}</dd>
          </div>
        </dl>
      </div>
      <div className="mt-3 flex items-center justify-end gap-1 text-xs text-fg-3 transition-colors group-hover:text-fg">
        {t('lp.perks.featuredHint')}
        <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}

function Perks({ plans, featured, affRates, startHref, startLabel, consoleHref }: { plans: PlanDTO[]; featured: MarketListingDTO | null; affRates: { newRate: number; renewRate: number } | null; startHref: string; startLabel: string; consoleHref: string }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const sample = [...plans].sort((a, b) => (cheapest(a)?.perMonth ?? Infinity) - (cheapest(b)?.perMonth ?? Infinity))[0];
  const card = (icon: ReactNode, title: string, desc: string, facts: [string, string][]) => (
    <div className="flex gap-4 rounded-xl border border-line bg-surface p-4 transition-[border-color,box-shadow] duration-200 hover:border-line-strong hover:shadow-card sm:p-5">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2 text-fg-2 [&>svg]:size-[18px]">{icon}</span>
      <div className="grid min-w-0 flex-1 gap-x-6 gap-y-3 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="min-w-0">
          <h3 className="text-[15px] font-medium text-fg">{title}</h3>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-3">{desc}</p>
        </div>
        {facts.map(([k, v]) => (
          <div key={k} className="min-w-0 md:border-l md:border-line md:pl-4">
            <div className="text-xs text-fg-3">{k}</div>
            <div className="mt-1 text-[13px] font-medium text-fg">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
  const region = sample?.regions[0];
  return (
    <div>
      <SectionHead
        title={t('lp.perks.title')}
        subtitle={t('lp.perks.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <LinkButton to={startHref} variant="primary">
              {startLabel}
              <ArrowRight />
            </LinkButton>
            <LinkButton to={consoleHref} variant="secondary">
              {t('lp.ctaConsole')}
            </LinkButton>
          </div>
        }
      />
      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          {card(<TicketPercent />, t('lp.perks.coupon'), t('lp.perks.couponDesc'), [
            [t('lp.perks.couponF1'), t('lp.perks.couponV1')],
            [t('lp.perks.couponF2'), t('lp.perks.couponV2')],
            [t('lp.perks.couponF3'), t('lp.perks.couponV3')],
          ])}
          {affRates &&
            card(<Gift />, t('lp.perks.aff'), t('lp.perks.affDesc'), [
              [t('lp.perks.affF1'), `${affRates.newRate}%`],
              [t('lp.perks.affF2'), `${affRates.renewRate}%`],
              [t('lp.perks.affF3'), t('lp.perks.affV3')],
            ])}
          {card(<UserRoundCog />, t('lp.perks.transfer'), t('lp.perks.transferDesc'), [
            [t('lp.perks.transferF1'), t('lp.perks.transferV1')],
            [t('lp.perks.transferF2'), t('lp.perks.transferV2')],
            [t('lp.perks.transferF3'), t('lp.perks.transferV3')],
          ])}
        </div>
        {/* 右侧：交易市场每日推荐；市场未开放或没有在售商品时显示入门套餐 */}
        {featured ? (
          <FeaturedListing listing={featured} />
        ) : sample && (
          <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-[15px] font-medium text-fg">{t('lp.perks.sample')}</h3>
                <p className="mt-0.5 text-xs text-fg-3">{t('lp.perks.sampleSub')}</p>
              </div>
              <Store className="size-[18px] text-fg-3" />
            </div>
            <div className="mt-4 rounded-lg border border-line bg-surface-2/50 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium text-fg">{sample.name}</div>
                  <div className="mt-0.5 text-xs text-fg-3">{L.instanceType[sample.type]}</div>
                </div>
                <StockTag left={sample.stockLeft} />
              </div>
              <dl className="mt-3 text-[13px]">
                {[
                  [t('lp.perks.fConfig'), `${sample.cpu} vCPU / ${formatMemory(sample.memory)} / ${sample.disk} GB`],
                  [t('lp.perks.fNet'), `${formatBandwidth(Math.max(sample.bandwidthIn, sample.bandwidthOut))} / ${sample.traffic > 0 ? formatTraffic(sample.traffic) : t('lp.unlimited')}`],
                  [t('lp.perks.fRegion'), region ?? '—'],
                  [t('lp.perks.fPrice'), `${formatMoney(sample.prices.MONTHLY ?? cheapest(sample)?.perMonth ?? 0, currency)} / ${t('lp.perMonth')}`],
                ].map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between gap-3 border-t border-line/70 py-2 first:border-0">
                    <dt className="text-xs text-fg-3">{k}</dt>
                    <dd className="tabular truncate font-medium text-fg">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────── 页面 ─────────

export default function HomePage() {
  const { t } = useI18n();
  const { data: me } = useMe();
  const { data: cfg } = usePublicConfig();
  const plans = useQuery({ queryKey: ['public-plans'], queryFn: () => api.get<PlanDTO[]>('/public/plans'), staleTime: 60_000 });
  const products = useQuery({ queryKey: ['public-products'], queryFn: () => api.get<ProductDTO[]>('/public/products'), staleTime: 60_000 });
  const images = useQuery({ queryKey: ['public-images'], queryFn: () => api.get<ImageDTO[]>('/public/images'), staleTime: 5 * 60_000 });
  // 交易市场每日推荐（被买走或下架时服务端会重新抽取）
  const featured = useQuery({ queryKey: ['public-market-featured'], queryFn: () => api.get<{ listing: MarketListingDTO | null }>('/public/market/featured'), enabled: !!cfg?.marketEnabled, staleTime: 60_000 });

  const siteName = cfg?.siteName ?? 'PaleDove';
  const allowRegister = cfg?.allowRegister ?? true;
  const isAdmin = me?.role === 'ADMIN';
  const consoleHref = me ? (isAdmin ? '/admin' : '/console/dashboard') : null;
  const consoleLabel = isAdmin ? t('shell.adminConsole') : t('home.nav.console');
  const entryHref = isAdmin ? '/admin' : '/store';
  // 游客也可以直接进入购买页选配置，付款时再登录 / 注册
  const buyHref = (planId: number, cycle: BillingCycle | null, region?: string) => {
    if (isAdmin) return '/admin/plans';
    return `/store?plan=${planId}${cycle ? `&cycle=${cycle}` : ''}${region ? `&region=${encodeURIComponent(region)}` : ''}`;
  };

  // 「套餐 × 地区」行与地区筛选（地区旗帜取自产品绑定的宿主机）
  const { rows, regions } = useMemo(() => {
    const byProduct = new Map((products.data ?? []).map((p) => [p.id, p]));
    const rows: Row[] = [];
    const regions: { name: string; country: string }[] = [];
    for (const plan of plans.data ?? []) {
      const product = byProduct.get(plan.productId);
      for (const region of plan.regions) {
        const country = product?.regionCountry[region] ?? '';
        rows.push({ key: `${plan.id}-${region}`, plan, region, country, product });
        if (!regions.some((r) => r.name === region)) regions.push({ name: region, country });
      }
    }
    return { rows, regions };
  }, [plans.data, products.data]);

  const { hash } = useLocation();
  // 从其他页面带着 #板块 跳转过来时，滚动到对应板块
  useEffect(() => {
    const id = hash.slice(1);
    if (id) window.setTimeout(() => scrollToId(id), 60);
  }, [hash]);
  const hasPlans = (plans.data?.length ?? 0) > 0;
  const hasImages = (images.data?.length ?? 0) > 0;
  const affRates = cfg?.affEnabled ? { newRate: cfg.affRateNew, renewRate: cfg.affRateRenew } : null;
  const checks = [t('home.point.instant'), t('lp.point.ports'), t('lp.point.vpc'), t('lp.point.snapshot')];

  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <PublicHeader active="top" />

      {/* ───────── 首屏 ───────── */}
      <section id="top" className="relative isolate flex min-h-dvh items-center overflow-hidden border-b border-line">
        <GalaxyParticles className="absolute inset-y-0 right-0 -z-10 h-full w-full opacity-45 sm:opacity-70 lg:w-[66%] lg:opacity-100 [mask-image:linear-gradient(90deg,transparent,#000_24%)]" />
        <div className="mx-auto w-full max-w-7xl px-4 pt-28 pb-28 sm:px-6">
          <div className="max-w-2xl">
            <a href="#servers" onClick={goTo('servers')} className="page-enter inline-flex items-center gap-2.5 rounded-full border border-line bg-surface/70 py-1.5 pr-3 pl-3.5 text-[13px] text-fg-2 backdrop-blur transition-colors hover:border-line-strong hover:text-fg">
              <span className="size-2 rounded-full bg-success" />
              {t('home.badge')}
              <ArrowUpRight className="size-3.5 text-fg-3" />
            </a>
            <h1 className="page-enter mt-7 text-[44px] leading-[1.08] font-medium tracking-tight text-fg [animation-delay:80ms] sm:text-[60px] lg:text-[72px]">
              {t('home.titleLead')}
              <br />
              <span className="text-gradient">{t('home.titleEmphasis')}</span>
            </h1>
            <p className="page-enter mt-6 max-w-xl text-base leading-relaxed text-fg-3 [animation-delay:160ms] sm:text-lg">{t('home.subtitle')}</p>
            <ul className="page-enter mt-7 flex flex-wrap gap-x-5 gap-y-2.5 text-[13px] text-fg-2 [animation-delay:240ms]">
              {checks.map((c) => (
                <li key={c} className="flex items-center gap-2">
                  <span className="flex size-5 items-center justify-center rounded-full border border-line bg-surface-2/70">
                    <CircleCheck className="size-3 text-success-icon" aria-hidden />
                  </span>
                  {c}
                </li>
              ))}
            </ul>
            <div className="page-enter mt-9 flex flex-wrap gap-3 [animation-delay:320ms]">
              <Link to={entryHref} className={buttonClass('primary', 'lg', 'group h-12 px-8 text-[15px] shadow-card active:scale-[0.97]')}>
                {isAdmin ? consoleLabel : t('lp.ctaServers')}
                <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
              <a href="#servers" onClick={goTo('servers')} className={buttonClass('secondary', 'lg', 'h-12 bg-surface/70 px-8 text-[15px] backdrop-blur')}>
                {t('home.ctaPricing')}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ───────── 热门云服务器 ───────── */}
      <section id="servers" className="scroll-mt-4 border-b border-line py-20 sm:py-24">
        <Reveal className="mx-auto max-w-7xl px-4 sm:px-6">
          <PopularServers
            rows={rows}
            regions={regions}
            loading={plans.isLoading || products.isLoading}
            allHref={me ? (isAdmin ? '/admin/plans' : '/store') : `${allowRegister ? '/register' : '/login'}?redirect=${encodeURIComponent('/store')}`}
            buyHref={(r) => buyHref(r.plan.id, cheapest(r.plan)?.cycle ?? null, r.region)}
          />
        </Reveal>
      </section>

      {/* ───────── 系统镜像 ───────── */}
      {hasImages && (
        <section id="images" className="scroll-mt-4 border-b border-line py-20 sm:py-24">
          <Reveal className="mx-auto max-w-7xl px-4 sm:px-6">
            <ImageCards images={images.data!} plans={plans.data ?? []} shopHref={entryHref} />
          </Reveal>
        </section>
      )}

      {/* ───────── 优惠与推广 ───────── */}
      <section id="perks" className="scroll-mt-4 border-b border-line py-20 sm:py-24">
        <Reveal className="mx-auto max-w-7xl px-4 sm:px-6">
          <Perks plans={hasPlans ? plans.data! : []} featured={cfg?.marketEnabled ? (featured.data?.listing ?? null) : null} affRates={affRates} startHref={entryHref} startLabel={me ? (isAdmin ? consoleLabel : t('lp.ctaServers')) : t('lp.perks.start')} consoleHref={consoleHref ?? '/login'} />
        </Reveal>
      </section>

      {/* ───────── 控制台入口 ───────── */}
      <section className="px-4 py-24 sm:px-6 sm:py-28">
        <Reveal className="mx-auto max-w-3xl text-center">
          <h2 className="text-[30px] leading-tight font-medium tracking-tight text-fg sm:text-[42px]">{t('lp.console.title', { name: siteName })}</h2>
          <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-fg-3">{t('lp.console.desc')}</p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <Link to={consoleHref ?? (allowRegister ? '/register' : '/login')} className={buttonClass('primary', 'lg', 'group px-7 active:scale-[0.97]')}>
              {t('lp.ctaConsole')}
              <ArrowRight className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <LinkButton to={entryHref} variant="secondary" size="lg" className="px-7">
              {t('lp.images.shop')}
            </LinkButton>
          </div>
        </Reveal>
      </section>

      <PublicFooter />
    </div>
  );
}

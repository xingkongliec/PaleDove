import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardList, Cpu, Info, Link2, Package, Pencil, Plus, Settings2, Tag as TagIcon, Trash, Waves } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { BILLING_CYCLES, formatMultiplier, type AdminPlanDTO, type AdminProductDTO, type NodeDTO } from '../../../shared/index';
import { CountryFlag } from '@/components/country';
import { PageHeader } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Badge, Card, Empty, ErrorState, PageLoading, Switch, Tag } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBandwidth, formatCores, formatMemory, formatPrice, formatTraffic } from '@/lib/format';
import { cheapest } from '@/lib/plans';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { MODE_LABEL } from '../nodes/NodeForm';
import { copyProductLink, multiplierRange, productCountry, productSubtitle } from './Plans';
import { ProductSettings } from './ProductDialog';
import { Panel, ProductAvatar, Stat, StatStrip, StatusDot, TwoLine } from './product-ui';

type Tab = 'overview' | 'settings' | 'plans';

/** 信息网格中的一项 */
function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="mt-1 text-[13px] break-words text-fg">{children}</dd>
    </div>
  );
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-[13px] first:pt-0 last:pb-0">
      <span className="text-fg-3">{label}</span>
      <span className="text-right text-fg">{children}</span>
    </div>
  );
}

/** 数值范围：相同则只显示一个 */
function range(values: number[], fmt: (n: number) => string): string {
  if (!values.length) return '-';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? fmt(lo) : `${fmt(lo)} - ${fmt(hi)}`;
}

const nodeDot: Record<NodeDTO['status'], string> = { ONLINE: 'bg-success', OFFLINE: 'bg-danger', PENDING: 'bg-warning', UNKNOWN: 'bg-fg-4' };

function Overview({ product, plans, onTab }: { product: AdminProductDTO; plans: AdminPlanDTO[]; onTab: (t: Tab) => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes') });
  const bound = (nodes.data ?? []).filter((n) => product.nodeIds.includes(n.id));
  const sale = plans.filter((p) => p.enabled && p.stockLeft !== 0);
  // 最低价格：按折合月价比较
  const best = plans
    .filter((p) => p.enabled)
    .map((p) => ({ p, c: cheapest(p) }))
    .filter((x) => x.c)
    .sort((a, b) => a.c!.perMonth - b.c!.perMonth)[0];
  const traffic = plans.map((p) => p.traffic);
  const edit = (
    <button type="button" className="text-xs text-fg-3 transition-colors hover:text-fg" onClick={() => onTab('settings')}>
      {t('common.edit')}
    </button>
  );

  return (
    <div className="space-y-4">
      <StatStrip>
        <Stat icon={<ClipboardList />} label={t('products.kpi.onSale')} value={sale.length} unit={`/ ${plans.length}`} hint={t('products.kpi.total', { n: plans.length })} />
        <Stat
          icon={<TagIcon />}
          label={t('products.kpi.lowest')}
          value={best ? formatPrice(best.c!.perMonth, currency) : '-'}
          unit={best && best.c!.perMonth > 0 ? t('products.kpi.perMonth') : undefined}
          hint={best ? `${L.billingCycle[best.c!.cycle]} ${formatPrice(best.p.prices[best.c!.cycle]!, currency)}` : t('products.kpi.noPrice')}
        />
        <Stat
          icon={<Cpu />}
          label={t('products.kpi.resources')}
          value={range(plans.map((p) => p.cpu), formatCores)}
          hint={plans.length ? `${range(plans.map((p) => p.memory), formatMemory)} · ${range(plans.map((p) => p.disk), (n) => `${n} GB`)}` : '-'}
        />
        <Stat
          icon={<Waves />}
          label={t('products.kpi.traffic')}
          value={traffic.length ? (traffic.every((x) => x === 0) ? t('common.unlimited') : range(traffic.filter((x) => x > 0), formatTraffic)) : '-'}
          hint={plans.length ? range(plans.map((p) => p.bandwidthOut), formatBandwidth) : '-'}
        />
      </StatStrip>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Panel title={t('products.basic')} extra={edit}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
            <Field label={t('products.colNetwork')}>{product.networkModes.map((m) => t(MODE_LABEL[m])).join(' / ') || '-'}</Field>
            <Field label={t('products.colTypes')}>{L.instanceType[product.type]}</Field>
            <Field label={t('products.multiplier')}>{multiplierRange(product)}</Field>
            <Field label={t('common.region')}>
              {product.regions.length ? (
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {product.regions.map((r) => (
                    <span key={r} className="inline-flex items-center gap-1.5">
                      <CountryFlag code={product.regionCountry[r] ?? ''} />
                      {r}
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-warning-text">{t('products.noNodes')}</span>
              )}
            </Field>
            <Field label={t('products.container')}>
              {[product.nesting && t('products.nesting'), product.privileged && t('products.privileged')].filter(Boolean).join(' · ') || t('products.containerNone')}
            </Field>
            <Field label={t('products.tags')}>
              {product.tags.length ? (
                <span className="flex flex-wrap gap-1">
                  {product.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </span>
              ) : (
                '-'
              )}
            </Field>
            <Field label={t('common.description')} className="col-span-2 md:col-span-3">
              <p className="leading-relaxed whitespace-pre-line text-fg-2">{product.description || '-'}</p>
            </Field>
          </dl>
        </Panel>
        <Panel title={t('products.visibility')} extra={edit}>
          <div className="divide-y divide-line/70">
            <Row label={t('products.onSale')}>
              <StatusDot on={product.enabled}>{product.enabled ? t('products.yes') : t('products.no')}</StatusDot>
            </Row>
            <Row label={t('products.listed')}>
              <StatusDot on={product.listed}>{product.listed ? t('products.yes') : t('products.no')}</StatusDot>
            </Row>
            <Row label={t('products.colInstances')}>
              <span className="tabular">{product.activeInstances}</span>
            </Row>
            <Row label={t('common.sortOrder')}>
              <span className="tabular">{product.sortOrder}</span>
            </Row>
          </div>
        </Panel>
      </div>

      <Panel title={t('products.boundNodes')} extra={<span>{t('products.nodeSelected', { n: product.nodeIds.length })}</span>} flush>
        {product.nodeIds.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-warning-text">{t('products.noNodes')}</p>
        ) : (
          <div className="divide-y divide-line/70">
            {bound.map((n) => (
              <Link
                key={n.id}
                to={`/admin/nodes/${n.id}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-2.5 transition-colors hover:bg-surface-2/60 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_4rem]"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <CountryFlag code={n.country} />
                  <span className="truncate text-[13px] font-medium text-fg">{n.name}</span>
                  <span className={cn('size-1.5 shrink-0 rounded-full', nodeDot[n.status])} title={L.nodeStatus[n.status]} />
                </span>
                <span className="hidden truncate text-xs text-fg-3 sm:block">
                  {n.region} · {t(MODE_LABEL[n.networkMode])}
                </span>
                <span className="hidden truncate text-xs text-fg-3 sm:block">
                  {t('products.rootPool')}: {product.nodeOptions[n.id]?.storagePool ?? `${n.storagePool}`}
                </span>
                <span className="tabular text-right text-xs text-fg-2" title={t('products.multiplier')}>
                  {formatMultiplier(product.nodeOptions[n.id]?.trafficMultiplier ?? 1)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

/** 套餐列表：一行一个套餐，可直接上下架 */
function PlansTab({ product, plans }: { product: AdminProductDTO; plans: AdminPlanDTO[] }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-plans'] });
    void qc.invalidateQueries({ queryKey: ['admin-products'] });
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.patch(`/admin/plans/${id}`, { enabled }),
    onSuccess: refresh,
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/plans/${id}`),
    onSuccess: () => {
      toast.success(t('plans.deleted'));
      refresh();
    },
    onError: (e) => toast.fromError(e),
  });
  const newPlan = `/admin/plans/new?product=${product.id}`;
  const navigateEdit = (p: AdminPlanDTO) => `/admin/plans/${p.id}/edit`;

  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-11 items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h3 className="text-[13px] font-semibold text-fg">
          {t('products.tab.plans')} <span className="tabular font-normal text-fg-4">{plans.length}</span>
        </h3>
        <span className="text-xs text-fg-3">{t('products.plansHint')}</span>
      </div>
      <DataTable
        rows={plans}
        rowKey={(p) => p.id}
        onRowClick={(p) => navigate(navigateEdit(p))}
        empty={
          <Empty
            title={t('products.noPlans')}
            icon={<Package />}
            action={
              <LinkButton variant="primary" size="sm" icon={<Plus />} to={newPlan}>
                {t('plans.create')}
              </LinkButton>
            }
          />
        }
        columns={[
          {
            key: 'name',
            header: t('plans.plan'),
            mobile: 'title',
            cell: (p) => (
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium text-fg">{p.name}</span>
                  {!p.enabled ? <Badge>{t('plans.offSale')}</Badge> : p.stockLeft === 0 ? <Badge tone="warning">{t('products.soldOut')}</Badge> : null}
                </div>
                <div className="max-w-60 truncate text-xs text-fg-3">{p.description || L.instanceType[p.type]}</div>
              </div>
            ),
          },
          {
            key: 'resources',
            header: t('products.plan.resources'),
            cell: (p) => (
              <TwoLine main={`${formatCores(p.cpu)}${p.cpuAllowance ? ` · ${p.cpuAllowance}%` : ''} · ${formatMemory(p.memory)}`} sub={`${t('spec.disk')} ${p.disk} GB`} />
            ),
          },
          {
            key: 'traffic',
            header: t('products.plan.traffic'),
            cell: (p) => (
              <TwoLine
                main={p.traffic > 0 ? formatTraffic(p.traffic) : t('common.unlimited')}
                sub={`${p.bandwidthIn === p.bandwidthOut ? formatBandwidth(p.bandwidthIn) : `${formatBandwidth(p.bandwidthIn)} / ${formatBandwidth(p.bandwidthOut)}`}${p.ipv6Count > 0 ? ` · IPv6 ×${p.ipv6Count}` : ''}`}
              />
            ),
          },
          {
            key: 'quota',
            header: t('products.plan.quota'),
            // 中等宽度下隐藏次要列，避免表格横向滚动
            headerClassName: 'hidden xl:table-cell',
            className: 'hidden xl:table-cell',
            cell: (p) =>
              p.type === 'KVM_IPV4' ? (
                <TwoLine main={t('spec.dedicatedIpv4')} sub={t('products.plan.snapshots', { n: p.snapshotLimit })} />
              ) : (
                <TwoLine main={t('products.plan.ports', { n: p.portLimit })} sub={`${t('products.plan.snapshots', { n: p.snapshotLimit })} · ${t('products.plan.sites', { n: p.siteLimit })}`} />
              ),
          },
          {
            key: 'stock',
            header: t('plans.soldStock'),
            headerClassName: 'hidden 2xl:table-cell',
            className: 'hidden 2xl:table-cell',
            cell: (p) => (
              <span className="tabular text-[13px] whitespace-nowrap">
                {p.activeInstances} <span className="text-fg-4">/ {p.stock ?? '∞'}</span>
              </span>
            ),
          },
          {
            key: 'price',
            header: <span className="block md:text-right">{t('plans.prices')}</span>,
            cell: (p) => {
              const main = p.prices.MONTHLY ? 'MONTHLY' : cheapest(p)?.cycle;
              const others = BILLING_CYCLES.filter((c) => p.prices[c] && c !== main);
              return (
                <div className="md:text-right">
                  <div className="tabular text-[13px] font-semibold whitespace-nowrap text-fg">
                    {main ? formatPrice(p.prices[main]!, currency) : '-'}
                    {main && <span className="ml-0.5 text-xs font-normal text-fg-3">/ {L.billingCycle[main]}</span>}
                  </div>
                  {others.length > 0 && (
                    <div className="tabular truncate text-xs text-fg-3">{others.map((c) => `${L.billingCycle[c]} ${formatPrice(p.prices[c]!, currency)}`).join(' · ')}</div>
                  )}
                </div>
              );
            },
          },
          {
            key: 'actions',
            header: <span className="block text-right">{t('products.onSaleShort')}</span>,
            className: 'w-36',
            mobile: 'actions',
            cell: (p) => (
              // 行本身可点击进入编辑，控件需阻止冒泡
              <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Switch checked={p.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate({ id: p.id, enabled: v })} />
                <LinkButton size="icon-sm" variant="ghost" aria-label={t('common.edit')} title={t('common.edit')} to={navigateEdit(p)} className="ml-1">
                  <Pencil />
                </LinkButton>
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                  onClick={async () => {
                    if (await confirm({ title: t('plans.deleteTitle', { name: p.name }), description: t('plans.deleteDesc'), danger: true })) remove.mutate(p.id);
                  }}
                >
                  <Trash />
                </Button>
              </div>
            ),
          },
        ]}
      />
    </Card>
  );
}

/** 产品管理：概览 / 配置 / 套餐 */
export default function AdminProductDetail() {
  const { t } = useI18n();
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab = (['settings', 'plans'].includes(params.get('tab') ?? '') ? params.get('tab') : 'overview') as Tab;
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === 'overview') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };
  // 后台没有单个产品的接口，从列表中查找（通常已缓存）
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<AdminPlanDTO[]>('/admin/plans') });

  const back = { to: '/admin/plans', label: t('nav.admin.plans') };
  if (products.isLoading || plans.isLoading) return <PageLoading />;
  const error = products.error ?? plans.error;
  if (error) return <ErrorState error={error} onRetry={() => void Promise.all([products.refetch(), plans.refetch()])} />;
  const product = products.data?.find((p) => p.id === id);
  if (!product) {
    return (
      <>
        <PageHeader back={back} title={t('products.notFound')} />
        <Empty title={t('products.notFound')} />
      </>
    );
  }
  const rows = (plans.data ?? []).filter((p) => p.productId === id);

  return (
    <>
      <PageHeader
        back={back}
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <ProductAvatar country={productCountry(product)} name={product.name} size="lg" />
            {product.name}
            <Badge tone={product.enabled ? 'success' : 'neutral'} dot>
              {product.enabled ? t('products.enabled') : t('products.disabled')}
            </Badge>
            {product.listed && <Badge tone="primary">{t('products.listed')}</Badge>}
          </span>
        }
        description={productSubtitle(product) || t('products.detailDesc')}
        actions={
          <>
            <Button icon={<Link2 />} onClick={() => void copyProductLink(product, t)}>
              {t('products.copyLink')}
            </Button>
            <LinkButton variant="primary" icon={<Plus />} to={`/admin/plans/new?product=${product.id}`}>
              {t('plans.create')}
            </LinkButton>
          </>
        }
      />
      <TabBar<Tab>
        value={tab}
        onChange={setTab}
        className="mb-4"
        items={[
          { value: 'overview', label: t('products.tab.overview'), icon: <Info /> },
          { value: 'settings', label: t('products.tab.settings'), icon: <Settings2 /> },
          { value: 'plans', label: t('products.tab.plans'), icon: <Package />, count: rows.length },
        ]}
      />
      <div key={tab} className="panel-enter">
        {tab === 'overview' && <Overview product={product} plans={rows} onTab={setTab} />}
        {tab === 'settings' && <ProductSettings key={product.id} product={product} />}
        {tab === 'plans' && <PlansTab product={product} plans={rows} />}
      </div>
    </>
  );
}

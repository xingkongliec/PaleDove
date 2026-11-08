import { useQuery } from '@tanstack/react-query';
import { Boxes, ChevronRight, Link2, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { formatMultiplier, INSTANCE_TYPES, isVmType, type AdminProductDTO, type InstanceType } from '../../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { Badge, Card, Empty, ErrorState, Tag } from '@/components/ui/misc';
import { DataTable } from '@/components/ui/table';
import { Segmented, TabBar } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/format';
import { toast } from '@/lib/toast';
import { MODE_LABEL } from '../nodes/NodeForm';
import { ProductDialog } from './ProductDialog';
import { ProductAvatar, StatusDot, TwoLine } from './product-ui';

/** 产品副标题：产品标签（地区已由旗帜表示，不再重复） */
export function productSubtitle(p: AdminProductDTO) {
  return p.tags.filter(Boolean).join(' | ');
}

/** 已绑定宿主机的流量倍率范围，如 1x、1x - 2x */
export function multiplierRange(p: AdminProductDTO) {
  const values = p.nodeIds.map((id) => p.nodeOptions[id]?.trafficMultiplier ?? 1);
  if (!values.length) return '-';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? formatMultiplier(lo) : `${formatMultiplier(lo)} - ${formatMultiplier(hi)}`;
}

/** 实例类型：LXC / KVM */
export const productKinds = (p: AdminProductDTO) => [isVmType(p.type) ? 'KVM' : 'LXC'];

/** 产品头像使用的国家：第一个地区 */
export const productCountry = (p: AdminProductDTO) => (p.regions[0] ? p.regionCountry[p.regions[0]] : undefined);

/** 购买页直达该产品的链接 */
export async function copyProductLink(p: AdminProductDTO, t: ReturnType<typeof useI18n>['t']) {
  if (await copyText(`${window.location.origin}/store?product=${p.id}`)) toast.success(t('products.linkCopied'));
}

type Filter = 'all' | 'on' | 'off';
/** 分类：按实例类型，默认全部 */
type Category = 'ALL' | InstanceType;

export default function AdminPlans() {
  const { t, L } = useI18n();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [category, setCategory] = useState<Category>('ALL');
  const all = q.data ?? [];
  const kw = search.trim().toLowerCase();
  // 分类内的产品（状态筛选的计数也按当前分类统计）
  const inCategory = all.filter((p) => category === 'ALL' || p.type === category);
  const rows = inCategory.filter(
    (p) =>
      (filter === 'all' || p.enabled === (filter === 'on')) &&
      (!kw || [p.name, ...p.tags, ...p.regions, ...p.nodeNames].some((s) => s.toLowerCase().includes(kw))),
  );
  const create = (
    <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
      {t('products.create')}
    </Button>
  );

  return (
    <>
      <PageHeader title={t('nav.admin.plans')} description={t('plans.subtitle')} actions={create} />
      <Card className="overflow-hidden">
        {/* 分类：全部 / LXC NAT / KVM NAT / KVM 独立 IPv4（没有产品的类型不显示） */}
        <TabBar<Category>
          value={category}
          onChange={setCategory}
          className="px-3 pt-3"
          items={[
            { value: 'ALL', label: t('products.categoryAll'), count: all.length },
            ...INSTANCE_TYPES.map((type) => ({ value: type, label: L.instanceType[type], count: all.filter((p) => p.type === type).length, hidden: !all.some((p) => p.type === type) })),
          ]}
        />
        <Toolbar
          right={
            <span className="text-xs text-fg-3">
              {t('products.summary', { products: all.length, plans: all.reduce((n, p) => n + p.planCount, 0), instances: all.reduce((n, p) => n + p.activeInstances, 0) })}
            </span>
          }
        >
          <Segmented
            aria-label={t('common.status')}
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: `${t('products.filterAll')} ${inCategory.length}` },
              { value: 'on', label: `${t('products.enabled')} ${inCategory.filter((p) => p.enabled).length}` },
              { value: 'off', label: `${t('products.disabled')} ${inCategory.filter((p) => !p.enabled).length}` },
            ]}
          />
          <label className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-line-strong sm:w-64">
            <Search className="size-3.5 shrink-0 text-fg-4" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('products.search')}
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
            />
          </label>
        </Toolbar>
        {q.error ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <DataTable
            rows={rows}
            loading={q.isLoading}
            rowKey={(p) => p.id}
            onRowClick={(p) => navigate(`/admin/products/${p.id}`)}
            empty={all.length ? <Empty title={t('products.noMatchProducts')} icon={<Search />} /> : <Empty title={t('products.empty')} description={t('products.emptyDesc')} icon={<Boxes />} action={create} />}
            columns={[
              {
                key: 'name',
                header: t('common.name'),
                mobile: 'title',
                cell: (p) => (
                  <div className="flex min-w-0 items-center gap-3">
                    <ProductAvatar country={productCountry(p)} name={p.name} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-fg">{p.name}</span>
                        {p.listed && <Badge tone="primary">{t('products.listed')}</Badge>}
                        {/* 窄屏隐藏了状态列，在名称旁标出已停用 */}
                        {!p.enabled && <Badge className="xl:hidden">{t('products.disabled')}</Badge>}
                      </div>
                      <div className="max-w-56 truncate text-xs text-fg-3 2xl:max-w-72">{productSubtitle(p) || '-'}</div>
                    </div>
                  </div>
                ),
              },
              {
                key: 'status',
                header: t('common.status'),
                headerClassName: 'hidden xl:table-cell',
                className: 'hidden xl:table-cell',
                cell: (p) => <StatusDot on={p.enabled}>{p.enabled ? t('products.enabled') : t('products.disabled')}</StatusDot>,
              },
              {
                key: 'network',
                header: t('products.colTypeNetwork'),
                cell: (p) => {
                  const modes = p.networkModes.map((m) => t(MODE_LABEL[m])).join(' / ');
                  return (
                    <div className="min-w-0 space-y-1">
                      <Tag tone={isVmType(p.type) ? 'primary' : 'success'}>{L.instanceType[p.type]}</Tag>
                      <div className="max-w-44 truncate text-xs text-fg-3" title={modes}>
                        {modes || t('products.noNodes')}
                      </div>
                    </div>
                  );
                },
              },
              {
                key: 'nodes',
                header: t('products.colNodes'),
                cell: (p) =>
                  p.nodeIds.length ? (
                    <TwoLine main={t('products.nodeCount', { n: p.nodeIds.length })} sub={<span className="block max-w-40 truncate font-mono">{p.nodeNames.join(', ')}</span>} />
                  ) : (
                    <span className="text-xs text-warning-text">{t('products.noNodes')}</span>
                  ),
              },
              {
                key: 'multiplier',
                // 中等宽度下隐藏次要列，避免表格横向滚动
                headerClassName: 'hidden xl:table-cell',
                className: 'hidden xl:table-cell',
                header: <span className="block md:text-right">{t('products.multiplier')}</span>,
                cell: (p) => <span className="tabular block text-[13px] text-fg-2 md:text-right">{multiplierRange(p)}</span>,
              },
              {
                key: 'counts',
                header: <span className="block md:text-right">{t('products.colCounts')}</span>,
                cell: (p) => (
                  <span className="tabular block text-[13px] whitespace-nowrap md:text-right">
                    {p.planCount}
                    <span className="text-fg-4"> / </span>
                    {p.activeInstances}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: '',
                className: 'w-24',
                mobile: 'actions',
                cell: (p) => (
                  // 行本身可点击进入管理，按钮需阻止冒泡
                  <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <Button size="icon-sm" variant="ghost" aria-label={t('products.copyLink')} title={t('products.copyLink')} onClick={() => void copyProductLink(p, t)}>
                      <Link2 />
                    </Button>
                    <LinkButton size="icon-sm" variant="ghost" aria-label={t('plans.create')} title={t('plans.create')} to={`/admin/plans/new?product=${p.id}`}>
                      <Plus />
                    </LinkButton>
                    <ChevronRight className="hidden size-4 text-fg-4 md:block" />
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>
      {creating && <ProductDialog onClose={() => setCreating(false)} onSaved={(p) => navigate(`/admin/products/${p.id}?tab=settings`)} />}
    </>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Info, RefreshCw, Search, Store, TriangleAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { InstanceType, MarketListingDTO, MarketSort } from '../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { DataTransition } from '@/components/DataTransition';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, Empty, ErrorState, Skeleton } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/table';
import { useI18n } from '@/i18n';
import { MARKET_PAGE_SIZE as PAGE_SIZE, marketListOptions } from '@/lib/market-query';
import { useMe, usePublicConfig } from '@/lib/queries';
import { BuyDialog } from './BuyDialog';
import { MarketCard } from './MarketCard';
import { MarketPingDialog } from './MarketPing';
import { PriceHistoryDialog } from './PriceHistoryDialog';

/** 下拉框里「全部」的取值（Select 不接受空字符串） */
const ALL = 'ALL';

/** 交易市场：控制台与公开页共用同一个界面（未登录可浏览，购买时引导登录） */
export default function Market() {
  const { t, L } = useI18n();
  const { data: me } = useMe();
  const { data: cfg } = usePublicConfig();
  const [params, setParams] = useSearchParams();
  const [region, setRegion] = useState(ALL);
  const [type, setType] = useState<InstanceType | typeof ALL>(ALL);
  const [sort, setSort] = useState<MarketSort>('NEWEST');
  // ?q= 预填搜索（首页「市场资源」卡片按挂牌编号跳转过来）
  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const [keyword, setKeyword] = useState(() => (params.get('q') ?? '').trim());
  const [page, setPage] = useState(1);
  const [buying, setBuying] = useState<MarketListingDTO | null>(null);
  const [history, setHistory] = useState<MarketListingDTO | null>(null);
  const [pinging, setPinging] = useState<MarketListingDTO | null>(null);

  // 搜索框防抖
  useEffect(() => {
    const id = window.setTimeout(() => {
      setKeyword(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const q = useQuery({
    ...marketListOptions({ region, type, sort, keyword, page }, me?.id ?? 0),
    placeholderData: (prev) => prev,
    enabled: cfg?.marketEnabled !== false,
    // 有商品正在拨测时每 5 秒刷新，拨测完成后卡片自动显示结果
    refetchInterval: (query) => (query.state.data?.items.some((l) => l.ping?.status === 'PENDING') ? 5_000 : false),
  });

  // ?buy=<挂牌ID> 在登录回来后自动打开购买窗口（出售在「我的上架」里进行）
  const buyParam = params.get('buy');
  useEffect(() => {
    if (!buyParam) return;
    const item = q.data?.items.find((l) => l.id === Number(buyParam));
    if (item) {
      setBuying(item);
      setParams((p) => (p.delete('buy'), p), { replace: true });
    } else if (q.data && !q.isFetching) {
      setParams((p) => (p.delete('buy'), p), { replace: true });
    }
  }, [buyParam, q.data, q.isFetching, setParams]);

  const items = q.data?.items ?? [];
  const filtered = !!keyword || region !== ALL || type !== ALL;
  const regionOptions = useMemo(() => [{ value: ALL, label: t('market.allRegions') }, ...(q.data?.regions ?? []).map((r) => ({ value: r, label: r }))], [q.data?.regions, t]);

  if (cfg && !cfg.marketEnabled) {
    return (
      <>
        <PageHeader title={t('market.title')} />
        <Card className="rounded-md">
          <Empty icon={<Store />} title={t('market.closed')} description={t('market.closedDesc')} />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('market.title')} description={t('market.subtitle')} />

      <div className="space-y-4">
        <Card className="rounded-md">
          <Toolbar
            className="border-b-0"
            right={
              <Button size="sm" className="rounded-md" icon={<RefreshCw className={q.isFetching ? 'animate-spin' : ''} />} onClick={() => void q.refetch()}>
                {t('common.refresh')}
              </Button>
            }
          >
            <Select<string> value={region} onChange={(v) => (setRegion(v), setPage(1))} options={regionOptions} className="rounded-md sm:w-44" aria-label={t('common.region')} />
            <Select<string>
              value={type}
              onChange={(v) => (setType(v as InstanceType | typeof ALL), setPage(1))}
              className="rounded-md sm:w-44"
              aria-label={t('common.type')}
              options={[
                { value: ALL, label: t('market.allTypes') },
                { value: 'LXC_NAT', label: L.instanceType.LXC_NAT },
                { value: 'KVM_NAT', label: L.instanceType.KVM_NAT },
                { value: 'KVM_IPV4', label: L.instanceType.KVM_IPV4 },
              ]}
            />
            <Select<MarketSort>
              value={sort}
              onChange={(v) => (setSort(v), setPage(1))}
              className="rounded-md sm:w-40"
              aria-label={t('market.sort')}
              options={[
                { value: 'NEWEST', label: t('market.sort.NEWEST') },
                { value: 'PRICE_ASC', label: t('market.sort.PRICE_ASC') },
                { value: 'PRICE_DESC', label: t('market.sort.PRICE_DESC') },
                { value: 'EXPIRES_DESC', label: t('market.sort.EXPIRES_DESC') },
              ]}
            />
            <div className="relative w-full sm:ml-auto sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('market.search')} className="rounded-md pl-8" />
            </div>
          </Toolbar>
        </Card>

        <div className="flex items-start gap-2.5 rounded-md border border-warning-line bg-warning-soft px-4 py-3 text-[13px] leading-relaxed text-warning-text">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <p>{t('market.warning', { rate: cfg?.marketFeeRate ?? 0 })}</p>
        </div>

        <DataTransition pending={q.isLoading || q.isPlaceholderData} refreshing={q.isFetching}>
        {q.isError && !q.data ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-80 rounded-md" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <Card className="rounded-md">
            <Empty icon={<Store />} title={filtered ? t('market.noMatch') : t('market.empty')} description={filtered ? undefined : t('market.emptyDesc')} />
          </Card>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {items.map((l) => (
                <MarketCard key={l.id} listing={l} onBuy={setBuying} onHistory={setHistory} onPing={setPinging} />
              ))}
            </div>
            <Card className="rounded-md">
              <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
            </Card>
          </>
        )}
        </DataTransition>
        <p className="flex items-start gap-1.5 text-xs text-fg-3">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {t('market.footnote')}
        </p>
      </div>

      {buying && <BuyDialog listing={buying} onClose={() => setBuying(null)} />}
      <PriceHistoryDialog listing={history} onClose={() => setHistory(null)} />
      {pinging && <MarketPingDialog subject={{ id: pinging.id, title: pinging.plan ?? pinging.product?.name ?? `#${pinging.id}`, region: pinging.region, country: pinging.country }} onClose={() => setPinging(null)} />}
    </>
  );
}

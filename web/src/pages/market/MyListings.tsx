import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CircleCheck, FileText, History, PackageOpen, Pencil, Plus, RefreshCw, Search, ShoppingBag, Store, Tag as TagIcon, Trash2, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import type { MarketListingDTO, MarketListingStatus, MarketMineDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Card, Empty, ErrorState, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination, type Column } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { daysLeftText, formatDate, formatMoney } from '@/lib/format';
import { useCurrency, useMe, usePublicConfig } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { MarketPingDialog, PingVerdictTag } from './MarketPing';
import { PriceHistoryDialog } from './PriceHistoryDialog';
import { SaleRecordDialog } from './SaleRecordDialog';
import { SellDialog, feeOf } from './SellDialog';

const PAGE_SIZE = 10;
const ALL = 'ALL';
/** active 正在上架；history 上架历史；bought 我买到的实例 */
type RecordTab = 'active' | 'history' | 'bought';

/** 改价 */
function EditDialog({ listing, onClose }: { listing: MarketMineDTO | null; onClose: () => void }) {
  const { t } = useI18n();
  const currency = useCurrency();
  const { data: cfg } = usePublicConfig();
  const qc = useQueryClient();
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!listing) return;
    setPrice(String(Number(listing.price)));
    setError(null);
  }, [listing]);
  const save = useMutation({
    mutationFn: () => api.patch(`/market/listings/${listing!.id}`, { price }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      for (const key of ['market', 'market-mine']) void qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  const amount = Number(price);
  const fee = amount > 0 ? feeOf(amount, cfg?.marketFeeRate ?? 0) : 0;
  return (
    <Modal
      open={!!listing}
      onOpenChange={(o) => !o && onClose()}
      title={t('market.editTitle')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!(amount > 0)} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('market.price')} required>
          <InputGroup type="number" min={0} step={0.01} prefix={currency} value={price} onChange={(e) => setPrice(e.target.value)} />
        </FormField>
        {amount > 0 && (
          <p className="-mt-2 text-xs text-fg-3">{t('market.feeHint', { rate: cfg?.marketFeeRate ?? 0, fee: formatMoney(fee, currency), income: formatMoney(Math.max(0, amount - fee), currency) })}</p>
        )}
      </div>
    </Modal>
  );
}

/** 顶部三格统计：点击切换到对应的列表 */
function StatCell({ icon, label, value, hint, active, onClick }: { icon: React.ReactNode; label: string; value: string; hint: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-w-0 px-4 py-3 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
        active ? 'bg-surface-2' : 'hover:bg-surface-2/60',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-fg-3 [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="tabular mt-1 truncate text-xl leading-7 font-semibold tracking-tight text-fg">{value}</div>
      <div className="mt-0.5 truncate text-xs text-fg-3">{hint}</div>
    </button>
  );
}

/** 上架记录：正在上架的实例可改价 / 撤销，已成交、已撤销、已下架的保留为历史记录；买到的实例保留成交记录与上架前拨测快照 */
export default function MyListings() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const location = useLocation();
  const { data: me, isLoading: meLoading } = useMe();
  const { data: cfg } = usePublicConfig();
  const [tab, setTab] = useState<RecordTab>('active');
  const [status, setStatus] = useState<MarketListingStatus | typeof ALL>(ALL);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<MarketMineDTO | null>(null);
  const [history, setHistory] = useState<MarketListingDTO | null>(null);
  const [record, setRecord] = useState<MarketMineDTO | null>(null);
  const [pinging, setPinging] = useState<MarketMineDTO | null>(null);
  const [selling, setSelling] = useState(false);
  const [presetId, setPresetId] = useState<number | null>(null);
  const [params, setParams] = useSearchParams();
  const isUser = me?.role === 'USER';
  // ?sell=<实例ID>：从实例列表或实例设置进入，打开出售窗口并预选该实例
  const sellParam = params.get('sell');
  useEffect(() => {
    if (!sellParam || !isUser) return;
    setPresetId(Number(sellParam) || null);
    setSelling(true);
    setParams((p) => (p.delete('sell'), p), { replace: true });
  }, [sellParam, isUser, setParams]);
  const q = useQuery({
    queryKey: ['market-mine'],
    queryFn: () => api.get<MarketMineDTO[]>('/market/mine'),
    enabled: isUser,
    // 刚上架的商品正在拨测时每 5 秒刷新
    refetchInterval: (query) => (query.state.data?.some((l) => l.ping?.status === 'PENDING') ? 5_000 : false),
  });
  const purchases = useQuery({ queryKey: ['market-purchases'], queryFn: () => api.get<MarketMineDTO[]>('/market/purchases'), enabled: isUser });
  const cancel = useMutation({
    mutationFn: (id: number) => api.delete(`/market/listings/${id}`),
    onSuccess: () => {
      toast.success(t('market.canceled'));
      for (const key of ['market', 'market-mine', 'market-sellable', 'instance', 'instances']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  // 拨测未完成的商品重新拨测
  const retry = useMutation({
    mutationFn: (id: number) => api.post(`/market/listings/${id}/ping`),
    onSuccess: () => {
      toast.success(t('market.ping.retried'));
      void qc.invalidateQueries({ queryKey: ['market-mine'] });
    },
    onError: (e) => toast.error(errorText(e)),
  });

  const all = q.data ?? [];
  const bought = purchases.data ?? [];
  const active = useMemo(() => all.filter((l) => l.status === 'ACTIVE'), [all]);
  const past = useMemo(() => all.filter((l) => l.status !== 'ACTIVE'), [all]);
  const sold = useMemo(() => all.filter((l) => l.status === 'SOLD'), [all]);
  const sum = (rows: MarketMineDTO[]) => rows.reduce((n, l) => n + Number(l.income), 0);

  const keyword = search.trim().toLowerCase();
  const rows = useMemo(() => {
    const base = tab === 'bought' ? bought : tab === 'active' ? active : status === ALL ? past : past.filter((l) => l.status === status);
    if (!keyword) return base;
    return base.filter((l) => [l.hostname, l.plan, l.product?.name, l.region, l.buyer, l.target, `#${l.id}`, String(l.id)].some((v) => v?.toLowerCase().includes(keyword)));
  }, [tab, bought, active, past, status, keyword]);
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pick = (next: RecordTab, nextStatus: MarketListingStatus | typeof ALL = ALL) => {
    setTab(next);
    setStatus(nextStatus);
    setPage(1);
  };

  if (meLoading) return null;
  if (!me) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname)}`} replace />;
  if (!isUser) return <Navigate to="/market" replace />;
  if (cfg && !cfg.marketEnabled) {
    return (
      <Card className="rounded-md">
        <Empty icon={<Store />} title={t('market.closed')} description={t('market.closedDesc')} />
      </Card>
    );
  }

  const statusTag = (l: MarketMineDTO) => {
    // 拨测完成后才上架：拨测中 / 拨测未完成
    if (l.status === 'ACTIVE' && !l.published) {
      return l.ping?.status === 'PENDING' ? <Tag tone="primary">{t('market.ping.testing')}</Tag> : <Tag tone="warning">{t('market.ping.unpublished')}</Tag>;
    }
    const tone = l.status === 'ACTIVE' ? 'primary' : l.status === 'SOLD' ? 'success' : l.status === 'REMOVED' ? 'danger' : 'neutral';
    return <Tag tone={tone}>{L.marketStatus[l.status]}</Tag>;
  };
  const columns: Column<MarketMineDTO>[] = [
    {
      key: 'instance',
      header: t('market.col.instance'),
      mobile: 'title',
      cell: (l) => (
        <div className="min-w-0">
          <Link to={`/console/instances/${l.instanceId}`} className="font-medium text-fg hover:underline">
            {l.hostname}
          </Link>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-3">
            <CountryFlag code={l.country} />
            {l.region} · {l.plan ?? L.instanceType[l.type]}
          </div>
          {/* 上架前拨测快照：点击查看详情 */}
          {l.ping && (
            <button type="button" className="mt-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPinging(l)} aria-label={t('market.ping.open')}>
              <PingVerdictTag ping={l.ping} />
            </button>
          )}
        </div>
      ),
    },
    { key: 'status', header: t('common.status'), cell: (l) => <div>{statusTag(l)}</div> },
    {
      key: 'price',
      header: t('market.price'),
      cell: (l) => (
        <div className="tabular">
          <div className="font-medium">{formatMoney(l.price, currency)}</div>
          {tab === 'bought' ? (
            <div className="text-xs text-fg-3">{t('market.bought.paid')}</div>
          ) : (
            <div className="text-xs text-fg-3">{t('market.incomeShort', { income: formatMoney(l.income, currency), fee: formatMoney(l.fee, currency) })}</div>
          )}
        </div>
      ),
    },
    {
      key: 'scope',
      header: t('market.scope'),
      cell: (l) => (
        <div className="text-[13px]">
          {l.targeted ? <Tag tone="warning">{t('market.targetTo', { name: l.target ?? '' })}</Tag> : <Tag>{t('market.scope.PUBLIC')}</Tag>}
        </div>
      ),
    },
    {
      key: 'time',
      header: t('market.col.time'),
      cell: (l) => (
        <div className="tabular text-[13px]">
          {tab === 'bought' && l.soldAt ? (
            <>
              <div>{formatDate(l.soldAt)}</div>
              <div className="text-xs text-fg-3">{t('market.bought.from', { name: l.seller })}</div>
            </>
          ) : l.status === 'SOLD' && l.soldAt ? (
            <>
              <div>{formatDate(l.soldAt)}</div>
              <div className="text-xs text-fg-3">{t('market.soldTo', { name: l.buyer ?? '' })}</div>
            </>
          ) : l.status === 'ACTIVE' ? (
            <>
              <div>{formatDate(l.createdAt)}</div>
              <div className="text-xs text-fg-3">{t('market.expiresIn', { left: daysLeftText(l.expiresAt) })}</div>
            </>
          ) : (
            <>
              <div>{formatDate(l.createdAt)}</div>
              {l.endReason && <div className="max-w-48 truncate text-xs text-fg-3">{l.endReason}</div>}
            </>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cell: (l) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="rounded-md" icon={<History />} aria-label={t('market.history')} onClick={() => setHistory(l)} />
          {l.ping && <Button size="sm" variant="ghost" className="rounded-md" icon={<Activity />} aria-label={t('market.ping.open')} title={t('market.ping.open')} onClick={() => setPinging(l)} />}
          {/* 成交记录：成交时保存的实例信息 */}
          {l.status === 'SOLD' && l.snapshot && (
            <Button size="sm" className="rounded-md" icon={<FileText />} onClick={() => setRecord(l)}>
              {t('market.record.open')}
            </Button>
          )}
          {l.status === 'ACTIVE' && (
            <>
              {!l.published && l.ping?.status !== 'PENDING' && (
                <Button size="sm" className="rounded-md" icon={<RefreshCw />} loading={retry.isPending && retry.variables === l.id} onClick={() => retry.mutate(l.id)}>
                  {t('market.ping.retry')}
                </Button>
              )}
              <Button size="sm" className="rounded-md" icon={<Pencil />} onClick={() => setEditing(l)}>
                {t('market.edit')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                className="rounded-md"
                icon={<Trash2 />}
                loading={cancel.isPending && cancel.variables === l.id}
                onClick={async () => {
                  if (await confirm({ title: t('market.cancelTitle'), description: t('market.cancelDesc', { host: l.hostname }), danger: true })) cancel.mutate(l.id);
                }}
              >
                {t('market.cancel')}
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  // 「我的购买」用购买记录的查询
  const shownQuery = tab === 'bought' ? purchases : q;
  const sell = (
    <Button variant="primary" size="sm" className="rounded-md" icon={<Plus />} onClick={() => (setPresetId(null), setSelling(true))}>
      {t('market.sell')}
    </Button>
  );
  const empty =
    keyword || (tab === 'history' && status !== ALL) ? (
      <Empty icon={<Search />} title={t('market.records.noMatch')} />
    ) : tab === 'bought' ? (
      <Empty icon={<ShoppingBag />} title={t('market.records.emptyBought')} description={t('market.records.emptyBoughtDesc')} />
    ) : tab === 'active' ? (
      <Empty icon={<PackageOpen />} title={t('market.records.emptyActive')} description={t('market.records.emptyActiveDesc')} action={sell} />
    ) : (
      <Empty icon={<PackageOpen />} title={t('market.records.emptyHistory')} description={t('market.records.emptyHistoryDesc')} />
    );

  return (
    <>
      <Card className="overflow-hidden rounded-md">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-3 text-fg-2 [&_svg]:size-4">
            <TagIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-base leading-6 font-semibold text-fg">{t('market.records.title')}</h1>
            <p className="text-xs text-fg-3">{t('market.records.desc')}</p>
          </div>
          <Tag>{t('market.records.count', { n: all.length })}</Tag>
        </div>

        <div className="grid grid-cols-1 divide-y divide-line border-b border-line sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <StatCell icon={<Store />} label={t('market.stat.active')} value={String(active.length)} hint={t('market.stat.activeDesc')} active={tab === 'active'} onClick={() => pick('active')} />
          <StatCell icon={<Wallet />} label={t('market.stat.expected')} value={formatMoney(sum(active), currency)} hint={t('market.stat.expectedDesc')} active={false} onClick={() => pick('active')} />
          <StatCell
            icon={<CircleCheck />}
            label={t('market.stat.sold')}
            value={String(sold.length)}
            hint={t('market.stat.soldDesc', { amount: formatMoney(sum(sold), currency) })}
            active={tab === 'history' && status === 'SOLD'}
            onClick={() => pick('history', 'SOLD')}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <TabBar<RecordTab>
            value={tab}
            onChange={(v) => pick(v)}
            listClassName="border-b-0 pb-0 [&>*]:rounded-md"
            items={[
              { value: 'active', label: t('market.tab.active'), count: active.length },
              { value: 'history', label: t('market.tab.history'), count: past.length },
              { value: 'bought', label: t('market.tab.bought'), count: bought.length },
            ]}
          />
          <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
              <Input value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} placeholder={t('market.records.search')} className="rounded-md pl-8" aria-label={t('market.records.search')} />
            </div>
            {tab === 'history' && (
              <Select<MarketListingStatus | typeof ALL>
                value={status}
                onChange={(v) => (setStatus(v), setPage(1))}
                className="w-40 rounded-md"
                aria-label={t('common.status')}
                options={[
                  { value: ALL, label: t('market.records.allStatus'), description: t('market.records.allStatusDesc') },
                  { value: 'SOLD', label: L.marketStatus.SOLD, description: t('market.statusDesc.SOLD') },
                  { value: 'CANCELED', label: L.marketStatus.CANCELED, description: t('market.statusDesc.CANCELED') },
                  { value: 'REMOVED', label: L.marketStatus.REMOVED, description: t('market.statusDesc.REMOVED') },
                ]}
              />
            )}
            {sell}
          </div>
        </div>

        {shownQuery.isError ? (
          <ErrorState error={shownQuery.error} onRetry={() => void shownQuery.refetch()} />
        ) : (
          <>
            <DataTable columns={tab === 'bought' ? columns.filter((c) => c.key !== 'scope' && c.key !== 'status') : columns} rows={pageRows} loading={shownQuery.isLoading} rowKey={(l) => l.id} empty={empty} />
            {rows.length > PAGE_SIZE && <Pagination page={page} pageSize={PAGE_SIZE} total={rows.length} onChange={setPage} />}
          </>
        )}
      </Card>
      <EditDialog listing={editing} onClose={() => setEditing(null)} />
      <PriceHistoryDialog listing={history} onClose={() => setHistory(null)} />
      <SaleRecordDialog record={record?.snapshot ?? null} listingId={record?.id ?? null} onClose={() => setRecord(null)} />
      <MarketPingDialog subject={pinging && { id: pinging.id, title: pinging.plan ?? pinging.hostname, region: pinging.region, country: pinging.country }} onClose={() => setPinging(null)} />
      <SellDialog open={selling} presetId={presetId} onClose={() => setSelling(false)} />
    </>
  );
}

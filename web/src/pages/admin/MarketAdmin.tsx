import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Ban, FileText, Pencil, Search, Store } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AdminMarketListingDTO, MarketListingStatus, Paginated } from '../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { CountryFlag } from '@/components/country';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Card, Empty, Tag } from '@/components/ui/misc';
import { DataTable, Pagination, type Column } from '@/components/ui/table';
import { Segmented } from '@/components/ui/tabs';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency, usePublicConfig } from '@/lib/queries';
import { MarketPingDialog, PingVerdictTag } from '@/pages/market/MarketPing';
import { SaleRecordDialog } from '@/pages/market/SaleRecordDialog';
import { toast } from '@/lib/toast';

const PAGE_SIZE = 20;

/** 编辑出售中的商品：售价与定向买家（留空为公开出售），可附说明；有变化时卖家收到站内信 */
function EditDialog({ listing, onClose }: { listing: AdminMarketListingDTO | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const currency = useCurrency();
  const { data: cfg } = usePublicConfig();
  const [price, setPrice] = useState('');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setPrice(listing?.price ?? '');
    setTarget(listing?.target ?? '');
    setNote('');
    setError(null);
  }, [listing]);
  const amount = Number(price);
  const rate = cfg?.marketFeeRate ?? 0;
  const fee = Number.isFinite(amount) && amount > 0 ? Math.round(amount * rate) / 100 : 0;
  const save = useMutation({
    mutationFn: () => api.patch<AdminMarketListingDTO>(`/admin/market/${listing!.id}`, { price: price.trim(), target: target.trim(), note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success(t('adminMarket.edited'), t('adminMarket.editedDesc'));
      void qc.invalidateQueries({ queryKey: ['admin-market'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open={!!listing}
      onOpenChange={(o) => !o && onClose()}
      title={t('adminMarket.editTitle', { id: listing?.id ?? '', host: listing?.hostname ?? '' })}
      description={t('adminMarket.editDesc')}
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
        <FormField
          label={t('market.price')}
          description={amount > 0 ? t('adminMarket.editIncome', { fee: formatMoney(fee, currency), income: formatMoney(Math.max(0, amount - fee), currency), rate }) : undefined}
        >
          <InputGroup prefix={currency} inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus />
        </FormField>
        <FormField label={t('adminMarket.target')} description={t('adminMarket.targetHint')}>
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('adminMarket.targetPlaceholder')} />
        </FormField>
        <FormField label={`${t('adminMarket.note')}${t('common.optionalSuffix')}`} description={t('adminMarket.noteHint')}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </FormField>
      </div>
    </Modal>
  );
}

/** 下架挂牌：填写原因，卖家会收到站内信 */
function RemoveDialog({ listing, onClose }: { listing: AdminMarketListingDTO | null; onClose: () => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [listing]);
  const remove = useMutation({
    mutationFn: () => api.post(`/admin/market/${listing!.id}/remove`, { reason: reason.trim() }),
    onSuccess: () => {
      toast.success(t('adminMarket.removed'));
      void qc.invalidateQueries({ queryKey: ['admin-market'] });
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open={!!listing}
      onOpenChange={(o) => !o && onClose()}
      title={t('adminMarket.removeTitle', { host: listing?.hostname ?? '' })}
      description={t('adminMarket.removeDesc')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            {t('adminMarket.remove')}
          </Button>
        </>
      }
    >
      <FormField label={t('adminMarket.reason')} description={t('adminMarket.reasonHint')}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} autoFocus />
      </FormField>
    </Modal>
  );
}

/** 管理后台：交易市场的全部挂牌，可按状态筛选、搜索，并下架违规商品 */
export default function MarketAdmin() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [status, setStatus] = useState<MarketListingStatus | 'ALL'>('ACTIVE');
  const [search, setSearch] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<AdminMarketListingDTO | null>(null);
  const [editing, setEditing] = useState<AdminMarketListingDTO | null>(null);
  const [record, setRecord] = useState<AdminMarketListingDTO | null>(null);
  const [pinging, setPinging] = useState<AdminMarketListingDTO | null>(null);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setKeyword(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const q = useQuery({
    queryKey: ['admin-market', { status, keyword, page }],
    queryFn: () => api.get<Paginated<AdminMarketListingDTO>>('/admin/market', { page, pageSize: PAGE_SIZE, status: status === 'ALL' ? undefined : status, q: keyword || undefined }),
    placeholderData: (prev) => prev,
  });
  const tone = (s: MarketListingStatus) => (s === 'ACTIVE' ? 'primary' : s === 'SOLD' ? 'success' : s === 'REMOVED' ? 'danger' : 'neutral');
  const columns: Column<AdminMarketListingDTO>[] = [
    { key: 'id', header: 'ID', cell: (l) => <span className="tabular text-fg-3">#{l.id}</span>, mobile: 'hide' },
    {
      key: 'instance',
      header: t('market.col.instance'),
      mobile: 'title',
      cell: (l) => (
        <div className="min-w-0">
          <Link to={`/admin/instances/${l.instanceId}`} className="font-medium text-fg hover:underline">
            {l.hostname}
          </Link>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-3">
            <CountryFlag code={l.country} />
            {l.region} · {l.plan ?? L.instanceType[l.type]}
          </div>
          {/* 上架前拨测快照 */}
          {l.ping && (
            <button type="button" className="mt-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setPinging(l)} aria-label={t('market.ping.open')}>
              <PingVerdictTag ping={l.ping} />
            </button>
          )}
        </div>
      ),
    },
    {
      key: 'seller',
      header: t('adminMarket.seller'),
      cell: (l) => (
        <div className="text-[13px]">
          <Link to={`/admin/users?q=${encodeURIComponent(l.sellerName)}`} className="hover:underline">
            {l.sellerName}
          </Link>
          {l.buyer && <div className="text-xs text-fg-3">{t('adminMarket.buyer', { name: l.buyer })}</div>}
        </div>
      ),
    },
    {
      key: 'price',
      header: t('market.price'),
      cell: (l) => (
        <div className="tabular">
          <div className="font-medium">{formatMoney(l.price, currency)}</div>
          <div className="text-xs text-fg-3">{t('adminMarket.fee', { fee: formatMoney(l.fee, currency) })}</div>
        </div>
      ),
    },
    {
      key: 'scope',
      header: t('market.scope'),
      cell: (l) => (
        <div className="flex flex-wrap items-center gap-1.5">
          {l.targeted ? <Tag tone="warning">{t('market.targetTo', { name: l.target ?? '' })}</Tag> : <Tag>{t('market.scope.PUBLIC')}</Tag>}
          <Tag>{l.mode === 'REINSTALL' ? t('market.mode.REINSTALL') : t('market.mode.KEEP')}</Tag>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('common.status'),
      cell: (l) => (
        <div>
          {/* 拨测完成后才上架 */}
          {l.status === 'ACTIVE' && !l.published ? (
            l.ping?.status === 'PENDING' ? <Tag tone="primary">{t('market.ping.testing')}</Tag> : <Tag tone="warning">{t('market.ping.unpublished')}</Tag>
          ) : (
            <Tag tone={tone(l.status)}>{L.marketStatus[l.status]}</Tag>
          )}
        </div>
      ),
    },
    {
      key: 'time',
      header: t('market.col.time'),
      cell: (l) => (
        <div className="tabular text-[13px]">
          <div>{formatDate(l.soldAt ?? l.createdAt)}</div>
          {l.endReason && <div className="max-w-48 truncate text-xs text-fg-3">{l.endReason}</div>}
        </div>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      cell: (l) =>
        l.status === 'ACTIVE' ? (
          <div className="flex justify-end gap-1.5">
            <Button size="sm" icon={<Pencil />} onClick={() => setEditing(l)}>
              {t('common.edit')}
            </Button>
            <Button size="sm" variant="danger" icon={<Ban />} onClick={() => setRemoving(l)}>
              {t('adminMarket.remove')}
            </Button>
          </div>
        ) : (
          <div className="flex justify-end gap-1.5">
            {l.ping && <Button size="sm" variant="ghost" icon={<Activity />} aria-label={t('market.ping.open')} onClick={() => setPinging(l)} />}
            {/* 成交记录：成交时保存的实例信息 */}
            {l.status === 'SOLD' && l.snapshot && (
              <Button size="sm" icon={<FileText />} onClick={() => setRecord(l)}>
                {t('market.record.open')}
              </Button>
            )}
          </div>
        ),
    },
  ];
  return (
    <>
      <PageHeader title={t('adminMarket.title')} description={t('adminMarket.desc')} />
      <Card className="overflow-hidden">
        <Toolbar
          right={
            <div className="relative w-full sm:w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-4" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('adminMarket.search')} className="pl-8" />
            </div>
          }
        >
          <Segmented
            value={status}
            onChange={(v) => (setStatus(v), setPage(1))}
            aria-label={t('common.status')}
            items={[
              { value: 'ACTIVE', label: L.marketStatus.ACTIVE },
              { value: 'SOLD', label: L.marketStatus.SOLD },
              { value: 'CANCELED', label: L.marketStatus.CANCELED },
              { value: 'REMOVED', label: L.marketStatus.REMOVED },
              { value: 'ALL', label: t('common.all') },
            ]}
          />
        </Toolbar>
        <DataTable columns={columns} rows={q.data?.items} loading={q.isLoading} rowKey={(l) => l.id} empty={<Empty icon={<Store />} title={t('adminMarket.empty')} />} />
        <Pagination page={page} pageSize={PAGE_SIZE} total={q.data?.total ?? 0} onChange={setPage} />
      </Card>
      <RemoveDialog listing={removing} onClose={() => setRemoving(null)} />
      <EditDialog listing={editing} onClose={() => setEditing(null)} />
      <SaleRecordDialog record={record?.snapshot ?? null} listingId={record?.id ?? null} onClose={() => setRecord(null)} />
      <MarketPingDialog subject={pinging && { id: pinging.id, title: pinging.plan ?? pinging.hostname, region: pinging.region, country: pinging.country }} onClose={() => setPinging(null)} />
    </>
  );
}

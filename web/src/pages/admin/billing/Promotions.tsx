import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Pencil, Plus, Search, Ticket, TicketPercent, Trash } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { AdminProductDTO, CouponDTO, CouponUsageDTO, Paginated, RedeemCodeDTO } from '../../../shared/index';
import { PageHeader, Toolbar } from '@/components/page';
import { Button, LinkButton } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Badge, Card, CodeBlock, CopyButton, Empty, Switch, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable, Pagination } from '@/components/ui/table';
import { Segmented, TabBar } from '@/components/ui/tabs';
import { useI18n, useT, type TFunction } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

type Tab = 'coupons' | 'codes';

/** 优惠内容：减 20%（最高 ¥10）/ 减 ¥5 */
export function couponText(c: Pick<CouponDTO, 'type' | 'value' | 'maxDiscount'>, currency: string, t: TFunction) {
  if (c.type === 'AMOUNT') return t('coupon.amountOff', { amount: formatMoney(c.value, currency) });
  const off = t('coupon.percentOff', { n: +Number(c.value).toFixed(2) });
  return c.maxDiscount ? t('coupon.percentOffMax', { off, max: formatMoney(c.maxDiscount, currency) }) : off;
}

/** 优惠码的使用记录 */
function UsagesDialog({ coupon, onClose }: { coupon: CouponDTO; onClose: () => void }) {
  const t = useT();
  const currency = useCurrency();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['admin-coupon-usages', coupon.id, page],
    queryFn: () => api.get<Paginated<CouponUsageDTO>>(`/admin/coupons/${coupon.id}/usages`, { page, pageSize: 10 }),
    placeholderData: keepPreviousData,
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={t('coupon.usagesTitle', { code: coupon.code })}>
      <div className="-mx-5 -my-4">
        <DataTable
          rows={list.data?.items}
          loading={list.isLoading}
          rowKey={(u) => u.id}
          empty={<Empty title={t('coupon.noUsages')} />}
          columns={[
            { key: 'user', header: t('common.user'), mobile: 'title', cell: (u) => <span className="font-medium text-fg">{u.user?.username ?? '-'}</span> },
            { key: 'type', header: t('common.type'), cell: (u) => (u.orderType === 'NEW' ? t('common.orderNew') : t('common.orderRenew')) },
            { key: 'amount', header: t('coupon.originalPrice'), cell: (u) => <span className="tabular">{formatMoney(u.amount, currency)}</span> },
            { key: 'discount', header: t('coupon.discount'), cell: (u) => <span className="tabular text-fg">-{formatMoney(u.discount, currency)}</span> },
            { key: 'no', header: t('billing.orderNo'), cell: (u) => <span className="font-mono text-xs text-fg-2">{u.orderNo}</span> },
            { key: 'time', header: t('common.time'), cell: (u) => <span className="tabular text-xs text-fg-2">{formatDate(u.createdAt)}</span> },
          ]}
        />
        {list.data && <Pagination page={page} pageSize={10} total={list.data.total} onChange={setPage} />}
      </div>
    </Modal>
  );
}

/** 优惠码列表 */
function Coupons() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [status, setStatus] = useState<'all' | 'active' | 'disabled'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [usages, setUsages] = useState<CouponDTO | null>(null);
  const q = search.trim();
  const list = useQuery({
    queryKey: ['admin-coupons', status, q, page],
    queryFn: () => api.get<Paginated<CouponDTO>>('/admin/coupons', { status, q: q || undefined, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const reload = () => void qc.invalidateQueries({ queryKey: ['admin-coupons'] });
  const toggle = useMutation({
    mutationFn: (c: CouponDTO) => api.patch(`/admin/coupons/${c.id}`, { enabled: !c.enabled }),
    onSuccess: reload,
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/coupons/${id}`),
    onSuccess: reload,
    onError: (e) => toast.fromError(e),
  });
  const now = Date.now();
  /** 状态：停用 / 未开始 / 已过期 / 已用完 / 可用 */
  const state = (c: CouponDTO): [string, 'neutral' | 'success' | 'warning'] => {
    if (!c.enabled) return [t('coupon.state.disabled'), 'neutral'];
    if (c.startsAt && new Date(c.startsAt).getTime() > now) return [t('coupon.state.pending'), 'warning'];
    if (c.expiresAt && new Date(c.expiresAt).getTime() <= now) return [t('coupon.state.expired'), 'neutral'];
    if (c.maxUses !== null && c.usedCount >= c.maxUses) return [t('coupon.state.exhausted'), 'neutral'];
    return [t('coupon.state.active'), 'success'];
  };
  const productNames = (ids: number[]) => ids.map((id) => products.data?.find((p) => p.id === id)?.name ?? `#${id}`).join('、');

  return (
    <Card className="overflow-hidden">
      <Toolbar
        right={
          <LinkButton variant="primary" size="sm" icon={<Plus />} to="/admin/promotions/coupons/new">
            {t('coupon.add')}
          </LinkButton>
        }
      >
        <Segmented
          aria-label={t('common.status')}
          value={status}
          onChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
          items={[
            { value: 'all' as const, label: t('common.all') },
            { value: 'active' as const, label: t('common.enabled') },
            { value: 'disabled' as const, label: t('common.disabled') },
          ]}
        />
        <label className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-surface px-2.5 focus-within:border-line-strong sm:w-56">
          <Search className="size-3.5 shrink-0 text-fg-4" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder={t('coupon.search')}
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
          />
        </label>
      </Toolbar>
      <DataTable
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(c) => c.id}
        empty={<Empty title={t('coupon.empty')} icon={<TicketPercent />} />}
        columns={[
          {
            key: 'code',
            header: t('coupon.code'),
            mobile: 'title',
            cell: (c) => (
              <div className="min-w-0">
                <span className="inline-flex items-center gap-1 font-mono text-[13px] font-medium text-fg">
                  {c.code}
                  <CopyButton value={c.code} />
                </span>
                {(c.name || c.remark) && <div className="max-w-48 truncate text-xs text-fg-3">{c.name || c.remark}</div>}
              </div>
            ),
          },
          {
            key: 'offer',
            header: t('coupon.offer'),
            cell: (c) => (
              <div className="text-[13px]">
                <div className="text-fg">{couponText(c, currency, t)}</div>
                {c.minAmount && <div className="text-xs text-fg-3">{t('coupon.minAmountShort', { amount: formatMoney(c.minAmount, currency) })}</div>}
              </div>
            ),
          },
          {
            key: 'scope',
            header: t('coupon.applies'),
            cell: (c) => (
              <div className="max-w-56 text-[13px]">
                <div className="flex flex-wrap items-center gap-1 text-fg-2">
                  {t(`coupon.scope.${c.scope}`)}
                  {c.mode === 'RECURRING' && <Tag>{t('coupon.mode.RECURRING')}</Tag>}
                  {c.newUserOnly && <Tag>{t('coupon.newUserOnly')}</Tag>}
                </div>
                <div className="truncate text-xs text-fg-3">
                  {[c.productIds ? productNames(c.productIds) : null, c.planIds ? t('coupon.planCount', { n: c.planIds.length }) : null, c.cycles ? c.cycles.map((x) => L.billingCycle[x]).join('、') : null].filter(Boolean).join(' · ') || t('coupon.noLimit')}
                </div>
              </div>
            ),
          },
          {
            key: 'used',
            header: t('coupon.used'),
            cell: (c) => (
              <div className="tabular text-[13px]">
                <div className="text-fg">
                  {c.usedCount} / {c.maxUses ?? '∞'}
                </div>
                <div className="text-xs text-fg-3">{c.perUser ? t('coupon.perUserShort', { n: c.perUser }) : t('coupon.perUserUnlimited')}</div>
              </div>
            ),
          },
          { key: 'total', header: t('coupon.totalDiscount'), cell: (c) => <span className="tabular text-[13px]">{formatMoney(c.totalDiscount, currency)}</span> },
          {
            key: 'time',
            header: t('coupon.validity'),
            cell: (c) => (
              <span className="tabular text-xs text-fg-2">
                {c.startsAt || c.expiresAt ? `${c.startsAt ? formatDate(c.startsAt) : '—'} ~ ${c.expiresAt ? formatDate(c.expiresAt) : '—'}` : t('coupon.forever')}
              </span>
            ),
          },
          {
            key: 'state',
            header: t('common.status'),
            cell: (c) => {
              const [label, tone] = state(c);
              return <Badge tone={tone}>{label}</Badge>;
            },
          },
          {
            key: 'actions',
            header: '',
            className: 'w-36',
            cell: (c) => (
              <div className="flex items-center justify-end gap-1">
                <Switch checked={c.enabled} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(c)} aria-label={t('common.enable')} />
                <Button size="icon-sm" variant="ghost" aria-label={t('coupon.usages')} title={t('coupon.usages')} onClick={() => setUsages(c)}>
                  <History />
                </Button>
                <LinkButton size="icon-sm" variant="ghost" aria-label={t('common.edit')} title={t('common.edit')} to={`/admin/promotions/coupons/${c.id}`}>
                  <Pencil />
                </LinkButton>
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                  disabled={c.usedCount > 0}
                  onClick={async () => {
                    if (await confirm({ title: t('coupon.deleteTitle', { code: c.code }), danger: true })) remove.mutate(c.id);
                  }}
                >
                  <Trash />
                </Button>
              </div>
            ),
          },
        ]}
      />
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
      {usages && <UsagesDialog coupon={usages} onClose={() => setUsages(null)} />}
    </Card>
  );
}

export default function AdminPromotions() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'codes' ? 'codes' : 'coupons';
  return (
    <>
      <PageHeader title={t('nav.admin.promotions')} description={t('promotions.subtitle')} />
      <TabBar<Tab>
        value={tab}
        onChange={(v) => setParams(v === 'coupons' ? {} : { tab: v }, { replace: true })}
        className="mb-4"
        items={[
          { value: 'coupons', label: t('promotions.coupons'), icon: <TicketPercent /> },
          { value: 'codes', label: t('finance.codes'), icon: <Ticket /> },
        ]}
      />
      <div key={tab} className="panel-enter">
        {tab === 'coupons' ? (
          <Coupons />
        ) : (
          <Card className="overflow-hidden">
            <Codes />
          </Card>
        )}
      </div>
    </>
  );
}

/** 兑换码有效期选项（天），0 为长期有效 */
const VALIDITY_DAYS = [7, 30, 90, 180, 365, 0] as const;

/** 金额单位：人民币写“元”，其他货币用符号 */
const currencyUnit = (currency: string, t: TFunction) => (currency === '¥' ? t('redeemForm.yuan') : currency);

/** 生成兑换码 */
function RedeemDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (codes: string[]) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const currency = useCurrency();
  const [f, setF] = useState({ amount: '10', count: '10', maxUses: '1', days: '90', remark: '' });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const count = Number(f.count) || 0;
  const expiryOf = (days: number) => (days ? new Date(Date.now() + days * 86_400_000) : null);
  const create = useMutation({
    mutationFn: () => {
      const exp = expiryOf(Number(f.days));
      return api.post<{ codes: string[] }>('/admin/redeem-codes', { amount: f.amount, count, maxUses: Number(f.maxUses) || 1, expiresAt: exp ? exp.toISOString() : null, remark: f.remark.trim() || undefined });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['admin-codes'] });
      onCreated(r.codes);
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={t('finance.generate')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={create.isPending} disabled={!Number(f.amount) || count < 1} onClick={() => create.mutate()}>
            {t('redeemForm.submit', { n: count })}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (Number(f.amount) && count >= 1) create.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label={t('finance.faceValue')} required>
            <InputGroup type="number" min={0.01} step="0.01" suffix={currencyUnit(currency, t)} value={f.amount} onChange={set('amount')} inputMode="decimal" />
          </FormField>
          <FormField label={t('finance.count')}>
            <InputGroup type="number" min={1} max={500} suffix={t('redeemForm.pcs')} value={f.count} onChange={set('count')} />
          </FormField>
          <FormField label={t('redeemForm.maxUses')} description={t('redeemForm.maxUsesHint')}>
            <InputGroup type="number" min={1} suffix={t('redeemForm.times')} value={f.maxUses} onChange={set('maxUses')} />
          </FormField>
        </div>
        <FormField label={t('redeemForm.validity')}>
          <Select
            value={f.days}
            onChange={(v) => setF({ ...f, days: v })}
            options={VALIDITY_DAYS.map((d) => {
              const exp = expiryOf(d);
              return {
                value: String(d),
                label: d ? (d === 365 ? t('redeemForm.oneYear') : t('redeemForm.days', { n: d })) : t('finance.noExpiry'),
                description: exp ? t('redeemForm.until', { date: formatDate(exp.toISOString(), 'YYYY-MM-DD') }) : t('redeemForm.foreverDesc'),
              };
            })}
          />
        </FormField>
        <FormField label={t('common.remark')}>
          <Input value={f.remark} onChange={set('remark')} placeholder={t('redeemForm.remarkPlaceholder')} maxLength={100} />
        </FormField>
      </form>
    </Modal>
  );
}

/** 兑换码 */
function Codes() {
  const t = useT();
  const currency = useCurrency();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [used, setUsed] = useState<'all' | 'used' | 'unused'>('unused');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string[] | null>(null);
  const list = useQuery({
    queryKey: ['admin-codes', used, page],
    queryFn: () => api.get<Paginated<RedeemCodeDTO>>('/admin/redeem-codes', { used, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/redeem-codes/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin-codes'] }),
    onError: (e) => toast.fromError(e),
  });
  return (
    <>
      <Toolbar
        right={
          <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setCreating(true)}>
            {t('finance.generate')}
          </Button>
        }
      >
        <Segmented
          value={used}
          onChange={(v) => {
            setUsed(v);
            setPage(1);
          }}
          items={[
            { value: 'unused', label: t('redeemForm.available') },
            { value: 'used', label: t('redeemForm.usedUp') },
            { value: 'all', label: t('common.all') },
          ]}
        />
      </Toolbar>
      <DataTable
        rows={list.data?.items}
        loading={list.isLoading}
        rowKey={(c) => c.id}
        empty={<Empty title={t('finance.noCodes')} icon={<Ticket />} />}
        columns={[
          {
            key: 'code',
            header: t('finance.code'),
            mobile: 'title',
            cell: (c) => (
              <span className="inline-flex items-center gap-1 font-mono text-xs text-fg">
                {c.code}
                <CopyButton value={c.code} />
              </span>
            ),
          },
          { key: 'amount', header: t('finance.faceValue'), cell: (c) => <span className="tabular font-medium">{formatMoney(c.amount, currency)}</span> },
          {
            key: 'used',
            header: t('redeemForm.redeemed'),
            cell: (c) => (
              <div className="tabular text-[13px]">
                <span className={c.usedCount >= c.maxUses ? 'text-fg-3' : 'text-fg'}>
                  {c.usedCount} / {c.maxUses}
                </span>
                {c.usedBy && (
                  <div className="text-xs text-fg-3">{t('redeemForm.lastBy', { user: c.usedBy.username, time: formatDate(c.usedAt, 'MM-DD HH:mm') })}</div>
                )}
              </div>
            ),
          },
          { key: 'exp', header: t('common.expiresAt'), cell: (c) => <span className="tabular text-xs">{c.expiresAt ? formatDate(c.expiresAt) : t('finance.noExpiry')}</span> },
          { key: 'remark', header: t('common.remark'), cell: (c) => <span className="text-xs text-fg-2">{c.remark || '—'}</span> },
          {
            key: 'actions',
            header: '',
            className: 'w-12',
            cell: (c) =>
              c.usedCount === 0 && (
                <Button
                  size="icon-sm"
                  variant="danger-ghost"
                  aria-label={t('common.delete')}
                  onClick={async () => {
                    if (await confirm({ title: t('finance.deleteCode'), danger: true })) remove.mutate(c.id);
                  }}
                >
                  <Trash />
                </Button>
              ),
          },
        ]}
      />
      {list.data && <Pagination page={page} pageSize={20} total={list.data.total} onChange={setPage} />}
      {creating && (
        <RedeemDialog
          onClose={() => setCreating(false)}
          onCreated={(codes) => {
            setCreating(false);
            setCreated(codes);
          }}
        />
      )}
      <Modal
        open={!!created}
        onOpenChange={(o) => !o && setCreated(null)}
        title={t('finance.generated', { n: created?.length ?? 0 })}
        footer={
          <>
            <CopyButton value={(created ?? []).join('\n')} label={t('common.copy')} />
            <Button variant="primary" onClick={() => setCreated(null)}>
              {t('common.done')}
            </Button>
          </>
        }
      >
        <CodeBlock value={(created ?? []).join('\n')} className="max-h-72 overflow-auto" />
      </Modal>
    </>
  );
}

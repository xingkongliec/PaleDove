import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CreditCard, Gift, HandCoins, LoaderCircle, Plus, Receipt, Wallet, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import QRCode from 'qrcode';
import { ZERO_DECIMAL_CURRENCIES, type BalanceLogDTO, type CreatePaymentResultDTO, type OrderDTO, type Paginated, type PayActionDTO, type PaymentDTO, type PayOptionDTO, type PayOptionsDTO } from '../../../shared/index';
import { AmountText } from '@/components/billing/AmountText';
import { PageHeader } from '@/components/page';
import { PaymentStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { Input, InputGroup } from '@/components/ui/input';
import { Alert, Badge, Card, Empty, Tag } from '@/components/ui/misc';
import { DataTable, Pagination } from '@/components/ui/table';
import { TabBar } from '@/components/ui/tabs';
import { useI18n, useT } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency, useMe } from '@/lib/queries';
import { toast } from '@/lib/toast';
import { Stat, StatStrip } from '@/pages/admin/catalog/product-ui';
import type { BillingSummary } from '../Dashboard';

/** 订单金额：实付，用了优惠码时下方注明减免与优惠码 */
export function OrderAmount({ order, currency }: { order: OrderDTO; currency: string }) {
  const { t } = useI18n();
  const original = Number(order.amount) + Number(order.discount);
  return (
    <span className="block min-w-[7rem] tabular leading-tight">
      <span className="block font-semibold text-fg">{formatMoney(order.amount, currency)}</span>
      {Number(order.discount) > 0 && (
        <span className="mt-0.5 block text-[11px] text-fg-3">
          {t('coupon.originalPrice')} {formatMoney(original, currency)} · {t('coupon.discount')} {formatMoney(order.discount, currency)}
        </span>
      )}
      {order.couponCode && Number(order.discount) > 0 && (
        <span className="mt-0.5 block max-w-[10rem] truncate text-[11px] text-success-text" title={order.couponCode}>
          {t('coupon.code')}: {order.couponCode}
        </span>
      )}
    </span>
  );
}

/** 订单内容：第一行实例主机名，第二行产品 · 套餐 · 类型；没有关联信息时显示订单说明 */
export function OrderContent({ order }: { order: OrderDTO }) {
  const { L } = useI18n();
  const sub = [order.plan?.product, order.plan?.name, order.instance && L.instanceType[order.instance.type]].filter(Boolean).join(' · ');
  if (!order.instance && !sub) return <span className="text-[13px] text-fg">{order.description ?? '—'}</span>;
  return (
    <span className="block min-w-0 leading-tight">
      <span className="block truncate font-mono text-[13px] font-medium text-fg">{order.instance?.hostname ?? order.description}</span>
      {sub && <span className="mt-0.5 block truncate text-xs text-fg-3">{sub}</span>}
    </span>
  );
}

/**
 * 余额明细说明：关联到订单时第一行是实例主机名与产品 / 套餐，第二行是计费周期与订单号；
 * 其他记录第一行是说明，订单号 / 支付单号放在第二行
 */
export function LogDescription({ log }: { log: BalanceLogDTO }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const o = log.order;
  const refText = log.ref && (
    <>
      {log.type === 'RECHARGE' ? t('billing.refPayment') : t('billing.refOrder')} <span className="font-mono">{log.ref}</span>
    </>
  );
  if (o?.hostname) {
    return (
      <span className="block min-w-0 leading-tight">
        <span className="block truncate text-[13px] text-fg">
          <span className="font-mono font-medium">{o.hostname}</span>
          {o.plan && <span className="text-fg-3"> · {o.plan}</span>}
        </span>
        <span className="mt-0.5 block truncate text-xs text-fg-3">
          {[o.type && L.instanceType[o.type], L.billingCycle[o.cycle]].filter(Boolean).join(' · ')}
          {Number(o.discount) > 0 && <span className="text-success-text"> · {t('coupon.orderDiscount', { amount: formatMoney(o.discount, currency), code: o.couponCode ?? '' })}</span>}
          {refText && <> · {refText}</>}
        </span>
      </span>
    );
  }
  return (
    <span className="block min-w-0 leading-tight">
      <span className="block truncate text-[13px] text-fg" title={log.description ?? undefined}>
        {log.description || '—'}
      </span>
      {refText && <span className="mt-0.5 block truncate text-xs text-fg-3">{refText}</span>}
    </span>
  );
}

const PRESETS = [10, 50, 100, 200, 500, 1000];

const keyOf = (o: PayOptionDTO) => `${o.channelId}:${o.method}`;
/** 向上取到 digits 位小数（与服务端 ROUND_UP 一致，减去误差避免 0.1 + 0.2 这类浮点数多进一位） */
const ceilTo = (v: number, digits = 2) => Math.ceil(v * 10 ** digits - 1e-9) / 10 ** digits;
const feeOf = (o: PayOptionDTO, amount: number) => ceilTo((amount * o.feePercent) / 100 + o.feeFixed);

/** 选项按钮：选中为实心底色 */
const optionClass = (active: boolean) =>
  cn(
    'tabular h-9 rounded-md border text-[13px] transition-[background-color,border-color,color,scale] duration-150 active:scale-[0.98]',
    active ? 'border-primary bg-primary font-medium text-primary-fg' : 'border-line hover:border-line-strong hover:bg-surface-2',
  );

/** 提交支付网关要求的表单（易支付 v2 页面跳转） */
function submitForm(action: string, fields: Record<string, string>) {
  if (!/^https?:\/\//i.test(action)) throw new Error('invalid gateway url');
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = action;
  for (const [k, v] of Object.entries(fields)) {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.name = k;
    input.value = v;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function QrCanvas({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void QRCode.toCanvas(ref.current, text, { width: 220, margin: 1 });
  }, [text]);
  return <canvas ref={ref} className="mx-auto rounded bg-white" />;
}

/** 在线充值：金额（预设 / 自定义）、支付方式（每个渠道各自的金额范围和手续费） */
function TopUpDialog({ open, onOpenChange, payment }: { open: boolean; onOpenChange: (o: boolean) => void; payment: PayOptionsDTO | undefined }) {
  const t = useT();
  const currency = useCurrency();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const options = useMemo(() => payment?.options ?? [], [payment]);
  // 预设金额：任一支付方式能用就显示
  const presets = useMemo(() => PRESETS.filter((v) => options.some((o) => v >= o.minAmount && (!o.maxAmount || v <= o.maxAmount))), [options]);
  const [preset, setPreset] = useState<number | 'custom'>(50);
  const [custom, setCustom] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 接口下单返回二维码 / 页面时，在弹窗里展示，并可点“我已完成支付”查询结果
  const [pending, setPending] = useState<{ no: string; qr?: string; html?: string } | null>(null);
  const money = (v: number | string) => formatMoney(v, currency);
  const rangeText = (lo: number, hi: number) => (hi > 0 ? `${money(lo)} - ${money(hi)}` : t('billing.rangeFrom', { min: money(lo) }));

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPending(null);
    setPreset(presets.includes(50) ? 50 : (presets[0] ?? 'custom'));
    setCustom('');
    setSelected((cur) => (cur && options.some((o) => keyOf(o) === cur) ? cur : options[0] ? keyOf(options[0]) : null));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const option = options.find((o) => keyOf(o) === selected) ?? null;
  const min = option?.minAmount ?? 1;
  const max = option?.maxAmount ?? 0;
  const amount = preset === 'custom' ? Math.round(Number(custom) * 100) / 100 : preset;
  const entered = preset !== 'custom' || !!custom;
  const amountOk = Number.isFinite(amount) && amount > 0 && amount >= min && (!max || amount <= max);
  const fee = option && amountOk ? feeOf(option, amount) : 0;
  // 外币渠道：人民币应付金额 × 实时汇率，向上取到最小单位（Stripe 的日元等无小数位货币按整数）
  const foreign = option && option.currency !== 'CNY' ? option : null;
  const digits = foreign && foreign.method === 'stripe' && ZERO_DECIMAL_CURRENCIES.includes(foreign.currency) ? 0 : 2;
  const charge = foreign?.rate && amountOk ? `${ceilTo((amount + fee) * foreign.rate, digits).toFixed(digits)} ${foreign.currency}` : null;

  const run = (a: PayActionDTO, no: string) => {
    // 只跳转到网页或支付 App 的地址，拒绝 javascript: / data: 这类会在本站执行的地址
    if (a.kind === 'redirect') {
      if (/^\s*(javascript|data|vbscript|blob|file):/i.test(a.url)) throw new Error(t('billing.unsafeUrl'));
      window.location.href = a.url;
    } else if (a.kind === 'form') submitForm(a.action, a.fields);
    else setPending({ no, qr: a.kind === 'qrcode' ? a.content : undefined, html: a.kind === 'html' ? a.html : undefined });
  };
  const create = useMutation({
    mutationFn: () =>
      api.post<CreatePaymentResultDTO>('/payments', {
        amount,
        channelId: option!.channelId,
        method: option!.method,
        device: /Mobile|Android|iPhone/i.test(navigator.userAgent) ? 'mobile' : 'pc',
      }),
    onSuccess: (r) => {
      try {
        run(r.action, r.no);
      } catch (e) {
        setError(errorText(e));
      }
    },
    onError: (e) => setError(errorText(e)),
  });
  const check = useMutation({
    mutationFn: (no: string) => api.get<PaymentDTO>(`/payments/${no}`),
    onSuccess: (p) => {
      if (p.status === 'PAID') {
        toast.success(t('billing.result.paid', { amount: money(p.amount) }));
        setPending(null);
        onOpenChange(false);
        void qc.invalidateQueries({ queryKey: ['me'] });
        void qc.invalidateQueries({ queryKey: ['billing-logs'] });
        void qc.invalidateQueries({ queryKey: ['payments'] });
      } else toast.info(t('billing.notPaidYet'));
    },
    onError: (e) => toast.fromError(e),
  });

  if (pending) {
    return (
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={t('billing.scanTitle')}
        footer={
          <>
            <Button onClick={() => setPending(null)}>{t('billing.back')}</Button>
            <Button variant="primary" loading={check.isPending} onClick={() => check.mutate(pending.no)}>
              {t('billing.iHavePaid')}
            </Button>
          </>
        }
      >
        {pending.qr && (
          <div className="space-y-3 text-center">
            <QrCanvas text={pending.qr} />
            <div className="text-[13px] text-fg-3">{t('billing.scanHint')}</div>
          </div>
        )}
        {/* 支付网关返回的页面放进沙箱：不允许同源，脚本拿不到本站的接口和数据 */}
        {pending.html && (
          <iframe
            title={t('billing.scanTitle')}
            srcDoc={pending.html}
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
            className="h-96 w-full rounded border border-line bg-white"
          />
        )}
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('billing.topUp')}
      footer={
        payment?.enabled ? (
          <>
            <div className="mr-auto self-center text-[13px] text-fg-2">
              {t('billing.payable')} <span className="tabular text-base font-semibold text-fg">{amountOk ? money(amount + fee) : '—'}</span>
              {charge && (
                <span className="ml-1.5 text-xs" translate="no">
                  ≈ {charge}
                </span>
              )}
              {amountOk && fee > 0 && <div className="text-xs">{t('billing.feeIncluded', { fee: money(fee), amount: money(amount) })}</div>}
            </div>
            <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={!option || !amountOk}
              onClick={() => {
                setError(null);
                create.mutate();
              }}
            >
              {t('billing.goPay')}
            </Button>
          </>
        ) : undefined
      }
    >
      {!payment?.enabled ? (
        <Empty icon={<CreditCard />} title={payment ? t('billing.noOnline') : t('common.loading')} description={t('billing.noOnlineDesc')} />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-[13px]">
            <span className="text-fg-2">{t('billing.currentBalanceLabel')}</span>
            <span className={cn('tabular font-medium', Number(me?.balance) < 0 && 'text-danger-text')}>{money(me?.balance ?? 0)}</span>
          </div>

          <div>
            <div className="mb-1.5 text-[13px] text-fg-2">{t('billing.amount')}</div>
            <div className="grid grid-cols-3 gap-2">
              {presets.map((v) => (
                <button key={v} type="button" onClick={() => setPreset(v)} className={optionClass(preset === v)}>
                  {money(v).replace(/\.00$/, '')}
                </button>
              ))}
            </div>
            <div className="mt-2">
              <InputGroup
                prefix={currency}
                value={custom}
                inputMode="decimal"
                className={preset === 'custom' ? 'border-primary' : undefined}
                onFocus={() => setPreset('custom')}
                onChange={(e) => {
                  setPreset('custom');
                  setCustom(e.target.value.replace(/[^\d.]/g, '').replace(/^(\d*\.\d{0,2}).*$/, '$1'));
                }}
                placeholder={t('billing.customAmountRange2', { range: rangeText(min, max) })}
                aria-label={t('billing.customAmount')}
              />
            </div>
            {entered && !amountOk && option && <div className="mt-1 text-xs text-danger-text">{t('billing.rangeError', { method: option.label, range: rangeText(min, max) })}</div>}
          </div>

          <div>
            <div className="mb-1.5 text-[13px] text-fg-2">{t('billing.method')}</div>
            <div className="grid grid-cols-2 gap-2">
              {options.map((o) => (
                <button key={keyOf(o)} type="button" onClick={() => setSelected(keyOf(o))} className={cn(optionClass(selected === keyOf(o)), 'truncate px-2')}>
                  {o.label}
                </button>
              ))}
            </div>
            {option && (option.feePercent > 0 || option.feeFixed > 0 || foreign) && (
              <div className="mt-1.5 space-y-0.5 text-xs text-fg-3">
                {(option.feePercent > 0 || option.feeFixed > 0) && (
                  <div>{t('billing.feeRule', { fee: [option.feePercent > 0 && `${option.feePercent}%`, option.feeFixed > 0 && money(option.feeFixed)].filter(Boolean).join(' + ') })}</div>
                )}
                {foreign && <div>{t('billing.fxRule', { currency: foreign.currency })}</div>}
              </div>
            )}
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

function RedeemDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const t = useT();
  const currency = useCurrency();
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCode('');
      setError(null);
    }
  }, [open]);
  const redeem = useMutation({
    mutationFn: () => api.post<{ balance: string }>('/billing/redeem', { code }),
    onSuccess: (r) => {
      toast.success(t('billing.redeemSuccess'), t('billing.currentBalance', { balance: formatMoney(r.balance, currency) }));
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['billing-logs'] });
      void qc.invalidateQueries({ queryKey: ['billing-summary'] });
      onOpenChange(false);
    },
    onError: (e) => setError(errorText(e)),
  });
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title={t('billing.redeem')}
      description={t('billing.redeemDesc')}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={redeem.isPending}
            disabled={code.trim().length < 4}
            onClick={() => {
              setError(null);
              redeem.mutate();
            }}
          >
            {t('billing.redeemButton')}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim().length >= 4) redeem.mutate();
        }}
      >
        <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX" className="font-mono" aria-label={t('billing.redeem')} autoFocus />
        {error && <p className="mt-2 text-xs text-danger-text">{error}</p>}
      </form>
    </Modal>
  );
}

/** 从支付页返回后轮询订单状态 */
function PaymentResult({ no, canceled, onDismiss }: { no: string; canceled: boolean; onDismiss: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const currency = useCurrency();
  const [started] = useState(() => Date.now());
  const q = useQuery({
    queryKey: ['payment', no],
    queryFn: () => api.get<PaymentDTO>(`/payments/${no}`),
    refetchInterval: (query) => (query.state.data?.status === 'PENDING' && Date.now() - started < 5 * 60_000 ? 3000 : false),
  });
  const status = q.data?.status;
  useEffect(() => {
    if (status === 'PAID') {
      void qc.invalidateQueries({ queryKey: ['me'] });
      void qc.invalidateQueries({ queryKey: ['billing-logs'] });
      void qc.invalidateQueries({ queryKey: ['payments'] });
    }
  }, [status, qc]);
  const close = (
    <button onClick={onDismiss} aria-label={t('common.close')} className="rounded-md p-1 opacity-70 hover:opacity-100">
      <X className="size-4" />
    </button>
  );
  if (q.error) return <Alert tone="danger" title={errorText(q.error)} action={close} className="mb-5" />;
  if (!q.data) return null;
  const p = q.data;
  if (p.status === 'PAID')
    return <Alert tone="success" title={t('billing.result.paid', { amount: formatMoney(p.amount, currency) })} action={close} className="mb-5">{t('billing.result.no', { no: p.no })}</Alert>;
  if (p.status === 'FAILED' || p.status === 'EXPIRED')
    return <Alert tone="danger" title={t('billing.result.failed')} action={close} className="mb-5">{t('billing.result.no', { no: p.no })}</Alert>;
  if (canceled)
    return <Alert tone="neutral" title={t('billing.result.canceled')} action={close} className="mb-5">{t('billing.result.no', { no: p.no })}</Alert>;
  return (
    <Alert tone="primary" title={t('billing.result.pending')} action={<LoaderCircle className="size-4 animate-spin" />} className="mb-5">
      {t('billing.result.pendingDesc')}
    </Alert>
  );
}

function Logs() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['billing-logs', page],
    queryFn: () => api.get<Paginated<BalanceLogDTO>>('/billing/logs', { page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        rowKey={(l) => l.id}
        empty={<Empty title={t('billing.noLogs')} />}
        columns={[
          { key: 'desc', header: t('common.description'), mobile: 'title', cell: (l) => <LogDescription log={l} /> },
          { key: 'type', header: t('common.type'), cell: (l) => <Tag>{L.balanceLogType[l.type]}</Tag> },
          { key: 'amount', header: t('common.amount'), mobile: 'actions', cell: (l) => <AmountText amount={l.amount} currency={currency} /> },
          { key: 'after', header: t('common.balance'), mobile: 'hide', cell: (l) => <span className="tabular text-fg-2">{formatMoney(l.balanceAfter, currency)}</span> },
          { key: 'time', header: t('common.time'), cell: (l) => <span className="tabular text-xs text-fg-2">{formatDate(l.createdAt, 'YYYY-MM-DD HH:mm:ss')}</span> },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={20} total={q.data.total} onChange={setPage} />}
    </>
  );
}

function Orders() {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['billing-orders', page],
    queryFn: () => api.get<Paginated<OrderDTO>>('/billing/orders', { page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        rowKey={(o) => o.id}
        empty={<Empty title={t('billing.noOrders')} />}
        columns={[
          { key: 'desc', header: t('common.content'), mobile: 'title', cell: (o) => <OrderContent order={o} /> },
          { key: 'type', header: t('common.type'), cell: (o) => <Tag tone={o.type === 'NEW' ? 'primary' : 'neutral'}>{o.type === 'NEW' ? t('common.orderNew') : t('common.orderRenew')}</Tag> },
          { key: 'cycle', header: t('store.cycle'), cell: (o) => L.billingCycle[o.cycle] },
          { key: 'amount', header: t('common.amount'), cell: (o) => <OrderAmount order={o} currency={currency} /> },
          { key: 'status', header: t('common.status'), cell: (o) => (
              <Badge tone={o.status === 'PAID' ? 'success' : 'warning'} dot>
                {o.status === 'PAID' ? t('common.paid') : t('common.refunded')}
              </Badge>
            ),
          },
          { key: 'no', header: t('billing.orderNo'), cell: (o) => <span className="font-mono text-xs text-fg-2">{o.no}</span> },
          { key: 'time', header: t('common.time'), cell: (o) => <span className="tabular text-xs text-fg-2">{formatDate(o.createdAt)}</span> },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={20} total={q.data.total} onChange={setPage} />}
    </>
  );
}

function Payments() {
  const t = useT();
  const currency = useCurrency();
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['payments', page],
    queryFn: () => api.get<Paginated<PaymentDTO>>('/payments', { page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  return (
    <>
      <DataTable
        rows={q.data?.items}
        loading={q.isLoading}
        rowKey={(p) => p.id}
        empty={<Empty title={t('billing.noPayments')} />}
        columns={[
          { key: 'no', header: t('billing.paymentNo'), mobile: 'title', cell: (p) => <span className="font-mono text-xs text-fg">{p.no}</span> },
          { key: 'gateway', header: t('billing.method'), cell: (p) => <span className="text-fg-2">{p.methodName}</span> },
          { key: 'amount', header: t('common.amount'), cell: (p) => <span className="tabular font-medium">{formatMoney(p.amount, currency)}</span> },
          { key: 'pay', header: t('billing.payAmountCol'), cell: (p) => <span className="tabular text-fg-2">{p.payAmount} {p.currency.toUpperCase()}</span> },
          { key: 'status', header: t('common.status'), cell: (p) => <PaymentStatusBadge status={p.status} /> },
          { key: 'time', header: t('common.time'), cell: (p) => <span className="tabular text-xs text-fg-2">{formatDate(p.createdAt)}</span> },
        ]}
      />
      {q.data && <Pagination page={page} pageSize={20} total={q.data.total} onChange={setPage} />}
    </>
  );
}

export default function Billing() {
  const t = useT();
  const { data: me } = useMe();
  const currency = useCurrency();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<'logs' | 'orders' | 'payments'>(params.get('payment') ? 'payments' : 'logs');
  const [redeemOpen, setRedeemOpen] = useState(false);
  const methods = useQuery({ queryKey: ['payment-options'], queryFn: () => api.get<PayOptionsDTO>('/payments/options'), staleTime: 60_000 });
  const summary = useQuery({ queryKey: ['billing-summary'], queryFn: () => api.get<BillingSummary>('/billing/summary') });
  const paymentNo = params.get('payment');
  const topUpOpen = params.get('topup') === '1';
  const setTopUp = (o: boolean) => {
    const next = new URLSearchParams(params);
    if (o) next.set('topup', '1');
    else next.delete('topup');
    setParams(next, { replace: true });
  };
  const s = summary.data;

  return (
    <>
      <PageHeader
        title={t('nav.billing')}
        description={methods.data?.enabled ? t('billing.balanceHint') : t('billing.balanceHintOffline')}
        actions={
          <>
            <Button icon={<Gift />} onClick={() => setRedeemOpen(true)}>
              {t('billing.redeem')}
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => setTopUp(true)}>
              {t('shell.topUp')}
            </Button>
          </>
        }
      />
      {paymentNo && (
        <PaymentResult
          no={paymentNo}
          canceled={params.get('canceled') === '1'}
          onDismiss={() => {
            const next = new URLSearchParams(params);
            next.delete('payment');
            next.delete('canceled');
            setParams(next, { replace: true });
          }}
        />
      )}
      <StatStrip>
        <Stat icon={<Wallet />} label={t('shell.balance')} value={formatMoney(me?.balance ?? 0, currency)} hint={t('billing.activeInstances', { n: s?.activeInstances ?? 0 })} />
        <Stat icon={<HandCoins />} label={t('billing.totalRecharge')} value={formatMoney(s?.totalRecharge ?? 0, currency)} hint={t('billing.monthRechargeHint', { amount: formatMoney(s?.monthRecharge ?? 0, currency) })} />
        <Stat icon={<Receipt />} label={t('billing.totalSpend')} value={formatMoney(s?.totalSpend ?? 0, currency)} />
        <Stat icon={<CalendarDays />} label={t('dash.monthSpend')} value={formatMoney(s?.monthSpend ?? 0, currency)} />
      </StatStrip>
      <TabBar
        value={tab}
        onChange={setTab}
        className="mt-4 mb-4"
        items={[
          { value: 'logs', label: t('billing.tabLogs') },
          { value: 'orders', label: t('billing.tabOrders') },
          { value: 'payments', label: t('billing.tabPayments') },
        ]}
      />
      <Card key={tab} className="panel-enter">
        {tab === 'logs' && <Logs />}
        {tab === 'orders' && <Orders />}
        {tab === 'payments' && <Payments />}
      </Card>
      <TopUpDialog open={topUpOpen} onOpenChange={setTopUp} payment={methods.data} />
      <RedeemDialog open={redeemOpen} onOpenChange={setRedeemOpen} />
    </>
  );
}

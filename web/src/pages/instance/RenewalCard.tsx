import { useMutation } from '@tanstack/react-query';
import { ArrowRight, CalendarClock, CircleAlert, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { CYCLE_MONTHS, type CouponQuoteDTO, type InvoiceDTO } from '../../shared/index';
import { CouponInput } from '@/components/CouponInput';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Card, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useInstanceApiPath, useInvalidateInstance, type AnyInstance } from '@/hooks/instances';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { daysLeft, daysLeftText, formatDate, formatMoney, monthsLabel } from '@/lib/format';
import { useCurrency, useMe } from '@/lib/queries';
import { renewalEstimate } from '@/lib/renewal';
import { toast } from '@/lib/toast';

function SummaryRow({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4 text-[13px]', className)}>
      <dt className="min-w-0 text-fg-3">{label}</dt>
      <dd className="tabular shrink-0 font-medium text-fg">{children}</dd>
    </div>
  );
}

/** 手动续费与自动续费分开呈现；提交前再次核对实例、时长、金额和到期时间。 */
export function RenewalCard({ inst }: { inst: AnyInstance }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const me = useMe();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const instancePath = useInstanceApiPath(inst.id);
  const invalidate = useInvalidateInstance(inst.id);
  const [periods, setPeriods] = useState(1);
  const [coupon, setCoupon] = useState<CouponQuoteDTO | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const estimate = renewalEstimate(inst, periods, me.data?.balance ?? null, coupon);
  const m = (value: string | number) => formatMoney(value, currency);
  const deleted = inst.status === 'DELETED' || inst.status === 'DELETING';
  const notProvisioned = inst.status === 'CREATING';
  const unavailable = deleted || notProvisioned;
  const insufficient = estimate.shortfall !== null && estimate.shortfall > 0;
  const pricing = quoting || estimate.quoteStale;
  const boundTotal = (Math.round(Number(inst.renewPrice) * 100) * periods) / 100;
  const couponExtra = Math.round((estimate.total - boundTotal) * 100) / 100;
  const left = daysLeft(inst.expiresAt);
  const duration = monthsLabel(CYCLE_MONTHS[inst.billingCycle] * periods);

  const renew = useMutation({
    mutationFn: (body: { periods: number; couponCode?: string }) => api.post<{ invoice: InvoiceDTO }>(`${instancePath}/renew`, body),
    onSuccess: (r) => {
      toast.success(t('invoice.created'), r.invoice.no);
      setCoupon(null);
      navigate('/console/invoices');
    },
    onError: (error) => toast.fromError(error, t('settings.renewFailed')),
  });
  const autoRenew = useMutation({
    mutationFn: (enabled: boolean) => api.patch(instancePath, { autoRenew: enabled }),
    onSuccess: (_, enabled) => {
      toast.success(t(enabled ? 'settings.autoRenewOnDone' : 'settings.autoRenewOffDone'));
      invalidate();
    },
    onError: (error) => toast.fromError(error),
  });
  const busy = confirming || renew.isPending || autoRenew.isPending;
  const askRenew = async () => {
    if (busy || unavailable || pricing || !me.data) return;
    const selection = { periods, couponCode: coupon?.code };
    setConfirming(true);
    try {
      const ok = await confirm({
        title: t('settings.renewConfirm', { amount: m(estimate.total) }),
        description: (
          <div>
            <p className="font-medium break-words text-fg">{inst.hostname}</p>
            <dl className="mt-3 space-y-2">
              <SummaryRow label={t('settings.duration')}>{duration}</SummaryRow>
              <SummaryRow label={t('renewal.newExpiry')}>{formatDate(estimate.renewedUntil)}</SummaryRow>
              {estimate.discount > 0 && <SummaryRow label={t('renewal.discount')}>−{m(estimate.discount)}</SummaryRow>}
              <SummaryRow label={t('renewal.balanceAfter')}>{m(estimate.balanceAfter ?? 0)}</SummaryRow>
            </dl>
            <p className="mt-3 text-xs leading-5 text-fg-3">{t('settings.renewConfirmDesc')}</p>
          </div>
        ),
        confirmText: t('settings.renewNow'),
      });
      if (ok) renew.mutate(selection);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Card className="overflow-hidden" aria-labelledby="instance-renewal-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
        <div>
          <h3 id="instance-renewal-title" className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <CalendarClock aria-hidden="true" className="size-4 text-fg-3" />
            {t('renewal.title')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-fg-3">{t('renewal.subtitle')}</p>
        </div>
        <span className={cn('inline-flex items-center gap-1.5 text-xs', left <= 0 ? 'text-danger-text' : left <= 7 ? 'text-warning-text' : 'text-fg-3')}>
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
          {daysLeftText(inst.expiresAt)}
        </span>
      </header>

      <div className="grid divide-y divide-line lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
        <div className="min-w-0 space-y-4 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <div className="min-w-0">
              <p className="text-sm font-medium break-words text-fg">{inst.plan?.name ?? t('renewal.currentInstance')}</p>
              <p className="mt-1 text-xs break-words text-fg-3">{inst.hostname} · {inst.region}</p>
            </div>
            <p className="tabular text-sm font-medium text-fg">{m(inst.renewPrice)} <span className="text-xs font-normal text-fg-3">/ {L.billingCycle[inst.billingCycle]}</span></p>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-fg-2">{t('settings.duration')}</p>
            <Select
              aria-label={t('settings.duration')}
              className="h-10"
              value={periods}
              onChange={setPeriods}
              disabled={busy || unavailable || quoting}
              options={[1, 2, 3, 6, 12].map((n) => ({
                value: n,
                label: monthsLabel(CYCLE_MONTHS[inst.billingCycle] * n),
                description: t('renewal.periodDescription', { n, cycle: L.billingCycle[inst.billingCycle], amount: m(Number(inst.renewPrice) * n) }),
              }))}
            />
            <p className="mt-1.5 text-xs leading-5 text-fg-3">{t('renewal.cycleFixed', { cycle: L.billingCycle[inst.billingCycle] })}</p>
          </div>

          <div className="border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <dl className="min-w-0 flex-1">
                <dt className="text-xs text-fg-3">{t('renewal.currentExpiry')}</dt>
                <dd className="tabular mt-1 text-[13px] text-fg-2">{formatDate(inst.expiresAt)}</dd>
              </dl>
              <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-fg-4 max-sm:hidden" />
              <dl className="min-w-0 flex-1">
                <dt className="text-xs text-fg-3">{t('renewal.newExpiry')}</dt>
                <dd className="tabular mt-1 text-[13px] font-semibold text-fg">{formatDate(estimate.renewedUntil)}</dd>
              </dl>
            </div>
            {estimate.expired && <p className="mt-2 text-xs leading-5 text-warning-text">{t('renewal.expiredHint')}</p>}
          </div>

          {estimate.original > 0 && !unavailable && (
            <div className="border-t border-line pt-3">
              <CouponInput
                target={{ kind: 'RENEW', instanceId: inst.id, periods }}
                refreshKey={`${inst.price}:${inst.renewPrice}`}
                value={coupon}
                onChange={setCoupon}
                onPendingChange={setQuoting}
                disabled={busy}
                currency={currency}
              />
              {inst.renewCoupon && !coupon && <p className="mt-2 text-xs leading-5 text-fg-3">{t('coupon.boundRenew', { code: inst.renewCoupon.code, price: m(inst.renewPrice), cycle: L.billingCycle[inst.billingCycle] })}</p>}
              {coupon && <p className="mt-2 text-xs leading-5 text-fg-3">{t(coupon.mode === 'RECURRING' ? 'renewal.recurringCoupon' : 'renewal.onceCoupon')}</p>}
              {coupon && inst.renewCoupon && !pricing && couponExtra > 0 && (
                <p className="mt-2 text-xs leading-5 text-warning-text">{t('renewal.betterBoundCoupon', { amount: m(couponExtra) })}</p>
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 px-4 py-4 sm:px-5">
          <h4 className="text-sm font-medium text-fg">{t('renewal.summary')}</h4>
          <dl className="mt-3 space-y-2.5">
            <SummaryRow label={t('renewal.original', { duration })}>{m(estimate.original)}</SummaryRow>
            {(estimate.discount > 0 || pricing) && (
              <SummaryRow label={t('renewal.discount')}>
                <span className={pricing ? 'text-fg-3' : 'text-success-text'}>{pricing ? '—' : `−${m(estimate.discount)}`}</span>
              </SummaryRow>
            )}
          </dl>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-3" aria-live="polite" aria-busy={pricing}>
            <span className="text-[13px] font-medium text-fg-2">{t('settings.amount')}</span>
            <span className="tabular text-3xl leading-9 font-semibold tracking-tight text-fg">{pricing ? <span className="text-sm font-normal text-fg-3">{t('renewal.quoting')}</span> : m(estimate.total)}</span>
          </div>
          <dl className="mt-3 space-y-2">
            <SummaryRow label={<span className="inline-flex items-center gap-1.5"><Wallet aria-hidden="true" className="size-3.5" />{t('renewal.balance')}</span>}>{me.data ? m(me.data.balance) : '—'}</SummaryRow>
            <SummaryRow label={t(insufficient ? 'renewal.shortfall' : 'renewal.balanceAfter')}>
              <span className={insufficient ? 'text-danger-text' : undefined}>{pricing || !me.data ? '—' : m(insufficient ? estimate.shortfall ?? 0 : estimate.balanceAfter ?? 0)}</span>
            </SummaryRow>
          </dl>
          <div className="mt-4">
            {unavailable ? (
              <p className="mb-2 flex items-start gap-1.5 text-xs leading-5 text-fg-3"><CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />{t(deleted ? 'renewal.deletedHint' : 'renewal.provisioningHint')}</p>
            ) : me.isError ? (
              <p className="mb-2 text-xs leading-5 text-danger-text">{t('renewal.balanceUnavailable')}</p>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              className="w-full"
              loading={renew.isPending}
              disabled={busy || unavailable || pricing || (!me.data && !me.isError)}
              onClick={() => me.isError && !me.data ? void me.refetch() : void askRenew()}
            >
              {me.isError && !me.data ? t('common.retry') : t('settings.renewNow')}
            </Button>
            {!unavailable && <p className="mt-2 text-center text-xs leading-5 text-fg-3">{t(estimate.total === 0 && !pricing ? 'renewal.freeHint' : 'renewal.paymentHint')}</p>}
          </div>
        </div>
      </div>

      <footer className="flex items-center justify-between gap-4 border-t border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-fg">{t('settings.autoRenew')}</p>
          <p className="mt-0.5 text-xs leading-5 text-fg-3">{t('renewal.autoRenewHint', { amount: m(inst.renewPrice), cycle: L.billingCycle[inst.billingCycle] })}</p>
        </div>
        <Switch
          checked={inst.autoRenew}
          disabled={unavailable || busy || pricing}
          label={<span className="sr-only">{t('settings.autoRenew')}</span>}
          onCheckedChange={async (enabled) => {
            setConfirming(true);
            try {
              const ok = await confirm(enabled ? {
                title: t('settings.autoRenewOnTitle'),
                description: t('settings.autoRenewOnDesc', { amount: m(inst.renewPrice), cycle: L.billingCycle[inst.billingCycle] }),
                confirmText: t('settings.autoRenewOnConfirm'),
              } : {
                title: t('settings.autoRenewOffTitle'), description: t('settings.autoRenewOffDesc'), confirmText: t('settings.autoRenewOffConfirm'),
              });
              if (ok) autoRenew.mutate(enabled);
            } finally {
              setConfirming(false);
            }
          }}
        />
      </footer>
    </Card>
  );
}

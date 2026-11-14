import { Popover } from '@base-ui/react/popover';
import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { isNatType, type InvoiceDTO, type InvoicePurchaseConfigDTO, type InvoiceStatus, type InvoiceType } from '@/shared/index';
import { PageHeader } from '@/components/page';
import { Badge, Card, Skeleton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { formatBandwidth, formatCores, formatDate, formatMemory, formatMoney, formatTraffic } from '@/lib/format';
import { diskIoText } from '@/lib/plans';
import { useCurrency } from '@/lib/queries';

const statusTone: Record<InvoiceStatus, 'warning' | 'success' | 'neutral' | 'danger'> = {
  PENDING: 'warning', PROCESSING: 'warning', PAID: 'success', CANCELED: 'neutral', EXPIRED: 'danger',
};
const statusLabel = { PENDING: 'invoice.pending', PROCESSING: 'invoice.processing', PAID: 'invoice.paid', CANCELED: 'invoice.canceled', EXPIRED: 'invoice.expired' } as const;
const typeLabel = { PURCHASE: 'invoice.purchase', RENEW: 'invoice.renew', TRAFFIC_RESET: 'invoice.trafficReset' } as const;

function Stat({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return <div className="rounded-lg border border-line bg-surface px-4 py-3"><div className="text-xs text-fg-3">{label}</div>{children ?? <div className="mt-1 text-lg font-semibold text-fg">{value}</div>}</div>;
}

function PurchaseConfiguration({ config }: { config: InvoicePurchaseConfigDTO }) {
  const { t, L } = useI18n();
  const traffic = formatTraffic(config.traffic);
  const trafficValue = `${traffic} · ${L.trafficMode[config.trafficMode]}`;
  const network = [isNatType(config.type) ? t('store.natPorts', { n: config.portLimit }) : t('store.ipv4One'), config.ipv6Count > 0 ? t('store.ipv6N', { n: config.ipv6Count }) : null].filter(Boolean).join(' · ');
  const fields = [
    { label: t('store.hostname'), value: config.hostname },
    { label: t('common.region'), value: config.region },
    { label: t('common.type'), value: L.instanceType[config.type] },
    { label: t('store.os'), value: config.image ?? '—' },
    { label: t('store.cycle'), value: L.billingCycle[config.cycle] },
    ...(config.node ? [{ label: t('invoice.node'), value: config.node }] : []),
    { label: 'CPU', value: formatCores(config.cpu) },
    { label: t('spec.memory'), value: formatMemory(config.memory) },
    ...(config.swap > 0 ? [{ label: 'SWAP', value: t('store.swapValue', { size: formatMemory(config.swap) }) }] : []),
    { label: t('spec.disk'), value: `${config.disk} GB` },
    {
      label: t('spec.traffic'),
      value: config.trafficIsEstimate ? (
        <Popover.Root>
          <Popover.Trigger openOnHover className="cursor-help text-left underline decoration-line-strong decoration-dotted underline-offset-4">{trafficValue}</Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner sideOffset={6} className="z-[80]">
              <Popover.Popup className="popup-anim max-w-xs rounded-md bg-fg px-2.5 py-1.5 text-xs leading-relaxed text-bg shadow-card">
                <Popover.Description>{t('invoice.trafficEstimate', { traffic })}</Popover.Description>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      ) : trafficValue,
    },
    { label: t('overview.ingressLimit'), value: formatBandwidth(config.bandwidthIn) },
    { label: t('overview.egressLimit'), value: formatBandwidth(config.bandwidthOut) },
    { label: t('store.colNetwork'), value: network },
    ...(isNatType(config.type) ? [{ label: t('spec.portsSites'), value: t('spec.portsSitesValue', { ports: config.portLimit, sites: config.siteLimit }) }] : []),
    { label: t('spec.snapshots'), value: String(config.snapshotLimit) },
  ];
  const io = diskIoText(config, t);
  if (io) fields.push({ label: t('spec.diskIo'), value: io });
  return (
    <section className="mt-4">
      <h3 className="text-sm font-semibold text-fg">{t('invoice.configuration')}</h3>
      {!config.snapshot && <p className="mt-1 text-xs text-fg-3">{t('invoice.legacyConfiguration')}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-4">
        {fields.map(({ label, value }) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-fg-3">{label}</dt>
            <dd className="mt-1 text-[13px] font-medium break-words text-fg">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function InvoiceLoading() {
  const { t } = useI18n();
  return (
    <div className="space-y-5" aria-busy="true" aria-label={t('common.loading')}>
      <div className="flex flex-wrap items-center justify-between gap-3 py-1">
        <div className="space-y-2"><Skeleton className="h-8 w-64 max-w-full" /><Skeleton className="h-4 w-40" /></div>
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Card key={i} className="space-y-3 p-4"><Skeleton className="h-3 w-20" /><Skeleton className="h-6 w-32" /></Card>)}</div>
      <Card className="space-y-5 p-5 sm:p-6">
        <Skeleton className="h-5 w-28" /><Skeleton className="h-11 w-full" />
        <Skeleton className="h-5 w-28" />
        <div className="grid gap-3 sm:grid-cols-2">{[0, 1].map((i) => <div key={i} className="space-y-3 rounded-lg border border-line p-4"><Skeleton className="h-3 w-20" /><Skeleton className="h-6 w-40 max-w-full" /></div>)}</div>
      </Card>
      <Card className="space-y-5 p-5 sm:p-6"><Skeleton className="h-5 w-28" /><Skeleton className="h-28 w-full" /></Card>
    </div>
  );
}

export function InvoiceView({ invoice, actions, backTo, customer, instanceLink }: {
  invoice: InvoiceDTO;
  actions?: ReactNode;
  backTo: string;
  customer?: { id: number; username: string; email: string };
  instanceLink?: string;
}) {
  const { t } = useI18n();
  const currency = useCurrency();
  const config = invoice.type === 'PURCHASE' ? invoice.purchaseConfig : null;
  const title = config ? `${config.product} / ${config.plan}` : invoice.instance?.hostname ?? invoice.plan?.name ?? invoice.description;
  const original = Number(invoice.amount) + Number(invoice.discount);
  return (
    <div className="space-y-5">
      <PageHeader
        back={{ to: backTo, label: t('invoice.back') }}
        title={invoice.no}
        description={`${t(typeLabel[invoice.type as InvoiceType])} · ${formatDate(invoice.createdAt)}`}
        actions={
          <>
            <Badge tone={statusTone[invoice.status]}>{t(statusLabel[invoice.status])}</Badge>
            {actions}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('invoice.original')} value={formatMoney(original, currency)} />
        <Stat label={t('invoice.total')} value={formatMoney(invoice.amount, currency)} />
        <Stat label={t('invoice.expires')} value={invoice.expiresAt ? formatDate(invoice.expiresAt) : '—'} />
      </div>
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-base font-semibold text-fg">{t('invoice.businessInfo')}</h2>
          {customer && <div className="text-sm text-fg-3"><Link className="font-medium text-primary hover:underline" to={`/admin/users/${customer.id}`}>{customer.username}</Link><span className="ml-2 break-all">{customer.email}</span></div>}
        </div>
        <div className="mt-3 rounded-lg bg-surface-2 px-4 py-3 text-sm text-fg">{title}</div>
        {invoice.nightMarket && <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-fg-2"><Badge>{t('night.title')}</Badge><span>{invoice.nightMarket.name}</span><Badge>{t(`night.quality.${invoice.nightMarket.quality}`)}</Badge><span>{t('night.savePercent', { percent: invoice.nightMarket.discountPercent })}</span><Badge>{t(`night.mode.${invoice.nightMarket.discountMode ?? 'ONCE'}`)}</Badge></div>}
        {instanceLink && invoice.instance && <Link to={instanceLink} className="mt-3 inline-block text-sm text-primary hover:underline">{invoice.instance.hostname} →</Link>}
        {config && <PurchaseConfiguration config={config} />}
        <h2 className="mt-6 text-base font-semibold text-fg">{t('invoice.keyTimes')}</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Stat label={t('invoice.createdAt')} value={formatDate(invoice.createdAt)} />
          <Stat label={t('invoice.paidAt')} value={invoice.paidAt ? formatDate(invoice.paidAt) : '—'} />
        </div>
      </Card>
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold text-fg">{t('invoice.detail')}</h2>
        <div className="mt-3 rounded-lg border border-line p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium text-fg">{t(typeLabel[invoice.type as InvoiceType])}</div><div className="mt-1 text-sm text-fg-3">{invoice.description}</div></div><div className="tabular font-semibold text-fg">{formatMoney(invoice.amount, currency)}</div></div>
          <div className="mt-3 grid gap-2 border-t border-line pt-3 text-sm text-fg-2 sm:grid-cols-2"><div>{t('invoice.quantity')}: 1</div><div className="sm:text-right">{t('invoice.original')} {formatMoney(original, currency)}{Number(invoice.discount) > 0 ? ` · ${t(invoice.discountSource === 'NIGHT_MARKET' ? 'billingAdmin.nightDiscount' : invoice.discountSource === 'COUPON' ? 'billingAdmin.couponDiscount' : 'billingAdmin.otherDiscount')} −${formatMoney(invoice.discount, currency)}${invoice.couponCode ? ` (${invoice.couponCode})` : ''}` : ''}</div></div>
        </div>
      </Card>
    </div>
  );
}

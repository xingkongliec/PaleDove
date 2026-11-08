import { Popover } from '@base-ui/react/popover';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FileText, X } from 'lucide-react';
import { useParams } from 'react-router';
import type { ReactNode } from 'react';
import { isNatType, type InvoiceDTO, type InvoicePurchaseConfigDTO, type InvoiceStatus, type InvoiceType } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, Empty } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatBandwidth, formatCores, formatDate, formatMemory, formatMoney, formatTraffic } from '@/lib/format';
import { diskIoText } from '@/lib/plans';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

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

export default function InvoiceDetail() {
  const { t } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const invoiceId = Number(id);
  const query = useQuery({ queryKey: ['invoice', invoiceId], queryFn: () => api.get<InvoiceDTO>(`/invoices/${invoiceId}`), enabled: Number.isInteger(invoiceId) && invoiceId > 0 });
  const pay = useMutation({
    mutationFn: () => api.post<InvoiceDTO>(`/invoices/${invoiceId}/pay`),
    onSuccess: (data) => { toast.success(t('invoice.paySuccess')); qc.setQueryData(['invoice', invoiceId], data); void qc.invalidateQueries({ queryKey: ['invoices'] }); void qc.invalidateQueries({ queryKey: ['me'] }); void qc.invalidateQueries({ queryKey: ['instances'] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api.post<InvoiceDTO>(`/invoices/${invoiceId}/cancel`),
    onSuccess: (data) => { toast.success(t('invoice.cancelSuccess')); qc.setQueryData(['invoice', invoiceId], data); void qc.invalidateQueries({ queryKey: ['invoices'] }); },
    onError: (e) => toast.error(errorText(e)),
  });
  if (query.isLoading) return <div className="py-12 text-center text-sm text-fg-3">{t('common.loading')}</div>;
  const invoice = query.data;
  if (!invoice) return <Empty icon={<FileText />} title={t('invoice.notFound')} />;
  const pending = invoice.status === 'PENDING';
  const config = invoice.type === 'PURCHASE' ? invoice.purchaseConfig : null;
  const title = config ? `${config.product} / ${config.plan}` : invoice.instance?.hostname ?? invoice.plan?.name ?? invoice.description;
  const original = Number(invoice.amount) + Number(invoice.discount);
  return (
    <div className="space-y-5">
      <PageHeader
        back={{ to: '/invoices', label: t('invoice.back') }}
        title={invoice.no}
        description={`${t(typeLabel[invoice.type as InvoiceType])} · ${formatDate(invoice.createdAt)}`}
        actions={
          <>
            <Badge tone={statusTone[invoice.status]}>{t(statusLabel[invoice.status])}</Badge>
            {pending && (
              <>
                <Button variant="ghost" icon={<X />} onClick={() => cancel.mutate()} loading={cancel.isPending} disabled={pay.isPending}>{t('invoice.cancel')}</Button>
                <Button variant="primary" icon={<CreditCard />} onClick={() => pay.mutate()} loading={pay.isPending} disabled={cancel.isPending}>{t('invoice.pay')}</Button>
              </>
            )}
          </>
        }
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('invoice.status')}><Badge tone={statusTone[invoice.status]}>{t(statusLabel[invoice.status])}</Badge></Stat>
        <Stat label={t('invoice.total')} value={formatMoney(invoice.amount, currency)} />
        <Stat label={t('invoice.expires')} value={invoice.expiresAt ? formatDate(invoice.expiresAt) : '—'} />
      </div>
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold text-fg">{t('invoice.businessInfo')}</h2>
        <div className="mt-3 rounded-lg bg-surface-2 px-4 py-3 text-sm text-fg">{title}</div>
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
          <div className="mt-3 grid gap-2 border-t border-line pt-3 text-sm text-fg-2 sm:grid-cols-2"><div>{t('invoice.quantity')}: 1</div><div className="sm:text-right">{t('invoice.original')} {formatMoney(original, currency)}{Number(invoice.discount) > 0 ? ` · ${t('coupon.discount')} ${formatMoney(invoice.discount, currency)}` : ''}</div></div>
        </div>
      </Card>
    </div>
  );
}

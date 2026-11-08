// 交易市场成交记录：成交时保存的实例信息快照（卖家在「我的出售」、管理员在交易市场管理中查看）
import type { MarketSaleSnapshotDTO } from '../../shared/index';
import type { ReactNode } from 'react';
import { CountryFlag } from '@/components/country';
import { Modal } from '@/components/ui/dialog';
import { CopyButton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { formatBandwidth, formatBytes, formatCores, formatDate, formatMemory, formatMoney, formatTraffic } from '@/lib/format';
import { useCurrency } from '@/lib/queries';

/** 一组信息：小标题 + 两列的键值 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-xs font-medium text-fg-3">{title}</h4>
      <dl className="grid gap-x-6 rounded-lg border border-line px-3.5 py-1 sm:grid-cols-2">{children}</dl>
    </section>
  );
}

function Item({ label, children, copy, mono }: { label: string; children: ReactNode; copy?: string | null; mono?: boolean }) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-3 border-b border-line/60 py-1.5 text-[13px] last:border-0 sm:[&:nth-last-child(2):nth-child(odd)]:border-0">
      <dt className="shrink-0 text-fg-3">{label}</dt>
      <dd className={`flex min-w-0 items-center justify-end gap-1 text-right text-fg ${mono ? 'font-mono text-[12.5px]' : ''}`}>
        <span className="truncate">{children}</span>
        {copy && <CopyButton value={copy} className="size-6 text-fg-4" />}
      </dd>
    </div>
  );
}

export function SaleRecordDialog({ record, listingId, onClose }: { record: MarketSaleSnapshotDTO | null; listingId: number | null; onClose: () => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const r = record;
  return (
    <Modal
      open={!!r}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t('market.record.title', { id: listingId ?? '' })}
      description={r ? t('market.record.desc', { time: formatDate(r.takenAt, 'YYYY-MM-DD HH:mm:ss') }) : undefined}
    >
      {r && (
        <div className="space-y-4">
          <Group title={t('market.record.deal')}>
            <Item label={t('market.price')}>{formatMoney(r.price, currency)}</Item>
            <Item label={t('market.record.fee')}>{formatMoney(r.fee, currency)}</Item>
            <Item label={t('market.record.income')}>{formatMoney(r.income, currency)}</Item>
            <Item label={t('market.record.mode')}>{r.mode === 'REINSTALL' ? t('market.mode.REINSTALL') : t('market.mode.KEEP')}</Item>
            <Item label={t('market.record.seller')}>{r.seller.username}</Item>
            <Item label={t('market.record.buyer')}>{r.buyer.username}</Item>
          </Group>
          <Group title={t('market.record.instance')}>
            <Item label={t('market.record.hostname')}>{r.hostname}</Item>
            <Item label={t('market.record.instanceName')} copy={r.instanceName} mono>
              {r.instanceName}
            </Item>
            <Item label={t('market.record.node')}>
              <span className="inline-flex items-center gap-1.5">
                <CountryFlag code={r.country} />
                {r.region} · {r.nodeName}
              </span>
            </Item>
            <Item label={t('market.record.plan')}>{[r.product, r.plan].filter(Boolean).join(' / ') || L.instanceType[r.type]}</Item>
            <Item label={t('market.record.type')}>{L.instanceType[r.type]}</Item>
            <Item label={t('market.record.image')}>{r.image ?? '—'}</Item>
            <Item label={t('market.record.status')}>{L.instanceStatus[r.instanceStatus]}</Item>
            <Item label={t('market.record.publicIp')} copy={r.publicIp} mono>
              {r.publicIp ?? '—'}
            </Item>
            {r.privateIp && (
              <Item label={t('market.record.privateIp')} mono>
                {r.privateIp}
              </Item>
            )}
            {r.ipv6.map((ip, i) => (
              <Item key={ip} label={i ? `IPv6 #${i + 1}` : 'IPv6'} copy={ip} mono>
                {ip}
              </Item>
            ))}
          </Group>
          <Group title={t('market.record.spec')}>
            <Item label={t('market.record.config')}>{`${formatCores(r.cpu)} / ${formatMemory(r.memory)} / ${r.disk} GB`}</Item>
            <Item label={t('market.record.bandwidth')}>{`${formatBandwidth(r.bandwidthIn)} / ${formatBandwidth(r.bandwidthOut)}`}</Item>
            <Item label={t('market.record.traffic')}>
              {formatBytes(r.trafficUsed)} / {r.traffic > 0 ? formatTraffic(r.traffic) : t('common.unlimited')} · {L.trafficMode[r.trafficMode]}
            </Item>
            <Item label={t('market.record.renew')}>{`${formatMoney(r.renewPrice, currency)} / ${L.billingCycle[r.billingCycle]}`}</Item>
            <Item label={t('common.createdAt')}>{formatDate(r.createdAt)}</Item>
            <Item label={t('market.record.expires')}>{formatDate(r.expiresAt)}</Item>
          </Group>
        </div>
      )}
    </Modal>
  );
}

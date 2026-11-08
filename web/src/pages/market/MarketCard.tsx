import { Clock, History, ShoppingCart } from 'lucide-react';
import type { ReactNode } from 'react';
import type { MarketListingDTO } from '../../shared/index';
import { CountryFlag } from '@/components/country';
import { Tag, Tooltip } from '@/components/ui/misc';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { formatBandwidth, formatCores, formatDate, formatMemory, formatMoney, daysLeftText } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { PingSummaryButton } from './MarketPing';

const GIB = 1024 ** 3;
const GB = 1000 ** 3;

/** 二进制与十进制两种单位的流量，例如 14.63 GiB ≈ 15.71 GB */
const gib = (bytes: number) => `${(bytes / GIB).toFixed(bytes / GIB >= 100 ? 1 : 2)} GiB`;
const gbOf = (bytes: number) => `${(bytes / GB).toFixed(2)} GB`;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-[3px] text-[13px] leading-5">
      <dt className="w-[4.25rem] shrink-0 text-fg-3">{label}</dt>
      <dd className="tabular min-w-0 flex-1 break-words text-fg">{children}</dd>
    </div>
  );
}

/** 流量额度的悬停说明：二进制 / 十进制换算、已用流量、计费方式与超额处理 */
function TrafficTip({ l }: { l: MarketListingDTO }) {
  const { t, L } = useI18n();
  const limit = l.traffic * GIB;
  return (
    <div className="space-y-1.5">
      <div>
        <span className="text-base font-semibold">{l.traffic} GiB</span>
        <span className="ml-1.5 opacity-70">≈ {gbOf(limit)}</span>
      </div>
      <div className="opacity-80">
        {t('market.tip.used')} {gib(l.trafficUsed)} ≈ {gbOf(l.trafficUsed)}
      </div>
      <div className="opacity-80">
        {t('market.tip.mode')} {L.trafficMode[l.trafficMode]}
      </div>
      <div className="opacity-80">{l.overLimitAction === 'THROTTLE' ? t('market.tip.throttle', { rate: l.throttleRate }) : t('market.tip.stop')}</div>
    </div>
  );
}

/** 产品与线路的悬停说明：旗帜、产品名、标签与介绍 */
function ProductTip({ l }: { l: MarketListingDTO }) {
  return (
    <div className="max-w-xs space-y-1.5">
      <div className="flex items-center gap-2 font-medium">
        <CountryFlag code={l.country} />
        {l.product?.name ?? l.plan}
      </div>
      {l.product && l.product.tags.length > 0 && <div className="opacity-80">{l.product.tags.join(' · ')}</div>}
      {l.product?.description && <p className="line-clamp-5 whitespace-pre-line opacity-80">{l.product.description}</p>}
    </div>
  );
}

/** 交易市场的一件商品：配置、续费价格、到期时间、上架前拨测快照与成交价走势入口（控制台与公开页共用） */
export function MarketCard({
  listing: l,
  onBuy,
  onHistory,
  onPing,
}: {
  listing: MarketListingDTO;
  onBuy: (l: MarketListingDTO) => void;
  onHistory: (l: MarketListingDTO) => void;
  onPing: (l: MarketListingDTO) => void;
}) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  return (
    <div className="flex flex-col rounded-md border border-line bg-surface p-5 transition-colors duration-200 hover:border-line-strong">
      <div className="flex items-start justify-between gap-3">
        <Tooltip content={<ProductTip l={l} />}>
          <h3 className="min-w-0 cursor-pointer truncate text-[17px] leading-7 font-semibold text-fg transition-colors hover:text-fg-2">{l.plan ?? l.product?.name ?? `#${l.id}`}</h3>
        </Tooltip>
        <Tooltip content={t('market.history')}>
          <button
            type="button"
            aria-label={t('market.history')}
            onClick={() => onHistory(l)}
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-surface-2/60 text-fg-3 transition-colors hover:border-line-strong hover:text-fg"
          >
            <History className="size-4" />
          </button>
        </Tooltip>
      </div>

      {/* 上架前拨测快照：IP 状态、拨测时间与三网最快，点击查看详情；功能上线前上架的商品只显示上架时间 */}
      {l.ping ? (
        <div className="mt-1.5">
          <PingSummaryButton ping={l.ping} onOpen={() => onPing(l)} />
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <span className="inline-flex items-center gap-1 text-[11px] text-fg-3">
            <Clock className="size-3" />
            {formatDate(l.createdAt, 'YYYY-MM-DD HH:mm:ss')}
          </span>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {l.targeted && <Tag tone="warning">{t('market.targeted')}</Tag>}
        {l.product?.tags.slice(0, 3).map((tag) => (
          <Tag key={tag} tone="success">
            {tag}
          </Tag>
        ))}
      </div>

      <dl className="mt-3.5">
        <Row label={t('common.region')}>
          <span className="inline-flex items-center gap-1.5">
            <CountryFlag code={l.country} className="h-3.5 w-5" />
            {l.region}
          </span>
        </Row>
        <Row label={t('market.field.product')}>{l.product?.name ?? '—'}</Row>
        <Row label={t('market.field.plan')}>{l.plan ?? '—'}</Row>
        <Row label={t('market.field.config')}>
          {formatCores(l.cpu)} {formatMemory(l.memory)} {l.disk}GB
        </Row>
        <Row label={t('market.field.network')}>
          {t('market.bandwidth')} {formatBandwidth(Math.max(l.bandwidthIn, l.bandwidthOut))}{' '}
          {l.traffic > 0 ? (
            <Tooltip content={<TrafficTip l={l} />}>
              <span className="cursor-help underline decoration-fg-4 decoration-dotted underline-offset-4">
                {t('market.traffic')} {gib(l.trafficUsed)} / {l.traffic} GiB
              </span>
            </Tooltip>
          ) : (
            <span>
              {t('market.traffic')} {t('common.unlimited')}
            </span>
          )}
        </Row>
        <Row label="IP">
          {l.ipv4 === 'DEDICATED' ? t('market.ip.dedicated') : t('market.ip.nat')}
          {l.ipv6Count > 0 ? ` · IPv6 ${l.ipv6Count}` : ''}
        </Row>
        <Row label={t('market.field.renew')}>
          <span className="font-medium text-warning-text">
            {formatMoney(l.renewPrice, currency)}/{L.billingCycle[l.billingCycle]}
          </span>
        </Row>
        {l.trafficResetPrice && (
          <Row label={t('market.field.reset')}>
            <span className="font-medium text-warning-text">{formatMoney(l.trafficResetPrice, currency)}</span>
          </Row>
        )}
        <Row label={t('market.field.expires')}>
          {formatDate(l.expiresAt, 'YYYY-MM-DD HH:mm:ss')} <span className="text-xs text-fg-3">({daysLeftText(l.expiresAt)})</span>
        </Row>
      </dl>

      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <span className="tabular text-[26px] leading-none font-bold tracking-tight text-fg">{formatMoney(l.price, currency)}</span>
        {l.mine ? (
          <Tag>{t('market.mine')}</Tag>
        ) : (
          <Button variant="primary" size="sm" className="rounded-md" icon={<ShoppingCart />} onClick={() => onBuy(l)}>
            {t('market.buy')}
          </Button>
        )}
      </div>
    </div>
  );
}

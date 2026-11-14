import { lazy, Suspense } from 'react';
import type { MarketListingDTO } from '../../shared/index';
import { Modal } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { trackLoading } from '@/lib/loading';

const HistoryView = lazy(() => trackLoading(import('./PriceHistoryView').then((module) => ({ default: module.PriceHistoryView }))));

/** 图表代码与订阅只在查看走势时加载，市场列表不再等待整套图表依赖。 */
export function PriceHistoryDialog(props: { listing: MarketListingDTO | null; onClose: () => void }) {
  const { t } = useI18n();
  if (!props.listing) return null;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      size="xl"
      title={t('market.historyTitle', { plan: props.listing.plan ?? props.listing.product?.name ?? '' })}
      description={t('market.historyDesc')}
    >
      <Suspense fallback={<Skeleton className="h-80" />}>
        <HistoryView listing={props.listing} />
      </Suspense>
    </Modal>
  );
}

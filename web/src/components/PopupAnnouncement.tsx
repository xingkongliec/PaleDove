import { ImageOff, Megaphone } from 'lucide-react';
import { useState } from 'react';
import type { PopupDismissMode, PopupNotice, PopupPromotion } from '../shared/index';
import { Markdown } from './Markdown';
import { Modal } from './ui/dialog';
import { Button } from './ui/button';
import { useT } from '@/i18n';

export type PopupItem = { kind: 'notice'; value: PopupNotice } | { kind: 'promotion'; value: PopupPromotion };

export function PromotionImage({ url, title }: { url: string; title: string }) {
  const t = useT();
  const [failed, setFailed] = useState<string | null>(null);
  return failed === url ? <div className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg bg-surface-2 p-5 text-center text-sm text-fg-3"><ImageOff className="size-6" />{t('popup.imageFailed')}</div>
    : <img src={url} alt={title} referrerPolicy="no-referrer" className="mx-auto max-h-[50dvh] w-full rounded-lg object-contain" onError={() => setFailed(url)} />;
}

export function PopupAnnouncement({ item, open, onClose, onDismiss, onPurchase, preview = false }: {
  item: PopupItem | null;
  open: boolean;
  onClose: () => void;
  onDismiss?: (mode: PopupDismissMode) => void;
  onPurchase?: () => void;
  preview?: boolean;
}) {
  const t = useT();
  const title = item?.value.title || t(item?.kind === 'promotion' ? 'popup.promotionTitle' : 'popup.noticeTitle');
  return <Modal open={open} onOpenChange={value => { if (!value) onClose(); }} size="lg"
    title={<span className="flex items-center gap-2"><Megaphone className="size-4 text-fg-3" />{title}</span>}
    description={preview ? t('popup.previewHint') : undefined}
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-3">
      {!preview && <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onDismiss?.('today')}>{t('popup.hideToday')}</Button>
        <Button size="sm" variant="ghost" onClick={() => onDismiss?.('forever')}>{t('popup.hideForever')}</Button>
      </div>}
      <Button variant="primary" className="ml-auto" onClick={item?.kind === 'promotion' && item.value.planId && !preview ? onPurchase : onClose}>{t(preview ? 'common.close' : item?.kind === 'promotion' && item.value.planId ? 'popup.viewPlan' : 'popup.acknowledge')}</Button>
    </div>}>
    {item?.kind === 'notice' ? <Markdown source={item.value.content} className="break-words [overflow-wrap:anywhere]" />
      : item?.value.imageUrl ? <PromotionImage url={item.value.imageUrl} title={title} /> : null}
  </Modal>;
}

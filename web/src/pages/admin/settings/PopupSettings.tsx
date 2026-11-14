import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { POPUP_CONTENT_LIMIT, type AdminPopupSettingsDTO, type PopupNotice, type PopupPromotion } from '../../../shared/index';
import { PopupAnnouncement, PromotionImage, type PopupItem } from '@/components/PopupAnnouncement';
import { Button } from '@/components/ui/button';
import { FormField, Input, Textarea } from '@/components/ui/input';
import { Alert, Card, CardBody, CardHeader, ErrorState, PageLoading, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';

export function PopupSettingsCard() {
  const q = useQuery({ queryKey: ['popup-settings'], queryFn: () => api.get<AdminPopupSettingsDTO>('/admin/settings/popups') });
  if (!q.data) return q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : <PageLoading />;
  return <PopupEditor initial={q.data} />;
}

function PopupEditor({ initial }: { initial: AdminPopupSettingsDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const [notice, setNotice] = useState(initial.notice);
  const [promotion, setPromotion] = useState(initial.promotion);
  const [preview, setPreview] = useState<PopupItem | null>(null);
  const saved = <K extends 'notice' | 'promotion'>(key: K, value: AdminPopupSettingsDTO[K]) => {
    qc.setQueryData<AdminPopupSettingsDTO>(['popup-settings'], current => current && ({ ...current, [key]: value }));
    void qc.invalidateQueries({ queryKey: ['public-config'] });
    toast.success(t('adminSettings.saved'));
  };
  const saveNotice = useMutation({
    mutationFn: () => api.put<PopupNotice>('/admin/settings/popups/notice', { enabled: notice.enabled, title: notice.title, content: notice.content }),
    onSuccess: value => { setNotice(value); saved('notice', value); }, onError: error => toast.fromError(error),
  });
  const savePromotion = useMutation({
    mutationFn: () => api.put<PopupPromotion>('/admin/settings/popups/promotion', { enabled: promotion.enabled, title: promotion.title, imageUrl: promotion.imageUrl, planId: promotion.planId }),
    onSuccess: value => { setPromotion(value); saved('promotion', value); }, onError: error => toast.fromError(error),
  });
  const submit = (event: FormEvent, kind: 'notice' | 'promotion') => { event.preventDefault(); (kind === 'notice' ? saveNotice : savePromotion).mutate(); };
  const imageValid = /^https?:\/\/\S+$/i.test(promotion.imageUrl.trim());
  const planOptions = [{ value: 0, label: t('popup.noPlan') }, ...initial.plans.map(plan => ({ value: plan.id, label: `${plan.productName} / ${plan.name}` }))];
  if (promotion.planId && !initial.plans.some(plan => plan.id === promotion.planId)) planOptions.push({ value: promotion.planId, label: t('popup.unavailablePlan', { id: promotion.planId }) });
  return <div className="space-y-4">
    <Card><CardHeader title={t('popup.settingsTitle')} description={t('popup.settingsHint')} /><CardBody>
      <form onSubmit={event => submit(event, 'notice')} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <FormField className="min-w-48 flex-1" label={t('popup.titleLabel')}><Input maxLength={100} value={notice.title} placeholder={t('popup.noticeTitle')} onChange={event => setNotice(value => ({ ...value, title: event.target.value }))} /></FormField>
          <div className="flex h-8.5 items-center"><Switch checked={notice.enabled} onCheckedChange={enabled => setNotice(value => ({ ...value, enabled }))} label={t('popup.enabled')} /></div>
        </div>
        <FormField label={t('popup.contentLabel')}><Textarea rows={7} maxLength={POPUP_CONTENT_LIMIT} value={notice.content} aria-label={t('popup.contentLabel')} placeholder={t('popup.contentPlaceholder')} onChange={event => setNotice(value => ({ ...value, content: event.target.value }))} /></FormField>
        <div className="flex items-start justify-between gap-4 text-xs text-fg-3"><p className="leading-relaxed">{t('popup.contentHint')}</p><span className="shrink-0 tabular-nums">{notice.content.length}/{POPUP_CONTENT_LIMIT}</span></div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <Button icon={<Eye />} disabled={!notice.content.trim()} onClick={() => setPreview({ kind: 'notice', value: notice })}>{t('popup.preview')}</Button>
          <Button type="submit" variant="primary" loading={saveNotice.isPending} disabled={JSON.stringify(notice) === JSON.stringify(initial.notice)}>{t('common.save')}</Button>
        </div>
      </form>
    </CardBody></Card>
    <Card><CardHeader title={t('popup.promotionSettings')} description={t('popup.promotionHint')} /><CardBody>
      <form onSubmit={event => submit(event, 'promotion')} className="space-y-4">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-4"><FormField className="min-w-48 flex-1" label={t('popup.titleLabel')}><Input maxLength={100} value={promotion.title} placeholder={t('popup.promotionTitle')} onChange={event => setPromotion(value => ({ ...value, title: event.target.value }))} /></FormField><div className="flex h-8.5 items-center"><Switch checked={promotion.enabled} onCheckedChange={enabled => setPromotion(value => ({ ...value, enabled }))} label={t('popup.enabled')} /></div></div>
            <FormField label={t('popup.imageUrl')} description={t('popup.imageHint')}><Input type="url" maxLength={1000} value={promotion.imageUrl} placeholder="https://example.com/promotion.png" onChange={event => setPromotion(value => ({ ...value, imageUrl: event.target.value }))} /></FormField>
            <FormField label={t('popup.planLabel')} description={t('popup.planHint')}><Select value={promotion.planId ?? 0} options={planOptions} onChange={id => setPromotion(value => ({ ...value, planId: id || null }))} aria-label={t('popup.planLabel')} /></FormField>
          </div>
          <div className="flex items-center justify-center rounded-lg bg-surface-2 p-3">{imageValid ? <PromotionImage url={promotion.imageUrl.trim()} title={promotion.title || t('popup.promotionTitle')} /> : <p className="py-8 text-center text-xs text-fg-3">{t('popup.imagePreview')}</p>}</div>
        </div>
        {promotion.enabled && !imageValid && <Alert tone="warning">{t('popup.imageRequired')}</Alert>}
        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <Button icon={<Eye />} disabled={!imageValid} onClick={() => setPreview({ kind: 'promotion', value: promotion })}>{t('popup.preview')}</Button>
          <Button type="submit" variant="primary" loading={savePromotion.isPending} disabled={JSON.stringify(promotion) === JSON.stringify(initial.promotion) || (promotion.enabled && !imageValid)}>{t('common.save')}</Button>
        </div>
      </form>
    </CardBody></Card>
    <PopupAnnouncement item={preview} open={!!preview} onClose={() => setPreview(null)} preview />
  </div>;
}

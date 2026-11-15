import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Clock3, Info, Percent, Save, Users } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AdminSettingsDTO, SiteSettings } from '@/shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { FormField, InputGroup } from '@/components/ui/input';
import { Card, ErrorState, PageLoading, Switch } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { AffRecords } from './AffRecords';

type AffSettings = Pick<SiteSettings, 'affEnabled' | 'affRateNew' | 'affRateRenew' | 'affFreezeDays' | 'affMinWithdraw'>;
const settingKeys: (keyof AffSettings)[] = ['affEnabled', 'affRateNew', 'affRateRenew', 'affFreezeDays', 'affMinWithdraw'];

export default function AdminAffiliate() {
  const t = useT();
  const settings = useQuery({ queryKey: ['admin-settings'], queryFn: () => api.get<AdminSettingsDTO>('/admin/settings') });
  return (
    <div>
      <PageHeader title={t('nav.admin.affiliate')} />
      <div className="space-y-4">
        {settings.data ? <AffSettingsCard value={settings.data} /> : settings.error ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : <PageLoading />}
        <AffRecords />
      </div>
    </div>
  );
}

function AffSettingsCard({ value }: { value: AdminSettingsDTO }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState(value);
  useEffect(() => setForm(value), [value]);
  const set = <K extends keyof AffSettings>(key: K, next: AffSettings[K]) => setForm(current => ({ ...current, [key]: next }));
  const dirty = settingKeys.some(key => form[key] !== value[key]);
  const save = useMutation({
    mutationFn: (patch: AffSettings) => api.put<AdminSettingsDTO>('/admin/settings', patch),
    onSuccess: data => {
      qc.setQueryData(['admin-settings'], data);
      void qc.invalidateQueries({ queryKey: ['public-config'] });
      toast.success(t('adminSettings.saved'));
    },
    onError: error => toast.fromError(error),
  });
  return (
    <Card className="overflow-hidden">
      <form onSubmit={event => {
        event.preventDefault();
        if (dirty && !save.isPending) save.mutate({
          affEnabled: form.affEnabled,
          affRateNew: form.affRateNew,
          affRateRenew: form.affRateRenew,
          affFreezeDays: form.affFreezeDays,
          affMinWithdraw: form.affMinWithdraw,
        });
      }}>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-4 border-b border-line bg-linear-to-r from-surface-2 to-surface px-4 py-4 sm:px-5">
          <div className="flex min-w-0 flex-[1_1_20rem] items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-surface text-fg-2">
              <Users aria-hidden className="size-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] leading-5 font-semibold text-fg">{t('adminAff.settingsTitle')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-fg-3">{t('adminAff.settingsDescription')}</p>
            </div>
          </div>
          <Switch checked={form.affEnabled} onCheckedChange={v => set('affEnabled', v)} label={t('adminSettings.affEnabledLabel')} />
        </div>

        <div className="grid gap-5 p-4 sm:p-5 lg:grid-cols-2 lg:gap-0">
          <fieldset className="min-w-0 lg:pr-6 xl:pr-8">
            <legend className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Percent aria-hidden className="size-4 text-fg-3" />{t('adminAff.ratesTitle')}
            </legend>
            <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
              <FormField label={t('adminSettings.affRateNew')} description={t('adminAff.newRateHint')}>
                <InputGroup type="number" min={0} max={100} step={0.1} required value={String(form.affRateNew)} onChange={e => set('affRateNew', Number(e.target.value))} suffix="%" className="h-11 text-lg font-semibold tabular" />
              </FormField>
              <FormField label={t('adminSettings.affRateRenew')} description={t('adminAff.renewRateHint')}>
                <InputGroup type="number" min={0} max={100} step={0.1} required value={String(form.affRateRenew)} onChange={e => set('affRateRenew', Number(e.target.value))} suffix="%" className="h-11 text-lg font-semibold tabular" />
              </FormField>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-fg-3">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-4" />
              {t('adminAff.commissionBasis')}
            </p>
          </fieldset>

          <fieldset className="min-w-0 border-t border-line pt-5 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6 xl:pl-8">
            <legend className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
              <Clock3 aria-hidden className="size-4 text-fg-3" />{t('adminAff.settlementTitle')}
            </legend>
            <div className="grid grid-cols-1 gap-4 min-[420px]:grid-cols-2">
              <FormField label={t('adminSettings.affFreezeDays')} description={t('adminAff.freezeHint')}>
                <InputGroup type="number" min={0} max={365} step={1} required value={String(form.affFreezeDays)} onChange={e => set('affFreezeDays', Number(e.target.value))} suffix={t('batch.daysUnit')} className="h-11 text-lg font-semibold tabular" />
              </FormField>
              <FormField label={t('adminSettings.affMinWithdraw')} description={t('adminAff.withdrawHint')}>
                <InputGroup type="number" min={0} step={0.01} required value={String(form.affMinWithdraw)} onChange={e => set('affMinWithdraw', Number(e.target.value))} prefix={form.currency} className="h-11 text-lg font-semibold tabular" />
              </FormField>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-fg-3">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0 text-fg-4" />
              {t('adminAff.refundHint')}
            </p>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 sm:px-5">
          <span aria-live="polite" className="flex items-center gap-1.5 text-xs text-fg-3">
            {dirty ? <span aria-hidden className="size-1.5 rounded-full bg-warning-icon" /> : <CircleCheck aria-hidden className="size-3.5 text-fg-4" />}
            {t(dirty ? 'common.unsaved' : 'common.saved')}
          </span>
          <Button type="submit" variant="primary" icon={<Save />} disabled={!dirty} loading={save.isPending} className="ml-auto">{t('common.saveChanges')}</Button>
        </div>
      </form>
    </Card>
  );
}

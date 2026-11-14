import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AdminSettingsDTO, SiteSettings } from '@/shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { InputGroup } from '@/components/ui/input';
import { Card, CardBody, ErrorState, FormRow, PageLoading, Switch } from '@/components/ui/misc';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { toast } from '@/lib/toast';
import { AffRecords } from './AffRecords';

type AffSettings = Pick<SiteSettings, 'affEnabled' | 'affRateNew' | 'affRateRenew' | 'affFreezeDays' | 'affMinWithdraw'>;

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
    <Card>
      <CardBody>
        <FormRow label={t('adminSettings.affEnabled')} hint={t('adminSettings.affEnabledHint')}>
          <Switch checked={form.affEnabled} onCheckedChange={v => set('affEnabled', v)} label={t('adminSettings.affEnabledLabel')} />
        </FormRow>
        <FormRow label={t('adminSettings.affRateNew')} hint={t('adminSettings.affRateNewHint')}>
          <InputGroup type="number" min={0} max={100} step={0.1} value={String(form.affRateNew)} onChange={e => set('affRateNew', Number(e.target.value))} suffix="%" className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.affRateRenew')} hint={t('adminSettings.affRateRenewHint')}>
          <InputGroup type="number" min={0} max={100} step={0.1} value={String(form.affRateRenew)} onChange={e => set('affRateRenew', Number(e.target.value))} suffix="%" className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.affFreezeDays')} hint={t('adminSettings.affFreezeDaysHint')}>
          <InputGroup type="number" min={0} max={365} value={String(form.affFreezeDays)} onChange={e => set('affFreezeDays', Number(e.target.value))} suffix={t('batch.daysUnit')} className="w-32" />
        </FormRow>
        <FormRow label={t('adminSettings.affMinWithdraw')} hint={t('adminSettings.affMinWithdrawHint')}>
          <InputGroup type="number" min={0} value={String(form.affMinWithdraw)} onChange={e => set('affMinWithdraw', Number(e.target.value))} prefix={form.currency} className="w-32" />
        </FormRow>
        <div className="mt-4 flex justify-end border-t border-line pt-4">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate({
            affEnabled: form.affEnabled,
            affRateNew: form.affRateNew,
            affRateRenew: form.affRateRenew,
            affFreezeDays: form.affFreezeDays,
            affMinWithdraw: form.affMinWithdraw,
          })}>{t('common.save')}</Button>
        </div>
      </CardBody>
    </Card>
  );
}

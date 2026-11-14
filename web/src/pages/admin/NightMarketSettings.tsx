import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Diamond, Pencil, Plus, Trash } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { BILLING_CYCLES, NIGHT_QUALITIES, NIGHT_DISCOUNT_MODES, nightCatalogStats, validNightCatalog, validNightDrawRules, type AdminNightMarketDTO, type AdminPlanDTO, type AdminProductDTO, type NightConfig, type NightPrize, type NightDrawRules } from '../../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { Alert, Badge, Card, CardBody, CardHeader, Empty, ErrorState, PageLoading, Switch } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatDate, formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

const colors = { SELECT: '#21965b', DELUXE: '#3983ce', PREMIUM: '#9872c6', EXCLUSIVE: '#b58a35' };
const localDateTime = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function PrizeEditor({ prize, plans, products, onApply, onClose }: { prize: NightPrize; plans: AdminPlanDTO[]; products: AdminProductDTO[]; onApply: (prize: NightPrize) => void; onClose: () => void }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [form, setForm] = useState(prize);
  const set = <K extends keyof NightPrize>(key: K, value: NightPrize[K]) => setForm(current => ({ ...current, [key]: value }));
  const plan = plans.find(p => p.id === form.planId);
  const cycles = BILLING_CYCLES.filter(cycle => Number(plan?.prices[cycle]) > 0);
  const validRange = Number.isInteger(form.discountMin) && Number.isInteger(form.discountMax) && form.discountMin >= 1 && form.discountMax <= 99 && form.discountMin <= form.discountMax;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.groupKey.trim() || !cycles.includes(form.cycle) || !validRange) return;
    onApply({ ...form, name: form.name.trim(), description: form.description.trim(), groupKey: form.groupKey.trim() });
  };
  return <Card className="border-line-strong"><CardHeader title={t('night.editPrize')} /><CardBody>
    <form onSubmit={submit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FormField required label={t('night.name')}><Input autoFocus required maxLength={80} value={form.name} onChange={event => set('name', event.target.value)} /></FormField>
        <FormField required label={t('night.plan')}><Select aria-label={t('night.plan')} value={form.planId || null} options={plans.map(p => ({ value: p.id, label: `${products.find(product => product.id === p.productId)?.name ?? p.productId} / ${p.name}`, disabled: !p.enabled || !BILLING_CYCLES.some(c => Number(p.prices[c]) > 0) }))} onChange={id => {
          const next = plans.find(p => p.id === id)!;
          setForm(current => ({ ...current, planId: id, cycle: BILLING_CYCLES.find(c => Number(next.prices[c]) > 0) ?? 'MONTHLY', name: current.name || next.name, groupKey: current.groupKey || `product-${next.productId}` }));
        }} /></FormField>
        <FormField required label={t('night.cycle')}><Select aria-label={t('night.cycle')} value={form.cycle} options={cycles.map(c => ({ value: c, label: `${L.billingCycle[c]} · ${formatMoney(plan!.prices[c]!, currency)}` }))} onChange={value => set('cycle', value)} /></FormField>
        <FormField label={t('night.quality')}><Select aria-label={t('night.quality')} value={form.quality} options={NIGHT_QUALITIES.map(quality => ({ value: quality, label: <span className="flex items-center gap-2"><Diamond className="size-3" style={{ color: colors[quality] }} />{t(`night.quality.${quality}`)}</span> }))} onChange={value => set('quality', value)} /></FormField>
        <FormField required label={t('night.group')} description={t('night.groupHint')}><Input required maxLength={80} value={form.groupKey} onChange={event => set('groupKey', event.target.value)} /></FormField>
        <FormField required label={t('night.eligibleFromPeriod')} description={t('night.eligibleFromPeriodHint')}><Input required type="number" min={1} max={1000000} step={1} value={form.eligibleFromPeriod} onChange={event => set('eligibleFromPeriod', Number(event.target.value))} /></FormField>
        <FormField required label={t('night.discountMin')} description={t('night.discountRangeHint')}><Input required type="number" min={1} max={99} step={1} value={form.discountMin} onChange={event => set('discountMin', Number(event.target.value))} /></FormField>
        <FormField required label={t('night.discountMax')}><Input required type="number" min={form.discountMin || 1} max={99} step={1} value={form.discountMax} onChange={event => set('discountMax', Number(event.target.value))} /></FormField>
        <FormField label={t('night.discountMode')}><Select aria-label={t('night.discountMode')} value={form.discountMode} options={NIGHT_DISCOUNT_MODES.map(mode => ({ value: mode, label: t(`night.mode.${mode}`), description: t(`night.modeHint.${mode}`) }))} onChange={value => set('discountMode', value)} /></FormField>
      </div>
      {!validRange && <Alert tone="warning">{t('night.invalidDiscountRange')}</Alert>}
      <FormField label={t('night.description')}><Textarea maxLength={400} rows={2} value={form.description} onChange={event => set('description', event.target.value)} /></FormField>
      <div className="flex flex-wrap items-center justify-between gap-3"><Switch checked={form.enabled} onCheckedChange={value => set('enabled', value)} label={t('night.prizeEnabled')} /><div className="flex gap-2"><Button onClick={onClose}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={!form.planId || !cycles.includes(form.cycle) || !validRange}>{t('common.confirm')}</Button></div></div>
    </form>
  </CardBody></Card>;
}

function NightEditor({ initial, plans, products }: { initial: AdminNightMarketDTO; plans: AdminPlanDTO[]; products: AdminProductDTO[] }) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const qc = useQueryClient();
  const [form, setForm] = useState<NightConfig>(initial.config);
  const [startsAt, setStartsAt] = useState(localDateTime(initial.config.startsAt));
  const [editing, setEditing] = useState<NightPrize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof NightConfig>(key: K, value: NightConfig[K]) => setForm(current => ({ ...current, [key]: value }));
  const eligible = form.prizes.filter(p => {
    const plan = plans.find(plan => plan.id === p.planId);
    return p.enabled && p.eligibleFromPeriod <= initial.draftPeriodNumber && plan?.enabled && products.some(product => product.id === plan.productId && product.enabled) && Number(plan.prices[p.cycle]) > 0;
  });
  const rules = form.drawRules;
  const setRule = <K extends keyof NightDrawRules>(key: K, value: NightDrawRules[K]) => setForm(current => ({ ...current, drawRules: { ...current.drawRules, [key]: value } }));
  const stats = nightCatalogStats(eligible, rules);
  const validRules = validNightDrawRules(rules);
  const valid = validNightCatalog(eligible, rules);
  const probabilityTotal = NIGHT_QUALITIES.reduce((sum, q) => sum + rules.qualityProbabilities[q], 0);
  const save = useMutation({
    mutationFn: () => api.put<AdminNightMarketDTO>('/admin/night-market', { ...form, startsAt: new Date(startsAt).toISOString() }),
    onSuccess: data => {
      qc.setQueryData(['admin-night-market'], data); setForm(data.config); setError(null);
      for (const key of ['public-config', 'night-market', 'night-offer']) void qc.invalidateQueries({ queryKey: [key] });
      toast.success(t('common.saved'));
    },
    onError: error => setError(errorText(error)),
  });
  const add = () => {
    const plan = plans.find(p => p.enabled && BILLING_CYCLES.some(c => Number(p.prices[c]) > 0));
    if (!plan) { toast.error(t('night.noPlan')); return; }
    setEditing({ id: crypto.randomUUID(), name: plan.name, description: '', planId: plan.id, cycle: BILLING_CYCLES.find(c => Number(plan.prices[c]) > 0)!, quality: 'SELECT', groupKey: `product-${plan.productId}`, eligibleFromPeriod: initial.draftPeriodNumber, discountMin: 10, discountMax: 49, discountMode: 'ONCE', enabled: true });
  };
  return <div className="space-y-5">
    <Card><CardHeader title={t('night.settings')} actions={<Switch checked={form.enabled} disabled={save.isPending} onCheckedChange={value => set('enabled', value)} label={t('night.enabled')} />} /><CardBody className="space-y-4">
      <form id="night-market-settings" onSubmit={event => { event.preventDefault(); if (!save.isPending && !editing && validRules && form.activeHours <= form.refreshHours && (!form.enabled || valid)) save.mutate(); }} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <FormField required label={t('night.startsAt')}><Input required type="datetime-local" value={startsAt} onChange={event => setStartsAt(event.target.value)} /></FormField>
        <FormField required label={t('night.refreshHours')}><Input required type="number" min={1} max={8760} step={1} value={form.refreshHours} onChange={event => set('refreshHours', Number(event.target.value))} /></FormField>
        <FormField required label={t('night.activeHours')}><Input required type="number" min={1} max={form.refreshHours} step={1} value={form.activeHours} onChange={event => set('activeHours', Number(event.target.value))} /></FormField>
        <FormField label={t('night.currentPeriod')} description={t('night.currentPeriodHint')}><Input readOnly value={initial.period ? t('night.period', { id: initial.period.number }) : t('night.notStarted')} /></FormField>
      </form>
      <p className="text-xs leading-6 text-fg-3">{t('night.scheduleHint')}</p>
      <Alert>{t('night.freezeHint')}</Alert>
      {initial.period && <p className="text-xs text-fg-3">{t('night.activePeriod', { id: initial.period.number, time: formatDate(initial.period.closesAt) })}</p>}
    </CardBody></Card>
    <Card><CardHeader title={t('night.drawRules')} description={t('night.drawRulesHint')} /><CardBody className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-medium text-fg">{t('night.guarantee')}</h3><p className="mt-1 text-xs text-fg-3">{t('night.guaranteeHint')}</p></div><Switch checked={rules.guaranteeEnabled} disabled={save.isPending} onCheckedChange={value => setRule('guaranteeEnabled', value)} label={t('night.guaranteeEnabled')} /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField required={rules.guaranteeEnabled} label={t('night.guaranteeCount')}><Input form="night-market-settings" required={rules.guaranteeEnabled} disabled={!rules.guaranteeEnabled || save.isPending} type="number" min={1} max={6} step={1} value={rules.guaranteeCount} onChange={event => setRule('guaranteeCount', Number(event.target.value))} /></FormField>
        <FormField label={t('night.guaranteeQuality')}><Select aria-label={t('night.guaranteeQuality')} disabled={!rules.guaranteeEnabled || save.isPending} value={rules.guaranteeQuality} options={NIGHT_QUALITIES.map(quality => ({ value: quality, label: t(`night.quality.${quality}`), description: t('night.qualityOrHigher', { quality: t(`night.quality.${quality}`) }) }))} onChange={value => setRule('guaranteeQuality', value)} /></FormField>
      </div>
      <div className="space-y-3 border-t border-line pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-fg">{t('night.qualityProbabilities')}</h3><Badge tone={probabilityTotal === 100 ? 'success' : 'warning'}>{t('night.probabilityTotal', { total: probabilityTotal })}</Badge></div>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{NIGHT_QUALITIES.map(quality => <FormField key={quality} required label={<span className="inline-flex items-center gap-1.5 align-middle"><Diamond className="size-3.5" style={{ color: colors[quality] }} />{t(`night.quality.${quality}`)}</span>} description={t('night.qualityPrizeCount', { count: eligible.filter(p => p.quality === quality).length })}>
          <InputGroup form="night-market-settings" aria-label={t('night.qualityProbability', { quality: t(`night.quality.${quality}`) })} suffix="%" required disabled={save.isPending} type="number" min={0} max={100} step={1} value={rules.qualityProbabilities[quality]} onChange={event => setForm(current => ({ ...current, drawRules: { ...current.drawRules, qualityProbabilities: { ...current.drawRules.qualityProbabilities, [quality]: Number(event.target.value) } } }))} />
        </FormField>)}</div>
        <p className="text-xs leading-6 text-fg-3">{t('night.probabilityHint')}</p>
        {!validRules && <Alert tone="warning">{t('night.invalidDrawRules')}</Alert>}
      </div>
    </CardBody></Card>
    <Card><CardHeader title={t('night.prizes')} description={t('night.draftHint')} actions={<Button icon={<Plus />} onClick={add} disabled={save.isPending || form.prizes.length >= 200}>{t('night.addPrize')}</Button>} /><CardBody className="space-y-3">
      <p className="text-sm font-medium text-fg">{t('night.draftPeriod', { id: initial.draftPeriodNumber })} · {t('night.eligibleSummary', { count: stats.eligibleCount, capacity: stats.groupCapacity })}</p>
      {rules.guaranteeEnabled && <p className="text-xs text-fg-3">{t('night.guaranteeSummary', { quality: t(`night.quality.${rules.guaranteeQuality}`), capacity: stats.guaranteeCapacity, count: rules.guaranteeCount })}</p>}
      <p className="text-xs leading-6 text-fg-3">{t('night.eligibilityHint', { id: initial.draftPeriodNumber })}</p>
      {validRules && !valid && <Alert tone="warning">{t('night.poolRequirement')}</Alert>}
      {!form.prizes.length && !editing && <Empty title={t('night.emptyPrizes')} />}
      {!!form.prizes.length && <div className="divide-y divide-line rounded-lg border border-line">{form.prizes.map(prize => {
        const plan = plans.find(plan => plan.id === prize.planId);
        return <div key={prize.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-3"><Diamond className="size-4" style={{ color: colors[prize.quality] }} /></span>
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm break-all">{prize.name}</strong><Badge>{t(`night.quality.${prize.quality}`)}</Badge><Badge tone={!prize.enabled ? 'neutral' : stats.eligibleIds.includes(prize.id) ? 'success' : 'warning'}>{!prize.enabled ? t('night.disabledPrize') : rules.qualityProbabilities[prize.quality] === 0 ? t('night.zeroProbability') : stats.eligibleIds.includes(prize.id) ? t('night.eligible') : prize.eligibleFromPeriod > initial.draftPeriodNumber ? t('night.availableFrom', { id: prize.eligibleFromPeriod }) : t('night.ineligible')}</Badge></div><p className="mt-1 text-xs break-all text-fg-3">{plan?.name ?? t('night.missingPlan')} · {L.billingCycle[prize.cycle]} · {plan?.prices[prize.cycle] ? formatMoney(plan.prices[prize.cycle]!, currency) : '—'} · {t('night.discountRange', { min: prize.discountMin, max: prize.discountMax })} · {t(`night.mode.${prize.discountMode}`)} · {prize.groupKey} · {t('night.availableFrom', { id: prize.eligibleFromPeriod })}</p></div>
          <div className="flex gap-1"><Button size="icon-sm" aria-label={t('common.edit')} disabled={save.isPending} onClick={() => setEditing(prize)}><Pencil /></Button><Button variant="danger-ghost" size="icon-sm" aria-label={t('common.delete')} disabled={save.isPending} onClick={() => { set('prizes', form.prizes.filter(p => p.id !== prize.id)); if (editing?.id === prize.id) setEditing(null); }}><Trash /></Button></div>
        </div>;
      })}</div>}
    </CardBody></Card>
    {editing && <PrizeEditor key={editing.id} prize={editing} plans={plans} products={products} onClose={() => setEditing(null)} onApply={prize => { set('prizes', form.prizes.some(p => p.id === prize.id) ? form.prizes.map(p => p.id === prize.id ? prize : p) : [...form.prizes, prize]); setEditing(null); toast.success(t('night.savedLocally')); }} />}
    {form.activeHours > form.refreshHours && <Alert tone="danger">{t('night.invalidDuration')}</Alert>}
    {error && <Alert tone="danger">{error}</Alert>}
    <div className="flex items-center justify-end gap-3 border-t border-line pt-4"><Button variant="primary" form="night-market-settings" type="submit" loading={save.isPending} disabled={!!editing || !validRules || form.activeHours > form.refreshHours || (form.enabled && !valid)}>{t('common.save')}</Button></div>
  </div>;
}

export default function NightMarketSettings() {
  const { t } = useI18n();
  const settings = useQuery({ queryKey: ['admin-night-market'], queryFn: () => api.get<AdminNightMarketDTO>('/admin/night-market') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<AdminPlanDTO[]>('/admin/plans') });
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  if (settings.isLoading || plans.isLoading || products.isLoading) return <PageLoading />;
  if (!settings.data || !plans.data || !products.data) return <ErrorState error={settings.error ?? plans.error ?? products.error} onRetry={() => void Promise.all([settings.refetch(), plans.refetch(), products.refetch()])} />;
  return <div><PageHeader title={t('night.adminTitle')} description={t('night.adminSubtitle')} /><NightEditor initial={settings.data} plans={plans.data} products={products.data} /></div>;
}

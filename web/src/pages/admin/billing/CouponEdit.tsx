import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BILLING_CYCLES, COUPON_MODES, COUPON_SCOPES, COUPON_TYPES, type AdminPlanDTO, type BillingCycle, type AdminProductDTO, type CouponDTO, type CouponMode, type CouponScope, type CouponType } from '../../../shared/index';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { Alert, Card, Checkbox, ErrorState, PageLoading } from '@/components/ui/misc';
import { MultiSelect, Select } from '@/components/ui/select';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatPrice } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

/** ISO 时间 ↔ datetime-local 输入框的本地时间 */
const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
const numText = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(Number(v)));

/** 选项框底色的勾选项 */
function CheckBox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5">
      <Checkbox checked={checked} onCheckedChange={onChange} label={label} />
      <p className="mt-0.5 pl-6 text-xs text-fg-3">{hint}</p>
    </div>
  );
}

function CouponForm({ coupon }: { coupon?: CouponDTO }) {
  const { t, L } = useI18n();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const currency = useCurrency();
  const products = useQuery({ queryKey: ['admin-products'], queryFn: () => api.get<AdminProductDTO[]>('/admin/products') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api.get<AdminPlanDTO[]>('/admin/plans') });
  const [f, setF] = useState({
    code: coupon?.code ?? '',
    name: coupon?.name ?? '',
    type: (coupon?.type ?? 'PERCENT') as CouponType,
    value: coupon ? numText(coupon.value) : '10',
    productIds: coupon?.productIds ?? [],
    planIds: coupon?.planIds ?? [],
    cycles: coupon?.cycles ?? null,
    minAmount: numText(coupon?.minAmount),
    maxDiscount: numText(coupon?.maxDiscount),
    mode: (coupon?.mode ?? 'ONCE') as CouponMode,
    maxUses: numText(coupon?.maxUses),
    perUser: numText(coupon?.perUser),
    scope: (coupon?.scope ?? 'NEW') as CouponScope,
    startsAt: toLocalInput(coupon?.startsAt ?? null),
    expiresAt: toLocalInput(coupon?.expiresAt ?? null),
    newUserOnly: coupon?.newUserOnly ?? false,
    enabled: coupon?.enabled ?? true,
    remark: coupon?.remark ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  // 只能从已选产品下挑选套餐；多个产品时名称前加产品名
  const productPlans = (plans.data ?? []).filter((p) => f.productIds.includes(p.productId));
  const productName = (id: number) => products.data?.find((p) => p.id === id)?.name ?? '';
  const count = (v: string) => (v.trim() ? Number(v) : null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: f.code.trim() || undefined,
        name: f.name.trim() || null,
        type: f.type,
        value: f.value,
        productIds: f.productIds.length ? f.productIds : null,
        planIds: f.planIds.length ? f.planIds : null,
        cycles: f.cycles?.length ? f.cycles : null,
        minAmount: Number(f.minAmount) > 0 ? f.minAmount : null,
        maxDiscount: f.type === 'PERCENT' && f.maxDiscount.trim() ? f.maxDiscount : null,
        mode: f.mode,
        maxUses: count(f.maxUses),
        perUser: count(f.perUser),
        scope: f.scope,
        startsAt: fromLocalInput(f.startsAt),
        expiresAt: fromLocalInput(f.expiresAt),
        newUserOnly: f.newUserOnly,
        enabled: f.enabled,
        remark: f.remark.trim() || null,
      };
      return coupon ? api.patch<CouponDTO>(`/admin/coupons/${coupon.id}`, body) : api.post<CouponDTO>('/admin/coupons', body);
    },
    onSuccess: (c) => {
      toast.success(coupon ? t('common.saved') : t('coupon.created', { code: c.code }));
      void qc.invalidateQueries({ queryKey: ['admin-coupons'] });
      void qc.invalidateQueries({ queryKey: ['admin-coupon', c.id] });
      navigate('/admin/promotions');
    },
    onError: (e) => setError(errorText(e)),
  });

  return (
    <Card className="p-5">
      <form
        className="grid gap-x-4 gap-y-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormField label={t('coupon.code')} description={coupon ? undefined : t('coupon.codeHint')}>
          <Input value={f.code} onChange={(e) => set('code', e.target.value.toUpperCase())} className="font-mono" placeholder={t('coupon.codeAuto')} maxLength={32} />
        </FormField>
        <FormField label={t('coupon.name')}>
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder={t('coupon.namePlaceholder')} maxLength={64} />
        </FormField>

        <FormField label={t('coupon.type')}>
          <Select<CouponType>
            value={f.type}
            onChange={(v) => set('type', v)}
            options={COUPON_TYPES.map((x) => ({ value: x, label: t(`coupon.type.${x}`), description: t(`coupon.typeDesc.${x}`) }))}
          />
        </FormField>
        <FormField label={f.type === 'PERCENT' ? t('coupon.percent') : t('coupon.amount')} required>
          {f.type === 'PERCENT' ? (
            <InputGroup type="number" min={0.01} max={100} step="0.01" suffix="%" value={f.value} onChange={(e) => set('value', e.target.value)} />
          ) : (
            <InputGroup type="number" min={0.01} step="0.01" prefix={currency} value={f.value} onChange={(e) => set('value', e.target.value)} />
          )}
        </FormField>

        <FormField label={t('coupon.products')} description={t('coupon.productsHint')}>
          <MultiSelect<number>
            value={f.productIds}
            onChange={(v) =>
              // 取消某个产品时，一并去掉它下面已选的套餐
              setF((x) => ({ ...x, productIds: v, planIds: x.planIds.filter((id) => v.includes(plans.data?.find((p) => p.id === id)?.productId ?? -1)) }))
            }
            placeholder={t('coupon.allProducts')}
            options={(products.data ?? []).map((p) => ({ value: p.id, label: p.name, description: t('coupon.productPlans', { n: p.planCount }) }))}
          />
        </FormField>
        <FormField label={t('coupon.plans')} description={t('coupon.plansHint')}>
          <MultiSelect<number>
            value={f.planIds}
            disabled={!f.productIds.length}
            onChange={(v) => set('planIds', v)}
            placeholder={f.productIds.length ? t('coupon.allPlans') : t('coupon.pickProductFirst')}
            options={productPlans.map((p) => ({
              value: p.id,
              label: f.productIds.length > 1 ? `${productName(p.productId)} · ${p.name}` : p.name,
              description: formatPrice(p.prices.MONTHLY ?? Object.values(p.prices)[0] ?? 0, currency),
            }))}
          />
        </FormField>

        <FormField label={t('coupon.cycles')} description={t('coupon.cyclesHint')}>
          <MultiSelect<BillingCycle>
            value={f.cycles ?? []}
            onChange={(v) => set('cycles', v.length ? v : null)}
            placeholder={t('coupon.allCycles')}
            options={BILLING_CYCLES.map((c) => ({ value: c, label: L.billingCycle[c] }))}
          />
        </FormField>
        <FormField label={t('coupon.scope')}>
          <Select<CouponScope>
            value={f.scope}
            onChange={(v) => set('scope', v)}
            options={COUPON_SCOPES.map((s) => ({ value: s, label: t(`coupon.scope.${s}`), description: t(`coupon.scopeDesc.${s}`) }))}
          />
        </FormField>

        <FormField label={t('coupon.minAmount')} description={t('coupon.minAmountHint')}>
          <InputGroup type="number" min={0} step="0.01" prefix={currency} value={f.minAmount} onChange={(e) => set('minAmount', e.target.value)} placeholder="0" />
        </FormField>
        <FormField label={t('coupon.maxDiscount')} description={f.type === 'PERCENT' ? t('coupon.maxDiscountHint') : t('coupon.maxDiscountAmount')}>
          <InputGroup type="number" min={0.01} step="0.01" prefix={currency} value={f.type === 'PERCENT' ? f.maxDiscount : ''} disabled={f.type !== 'PERCENT'} onChange={(e) => set('maxDiscount', e.target.value)} placeholder={t('coupon.unlimited')} />
        </FormField>

        <FormField label={t('coupon.mode')}>
          <Select<CouponMode> value={f.mode} onChange={(v) => set('mode', v)} options={COUPON_MODES.map((m) => ({ value: m, label: t(`coupon.mode.${m}`), description: t(`coupon.modeDesc.${m}`) }))} />
        </FormField>
        <FormField label={t('coupon.maxUses')}>
          <Input type="number" min={1} value={f.maxUses} onChange={(e) => set('maxUses', e.target.value)} placeholder={t('coupon.unlimited')} />
        </FormField>

        <FormField label={t('coupon.perUser')}>
          <Input type="number" min={1} value={f.perUser} onChange={(e) => set('perUser', e.target.value)} placeholder={t('coupon.unlimited')} />
        </FormField>
        {/* 两列对齐：单用户次数旁边留空 */}
        <div className="hidden sm:block" />

        <FormField label={t('coupon.startsAt')}>
          <Input type="datetime-local" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
        </FormField>
        <FormField label={t('coupon.expiresAt')}>
          <Input type="datetime-local" value={f.expiresAt} onChange={(e) => set('expiresAt', e.target.value)} />
        </FormField>

        <CheckBox checked={f.newUserOnly} onChange={(v) => set('newUserOnly', v)} label={t('coupon.newUserOnly')} hint={t('coupon.newUserOnlyHint')} />
        <CheckBox
          checked={f.enabled}
          onChange={(v) => set('enabled', v)}
          label={coupon ? t('common.enable') : t('coupon.enableAfterCreate')}
          hint={t('coupon.enableHint')}
        />

        <FormField label={t('coupon.description')} className="sm:col-span-2">
          <Textarea rows={3} value={f.remark} onChange={(e) => set('remark', e.target.value)} placeholder={t('coupon.descriptionPlaceholder')} maxLength={200} />
        </FormField>

        <div className="flex items-center justify-end gap-2 sm:col-span-2">
          {error && (
            <Alert tone="danger" className="mr-auto py-1.5">
              {error}
            </Alert>
          )}
          <Button type="button" onClick={() => navigate('/admin/promotions')}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!Number(f.value)}>
            {coupon ? t('common.save') : t('coupon.create')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** 新建 / 编辑优惠码（/admin/promotions/coupons/new、/admin/promotions/coupons/:id） */
export default function CouponEdit() {
  const { t } = useI18n();
  const { id } = useParams();
  const editing = id && id !== 'new' ? Number(id) : null;
  const q = useQuery({ queryKey: ['admin-coupon', editing], queryFn: () => api.get<CouponDTO>(`/admin/coupons/${editing}`), enabled: editing !== null });
  return (
    <>
      <Link to="/admin/promotions" className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-fg-3 transition-colors hover:text-fg">
        <ArrowLeft className="size-3.5" />
        {t('nav.admin.promotions')}
      </Link>
      <PageHeader title={editing ? t('coupon.editTitle', { code: q.data?.code ?? '' }) : t('coupon.add')} description={t('coupon.pageDesc')} />
      {editing === null ? <CouponForm /> : q.isLoading ? <PageLoading /> : q.error || !q.data ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <CouponForm key={q.data.id} coupon={q.data} />}
    </>
  );
}

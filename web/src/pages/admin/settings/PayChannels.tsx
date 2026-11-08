// 系统设置 → 支付：支付渠道列表（易支付 / Stripe / Heleket 各可添加多个），每个渠道单独设置金额范围和手续费
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { EpayMethod, PayChannelDTO, PayChannelType, PayChannelsViewDTO } from '../../../shared/index';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { Checkbox, CopyButton, Empty, ErrorState, PageLoading, Switch, Tag } from '@/components/ui/misc';
import { Segmented } from '@/components/ui/tabs';
import { useT, type TFunction } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { useCurrency } from '@/lib/queries';
import { toast } from '@/lib/toast';

type Method = { method: EpayMethod; enabled: boolean; feePercent: number };
/** 编辑表单：渠道字段 + 要提交的新密钥（留空表示不修改） */
type FormState = Partial<PayChannelDTO> & {
  type: PayChannelType;
  name: string;
  enabled: boolean;
  sort: number;
  minAmount: number;
  maxAmount: number;
  feeFixed: number;
  [k: string]: unknown;
};

const QUERY_KEY = ['admin-pay-channels'];
const pct = (n: number) => `${n.toFixed(2)}%`;

export function PayChannels() {
  const t = useT();
  const currency = useCurrency();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.get<PayChannelsViewDTO>('/admin/pay-channels') });
  const [editing, setEditing] = useState<PayChannelDTO | 'new' | null>(null);
  const setData = (v: PayChannelsViewDTO) => {
    qc.setQueryData(QUERY_KEY, v);
    void qc.invalidateQueries({ queryKey: ['payment-options'] });
  };
  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.put<PayChannelsViewDTO>(`/admin/pay-channels/${id}/enabled`, { enabled }),
    onSuccess: (v, vars) => {
      setData(v);
      toast.success(vars.enabled ? t('payAdmin.enabledToast') : t('payAdmin.disabledToast'));
    },
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<PayChannelsViewDTO>(`/admin/pay-channels/${id}`),
    onSuccess: (v) => {
      setData(v);
      toast.success(t('payAdmin.deleted'));
    },
    onError: (e) => toast.fromError(e),
  });
  if (q.error) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (!q.data) return <PageLoading />;
  const list = q.data.channels;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
        <div>
          <h3 className="text-[15px] font-semibold text-fg">{t('payAdmin.channels')}</h3>
          <p className="mt-0.5 text-xs text-fg-3">{t('payAdmin.channelsHint')}</p>
        </div>
        <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
          {t('payAdmin.addChannel')}
        </Button>
      </div>

      {list.length === 0 ? (
        <div className="rounded-lg border border-line bg-surface">
          <Empty title={t('payAdmin.empty')} />
        </div>
      ) : (
        <div className="space-y-3">
          {list.map((c) => (
            <div key={c.id} className="row-in rounded-lg border border-line bg-surface px-5 py-4">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg">{c.name}</span>
                    <Tag tone={c.enabled ? 'success' : 'neutral'}>{c.enabled ? t('payAdmin.on') : t('payAdmin.off')}</Tag>
                    <Tag>{c.type === 'epay' ? `${t('payAdmin.type.epay')} ${c.version}` : t(`payAdmin.type.${c.type}`)}</Tag>
                    {c.type !== 'epay' && c.currency !== 'CNY' && <Tag>{c.currency}</Tag>}
                  </div>
                  <dl className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-4">
                    <Stat label={t('payAdmin.min')} value={formatMoney(c.minAmount, currency)} />
                    <Stat label={t('payAdmin.max')} value={c.maxAmount > 0 ? formatMoney(c.maxAmount, currency) : t('payAdmin.unlimited')} />
                    {c.type !== 'epay' && <Stat label={t('payAdmin.feePercent')} value={pct(c.feePercent)} />}
                    <Stat label={t('payAdmin.feeFixed')} value={formatMoney(c.feeFixed, currency)} />
                  </dl>
                  {c.type === 'epay' && (
                    <div className="mt-1.5 text-xs text-fg-3">
                      {t('payAdmin.methodsLine')}
                      {c.methods
                        .filter((m) => m.enabled)
                        .map((m) => `${t(`payAdmin.method.${m.method}`)}（${pct(m.feePercent)}）`)
                        .join('、') || t('payAdmin.noMethods')}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Switch checked={c.enabled} disabled={toggle.isPending} onCheckedChange={(v) => toggle.mutate({ id: c.id, enabled: v })} />
                  <Button variant="ghost" size="icon-sm" className="ml-2" aria-label={t('common.edit')} title={t('common.edit')} onClick={() => setEditing(c)}>
                    <Pencil />
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="icon-sm"
                    aria-label={t('common.delete')}
                    title={t('common.delete')}
                    onClick={async () => {
                      if (await confirm({ title: t('payAdmin.deleteTitle', { name: c.name }), description: t('payAdmin.deleteDesc'), confirmText: t('common.delete'), danger: true })) remove.mutate(c.id);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && <ChannelForm channel={editing === 'new' ? null : editing} nextSort={list.length} urls={q.data.urls} onClose={() => setEditing(null)} onSaved={setData} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-1.5">
      <dt className="text-fg-3">{label}</dt>
      <dd className="tabular text-fg">{value}</dd>
    </div>
  );
}

const defaults = (t: TFunction): Record<PayChannelType, Record<string, unknown>> => ({
  epay: {
    name: t('payAdmin.type.epay'),
    version: 'v1',
    mode: 'submit',
    apiUrl: '',
    pid: '',
    platformPublicKey: '',
    methods: [
      { method: 'alipay', enabled: true, feePercent: 0 },
      { method: 'wxpay', enabled: true, feePercent: 0 },
      { method: 'qqpay', enabled: false, feePercent: 0 },
    ],
  },
  stripe: { name: 'Stripe', feePercent: 0, currency: 'CNY' },
  heleket: { name: t('payAdmin.heleketDefaultName'), feePercent: 0, currency: 'CNY', merchantId: '', lifetime: 3600 },
});

/** 数字输入：输入过程中保留原文（如“1.”），对外只给数字 */
function NumField({ value, onChange, suffix, min, max, step, disabled, className }: { value: number; onChange: (v: number) => void; suffix?: ReactNode; min?: number; max?: number; step?: number; disabled?: boolean; className?: string }) {
  const [text, setText] = useState(String(value ?? 0));
  useEffect(() => {
    if (Number(text) !== value) setText(String(value ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <InputGroup
      type="number"
      inputMode="decimal"
      className={className ?? 'tabular'}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={text}
      suffix={suffix}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? n : 0);
      }}
    />
  );
}

function ChannelForm({ channel, nextSort, urls, onClose, onSaved }: { channel: PayChannelDTO | null; nextSort: number; urls: PayChannelsViewDTO['urls']; onClose: () => void; onSaved: (v: PayChannelsViewDTO) => void }) {
  const t = useT();
  const currency = useCurrency();
  const DEFAULTS = defaults(t);
  const [f, setF] = useState<FormState>(() => ({
    ...((channel as FormState | null) ?? { type: 'epay', enabled: true, sort: nextSort, minAmount: 1, maxAmount: 0, feeFixed: 0, ...DEFAULTS.epay } as FormState),
    key: '',
    merchantPrivateKey: '',
    secretKey: '',
    webhookSecret: '',
    apiKey: '',
  }));
  const [error, setError] = useState<string | null>(null);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const type = f.type;
  const methods = (f.methods as Method[] | undefined) ?? [];
  const setMethod = (i: number, patch: Partial<Method>) => set('methods', methods.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  // 换类型时带上该类型的默认值，已改过的通用字段（金额、费用、排序）保留
  const switchType = (next: PayChannelType) => setF((x) => ({ ...x, ...DEFAULTS[next], type: next, name: x.name === DEFAULTS[x.type].name ? (DEFAULTS[next].name as string) : x.name }));

  const save = useMutation({
    mutationFn: () => {
      const common = { type, name: f.name, enabled: f.enabled, sort: f.sort, minAmount: f.minAmount, maxAmount: f.maxAmount || 0, feeFixed: f.feeFixed || 0 };
      const body =
        type === 'epay'
          ? { ...common, version: f.version, mode: f.mode, apiUrl: f.apiUrl, pid: f.pid, key: f.key || undefined, merchantPrivateKey: f.merchantPrivateKey || undefined, platformPublicKey: f.platformPublicKey, methods: methods.map((m) => ({ ...m, feePercent: m.feePercent || 0 })) }
          : type === 'stripe'
            ? { ...common, feePercent: f.feePercent || 0, currency: f.currency, secretKey: f.secretKey || undefined, webhookSecret: f.webhookSecret || undefined }
            : { ...common, feePercent: f.feePercent || 0, currency: f.currency, merchantId: f.merchantId, apiKey: f.apiKey || undefined, lifetime: f.lifetime };
      return channel ? api.put<PayChannelsViewDTO>(`/admin/pay-channels/${channel.id}`, body) : api.post<PayChannelsViewDTO>('/admin/pay-channels', body);
    },
    onSuccess: (v) => {
      onSaved(v);
      toast.success(channel ? t('payAdmin.saved') : t('payAdmin.added'));
      onClose();
    },
    onError: (e) => setError(errorText(e)),
  });

  const has = (k: 'hasKey' | 'hasPrivateKey' | 'hasSecretKey' | 'hasWebhookSecret' | 'hasApiKey') => !!(channel as Record<string, unknown> | null)?.[k];
  const secretHint = (configured: boolean, help: string) => (configured ? t('payAdmin.secretKept') : help);
  const secretInput = (k: string) => <Input className="font-mono text-xs" type="password" autoComplete="new-password" value={String(f[k] ?? '')} onChange={(e) => set(k, e.target.value)} />;
  const yuan = currency;

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={channel ? t('payAdmin.editTitle', { name: channel.name }) : t('payAdmin.addTitle')}
      footer={
        <>
          <div className="mr-auto">
            <Switch checked={f.enabled} onCheckedChange={(v) => set('enabled', v)} label={t('payAdmin.on')} />
          </div>
          {error && <span className="min-w-0 truncate text-xs text-danger-text" title={error}>{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {channel ? t('common.save') : t('payAdmin.add')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!channel && (
          <FormField label={t('payAdmin.channelType')}>
            <Segmented
              value={type}
              onChange={switchType}
              items={[
                { value: 'epay', label: t('payAdmin.type.epay') },
                { value: 'stripe', label: 'Stripe' },
                { value: 'heleket', label: t('payAdmin.type.heleketLong') },
              ]}
            />
          </FormField>
        )}
        <FormField label={t('payAdmin.channelName')} required description={type === 'epay' ? t('payAdmin.channelNameEpayHint') : t('payAdmin.channelNameHint')}>
          <Input value={f.name} maxLength={32} onChange={(e) => set('name', e.target.value)} />
        </FormField>

        {type === 'epay' && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label={t('payAdmin.version')}>
                <Segmented
                  value={f.version as 'v1' | 'v2'}
                  onChange={(v) => set('version', v)}
                  items={[
                    { value: 'v1', label: t('payAdmin.versionV1') },
                    { value: 'v2', label: t('payAdmin.versionV2') },
                  ]}
                />
              </FormField>
              <FormField label={t('payAdmin.mode')} description={t('payAdmin.modeHint')}>
                <Segmented
                  value={f.mode as 'submit' | 'api'}
                  onChange={(v) => set('mode', v)}
                  items={[
                    { value: 'submit', label: t('payAdmin.modeSubmit') },
                    { value: 'api', label: t('payAdmin.modeApi') },
                  ]}
                />
              </FormField>
            </div>
            <FormField label={t('payAdmin.epayUrl')} required description={t('payAdmin.epayUrlHint')}>
              <Input className="font-mono text-xs" value={String(f.apiUrl ?? '')} onChange={(e) => set('apiUrl', e.target.value)} placeholder="https://pay.example.com" />
            </FormField>
            <FormField label={t('payAdmin.epayPid')} required>
              <Input className="font-mono text-xs" value={String(f.pid ?? '')} onChange={(e) => set('pid', e.target.value)} />
            </FormField>
            {f.version === 'v1' ? (
              <FormField label={t('payAdmin.epayKey')} required={!has('hasKey')} description={secretHint(has('hasKey'), t('payAdmin.epayKeyHint'))}>
                {secretInput('key')}
              </FormField>
            ) : (
              <>
                <FormField label={t('payAdmin.privateKey')} required={!has('hasPrivateKey')} description={secretHint(has('hasPrivateKey'), t('payAdmin.privateKeyHint'))}>
                  <Textarea rows={4} className="font-mono text-xs" value={String(f.merchantPrivateKey ?? '')} onChange={(e) => set('merchantPrivateKey', e.target.value)} />
                </FormField>
                <FormField label={t('payAdmin.publicKey')} required description={t('payAdmin.publicKeyHint')}>
                  <Textarea rows={3} className="font-mono text-xs" value={String(f.platformPublicKey ?? '')} onChange={(e) => set('platformPublicKey', e.target.value)} />
                </FormField>
              </>
            )}
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-fg-2">{t('payAdmin.methods')}</div>
              <div className="divide-y divide-line rounded-lg border border-line">
                {methods.map((m, i) => (
                  <div key={m.method} className="flex items-center gap-3 px-3.5 py-2">
                    <div className="flex-1">
                      <Checkbox checked={m.enabled} onCheckedChange={(v) => setMethod(i, { enabled: v })} label={t(`payAdmin.method.${m.method}`)} />
                    </div>
                    <span className="text-xs text-fg-3">{t('payAdmin.feePercent')}</span>
                    <div className="w-28">
                      <NumField value={m.feePercent} min={0} max={100} step={0.1} suffix="%" disabled={!m.enabled} onChange={(v) => setMethod(i, { feePercent: v })} />
                    </div>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-xs text-fg-3">{t('payAdmin.methodsHint')}</p>
            </div>
          </>
        )}

        {type === 'stripe' && (
          <>
            <FormField label={t('payAdmin.stripeKey')} required={!has('hasSecretKey')} description={secretHint(has('hasSecretKey'), t('payAdmin.stripeKeyHint'))}>
              {secretInput('secretKey')}
            </FormField>
            <FormField label={t('payAdmin.webhookUrl')} description={t('payAdmin.webhookUrlHint')}>
              <CopyInput value={urls.stripeWebhook} />
            </FormField>
            <FormField label={t('payAdmin.webhookSecret')} required={!has('hasWebhookSecret')} description={secretHint(has('hasWebhookSecret'), t('payAdmin.webhookSecretHint'))}>
              {secretInput('webhookSecret')}
            </FormField>
            <CurrencyField value={String(f.currency ?? 'CNY')} onChange={(v) => set('currency', v)} hint={t('payAdmin.currencyHintStripe')} />
          </>
        )}

        {type === 'heleket' && (
          <>
            <FormField label={t('payAdmin.merchantId')} required description={t('payAdmin.merchantIdHint')}>
              <Input className="font-mono text-xs" value={String(f.merchantId ?? '')} onChange={(e) => set('merchantId', e.target.value)} />
            </FormField>
            <FormField label={t('payAdmin.apiKey')} required={!has('hasApiKey')} description={secretHint(has('hasApiKey'), t('payAdmin.apiKeyHint'))}>
              {secretInput('apiKey')}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <CurrencyField value={String(f.currency ?? 'CNY')} onChange={(v) => set('currency', v)} hint={t('payAdmin.currencyHintHeleket')} />
              <FormField label={t('payAdmin.lifetime')} description={t('payAdmin.lifetimeHint')}>
                <NumField value={Number(f.lifetime ?? 3600)} min={300} max={43200} step={60} suffix={t('payAdmin.seconds')} onChange={(v) => set('lifetime', Math.round(v))} />
              </FormField>
            </div>
          </>
        )}

        <div className="grid gap-4 border-t border-line pt-4 sm:grid-cols-2">
          <FormField label={t('payAdmin.min')}>
            <NumField value={f.minAmount} min={0.01} step={1} suffix={yuan} onChange={(v) => set('minAmount', v)} />
          </FormField>
          <FormField label={t('payAdmin.max')} description={t('payAdmin.maxHint')}>
            <NumField value={f.maxAmount} min={0} step={100} suffix={yuan} onChange={(v) => set('maxAmount', v)} />
          </FormField>
          {type !== 'epay' && (
            <FormField label={t('payAdmin.feePercent')}>
              <NumField value={Number(f.feePercent ?? 0)} min={0} max={100} step={0.1} suffix="%" onChange={(v) => set('feePercent', v)} />
            </FormField>
          )}
          <FormField label={t('payAdmin.feeFixed')} description={t('payAdmin.feeFixedHint')}>
            <NumField value={f.feeFixed} min={0} step={0.1} suffix={yuan} onChange={(v) => set('feeFixed', v)} />
          </FormField>
          <FormField label={t('payAdmin.sort')} description={t('payAdmin.sortHint')}>
            <NumField value={f.sort} min={0} step={1} onChange={(v) => set('sort', Math.max(0, Math.round(v || 0)))} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

function CurrencyField({ value, onChange, hint }: { value: string; onChange: (v: string) => void; hint: string }) {
  const t = useT();
  return (
    <FormField label={t('payAdmin.currency')} description={hint}>
      <Input className="w-28 font-mono uppercase" maxLength={3} value={value} onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} />
    </FormField>
  );
}

function CopyInput({ value }: { value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input readOnly className="font-mono text-xs" value={value} onFocus={(e) => e.target.select()} />
      <CopyButton value={value} />
    </div>
  );
}

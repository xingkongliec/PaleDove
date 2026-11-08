import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Search, Trash, X } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { useNavigate } from 'react-router';
import {
  BOOT_AUTOSTART_MODES,
  BOOT_LIMITS,
  DEFAULT_BOOT_OPTIONS,
  INSTANCE_TYPES,
  isNatType,
  isPublicIpv4Mode,
  TRAFFIC_MULTIPLIER_MAX,
  TRAFFIC_MULTIPLIER_MIN,
  type AdminProductDTO,
  type BootAutostart,
  type BootOptions,
  type InstanceType,
  type NodeDTO,
  type StoragePoolDTO,
} from '../../../shared/index';
import { CountryFlag } from '@/components/country';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Alert, Card, SwitchRow } from '@/components/ui/misc';
import { useI18n } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { MODE_LABEL } from '../nodes/NodeForm';
import { Block, GRID, ToggleGroup, toggleRow } from './product-ui';

/** 标签输入：回车或逗号添加，点击 × 移除 */
function TagInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const commit = () => {
    const tag = draft.trim();
    if (tag && !value.includes(tag) && value.length < 8) onChange([...value, tag]);
    setDraft('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line bg-surface px-2 py-1.5 focus-within:border-line-strong focus-within:ring-2 focus-within:ring-ring">
      {value.map((tag) => (
        <span key={tag} className="inline-flex items-center gap-1 rounded bg-surface-3 py-0.5 pr-1 pl-2 text-xs text-fg">
          {tag}
          <button type="button" aria-label={t('common.delete')} className="rounded text-fg-4 hover:text-fg" onClick={() => onChange(value.filter((x) => x !== tag))}>
            <X className="size-3" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        maxLength={32}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={value.length ? '' : t('products.tagsPlaceholder')}
        className="min-w-24 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
      />
    </div>
  );
}

const nodeDot: Record<NodeDTO['status'], string> = { ONLINE: 'bg-success', OFFLINE: 'bg-danger', PENDING: 'bg-warning', UNKNOWN: 'bg-fg-4' };

/** 宿主机多选：可搜索的紧凑卡片网格 */
function NodePicker({ value, onChange, type, wide }: { value: number[]; onChange: (v: number[]) => void; type: InstanceType; wide?: boolean }) {
  const { t, L } = useI18n();
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes') });
  const [q, setQ] = useState('');
  if (nodes.isLoading) return null;
  if (!nodes.data?.length) return <Alert tone="neutral">{t('plans.noNodes')}</Alert>;
  const kw = q.trim().toLowerCase();
  const list = nodes.data.filter((n) => !kw || [n.name, n.region, n.country, n.publicIp].some((s) => s.toLowerCase().includes(kw)));
  return (
    <div className="overflow-hidden rounded-lg border border-line">
      <div className="flex h-9 items-center gap-2 border-b border-line bg-surface-2/60 px-3">
        <Search className="size-3.5 shrink-0 text-fg-4" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('products.nodeSearch')}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
        />
        <span className="shrink-0 text-xs text-fg-3">{t('products.nodeSelected', { n: value.length })}</span>
      </div>
      <div className={cn('grid max-h-72 gap-1.5 overflow-y-auto p-1.5 sm:grid-cols-2', wide && 'xl:grid-cols-3')}>
        {list.map((n) => {
          const checked = value.includes(n.id);
          const fits = isPublicIpv4Mode(n.networkMode) === !isNatType(type);
          return (
            <button
              key={n.id}
              type="button"
              role="checkbox"
              aria-checked={checked}
              disabled={!fits && !checked}
              title={fits ? undefined : t('products.nodeMismatch')}
              onClick={() => onChange(checked ? value.filter((x) => x !== n.id) : [...value, n.id])}
              className={cn(
                'flex min-w-0 items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45',
                checked ? (fits ? 'border-line-strong bg-surface-2' : 'border-warning/60 bg-warning-soft') : 'border-transparent hover:not-disabled:bg-surface-2/70',
              )}
            >
              <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', checked ? 'border-primary bg-primary text-primary-fg' : 'border-line-strong')}>
                {checked && <Check className="size-3" strokeWidth={3} />}
              </span>
              <CountryFlag code={n.country} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[13px] font-medium text-fg">{n.name}</span>
                  <span className={cn('size-1.5 shrink-0 rounded-full', nodeDot[n.status])} title={L.nodeStatus[n.status]} />
                </span>
                <span className="block truncate text-[11px] text-fg-3">
                  {n.region} · {t(MODE_LABEL[n.networkMode])} · {fits ? t('products.nodeInstances', { n: n.instanceCount }) : t('products.nodeMismatchShort')}
                </span>
              </span>
            </button>
          );
        })}
        {!list.length && <p className="col-span-full px-2 py-3 text-[13px] text-fg-3">{t('products.noMatch')}</p>}
      </div>
    </div>
  );
}

const DEFAULT_POOL = '__default__';
const OPTION_COLS = 'sm:grid-cols-[minmax(0,1fr)_13rem_7rem]';

/** 一台已绑定宿主机的设置：系统盘存储池与流量倍率 */
function NodeOptionRow({ nodeId, value, onChange }: { nodeId: number; value: NodeOptionForm; onChange: (v: NodeOptionForm) => void }) {
  const { t } = useI18n();
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes') });
  const node = nodes.data?.find((n) => n.id === nodeId);
  // 存储池列表从宿主机实时读取；读取失败时改为手动填写
  const pools = useQuery({
    queryKey: ['node-pools', nodeId],
    queryFn: () => api.get<StoragePoolDTO[]>(`/admin/nodes/${nodeId}/storage-pools`),
    enabled: !!node && node.status !== 'PENDING',
    retry: false,
  });
  const rootPools = (pools.data ?? []).filter((p) => p.usage === 'root');
  const defaultPool = rootPools.find((p) => p.isDefault)?.name ?? node?.storagePool;
  const multiplier = Number(value.trafficMultiplier);
  const badMultiplier = value.trafficMultiplier !== '' && !(multiplier >= TRAFFIC_MULTIPLIER_MIN && multiplier <= TRAFFIC_MULTIPLIER_MAX);
  return (
    <div className={cn('grid items-center gap-x-3 gap-y-2 px-3 py-2', OPTION_COLS)}>
      <div className="flex min-w-0 items-center gap-2">
        <CountryFlag code={node?.country ?? ''} />
        <span className="truncate text-[13px] font-medium text-fg">{node?.name ?? `#${nodeId}`}</span>
        <span className="shrink-0 text-[11px] text-fg-4">#{nodeId}</span>
      </div>
      {pools.isError ? (
        <Input value={value.storagePool} onChange={(e) => onChange({ ...value, storagePool: e.target.value })} placeholder={t('instCreate.poolDefault')} aria-label={t('products.rootPool')} />
      ) : (
        <Select
          aria-label={t('products.rootPool')}
          value={value.storagePool || DEFAULT_POOL}
          onChange={(v) => onChange({ ...value, storagePool: v === DEFAULT_POOL ? '' : v })}
          options={[
            { value: DEFAULT_POOL, label: t('instCreate.poolDefault'), description: defaultPool ? t('instCreate.poolDefaultDesc', { name: defaultPool }) : undefined },
            // 已保存但宿主机上暂时没读到的存储池仍保留为选项
            ...(value.storagePool && !rootPools.some((p) => p.name === value.storagePool) ? [{ value: value.storagePool, label: value.storagePool }] : []),
            ...rootPools.map((p) => ({ value: p.name, label: p.name, description: `${p.driver}${p.isDefault ? ` · ${t('instCreate.poolIsDefault')}` : ''}` })),
          ]}
        />
      )}
      <InputGroup
        type="number"
        step="0.1"
        min={TRAFFIC_MULTIPLIER_MIN}
        max={TRAFFIC_MULTIPLIER_MAX}
        value={value.trafficMultiplier}
        onChange={(e) => onChange({ ...value, trafficMultiplier: e.target.value })}
        suffix="x"
        aria-label={t('products.multiplier')}
        aria-invalid={badMultiplier || undefined}
        title={t('products.multiplier')}
      />
    </div>
  );
}

/** 表单中的宿主机设置：存储池为空表示宿主机默认，倍率为输入框文本 */
type NodeOptionForm = { storagePool: string; trafficMultiplier: string };

type ProductForm = {
  name: string;
  type: InstanceType;
  description: string;
  tags: string[];
  nodeIds: number[];
  nodeOptions: Record<number, NodeOptionForm>;
  privileged: boolean;
  nesting: boolean;
  boot: BootForm;
  enabled: boolean;
  sortOrder: string;
};

/** 启动设置表单：数值留空为 Incus 默认值 */
type BootForm = { autostart: BootAutostart } & Record<Exclude<keyof BootOptions, 'autostart'>, string>;
const BOOT_NUMBERS = ['delay', 'priority', 'stopPriority', 'shutdownTimeout'] as const;

const toBootForm = (b: BootOptions = DEFAULT_BOOT_OPTIONS): BootForm => ({
  autostart: b.autostart,
  ...(Object.fromEntries(BOOT_NUMBERS.map((k) => [k, b[k] === null ? '' : String(b[k])])) as Record<(typeof BOOT_NUMBERS)[number], string>),
});

const toBootPayload = (f: BootForm): BootOptions => ({
  autostart: f.autostart,
  ...(Object.fromEntries(BOOT_NUMBERS.map((k) => [k, f[k].trim() === '' ? null : Number(f[k])])) as Record<(typeof BOOT_NUMBERS)[number], number | null>),
});

const toForm = (p?: AdminProductDTO): ProductForm => ({
  name: p?.name ?? '',
  type: p?.type ?? 'LXC_NAT',
  description: p?.description ?? '',
  tags: p?.tags ?? [],
  nodeIds: p?.nodeIds ?? [],
  nodeOptions: Object.fromEntries(
    Object.entries(p?.nodeOptions ?? {}).map(([id, o]) => [id, { storagePool: o.storagePool ?? '', trafficMultiplier: String(o.trafficMultiplier) }]),
  ),
  privileged: p?.privileged ?? false,
  nesting: p?.nesting ?? true,
  boot: toBootForm(p?.boot),
  enabled: p?.enabled ?? true,
  sortOrder: String(p?.sortOrder ?? 0),
});

const nodeOption = (f: ProductForm, id: number): NodeOptionForm => f.nodeOptions[id] ?? { storagePool: '', trafficMultiplier: '1' };

const toPayload = (f: ProductForm) => ({
  ...f,
  description: f.description || null,
  sortOrder: Number(f.sortOrder),
  boot: toBootPayload(f.boot),
  // 只提交已绑定宿主机的设置
  nodeOptions: Object.fromEntries(
    f.nodeIds.map((id) => {
      const o = nodeOption(f, id);
      return [id, { storagePool: o.storagePool || null, trafficMultiplier: o.trafficMultiplier === '' ? 1 : Number(o.trafficMultiplier) }];
    }),
  ),
});

/** 启动设置：宿主机（Incus）启动时是否自动开机、开机与关机的顺序和关机等待时间 */
function BootFields({ value, onChange }: { value: BootForm; onChange: (v: BootForm) => void }) {
  const { t } = useI18n();
  const num = (k: (typeof BOOT_NUMBERS)[number], max: number, unit?: string) => (
    <FormField label={t(`products.boot.${k}`)} description={t(`products.boot.${k}Hint`)}>
      <InputGroup type="number" min={0} max={max} value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} suffix={unit} placeholder={t('limits.default')} />
    </FormField>
  );
  return (
    <div className={GRID}>
      <FormField label={t('products.boot.autostart')}>
        <Select
          value={value.autostart}
          onChange={(autostart) => onChange({ ...value, autostart })}
          options={BOOT_AUTOSTART_MODES.map((m) => ({ value: m, label: t(`products.boot.autostart.${m}`), description: t(`products.boot.autostart.${m}Desc`) }))}
        />
      </FormField>
      {num('delay', BOOT_LIMITS.delay, t('products.boot.unitSec'))}
      {num('priority', BOOT_LIMITS.priority)}
      {num('stopPriority', BOOT_LIMITS.stopPriority)}
      {num('shutdownTimeout', BOOT_LIMITS.shutdownTimeout, t('products.boot.unitSec'))}
    </div>
  );
}

/** 产品表单状态与保存 */
function useProductForm(product: AdminProductDTO | undefined, onSaved: (p: AdminProductDTO) => void) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [initial, setInitial] = useState(() => toForm(product));
  const [f, setF] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const body = toPayload(f);
      return product ? api.patch<AdminProductDTO>(`/admin/products/${product.id}`, body) : api.post<AdminProductDTO>('/admin/products', body);
    },
    onSuccess: (saved) => {
      toast.success(product ? t('products.updated') : t('products.created'));
      void qc.invalidateQueries({ queryKey: ['admin-products'] });
      void qc.invalidateQueries({ queryKey: ['admin-plans'] });
      setInitial(toForm(saved));
      setF(toForm(saved));
      onSaved(saved);
    },
    onError: (e) => setError(errorText(e)),
  });
  const submit = () => {
    setError(null);
    save.mutate();
  };
  return { f, setF, initial, error, save, submit, dirty: JSON.stringify(f) !== JSON.stringify(initial) };
}

type FieldsProps = { f: ProductForm; setF: (f: ProductForm) => void; autoFocus?: boolean };

/** 实例类型下拉：切换后去掉不匹配的宿主机 */
function TypeField({ f, setF, hint }: FieldsProps & { hint?: boolean }) {
  const { t, L } = useI18n();
  const nodes = useQuery({ queryKey: ['admin-nodes'], queryFn: () => api.get<NodeDTO[]>('/admin/nodes') });
  return (
    <FormField label={t('products.type')} required description={hint ? t('products.typeHint') : undefined}>
      <Select
        value={f.type}
        onChange={(type) => {
          const fit = (id: number) => {
            const n = nodes.data?.find((x) => x.id === id);
            return !n || isPublicIpv4Mode(n.networkMode) === !isNatType(type);
          };
          setF({ ...f, type, nodeIds: f.nodeIds.filter(fit) });
        }}
        options={INSTANCE_TYPES.map((ty) => ({ value: ty, label: L.instanceType[ty], description: L.instanceTypeDesc[ty] }))}
      />
    </FormField>
  );
}

/** 名称、排序、标签与说明 */
function BasicFields({ f, setF, autoFocus }: FieldsProps) {
  const { t } = useI18n();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_1fr_7rem]">
        <FormField label={t('products.name')} required>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="JP Lite" autoFocus={autoFocus} />
        </FormField>
        <TypeField f={f} setF={setF} />
        <FormField label={t('common.sortOrder')}>
          <Input type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />
        </FormField>
      </div>
      <FormField label={t('products.tags')} description={t('products.tagsHint')}>
        <TagInput value={f.tags} onChange={(tags) => setF({ ...f, tags })} />
      </FormField>
      <FormField label={`${t('common.description')}${t('common.optionalSuffix')}`} description={t('products.descriptionHint')}>
        <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </FormField>
    </>
  );
}

/** 新建产品：只填基本信息与宿主机，其余在创建后的「配置」页调整 */
export function ProductDialog({ onClose, onSaved }: { onClose: () => void; onSaved?: (p: AdminProductDTO) => void }) {
  const { t } = useI18n();
  const form = useProductForm(undefined, (p) => {
    onClose();
    onSaved?.(p);
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t('products.create')}
      description={t('products.dialogDesc')}
      footer={
        <>
          {form.error && <span className="mr-auto text-sm text-danger-text">{form.error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={form.save.isPending} onClick={form.submit}>
            {t('products.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <BasicFields f={form.f} setF={form.setF} autoFocus />
        <FormField label={t('products.nodes')} description={t('products.nodesHint')}>
          <NodePicker value={form.f.nodeIds} onChange={(nodeIds) => form.setF({ ...form.f, nodeIds })} type={form.f.type} />
        </FormField>
      </div>
    </Modal>
  );
}

/** 产品管理页的「配置」标签：分节表单 + 删除 */
export function ProductSettings({ product }: { product: AdminProductDTO }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const form = useProductForm(product, () => {});
  const { f, setF } = form;
  const remove = useMutation({
    mutationFn: () => api.delete(`/admin/products/${product.id}`),
    onSuccess: () => {
      toast.success(t('products.deleted'));
      void qc.invalidateQueries({ queryKey: ['admin-products'] });
      navigate('/admin/plans', { replace: true });
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (form.dirty) form.submit();
      }}
    >
      <Block title={t('products.section.basic')} description={t('products.section.basicDesc')}>
        <div className={GRID}>
          <FormField label={t('products.name')} required>
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="JP Lite" />
          </FormField>
          <TypeField f={f} setF={setF} hint />
          <FormField label={t('products.tags')} description={t('products.tagsHint')}>
            <TagInput value={f.tags} onChange={(tags) => setF({ ...f, tags })} />
          </FormField>
        </div>
        <FormField label={`${t('common.description')}${t('common.optionalSuffix')}`} description={t('products.descriptionHint')}>
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </FormField>
      </Block>

      <Block title={t('products.nodes')} description={t('products.nodesHint')}>
        <NodePicker value={f.nodeIds} onChange={(nodeIds) => setF({ ...f, nodeIds })} type={f.type} wide />
        {f.nodeIds.length > 0 && (
          <FormField label={t('products.nodeOptions')} description={t('products.nodeOptionsHint')}>
            <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">
              <div className={cn('hidden gap-x-3 bg-surface-2/60 px-3 py-1.5 text-[11px] text-fg-3 sm:grid', OPTION_COLS)}>
                <span>{t('products.colNodes')}</span>
                <span>{t('products.rootPool')}</span>
                <span>{t('products.multiplier')}</span>
              </div>
              {f.nodeIds.map((id) => (
                <NodeOptionRow key={id} nodeId={id} value={nodeOption(f, id)} onChange={(o) => setF({ ...f, nodeOptions: { ...f.nodeOptions, [id]: o } })} />
              ))}
            </div>
          </FormField>
        )}
      </Block>

      <Block title={t('products.container')} description={t('products.containerHint')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleGroup>
            <SwitchRow checked={f.nesting} onCheckedChange={(v) => setF({ ...f, nesting: v })} title={t('products.nesting')} description={t('products.nestingDesc')} className={toggleRow} />
          </ToggleGroup>
          <ToggleGroup>
            <SwitchRow checked={f.privileged} onCheckedChange={(v) => setF({ ...f, privileged: v })} title={t('products.privileged')} description={t('products.privilegedDesc')} className={toggleRow} />
          </ToggleGroup>
        </div>
      </Block>

      <Block title={t('products.boot')} description={t('products.bootHint')}>
        <BootFields value={f.boot} onChange={(boot) => setF({ ...f, boot })} />
      </Block>

      <Block title={t('products.section.sale')} description={t('products.section.saleDesc')}>
        <div className={GRID}>
          <FormField label={t('common.sortOrder')} description={t('products.sortHint')}>
            <Input type="number" value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: e.target.value })} />
          </FormField>
          <div className="self-start sm:pt-6 lg:col-span-2">
            <ToggleGroup>
              <SwitchRow checked={f.enabled} onCheckedChange={(v) => setF({ ...f, enabled: v })} title={t('products.onSale')} description={t('products.onSaleDesc')} className={toggleRow} />
            </ToggleGroup>
          </div>
        </div>
      </Block>

      <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
        <div>
          <h3 className="text-[15px] font-semibold text-fg">{t('common.dangerZone')}</h3>
          <p className="mt-0.5 text-xs text-fg-3">{t('products.deleteDesc')}</p>
        </div>
        <Button
          variant="danger-ghost"
          icon={<Trash />}
          loading={remove.isPending}
          className="shrink-0 self-start sm:self-auto"
          onClick={async () => {
            if (await confirm({ title: t('products.deleteTitle', { name: product.name }), description: t('products.deleteDesc'), danger: true })) remove.mutate();
          }}
        >
          {t('products.delete')}
        </Button>
      </Card>
      {/* 底部操作栏：表单较长时始终可见 */}
      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-bg/85 px-4 py-2.5 backdrop-blur lg:-mx-6 lg:px-6">
        {form.error ? (
          <span className="mr-auto text-sm text-danger-text">{form.error}</span>
        ) : (
          form.dirty && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-sm text-fg-3">
              <span className="size-1.5 rounded-full bg-warning" />
              {t('common.unsaved')}
            </span>
          )
        )}
        <Button disabled={!form.dirty} onClick={() => setF(form.initial)}>
          {t('products.revert')}
        </Button>
        <Button type="submit" variant="primary" loading={form.save.isPending} disabled={!form.dirty}>
          {t('common.saveChanges')}
        </Button>
      </div>
    </form>
  );
}

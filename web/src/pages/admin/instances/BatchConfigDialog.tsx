import { ChevronDown } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { CPU_PRIORITY_MAX, PROCESS_LIMIT_MIN, type AdminInstanceDTO } from '../../../shared/index';
import type { DiskUnit } from '@/components/resource-limits';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { useI18n, type MessageKey, type TFunction } from '@/i18n';
import { overLimitOptions, trafficModeOptions } from '@/lib/plans';
import { cn } from '@/lib/cn';
import { useCurrency } from '@/lib/queries';

/** 下拉框里「不修改」的取值（空字符串会被当成未选择） */
const KEEP = 'keep';

/** 数值字段：留空不修改 */
const NUMBERS = ['cpu', 'memory', 'swap', 'disk', 'bandwidthIn', 'bandwidthOut', 'traffic', 'throttleRate', 'portLimit', 'siteLimit', 'snapshotLimit'] as const;
/** 可取消的字段：勾选后提交 null（不限 / 默认 / 不开放） */
const NULLABLE = ['cpuAllowance', 'cpuPriority', 'processLimit', 'trafficResetPrice'] as const;
type NumKey = (typeof NUMBERS)[number] | (typeof NULLABLE)[number] | 'price' | 'diskRead' | 'diskWrite';

/** 分组与其包含的提交字段（用于统计每组已修改的项目数） */
const SECTIONS = ['batch.section.spec', 'batch.section.limits', 'batch.section.network', 'batch.section.quota', 'batch.section.billing'] as const;
const SECTION_FIELDS: Record<(typeof SECTIONS)[number], string[]> = {
  'batch.section.spec': ['cpu', 'memory', 'swap', 'disk'],
  'batch.section.limits': ['cpuAllowance', 'cpuPriority', 'processLimit', 'diskRead', 'diskWrite'],
  'batch.section.network': ['bandwidthIn', 'bandwidthOut', 'traffic', 'trafficMode', 'overLimitAction', 'throttleRate'],
  'batch.section.quota': ['portLimit', 'siteLimit', 'snapshotLimit'],
  'batch.section.billing': ['price', 'autoRenew', 'trafficResetPrice'],
};

/** 带下拉框的分组每格较宽，改为两列（窄屏一列），避免输入框被挤窄 */
const WIDE = new Set<string>(['batch.section.limits', 'batch.section.billing']);

/** 单独配置时各输入框提示的当前值 */
function currentHints(c: AdminInstanceDTO | undefined, t: TFunction, currency: string): Partial<Record<NumKey, string>> {
  if (!c) return {};
  const or = (v: number | string | null, empty: string) => (v === null ? empty : String(v));
  const disk = (mb: number, iops: number) => (iops ? `${iops} IOPS` : mb ? `${mb} MB/s` : t('common.unlimited'));
  return {
    cpu: String(c.cpu),
    memory: String(c.memory),
    swap: String(c.swap),
    disk: String(c.disk),
    cpuAllowance: or(c.cpuAllowance, t('common.unlimited')),
    cpuPriority: or(c.cpuPriority, t('limits.default')),
    processLimit: or(c.processLimit, t('common.unlimited')),
    diskRead: disk(c.diskRead, c.diskReadIops),
    diskWrite: disk(c.diskWrite, c.diskWriteIops),
    bandwidthIn: String(c.bandwidthIn),
    bandwidthOut: String(c.bandwidthOut),
    traffic: String(c.traffic),
    throttleRate: String(c.throttleRate),
    portLimit: String(c.portLimit),
    siteLimit: String(c.siteLimit),
    snapshotLimit: String(c.snapshotLimit),
    price: `${currency}${c.price}`,
    trafficResetPrice: c.trafficResetPrice === null ? t('batch.resetOff') : `${currency}${c.trafficResetPrice}`,
  };
}

/** 根据表单生成提交内容：只包含填写或勾选了的项目 */
function buildPayload(v: Partial<Record<NumKey, string>>, clear: Set<string>, sel: { trafficMode: string; overLimitAction: string; autoRenew: string }, units: { read: DiskUnit; write: DiskUnit }) {
  const out: Record<string, unknown> = {};
  const filled = (k: NumKey) => (v[k] ?? '').trim() !== '';
  for (const k of NUMBERS) if (filled(k)) out[k] = Number(v[k]);
  for (const k of NULLABLE) {
    if (clear.has(k)) out[k] = null;
    else if (filled(k)) out[k] = k === 'trafficResetPrice' ? v[k]!.trim() : Number(v[k]);
  }
  if (filled('price')) out.price = v.price!.trim();
  // 磁盘读写：按所选单位设置，另一种清零（Incus 每个方向只能设置一种）；0 为不限
  if (filled('diskRead')) Object.assign(out, units.read === 'MB' ? { diskRead: Number(v.diskRead), diskReadIops: 0 } : { diskRead: 0, diskReadIops: Number(v.diskRead) });
  if (filled('diskWrite')) Object.assign(out, units.write === 'MB' ? { diskWrite: Number(v.diskWrite), diskWriteIops: 0 } : { diskWrite: 0, diskWriteIops: Number(v.diskWrite) });
  if (sel.trafficMode !== KEEP) out.trafficMode = sel.trafficMode;
  if (sel.overLimitAction !== KEEP) out.overLimitAction = sel.overLimitAction;
  if (sel.autoRenew !== KEEP) out.autoRenew = sel.autoRenew === 'on';
  return out;
}

/**
 * 批量配置所选实例：规格、性能限制、带宽与流量、配额、续费设置；留空的项目保持不变。
 * 传入 current 时为单独配置一台实例：标题改为实例名，输入框与「不修改」选项里提示当前值
 */
export function BatchConfigDialog({
  open,
  count,
  current,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  count: number;
  current?: AdminInstanceDTO;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (config: Record<string, unknown>) => void;
}) {
  const { t, L } = useI18n();
  const currency = useCurrency();
  const [v, setV] = useState<Partial<Record<NumKey, string>>>({});
  const [clear, setClear] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState({ trafficMode: KEEP, overLimitAction: KEEP, autoRenew: KEEP });
  const [units, setUnits] = useState<{ read: DiskUnit; write: DiskUnit }>({ read: 'MB', write: 'MB' });
  // 默认全部折叠
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const payload = buildPayload(v, clear, sel, units);
  const empty = Object.keys(payload).length === 0;
  const keep = { value: KEEP, label: t('batch.keep'), description: t('batch.keepDesc') };
  // 单独配置：「不修改」选项显示当前值
  const keepWith = (v: string) => (current ? { ...keep, label: t('batch.keepCurrent', { v }) } : keep);
  const hint = currentHints(current, t, currency);
  const unitOptions = [
    { value: 'MB' as const, label: 'MB/s', description: t('limits.unitMbDesc') },
    { value: 'IOPS' as const, label: 'IOPS', description: t('limits.unitIopsDesc') },
  ];

  const input = (k: NumKey, opts: { prefix?: string; suffix?: string; min?: number; max?: number; disabled?: boolean } = {}) => (
    <InputGroup
      type="number"
      min={opts.min ?? 0}
      max={opts.max}
      prefix={opts.prefix}
      suffix={opts.suffix}
      disabled={opts.disabled}
      value={opts.disabled ? '' : (v[k] ?? '')}
      onChange={(e) => setV({ ...v, [k]: e.target.value })}
      placeholder={hint[k] ? t('batch.currentValue', { v: hint[k] }) : t('batch.keep')}
    />
  );
  const num = (k: NumKey, label: MessageKey, opts: Parameters<typeof input>[1] = {}) => (
    <FormField key={k} label={t(label)}>
      {input(k, opts)}
    </FormField>
  );
  /** 可取消的字段：输入框右侧下拉选择「指定」或「不限 / 默认 / 不开放」 */
  const nullable = (k: (typeof NULLABLE)[number], label: MessageKey, clearLabel: MessageKey, opts: Parameters<typeof input>[1] = {}) => {
    const on = clear.has(k);
    const setMode = (m: 'set' | 'clear') => {
      const next = new Set(clear);
      if (m === 'clear') next.add(k);
      else next.delete(k);
      setClear(next);
    };
    return (
      <FormField key={k} label={t(label)}>
        <div className="flex gap-1.5">
          <div className="min-w-0 flex-1">{input(k, { ...opts, disabled: on })}</div>
          <Select
            value={on ? 'clear' : 'set'}
            onChange={setMode}
            className="w-24 shrink-0"
            aria-label={t(label)}
            options={[
              { value: 'set' as const, label: t('batch.modeSet'), description: t('batch.modeSetDesc') },
              { value: 'clear' as const, label: t(clearLabel), description: t('batch.modeClearDesc', { label: t(clearLabel) }) },
            ]}
          />
        </div>
      </FormField>
    );
  };
  const disk = (k: 'diskRead' | 'diskWrite', label: MessageKey) => {
    const u = k === 'diskRead' ? 'read' : 'write';
    return (
      <FormField key={k} label={t(label)} description={t('batch.diskZero')}>
        <div className="flex gap-1.5">
          <Input type="number" min={0} value={v[k] ?? ''} onChange={(e) => setV({ ...v, [k]: e.target.value })} placeholder={hint[k] ? t('batch.currentValue', { v: hint[k] }) : t('batch.keep')} className="min-w-0 flex-1" />
          <Select value={units[u]} onChange={(x) => setUnits({ ...units, [u]: x })} options={unitOptions} className="w-24 shrink-0" aria-label={t('limits.diskUnit')} />
        </div>
      </FormField>
    );
  };
  /** 分组默认折叠，点击标题展开；标题右侧显示该组已修改的项目数（折叠时也能看到） */
  const section = (title: (typeof SECTIONS)[number], children: ReactNode) => {
    const isOpen = expanded.has(title);
    const changed = SECTION_FIELDS[title].filter((f) => f in payload).length;
    const toggle = () => {
      const next = new Set(expanded);
      if (isOpen) next.delete(title);
      else next.add(title);
      setExpanded(next);
    };
    return (
      <section className="overflow-hidden rounded-lg border border-line">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={toggle}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-fg transition-colors hover:bg-surface-2/60"
        >
          <ChevronDown className={cn('size-4 shrink-0 text-fg-3 transition-transform duration-200', !isOpen && '-rotate-90')} />
          <span className="flex-1">{t(title)}</span>
          {changed > 0 && <Tag tone="primary">{t('batch.sectionChanged', { n: changed })}</Tag>}
        </button>
        {isOpen && (
          <div className={cn('panel-enter grid gap-y-3.5 border-t border-line px-3 pt-3 pb-3.5', WIDE.has(title) ? 'grid-cols-1 gap-x-4 sm:grid-cols-2' : 'grid-cols-2 gap-x-3 sm:grid-cols-3')}>{children}</div>
        )}
      </section>
    );
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={current ? t('adminInstances.configOneTitle', { name: current.hostname }) : t('batch.configTitle', { n: count })}
      description={current ? t('adminInstances.configOneDesc') : t('batch.configDesc')}
      footer={
        <>
          {error && <span className="mr-auto text-sm text-danger-text">{error}</span>}
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={pending} disabled={empty} onClick={() => onSubmit(payload)}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {section(
          'batch.section.spec',
          <>
            {num('cpu', 'batch.cpu', { suffix: t('adminInst.unitCores'), min: 1 })}
            {num('memory', 'batch.memory', { suffix: 'MiB', min: 64 })}
            {num('swap', 'batch.swap', { suffix: 'MiB', min: 0 })}
            {num('disk', 'batch.disk', { suffix: 'GiB', min: 1 })}
          </>,
        )}
        {section(
          'batch.section.limits',
          <>
            {nullable('cpuAllowance', 'plans.cpuAllowance', 'common.unlimited', { suffix: '%', min: 1, max: 100 })}
            {nullable('cpuPriority', 'limits.cpuPriority', 'limits.default', { suffix: `/ ${CPU_PRIORITY_MAX}`, max: CPU_PRIORITY_MAX })}
            {nullable('processLimit', 'limits.processLimit', 'common.unlimited', { suffix: t('limits.unitProcess'), min: PROCESS_LIMIT_MIN })}
            {disk('diskRead', 'limits.diskReadLimit')}
            {disk('diskWrite', 'limits.diskWriteLimit')}
          </>,
        )}
        {section(
          'batch.section.network',
          <>
            {num('bandwidthIn', 'batch.bandwidthIn', { suffix: 'Mbps' })}
            {num('bandwidthOut', 'batch.bandwidthOut', { suffix: 'Mbps' })}
            {num('traffic', 'batch.traffic', { suffix: 'GB' })}
            <FormField label={t('adminInst.trafficMode')}>
              <Select value={sel.trafficMode} onChange={(x) => setSel({ ...sel, trafficMode: x })} options={[keepWith(trafficModeOptions(t, L).find((o) => o.value === current?.trafficMode)?.label ?? ''), ...trafficModeOptions(t, L)]} />
            </FormField>
            <FormField label={t('adminInst.overLimit')}>
              <Select value={sel.overLimitAction} onChange={(x) => setSel({ ...sel, overLimitAction: x })} options={[keepWith(overLimitOptions(t, L).find((o) => o.value === current?.overLimitAction)?.label ?? ''), ...overLimitOptions(t, L)]} />
            </FormField>
            {num('throttleRate', 'plans.throttle', { suffix: 'Mbps', min: 1 })}
          </>,
        )}
        {section(
          'batch.section.quota',
          <>
            {num('portLimit', 'batch.portLimit')}
            {num('siteLimit', 'batch.siteLimit')}
            {num('snapshotLimit', 'batch.snapshotLimit')}
          </>,
        )}
        {section(
          'batch.section.billing',
          <>
            {num('price', 'overview.renewPrice', { prefix: currency })}
            <FormField label={t('batch.autoRenew')}>
              <Select
                value={sel.autoRenew}
                onChange={(x) => setSel({ ...sel, autoRenew: x })}
                options={[
                  keepWith(current?.autoRenew ? t('batch.autoRenewOn') : t('batch.autoRenewOff')),
                  { value: 'on', label: t('batch.autoRenewOn'), description: t('batch.autoRenewOnDesc') },
                  { value: 'off', label: t('batch.autoRenewOff'), description: t('batch.autoRenewOffDesc') },
                ]}
              />
            </FormField>
            {nullable('trafficResetPrice', 'plans.trafficResetPrice', 'batch.resetOff', { prefix: currency })}
          </>,
        )}
      </div>
    </Modal>
  );
}

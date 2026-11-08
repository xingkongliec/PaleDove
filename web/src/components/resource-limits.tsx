import { CPU_PRIORITY_MAX, isVmType, PROCESS_LIMIT_MIN, type InstanceType, type PlanDTO } from '../shared/index';
import { FormField, Input, InputGroup } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useI18n, type MessageKey } from '@/i18n';

/** 磁盘限制的单位：速率（MB/s）或 IOPS，Incus 每个方向只能设置其中一种 */
export type DiskUnit = 'MB' | 'IOPS';

/** 性能限制字段（套餐、管理员创建实例、实例管理共用），表单中均为字符串，留空表示不限 / 默认 */
export interface LimitForm {
  cpuAllowance: string;
  cpuPriority: string;
  processLimit: string;
  diskRead: string;
  diskReadUnit: DiskUnit;
  diskWrite: string;
  diskWriteUnit: DiskUnit;
}

type LimitSource = Pick<PlanDTO, 'cpuAllowance' | 'cpuPriority' | 'processLimit' | 'diskRead' | 'diskWrite' | 'diskReadIops' | 'diskWriteIops'>;

const str = (v: number | null | undefined) => (v ? String(v) : '');

/** 一个方向的磁盘限制：设置了 IOPS 时按 IOPS，否则按速率 */
const disk = (mb: number | undefined, iops: number | undefined): [string, DiskUnit] => (iops ? [String(iops), 'IOPS'] : [str(mb), 'MB']);

export function limitForm(src?: Partial<LimitSource> | null): LimitForm {
  const [diskRead, diskReadUnit] = disk(src?.diskRead, src?.diskReadIops);
  const [diskWrite, diskWriteUnit] = disk(src?.diskWrite, src?.diskWriteIops);
  return {
    cpuAllowance: str(src?.cpuAllowance),
    // 优先级 0 是有效值
    cpuPriority: src?.cpuPriority === null || src?.cpuPriority === undefined ? '' : String(src.cpuPriority),
    processLimit: str(src?.processLimit),
    diskRead,
    diskReadUnit,
    diskWrite,
    diskWriteUnit,
  };
}

/** 提交的值：留空为 null（不限 / 默认）或 0（磁盘不限）；虚拟机没有进程数限制；磁盘每个方向只提交所选单位的值 */
export function limitPayload(f: LimitForm, type: InstanceType) {
  const opt = (v: string) => (v.trim() === '' ? null : Number(v));
  const read = Number(f.diskRead) || 0;
  const write = Number(f.diskWrite) || 0;
  return {
    cpuAllowance: opt(f.cpuAllowance) || null,
    cpuPriority: opt(f.cpuPriority),
    processLimit: isVmType(type) ? null : opt(f.processLimit),
    diskRead: f.diskReadUnit === 'MB' ? read : 0,
    diskReadIops: f.diskReadUnit === 'IOPS' ? read : 0,
    diskWrite: f.diskWriteUnit === 'MB' ? write : 0,
    diskWriteIops: f.diskWriteUnit === 'IOPS' ? write : 0,
  };
}

/** 性能限制的输入项（不含外层网格）；hints 为 true 时显示每项的说明 */
export function LimitFields({ value, onChange, type, hints = true }: { value: LimitForm; onChange: (v: LimitForm) => void; type: InstanceType; hints?: boolean }) {
  const { t } = useI18n();
  const vm = isVmType(type);
  const units = [
    { value: 'MB' as const, label: 'MB/s', description: t('limits.unitMbDesc') },
    { value: 'IOPS' as const, label: 'IOPS', description: t('limits.unitIopsDesc') },
  ];
  const field = (k: 'cpuAllowance' | 'cpuPriority' | 'processLimit', label: MessageKey, unit: string, desc: MessageKey, opts: { min?: number; max?: number; placeholder?: string } = {}) => (
    <FormField key={k} label={t(label)} description={hints ? t(desc) : undefined}>
      <InputGroup
        type="number"
        min={opts.min ?? 0}
        max={opts.max}
        value={value[k]}
        onChange={(e) => onChange({ ...value, [k]: e.target.value })}
        suffix={unit}
        placeholder={opts.placeholder ?? t('common.unlimited')}
      />
    </FormField>
  );
  // 磁盘读 / 写：数值 + 单位下拉（速率与 IOPS 二选一）
  const diskField = (k: 'diskRead' | 'diskWrite', label: MessageKey) => {
    const unitKey = k === 'diskRead' ? 'diskReadUnit' : 'diskWriteUnit';
    return (
      <FormField key={k} label={t(label)} description={hints ? t('limits.diskHint') : undefined}>
        <div className="flex gap-1.5">
          <Input type="number" min={0} value={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.value })} placeholder={t('common.unlimited')} className="min-w-0 flex-1" />
          <Select value={value[unitKey]} onChange={(u) => onChange({ ...value, [unitKey]: u })} options={units} className="w-24 shrink-0" aria-label={t('limits.diskUnit')} />
        </div>
      </FormField>
    );
  };
  return (
    <>
      {field('cpuAllowance', 'plans.cpuAllowance', '%', vm ? 'limits.cpuAllowanceVmHint' : 'plans.cpuAllowanceHint', { min: 1, max: 100 })}
      {field('cpuPriority', 'limits.cpuPriority', `/ ${CPU_PRIORITY_MAX}`, vm ? 'limits.cpuPriorityVmHint' : 'limits.cpuPriorityHint', { max: CPU_PRIORITY_MAX, placeholder: t('limits.default') })}
      {!vm && field('processLimit', 'limits.processLimit', t('limits.unitProcess'), 'limits.processLimitHint', { min: PROCESS_LIMIT_MIN })}
      {diskField('diskRead', 'limits.diskReadLimit')}
      {diskField('diskWrite', 'limits.diskWriteLimit')}
    </>
  );
}

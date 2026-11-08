import { BILLING_CYCLES, CYCLE_MONTHS, OVER_LIMIT_ACTIONS, TRAFFIC_MODES, type BillingCycle, type EnumLabels, type PlanDTO } from '../shared/index';
import type { TFunction } from '@/i18n';

/** 套餐的最低月均价格（用于列表展示） */
export function cheapest(plan: PlanDTO): { cycle: BillingCycle; perMonth: number } | null {
  let best: { cycle: BillingCycle; perMonth: number } | null = null;
  for (const c of BILLING_CYCLES) {
    const p = plan.prices[c];
    if (!p) continue;
    const perMonth = Number(p) / CYCLE_MONTHS[c];
    if (!best || perMonth < best.perMonth) best = { cycle: c, perMonth };
  }
  return best;
}

/** 流量计费方式下拉选项（带说明） */
export const trafficModeOptions = (t: TFunction, L: EnumLabels) =>
  TRAFFIC_MODES.map((m) => ({ value: m, label: L.trafficMode[m], description: t(`trafficModeDesc.${m}`) }));

/** 超额处理下拉选项（带说明） */
export const overLimitOptions = (t: TFunction, L: EnumLabels) =>
  OVER_LIMIT_ACTIONS.map((m) => ({ value: m, label: L.overLimitAction[m], description: t(`overLimitDesc.${m}`) }));

type DiskIo = Pick<PlanDTO, 'diskRead' | 'diskWrite' | 'diskReadIops' | 'diskWriteIops'>;

/** 磁盘 I/O 限制的文字，例如「读 100 MB/s · 3000 IOPS，写 50 MB/s」；都不限时返回 null */
export function diskIoText(p: DiskIo, t: TFunction): string | null {
  if (!p.diskRead && !p.diskWrite && !p.diskReadIops && !p.diskWriteIops) return null;
  const part = (mb: number, iops: number) => [mb ? `${mb} MB/s` : '', iops ? `${iops} IOPS` : ''].filter(Boolean).join(' · ') || t('common.unlimited');
  return t('spec.diskIoValue', { read: part(p.diskRead, p.diskReadIops), write: part(p.diskWrite, p.diskWriteIops) });
}

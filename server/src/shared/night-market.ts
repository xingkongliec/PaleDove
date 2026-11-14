import type { BillingCycle, InvoiceStatus } from './enums';

export const NIGHT_QUALITIES = ['SELECT', 'DELUXE', 'PREMIUM', 'EXCLUSIVE'] as const;
export type NightQuality = (typeof NIGHT_QUALITIES)[number];
export const nightHighQuality = (quality: NightQuality) => quality === 'PREMIUM' || quality === 'EXCLUSIVE';
export const NIGHT_DISCOUNT_MODES = ['ONCE', 'RECURRING'] as const;
export type NightDiscountMode = (typeof NIGHT_DISCOUNT_MODES)[number];

export interface NightDrawRules {
  guaranteeEnabled: boolean;
  guaranteeCount: number;
  guaranteeQuality: NightQuality;
  /** 普通抽取的品质概率，整数百分比，合计 100；0 表示不参与抽取和保底。 */
  qualityProbabilities: Record<NightQuality, number>;
}

export const defaultNightDrawRules = (): NightDrawRules => ({
  guaranteeEnabled: true, guaranteeCount: 2, guaranteeQuality: 'PREMIUM',
  qualityProbabilities: { SELECT: 25, DELUXE: 25, PREMIUM: 25, EXCLUSIVE: 25 },
});

export function validNightDrawRules(rules: NightDrawRules): boolean {
  return typeof rules.guaranteeEnabled === 'boolean'
    && Number.isInteger(rules.guaranteeCount) && rules.guaranteeCount >= 1 && rules.guaranteeCount <= 6
    && NIGHT_QUALITIES.includes(rules.guaranteeQuality)
    && NIGHT_QUALITIES.every(q => Number.isInteger(rules.qualityProbabilities[q]) && rules.qualityProbabilities[q] >= 0 && rules.qualityProbabilities[q] <= 100)
    && NIGHT_QUALITIES.reduce((sum, q) => sum + rules.qualityProbabilities[q], 0) === 100;
}

export const nightMeetsGuarantee = (quality: NightQuality, rules: NightDrawRules) =>
  NIGHT_QUALITIES.indexOf(quality) >= NIGHT_QUALITIES.indexOf(rules.guaranteeQuality);

type DrawPrize = Pick<NightPrize, 'id' | 'quality' | 'groupKey'>;

export function nightCatalogStats(catalog: DrawPrize[], rules: NightDrawRules = defaultNightDrawRules()) {
  const eligible = [...new Map(catalog.filter(p => rules.qualityProbabilities[p.quality] > 0).map(p => [p.id, p])).values()];
  const groups = new Map<string, { total: number; guaranteed: number }>();
  for (const prize of eligible) {
    const group = groups.get(prize.groupKey) ?? { total: 0, guaranteed: 0 };
    group.total++;
    if (nightMeetsGuarantee(prize.quality, rules)) group.guaranteed++;
    groups.set(prize.groupKey, group);
  }
  return {
    eligibleCount: eligible.length,
    highQualityCount: eligible.filter(p => nightHighQuality(p.quality)).length,
    guaranteeEligibleCount: eligible.filter(p => nightMeetsGuarantee(p.quality, rules)).length,
    guaranteeCapacity: [...groups.values()].reduce((sum, group) => sum + Math.min(2, group.guaranteed), 0),
    groupCapacity: [...groups.values()].reduce((sum, group) => sum + Math.min(2, group.total), 0),
    eligibleIds: eligible.map(p => p.id),
  };
}

/** 每次候选都须留下足够的分组容量和保底名额，避免随机选中后无法凑齐六张。 */
export function canCompleteNightDraw(catalog: DrawPrize[], rules: NightDrawRules, selected: DrawPrize[] = []): boolean {
  if (!validNightDrawRules(rules) || selected.length > 6) return false;
  const ids = new Set(selected.map(p => p.id));
  if (ids.size !== selected.length) return false;
  const taken = new Map<string, number>();
  for (const prize of selected) {
    if (!(rules.qualityProbabilities[prize.quality] > 0)) return false;
    const count = (taken.get(prize.groupKey) ?? 0) + 1;
    if (count > 2) return false;
    taken.set(prize.groupKey, count);
  }
  const groups = new Map<string, { total: number; guaranteed: number }>();
  for (const prize of catalog) {
    if (ids.has(prize.id) || !(rules.qualityProbabilities[prize.quality] > 0)) continue;
    ids.add(prize.id);
    const group = groups.get(prize.groupKey) ?? { total: 0, guaranteed: 0 };
    group.total++;
    if (nightMeetsGuarantee(prize.quality, rules)) group.guaranteed++;
    groups.set(prize.groupKey, group);
  }
  let capacity = 0;
  let guaranteeCapacity = 0;
  for (const [key, group] of groups) {
    const available = 2 - (taken.get(key) ?? 0);
    capacity += Math.min(available, group.total);
    guaranteeCapacity += Math.min(available, group.guaranteed);
  }
  const needed = rules.guaranteeEnabled ? Math.max(0, rules.guaranteeCount - selected.filter(p => nightMeetsGuarantee(p.quality, rules)).length) : 0;
  return capacity >= 6 - selected.length && needed <= 6 - selected.length && guaranteeCapacity >= needed;
}

export const validNightCatalog = (catalog: DrawPrize[], rules: NightDrawRules = defaultNightDrawRules()) => canCompleteNightDraw(catalog, rules);

export interface NightPrize {
  id: string;
  name: string;
  description: string;
  planId: number;
  cycle: BillingCycle;
  quality: NightQuality;
  discountMin: number;
  discountMax: number;
  discountMode: NightDiscountMode;
  /** 同组每期最多出现两张卡；建议使用产品名称分组。 */
  groupKey: string;
  /** First automatic Night Market period this prize can enter; periods start at 1. */
  eligibleFromPeriod: number;
  enabled: boolean;
}

export interface NightConfig {
  enabled: boolean;
  startsAt: string;
  refreshHours: number;
  activeHours: number;
  drawRules: NightDrawRules;
  prizes: NightPrize[];
}

export interface NightPrizeSnapshot extends NightPrize {
  productName: string;
  planName: string;
  originalPrice: string;
  cpu: number;
  memory: number;
  disk: number;
}

export interface NightPeriodDTO {
  id: number;
  number: number;
  startsAt: string;
  closesAt: string;
  refreshAt: string;
  drawRules: NightDrawRules;
}

export interface NightOfferDTO {
  id: number;
  position: number;
  quality: NightQuality;
  revealedAt: string | null;
  purchasedAt: string | null;
  invoiceId: number | null;
  instanceId: number | null;
  /** 未翻开的卡片不下发奖品、价格或折扣。 */
  prize?: NightPrizeSnapshot;
  discountPercent?: number;
  amount?: string;
}

export interface NightMarketDTO {
  state: 'disabled' | 'scheduled' | 'open' | 'closed' | 'unavailable';
  serverTime: string;
  nextStartsAt: string | null;
  period: NightPeriodDTO | null;
  offers: NightOfferDTO[];
}

export interface AdminNightMarketDTO {
  config: NightConfig;
  period: NightPeriodDTO | null;
  draftPeriodNumber: number;
  draftStartsAt: string;
  eligibleCount: number;
  highQualityCount: number;
  guaranteeEligibleCount: number;
  guaranteeCapacity: number;
  groupCapacity: number;
  eligibleIds: string[];
}

export interface AdminUserNightOfferDTO extends Omit<NightOfferDTO, 'prize' | 'discountPercent' | 'amount'> {
  prize: NightPrizeSnapshot;
  discountPercent: number;
  amount: string;
  invoiceStatus: InvoiceStatus | null;
}

export interface AdminUserNightMarketDTO extends Omit<NightMarketDTO, 'offers'> {
  poolId: number | null;
  generatedAt: string | null;
  offers: AdminUserNightOfferDTO[];
  resetBlockedReason: 'closed' | 'processing' | 'purchased' | 'role' | null;
}

export interface AdminUserNightResetInput {
  periodId: number;
  /** 当前页面的卡片编号，避免旧页面或重复提交覆盖新奖池。 */
  offerIds: number[];
}

export interface AdminUserNightResetDTO {
  market: AdminUserNightMarketDTO;
  canceledInvoices: number;
  retainedOffers: number;
}

import { randomInt } from 'node:crypto';
import {
  CYCLE_PRICE_FIELD, NIGHT_QUALITIES, defaultNightDrawRules, nightCatalogStats, validNightCatalog, canCompleteNightDraw,
  type AdminNightMarketDTO, type BillingCycle, type NightConfig, type NightMarketDTO,
  type NightDrawRules, type NightOfferDTO, type NightPeriodDTO, type NightPrize, type NightPrizeSnapshot,
  type AdminUserNightMarketDTO, type AdminUserNightResetInput, type AdminUserNightResetDTO,
} from '../shared/index.ts';
import { prisma, Prisma } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { invalidateCache } from '../lib/cache.ts';
import { t } from '../i18n/index.ts';

type Tx = Prisma.TransactionClient;
const CONFIG_KEY = 'nightMarket';
const HOUR = 3_600_000;
export const defaultNightConfig = (): NightConfig => ({
  enabled: false, startsAt: new Date().toISOString(), refreshHours: 720,
  activeHours: 336, drawRules: defaultNightDrawRules(), prizes: [],
});

/** 旧期次和卡片沿用首期优惠，补充字段时不重抽折扣。 */
export function normalizeNightPrize<T extends NightPrize>(prize: T): T {
  return { ...prize, discountMin: prize.discountMin ?? 10, discountMax: prize.discountMax ?? 49, discountMode: prize.discountMode ?? 'ONCE' };
}

export async function getNightConfig(db: Pick<Tx, 'setting' | 'nightMarketPeriod'> = prisma): Promise<NightConfig> {
  const row = await db.setting.findUnique({ where: { key: CONFIG_KEY } });
  if (!row) return defaultNightConfig();
  const stored = row.value as unknown as Omit<NightConfig, 'prizes'> & { currentAct?: number; prizes: (NightPrize & { releaseAct?: number })[] };
  const needsUpgrade = !stored.drawRules || stored.currentAct !== undefined || stored.prizes.some(p => p.discountMin === undefined || p.discountMax === undefined || p.discountMode === undefined);
  if (!needsUpgrade) return stored;
  const latest = stored.currentAct !== undefined ? await db.nightMarketPeriod.findFirst({ orderBy: { startsAt: 'desc' } }) : null;
  const basePeriod = latest?.number ?? 1;
  const { currentAct, ...config } = stored;
  // Preserve eligibility when upgrading from manually maintained release batches.
  const upgraded: NightConfig = { ...config, drawRules: stored.drawRules ?? defaultNightDrawRules(), prizes: stored.prizes.map(({ releaseAct, ...prize }) => ({
    ...normalizeNightPrize(prize), eligibleFromPeriod: prize.eligibleFromPeriod ?? Math.max(1, basePeriod + (releaseAct ?? 0) - ((currentAct ?? 2) - 2)),
  })) };
  const saved = await db.setting.updateMany({ where: { key: CONFIG_KEY, updatedAt: row.updatedAt }, data: { value: upgraded as unknown as Prisma.InputJsonValue } });
  return saved.count ? upgraded : getNightConfig(db);
}

/** The database row also serializes operations across processes and Redis restarts. */
export async function lockNightMarket(tx: Tx): Promise<void> {
  await tx.setting.upsert({ where: { key: 'nightMarketLock' }, create: { key: 'nightMarketLock', value: 0 }, update: { value: 0, updatedAt: new Date() } });
}

export function nightTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withLock('night-market', 30_000, () => prisma.$transaction(async tx => {
    await lockNightMarket(tx);
    return fn(tx);
  }, { timeout: 20_000, maxWait: 20_000 }));
}

async function buildCatalog(tx: Tx, config: NightConfig, periodNumber: number): Promise<NightPrizeSnapshot[]> {
  const eligible = config.prizes.filter(p => p.enabled && p.eligibleFromPeriod <= periodNumber);
  const plans = await tx.plan.findMany({ where: { id: { in: eligible.map(p => p.planId) }, enabled: true, product: { enabled: true } }, include: { product: { select: { name: true } } } });
  return eligible.flatMap(prize => {
    const plan = plans.find(p => p.id === prize.planId);
    const price = plan?.[CYCLE_PRICE_FIELD[prize.cycle]];
    if (!plan || !price || !price.gt(0)) return [];
    return [{ ...prize, productName: plan.product.name, planName: plan.name, originalPrice: price.toFixed(2), cpu: plan.cpu, memory: plan.memory, disk: plan.disk }];
  });
}

function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

export function drawNightPrizes(catalog: NightPrizeSnapshot[], rules: NightDrawRules = defaultNightDrawRules(), fixed: { position: number; prize: NightPrizeSnapshot }[] = []) {
  const selected = fixed.map(card => card.prize);
  if (!validNightCatalog(catalog, rules) || !canCompleteNightDraw(catalog, rules, selected)) throw badRequest(t('night.invalidCatalog'));
  const unique = [...new Map(catalog.map(p => [p.id, p])).values()];
  while (selected.length < 6) {
    const candidates = unique.filter(prize => canCompleteNightDraw(unique, rules, [...selected, prize]));
    const qualities = NIGHT_QUALITIES.filter(q => candidates.some(p => p.quality === q));
    // 先按品质概率抽取，再在该品质的可行奖品中等概率抽取；奖品数量不改变品质权重。
    let ticket = randomInt(qualities.reduce((sum, q) => sum + rules.qualityProbabilities[q], 0));
    const quality = qualities.find(q => { ticket -= rules.qualityProbabilities[q]; return ticket < 0; })!;
    const prizes = candidates.filter(p => p.quality === quality);
    selected.push(prizes[randomInt(prizes.length)]!);
  }
  const positions = Array.from({ length: 6 }, (_, index) => index).filter(position => !fixed.some(card => card.position === position));
  return shuffle(selected.slice(fixed.length)).map((stored, index) => {
    const prize = normalizeNightPrize(stored);
    const discountPercent = randomInt(prize.discountMin, prize.discountMax + 1);
    const originalPrice = new Prisma.Decimal(prize.originalPrice);
    return { position: positions[index]!, snapshot: prize as unknown as Prisma.InputJsonValue, originalPrice, discountPercent,
      amount: originalPrice.mul(100 - discountPercent).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP) };
  });
}

type Period = Prisma.NightMarketPeriodGetPayload<object>;
export function nightPeriodDto(period: Period): NightPeriodDTO {
  return { id: period.id, number: period.number, startsAt: period.startsAt.toISOString(), closesAt: period.closesAt.toISOString(), refreshAt: period.refreshAt.toISOString(), drawRules: (period.drawRules as unknown as NightDrawRules | null) ?? defaultNightDrawRules() };
}

function nextPeriod(latest: Period | null, config: NightConfig, now: Date) {
  const anchor = latest?.refreshAt.getTime() ?? new Date(config.startsAt).getTime();
  const interval = config.refreshHours * HOUR;
  const skipped = Math.max(0, Math.floor((now.getTime() - anchor) / interval));
  return { number: (latest?.number ?? 0) + 1 + skipped, startsAt: new Date(anchor + skipped * interval) };
}

async function ensurePeriod(tx: Tx, config: NightConfig, now: Date) {
  const latest = await tx.nightMarketPeriod.findFirst({ orderBy: { startsAt: 'desc' } });
  if (latest && now < latest.refreshAt) return { period: latest, nextStartsAt: latest.refreshAt };
  const next = nextPeriod(latest, config, now);
  if (now < next.startsAt) return { period: null, nextStartsAt: next.startsAt };
  const start = next.startsAt.getTime();
  const catalog = await buildCatalog(tx, config, next.number);
  if (!validNightCatalog(catalog, config.drawRules)) return { period: null, nextStartsAt: null };
  const period = await tx.nightMarketPeriod.create({ data: {
    number: next.number, startsAt: next.startsAt, closesAt: new Date(start + config.activeHours * HOUR), refreshAt: new Date(start + config.refreshHours * HOUR),
    catalog: catalog as unknown as Prisma.InputJsonValue,
    drawRules: config.drawRules as unknown as Prisma.InputJsonValue,
  } });
  return { period, nextStartsAt: period.refreshAt };
}

export async function adminNightMarket(): Promise<AdminNightMarketDTO> {
  return nightTransaction(async tx => {
    const config = await getNightConfig(tx);
    const now = new Date();
    const period = config.enabled ? (await ensurePeriod(tx, config, now)).period : await tx.nightMarketPeriod.findFirst({ orderBy: { startsAt: 'desc' } });
    const latest = period ?? await tx.nightMarketPeriod.findFirst({ orderBy: { startsAt: 'desc' } });
    const draft = nextPeriod(latest, config, now);
    const catalog = await buildCatalog(tx, config, draft.number);
    return { config, period: latest ? nightPeriodDto(latest) : null, draftPeriodNumber: draft.number, draftStartsAt: draft.startsAt.toISOString(), ...nightCatalogStats(catalog, config.drawRules) };
  });
}

export async function saveNightConfig(config: NightConfig): Promise<void> {
  await nightTransaction(async tx => {
    const previous = await getNightConfig(tx);
    // Freeze an already-open period before replacing its configuration, even if no user visited yet.
    if (previous.enabled) await ensurePeriod(tx, previous, new Date());
    const latest = await tx.nightMarketPeriod.findFirst({ orderBy: { startsAt: 'desc' } });
    const draft = nextPeriod(latest, config, new Date());
    const catalog = await buildCatalog(tx, config, draft.number);
    if (config.enabled && !validNightCatalog(catalog, config.drawRules)) throw badRequest(t('night.invalidCatalog'));
    await tx.setting.upsert({ where: { key: CONFIG_KEY }, create: { key: CONFIG_KEY, value: config as unknown as Prisma.InputJsonValue }, update: { value: config as unknown as Prisma.InputJsonValue } });
    if (config.enabled) await ensurePeriod(tx, config, new Date());
  });
  await invalidateCache('settings');
}

const offerInclude = {
  invoice: { select: { id: true, status: true, expiresAt: true } },
  order: { select: { instanceId: true } },
} satisfies Prisma.NightMarketOfferInclude;
type Offer = Prisma.NightMarketOfferGetPayload<{ include: typeof offerInclude }>;

function offerDto(row: Offer, now: Date): NightOfferDTO {
  const prize = normalizeNightPrize(row.snapshot as unknown as NightPrizeSnapshot);
  const invoice = row.invoice;
  const pendingInvoice = invoice && (invoice.status === 'PROCESSING' || (invoice.status === 'PENDING' && (!invoice.expiresAt || invoice.expiresAt > now)));
  return {
    id: row.id, position: row.position, quality: prize.quality,
    revealedAt: row.revealedAt?.toISOString() ?? null, purchasedAt: row.purchasedAt?.toISOString() ?? null,
    invoiceId: pendingInvoice ? invoice.id : null, instanceId: row.order?.instanceId ?? null,
    ...(row.revealedAt ? { prize, discountPercent: row.discountPercent, amount: row.amount.toFixed(2) } : {}),
  };
}

export async function getUserNightMarket(userId: number): Promise<NightMarketDTO> {
  return nightTransaction(async tx => {
    const now = new Date();
    const config = await getNightConfig(tx);
    const base = { serverTime: now.toISOString(), period: null, offers: [], nextStartsAt: null };
    if (!config.enabled) return { ...base, state: 'disabled' };
    const { period, nextStartsAt } = await ensurePeriod(tx, config, now);
    if (!period) return { ...base, state: nextStartsAt ? 'scheduled' : 'unavailable', nextStartsAt: nextStartsAt?.toISOString() ?? null };
    const open = now >= period.startsAt && now < period.closesAt;
    let pool = await tx.nightMarketPool.findUnique({ where: { userId_periodId: { userId, periodId: period.id } } });
    if (!pool && open) pool = await tx.nightMarketPool.create({ data: {
      userId, periodId: period.id, offers: { create: drawNightPrizes(period.catalog as unknown as NightPrizeSnapshot[], nightPeriodDto(period).drawRules) },
    } });
    const offers = pool ? await tx.nightMarketOffer.findMany({ where: { poolId: pool.id }, include: offerInclude, orderBy: { position: 'asc' } }) : [];
    return { state: open ? 'open' : 'closed', serverTime: now.toISOString(), period: nightPeriodDto(period), nextStartsAt: period.refreshAt.toISOString(), offers: offers.map(row => offerDto(row, now)) };
  });
}

/** 管理员可查看未翻开卡片，但查看不会生成用户奖池或改变翻牌状态。 */
async function readAdminUserNightMarket(tx: Tx, userId: number): Promise<AdminUserNightMarketDTO> {
  const user = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) throw notFound(t('user.notFound'));
  const now = new Date();
  const config = await getNightConfig(tx);
  const active = config.enabled ? await ensurePeriod(tx, config, now) : null;
  const period = active ? active.period : await tx.nightMarketPeriod.findFirst({ orderBy: { startsAt: 'desc' } });
  const pool = period ? await tx.nightMarketPool.findUnique({ where: { userId_periodId: { userId, periodId: period.id } }, include: { offers: { include: offerInclude, orderBy: { position: 'asc' } } } }) : null;
  const open = !!(config.enabled && period && now >= period.startsAt && now < period.closesAt);
  const offers = pool?.offers ?? [];
  return {
    state: !config.enabled ? 'disabled' : open ? 'open' : period ? 'closed' : active?.nextStartsAt ? 'scheduled' : 'unavailable',
    serverTime: now.toISOString(), period: period ? nightPeriodDto(period) : null,
    nextStartsAt: (period?.refreshAt ?? active?.nextStartsAt)?.toISOString() ?? null,
    poolId: pool?.id ?? null, generatedAt: pool?.createdAt.toISOString() ?? null,
    offers: offers.map(row => ({ ...offerDto(row, now), prize: normalizeNightPrize(row.snapshot as unknown as NightPrizeSnapshot),
      discountPercent: row.discountPercent, amount: row.amount.toFixed(2), invoiceId: row.invoiceId, invoiceStatus: row.invoice?.status ?? null })),
    resetBlockedReason: user.role !== 'USER' ? 'role' : !open ? 'closed' : offers.some(row => row.invoice?.status === 'PROCESSING') ? 'processing'
      : offers.length === 6 && offers.every(row => row.purchasedAt) ? 'purchased' : null,
  };
}

export function adminUserNightMarket(userId: number): Promise<AdminUserNightMarketDTO> {
  return nightTransaction(tx => readAdminUserNightMarket(tx, userId));
}

/** 只重抽未购买卡片；账单撤销与卡片替换在同一事务中完成。 */
export function resetUserNightMarket(userId: number, input: AdminUserNightResetInput): Promise<AdminUserNightResetDTO> {
  return nightTransaction(async tx => {
    const current = await readAdminUserNightMarket(tx, userId);
    if (current.resetBlockedReason) throw conflict(t(`night.resetBlocked.${current.resetBlockedReason}`));
    if (!current.period || current.period.id !== input.periodId || current.offers.length !== input.offerIds.length
      || current.offers.some(offer => !input.offerIds.includes(offer.id))) throw conflict(t('night.resetStale'));
    const period = await tx.nightMarketPeriod.findUniqueOrThrow({ where: { id: input.periodId } });
    const retained = current.offers.filter(offer => offer.purchasedAt);
    const replace = current.offers.filter(offer => !offer.purchasedAt);
    const pending = replace.filter(offer => offer.invoiceStatus === 'PENDING').map(offer => offer.invoiceId!);
    const canceled = await tx.invoice.updateMany({ where: { id: { in: pending }, userId, status: 'PENDING' }, data: { status: 'CANCELED' } });
    // 支付先抢占 PROCESSING；若支付抢先，整次重置回滚，不删除支付中的卡片。
    if (canceled.count !== pending.length || replace.some(offer => offer.invoiceStatus === 'PAID')) throw conflict(t('night.resetBlocked.processing'));
    const cards = drawNightPrizes(period.catalog as unknown as NightPrizeSnapshot[], current.period.drawRules, retained.map(offer => ({ position: offer.position, prize: offer.prize })));
    const pool = current.poolId ? { id: current.poolId } : await tx.nightMarketPool.create({ data: { userId, periodId: period.id } });
    await tx.nightMarketOffer.deleteMany({ where: { poolId: pool.id, id: { in: replace.map(offer => offer.id) } } });
    for (const card of cards) await tx.nightMarketOffer.create({ data: { ...card, poolId: pool.id } });
    return { market: await readAdminUserNightMarket(tx, userId), canceledInvoices: canceled.count, retainedOffers: retained.length };
  });
}

export async function requireNightOffer(tx: Tx, userId: number, id: number, options: { reveal?: boolean; planId?: number; cycle?: BillingCycle; invoiceId?: number } = {}) {
  const row = await tx.nightMarketOffer.findFirst({ where: { id, pool: { userId } }, include: { ...offerInclude, pool: { include: { period: true } } } });
  if (!row) throw notFound(t('night.offerMissing'));
  const config = await getNightConfig(tx);
  const now = new Date();
  if (!config.enabled || now < row.pool.period.startsAt || now >= row.pool.period.closesAt) throw conflict(t('night.closed'));
  if (!options.reveal && !row.revealedAt) throw badRequest(t('night.revealFirst'));
  if (!options.reveal && row.purchasedAt) throw conflict(t('night.purchased'));
  const prize = row.snapshot as unknown as NightPrizeSnapshot;
  if ((options.planId !== undefined && options.planId !== prize.planId) || (options.cycle !== undefined && options.cycle !== prize.cycle)) throw badRequest(t('night.mismatch'));
  if (options.invoiceId !== undefined && (row.invoiceId !== options.invoiceId || row.invoice?.status !== 'PROCESSING')) throw conflict(t('night.invoiceMismatch'));
  if (options.invoiceId !== undefined && row.invoice?.expiresAt && row.invoice.expiresAt <= now) throw conflict(t('night.closed'));
  return row;
}

export async function revealNightOffer(userId: number, id: number): Promise<NightOfferDTO> {
  return nightTransaction(async tx => {
    const row = await requireNightOffer(tx, userId, id, { reveal: true });
    const updated = row.revealedAt ? row : await tx.nightMarketOffer.update({ where: { id }, data: { revealedAt: new Date() }, include: offerInclude });
    return offerDto(updated, new Date());
  });
}

export async function nightCheckoutQuote(userId: number, id: number) {
  return nightTransaction(async tx => {
    const row = await requireNightOffer(tx, userId, id);
    return { offer: offerDto(row, new Date()), closesAt: row.pool.period.closesAt.toISOString() };
  });
}

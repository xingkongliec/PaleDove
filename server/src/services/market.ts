// 交易市场：卖家把自己的实例挂牌出售，买家用余额购买，成交后实例用「实例转移」过户给买家
import type {
  AdminMarketListingDTO,
  MarketHistoryDTO,
  MarketListingDTO,
  MarketListPageDTO,
  MarketMineDTO,
  MarketSaleSnapshotDTO,
  MarketSellableDTO,
  MarketSort,
} from '../shared/index.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { containsInsensitive, prisma, Prisma, type Instance, type User } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { getSetting, getSettings, setSetting } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { maskName } from './aff.ts';
import { beginListingPing, canRetry, pingDetail, pingSummary } from './market-ping.ts';
import { changeBalance } from './billing.ts';
import { renewalPrice } from './coupons.ts';
import { isRealNameApproved } from './realname/realname.ts';
import { money, trafficUsedBytes } from './serializers.ts';
import { enqueueTask, hasActiveTask } from './tasks.ts';
import { notify, resolveReinstallImage, transferInstance } from './transfer.ts';

/** 交易提交时保留一点时间，避免刚扣款就因为实例到期而无法过户。 */
const MARKET_SAFETY_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;
const PRICE_MAX = 1_000_000;

/**
 * 将后台配置转换为实际门槛：配置的天数是业务门槛，0 表示不额外限制，
 * 但仍保留 5 分钟交易缓冲。挂牌展示、创建挂牌和购买必须使用同一个门槛，
 * 否则会出现“能挂牌但不能买”或设置为 0 仍然要求 1 天的情况。
 */
export function marketMinLeftMs(minDays: number): number {
  const days = Number.isFinite(minDays) ? Math.max(0, Math.floor(minDays)) : 0;
  return Math.max(days * DAY_MS, MARKET_SAFETY_MS);
}

const include = {
  instance: {
    include: {
      node: true,
      coupon: true,
      image: { select: { name: true } },
      ipAddress: { select: { address: true } },
      plan: { include: { product: { select: { name: true, tags: true, description: true } } } },
    },
  },
  seller: { select: { id: true, username: true } },
  buyer: { select: { id: true, username: true } },
  target: { select: { id: true, username: true } },
} satisfies Prisma.MarketListingInclude;

type ListingRow = Prisma.MarketListingGetPayload<{ include: typeof include }>;

/** 手续费：成交价 × 费率，四舍五入到分 */
export function marketFee(price: Prisma.Decimal, rate: number): Prisma.Decimal {
  return price.mul(rate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

async function requireEnabled() {
  const settings = await getSettings();
  if (!settings.marketEnabled) throw badRequest(t('market.disabled'));
  return settings;
}

const tags = (v: Prisma.JsonValue | null): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

// ───────── DTO ─────────

function toListing(row: ListingRow, viewerId: number | null): MarketListingDTO {
  const inst = row.instance;
  const product = inst.plan?.product;
  const snap = saleSnapshot(row);
  const base: MarketListingDTO = {
    id: row.id,
    mine: viewerId !== null && row.sellerId === viewerId,
    targeted: row.targetUserId !== null,
    status: row.status,
    price: money(row.price),
    mode: row.mode,
    createdAt: row.createdAt.toISOString(),
    region: inst.node.region,
    country: inst.node.country,
    product: product ? { name: product.name, tags: tags(product.tags), description: product.description } : null,
    plan: inst.plan?.name ?? null,
    type: inst.type,
    cpu: inst.cpu,
    memory: inst.memory,
    disk: inst.disk,
    bandwidthIn: inst.bandwidthIn,
    bandwidthOut: inst.bandwidthOut,
    traffic: inst.traffic,
    trafficUsed: Number(trafficUsedBytes(inst)),
    trafficMode: inst.trafficMode,
    overLimitAction: inst.overLimitAction,
    throttleRate: inst.throttleRate,
    ipv4: inst.type === 'KVM_IPV4' ? 'DEDICATED' : 'NAT',
    ipv6Count: (inst.publicIpv6 ?? '').split(',').filter(Boolean).length,
    image: inst.image?.name ?? null,
    renewPrice: money(renewalPrice(inst)),
    billingCycle: inst.billingCycle,
    trafficResetPrice: inst.trafficResetPrice ? money(inst.trafficResetPrice) : null,
    expiresAt: inst.expiresAt.toISOString(),
    instanceStatus: inst.status,
    seller: maskName(row.seller.username),
    ping: pingSummary(row.ping),
    published: row.published,
  };
  if (!snap) return base;
  // 成交后实例已归买家：配置、地区、到期等以成交时的快照为准
  return {
    ...base,
    region: snap.region,
    country: snap.country,
    plan: snap.plan,
    type: snap.type,
    cpu: snap.cpu,
    memory: snap.memory,
    disk: snap.disk,
    bandwidthIn: snap.bandwidthIn,
    bandwidthOut: snap.bandwidthOut,
    traffic: snap.traffic,
    trafficUsed: snap.trafficUsed,
    trafficMode: snap.trafficMode,
    ipv4: snap.type === 'KVM_IPV4' ? ('DEDICATED' as const) : ('NAT' as const),
    ipv6Count: snap.ipv6.length,
    image: snap.image,
    renewPrice: snap.renewPrice,
    billingCycle: snap.billingCycle,
    expiresAt: snap.expiresAt,
    instanceStatus: snap.instanceStatus,
  };
}

/** 读取成交快照（字段不完整的视为没有） */
function saleSnapshot(row: Pick<ListingRow, 'snapshot'>): MarketSaleSnapshotDTO | null {
  const s = row.snapshot as Partial<MarketSaleSnapshotDTO> | null;
  return s && typeof s === 'object' && typeof s.instanceName === 'string' && typeof s.hostname === 'string' ? (s as MarketSaleSnapshotDTO) : null;
}

/** 给卖家看的成交记录：买家用户名脱敏、不含买家 ID（与挂牌记录一致）；管理员（viewerId 为 null）看完整记录 */
function snapshotFor(row: Pick<ListingRow, 'snapshot'>, viewerId: number | null): MarketSaleSnapshotDTO | null {
  const snap = saleSnapshot(row);
  if (!snap || viewerId === null) return snap;
  return { ...snap, buyer: { id: 0, username: maskName(snap.buyer.username) } };
}

/** 成交时记录实例信息（在过户之前调用，实例仍是卖家的状态） */
function buildSaleSnapshot(row: ListingRow, buyer: Pick<User, 'id' | 'username'>, fee: Prisma.Decimal): MarketSaleSnapshotDTO {
  const inst = row.instance;
  return {
    takenAt: new Date().toISOString(),
    instanceId: inst.id,
    instanceName: inst.name,
    hostname: inst.hostname,
    nodeId: inst.node.id,
    nodeName: inst.node.name,
    region: inst.node.region,
    country: inst.node.country,
    product: inst.plan?.product.name ?? null,
    plan: inst.plan?.name ?? null,
    type: inst.type,
    cpu: inst.cpu,
    memory: inst.memory,
    disk: inst.disk,
    bandwidthIn: inst.bandwidthIn,
    bandwidthOut: inst.bandwidthOut,
    traffic: inst.traffic,
    trafficUsed: Number(trafficUsedBytes(inst)),
    trafficMode: inst.trafficMode,
    publicIp: inst.type === 'KVM_IPV4' ? (inst.ipAddress?.address ?? null) : inst.node.publicIp || null,
    privateIp: inst.privateIp,
    ipv6: (inst.publicIpv6 ?? '').split(',').filter(Boolean),
    image: inst.image?.name ?? null,
    instanceStatus: inst.status,
    createdAt: inst.createdAt.toISOString(),
    expiresAt: inst.expiresAt.toISOString(),
    billingCycle: inst.billingCycle,
    renewPrice: money(renewalPrice(inst)),
    seller: { id: row.seller.id, username: row.seller.username },
    buyer: { id: buyer.id, username: buyer.username },
    price: money(row.price),
    fee: money(fee),
    income: money(row.price.minus(fee)),
    mode: row.mode,
  };
}

function toMine(row: ListingRow, viewerId: number | null, feeRate: number): MarketMineDTO {
  const fee = row.status === 'SOLD' ? row.fee : marketFee(row.price, feeRate);
  return {
    ...toListing(row, viewerId),
    instanceId: row.instanceId,
    hostname: saleSnapshot(row)?.hostname ?? row.instance.hostname,
    snapshot: snapshotFor(row, viewerId),
    fee: money(fee),
    income: money(row.price.minus(fee)),
    soldAt: row.soldAt?.toISOString() ?? null,
    buyer: row.buyer ? maskName(row.buyer.username) : null,
    target: row.target?.username ?? null,
    endReason: row.endReason,
  };
}

// ───────── 能否挂牌 / 购买 ─────────

/** 实例当前不能挂牌的原因（可以挂牌时返回 null） */
export async function sellBlocker(inst: Pick<Instance, 'id' | 'status' | 'expiresAt' | 'provisionedAt' | 'imageId'>, minDays: number): Promise<string | null> {
  if (!inst.provisionedAt || (inst.status !== 'RUNNING' && inst.status !== 'STOPPED')) return t('market.blocker.status');
  // 成交后一律全新安装再交给买家：实例必须记录了系统镜像
  if (!inst.imageId) return t('market.blocker.noImage');
  if (inst.expiresAt.getTime() - Date.now() < marketMinLeftMs(minDays)) {
    return minDays > 0 ? t('market.blocker.expiresSoon', { days: Math.floor(minDays) }) : t('market.blocker.expiresSoonNoDays');
  }
  if (await hasActiveTask(inst.id)) return t('market.blocker.busy');
  if (await prisma.marketListing.count({ where: { instanceId: inst.id, status: 'ACTIVE' } })) return t('market.blocker.listed');
  return null;
}

/** 实例正在挂牌时，卖家不能删除、重装、转移或重置密码 */
export async function assertNotListed(instanceId: number): Promise<void> {
  if (await prisma.marketListing.count({ where: { instanceId, status: 'ACTIVE' } })) throw conflict(t('market.instanceListed'));
}

/** 实例被删除等原因不再可售时，下架它的挂牌 */
export async function closeListings(instanceId: number, reason: string, tx: Pick<typeof prisma, 'marketListing'> = prisma): Promise<void> {
  await tx.marketListing.updateMany({ where: { instanceId, status: 'ACTIVE' }, data: { status: 'REMOVED', endReason: reason } });
}

// ───────── 市场列表 ─────────

export interface MarketQuery {
  page: number;
  pageSize: number;
  region?: string;
  q?: string;
  type?: Instance['type'];
  sort: MarketSort;
}

/** 在售商品的筛选条件：实例仍在运行 / 关机且剩余时间足够；定向挂牌只有指定买家和卖家看得到 */
function visibleWhere(viewerId: number | null, minLeftMs = MARKET_SAFETY_MS): Prisma.MarketListingWhereInput {
  return {
    status: 'ACTIVE',
    // 拨测完成后才公开
    published: true,
    instance: { status: { in: ['RUNNING', 'STOPPED'] }, expiresAt: { gt: new Date(Date.now() + minLeftMs) } },
    OR: viewerId ? [{ targetUserId: null }, { targetUserId: viewerId }, { sellerId: viewerId }] : [{ targetUserId: null }],
  };
}

export async function listMarket(q: MarketQuery, viewer: Pick<User, 'id'> | null): Promise<MarketListPageDTO> {
  const settings = await getSettings();
  if (!settings.marketEnabled) return { items: [], total: 0, page: q.page, pageSize: q.pageSize, regions: [] };
  const viewerId = viewer?.id ?? null;
  const base = visibleWhere(viewerId, marketMinLeftMs(settings.marketMinDays));
  const and: Prisma.MarketListingWhereInput[] = [base];
  if (q.region) and.push({ instance: { node: { region: q.region } } });
  if (q.type) and.push({ instance: { type: q.type } });
  if (q.q) {
    // 支持按挂牌编号搜索（如 3239 或 #3239），首页的「市场资源」卡片用它定位到具体商品
    const id = /^#?(\d{1,9})$/.exec(q.q)?.[1];
    const byName: Prisma.MarketListingWhereInput = { instance: { plan: { OR: [{ name: containsInsensitive(q.q) }, { product: { name: containsInsensitive(q.q) } }] } } };
    and.push(id ? { OR: [{ id: Number(id) }, byName] } : byName);
  }
  const where: Prisma.MarketListingWhereInput = { AND: and };
  const orderBy: Prisma.MarketListingOrderByWithRelationInput[] =
    q.sort === 'PRICE_ASC' ? [{ price: 'asc' }, { id: 'desc' }] : q.sort === 'PRICE_DESC' ? [{ price: 'desc' }, { id: 'desc' }] : q.sort === 'EXPIRES_DESC' ? [{ instance: { expiresAt: 'desc' } }, { id: 'desc' }] : [{ id: 'desc' }];
  const [rows, total, regionRows] = await Promise.all([
    prisma.marketListing.findMany({ where, include, orderBy, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.marketListing.count({ where }),
    prisma.marketListing.findMany({ where: base, select: { instance: { select: { node: { select: { region: true } } } } } }),
  ]);
  const regions = [...new Set(regionRows.map((r) => r.instance.node.region))].sort();
  return { items: rows.map((r) => toListing(r, viewerId)), total, page: q.page, pageSize: q.pageSize, regions };
}

// ───────── 首页推荐 ─────────

/** 首页推荐的展示时长 */
const FEATURE_MS = 24 * 3600_000;

/**
 * 首页「市场资源」：从公开在售的商品中随机抽取一位卖家的一个商品，展示 24 小时（每天更换）；
 * 展示期间被买走或下架时立即重新抽取，新商品同样展示 24 小时。市场关闭或没有在售商品时返回 null
 */
export async function featuredListing(): Promise<MarketListingDTO | null> {
  const settings = await getSettings();
  if (!settings.marketEnabled) return null;
  const where = visibleWhere(null, marketMinLeftMs(settings.marketMinDays));
  const current = async () => {
    const cur = await getSetting('marketFeatured');
    if (!cur.listingId || !cur.until || Date.parse(cur.until) <= Date.now()) return null;
    return prisma.marketListing.findFirst({ where: { AND: [where, { id: cur.listingId }] }, include });
  };
  const hit = await current();
  if (hit) return toListing(hit, null);
  // 并发请求只抽取一次
  return withLock('market:featured', 10_000, async () => {
    const again = await current();
    if (again) return toListing(again, null);
    const rows = await prisma.marketListing.findMany({ where, select: { id: true, sellerId: true } });
    if (!rows.length) {
      await setSetting('marketFeatured', { listingId: 0, until: '' });
      return null;
    }
    // 先随机选卖家再随机选商品：每位卖家机会相同，不会因为挂牌多就更容易被选中
    const sellers = [...new Set(rows.map((r) => r.sellerId))];
    const seller = sellers[Math.floor(Math.random() * sellers.length)];
    const own = rows.filter((r) => r.sellerId === seller);
    const pick = own[Math.floor(Math.random() * own.length)]!;
    await setSetting('marketFeatured', { listingId: pick.id, until: new Date(Date.now() + FEATURE_MS).toISOString() });
    const row = await prisma.marketListing.findUniqueOrThrow({ where: { id: pick.id }, include });
    return toListing(row, null);
  });
}

// ───────── 卖家：可挂牌的实例与我的挂牌 ─────────

export async function sellableInstances(user: Pick<User, 'id'>): Promise<MarketSellableDTO[]> {
  const { marketMinDays } = await getSettings();
  const rows = await prisma.instance.findMany({
    where: { userId: user.id, status: { notIn: ['DELETED', 'DELETING'] } },
    include: { node: { select: { region: true } }, plan: { select: { name: true } }, coupon: true },
    orderBy: { id: 'desc' },
  });
  return Promise.all(
    rows.map(async (i) => ({
      id: i.id,
      hostname: i.hostname,
      region: i.node.region,
      plan: i.plan?.name ?? null,
      type: i.type,
      cpu: i.cpu,
      memory: i.memory,
      disk: i.disk,
      renewPrice: money(renewalPrice(i)),
      billingCycle: i.billingCycle,
      expiresAt: i.expiresAt.toISOString(),
      status: i.status,
      hasImage: !!i.imageId,
      blocker: await sellBlocker(i, marketMinDays),
    })),
  );
}

export async function myListings(user: Pick<User, 'id'>): Promise<MarketMineDTO[]> {
  const { marketFeeRate } = await getSettings();
  const rows = await prisma.marketListing.findMany({ where: { sellerId: user.id }, include, orderBy: { id: 'desc' }, take: 200 });
  return rows.map((r) => toMine(r, user.id, marketFeeRate));
}

/** 我买到的实例（成交记录，买家视角）：成交快照与上架前拨测快照的存档 */
export async function myPurchases(user: Pick<User, 'id'>): Promise<MarketMineDTO[]> {
  const { marketFeeRate } = await getSettings();
  const rows = await prisma.marketListing.findMany({ where: { buyerId: user.id, status: 'SOLD' }, include, orderBy: { soldAt: 'desc' }, take: 200 });
  return rows.map((r) => {
    const mine = toMine(r, user.id, marketFeeRate);
    // 买家不需要卖家的手续费与到手金额
    return { ...mine, fee: money(new Prisma.Decimal(0)), income: mine.price, buyer: null, target: null };
  });
}

/**
 * 上架前拨测快照详情：在售商品对能看到它的人公开（定向商品只有卖家与指定买家）；
 * 已结束的商品只有卖家、买家与管理员能看。
 */
export async function listingPing(id: number, viewer: Pick<User, 'id' | 'role'> | null) {
  const row = await prisma.marketListing.findUnique({ where: { id }, select: { status: true, published: true, sellerId: true, buyerId: true, targetUserId: true, ping: true, instance: { select: { type: true } } } });
  const uid = viewer?.id ?? null;
  const party = uid !== null && (row?.sellerId === uid || row?.buyerId === uid);
  const visible =
    !!row &&
    (viewer?.role === 'ADMIN' || party || (row.status === 'ACTIVE' && row.published && (row.targetUserId === null || row.targetUserId === uid)));
  if (!row || !visible) throw notFound(t('market.notFound'));
  const ping = pingDetail(row.ping, row.instance.type);
  if (!ping) throw notFound(t('market.pingNone'));
  return ping;
}

async function findTarget(account: string, seller: Pick<User, 'id'>): Promise<User> {
  const value = account.trim();
  const user = await prisma.user.findFirst({ where: { OR: [{ username: value }, { email: value.toLowerCase() }] } });
  if (!user || user.role !== 'USER') throw notFound(t('transfer.targetNotFound'));
  if (user.status !== 'ACTIVE') throw badRequest(t('transfer.targetDisabled'));
  if (user.id === seller.id) throw badRequest(t('transfer.sameOwner'));
  return user;
}

export interface CreateListingInput {
  instanceId: number;
  price: number | string;
  /** 定向出售给指定用户（用户名或邮箱）；为空表示公开挂牌 */
  target?: string;
}

function parsePrice(raw: number | string): Prisma.Decimal {
  const price = new Prisma.Decimal(raw);
  if (!price.isFinite() || price.lte(0) || price.gt(PRICE_MAX)) throw badRequest(t('market.priceInvalid', { max: PRICE_MAX }));
  return price.toDecimalPlaces(2);
}

export async function createListing(user: User, input: CreateListingInput): Promise<MarketMineDTO> {
  const settings = await requireEnabled();
  const price = parsePrice(input.price);
  const inst = await prisma.instance.findFirst({ where: { id: input.instanceId, userId: user.id }, include: { node: true, ipAddress: true } });
  if (!inst) throw notFound(t('instance.notFound'));
  const target = input.target?.trim() ? await findTarget(input.target, user) : null;
  // 成交后一律全新安装：挂牌时先确认原镜像仍可用于重装
  await resolveReinstallImage(inst, inst.imageId ?? 0);
  const row = await withLock(`market-list:${inst.id}`, 20_000, async () => {
    const blocker = await sellBlocker(inst, settings.marketMinDays);
    if (blocker) throw badRequest(blocker);
    return prisma.marketListing.create({
      // 先不公开：拨测完成后自动公开
      data: { instanceId: inst.id, sellerId: user.id, planId: inst.planId, price, mode: 'REINSTALL', targetUserId: target?.id ?? null, published: false },
      include,
    });
  });
  // 上架前拨测：宿主机 Agent 从实例对外的 IPv4 向国内三网 Ping 一次，结果存档在商品上（见 market-ping.ts）。
  // 独立 IPv4 需要实例运行时才能测，由拨测流程测完后关机
  const { deferStop } = await beginListingPing(row.id, inst, user.id);
  // 挂牌期间实例关机并锁定（见 routes/instances.ts），成交后会全新安装再交给买家
  if (inst.status === 'RUNNING' && !deferStop) await enqueueTask({ instanceId: inst.id, type: 'STOP', userId: user.id }).catch(() => undefined);
  const fresh = await prisma.marketListing.findUniqueOrThrow({ where: { id: row.id }, include });
  return toMine(fresh, user.id, settings.marketFeeRate);
}

/** 拨测未完成（Agent 不在线、超时、出错）的商品重新拨测，完成后公开 */
export async function retryListingPing(user: Pick<User, 'id'>, id: number): Promise<MarketMineDTO> {
  const { marketFeeRate } = await requireEnabled();
  const row = await ownListing(user, id);
  if (!canRetry(row)) throw conflict(t('market.pingNoRetry'));
  const inst = await prisma.instance.findUniqueOrThrow({ where: { id: row.instanceId }, include: { node: true, ipAddress: true } });
  await beginListingPing(row.id, inst, user.id);
  return toMine(await prisma.marketListing.findUniqueOrThrow({ where: { id }, include }), user.id, marketFeeRate);
}

async function ownListing(user: Pick<User, 'id'>, id: number): Promise<ListingRow> {
  const row = await prisma.marketListing.findFirst({ where: { id, sellerId: user.id }, include });
  if (!row) throw notFound(t('market.notFound'));
  if (row.status !== 'ACTIVE') throw conflict(t('market.unavailable'));
  return row;
}

export async function updateListing(user: Pick<User, 'id'>, id: number, patch: { price: number | string }): Promise<MarketMineDTO> {
  const { marketFeeRate } = await getSettings();
  await ownListing(user, id);
  const row = await prisma.marketListing.update({
    where: { id },
    data: { price: parsePrice(patch.price) },
    include,
  });
  return toMine(row, user.id, marketFeeRate);
}

export async function cancelListing(user: Pick<User, 'id'>, id: number): Promise<void> {
  await ownListing(user, id);
  await prisma.marketListing.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'CANCELED' } });
}

// ───────── 买家：购买 ─────────

/** 退回已扣的款项（过户失败时的补偿）：直接调整余额，不会因为卖家已经花掉所得而失败 */
async function reverseSale(listing: ListingRow, buyerId: number, income: Prisma.Decimal): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await changeBalance(tx, buyerId, listing.price, 'MARKET', t('log.marketRefund', { id: listing.id }));
    if (income.gt(0)) {
      const { balance } = await tx.user.update({ where: { id: listing.sellerId }, data: { balance: { decrement: income } }, select: { balance: true } });
      await tx.balanceLog.create({ data: { userId: listing.sellerId, type: 'MARKET', amount: income.negated(), balanceAfter: balance, description: t('log.marketRefund', { id: listing.id }) } });
    }
    await tx.marketListing.update({ where: { id: listing.id }, data: { status: 'ACTIVE', buyerId: null, fee: 0, soldAt: null, snapshot: Prisma.DbNull } });
  });
}

export async function buyListing(id: number, buyer: User): Promise<{ instanceId: number }> {
  const settings = await requireEnabled();
  if (buyer.role !== 'USER' || buyer.status !== 'ACTIVE') throw forbidden();
  return withLock(`market-buy:${id}`, 120_000, async () => {
    const listing = await prisma.marketListing.findUnique({ where: { id }, include });
    if (!listing || listing.status !== 'ACTIVE') throw conflict(t('market.unavailable'));
    // 拨测完成后才公开、才能购买
    if (!listing.published) throw conflict(t('market.pingPending'));
    if (listing.sellerId === buyer.id) throw badRequest(t('market.ownListing'));
    // 定向挂牌对其他人表现为不存在
    if (listing.targetUserId && listing.targetUserId !== buyer.id) throw notFound(t('market.notFound'));
    const inst = listing.instance;
    if (inst.userId !== listing.sellerId || (inst.status !== 'RUNNING' && inst.status !== 'STOPPED') || inst.expiresAt.getTime() - Date.now() < marketMinLeftMs(settings.marketMinDays)) {
      throw conflict(t('market.unavailable'));
    }
    if (await hasActiveTask(inst.id)) throw conflict(t('market.blocker.busy'));
    if (inst.node.requireRealName && !(await isRealNameApproved(buyer.id))) throw badRequest(t('transfer.targetRealName'));

    const fee = marketFee(listing.price, settings.marketFeeRate);
    const income = listing.price.minus(fee);
    // 扣买家的钱、给卖家结算、把挂牌标记为已成交：一个事务
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.marketListing.updateMany({
        where: { id, status: 'ACTIVE', published: true },
        data: { status: 'SOLD', buyerId: buyer.id, fee, soldAt: new Date(), snapshot: buildSaleSnapshot(listing, buyer, fee) as unknown as Prisma.InputJsonValue },
      });
      if (!claimed.count) throw conflict(t('market.unavailable'));
      await changeBalance(tx, buyer.id, listing.price.negated(), 'MARKET', t('log.marketBuy', { id, plan: inst.plan?.name ?? inst.hostname }));
      if (income.gt(0)) await changeBalance(tx, listing.sellerId, income, 'MARKET', t('log.marketSell', { id, plan: inst.plan?.name ?? inst.hostname, fee: fee.toFixed(2) }));
    });

    // 过户；失败时退款并重新挂牌
    try {
      await transferInstance(
        { ...inst, node: inst.node },
        { actor: buyer, byAdmin: false, target: buyer.username, mode: 'REINSTALL', imageId: inst.imageId ?? undefined, remark: t('market.transferRemark', { id }), market: true },
      );
    } catch (err) {
      await reverseSale(listing, buyer.id, income);
      throw err;
    }

    const seller = await prisma.user.findUniqueOrThrow({ where: { id: listing.sellerId }, select: { id: true, locale: true } });
    const label = inst.plan?.name ?? inst.hostname;
    await notify(seller, () => ({
      title: t('market.msgSoldTitle', { plan: label }),
      content: [t('market.msgSold', { id, plan: label, price: settings.currency + listing.price.toFixed(2) }), t('market.msgSoldIncome', { fee: settings.currency + fee.toFixed(2), income: settings.currency + income.toFixed(2) })].join('\n'),
    }));
    await notify(buyer, () => ({
      title: t('market.msgBoughtTitle', { plan: label }),
      content: [
        t('market.msgBought', { id, host: inst.hostname, price: settings.currency + listing.price.toFixed(2) }),
        t('market.msgBoughtReinstall'),
        t('transfer.msgAutoRenew'),
      ].join('\n'),
    }));
    return { instanceId: inst.id };
  });
}

// ───────── 价格走势 ─────────

export type HistoryKind = 'ALL' | 'PUBLIC' | 'TARGETED';

/** 某件商品所属套餐最近 30 天的成交价走势；挂牌对看不到它的人不存在 */
export async function listingHistory(id: number, viewer: Pick<User, 'id'> | null, kind: HistoryKind): Promise<MarketHistoryDTO> {
  const viewerId = viewer?.id ?? null;
  const settings = await getSettings();
  const listing = await prisma.marketListing.findFirst({
    where: { id, OR: [{ AND: [visibleWhere(viewerId, marketMinLeftMs(settings.marketMinDays))] }, ...(viewerId ? [{ sellerId: viewerId }, { buyerId: viewerId }] : [])] },
    include,
  });
  if (!listing) throw notFound(t('market.notFound'));
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const sold = listing.planId
    ? await prisma.marketListing.findMany({
        where: { planId: listing.planId, status: 'SOLD', soldAt: { gte: from }, ...(kind === 'PUBLIC' ? { targetUserId: null } : kind === 'TARGETED' ? { targetUserId: { not: null } } : {}) },
        select: { price: true, soldAt: true, targetUserId: true },
        orderBy: { soldAt: 'asc' },
        take: 300,
      })
    : [];
  const prices = sold.map((s) => s.price);
  const sum = prices.reduce((a, p) => a.plus(p), new Prisma.Decimal(0));
  return {
    plan: listing.instance.plan?.name ?? null,
    renewPrice: money(renewalPrice(listing.instance)),
    currentPrice: money(listing.price),
    average: prices.length ? money(sum.div(prices.length)) : null,
    min: prices.length ? money(Prisma.Decimal.min(...prices)) : null,
    max: prices.length ? money(Prisma.Decimal.max(...prices)) : null,
    count: sold.length,
    from: from.toISOString(),
    to: to.toISOString(),
    points: sold.map((s) => ({ t: s.soldAt!.toISOString(), price: money(s.price), targeted: s.targetUserId !== null })),
  };
}

// ───────── 管理员 ─────────

export interface AdminMarketQuery {
  page: number;
  pageSize: number;
  status?: ListingRow['status'];
  q?: string;
}

export async function adminListings(q: AdminMarketQuery): Promise<{ items: AdminMarketListingDTO[]; total: number; page: number; pageSize: number }> {
  const { marketFeeRate } = await getSettings();
  const where: Prisma.MarketListingWhereInput = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.q
      ? {
          OR: [
            { seller: { username: containsInsensitive(q.q) } },
            { instance: { hostname: containsInsensitive(q.q) } },
            { instance: { plan: { name: containsInsensitive(q.q) } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.marketListing.findMany({ where, include, orderBy: { id: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    prisma.marketListing.count({ where }),
  ]);
  return {
    items: rows.map((r) => ({ ...toMine(r, null, marketFeeRate), sellerId: r.sellerId, sellerName: r.seller.username, buyerId: r.buyerId, buyer: r.buyer?.username ?? null })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

/** 管理员下架挂牌，并通知卖家 */
/**
 * 管理员修改出售中的商品：售价、定向买家（用户名或邮箱，空字符串改为公开出售）；可附说明。
 * 只修改传入的字段；有变化时通知卖家
 */
export async function adminUpdateListing(id: number, patch: { price?: number | string; target?: string; note?: string }): Promise<AdminMarketListingDTO> {
  const { marketFeeRate, currency } = await getSettings();
  const row = await prisma.marketListing.findUnique({ where: { id }, include });
  if (!row) throw notFound(t('market.notFound'));
  if (row.status !== 'ACTIVE') throw conflict(t('market.unavailable'));
  const data: Prisma.MarketListingUncheckedUpdateInput = {};
  const changes: string[] = [];
  if (patch.price !== undefined) {
    const price = parsePrice(patch.price);
    if (!price.eq(row.price)) {
      data.price = price;
      changes.push(t('market.msgEditedPrice', { from: currency + row.price.toFixed(2), to: currency + price.toFixed(2) }));
    }
  }
  if (patch.target !== undefined) {
    const target = patch.target.trim() ? await findTarget(patch.target, { id: row.sellerId }) : null;
    if ((target?.id ?? null) !== row.targetUserId) {
      data.targetUserId = target?.id ?? null;
      changes.push(target ? t('market.msgEditedTarget', { name: target.username }) : t('market.msgEditedPublic'));
    }
  }
  if (changes.length) {
    await prisma.marketListing.update({ where: { id }, data });
    const seller = await prisma.user.findUniqueOrThrow({ where: { id: row.sellerId }, select: { id: true, locale: true } });
    await notify(seller, () => ({
      title: t('market.msgEditedTitle', { host: row.instance.hostname }),
      content: [t('market.msgEdited', { id, host: row.instance.hostname }), ...changes, patch.note?.trim() ? t('market.msgRemovedReason', { reason: patch.note.trim() }) : null].filter(Boolean).join('\n'),
    }));
  }
  const fresh = await prisma.marketListing.findUniqueOrThrow({ where: { id }, include });
  return { ...toMine(fresh, null, marketFeeRate), sellerId: fresh.sellerId, sellerName: fresh.seller.username, buyerId: fresh.buyerId, buyer: fresh.buyer?.username ?? null };
}

export async function removeListing(id: number, reason: string): Promise<void> {
  const row = await prisma.marketListing.findUnique({ where: { id }, include });
  if (!row) throw notFound(t('market.notFound'));
  if (row.status !== 'ACTIVE') throw conflict(t('market.unavailable'));
  await prisma.marketListing.updateMany({ where: { id, status: 'ACTIVE' }, data: { status: 'REMOVED', endReason: reason || null } });
  const seller = await prisma.user.findUniqueOrThrow({ where: { id: row.sellerId }, select: { id: true, locale: true } });
  await notify(seller, () => ({
    title: t('market.msgRemovedTitle', { host: row.instance.hostname }),
    content: [t('market.msgRemoved', { id, host: row.instance.hostname }), reason ? t('market.msgRemovedReason', { reason }) : null].filter(Boolean).join('\n'),
  }));
}

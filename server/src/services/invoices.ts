import { BILLING_CYCLES, CYCLE_PRICE_FIELD, hasIpv6Mode, isNatType, isPublicIpv4Mode, isVmType, productNodeOption, scaleTraffic, type InvoiceDTO, type InvoicePurchaseConfigDTO, type NightPrizeSnapshot } from '../shared/index.ts';
import { encrypt, decrypt } from '../lib/crypto.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { containsInsensitive, prisma, Prisma, type Invoice, type User } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { t, labels } from '../i18n/index.ts';
import { quoteCoupon, recurringDiscount } from './coupons.ts';
import { orderNo, purchase, renew, type PurchaseInput } from './billing.ts';
import { purchaseTrafficReset } from './lifecycle.ts';
import { toInvoice } from './serializers.ts';
import { nightTransaction, normalizeNightPrize, requireNightOffer } from './night-market.ts';

type InvoiceWithRelations = Invoice & {
  instance: { hostname: string; type: 'LXC_NAT' | 'KVM_NAT' | 'KVM_IPV4' } | null;
  plan: { name: string; product: { name: string } } | null;
};

const expiresAt = () => new Date(Date.now() + 24 * 60 * 60 * 1000);

const purchasePlanInclude = {
  product: { include: { nodes: { select: { id: true, name: true, region: true, enabled: true, networkMode: true } } } },
} satisfies Prisma.PlanInclude;

function purchaseConfig(
  plan: Prisma.PlanGetPayload<{ include: typeof purchasePlanInclude }>,
  input: Pick<PurchaseInput, 'hostname' | 'region' | 'cycle' | 'nodeId'>,
  image: string | null,
  snapshot: boolean,
): InvoicePurchaseConfigDTO {
  const nodes = plan.product.nodes.filter((node) => node.enabled && node.region === input.region && isPublicIpv4Mode(node.networkMode) === !isNatType(plan.type) && (plan.ipv6Count > 0 ? hasIpv6Mode(node.networkMode) : node.networkMode !== 'IPV6_ONLY'));
  const node = input.nodeId ? nodes.find((n) => n.id === input.nodeId) : nodes.length === 1 ? nodes[0] : null;
  const multipliers = (node ? [node] : nodes).map((n) => productNodeOption(plan.product.nodeOptions, n.id).trafficMultiplier);
  return {
    product: plan.product.name,
    plan: plan.name,
    hostname: input.hostname,
    region: input.region,
    node: node?.name ?? null,
    image,
    cycle: input.cycle,
    type: plan.type,
    cpu: plan.cpu,
    cpuAllowance: plan.cpuAllowance,
    memory: plan.memory,
    swap: isVmType(plan.type) ? 0 : plan.swap,
    disk: plan.disk,
    diskRead: plan.diskRead,
    diskWrite: plan.diskWrite,
    diskReadIops: plan.diskReadIops,
    diskWriteIops: plan.diskWriteIops,
    bandwidthIn: plan.bandwidthIn,
    bandwidthOut: plan.bandwidthOut,
    traffic: scaleTraffic(plan.traffic, multipliers.length ? Math.min(...multipliers) : 1),
    trafficMode: plan.trafficMode,
    portLimit: isNatType(plan.type) ? plan.portLimit : 0,
    siteLimit: isNatType(plan.type) ? plan.siteLimit : 0,
    snapshotLimit: plan.snapshotLimit,
    ipv6Count: plan.ipv6Count,
    snapshot,
    trafficIsEstimate: plan.traffic > 0 && new Set(multipliers).size > 1,
  };
}

async function loadInvoice(id: number, userId: number): Promise<InvoiceWithRelations> {
  const row = await prisma.invoice.findFirst({
    where: { id, userId },
    include: { instance: { select: { hostname: true, type: true } }, plan: { select: { name: true, product: { select: { name: true } } } } },
  });
  if (!row) throw notFound(t('invoice.notFound'));
  return row as InvoiceWithRelations;
}

export async function createPurchaseInvoice(user: User, input: PurchaseInput): Promise<InvoiceWithRelations> {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId }, include: purchasePlanInclude });
  if (!plan || !plan.enabled || !plan.product.enabled) throw notFound(t('plan.unavailable'));
  const price = plan[CYCLE_PRICE_FIELD[input.cycle]];
  if (!price) throw badRequest(t('plan.cycleUnsupported', { cycle: labels().billingCycle[input.cycle] }));
  if (input.nightMarketOfferId && input.couponCode) throw badRequest(t('night.noStacking'));
  const coupon = input.couponCode ? await quoteCoupon(prisma, input.couponCode, { userId: user.id, kind: 'NEW', productId: plan.productId, planId: plan.id, cycle: input.cycle, amount: price }) : null;
  const amount = coupon ? price.minus(coupon.discount) : price;
  const image = await prisma.image.findUnique({ where: { id: input.imageId }, select: { name: true } });
  const invoiceInput = {
    userId: user.id,
    type: 'PURCHASE',
    amount,
    discount: coupon?.discount ?? new Prisma.Decimal(0),
    description: t('order.newDesc', { plan: plan.name, hostname: input.hostname }),
    planId: plan.id,
    payload: {
      planId: input.planId,
      region: input.region,
      imageId: input.imageId,
      cycle: input.cycle,
      hostname: input.hostname,
      sshKeys: input.sshKeys ?? [],
      couponCode: input.couponCode ?? null,
      discountSource: coupon ? 'COUPON' : null,
      nightMarketOfferId: input.nightMarketOfferId ?? null,
      nodeId: input.nodeId ?? null,
      passwordEnc: input.password ? encrypt(input.password) : null,
      purchaseConfig: { ...purchaseConfig(plan, input, image?.name ?? null, true) },
    },
  } satisfies Parameters<typeof createInvoice>[0];
  if (!input.nightMarketOfferId) return createInvoice(invoiceInput);
  return nightTransaction(async tx => {
    const offer = await requireNightOffer(tx, user.id, input.nightMarketOfferId!, { planId: input.planId, cycle: input.cycle });
    if (offer.invoice && (offer.invoice.status === 'PROCESSING' || (offer.invoice.status === 'PENDING' && (!offer.invoice.expiresAt || offer.invoice.expiresAt > new Date())))) {
      return await tx.invoice.findUniqueOrThrow({ where: { id: offer.invoice.id }, include: { instance: { select: { hostname: true, type: true } }, plan: { select: { name: true, product: { select: { name: true } } } } } }) as InvoiceWithRelations;
    }
    if (offer.invoice?.status === 'PENDING') await tx.invoice.update({ where: { id: offer.invoice.id }, data: { status: 'EXPIRED' } });
    const prize = normalizeNightPrize(offer.snapshot as unknown as NightPrizeSnapshot);
    const invoice = await createInvoice({ ...invoiceInput, payload: { ...invoiceInput.payload, discountSource: 'NIGHT_MARKET', nightMarket: { name: prize.name, quality: prize.quality, discountPercent: offer.discountPercent, discountMode: prize.discountMode, periodId: offer.pool.periodId } }, amount: offer.amount, discount: offer.originalPrice.minus(offer.amount), expiresAt: new Date(Math.min(expiresAt().getTime(), offer.pool.period.closesAt.getTime())) }, tx);
    await tx.nightMarketOffer.update({ where: { id: offer.id }, data: { invoiceId: invoice.id } });
    return invoice;
  });
}

export async function getInvoiceDetail(id: number, userId: number): Promise<InvoiceDTO> {
  const row = await loadInvoice(id, userId);
  return invoiceDetailDto(row);
}

/** 用户与管理员共用脱敏后的配置展示；调用方负责限定访问范围。 */
export async function invoiceDetailDto(row: InvoiceWithRelations): Promise<InvoiceDTO> {
  const dto = invoiceDto(row);
  if (row.type !== 'PURCHASE' || dto.purchaseConfig || !row.planId) return dto;
  // 旧账单没有下单配置快照，只以当前关联套餐补充展示，不改写历史数据。
  const payload = row.payload as Partial<PurchaseInput> | null;
  if (!payload?.cycle || !BILLING_CYCLES.includes(payload.cycle) || !payload.hostname || !payload.region) return dto;
  const [plan, image] = await Promise.all([
    prisma.plan.findUnique({ where: { id: row.planId }, include: purchasePlanInclude }),
    payload.imageId ? prisma.image.findUnique({ where: { id: payload.imageId }, select: { name: true } }) : null,
  ]);
  if (plan) dto.purchaseConfig = purchaseConfig(plan, { hostname: payload.hostname, region: payload.region, cycle: payload.cycle, nodeId: payload.nodeId }, image?.name ?? null, false);
  return dto;
}

export async function createRenewInvoice(userId: number, instanceId: number, periods: number, couponCode?: string): Promise<InvoiceWithRelations> {
  if (!Number.isInteger(periods) || periods < 1 || periods > 36) throw badRequest(t('renew.invalidPeriods'));
  const inst = await prisma.instance.findFirst({ where: { id: instanceId, userId, status: { notIn: ['DELETED', 'DELETING'] } }, include: { plan: { select: { productId: true } }, coupon: true } });
  if (!inst) throw notFound(t('instance.notFound'));
  if (inst.nightRenewPrice !== null && couponCode) throw badRequest(t('night.noStacking'));
  const existing = await prisma.invoice.findFirst({ where: { userId, instanceId, type: 'RENEW', status: { in: ['PENDING', 'PROCESSING'] } }, orderBy: { id: 'desc' }, include: { instance: { select: { hostname: true, type: true } }, plan: { select: { name: true, product: { select: { name: true } } } } } });
  if (existing) return existing as InvoiceWithRelations;
  if (inst.status === 'CREATING' && !inst.provisionedAt) throw badRequest(t('renew.notProvisioned'));
  const original = inst.price.mul(periods);
  const coupon = couponCode ? await quoteCoupon(prisma, couponCode, { userId, kind: 'RENEW', productId: inst.plan?.productId ?? null, planId: inst.planId, cycle: inst.billingCycle, amount: original, periods }) : null;
  const bound = !coupon && inst.coupon ? inst.coupon : null;
  const discount = inst.nightRenewPrice !== null ? original.minus(inst.nightRenewPrice.mul(periods)) : coupon?.discount ?? (bound ? recurringDiscount(bound, inst.price, periods) : new Prisma.Decimal(0));
  const applied = inst.nightRenewPrice !== null ? null : coupon?.coupon ?? bound;
  return createInvoice({
    userId,
    type: 'RENEW',
    amount: original.minus(discount),
    discount,
    description: t('order.renewDesc', { hostname: inst.hostname, periods }),
    instanceId,
    planId: inst.planId,
    payload: { instanceId, periods, couponCode: couponCode || null, appliedCouponCode: applied?.code ?? null, discountSource: inst.nightRenewPrice !== null ? 'NIGHT_MARKET' : applied ? 'COUPON' : null },
  });
}

export async function createTrafficResetInvoice(userId: number, instanceId: number): Promise<InvoiceWithRelations> {
  const inst = await prisma.instance.findFirst({ where: { id: instanceId, userId } });
  if (!inst) throw notFound(t('instance.notFound'));
  if (inst.trafficResetPrice === null) throw badRequest(t('traffic.resetUnavailable'));
  if (inst.traffic <= 0) throw badRequest(t('traffic.unlimited'));
  if (['DELETED', 'DELETING', 'CREATING'].includes(inst.status)) throw badRequest(t('traffic.resetBadStatus'));
  if (inst.status === 'SUSPENDED' && inst.suspendReason !== 'TRAFFIC') throw badRequest(t('traffic.resetBadStatus'));
  return createInvoice({
    userId,
    type: 'TRAFFIC_RESET',
    amount: inst.trafficResetPrice,
    discount: new Prisma.Decimal(0),
    description: t('log.trafficReset', { hostname: inst.hostname }),
    instanceId,
    payload: { instanceId },
  });
}

async function createInvoice(input: {
  userId: number;
  type: 'PURCHASE' | 'RENEW' | 'TRAFFIC_RESET';
  amount: Prisma.Decimal;
  discount: Prisma.Decimal;
  description: string;
  payload: Prisma.InputJsonValue;
  instanceId?: number;
  planId?: number | null;
  expiresAt?: Date;
}, db: Pick<Prisma.TransactionClient, 'invoice'> = prisma): Promise<InvoiceWithRelations> {
  const row = await db.invoice.create({
    data: {
      no: `INV${orderNo()}`,
      userId: input.userId,
      type: input.type,
      amount: input.amount,
      discount: input.discount,
      discountSource: (input.payload as { discountSource?: string }).discountSource ?? null,
      description: input.description,
      payload: input.payload,
      instanceId: input.instanceId,
      planId: input.planId ?? null,
      expiresAt: input.expiresAt ?? expiresAt(),
    },
    include: { instance: { select: { hostname: true, type: true } }, plan: { select: { name: true, product: { select: { name: true } } } } },
  });
  return row as InvoiceWithRelations;
}

export async function listInvoices(userId: number, filters: {
  page: number;
  pageSize: number;
  status?: Invoice['status'];
  type?: Invoice['type'];
  q?: string;
  startAt?: string;
  endAt?: string;
}) {
  const where: Prisma.InvoiceWhereInput = {
    userId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.q ? { no: containsInsensitive(filters.q) } : {}),
    ...((filters.startAt || filters.endAt) ? { createdAt: {
      ...(filters.startAt ? { gte: new Date(filters.startAt) } : {}),
      ...(filters.endAt ? { lt: new Date(filters.endAt) } : {}),
    } } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: { instance: { select: { hostname: true, type: true } }, plan: { select: { name: true, product: { select: { name: true } } } } },
      orderBy: { id: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.invoice.count({ where }),
  ]);
  return { items, total };
}

export async function cancelInvoice(id: number, userId: number): Promise<InvoiceWithRelations> {
  await loadInvoice(id, userId);
  const row = await prisma.invoice.updateMany({ where: { id, userId, status: 'PENDING' }, data: { status: 'CANCELED' } });
  if (!row.count) throw conflict(t('invoice.notPending'));
  return loadInvoice(id, userId);
}

export async function payInvoice(id: number, userId: number): Promise<InvoiceWithRelations> {
  return withLock(`invoice-pay:${id}`, 30_000, async () => {
    const current = await loadInvoice(id, userId);
    if (current.status === 'PAID') return current;
    if (current.status !== 'PENDING') throw conflict(t('invoice.notPending'));
    if (current.expiresAt && current.expiresAt < new Date()) {
      await prisma.invoice.update({ where: { id }, data: { status: 'EXPIRED' } });
      throw conflict(t('invoice.expired'));
    }
    const claimed = await prisma.invoice.updateMany({ where: { id, userId, status: 'PENDING' }, data: { status: 'PROCESSING' } });
    if (!claimed.count) throw conflict(t('invoice.processing'));
    try {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const payload = current.payload as Record<string, unknown>;
      let createdInstanceId: number | undefined;
      if (current.type === 'PURCHASE') {
        const input = { ...payload, password: payload.passwordEnc ? decrypt(String(payload.passwordEnc)) : undefined } as unknown as PurchaseInput;
        const completedOffer = input.nightMarketOfferId ? await prisma.nightMarketOffer.findFirst({ where: { id: input.nightMarketOfferId, invoiceId: current.id, purchasedAt: { not: null }, pool: { userId } }, include: { order: true } }) : null;
        createdInstanceId = completedOffer?.order?.instanceId ?? (await purchase(user, input, { invoiceId: current.id })).id;
      } else if (current.type === 'RENEW') {
        await renew(Number(payload.instanceId), Number(payload.periods), { userId, couponCode: typeof payload.couponCode === 'string' ? payload.couponCode : undefined });
      } else {
        const inst = await prisma.instance.findUniqueOrThrow({ where: { id: Number(payload.instanceId) } });
        await purchaseTrafficReset(inst);
      }
      await prisma.invoice.update({ where: { id }, data: { status: 'PAID', paidAt: new Date(), ...(createdInstanceId ? { instanceId: createdInstanceId } : {}) } });
      return loadInvoice(id, userId);
    } catch (error) {
      await prisma.invoice.updateMany({ where: { id, status: 'PROCESSING' }, data: { status: 'PENDING' } });
      throw error;
    }
  });
}

export function invoiceDto(row: InvoiceWithRelations) {
  return toInvoice(row);
}


import { randomInt } from 'node:crypto';
import {
  CYCLE_MONTHS,
  CYCLE_PRICE_FIELD,
  type DeleteRefundMode,
  hasIpv6Mode,
  isNatType,
  isPublicIpv4Mode,
  isVmType,
  nodeAllowsImage,
  nodeImageIds,
  productNodeOption,
  scaleTraffic,
  type BillingCycle,
} from '../shared/index.ts';
import { encrypt, generatePassword, randomId, randomMac } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound, paymentRequired } from '../lib/errors.ts';
import { isRealNameApproved } from './realname/realname.ts';
import { prisma, Prisma, type BalanceLogType, type Coupon, type Instance, type Node, type User } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { getSettings } from '../lib/settings.ts';
import { addCycle, dayjs, nextTrafficReset } from '../lib/time.ts';
import { labels, t } from '../i18n/index.ts';
import { allocatePrivateIp, allocateIpv6Resources, allocatePublicPort, ensureNatNetwork, hostPrivateIps, nodeLoads } from './allocation.ts';
import { createTaskRecord, dispatchTask, enqueueTask } from './tasks.ts';
import { sendBusinessNotice } from './mail/business-mail.ts';
import { consumeCoupon, quoteCoupon, recurringDiscount, releaseCoupon, renewalPrice } from './coupons.ts';
import { awardCommission, revokeCommission } from './aff.ts';
import { resolveNodeArchitectures } from './node-architecture.ts';

type Tx = Prisma.TransactionClient;

export function orderNo(): string {
  return dayjs().format('YYYYMMDDHHmmss') + String(randomInt(1_000_000)).padStart(6, '0');
}

/**
 * 修改用户余额并写入流水。amount 为负数时扣款，余额不足抛出 402。
 * 必须在事务中调用。
 */
export async function changeBalance(
  tx: Tx,
  userId: number,
  amount: Prisma.Decimal,
  type: BalanceLogType,
  description: string,
): Promise<Prisma.Decimal> {
  if (amount.isZero()) {
    const u = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
    return u.balance;
  }
  if (amount.isNegative()) {
    const res = await tx.user.updateMany({
      where: { id: userId, balance: { gte: amount.abs() } },
      data: { balance: { decrement: amount.abs() } },
    });
    if (res.count === 0) throw paymentRequired(t('err.insufficientBalance'));
  } else {
    await tx.user.update({ where: { id: userId }, data: { balance: { increment: amount } } });
  }
  const { balance } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { balance: true } });
  await tx.balanceLog.create({ data: { userId, type, amount, balanceAfter: balance, description } });
  return balance;
}

// ───────── 下单 ─────────

export interface SaleNodeDTO {
  id: number;
  name: string;
  /** 产品在这台宿主机上的流量倍率 */
  trafficMultiplier: number;
  /** 这台宿主机提供的镜像（按勾选与架构过滤）；null 为面板全部镜像 */
  imageIds: number[] | null;
  /** 这台宿主机现在能开通的套餐（网络类型、IPv6 条件匹配且未满载；独立 IP 套餐还需有空闲 IP） */
  plans: number[];
}

/** 购买页「选择节点」：产品在某地区的宿主机，以及每台现在能开通的套餐（镜像与实名在下单时再检查） */
export async function saleNodes(productId: number, region: string): Promise<SaleNodeDTO[]> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { nodes: { where: { enabled: true, region }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }, plans: { where: { enabled: true } } },
  });
  if (!product?.enabled) return [];
  const [loads, images] = await Promise.all([resolveNodeArchitectures(product.nodes).then(nodeLoads), prisma.image.findMany({ where: { enabled: true }, select: { id: true, arch: true } })]);
  return loads.map(({ node, active, freeIps }) => ({
    id: node.id,
    name: node.name,
    // 购买页切换宿主机时只显示这台宿主机有的镜像（未勾选且架构未知时为全部）
    imageIds: nodeImageIds(node.imageIds) === null && !node.arch ? null : images.filter((i) => nodeAllowsImage(node, i)).map((i) => i.id),
    // 产品在这台宿主机上的流量倍率：购买页切换宿主机时按它显示流量
    trafficMultiplier: productNodeOption(product.nodeOptions, node.id).trafficMultiplier,
    plans: product.plans
      .filter(
        (plan) =>
          node.status !== 'OFFLINE' &&
          active < node.maxInstances &&
          isPublicIpv4Mode(node.networkMode) === !isNatType(plan.type) &&
          nodeFitsIpv6(node, plan.ipv6Count) &&
          (plan.type !== 'KVM_IPV4' || freeIps > 0),
      )
      .map((plan) => plan.id),
  }));
}

export interface PurchaseInput {
  planId: number;
  region: string;
  imageId: number;
  cycle: BillingCycle;
  hostname: string;
  password?: string;
  sshKeys?: string[];
  couponCode?: string;
  /** 购买页选择的宿主机（产品在该地区有多台时）；不传时自动选择负载最低的 */
  nodeId?: number;
}

export async function activeInstanceCount(planId: number): Promise<number> {
  return prisma.instance.count({ where: { planId, status: { notIn: ['DELETED'] } } });
}

export async function purchase(user: User, input: PurchaseInput): Promise<Instance> {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId }, include: { product: { include: { nodes: true } } } });
  if (!plan || !plan.enabled || !plan.product.enabled) throw notFound(t('plan.unavailable'));
  const price = plan[CYCLE_PRICE_FIELD[input.cycle]];
  if (!price) throw badRequest(t('plan.cycleUnsupported', { cycle: labels().billingCycle[input.cycle] }));

  const image = await prisma.image.findUnique({ where: { id: input.imageId } });
  if (!image || !image.enabled) throw badRequest(t('image.unavailable'));
  if (isVmType(plan.type) ? !image.forVm : !image.forContainer) throw badRequest(t('image.typeMismatch'));

  if (plan.stock !== null && (await activeInstanceCount(plan.id)) >= plan.stock) throw conflict(t('plan.soldOut'));

  // 选择节点：同地区、已启用、未满载；网络模式与套餐类型匹配（NAT 套餐 ↔ NAT / IPv6 宿主机，独立 IP 套餐 ↔ 独立 IPv4 宿主机）；
  // IPv6 模式需已配置 IPv6 子网；独立 IP 套餐需有空闲 IP。优先选择负载最低的节点
  const candidates = plan.product.nodes.filter(
    (n) =>
      n.enabled &&
      n.region === input.region &&
      n.status !== 'OFFLINE' &&
      isPublicIpv4Mode(n.networkMode) === !isNatType(plan.type) &&
      nodeFitsIpv6(n, plan.ipv6Count),
  );
  // 宿主机可以只提供部分镜像
  const withImage = candidates.filter((n) => nodeAllowsImage(n, image));
  if (candidates.length && !withImage.length) throw badRequest(t('image.notInRegion'));
  // 要求实名的宿主机只分配给已通过实名认证的用户
  const verified = withImage.some((n) => n.requireRealName) ? await isRealNameApproved(user.id) : true;
  const allowed = verified ? withImage : withImage.filter((n) => !n.requireRealName);
  if (withImage.length && !allowed.length) throw new AppError(403, 'REALNAME_REQUIRED', t('realname.requiredToBuy'));
  const loads = (await nodeLoads(allowed)).filter((l) => l.active < l.node.maxInstances && (plan.type !== 'KVM_IPV4' || l.freeIps > 0));
  loads.sort((a, b) => a.active / a.node.maxInstances - b.active / b.node.maxInstances);
  if (loads.length === 0) throw conflict(t('region.noStock'));
  // 用户指定了宿主机：必须在可用列表中（满载、网络类型不符、需要实名或不提供所选镜像时都不可用）
  const chosen = input.nodeId ? loads.find((l) => l.node.id === input.nodeId) : loads[0];
  if (!chosen) throw conflict(t('store.nodeUnavailable'));
  let node = chosen.node;
  if (isNatType(plan.type)) node = await ensureNatNetwork(node);
  // 产品在这台宿主机上的设置：流量倍率与系统盘存储池（未设置时用套餐的存储池）
  const nodeOption = productNodeOption(plan.product.nodeOptions, node.id);

  const password = input.password || generatePassword();
  const now = new Date();

  const { instance, task } = await withAllocLocks(node, isNatType(plan.type), (hostIps) =>
    prisma.$transaction(async (tx) => {
      const no = orderNo();
      // 优惠码只抵扣首期，续费仍按原价
      const coupon = input.couponCode ? await quoteCoupon(tx, input.couponCode, { userId: user.id, kind: 'NEW', productId: plan.productId, planId: plan.id, cycle: input.cycle, amount: price }) : null;
      const pay = coupon ? price.minus(coupon.discount) : price;
      await changeBalance(
        tx,
        user.id,
        pay.negated(),
        'PURCHASE',
        t('log.purchase', { hostname: input.hostname, plan: plan.name, type: labels().instanceType[plan.type], cycle: labels().billingCycle[input.cycle], no }),
      );
      const created = await allocateInstance(
        tx,
        node,
        {
          hostname: input.hostname,
          userId: user.id,
          planId: plan.id,
          imageId: image.id,
          type: plan.type,
          cpu: plan.cpu,
          cpuAllowance: plan.cpuAllowance,
          cpuPriority: plan.cpuPriority,
          processLimit: plan.processLimit,
          memory: plan.memory,
          swap: isVmType(plan.type) ? 0 : plan.swap,
          disk: plan.disk,
          diskRead: plan.diskRead,
          diskWrite: plan.diskWrite,
          diskReadIops: plan.diskReadIops,
          diskWriteIops: plan.diskWriteIops,
          bandwidthIn: plan.bandwidthIn,
          bandwidthOut: plan.bandwidthOut,
          traffic: scaleTraffic(plan.traffic, nodeOption.trafficMultiplier),
          trafficMode: plan.trafficMode,
          overLimitAction: plan.overLimitAction,
          throttleRate: plan.throttleRate,
          trafficResetPrice: plan.trafficResetPrice,
          portLimit: plan.portLimit,
          siteLimit: plan.siteLimit,
          snapshotLimit: plan.snapshotLimit,
          storagePool: nodeOption.storagePool ?? plan.storagePool,
          privileged: plan.product.privileged,
          nesting: plan.product.nesting,
          boot: plan.product.boot ?? undefined,
          billingCycle: input.cycle,
          price,
          // 循环抵扣：优惠码绑定到实例，之后每次续费都按它减免
          couponId: coupon?.coupon.mode === 'RECURRING' ? coupon.coupon.id : null,
          expiresAt: addCycle(now, input.cycle),
        },
        { password, sshKeys: input.sshKeys ?? [], taskUserId: user.id, ipv6Count: plan.ipv6Count, hostIps },
      );
      const order = await tx.order.create({
        data: {
          no,
          userId: user.id,
          instanceId: created.instance.id,
          planId: plan.id,
          type: 'NEW',
          cycle: input.cycle,
          amount: pay,
          discount: coupon?.discount ?? 0,
          couponCode: coupon?.coupon.code ?? null,
          couponId: coupon?.coupon.id ?? null,
          description: t('order.newDesc', { plan: plan.name, hostname: input.hostname }),
        },
      });
      if (coupon) await consumeCoupon(tx, coupon.coupon, order, price, coupon.discount);
      await awardCommission(tx, order);
      return created;
    }),
  );

  await dispatchTask(task);
  return instance;
}

/** 实例的规格与计费字段：购买时从套餐复制，管理员创建时自由填写 */
type InstanceSpec = Pick<
  Prisma.InstanceUncheckedCreateInput,
  | 'hostname'
  | 'userId'
  | 'planId'
  | 'imageId'
  | 'type'
  | 'cpu'
  | 'cpuAllowance'
  | 'cpuPriority'
  | 'processLimit'
  | 'memory'
  | 'swap'
  | 'disk'
  | 'diskRead'
  | 'diskWrite'
  | 'diskReadIops'
  | 'diskWriteIops'
  | 'bandwidthIn'
  | 'bandwidthOut'
  | 'traffic'
  | 'trafficMode'
  | 'overLimitAction'
  | 'throttleRate'
  | 'trafficResetPrice'
  | 'portLimit'
  | 'siteLimit'
  | 'snapshotLimit'
  | 'storagePool'
  | 'privileged'
  | 'nesting'
  | 'boot'
  | 'billingCycle'
  | 'price'
  | 'expiresAt'
  | 'autoRenew'
  | 'couponId'
  | 'remark'
> & { type: Instance['type'] };

/** 同时持有 IP 分配锁与端口锁，避免与并发的下单 / 端口映射请求冲突 */
function withAllocLocks<T>(node: Node, nat: boolean, fn: (hostIps: ReadonlySet<string>) => Promise<T>): Promise<T> {
  return withLock(`node-alloc:${node.id}`, 60_000, async () => {
    const hostIps = nat ? await hostPrivateIps(node) : new Set<string>();
    return withLock(`node-ports:${node.id}`, 20_000, () => fn(hostIps));
  });
}

/**
 * 在事务中创建实例记录并分配网络资源（内网 IP / 独立 IPv4 / 公网 IPv6 / SSH 端口映射），
 * 同时创建开通任务（事务提交后由调用方派发）。调用方需持有 withAllocLocks。
 */
/**
 * 宿主机能否满足 IPv6 数量要求：需要 IPv6 时宿主机须为 IPv6 模式且配置了子网；
 * 不需要时不能是 IPv6 Only 宿主机（否则实例没有任何公网入口）
 */
export function nodeFitsIpv6(node: Pick<Node, 'networkMode' | 'ipv6Subnet'>, ipv6Count: number): boolean {
  return ipv6Count > 0 ? hasIpv6Mode(node.networkMode) && !!node.ipv6Subnet : node.networkMode !== 'IPV6_ONLY';
}

async function allocateInstance(tx: Tx, node: Node, spec: InstanceSpec, opts: { password: string; sshKeys: string[]; taskUserId: number; ipv6Count: number; hostIps: ReadonlySet<string> }) {
  let ipId: number | null = null;
  if (spec.type === 'KVM_IPV4') {
    const ip = await tx.ipAddress.findFirst({
      where: { nodeId: node.id, instanceId: null, disabled: false },
      orderBy: { id: 'asc' },
    });
    if (!ip) throw conflict(t('ip.soldOut'));
    ipId = ip.id;
  }

  const now = new Date();
  const anchorDay = now.getDate();
  const instance = await tx.instance.create({
    data: {
      ...spec,
      // 实例 ID：pd-所属用户 ID-随机编码，便于在宿主机上辨认归属
      name: `pd-${spec.userId}-${randomId(8)}`,
      nodeId: node.id,
      status: 'CREATING',
      privateIp: isNatType(spec.type) ? await allocatePrivateIp(tx, node, opts.hostIps) : null,
      ...(opts.ipv6Count > 0 && hasIpv6Mode(node.networkMode) ? await allocateIpv6Resources(tx, node, opts.ipv6Count) : {}),
      macAddress: randomMac(),
      rootPassword: encrypt(opts.password),
      trafficAnchorDay: anchorDay,
      // 流量周期以开通时间为锚点，与 createdAt 保持一致
      createdAt: now,
      trafficResetAt: nextTrafficReset(now, now),
    },
  });

  if (ipId !== null) {
    const res = await tx.ipAddress.updateMany({ where: { id: ipId, instanceId: null }, data: { instanceId: instance.id } });
    if (res.count === 0) throw conflict(t('ip.conflict'));
  }

  // IPv6 Only 宿主机不做端口映射，SSH 直接通过实例的公网 IPv6 访问
  if (isNatType(spec.type) && node.networkMode !== 'IPV6_ONLY') {
    const sshPort = await allocatePublicPort(tx, node);
    await tx.portMapping.create({
      data: {
        instanceId: instance.id,
        nodeId: node.id,
        protocol: 'TCP',
        publicPort: sshPort,
        privatePort: 22,
        description: 'SSH',
        system: true,
      },
    });
    await tx.instance.update({ where: { id: instance.id }, data: { sshPort } });
  }

  const task = await createTaskRecord(tx, {
    instanceId: instance.id,
    type: 'CREATE',
    userId: opts.taskUserId,
    payload: { password: encrypt(opts.password), sshKeys: opts.sshKeys },
  });
  return { instance, task };
}

// ───────── 管理员创建 ─────────

export interface AdminCreateInput extends Omit<InstanceSpec, 'price' | 'expiresAt' | 'planId'> {
  nodeId: number;
  /** 分配的公网 IPv6 数量，0 表示不分配；不传时 IPv6 模式宿主机分配 1 个 */
  ipv6Count?: number;
  planId: number | null;
  price: Prisma.Decimal;
  expiresAt: Date;
  password?: string;
  sshKeys?: string[];
  /** 从用户余额扣除首期费用并生成订单（开通失败删除时自动退款）；否则免费开通 */
  charge: boolean;
}

/**
 * 管理员为用户创建实例：规格自由填写，直接指定宿主机（不受套餐库存、宿主机满载与实名要求限制），
 * 但网络模式、镜像与宿主机必须匹配。
 */
export async function adminCreateInstance(admin: User, input: AdminCreateInput): Promise<Instance> {
  const { nodeId, password: rawPassword, sshKeys, charge, ipv6Count: wantIpv6, ...spec } = input;
  const user = await prisma.user.findUnique({ where: { id: spec.userId } });
  if (!user) throw notFound(t('user.notFound'));
  let node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node) throw notFound(t('node.notFound'));
  if (node.status === 'PENDING') throw badRequest(t('adminCreate.nodePending'));
  if (isPublicIpv4Mode(node.networkMode) === isNatType(spec.type)) throw badRequest(t('adminCreate.typeMismatch'));
  if (hasIpv6Mode(node.networkMode) && !node.ipv6Subnet) throw badRequest(t('adminCreate.noIpv6Subnet'));
  const ipv6Count = wantIpv6 ?? (hasIpv6Mode(node.networkMode) ? 1 : 0);
  if (!nodeFitsIpv6(node, ipv6Count)) throw badRequest(t(ipv6Count > 0 ? 'adminCreate.noIpv6Mode' : 'adminCreate.ipv6OnlyNeedsIpv6'));
  const image = await prisma.image.findUnique({ where: { id: spec.imageId! } });
  if (!image) throw badRequest(t('image.unavailable'));
  if (isVmType(spec.type) ? !image.forVm : !image.forContainer) throw badRequest(t('image.typeMismatch'));
  if (!nodeAllowsImage(node, image)) throw badRequest(t('adminCreate.imageNotOnNode'));
  const plan = spec.planId ? await prisma.plan.findUnique({ where: { id: spec.planId }, include: { product: { select: { boot: true } } } }) : null;
  if (spec.planId && !plan) throw notFound(t('plan.notFound'));
  // 启动设置跟随所选套餐的产品
  if (plan?.product.boot) spec.boot = plan.product.boot;
  if (isNatType(spec.type)) node = await ensureNatNetwork(node);

  const target = node;
  const password = rawPassword || generatePassword();
  const { instance, task } = await withAllocLocks(target, isNatType(spec.type), (hostIps) =>
    prisma.$transaction(async (tx) => {
      const created = await allocateInstance(tx, target, spec, { password, sshKeys: sshKeys ?? [], taskUserId: admin.id, ipv6Count, hostIps });
      if (charge && spec.price.gt(0)) {
        const no = orderNo();
        await changeBalance(tx, user.id, spec.price.negated(), 'PURCHASE', t('log.adminCreate', { hostname: spec.hostname, no }));
        const order = await tx.order.create({
          data: {
            no,
            userId: user.id,
            instanceId: created.instance.id,
            planId: spec.planId,
            type: 'NEW',
            cycle: spec.billingCycle,
            amount: spec.price,
            description: t('order.adminCreateDesc', { hostname: spec.hostname }),
          },
        });
        await awardCommission(tx, order);
      }
      return created;
    }),
  );
  await dispatchTask(task);
  return instance;
}

// ───────── 续费 ─────────

export async function renew(
  instanceId: number,
  periods: number,
  opts: { userId?: number | null; auto?: boolean; couponCode?: string } = {},
): Promise<Instance> {
  if (!Number.isInteger(periods) || periods < 1 || periods > 36) throw badRequest(t('renew.invalidPeriods'));
  const result = await prisma.$transaction(async (tx) => {
    const inst = await tx.instance.findUniqueOrThrow({ where: { id: instanceId } });
    if (['DELETED', 'DELETING'].includes(inst.status)) throw badRequest(t('renew.deleted'));
    if (inst.status === 'CREATING' && !inst.provisionedAt) throw badRequest(t('renew.notProvisioned'));
    const amount = inst.price.mul(periods);
    const no = orderNo();
    const productId = inst.planId ? ((await tx.plan.findUnique({ where: { id: inst.planId }, select: { productId: true } }))?.productId ?? null) : null;
    // 本次填写的优惠码优先；没有填写时套用实例绑定的循环抵扣优惠码（自动续费也会套用）
    const coupon = opts.couponCode ? await quoteCoupon(tx, opts.couponCode, { userId: inst.userId, kind: 'RENEW', productId, planId: inst.planId, cycle: inst.billingCycle, amount, periods }) : null;
    const bound = !coupon && inst.couponId ? await tx.coupon.findUnique({ where: { id: inst.couponId } }) : null;
    const discount = coupon?.discount ?? (bound ? recurringDiscount(bound, inst.price, periods) : null);
    const applied = coupon?.coupon ?? bound;
    const pay = discount ? amount.minus(discount) : amount;
    await changeBalance(
      tx,
      inst.userId,
      pay.negated(),
      'RENEW',
      t(opts.auto ? 'log.autoRenew' : 'log.renew', { hostname: inst.hostname, cycle: labels().billingCycle[inst.billingCycle], periods, no }),
    );
    // 未过期从到期时间顺延；已过期从当前时间起算
    const base = inst.expiresAt > new Date() ? inst.expiresAt : new Date();
    let expiresAt = base;
    for (let i = 0; i < periods; i++) expiresAt = addCycle(expiresAt, inst.billingCycle, inst.createdAt.getDate());
    const order = await tx.order.create({
      data: {
        no,
        userId: inst.userId,
        instanceId: inst.id,
        planId: inst.planId,
        type: 'RENEW',
        cycle: inst.billingCycle,
        amount: pay,
        discount: discount ?? 0,
        couponCode: applied?.code ?? null,
        couponId: applied?.id ?? null,
        description: t(opts.auto ? 'order.autoRenewDesc' : 'order.renewDesc', { hostname: inst.hostname, periods }),
      },
    });
    if (coupon) await consumeCoupon(tx, coupon.coupon, order, amount, coupon.discount);
    await awardCommission(tx, order);
    // 续费时用了新的循环抵扣优惠码：改为绑定它
    return tx.instance.update({ where: { id: inst.id }, data: { expiresAt, ...(coupon?.coupon.mode === 'RECURRING' ? { couponId: coupon.coupon.id } : {}) } });
  });

  if (result.status === 'SUSPENDED' && result.suspendReason === 'EXPIRED') {
    await enqueueTask({ instanceId: result.id, type: 'UNSUSPEND', userId: opts.userId ?? null, exclusive: false });
  }
  if (opts.auto) void sendBusinessNotice(result.userId, 'renewed', { name: result.hostname, time: result.expiresAt.toISOString() }, `${result.id}:${result.expiresAt.toISOString()}`).catch((error) => console.error('renewal email failed', error));
  return result;
}

/** 删除从未开通成功的实例时，退还新购订单金额 */
export async function refundUnprovisioned(tx: Tx, inst: Instance): Promise<void> {
  if (inst.provisionedAt) return;
  const order = await tx.order.findFirst({ where: { instanceId: inst.id, type: 'NEW', status: 'PAID' } });
  if (!order) return;
  await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
  await releaseCoupon(tx, order.id);
  await revokeCommission(tx, order.id);
  await changeBalance(tx, inst.userId, order.amount, 'REFUND', t('log.refundUnprovisioned', { hostname: inst.hostname, no: order.no }));
}

/**
 * 实例的剩余价值：每期实际续费价格（扣除循环抵扣优惠）× 剩余时长 / 一期时长，向下取到分。
 * 一期时长按到期时间往前推一个计费周期计算；已过期为 0。
 */
export function remainingValue(inst: Pick<Instance, 'expiresAt' | 'billingCycle' | 'price'> & { coupon?: Coupon | null }, now = new Date()): Prisma.Decimal {
  const left = inst.expiresAt.getTime() - now.getTime();
  if (left <= 0) return new Prisma.Decimal(0);
  const cycleMs = inst.expiresAt.getTime() - dayjs(inst.expiresAt).subtract(CYCLE_MONTHS[inst.billingCycle], 'month').valueOf();
  return renewalPrice(inst).mul(left).div(cycleMs).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
}

/**
 * 管理员删除实例时退款，返回退款金额：
 *  - REMAINING：按剩余价值退回余额
 *  - FULL：退回该实例全部已付订单（订单标记为已退款，撤回推广佣金）
 *  - NONE：不退款
 * 从未开通成功的实例，只要不是 NONE 就退回新购订单的全款。
 */
export async function refundOnDelete(tx: Tx, inst: Instance, mode: DeleteRefundMode): Promise<Prisma.Decimal> {
  const zero = new Prisma.Decimal(0);
  if (mode === 'NONE') return zero;
  if (!inst.provisionedAt) {
    const order = await tx.order.findFirst({ where: { instanceId: inst.id, type: 'NEW', status: 'PAID' } });
    await refundUnprovisioned(tx, inst);
    return order?.amount ?? zero;
  }
  if (mode === 'FULL') {
    const orders = await tx.order.findMany({ where: { instanceId: inst.id, status: 'PAID' } });
    let total = zero;
    for (const order of orders) {
      await tx.order.update({ where: { id: order.id }, data: { status: 'REFUNDED' } });
      await revokeCommission(tx, order.id);
      total = total.plus(order.amount);
    }
    if (total.gt(0)) await changeBalance(tx, inst.userId, total, 'REFUND', t('log.refundDeleteFull', { hostname: inst.hostname }));
    return total;
  }
  const coupon = inst.couponId ? await tx.coupon.findUnique({ where: { id: inst.couponId } }) : null;
  const value = remainingValue({ ...inst, coupon });
  if (value.gt(0)) await changeBalance(tx, inst.userId, value, 'REFUND', t('log.refundDeleteRemaining', { hostname: inst.hostname }));
  return value;
}

/**
 * 删除前预览各退款方式的退款金额（只读，算法与 refundOnDelete 一致）：
 * 从未开通成功的实例，除 NONE 外都退回新购订单金额
 */
export async function previewRefundOnDelete(inst: Instance): Promise<Record<DeleteRefundMode, Prisma.Decimal>> {
  const zero = new Prisma.Decimal(0);
  if (!inst.provisionedAt) {
    const order = await prisma.order.findFirst({ where: { instanceId: inst.id, type: 'NEW', status: 'PAID' }, select: { amount: true } });
    const amount = order?.amount ?? zero;
    return { REMAINING: amount, FULL: amount, NONE: zero };
  }
  const orders = await prisma.order.findMany({ where: { instanceId: inst.id, status: 'PAID' }, select: { amount: true } });
  const coupon = inst.couponId ? await prisma.coupon.findUnique({ where: { id: inst.couponId } }) : null;
  return {
    REMAINING: remainingValue({ ...inst, coupon }),
    FULL: orders.reduce((sum, o) => sum.plus(o.amount), zero),
    NONE: zero,
  };
}

// ───────── 兑换码 ─────────

export async function redeemCode(userId: number, rawCode: string): Promise<Prisma.Decimal> {
  const code = rawCode.trim().toUpperCase();
  return prisma.$transaction(async (tx) => {
    const row = await tx.redeemCode.findUnique({ where: { code } });
    if (!row) throw badRequest(t('redeem.notFound'));
    if (row.expiresAt && row.expiresAt < new Date()) throw badRequest(t('redeem.expired'));
    // 每个账号只能兑换一次；兑换记录有唯一约束，并发提交时只有一次成功
    if (await tx.redeemUsage.findUnique({ where: { codeId_userId: { codeId: row.id, userId } } })) throw badRequest(t('redeem.alreadyRedeemed'));
    if (row.usedCount >= row.maxUses) throw badRequest(t('redeem.used'));
    const claimed = await tx.redeemCode.updateMany({
      where: { id: row.id, usedCount: { lt: row.maxUses } },
      data: { usedCount: { increment: 1 }, usedById: userId, usedAt: new Date() },
    });
    if (claimed.count === 0) throw badRequest(t('redeem.used'));
    await tx.redeemUsage.create({ data: { codeId: row.id, userId } }).catch(() => {
      throw badRequest(t('redeem.alreadyRedeemed'));
    });
    return changeBalance(tx, userId, row.amount, 'REDEEM', t('log.redeem', { code: `${code.slice(0, 4)}****` }));
  });
}

export function generateRedeemCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join('-');
}


export async function reinstallCooldownCheck(inst: Instance): Promise<void> {
  const { reinstallCooldownMinutes } = await getSettings();
  if (!reinstallCooldownMinutes || !inst.lastReinstallAt) return;
  const next = inst.lastReinstallAt.getTime() + reinstallCooldownMinutes * 60_000;
  if (next > Date.now()) {
    throw badRequest(t('reinstall.cooldown', { minutes: Math.ceil((next - Date.now()) / 60_000) }));
  }
}

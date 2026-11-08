import type {
  ActivityLogDTO,
  AdminImageDTO,
  AdminInstanceDTO,
  AdminPlanDTO,
  AdminProductDTO,
  AdminUserDTO,
  AnnouncementDTO,
  BalanceLogDTO,
  ImageDTO,
  InvoiceDTO,
  InvoicePurchaseConfigDTO,
  InstanceDTO,
  IpAddressDTO,
  MeDTO,
  NodeDTO,
  OrderDTO,
  PaymentDTO,
  PlanDTO,
  ProductDTO,
  ProxySiteDTO,
  PortMappingDTO,
  RedeemCodeDTO,
  SiteBindingDTO,
  SnapshotDTO,
  TaskDTO,
  PlanRegionInfo,
} from '../shared/index.ts';
import { bootOptions, hasIpv6Mode, isNatType, isPublicIpv4Mode, nodeAllowsImage, nodeImageIds, parseIpv6List, productNodeOption } from '../shared/index.ts';
import { prisma } from '../lib/prisma.ts';
import { createHash } from 'node:crypto';
import { DEFAULT_AVATAR_STYLE, isAvatarStyle, type AvatarDTO } from '../shared/index.ts';
import type {
  Announcement,
  BalanceLog,
  Coupon,
  Image,
  Invoice,
  Instance,
  IpAddress,
  Node,
  Order,
  Payment,
  Plan,
  Product,
  PortMapping,
  Prisma,
  ProxySite,
  RedeemCode,
  SiteBinding,
  Snapshot,
  Task,
  User,
} from '../lib/prisma.ts';
import { endpointAddress } from '../incus/client.ts';
import { renewalPrice } from './coupons.ts';
import { trafficCycleStart } from '../lib/time.ts';
import { paymentNames } from './payments/payments.ts';

type Decimalish = Prisma.Decimal | null | undefined;

export const money = (d: Decimalish): string => (d ? d.toFixed(2) : '0.00');
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function trafficUsedBytes(inst: Pick<Instance, 'trafficIn' | 'trafficOut' | 'trafficMode'>): bigint {
  switch (inst.trafficMode) {
    case 'IN':
      return inst.trafficIn;
    case 'OUT':
      return inst.trafficOut;
    case 'BOTH':
      return inst.trafficIn + inst.trafficOut;
    case 'MAX':
      return inst.trafficIn > inst.trafficOut ? inst.trafficIn : inst.trafficOut;
  }
}

/** 第三方登录注册的账号没有本地密码（passwordHash 以 oauth$ 开头，不是合法的哈希） */
export const hasPassword = (u: Pick<User, 'passwordHash'>) => !u.passwordHash.startsWith('oauth$');

/** 返回给前端的当前用户信息（去掉敏感字段） */
/** 用户头像：所选风格 + 邮箱（去空格、小写）的 md5 作为种子，不向第三方暴露明文邮箱 */
export function toAvatar(user: { email: string; avatarStyle: string; avatarVariant: number }): AvatarDTO {
  return {
    style: isAvatarStyle(user.avatarStyle) ? user.avatarStyle : DEFAULT_AVATAR_STYLE,
    seed: createHash('md5').update(user.email.trim().toLowerCase()).digest('hex'),
    variant: user.avatarVariant,
  };
}

export function toMe(user: User, impersonatedBy?: { id: number; username: string } | null): MeDTO {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    avatar: toAvatar(user),
    role: user.role,
    balance: money(user.balance),
    createdAt: user.createdAt.toISOString(),
    locale: (user.locale as MeDTO['locale']) ?? null,
    country: user.country,
    theme: (user.theme as MeDTO['theme']) ?? null,
    totpEnabled: !!user.totpEnabledAt,
    hasPassword: hasPassword(user),
    announceEmail: user.announceEmail,
    balanceAlert: user.balanceAlert,
    alertEmail: user.alertEmail,
    impersonatedBy: impersonatedBy ?? null,
  };
}

export function toTask(t: Task & { instance?: { name: string } | null; user?: Pick<User, 'id' | 'username'> | null }): TaskDTO {
  return {
    id: t.id,
    type: t.type,
    status: t.status,
    error: t.error,
    createdAt: t.createdAt.toISOString(),
    startedAt: iso(t.startedAt),
    finishedAt: iso(t.finishedAt),
    instanceId: t.instanceId,
    instanceName: t.instance?.name ?? null,
    user: t.user ? { id: t.user.id, username: t.user.username } : null,
  };
}

function planPrices(plan: Plan): PlanDTO['prices'] {
  const prices: PlanDTO['prices'] = {};
  if (plan.priceMonthly) prices.MONTHLY = money(plan.priceMonthly);
  if (plan.priceQuarterly) prices.QUARTERLY = money(plan.priceQuarterly);
  if (plan.priceSemiannual) prices.SEMIANNUAL = money(plan.priceSemiannual);
  if (plan.priceAnnual) prices.ANNUAL = money(plan.priceAnnual);
  return prices;
}

type SaleNode = Pick<Node, 'id' | 'region' | 'enabled' | 'networkMode'> & Partial<Pick<Node, 'requireRealName' | 'imageIds' | 'arch'>>;

/** 宿主机可用的镜像 ID（null 为全部）；传入镜像列表时按宿主机架构过滤 */
function nodeImages(n: SaleNode, images?: Pick<Image, 'id' | 'arch'>[]): number[] | null {
  const ids = nodeImageIds(n.imageIds);
  if (!images || (ids === null && !n.arch)) return ids;
  return images.filter((i) => nodeAllowsImage(n, i)).map((i) => i.id);
}

/** 套餐在各地区的可用镜像（任一宿主机用面板全部镜像时为 null）与是否需要实名（该地区宿主机全部要求实名） */
function regionInfo(nodes: SaleNode[], nodeOptions: Prisma.JsonValue | null, images?: Pick<Image, 'id' | 'arch'>[]): Record<string, PlanRegionInfo> {
  const out: Record<string, PlanRegionInfo> = {};
  for (const region of new Set(nodes.filter((n) => n.enabled).map((n) => n.region))) {
    const list = nodes.filter((n) => n.enabled && n.region === region);
    const ids = list.map((n) => nodeImages(n, images));
    out[region] = {
      imageIds: ids.some((x) => x === null) ? null : [...new Set(ids.flat() as number[])],
      realName: list.every((n) => !!n.requireRealName),
      trafficMultiplier: Math.min(...list.map((n) => productNodeOption(nodeOptions, n.id).trafficMultiplier)),
    };
  }
  return out;
}

/** 套餐可用的宿主机：所属产品绑定的宿主机中网络模式与套餐类型匹配的（NAT 套餐 ↔ NAT / IPv6，独立 IP 套餐 ↔ 独立 IPv4） */
function planNodes(plan: Plan, nodes: SaleNode[]) {
  return nodes.filter(
    (n) => isPublicIpv4Mode(n.networkMode) === !isNatType(plan.type) && (plan.ipv6Count > 0 ? hasIpv6Mode(n.networkMode) : n.networkMode !== 'IPV6_ONLY'),
  );
}

type PlanProduct = { nodes: SaleNode[]; nodeOptions: Prisma.JsonValue | null };

/** images：全部镜像的架构，用于按宿主机架构计算各地区可用镜像（购买页需要） */
export function toPlan(plan: Plan & { product: PlanProduct }, activeInstances: number, images?: Pick<Image, 'id' | 'arch'>[]): PlanDTO {
  const nodes = planNodes(plan, plan.product.nodes);
  return {
    id: plan.id,
    productId: plan.productId,
    name: plan.name,
    description: plan.description,
    type: plan.type,
    cpu: plan.cpu,
    cpuAllowance: plan.cpuAllowance,
    cpuPriority: plan.cpuPriority,
    processLimit: plan.processLimit,
    memory: plan.memory,
    swap: plan.swap,
    disk: plan.disk,
    diskRead: plan.diskRead,
    diskWrite: plan.diskWrite,
    diskReadIops: plan.diskReadIops,
    diskWriteIops: plan.diskWriteIops,
    bandwidthIn: plan.bandwidthIn,
    bandwidthOut: plan.bandwidthOut,
    traffic: plan.traffic,
    trafficMode: plan.trafficMode,
    overLimitAction: plan.overLimitAction,
    throttleRate: plan.throttleRate,
    trafficResetPrice: plan.trafficResetPrice ? money(plan.trafficResetPrice) : null,
    portLimit: plan.portLimit,
    siteLimit: plan.siteLimit,
    snapshotLimit: plan.snapshotLimit,
    ipv6Count: plan.ipv6Count,
    storagePool: plan.storagePool,
    prices: planPrices(plan),
    stockLeft: plan.stock === null ? null : Math.max(0, plan.stock - activeInstances),
    regions: [...new Set(nodes.filter((n) => n.enabled).map((n) => n.region))],
    regionInfo: regionInfo(nodes, plan.product.nodeOptions, images),
  };
}

export function toAdminPlan(plan: Plan & { product: PlanProduct }, activeInstances: number): AdminPlanDTO {
  return {
    ...toPlan(plan, activeInstances),
    stock: plan.stock,
    enabled: plan.enabled,
    sortOrder: plan.sortOrder,
    activeInstances,
  };
}

/** 产品标签存为 JSON 数组 */
export function productTags(tags: Prisma.JsonValue | null): string[] {
  return Array.isArray(tags) ? tags.filter((x): x is string => typeof x === 'string') : [];
}

export function toProduct(product: Product & { nodes: Array<Pick<Node, 'region' | 'enabled' | 'country'>> }): ProductDTO {
  const regionCountry: Record<string, string> = {};
  for (const n of product.nodes) if (n.enabled && !(n.region in regionCountry)) regionCountry[n.region] = n.country;
  return {
    id: product.id,
    name: product.name,
    type: product.type,
    description: product.description,
    tags: productTags(product.tags),
    regions: Object.keys(regionCountry),
    regionCountry,
  };
}

export function toAdminProduct(
  product: Product & { nodes: Array<Pick<Node, 'id' | 'name' | 'region' | 'enabled' | 'country' | 'networkMode'>>; plans: Array<Pick<Plan, 'id'>> },
  stats: { activeInstances: number; listed: boolean },
): AdminProductDTO {
  return {
    ...toProduct(product),
    enabled: product.enabled,
    sortOrder: product.sortOrder,
    nodeIds: product.nodes.map((n) => n.id),
    nodeNames: product.nodes.map((n) => n.name),
    privileged: product.privileged,
    nesting: product.nesting,
    boot: bootOptions(product.boot),
    nodeOptions: Object.fromEntries(product.nodes.map((n) => [n.id, productNodeOption(product.nodeOptions, n.id)])),
    networkModes: [...new Set(product.nodes.map((n) => n.networkMode))],
    planCount: product.plans.length,
    ...stats,
  };
}

export function toImage(image: Image): ImageDTO {
  return {
    id: image.id,
    name: image.name,
    family: image.family,
    forContainer: image.forContainer,
    forVm: image.forVm,
    arch: image.arch === 'aarch64' ? 'aarch64' : 'x86_64',
  };
}

export function toAdminImage(image: Image): AdminImageDTO {
  return {
    ...toImage(image),
    alias: image.alias,
    server: image.server,
    protocol: image.protocol,
    cloudInit: image.cloudInit,
    enabled: image.enabled,
    sortOrder: image.sortOrder,
  };
}

export type InstanceWithRelations = Instance & {
  node: Node;
  plan: Pick<Plan, 'id' | 'name'> | null;
  image: Pick<Image, 'id' | 'name' | 'family'> | null;
  ipAddress: Pick<IpAddress, 'address'> | null;
  coupon: Pick<Coupon, 'code' | 'name' | 'type' | 'value' | 'maxDiscount'> | null;
  vpc: { id: number; name: string } | null;
  marketListings: Array<{ id: number; price: Prisma.Decimal }>;
  tasks: Task[];
  user?: Pick<User, 'id' | 'username' | 'email'>;
  _count: { portMappings: number; sites: number; snapshots: number; volumes: number };
};

export const instanceInclude = {
  node: true,
  plan: { select: { id: true, name: true } },
  image: { select: { id: true, name: true, family: true } },
  ipAddress: { select: { address: true } },
  coupon: { select: { code: true, name: true, type: true, value: true, maxDiscount: true } },
  vpc: { select: { id: true, name: true } },
  marketListings: { where: { status: 'ACTIVE' }, select: { id: true, price: true }, take: 1 },
  tasks: { where: { status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { id: 'desc' }, take: 1 },
  _count: { select: { portMappings: true, sites: true, snapshots: true, volumes: true } },
} satisfies Prisma.InstanceInclude;

export const adminInstanceInclude = {
  ...instanceInclude,
  user: { select: { id: true, username: true, email: true } },
} satisfies Prisma.InstanceInclude;

export function toInstance(inst: InstanceWithRelations): InstanceDTO {
  const nat = inst.type !== 'KVM_IPV4';
  // IPv6 Only 宿主机没有 IPv4 入口：不提供公网 IPv4 与端口映射，SSH 直接走 IPv6 的 22 端口
  const ipv6Only = nat && inst.node.networkMode === 'IPV6_ONLY';
  return {
    id: inst.id,
    name: inst.name,
    hostname: inst.hostname,
    type: inst.type,
    status: inst.status,
    suspendReason: inst.suspendReason,
    suspendNote: inst.suspendNote,
    region: inst.node.region,
    country: inst.node.country,
    plan: inst.plan,
    image: inst.image,
    cpu: inst.cpu,
    cpuAllowance: inst.cpuAllowance,
    cpuPriority: inst.cpuPriority,
    processLimit: inst.processLimit,
    memory: inst.memory,
    swap: inst.swap,
    swapEnabled: inst.swapEnabled,
    disk: inst.disk,
    diskRead: inst.diskRead,
    diskWrite: inst.diskWrite,
    diskReadIops: inst.diskReadIops,
    diskWriteIops: inst.diskWriteIops,
    bandwidthIn: inst.bandwidthIn,
    bandwidthOut: inst.bandwidthOut,
    traffic: inst.traffic,
    trafficMode: inst.trafficMode,
    overLimitAction: inst.overLimitAction,
    throttleRate: inst.throttleRate,
    trafficResetPrice: inst.trafficResetPrice ? money(inst.trafficResetPrice) : null,
    portLimit: inst.portLimit,
    siteLimit: inst.siteLimit,
    snapshotLimit: inst.snapshotLimit,
    publicIp: ipv6Only ? null : nat ? inst.node.publicIp : (inst.ipAddress?.address ?? null),
    hostAnnouncement: inst.node.announcement || null,
    privateIp: inst.privateIp,
    ipv6: parseIpv6List(inst.publicIpv6)[0] ?? inst.ipv6,
    ipv6List: inst.publicIpv6 ? parseIpv6List(inst.publicIpv6) : inst.ipv6 ? [inst.ipv6] : [],
    ipv6Prefixes: parseIpv6List(inst.ipv6Prefixes),
    ipv6Only,
    sshPort: nat && !ipv6Only ? inst.sshPort : 22,
    portRange: nat && !ipv6Only ? { start: inst.node.portRangeStart, end: inst.node.portRangeEnd } : null,
    trafficIn: Number(inst.trafficIn),
    trafficOut: Number(inst.trafficOut),
    trafficUsed: Number(trafficUsedBytes(inst)),
    trafficThrottled: inst.trafficThrottled,
    trafficPeriodStart: trafficCycleStart(inst.trafficResetAt, inst.createdAt).toISOString(),
    trafficResetAt: inst.trafficResetAt.toISOString(),
    billingCycle: inst.billingCycle,
    price: money(inst.price),
    renewPrice: money(renewalPrice(inst)),
    renewCoupon: inst.coupon ? { code: inst.coupon.code, name: inst.coupon.name } : null,
    vpc: inst.vpc && inst.vpcIp ? { id: inst.vpc.id, name: inst.vpc.name, ip: inst.vpcIp } : null,
    marketListing: inst.marketListings[0] ? { id: inst.marketListings[0].id, price: money(inst.marketListings[0].price) } : null,
    expiresAt: inst.expiresAt.toISOString(),
    autoRenew: inst.autoRenew,
    createdAt: inst.createdAt.toISOString(),
    activeTask: inst.tasks[0] ? toTask(inst.tasks[0]) : null,
    counts: {
      portMappings: inst._count.portMappings,
      sites: inst._count.sites,
      snapshots: inst._count.snapshots,
      volumes: inst._count.volumes,
    },
  };
}

export function toAdminInstance(inst: InstanceWithRelations & { user: Pick<User, 'id' | 'username' | 'email'> }): AdminInstanceDTO {
  return {
    ...toInstance(inst),
    node: { id: inst.node.id, name: inst.node.name },
    user: inst.user,
    remark: inst.remark,
    lastError: inst.lastError,
  };
}

export function toPortMapping(m: PortMapping): PortMappingDTO {
  return {
    id: m.id,
    protocol: m.protocol,
    publicPort: m.publicPort,
    privatePort: m.privatePort,
    description: m.description,
    system: m.system,
    createdAt: m.createdAt.toISOString(),
  };
}

export function toSite(s: SiteBinding): SiteBindingDTO {
  return {
    id: s.id,
    domain: s.domain,
    targetPort: s.targetPort,
    https: s.https,
    status: s.status,
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toSnapshot(s: Snapshot): SnapshotDTO {
  return { id: s.id, name: s.name, description: s.description, createdAt: s.createdAt.toISOString() };
}

/** 订单列表需要的关联：实例主机名与类型、套餐与产品名称 */
export const orderInclude = {
  instance: { select: { hostname: true, type: true } },
  plan: { select: { name: true, product: { select: { name: true } } } },
} satisfies Prisma.OrderInclude;

export function toOrder(
  o: Order & {
    user?: Pick<User, 'id' | 'username'>;
    instance?: Pick<Instance, 'hostname' | 'type'> | null;
    plan?: { name: string; product: { name: string } } | null;
  },
): OrderDTO {
  return {
    id: o.id,
    no: o.no,
    type: o.type,
    cycle: o.cycle,
    amount: money(o.amount),
    discount: money(o.discount),
    couponCode: o.couponCode,
    status: o.status,
    description: o.description,
    createdAt: o.createdAt.toISOString(),
    instanceId: o.instanceId,
    instance: o.instance ? { hostname: o.instance.hostname, type: o.instance.type } : null,
    plan: o.plan ? { name: o.plan.name, product: o.plan.product.name } : null,
    ...(o.user ? { user: { id: o.user.id, username: o.user.username } } : {}),
  };
}

export function toInvoice(
  i: Invoice & {
    instance?: Pick<Instance, 'hostname' | 'type'> | null;
    plan?: { name: string; product: { name: string } } | null;
  },
): InvoiceDTO {
  const payload = i.payload as { purchaseConfig?: InvoicePurchaseConfigDTO } | null;
  return {
    id: i.id,
    no: i.no,
    type: i.type,
    status: i.status,
    amount: money(i.amount),
    discount: money(i.discount),
    description: i.description,
    instanceId: i.instanceId,
    instance: i.instance ? { hostname: i.instance.hostname, type: i.instance.type } : null,
    plan: i.plan ? { name: i.plan.name, product: i.plan.product.name } : null,
    purchaseConfig: i.type === 'PURCHASE' ? payload?.purchaseConfig ?? null : null,
    expiresAt: iso(i.expiresAt),
    paidAt: iso(i.paidAt),
    createdAt: i.createdAt.toISOString(),
    updatedAt: i.updatedAt.toISOString(),
  };
}

/** 说明末尾的订单号 / 支付单号（各语言的写法），单独拆出来显示 */
const LOG_REF = /\s*[，,]\s*(?:订单|訂單|单号|單號|order|ref)\s+([0-9A-Za-z_-]{6,})$/i;

export function toBalanceLog(l: BalanceLog & { user?: Pick<User, 'id' | 'username'> }): BalanceLogDTO {
  const ref = l.description?.match(LOG_REF);
  return {
    id: l.id,
    type: l.type,
    amount: money(l.amount),
    balanceAfter: money(l.balanceAfter),
    description: ref ? l.description!.slice(0, ref.index) : l.description,
    ref: ref ? ref[1]! : null,
    createdAt: l.createdAt.toISOString(),
    ...(l.user ? { user: { id: l.user.id, username: l.user.username } } : {}),
  };
}

/** 余额明细：按拆出的订单号补上订单里的实例与套餐，旧记录的说明里没有主机名时也能看出是哪台实例 */
export async function toBalanceLogs(rows: Array<BalanceLog & { user?: Pick<User, 'id' | 'username'> }>): Promise<BalanceLogDTO[]> {
  const items = rows.map(toBalanceLog);
  const refs = [...new Set(items.map((l) => l.ref).filter((r): r is string => !!r))];
  if (!refs.length) return items;
  const [orders, payments] = await Promise.all([
    prisma.order.findMany({ where: { no: { in: refs } }, include: orderInclude }),
    prisma.payment.findMany({ where: { no: { in: refs } } }),
  ]);
  const byNo = new Map(orders.map((o) => [o.no, o]));
  const byPaymentNo = new Map(payments.map((p) => [p.no, p]));
  const names = await paymentNames();
  return items.map((l, i) => {
    // 说明可能来自人工输入，不能将另一用户的单号当成这条流水的关联。
    const candidateOrder = l.ref && ['PURCHASE', 'RENEW', 'REFUND'].includes(l.type) ? byNo.get(l.ref) : undefined;
    const candidatePayment = l.ref && l.type === 'RECHARGE' ? byPaymentNo.get(l.ref) : undefined;
    const o = candidateOrder?.userId === rows[i]!.userId ? candidateOrder : undefined;
    const payment = candidatePayment?.userId === rows[i]!.userId && candidatePayment?.status === 'PAID' ? candidatePayment : undefined;
    return {
      ...l,
      ...(o
        ? {
            order: {
              hostname: o.instance?.hostname ?? null,
              plan: o.plan ? `${o.plan.product.name} / ${o.plan.name}` : null,
              cycle: o.cycle,
              type: o.instance?.type ?? null,
              amount: money(o.amount),
              discount: money(o.discount),
              couponCode: o.couponCode,
            },
          }
        : {}),
      ...(payment
        ? {
            payment: {
              ...names(payment),
              amount: money(payment.amount),
              fee: money(payment.fee),
              payAmount: money(payment.payAmount),
              currency: payment.currency,
              status: payment.status,
            },
          }
        : {}),
    };
  });
}

export function toRedeemCode(c: RedeemCode & { usedBy: Pick<User, 'id' | 'username'> | null }): RedeemCodeDTO {
  return {
    id: c.id,
    code: c.code,
    amount: money(c.amount),
    maxUses: c.maxUses,
    usedCount: c.usedCount,
    usedBy: c.usedBy ? { id: c.usedBy.id, username: c.usedBy.username } : null,
    usedAt: iso(c.usedAt),
    expiresAt: iso(c.expiresAt),
    remark: c.remark,
    createdAt: c.createdAt.toISOString(),
  };
}

export function toAnnouncement(a: Announcement): AnnouncementDTO {
  return {
    id: a.id,
    title: a.title,
    content: a.content,
    pinned: a.pinned,
    published: a.published,
    level: a.level as AnnouncementDTO['level'],
    expiresAt: iso(a.expiresAt),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function toAdminUser(u: User & { _count: { instances: number } }, oauth: AdminUserDTO['oauth'] = []): AdminUserDTO {
  return {
    emailVerifiedAt: iso(u.emailVerifiedAt),
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    avatar: toAvatar(u),
    oauth,
    role: u.role,
    status: u.status,
    balance: money(u.balance),
    remark: u.remark,
    instanceCount: u._count.instances,
    lastLoginAt: iso(u.lastLoginAt),
    lastLoginIp: u.lastLoginIp,
    createdAt: u.createdAt.toISOString(),
    twoFactorEnabled: !!u.totpEnabledAt,
  };
}

export function toNode(n: Node, extra: { instanceCount: number; ipTotal: number; ipUsed: number; siteCount: number }): NodeDTO {
  return {
    id: n.id,
    name: n.name,
    region: n.region,
    country: n.country,
    description: n.description,
    networkMode: n.networkMode,
    address: endpointAddress(n.endpoint),
    endpoint: n.endpoint,
    serverFingerprint: n.serverFingerprint,
    project: n.project,
    storagePool: n.storagePool,
    profile: n.profile,
    publicIp: n.publicIp,
    publicIpv6: n.publicIpv6,
    natNetwork: n.natNetwork,
    natCidr: n.natCidr,
    natListenAddress: n.natListenAddress,
    natListenAddressV6: n.natListenAddressV6,
    ipv6Subnet: n.ipv6Subnet,
    ipv6Parent: n.ipv6Parent,
    ipv6PrefixLength: n.ipv6PrefixLength,
    portRangeStart: n.portRangeStart,
    portRangeEnd: n.portRangeEnd,
    publicNicMode: n.publicNicMode,
    publicNicParent: n.publicNicParent,
    dnsServers: n.dnsServers,
    apiPort: n.apiPort,
    storageDriver: n.storageDriver,
    storageSource: n.storageSource,
    storageSize: n.storageSize,
    natCidrInstall: n.natCidrInstall,
    installTokenExpires: iso(n.installTokenExpires),
    installedAt: iso(n.installedAt),
    incusVersion: n.incusVersion,
    arch: n.arch,
    caddyStatus: n.caddyStatus,
    caddyAdminPort: n.caddyAdminPort,
    caddyError: n.caddyError,
    caddyVersion: n.caddyVersion,
    trafficLimit: n.trafficLimit,
    trafficResetDay: n.trafficResetDay,
    trafficMode: n.trafficMode,
    maxInstances: n.maxInstances,
    pingEnabled: n.pingEnabled,
    installAgent: n.installAgent,
    installFirewall: n.installFirewall,
    enableFirewallRules: n.enableFirewallRules,
    announcement: n.announcement,
    egressEnabled: n.egressEnabled,
    requireRealName: n.requireRealName,
    imageIds: nodeImageIds(n.imageIds),
    enabled: n.enabled,
    status: n.status,
    lastCheckedAt: iso(n.lastCheckedAt),
    lastError: n.lastError,
    sortOrder: n.sortOrder,
    createdAt: n.createdAt.toISOString(),
    instanceCount: extra.instanceCount,
    ipStats: { total: extra.ipTotal, used: extra.ipUsed },
    siteCount: extra.siteCount,
  };
}

export function toProxySite(p: ProxySite & { node: Pick<Node, 'id' | 'name'> }): ProxySiteDTO {
  return {
    id: p.id,
    node: { id: p.node.id, name: p.node.name },
    domain: p.domain,
    upstream: p.upstream,
    https: p.https,
    remark: p.remark,
    status: p.status,
    lastError: p.lastError,
    createdAt: p.createdAt.toISOString(),
  };
}

export function toPayment(p: Payment & { user?: Pick<User, 'id' | 'username'> }, names: { methodName: string; channelName: string | null }): PaymentDTO {
  return {
    id: p.id,
    no: p.no,
    gateway: p.gateway as PaymentDTO['gateway'],
    channel: p.channel,
    ...names,
    amount: money(p.amount),
    fee: money(p.fee),
    payAmount: money(p.payAmount),
    currency: p.currency,
    status: p.status,
    paidAt: iso(p.paidAt),
    createdAt: p.createdAt.toISOString(),
    ...(p.user ? { user: { id: p.user.id, username: p.user.username } } : {}),
  };
}

export function toIpAddress(ip: IpAddress & { instance: Pick<Instance, 'id' | 'name' | 'hostname'> | null }): IpAddressDTO {
  return {
    id: ip.id,
    nodeId: ip.nodeId,
    address: ip.address,
    prefix: ip.prefix,
    gateway: ip.gateway,
    disabled: ip.disabled,
    remark: ip.remark,
    instance: ip.instance ? { id: ip.instance.id, name: ip.instance.name, hostname: ip.instance.hostname } : null,
    createdAt: ip.createdAt.toISOString(),
  };
}

export function toActivity(a: {
  id: number;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: Date;
  user: Pick<User, 'id' | 'username'> | null;
}): ActivityLogDTO {
  return {
    id: a.id,
    action: a.action,
    detail: a.detail,
    ip: a.ip,
    createdAt: a.createdAt.toISOString(),
    user: a.user ? { id: a.user.id, username: a.user.username } : null,
  };
}

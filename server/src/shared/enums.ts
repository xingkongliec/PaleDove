// 与 Prisma schema 中的枚举保持一致（前端不能直接引用 Prisma 生成代码）

export const ROLES = ['USER', 'ADMIN'] as const;
export type Role = (typeof ROLES)[number];

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const INSTANCE_TYPES = ['LXC_NAT', 'KVM_NAT', 'KVM_IPV4'] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];

export const INSTANCE_STATUSES = [
  'CREATING',
  'RUNNING',
  'STOPPED',
  'REINSTALLING',
  'MIGRATING',
  'SUSPENDED',
  'ERROR',
  'DELETING',
  'DELETED',
] as const;
export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];

export const SUSPEND_REASONS = ['EXPIRED', 'TRAFFIC', 'ADMIN'] as const;
export type SuspendReason = (typeof SUSPEND_REASONS)[number];

export const TRAFFIC_MODES = ['OUT', 'IN', 'BOTH', 'MAX'] as const;
export type TrafficMode = (typeof TRAFFIC_MODES)[number];

export const OVER_LIMIT_ACTIONS = ['STOP', 'THROTTLE'] as const;
export type OverLimitAction = (typeof OVER_LIMIT_ACTIONS)[number];

/** 实例转移方式：原样交接 / 全新安装后交接 */
export const TRANSFER_MODES = ['KEEP', 'REINSTALL'] as const;
export type TransferMode = (typeof TRANSFER_MODES)[number];
/** 转移手续费：不收取 / 固定金额 / 按实例续费价格的百分比 */
export const TRANSFER_FEE_MODES = ['NONE', 'FIXED', 'PERCENT'] as const;
export type TransferFeeMode = (typeof TRANSFER_FEE_MODES)[number];
/** 推广佣金明细类型 */
/** 管理员删除实例时的退款方式：按剩余价值 / 退全款 / 不退款 */
export const DELETE_REFUND_MODES = ['REMAINING', 'FULL', 'NONE'] as const;
export type DeleteRefundMode = (typeof DELETE_REFUND_MODES)[number];

export const AFF_LOG_TYPES = ['EARN', 'REVOKE', 'WITHDRAW'] as const;
export type AffLogType = (typeof AFF_LOG_TYPES)[number];
export const AFF_LOG_STATUSES = ['PENDING', 'SETTLED', 'CANCELED'] as const;
export type AffLogStatus = (typeof AFF_LOG_STATUSES)[number];

export const BILLING_CYCLES = ['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const PORT_PROTOCOLS = ['TCP', 'UDP', 'TCP_UDP'] as const;
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];
/** 端口映射占用的配额：TCP+UDP 同时映射两种协议，占 2 个，单一协议占 1 个 */
export const portQuotaCost = (protocol: PortProtocol): number => (protocol === 'TCP_UDP' ? 2 : 1);
/** 已用端口配额：系统映射（SSH）不计入 */
export const portQuotaUsed = (mappings: Array<{ protocol: PortProtocol; system: boolean }>): number =>
  mappings.reduce((n, m) => n + (m.system ? 0 : portQuotaCost(m.protocol)), 0);

export const SITE_STATUSES = ['PENDING', 'ACTIVE', 'ERROR'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

export const TASK_TYPES = [
  'CREATE',
  'START',
  'STOP',
  'RESTART',
  'FORCE_STOP',
  'REINSTALL',
  'RESET_PASSWORD',
  'SNAPSHOT_CREATE',
  'SNAPSHOT_RESTORE',
  'SNAPSHOT_DELETE',
  'SUSPEND',
  'UNSUSPEND',
  'APPLY_LIMITS',
  'DELETE',
  'MIGRATE',
  'SYNC_BASELINE',
  'REPAIR_NETWORK',
  'RENAME',
  'SWITCH_NODE',
] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_STATUSES = ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ORDER_TYPES = ['NEW', 'RENEW'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ['PAID', 'REFUNDED'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const INVOICE_STATUSES = ['PENDING', 'PROCESSING', 'PAID', 'CANCELED', 'EXPIRED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const INVOICE_TYPES = ['PURCHASE', 'RENEW', 'TRAFFIC_RESET'] as const;
export type InvoiceType = (typeof INVOICE_TYPES)[number];

export const BALANCE_LOG_TYPES = ['RECHARGE', 'REDEEM', 'PURCHASE', 'RENEW', 'REFUND', 'ADJUST', 'AFF', 'TRANSFER', 'TRAFFIC', 'MARKET', 'SWITCH'] as const;

/** 交易市场挂牌状态：挂牌中 / 已成交 / 卖家撤销 / 被下架 */
export const MARKET_LISTING_STATUSES = ['ACTIVE', 'SOLD', 'CANCELED', 'REMOVED'] as const;
export type MarketListingStatus = (typeof MARKET_LISTING_STATUSES)[number];

/** 交易市场列表排序 */
export const MARKET_SORTS = ['NEWEST', 'PRICE_ASC', 'PRICE_DESC', 'EXPIRES_DESC'] as const;
export type MarketSort = (typeof MARKET_SORTS)[number];
export type BalanceLogType = (typeof BALANCE_LOG_TYPES)[number];

export const NODE_STATUSES = ['PENDING', 'ONLINE', 'OFFLINE', 'UNKNOWN'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * 宿主机网络模式：
 *  - NAT：IPv4 NAT（端口映射）
 *  - NAT_IPV6：IPv4 NAT + 每个实例一个公网 IPv6
 *  - IPV6_ONLY：实例只有公网 IPv6，不提供 IPv4 端口映射
 *  - IPV4：每个实例一个独立公网 IPv4（地址池）
 *  - IPV4_IPV6：独立公网 IPv4 + 公网 IPv6
 * NAT 类套餐只分配到前三种宿主机，独立 IPv4 套餐只分配到后两种。
 */
export const NETWORK_MODES = ['NAT', 'NAT_IPV6', 'IPV6_ONLY', 'IPV4', 'IPV4_IPV6'] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

/** 该网络模式下实例是否分配公网 IPv6 */
export const hasIpv6Mode = (mode: NetworkMode) => mode === 'NAT_IPV6' || mode === 'IPV6_ONLY' || mode === 'IPV4_IPV6';

/** 该网络模式下实例是否使用独立公网 IPv4（否则为 NAT） */
export const isPublicIpv4Mode = (mode: NetworkMode) => mode === 'IPV4' || mode === 'IPV4_IPV6';

/** 存储池用途：实例系统盘（可作为默认存储池）或实例存储盘（数据盘） */
export const POOL_USAGES = ['root', 'data'] as const;
export type PoolUsage = (typeof POOL_USAGES)[number];

export const PUBLIC_NIC_MODES = ['ROUTED', 'BRIDGED'] as const;
export type PublicNicMode = (typeof PUBLIC_NIC_MODES)[number];

export const CADDY_STATUSES = ['NONE', 'PENDING', 'READY', 'ERROR'] as const;
export type CaddyStatus = (typeof CADDY_STATUSES)[number];

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_GATEWAYS = ['stripe', 'heleket', 'epay'] as const;
export type PaymentGateway = (typeof PAYMENT_GATEWAYS)[number];

export const VERIFICATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const STORAGE_DRIVERS = ['zfs', 'btrfs', 'lvm', 'dir'] as const;
export type StorageDriver = (typeof STORAGE_DRIVERS)[number];

/** 每个计费周期对应的月数 */
export const CYCLE_MONTHS: Record<BillingCycle, number> = {
  MONTHLY: 1,
  QUARTERLY: 3,
  SEMIANNUAL: 6,
  ANNUAL: 12,
};

/** 套餐价格字段与计费周期的对应关系 */
export const CYCLE_PRICE_FIELD = {
  MONTHLY: 'priceMonthly',
  QUARTERLY: 'priceQuarterly',
  SEMIANNUAL: 'priceSemiannual',
  ANNUAL: 'priceAnnual',
} as const satisfies Record<BillingCycle, string>;

export function isNatType(type: InstanceType): boolean {
  return type === 'LXC_NAT' || type === 'KVM_NAT';
}

export function isVmType(type: InstanceType): boolean {
  return type === 'KVM_NAT' || type === 'KVM_IPV4';
}

/** 镜像架构：x86_64（amd64）与 aarch64（arm64） */
export const IMAGE_ARCHES = ['x86_64', 'aarch64'] as const;
export type ImageArch = (typeof IMAGE_ARCHES)[number];

/** 优惠码类型：按百分比减免 / 减免固定金额 */
export const COUPON_TYPES = ['PERCENT', 'AMOUNT'] as const;
export type CouponType = (typeof COUPON_TYPES)[number];

/** 优惠码适用的订单：新购 / 续费 / 都可以 */
export const COUPON_SCOPES = ['NEW', 'RENEW', 'ALL'] as const;
export type CouponScope = (typeof COUPON_SCOPES)[number];

/** 优惠码使用模式：只抵扣这一笔订单 / 新购时锁定优惠价，之后续费都按优惠价 */
export const COUPON_MODES = ['ONCE', 'RECURRING'] as const;
export type CouponMode = (typeof COUPON_MODES)[number];

/** 操作日志模块：取操作名的前缀（如 instance.renew → instance） */
export const LOG_MODULES = ['auth', 'account', 'instance', 'billing', 'realname', 'ticket', 'admin', 'agent'] as const;
export type LogModule = (typeof LOG_MODULES)[number];

/** 智能分流出口类型 */
export const EGRESS_TYPES = ['WIREGUARD', 'SOCKS5', 'HTTP'] as const;
export type EgressType = (typeof EGRESS_TYPES)[number];

import type {
  BalanceLogType,
  BillingCycle,
  CaddyStatus,
  InstanceStatus,
  MarketListingStatus,
  InstanceType,
  NodeStatus,
  OverLimitAction,
  PaymentStatus,
  PortProtocol,
  SiteStatus,
  SuspendReason,
  TaskStatus,
  TaskType,
  TrafficMode,
  VerificationStatus,
} from './enums';

// ───────── 语言 ─────────

export const LOCALES = ['zh-CN', 'zh-TW', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-CN';

export const LOCALE_NAMES: Record<Locale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
};

/** 将任意语言标识（Accept-Language、navigator.language 等）归一化为受支持的语言 */
export function normalizeLocale(input?: string | null): Locale | null {
  if (!input) return null;
  for (const part of input.split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase();
    if (!tag) continue;
    if (tag === 'zh-tw' || tag === 'zh-hk' || tag === 'zh-mo' || tag.startsWith('zh-hant')) return 'zh-TW';
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('en')) return 'en';
  }
  return null;
}

// ───────── 枚举标签 ─────────

export interface EnumLabels {
  instanceType: Record<InstanceType, string>;
  instanceTypeDesc: Record<InstanceType, string>;
  instanceStatus: Record<InstanceStatus, string>;
  suspendReason: Record<SuspendReason, string>;
  billingCycle: Record<BillingCycle, string>;
  trafficMode: Record<TrafficMode, string>;
  overLimitAction: Record<OverLimitAction, string>;
  portProtocol: Record<PortProtocol, string>;
  taskType: Record<TaskType, string>;
  taskStatus: Record<TaskStatus, string>;
  balanceLogType: Record<BalanceLogType, string>;
  marketStatus: Record<MarketListingStatus, string>;
  paymentStatus: Record<PaymentStatus, string>;
  nodeStatus: Record<NodeStatus, string>;
  siteStatus: Record<SiteStatus, string>;
  caddyStatus: Record<CaddyStatus, string>;
  verificationStatus: Record<VerificationStatus, string>;
}

const portProtocol: Record<PortProtocol, string> = { TCP: 'TCP', UDP: 'UDP', TCP_UDP: 'TCP + UDP' };

const zhCN: EnumLabels = {
  instanceType: { LXC_NAT: 'LXC NAT', KVM_NAT: 'KVM NAT', KVM_IPV4: 'KVM 独立 IPv4' },
  instanceTypeDesc: {
    LXC_NAT: '轻量容器，共享公网 IP，通过端口映射访问，性价比最高',
    KVM_NAT: '完整虚拟化，独立内核，共享公网 IP，通过端口映射访问',
    KVM_IPV4: '完整虚拟化，独享一个公网 IPv4，全部端口可用',
  },
  instanceStatus: {
    CREATING: '创建中',
    RUNNING: '运行中',
    STOPPED: '已关机',
    REINSTALLING: '重装中',
    MIGRATING: '迁移中',
    SUSPENDED: '已封禁',
    ERROR: '异常',
    DELETING: '删除中',
    DELETED: '已删除',
  },
  suspendReason: { EXPIRED: '已到期', TRAFFIC: '流量超额', ADMIN: '管理员封禁' },
  billingCycle: { MONTHLY: '月付', QUARTERLY: '季付', SEMIANNUAL: '半年付', ANNUAL: '年付' },
  marketStatus: { ACTIVE: '出售中', SOLD: '已成交', CANCELED: '已撤销', REMOVED: '已下架' },
  trafficMode: { OUT: '单向（出站）', IN: '单向（入站）', BOTH: '双向合计', MAX: '双向取大' },
  overLimitAction: { STOP: '停机', THROTTLE: '限速' },
  portProtocol,
  taskType: {
    CREATE: '创建实例',
    START: '开机',
    STOP: '关机',
    RESTART: '重启',
    FORCE_STOP: '强制关机',
    REINSTALL: '重装系统',
    RESET_PASSWORD: '重置密码',
    SNAPSHOT_CREATE: '创建快照',
    SNAPSHOT_RESTORE: '恢复快照',
    SNAPSHOT_DELETE: '删除快照',
    SUSPEND: '暂停',
    UNSUSPEND: '解除暂停',
    APPLY_LIMITS: '应用配置',
    DELETE: '删除实例',
    MIGRATE: '迁移宿主机',
    SYNC_BASELINE: '基线同步',
    REPAIR_NETWORK: '网络修复',
    RENAME: '重命名',
    SWITCH_NODE: '切换机房',
  },
  taskStatus: { QUEUED: '排队中', RUNNING: '执行中', SUCCESS: '成功', FAILED: '失败' },
  balanceLogType: { RECHARGE: '充值', REDEEM: '兑换码', PURCHASE: '购买', RENEW: '续费', REFUND: '退款', ADJUST: '管理员调整', AFF: '推广佣金', TRANSFER: '转移手续费', TRAFFIC: '重置流量', MARKET: '交易市场', SWITCH: '切换机房' },
  paymentStatus: { PENDING: '待支付', PAID: '已支付', EXPIRED: '已过期', FAILED: '失败' },
  nodeStatus: { PENDING: '待安装', ONLINE: '在线', OFFLINE: '离线', UNKNOWN: '未检测' },
  siteStatus: { PENDING: '等待生效', ACTIVE: '已生效', ERROR: '异常' },
  caddyStatus: { NONE: '未安装', PENDING: '等待安装', READY: '已就绪', ERROR: '异常' },
  verificationStatus: { PENDING: '认证中', APPROVED: '已通过', REJECTED: '未通过' },
};

const zhTW: EnumLabels = {
  instanceType: { LXC_NAT: 'LXC NAT', KVM_NAT: 'KVM NAT', KVM_IPV4: 'KVM 獨立 IPv4' },
  instanceTypeDesc: {
    LXC_NAT: '輕量容器，共用公網 IP，透過連接埠轉發存取，性價比最高',
    KVM_NAT: '完整虛擬化，獨立核心，共用公網 IP，透過連接埠轉發存取',
    KVM_IPV4: '完整虛擬化，獨享一個公網 IPv4，所有連接埠皆可使用',
  },
  instanceStatus: {
    CREATING: '建立中',
    RUNNING: '執行中',
    STOPPED: '已關機',
    REINSTALLING: '重灌中',
    MIGRATING: '遷移中',
    SUSPENDED: '已封禁',
    ERROR: '異常',
    DELETING: '刪除中',
    DELETED: '已刪除',
  },
  suspendReason: { EXPIRED: '已到期', TRAFFIC: '流量超額', ADMIN: '管理員封禁' },
  billingCycle: { MONTHLY: '月付', QUARTERLY: '季付', SEMIANNUAL: '半年付', ANNUAL: '年付' },
  marketStatus: { ACTIVE: '出售中', SOLD: '已成交', CANCELED: '已撤銷', REMOVED: '已下架' },
  trafficMode: { OUT: '單向（出站）', IN: '單向（入站）', BOTH: '雙向合計', MAX: '雙向取大' },
  overLimitAction: { STOP: '停機', THROTTLE: '限速' },
  portProtocol,
  taskType: {
    CREATE: '建立執行個體',
    START: '開機',
    STOP: '關機',
    RESTART: '重新啟動',
    FORCE_STOP: '強制關機',
    REINSTALL: '重灌系統',
    RESET_PASSWORD: '重設密碼',
    SNAPSHOT_CREATE: '建立快照',
    SNAPSHOT_RESTORE: '還原快照',
    SNAPSHOT_DELETE: '刪除快照',
    SUSPEND: '暫停',
    UNSUSPEND: '解除暫停',
    APPLY_LIMITS: '套用設定',
    DELETE: '刪除執行個體',
    MIGRATE: '遷移主機',
    SYNC_BASELINE: '基線同步',
    REPAIR_NETWORK: '網路修復',
    RENAME: '重新命名',
    SWITCH_NODE: '切換機房',
  },
  taskStatus: { QUEUED: '排隊中', RUNNING: '執行中', SUCCESS: '成功', FAILED: '失敗' },
  balanceLogType: { RECHARGE: '儲值', REDEEM: '兌換碼', PURCHASE: '購買', RENEW: '續費', REFUND: '退款', ADJUST: '管理員調整', AFF: '推廣佣金', TRANSFER: '轉移手續費', TRAFFIC: '重置流量', MARKET: '交易市場', SWITCH: '切換機房' },
  paymentStatus: { PENDING: '待付款', PAID: '已付款', EXPIRED: '已過期', FAILED: '失敗' },
  nodeStatus: { PENDING: '待安裝', ONLINE: '線上', OFFLINE: '離線', UNKNOWN: '未偵測' },
  siteStatus: { PENDING: '等待生效', ACTIVE: '已生效', ERROR: '異常' },
  caddyStatus: { NONE: '未安裝', PENDING: '等待安裝', READY: '已就緒', ERROR: '異常' },
  verificationStatus: { PENDING: '認證中', APPROVED: '已通過', REJECTED: '未通過' },
};

const en: EnumLabels = {
  instanceType: { LXC_NAT: 'LXC NAT', KVM_NAT: 'KVM NAT', KVM_IPV4: 'KVM Dedicated IPv4' },
  instanceTypeDesc: {
    LXC_NAT: 'Lightweight container on a shared public IP, reachable through port forwarding. Best value.',
    KVM_NAT: 'Full virtualization with its own kernel on a shared public IP, reachable through port forwarding.',
    KVM_IPV4: 'Full virtualization with a dedicated public IPv4 address. All ports available.',
  },
  instanceStatus: {
    CREATING: 'Creating',
    RUNNING: 'Running',
    STOPPED: 'Stopped',
    REINSTALLING: 'Reinstalling',
    MIGRATING: 'Migrating',
    SUSPENDED: 'Suspended',
    ERROR: 'Error',
    DELETING: 'Deleting',
    DELETED: 'Deleted',
  },
  suspendReason: { EXPIRED: 'Expired', TRAFFIC: 'Traffic exceeded', ADMIN: 'Suspended by admin' },
  billingCycle: { MONTHLY: 'Monthly', QUARTERLY: 'Quarterly', SEMIANNUAL: 'Semi-annually', ANNUAL: 'Annually' },
  marketStatus: { ACTIVE: 'On sale', SOLD: 'Sold', CANCELED: 'Canceled', REMOVED: 'Taken down' },
  trafficMode: { OUT: 'Outbound only', IN: 'Inbound only', BOTH: 'In + out', MAX: 'Max of in/out' },
  overLimitAction: { STOP: 'Shut down', THROTTLE: 'Throttle' },
  portProtocol,
  taskType: {
    CREATE: 'Create instance',
    START: 'Start',
    STOP: 'Shut down',
    RESTART: 'Restart',
    FORCE_STOP: 'Force stop',
    REINSTALL: 'Reinstall OS',
    RESET_PASSWORD: 'Reset password',
    SNAPSHOT_CREATE: 'Create snapshot',
    SNAPSHOT_RESTORE: 'Restore snapshot',
    SNAPSHOT_DELETE: 'Delete snapshot',
    SUSPEND: 'Suspend',
    UNSUSPEND: 'Unsuspend',
    APPLY_LIMITS: 'Apply limits',
    DELETE: 'Delete instance',
    MIGRATE: 'Migrate host',
    SYNC_BASELINE: 'Baseline sync',
    REPAIR_NETWORK: 'Network repair',
    RENAME: 'Rename',
    SWITCH_NODE: 'Switch data center',
  },
  taskStatus: { QUEUED: 'Queued', RUNNING: 'Running', SUCCESS: 'Succeeded', FAILED: 'Failed' },
  balanceLogType: { RECHARGE: 'Top-up', REDEEM: 'Redeem code', PURCHASE: 'Purchase', RENEW: 'Renewal', REFUND: 'Refund', ADJUST: 'Admin adjustment', AFF: 'Referral commission', TRANSFER: 'Transfer fee', TRAFFIC: 'Traffic reset', MARKET: 'Marketplace', SWITCH: 'Data center switch' },
  paymentStatus: { PENDING: 'Pending', PAID: 'Paid', EXPIRED: 'Expired', FAILED: 'Failed' },
  nodeStatus: { PENDING: 'Awaiting install', ONLINE: 'Online', OFFLINE: 'Offline', UNKNOWN: 'Not checked' },
  siteStatus: { PENDING: 'Pending', ACTIVE: 'Active', ERROR: 'Error' },
  caddyStatus: { NONE: 'Not installed', PENDING: 'Awaiting install', READY: 'Ready', ERROR: 'Error' },
  verificationStatus: { PENDING: 'In progress', APPROVED: 'Verified', REJECTED: 'Not passed' },
};

export const ENUM_LABELS: Record<Locale, EnumLabels> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en };

export function enumLabels(locale: Locale): EnumLabels {
  return ENUM_LABELS[locale] ?? zhCN;
}

import type { AvatarDTO } from './avatar';
import type {
  AffLogType,
  BalanceLogType,
  BillingCycle,
  CaddyStatus,
  CouponMode,
  CouponScope,
  CouponType,
  DeleteRefundMode,
  ImageArch,
  InvoiceStatus,
  InvoiceType,
  InstanceStatus,
  InstanceType,
  NodeStatus,
  OrderStatus,
  OrderType,
  OverLimitAction,
  PaymentGateway,
  PaymentStatus,
  PortProtocol,
  NetworkMode,
  PoolUsage,
  PublicNicMode,
  Role,
  SiteStatus,
  SuspendReason,
  TaskStatus,
  TaskType,
  ThemePreference,
  TrafficMode,
  TransferMode,
  TransferFeeMode,
  UserStatus,
  VerificationStatus,
} from './enums';
import type { Locale } from './labels';
import type { MarketPingSummaryDTO } from './ping';
import type { PublicMaintenance } from './maintenance';

/** 金额统一以字符串传输，避免浮点误差，例如 "12.50" */
export type Money = string;
/** ISO 8601 时间字符串 */
export type DateString = string;

/** 切换机房前，由宿主机 Agent 即时检测实例对外的 IPv4。 */
export interface InstanceIpv4CheckDTO {
  status: 'pending' | 'ok' | 'blocked' | 'unknown';
  method: 'icmp' | null;
  reason: 'agentOffline' | 'agentUpgrade' | 'noIpv4' | 'timeout' | 'error' | 'notRunning' | null;
  ipv4: string | null;
  reachable: number;
  total: number;
  requestedAt: DateString;
  checkedAt: DateString | null;
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ───────── 认证 / 公共 ─────────

export interface MeDTO {
  id: number;
  email: string;
  username: string;
  /** 昵称 */
  name: string | null;
  /** 头像风格与种子 */
  avatar: AvatarDTO;
  role: Role;
  balance: Money;
  createdAt: DateString;
  locale: Locale | null;
  /** 国家或地区（ISO 3166-1 alpha-2） */
  country: string | null;
  theme: ThemePreference | null;
  totpEnabled: boolean;
  /** 第三方登录注册的账号没有本地密码，设置密码时不需要原密码 */
  hasPassword: boolean;
  announceEmail: boolean;
  balanceAlert: boolean;
  alertEmail: boolean;
  /** 管理员“以用户身份登录”时存在 */
  impersonatedBy?: { id: number; username: string } | null;
}

export interface PublicConfigDTO {
  siteName: string;
  icon: string | null;
  /** 头像 API 地址（DiceBear），为空时只显示首字母 */
  avatarApiBase: string;
  /** 切换机房：免费次数用完后额外切换的费用，0 表示不允许 */
  nodeSwitchFee: number;
  allowRegister: boolean;
  requireEmailVerification: boolean;
  allowTickets: boolean;
  signupBonus: number;
  /** 注册邮箱后缀规则：模式（不限制 / 白名单 / 黑名单）与后缀列表 */
  emailDomainMode: import('./access').EmailDomainMode;
  emailDomains: string[];
  mailEnabled: boolean;
  currency: string;
  footer: string;
  /** 已启用的第三方登录方式 */
  oauth: OAuthProviderPublicDTO[];
  maintenance: PublicMaintenance | null;
  legalRequireAgree: boolean;
  /** 推广返利已开启：用户侧边栏显示「邀请推广」 */
  affEnabled: boolean;
  /** 首购与续费的佣金比例（%），首页展示用 */
  affRateNew: number;
  affRateRenew: number;
  /** 交易市场已开启：首页与控制台显示「交易市场」 */
  marketEnabled: boolean;
  /** 成交手续费比例（%）与挂牌时实例至少要剩余的天数，出售时预估到账金额用 */
  marketFeeRate: number;
  marketMinDays: number;
}

/** 管理后台的系统设置：可修改的设置项 + 只读的环境变量配置 */
export interface AdminSettingsDTO extends SiteSettings {
  icon: string | null;
  iconSource: string;
  mailEnabled: boolean;
  /** 环境变量 PANEL_URL（面板对外访问地址），未设置时为空字符串 */
  panelUrl: string;
}

export interface SiteSettings {
  siteName: string;
  allowRegister: boolean;
  requireEmailVerification: boolean;
  allowTickets: boolean;
  signupBonus: number;
  /** 注册邮箱后缀规则：OFF 不限制；ALLOW 只允许列表中的后缀；DENY 禁止列表中的后缀（都匹配子域名） */
  emailDomainMode: import('./access').EmailDomainMode;
  /** 后缀列表，如 qq.com、gmail.com、edu.cn */
  emailDomains: string[];
  currency: string;
  footer: string;
  /** 绑定网站时检查域名 A 记录是否解析到节点 IP */
  requireDnsCheck: boolean;
  /** Caddy 申请证书使用的邮箱 */
  acmeEmail: string;
  /** 到期后暂停多少天删除 */
  graceDays: number;
  /** 到期前多少小时尝试自动续费 */
  autoRenewHours: number;
  /** 用户可执行的最小重装间隔（分钟），0 不限 */
  reinstallCooldownMinutes: number;
  /** 每个用户最多可创建的 VPC 数量，0 表示不开放 */
  vpcLimit: number;
  /** 推广返利：开启后用户可以生成推广链接，被邀请用户首购、续费按比例返佣 */
  affEnabled: boolean;
  /** 首购（新购）与续费的佣金比例（%） */
  affRateNew: number;
  affRateRenew: number;
  /** 佣金冻结期（天）：付款后多少天佣金才生效（可转入余额），期间退款则作废；0 表示立即生效 */
  affFreezeDays: number;
  /** 佣金满多少才能转入余额 */
  affMinWithdraw: number;
  /** 交易市场：开启后用户可以挂牌出售实例，也可以购买别人挂牌的实例 */
  marketEnabled: boolean;
  /** 成交时平台向卖家收取的手续费比例（%），从卖家所得中扣除 */
  marketFeeRate: number;
  /** 实例挂牌时至少还要有多少天才到期 */
  marketMinDays: number;
  /** 用户转移实例时收取的手续费（管理员操作不收取） */
  transferFeeMode: TransferFeeMode;
  /** 固定金额，或续费价格的百分比 */
  transferFeeValue: number;
  /** 头像 API 地址（DiceBear 兼容），为空时只显示首字母 */
  avatarApiBase: string;
  /** 切换机房：每台实例 30 天免费一次；免费次数用完后额外切换的费用，0 表示不允许额外切换 */
  nodeSwitchFee: number;
}

export type LegalKind = 'terms' | 'privacy';
export interface DocumentCategoryDTO { id: string; name: string; order: number }
export interface DocumentDTO {
  id: string;
  title: string;
  slug: string;
  content: string;
  categoryId: string;
  order: number;
  published: boolean;
  pinned: boolean;
  kind: LegalKind | null;
  updatedAt: string | null;
}
export type DocumentSummaryDTO = Omit<DocumentDTO, 'content'>;
export type DocumentMetadata = Pick<DocumentDTO, 'title' | 'categoryId' | 'order' | 'pinned'>;
export interface AdminDocumentsDTO {
  documents: DocumentDTO[];
  categories: DocumentCategoryDTO[];
  requireAgree: boolean;
  defaults: Record<LegalKind, string>;
}
export interface PublicDocumentsDTO {
  documents: DocumentSummaryDTO[];
  categories: DocumentCategoryDTO[];
}
export interface LegalDocDTO { content: string; updatedAt: string | null; custom: boolean }
export interface PublicLegalDTO extends LegalDocDTO { kind: LegalKind; title: string }
export interface LegalSettingsDTO {
  terms: LegalDocDTO;
  privacy: LegalDocDTO;
  requireAgree: boolean;
  defaults: Record<LegalKind, string>;
  changed?: LegalKind[];
}

export interface MailSettingsDTO {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  fromName: string;
  fromEmail: string;
  hasPassword: boolean;
}

export interface RegisterResultDTO {
  user?: MeDTO;
  needVerify: boolean;
  mailSent?: boolean;
}

export interface TicketDTO {
  id: number;
  number: number;
  subject: string;
  category: import('./tickets').TicketCategory;
  priority: import('./tickets').TicketPriority;
  status: import('./tickets').TicketStatus;
  resourceRef: number | null;
  resourceName: string | null;
  lastReplyAt: DateString;
  closedAt: DateString | null;
  createdAt: DateString;
  updatedAt: DateString;
  user: { id: number; username: string; name: string | null; email?: string; avatar: AvatarDTO };
  lastReply: { content: string; isAdmin: boolean } | null;
  counts: { messages: number; attachments: number };
}

export interface TicketAttachmentDTO {
  id: number;
  fileName: string;
  mimeType: string;
  size: number;
  createdAt: DateString;
}

export interface TicketDetailDTO extends TicketDTO {
  messages: { id: number; content: string; createdAt: DateString; isAdmin: boolean; author: { id: number | null; username: string; role: Role; avatar: AvatarDTO | null }; attachments: TicketAttachmentDTO[] }[];
}

// ───────── 套餐 / 镜像 ─────────

export interface PlanDTO {
  id: number;
  /** 所属产品，套餐跟随产品绑定的宿主机 */
  productId: number;
  name: string;
  description: string | null;
  type: InstanceType;
  cpu: number;
  /** CPU 时间配额（分配核数的百分比），null 表示不限 */
  cpuAllowance: number | null;
  /** CPU 优先级 0~10，null 为默认 */
  cpuPriority: number | null;
  /** 最大进程数（仅容器），null 表示不限 */
  processLimit: number | null;
  memory: number;
  /** SWAP 大小 MiB（仅容器，0 为不提供；实例默认关闭，用户可自行启用） */
  swap: number;
  disk: number;
  /** 磁盘读写速率 MB/s 与 IOPS，0 表示不限 */
  diskRead: number;
  diskWrite: number;
  diskReadIops: number;
  diskWriteIops: number;
  bandwidthIn: number;
  bandwidthOut: number;
  traffic: number;
  trafficMode: TrafficMode;
  overLimitAction: OverLimitAction;
  throttleRate: number;
  /** 自助重置流量的价格（每次），null 表示不开放 */
  trafficResetPrice: Money | null;
  portLimit: number;
  siteLimit: number;
  snapshotLimit: number;
  storagePool: string | null;
  /** 分配的公网 IPv6 数量，0 表示不分配 */
  ipv6Count: number;
  prices: Partial<Record<BillingCycle, Money>>;
  /** 剩余库存，null 表示不限 */
  stockLeft: number | null;
  regions: string[];
  /** 每个地区的可用镜像（null 表示面板全部镜像）与是否需要实名认证（该地区所有宿主机都要求实名时为 true） */
  regionInfo: Record<string, PlanRegionInfo>;
}

export interface PlanRegionInfo {
  imageIds: number[] | null;
  realName: boolean;
  /** 该地区宿主机中最低的流量倍率（实例流量 = 套餐流量 × 所在宿主机的倍率） */
  trafficMultiplier: number;
}

export interface AdminPlanDTO extends PlanDTO {
  stock: number | null;
  enabled: boolean;
  sortOrder: number;
  activeInstances: number;
}

/** 产品：套餐的上级分类，绑定可售宿主机 */
export interface ProductDTO {
  id: number;
  name: string;
  /** 实例类型：产品下的所有套餐都使用此类型 */
  type: InstanceType;
  description: string | null;
  tags: string[];
  /** 已启用宿主机所在地区 */
  regions: string[];
  /** 地区 → 国家 / 地区代码（取该地区第一台宿主机），用于显示旗帜 */
  regionCountry: Record<string, string>;
}

export interface AdminProductDTO extends ProductDTO {
  enabled: boolean;
  sortOrder: number;
  nodeIds: number[];
  /** 绑定宿主机的名称与网络模式（去重） */
  nodeNames: string[];
  networkModes: NetworkMode[];
  /** 容器选项：特权容器 / 嵌套 */
  privileged: boolean;
  nesting: boolean;
  /** 启动设置 */
  boot: import('./products').BootOptions;
  /** 已绑定宿主机的设置（以宿主机 ID 为键） */
  nodeOptions: Record<number, import('./products').ProductNodeOption>;
  planCount: number;
  /** 未删除的实例数 */
  activeInstances: number;
  /** 是否出现在购买页：已上架且至少有一个在售套餐 */
  listed: boolean;
}

export interface ImageDTO {
  id: number;
  name: string;
  family: string;
  forContainer: boolean;
  forVm: boolean;
  arch: ImageArch;
}

export interface AdminImageDTO extends ImageDTO {
  alias: string;
  server: string;
  protocol: string;
  cloudInit: string | null;
  enabled: boolean;
  sortOrder: number;
}

// ───────── 实例 ─────────

export interface TaskDTO {
  id: number;
  type: TaskType;
  status: TaskStatus;
  error: string | null;
  createdAt: DateString;
  startedAt: DateString | null;
  finishedAt: DateString | null;
  instanceId: number | null;
  instanceName?: string | null;
  user?: { id: number; username: string } | null;
}

export interface InstanceDTO {
  id: number;
  name: string;
  hostname: string;
  type: InstanceType;
  status: InstanceStatus;
  suspendReason: SuspendReason | null;
  /** 管理员填写的封禁原因 */
  suspendNote: string | null;
  region: string;
  /** 宿主机所在国家或地区（ISO 3166-1 alpha-2），未设置时为空 */
  country: string;
  plan: { id: number; name: string } | null;
  image: { id: number; name: string; family: string } | null;
  cpu: number;
  /** CPU 时间配额（分配核数的百分比），null 表示不限 */
  cpuAllowance: number | null;
  /** CPU 优先级 0~10，null 为默认 */
  cpuPriority: number | null;
  /** 最大进程数（仅容器），null 表示不限 */
  processLimit: number | null;
  memory: number;
  /** SWAP 大小 MiB（仅容器，0 为不提供）与是否已启用 */
  swap: number;
  swapEnabled: boolean;
  disk: number;
  /** 磁盘读写速率 MB/s 与 IOPS，0 表示不限 */
  diskRead: number;
  diskWrite: number;
  diskReadIops: number;
  diskWriteIops: number;
  bandwidthIn: number;
  bandwidthOut: number;
  traffic: number;
  trafficMode: TrafficMode;
  overLimitAction: OverLimitAction;
  /** 超额限速 Mbps */
  throttleRate: number;
  /** 自助重置流量的价格（每次），null 表示不开放 */
  trafficResetPrice: Money | null;
  portLimit: number;
  siteLimit: number;
  snapshotLimit: number;
  /** NAT 实例为宿主机公网 IP；独立 IP 实例为其公网 IPv4 */
  publicIp: string | null;
  /** 所在宿主机的公告（管理员在宿主机设置中填写），没有时为 null */
  hostAnnouncement: string | null;
  privateIp: string | null;
  /** 第一个公网 IPv6（主地址） */
  ipv6: string | null;
  /** 全部公网 IPv6 */
  ipv6List: string[];
  ipv6Prefixes: string[];
  /** 宿主机为 IPv6 Only：没有公网 IPv4 与端口映射，通过 IPv6 直接访问 */
  ipv6Only: boolean;
  sshPort: number | null;
  portRange: { start: number; end: number } | null;
  trafficIn: number;
  trafficOut: number;
  /** 按计费模式计算后的已用流量（字节） */
  trafficUsed: number;
  trafficThrottled: boolean;
  /** 当前流量周期：从开通时间起按月循环 */
  trafficPeriodStart: DateString;
  trafficResetAt: DateString;
  billingCycle: BillingCycle;
  price: Money;
  /** 每期实际续费价格：绑定了循环抵扣的优惠码时为优惠后的价格 */
  renewPrice: Money;
  /** 绑定的循环抵扣优惠码 */
  renewCoupon: { code: string; name: string | null } | null;
  /** 加入的 VPC 与内网地址 */
  vpc: { id: number; name: string; ip: string } | null;
  /** 正在交易市场挂牌：期间不能删除、重装、转移与重置密码 */
  marketListing: { id: number; price: Money } | null;
  expiresAt: DateString;
  autoRenew: boolean;
  createdAt: DateString;
  activeTask: TaskDTO | null;
  counts: { portMappings: number; sites: number; snapshots: number; volumes: number };
}

export interface AdminInstanceDTO extends InstanceDTO {
  node: { id: number; name: string };
  user: { id: number; username: string; email: string };
  remark: string | null;
  lastError: string | null;
}

export interface InstanceStateDTO {
  /** Incus 报告的状态，如 Running / Stopped */
  status: string;
  cpuPercent: number | null;
  memoryUsage: number;
  memoryTotal: number;
  swapUsage: number;
  diskUsage: number | null;
  diskTotal: number;
  processes: number;
  netRx: number;
  netTx: number;
  /** 实时网络速率（字节/秒），首次查询或计数器回绕时为 null */
  netRxRate: number | null;
  netTxRate: number | null;
  /** 本期流量（字节）：已统计的流量加上网卡计数器自上次统计以来的增量 */
  trafficIn: number;
  trafficOut: number;
  /** 按计费方向计算的本期已用流量 */
  trafficUsed: number;
  addresses: { family: 'inet' | 'inet6'; address: string; scope: string }[];
  collectedAt: DateString;
  /** 数据来源：agent 为宿主机 Agent 上报，panel 为面板直接查询 Incus */
  source: 'agent' | 'panel';
}

export interface MetricPoint {
  /** 毫秒时间戳 */
  t: number;
  /** CPU 使用率 0-100（相对于套餐核数） */
  cpu: number;
  /** 内存使用字节 */
  mem: number;
  /** 下行速率 bytes/s */
  rx: number;
  /** 上行速率 bytes/s */
  tx: number;
}

export interface TrafficDailyDTO {
  date: string;
  rx: number;
  tx: number;
}

export interface PortMappingDTO {
  id: number;
  protocol: PortProtocol;
  publicPort: number;
  privatePort: number;
  description: string | null;
  system: boolean;
  createdAt: DateString;
}

export interface SiteBindingDTO {
  id: number;
  domain: string;
  targetPort: number;
  https: boolean;
  status: SiteStatus;
  lastError: string | null;
  createdAt: DateString;
}

export interface SnapshotDTO {
  id: number;
  name: string;
  description: string | null;
  createdAt: DateString;
}

export interface CredentialsDTO {
  username: string;
  password: string | null;
  host: string | null;
  port: number;
}

// ───────── 计费 ─────────

export interface OrderDTO {
  id: number;
  no: string;
  type: OrderType;
  cycle: BillingCycle;
  /** 实付金额；原价 = amount + discount */
  amount: Money;
  discount: Money;
  couponCode: string | null;
  status: OrderStatus;
  description: string | null;
  createdAt: DateString;
  instanceId: number | null;
  /** 订单对应的实例（主机名与类型）；实例记录已不存在时为 null */
  instance: { hostname: string; type: InstanceType } | null;
  /** 下单时的产品与套餐 */
  plan: { name: string; product: string } | null;
  user?: { id: number; username: string };
}

export interface InvoicePurchaseConfigDTO extends Pick<PlanDTO, 'type' | 'cpu' | 'cpuAllowance' | 'memory' | 'swap' | 'disk' | 'diskRead' | 'diskWrite' | 'diskReadIops' | 'diskWriteIops' | 'bandwidthIn' | 'bandwidthOut' | 'traffic' | 'trafficMode' | 'portLimit' | 'siteLimit' | 'snapshotLimit' | 'ipv6Count'> {
  product: string;
  plan: string;
  hostname: string;
  region: string;
  node: string | null;
  image: string | null;
  cycle: BillingCycle;
  /** 旧账单使用当前关联套餐补充配置时为 false */
  snapshot: boolean;
  /** 未指定节点且各节点流量倍率不同时，展示最低可分配流量 */
  trafficIsEstimate: boolean;
}

export interface InvoiceDTO {
  id: number;
  no: string;
  type: InvoiceType;
  status: InvoiceStatus;
  amount: Money;
  discount: Money;
  description: string;
  instanceId: number | null;
  instance: { hostname: string; type: InstanceType } | null;
  plan: { name: string; product: string } | null;
  /** 仅包含购买配置，不包含密码、公钥或内部下单参数 */
  purchaseConfig: InvoicePurchaseConfigDTO | null;
  expiresAt: DateString | null;
  paidAt: DateString | null;
  createdAt: DateString;
  updatedAt: DateString;
}

export interface BalanceLogDTO {
  id: number;
  type: BalanceLogType;
  amount: Money;
  balanceAfter: Money;
  /** 说明（不含订单号） */
  description: string | null;
  /** 关联的订单号或支付单号，从说明末尾拆出 */
  ref: string | null;
  /** 订单号对应的订单：实例主机名、产品 / 套餐、计费周期与优惠信息 */
  order?: { hostname: string | null; plan: string | null; cycle: BillingCycle; type: InstanceType | null; amount: Money; discount: Money; couponCode: string | null };
  /** 在线充值对应的支付信息；兑换码、人工调整等记录没有此字段 */
  payment?: { methodName: string; channelName: string | null; amount: Money; fee: Money; payAmount: Money; currency: string; status: PaymentStatus };
  createdAt: DateString;
  user?: { id: number; username: string };
}

export interface AdminBillingRecordsDTO extends Paginated<BalanceLogDTO> {
  /** 当前全部筛选结果的净变动、扣款和入账，不受分页影响 */
  sum: Money;
  debitTotal: Money;
  creditTotal: Money;
}

export interface AdminOrdersDTO extends Paginated<OrderDTO> {
  /** 订单最初实付及优惠，包含后来全额退款的订单 */
  amountTotal: Money;
  discountTotal: Money;
  /** 标记为全额退款的订单金额；部分退款以余额流水为准 */
  refundedTotal: Money;
}

export interface RedeemCodeDTO {
  id: number;
  code: string;
  amount: Money;
  /** 可兑换次数（每个账号一次）与已兑换次数 */
  maxUses: number;
  usedCount: number;
  /** 最近一次兑换 */
  usedBy: { id: number; username: string } | null;
  usedAt: DateString | null;
  expiresAt: DateString | null;
  remark: string | null;
  createdAt: DateString;
}

/** 站内信 */
export interface MessageDTO {
  id: number;
  title: string;
  content: string;
  read: boolean;
  createdAt: DateString;
}

/** 批量操作结果：成功数量与失败明细 */
export interface BatchResultDTO {
  ok: number;
  failed: { id: number; hostname: string; message: string }[];
  /** 通知用户：收到站内信的用户数，立即发送与排队的邮件数 */
  notified?: { users: number; mailSent: number; mailQueued: number };
}

/** 管理员删除实例前的退款预览：每个实例在各退款方式下的退款金额与合计（与实际删除时的算法一致） */
export interface DeleteRefundPreviewDTO {
  items: { id: number; hostname: string; username: string; refund: Record<DeleteRefundMode, string> }[];
  total: Record<DeleteRefundMode, string>;
}

export interface AnnouncementDTO {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  published: boolean;
  level: 'INFO' | 'WARNING' | 'CRITICAL';
  expiresAt: DateString | null;
  createdAt: DateString;
  updatedAt: DateString;
  /** 当前用户是否已读（通知中心的公告列表才有） */
  read?: boolean;
}

export interface UserDashboardDTO {
  balance: Money;
  instances: { total: number; running: number; expiringSoon: number };
  announcements: AnnouncementDTO[];
  recentTasks: TaskDTO[];
}

// ───────── 管理 ─────────

/** 用户绑定的第三方登录（提供商已停用 / 删除的也列出） */
export interface AdminUserOAuthDTO {
  provider: string;
  providerName: string;
  icon: string | null;
  active: boolean;
  removed: boolean;
}

export interface AdminUserDTO {
  emailVerifiedAt: DateString | null;
  id: number;
  email: string;
  username: string;
  /** 昵称 */
  name: string | null;
  avatar: AvatarDTO;
  oauth: AdminUserOAuthDTO[];
  role: Role;
  status: UserStatus;
  balance: Money;
  remark: string | null;
  instanceCount: number;
  lastLoginAt: DateString | null;
  lastLoginIp: string | null;
  createdAt: DateString;
  twoFactorEnabled: boolean;
}

/** 管理端用户详情：账号信息 + 资源用量 */
export interface AdminUserDetailDTO {
  user: AdminUserDTO;
  usage: { instances: number; running: number; ports: number; sites: number; snapshots: number; cpu: number; memory: number; disk: number };
  /** 该账号有没有本地登录密码（只用第三方账号注册的没有） */
  hasPassword: boolean;
}

/** 管理端：用户的实例（简要） */
export interface AdminUserInstanceDTO {
  id: number;
  name: string;
  hostname: string;
  type: InstanceType;
  status: InstanceStatus;
  suspendReason: SuspendReason | null;
  nodeName: string;
  planName: string | null;
  imageName: string | null;
  family: string | null;
  ip: string | null;
  cpu: number;
  memory: number;
  disk: number;
  expiresAt: DateString;
  createdAt: DateString;
}

/** 管理端：用户的登录设备 */
export interface AdminUserSessionDTO {
  id: string;
  os: string;
  browser: string;
  device: 'mobile' | 'desktop';
  ip: string | null;
  createdAt: DateString;
  lastActiveAt: DateString;
  /** 管理员代登录产生的会话 */
  impersonatedBy: string | null;
}

/** 管理端：用户绑定的第三方账号 */
export interface AdminUserOAuthAccountDTO extends AdminUserOAuthDTO {
  id: number;
  providerId: string;
  email: string | null;
  name: string | null;
  createdAt: DateString;
}

export interface NodeDTO {
  id: number;
  name: string;
  /** 节点测试：Agent 每小时向国内三网目标 Ping */
  pingEnabled: boolean;
  /** 安装节点脚本时是否安装宿主机 Agent */
  installAgent: boolean;
  /** 安装节点脚本时是否部署 RFW 防火墙 */
  installFirewall: boolean;
  /** 安装节点脚本时是否启用 RFW 与 Incus 网络规则 */
  enableFirewallRules: boolean;
  /** 宿主机公告（显示在该宿主机上全部实例的实例管理页面），为空不显示 */
  announcement: string;
  /** 智能分流是否开启 */
  egressEnabled: boolean;
  region: string;
  /** 国家或地区（ISO 3166-1 alpha-2），未设置时为空 */
  country: string;
  description: string;
  networkMode: NetworkMode;
  /** 连接地址：IPv4、IPv6 或域名（mock:// 演示节点为完整地址） */
  address: string;
  endpoint: string;
  serverFingerprint: string | null;
  project: string;
  storagePool: string;
  profile: string;
  publicIp: string;
  publicIpv6: string;
  natNetwork: string;
  natCidr: string | null;
  natListenAddress: string;
  natListenAddressV6: string;
  ipv6Subnet: string;
  ipv6Parent: string;
  ipv6PrefixLength: number;
  portRangeStart: number;
  portRangeEnd: number;
  publicNicMode: PublicNicMode;
  publicNicParent: string | null;
  dnsServers: string;
  apiPort: number;
  storageDriver: string;
  storageSource: string | null;
  storageSize: string;
  natCidrInstall: string;
  installTokenExpires: DateString | null;
  installedAt: DateString | null;
  incusVersion: string | null;
  /** 宿主机架构；为空表示尚未读取，此时不按架构过滤镜像 */
  arch: string | null;
  caddyStatus: CaddyStatus;
  caddyAdminPort: number;
  caddyError: string | null;
  caddyVersion: string | null;
  /** 每周期流量额度（GB），0 为不限 */
  trafficLimit: number;
  trafficResetDay: number;
  trafficMode: TrafficMode;
  maxInstances: number;
  /** 购买这台宿主机上的实例前需要实名认证 */
  requireRealName: boolean;
  /** 可用的系统镜像 ID；null 表示使用面板的全部默认镜像 */
  imageIds: number[] | null;
  enabled: boolean;
  status: NodeStatus;
  lastCheckedAt: DateString | null;
  lastError: string | null;
  sortOrder: number;
  createdAt: DateString;
  instanceCount: number;
  ipStats: { total: number; used: number };
  siteCount: number;
}

/** 宿主机资源分配与本周期流量（流量为本机所有实例之和） */
export interface NodeUsageDTO {
  period: { start: DateString; end: DateString; resetDay: number };
  traffic: { rx: number; tx: number; used: number; limit: number | null; mode: TrafficMode };
  /** 本周期每天的流量（UTC 日期，YYYY-MM-DD） */
  daily: { date: string; rx: number; tx: number }[];
  /** 已售出的资源：vCPU、内存（MiB）、磁盘（GiB）与实例数 */
  allocated: { cpu: number; memory: number; disk: number; instances: number };
  /** 根据实例监控估算的 CPU 占用（核），无监控数据时为 null */
  cpuUsed: number | null;
}

export interface InstallCommandDTO {
  command: string;
  scriptUrl: string;
  expiresAt: DateString;
  installOptions?: {
    agent: boolean;
    firewall: boolean;
    firewallRules: boolean;
  };
}

/** 实例数据盘 */
export interface VolumeDTO {
  id: number;
  pool: string;
  /** Incus 卷名称 */
  name: string;
  /** GiB */
  size: number;
  /** 容器内的挂载目录；虚拟机为 null（作为磁盘接入） */
  path: string | null;
  /** 实例上的设备名 */
  device: string;
  createdAt: DateString;
}

export interface StoragePoolDTO {
  name: string;
  driver: string;
  status: string;
  description: string;
  source: string | null;
  size: string | null;
  usedBy: number;
  space: { used: number; total: number } | null;
  isDefault: boolean;
  usage: PoolUsage;
}

export interface ProxySiteDTO {
  id: number;
  node: { id: number; name: string };
  domain: string;
  upstream: string;
  https: boolean;
  remark: string | null;
  status: SiteStatus;
  lastError: string | null;
  createdAt: DateString;
}

export interface NodeResourcesDTO {
  serverVersion: string;
  serverName: string;
  kernel: string;
  cpu: { cores: number; model: string };
  memory: { total: number; used: number };
  storage: { pool: string; driver: string; total: number; used: number } | null;
  instances: { total: number; running: number };
  /** 系统负载（Incus resources_load 扩展，旧版本为 null） */
  load: { avg1: number; avg5: number; avg15: number; processes: number | null } | null;
  hardware: NodeHardwareDTO;
  /** 宿主机上报程序最近一次上报（2 分钟内），未安装或已中断时为 null */
  host: HostReportDTO | null;
  /** 是否已为该宿主机签发上报令牌（安装过上报程序） */
  agentInstalled: boolean;
  /** 当前下载源已确认的最新 Agent 版本；尚未获取到发布信息时为 null */
  agentLatestVersion?: string | null;
}

/** 宿主机上报程序采集的数据 */
export interface HostReportDTO {
  /** 整机 CPU 使用率（%） */
  cpu: number;
  load: [number, number, number];
  /** 系统运行时长（秒） */
  uptime: number;
  /** 上报协议版本：2 起支持限制虚拟机的 CPU 配额与优先级；3 起为 Go 版 Agent（以下字段只有 3 起才有） */
  version: number;
  reportedAt: DateString;
  /** Agent 发布版本，如 0.3.0 */
  release?: string;
  cores?: number;
  /** 内存 / SWAP / 根分区：总量与已用（字节） */
  memory?: { total: number; used: number };
  swap?: { total: number; used: number };
  disk?: { path: string; total: number; used: number };
  processes?: number;
  hostname?: string;
  os?: string;
  kernel?: string;
  arch?: string;
  /** Incus 检测：本地 socket 是否可用 */
  incus?: { available: boolean; socket?: string; version?: string; error?: string };
  /** Agent 支持的功能 */
  capabilities?: string[];
  /** 上报来源 IP（面板看到的心跳地址） */
  ip?: string;
  /** 在离线阈值（max(3 × 上报间隔, 60 秒)）内有上报；离线时仍返回最后一次上报 */
  online: boolean;
}

/** 宿主机硬件信息（来自 Incus /1.0/resources） */
export interface NodeHardwareDTO {
  system: { vendor: string; product: string; type: string } | null;
  os: { name: string; version: string; kernel: string } | null;
  cpu: { model: string; arch: string; sockets: number; cores: number; threads: number; frequency: number | null; turbo: number | null };
  gpus: { vendor: string; product: string }[];
  disks: { name: string; model: string; type: string; size: number; ssd: boolean | null }[];
  /** speed 为链路速率（Mbit/s），未连接或未知时为 null */
  nics: { name: string; vendor: string; product: string; speed: number | null; link: boolean }[];
}

/** 宿主机实时带宽：物理网卡收发速率（字节/秒） */
export interface NodeBandwidthDTO {
  interfaces: string[];
  current: { rx: number; tx: number } | null;
  /** 最近一小时的采样点，t 为毫秒时间戳 */
  series: { t: number; rx: number; tx: number }[];
}

export interface IpAddressDTO {
  id: number;
  nodeId: number;
  address: string;
  prefix: number;
  gateway: string | null;
  disabled: boolean;
  remark: string | null;
  instance: { id: number; name: string; hostname: string } | null;
  createdAt: DateString;
}

export interface AdminNodeUsageDTO {
  id: number;
  name: string;
  region: string;
  status: NodeStatus;
  enabled: boolean;
  instanceCount: number;
  /** 已分配给实例的资源（按套餐规格汇总）：vCPU 个数、内存 MiB、硬盘 GB */
  allocated: { cpu: number; memory: number; disk: number };
  /** 宿主机实际容量（字节），节点离线或无法获取时为 null */
  capacity: { cpu: number; memory: number; disk: number | null } | null;
}

export interface AdminStatsDTO {
  users: number;
  usersToday: number;
  /** 状态正常（未停用）的用户 */
  usersActive: number;
  instances: Record<string, number>;
  nodes: { total: number; online: number };
  /** lastMonth：上月同期（上月 1 日到上月今天此刻）的收入，用于环比 */
  revenue: { today: Money; month: Money; lastMonth: Money; total: Money; monthRecharge: Money };
  /** 充值订单：今日已支付 / 今日全部，以及等待支付的笔数 */
  payments: { todayPaid: number; todayTotal: number; pending: number };
  /** 等待处理（用户已提交或已回复）的工单 */
  ticketsOpen: number;
  revenueDaily: { date: string; amount: number }[];
  recentOrders: OrderDTO[];
  failedTasks: TaskDTO[];
  nodeUsage: AdminNodeUsageDTO[];
  pendingSites: number;
  system: SystemInfoDTO;
}

/** 面板客户端证书（不含私钥） */
export interface PanelCertificateDTO {
  /** PEM 格式证书 */
  certificate: string;
  /** SHA-256 指纹（十六进制小写，无冒号） */
  fingerprint: string;
  /** 主体，如 CN=paledove-panel, O=PaleDove */
  subject: string;
  validFrom: DateString;
  validTo: DateString;
  /** 公钥算法与长度，如 RSA 3072 */
  keyAlgorithm: string;
}

/** 本地 Incus 客户端证书的部署状态；不包含私钥内容。 */
export interface PanelCertificateStatusDTO {
  certificatePath: string;
  privateKeyPath: string;
  certificate: PanelCertificateDTO | null;
  error: string | null;
}

/** 管理总览底部的系统状态（每次请求实时检测） */
export interface SystemInfoDTO {
  /** 数据库与缓存均可用时为 ok */
  status: 'ok' | 'degraded';
  database: { kind: 'PostgreSQL' | 'SQLite'; version: string | null; ok: boolean; latencyMs: number | null };
  /** memory：REDIS_URL=memory:// 的进程内存储 */
  cache: { kind: 'Redis' | 'memory'; version: string | null; ok: boolean; latencyMs: number | null };
  queue: 'BullMQ' | 'memory';
  /** 本进程是否运行任务 Worker */
  worker: boolean;
  /** 进程运行时长（秒） */
  uptime: number;
  /** 进程常驻内存（字节） */
  memory: number;
  node: string;
}

export interface ActivityLogDTO {
  id: number;
  action: string;
  detail: string | null;
  ip: string | null;
  createdAt: DateString;
  user: { id: number; username: string } | null;
}

// ───────── 在线充值 ─────────

export interface PaymentDTO {
  id: number;
  no: string;
  gateway: PaymentGateway;
  /** 支付方式：alipay / wxpay / qqpay / stripe / heleket */
  channel: string | null;
  /** 支付方式名称（如“支付宝”“银行卡”） */
  methodName: string;
  /** 所属支付渠道名称（渠道已删除时为 null） */
  channelName: string | null;
  amount: Money;
  /** 手续费（加在应付金额上） */
  fee: Money;
  payAmount: Money;
  currency: string;
  status: PaymentStatus;
  paidAt: DateString | null;
  createdAt: DateString;
  user?: { id: number; username: string };
}

// ───────── 账号安全 ─────────

/** 登录设备（会话）：设备、IP、最后活动 */
export interface SessionDTO {
  id: string;
  os: string;
  browser: string;
  device: 'mobile' | 'desktop';
  ip: string | null;
  createdAt: DateString;
  lastActiveAt: DateString;
  current: boolean;
}

/** 通行密钥 */
/** 管理员查看的用户安全设置：两步验证状态与通行密钥 */
export interface AdminUserSecurityDTO {
  twofa: { enabled: boolean; enabledAt: DateString | null; recoveryRemaining: number };
  passkeys: PasskeyDTO[];
}

export interface PasskeyDTO {
  id: number;
  name: string;
  /** singleDevice：只保存在一台设备上；multiDevice：可在设备间同步（如 iCloud 钥匙串、Google 密码管理器） */
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  createdAt: DateString;
  lastUsedAt: DateString | null;
}

/** 登录结果：已启用两步验证时返回挑战令牌，凭验证码完成登录 */
export interface LoginResultDTO {
  user?: MeDTO;
  needTotp?: boolean;
  challenge?: string;
}

/** 登录页显示的第三方登录方式 */
export interface OAuthProviderPublicDTO {
  id: string;
  name: string;
  /** 自定义图标地址；null 时显示内置图标或名称首字 */
  icon: string | null;
}

/** 实名认证状态（支付宝刷脸核验） */
export interface RealNameInfoDTO {
  status: 'NONE' | VerificationStatus;
  nameMasked?: string;
  idNumberMasked?: string;
  reason?: string | null;
  submittedAt?: DateString;
  reviewedAt?: DateString | null;
  /** 平台是否已配置支付宝实名认证 */
  available: boolean;
  /** 认证中时的支付宝认证页地址 */
  certifyUrl?: string | null;
}

export interface ApiTokenDTO {
  id: number;
  name: string;
  /** 令牌开头几位 */
  prefix: string;
  lastUsedAt: DateString | null;
  lastUsedIp: string | null;
  expiresAt: DateString | null;
  /** 只读令牌：只能调用查询接口 */
  readOnly: boolean;
  createdAt: DateString;
}

// ───────── 宿主机运维 ─────────

/** 宿主机上的实例分类：已登记 / 残留（带面板标记但数据库里没有对应记录） / 其他（不是面板创建的） */
export type HostInstanceCategory = 'managed' | 'orphan' | 'other';

/** 与面板配置基线的差异：baseline 为配额与开机设置，network 为网卡、端口映射与实例内的地址 */
export interface InstanceDriftDTO {
  kind: 'baseline' | 'network';
  key: string;
  expected: string | null;
  actual: string | null;
}

export interface HostInstanceDTO {
  name: string;
  type: 'container' | 'virtual-machine';
  /** Incus 的运行状态：Running / Stopped / Frozen / Error */
  status: string;
  description: string;
  cpu: string | null;
  memory: string | null;
  disk: string | null;
  autostart: boolean;
  ipv4: string[];
  ipv6: string[];
  memoryUsage: number | null;
  diskUsage: number | null;
  createdAt: DateString;
  category: HostInstanceCategory;
  /** 实例上的面板标记 user.paledove.id */
  panelId: number | null;
  record: { id: number; hostname: string; status: InstanceStatus; type: InstanceType; user: { id: number; email: string } } | null;
  drift: InstanceDriftDTO[];
}

export interface HostInstancesDTO {
  /** 宿主机的 NAT 网桥检查结果；只提供独立 IPv4 的宿主机为 null */
  network: { name: string; ok: boolean; cidr: string | null; expected: string | null; message: string | null } | null;
  items: HostInstanceDTO[];
  /** 数据库里应该在这台宿主机上、但 Incus 里找不到的实例 */
  missing: Array<{ id: number; hostname: string; name: string; status: InstanceStatus; user: { id: number; email: string } }>;
}

/** 实例进程审查：只读读取实例内进程并按高风险工具规则分类。 */
export type InstanceAuditStatus = 'CLEAN' | 'SUSPICIOUS' | 'STOPPED' | 'UNSUPPORTED' | 'ERROR';
export type InstanceAuditCategory = 'MINING' | 'PACKET' | 'SCANNER' | 'DDOS' | 'PROXY' | 'ANOMALY';
export type InstanceAuditRisk = 'HIGH' | 'MEDIUM' | 'LOW';
export type InstanceAuditTarget = 'process' | 'network' | 'startup';
export type InstanceAuditMatchType = 'contains' | 'regex' | 'exact';
export type InstanceAuditSeverity = 'info' | 'low' | 'medium' | 'high';

export interface InstanceAuditRuleDTO {
  id: string;
  /** BUILTIN 规则由程序维护，CUSTOM 规则可在后台编辑。 */
  source: 'BUILTIN' | 'CUSTOM';
  databaseId?: number;
  enabled: boolean;
  name: string;
  category: InstanceAuditCategory;
  risk: InstanceAuditRisk;
  /** 规则库中的简短名称。 */
  evidence: string;
  /** 规则覆盖的程序名、协议或关键字。 */
  matches: string[];
  /** 规则检查的对象；旧版规则缺省为进程。 */
  targetTypes?: InstanceAuditTarget[];
  /** 自定义规则的匹配方式；旧版规则缺省为 contains。 */
  matchType?: InstanceAuditMatchType;
  /** regex/contains/exact 使用的原始表达式；未设置时使用 matches。 */
  patternText?: string;
  caseSensitive?: boolean;
  description?: string | null;
  recommendation?: string | null;
}

export interface InstanceAuditProcessDTO {
  pid: number;
  ppid: number | null;
  user: string;
  stat: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
  elapsed: string;
  command: string;
  args: string;
  findings: string[];
}

export interface InstanceAuditConnectionDTO {
  protocol: string;
  state: string;
  local: string;
  peer: string;
  process: string | null;
  pid: number | null;
  evidence: string;
  findings: string[];
}

export interface InstanceAuditStartupItemDTO {
  source: string;
  command: string;
  findings: string[];
}

export interface InstanceAuditFindingDTO {
  pid: number;
  process: string;
  ruleId: string;
  category: InstanceAuditCategory;
  risk: InstanceAuditRisk;
  /** 脱敏后的命令摘要，不包含完整参数。 */
  command: string;
  evidence: string;
  targetType?: InstanceAuditTarget;
  ruleName?: string;
  matchedText?: string;
  recommendation?: string | null;
  ignored?: boolean;
  ignoreReason?: string | null;
  detail?: string;
}

export interface InstanceAuditSummaryDTO {
  riskLevel: InstanceAuditSeverity;
  processCount: number;
  connectionCount: number;
  listeningCount: number;
  startupItemCount: number;
  findingCount: number;
  ignoredFindingCount?: number;
}

export interface InstanceAuditResultDTO {
  name: string;
  type: 'container' | 'virtual-machine';
  status: InstanceAuditStatus;
  /** 面板显示用的原因；不含原始命令行。 */
  message?: string;
  findings: InstanceAuditFindingDTO[];
  processes?: InstanceAuditProcessDTO[];
  connections?: InstanceAuditConnectionDTO[];
  startupItems?: InstanceAuditStartupItemDTO[];
  summary?: InstanceAuditSummaryDTO;
  checkedAt: DateString;
}

export interface InstanceAuditBatchDTO {
  results: InstanceAuditResultDTO[];
  rules: InstanceAuditRuleDTO[];
  checkedAt: DateString;
}

/** 管理后台的用户网站绑定（反代到实例的内网端口） */
export interface AdminSiteBindingDTO extends SiteBindingDTO {
  upstream: string;
  instance: { id: number; hostname: string; status: InstanceStatus };
  node: { id: number; name: string };
  user: { id: number; username: string; email: string };
}

/** 实例转移记录（用户视角） */
export interface TransferRecordDTO {
  id: number;
  instanceId: number;
  /** 转移时的主机名 */
  hostname: string;
  /** IN：转入我的账号；OUT：从我的账号转出 */
  direction: 'IN' | 'OUT';
  /** 对方用户名；管理员操作时为 null */
  counterpart: string | null;
  mode: TransferMode;
  byAdmin: boolean;
  /** 实例当前仍属于我且未删除，可以打开详情 */
  accessible: boolean;
  remark: string | null;
  /** 转出方支付的手续费 */
  fee: string;
  /** 转移时的实例信息 */
  spec: TransferSpecDTO;
  createdAt: DateString;
}

/** 转移记录里的实例快照 */
export interface TransferSpecDTO {
  name: string;
  type: InstanceType;
  cpu: number;
  memory: number;
  disk: number;
  bandwidthIn: number;
  bandwidthOut: number;
  /** 每月流量（GB），0 表示不限 */
  traffic: number;
  trafficMode: TrafficMode;
  region: string;
  country: string;
  /** 转移后的系统（全新安装时为重装的系统） */
  image: string | null;
  product: string | null;
  plan: string | null;
  cycle: BillingCycle;
  /** 续费价格（一个计费周期） */
  price: string;
  expiresAt: DateString;
}

/** 转移前的检查：接收方账号是否可用，以及需要支付的手续费 */
export interface TransferCheckDTO {
  fee: string;
  /** 接收方可用时返回用户名 */
  recipient: { username: string } | null;
  /** 接收方不可用的原因 */
  error: string | null;
}

/** 推广返利概况 */
export interface AffSummaryDTO {
  enabled: boolean;
  /** 首购与续费的佣金比例（%） */
  rateNew: number;
  rateRenew: number;
  /** 冻结期（天），0 表示立即生效 */
  freezeDays: number;
  minWithdraw: number;
  /** 推广码；功能关闭时为 null */
  code: string | null;
  /** 可转入余额的佣金 */
  balance: string;
  /** 冻结期内待生效的佣金 */
  pending: string;
  /** 累计已生效的佣金（扣除撤回） */
  total: string;
  /** 邀请注册的人数 / 其中付过款的人数 */
  invited: number;
  paidInvitees: number;
}

/** 佣金明细：一笔订单的返佣；REVOKED 为生效后因退款撤回，CANCELED 为冻结期内退款作废 */
export type AffCommissionStatus = 'PENDING' | 'SETTLED' | 'CANCELED' | 'REVOKED';

export interface AffLogDTO {
  id: number;
  type: AffLogType;
  status: AffCommissionStatus;
  amount: string;
  /** 订单号与订单类型（首购 / 续费） */
  orderNo: string | null;
  orderType: OrderType | null;
  /** 被邀请用户（用户名部分隐藏） */
  invitee: string | null;
  /** 返佣基数：订单净额中实际支付的部分 */
  orderAmount: string | null;
  rate: string | null;
  createdAt: DateString;
  /** 预计（待生效）或实际（已生效）生效时间 */
  effectiveAt: DateString | null;
}

/** 金额与笔数 */
export interface AmountCount {
  amount: Money;
  count: number;
}

export interface BillingChange {
  difference: Money;
  /** 上月同期为零或负数时不计算百分比 */
  percent: number | null;
}

/** 后台计费概览：服务收入不含市场买卖、人工调整和充值；充值为在线充值与兑换码入账 */
export interface AdminBillingOverviewDTO {
  period: { asOf: DateString; monthStart: DateString; lastMonthStart: DateString; lastMonthToDateEnd: DateString };
  income: {
    /** 净收入（累计） */
    total: Money;
    /** 服务扣费合计（新购、续费、过户、流量重置、切换机房） */
    gross: Money;
    /** 服务退款合计，包含切换机房等失败时退费 */
    refund: Money;
    today: Money;
    month: Money;
    /** 上月同期（上月 1 日至对应日期时刻；若无对应日期则使用上月整月） */
    lastMonthToDate: Money;
    lastMonth: Money;
    change: BillingChange;
    monthCharges: AmountCount;
    monthRefunds: AmountCount;
  };
  recharge: {
    total: AmountCount;
    month: AmountCount;
    today: AmountCount;
    /** 在线充值与兑换码的累计金额 */
    online: Money;
    redeem: Money;
    lastMonthToDate: AmountCount;
    lastMonth: AmountCount;
    change: BillingChange;
    monthOnline: AmountCount;
    monthRedeem: AmountCount;
  };
  /** 本月仍为已支付状态的新购 / 续费订单，不含全额退款订单 */
  monthOrders: { amount: Money; count: number; newCount: number; renewCount: number; discount: Money; discountedCount: number };
  /** 管理员手动调整余额的净额 */
  adjust: Money;
  /** 优惠码累计减免（已支付订单） */
  coupons: AmountCount;
  /** 用户当前余额合计（尚未消费的预付款） */
  balance: { total: Money; users: number };
  /** 收入结构：按扣费类型与按产品 */
  incomeByType: { purchase: Money; renew: Money; other: Money; refund: Money };
  monthIncomeByType: { purchase: Money; renew: Money; other: Money };
  incomeByProduct: Array<{ productId: number | null; name: string; amount: Money; count: number }>;
  instances: {
    /** 未删除实例：已到期（含宽限期内被暂停的）、已封停（流量超额或管理员封停）、其余为活跃 */
    total: number;
    active: number;
    expired: number;
    suspended: number;
    /** 按价格区分 */
    paid: number;
    free: number;
    autoRenew: number;
    /** 7 天内即将到期（尚未到期） */
    expiringSoon: number;
  };
}

/** 充值（在线充值 / 兑换码 / 人工增加）与扣费（服务消费 / 退费 / 市场交易 / 人工扣减） */
export type BillingRecordKind = 'all' | 'recharge' | 'charge';

// ───────── 优惠码 ─────────

export interface CouponDTO {
  id: number;
  code: string;
  name: string | null;
  type: CouponType;
  /** PERCENT 为减免比例（20 表示减 20%），AMOUNT 为减免金额 */
  value: Money;
  scope: CouponScope;
  /** 适用产品，null 为全部 */
  productIds: number[] | null;
  /** 适用套餐，null 为所选产品的全部套餐 */
  planIds: number[] | null;
  /** 适用付款周期，null 为全部 */
  cycles: BillingCycle[] | null;
  minAmount: Money | null;
  maxDiscount: Money | null;
  maxUses: number | null;
  perUser: number | null;
  mode: CouponMode;
  newUserOnly: boolean;
  usedCount: number;
  /** 累计减免金额 */
  totalDiscount: Money;
  startsAt: DateString | null;
  expiresAt: DateString | null;
  enabled: boolean;
  remark: string | null;
  createdAt: DateString;
}

export interface CouponUsageDTO {
  id: number;
  user: { id: number; username: string } | null;
  orderNo: string;
  orderType: OrderType;
  /** 订单原价与减免金额 */
  amount: Money;
  discount: Money;
  createdAt: DateString;
}

/** 下单 / 续费前试算优惠码 */
export interface CouponQuoteDTO {
  code: string;
  name: string | null;
  mode: CouponMode;
  type: CouponType;
  value: Money;
  amount: Money;
  discount: Money;
  total: Money;
}

// ───────── VPC 私有网络 ─────────

export interface VpcMemberDTO {
  instanceId: number;
  name: string;
  hostname: string;
  /** 在 VPC 中的内网地址 */
  ip: string;
  status: InstanceStatus;
}

export interface VpcDTO {
  id: number;
  name: string;
  cidr: string;
  /** 所在宿主机（用户只看到地区，位置用“与哪些实例在同一台宿主机”表示） */
  nodeId: number;
  region: string;
  country: string | null;
  createdAt: DateString;
  members: VpcMemberDTO[];
}

/** 可以建 VPC 的位置：用户实例所在的宿主机 */
export interface VpcLocationDTO {
  nodeId: number;
  region: string;
  country: string | null;
  instances: Array<{ id: number; name: string; hostname: string; vpcId: number | null }>;
}

export interface VpcListDTO {
  items: VpcDTO[];
  locations: VpcLocationDTO[];
  /** 每个用户最多可创建的数量，0 表示未开放 */
  limit: number;
}

/** 账号保存的 SSH 公钥 */
export interface SshKeyDTO {
  id: number;
  name: string;
  /** ssh-ed25519 / ssh-rsa 等 */
  type: string;
  /** RSA 密钥位数，其他类型为 null */
  bits: number | null;
  /** SHA256 指纹 */
  fingerprint: string;
  publicKey: string;
  createdAt: DateString;
}

// ───────── 交易市场 ─────────

/** 交易市场里的一件商品：只包含买家需要看的配置，不含主机名、IP 等可识别实例的信息 */
export interface MarketListingDTO {
  id: number;
  /** 当前登录用户就是卖家 */
  mine: boolean;
  /** 定向出售：只有指定的买家和卖家看得到 */
  targeted: boolean;
  status: import('./enums').MarketListingStatus;
  /** 挂牌价（买家支付） */
  price: Money;
  /** 成交后的交接方式：现在一律全新安装（旧记录可能是原样交接） */
  mode: TransferMode;
  createdAt: DateString;
  region: string;
  country: string;
  product: { name: string; tags: string[]; description: string | null } | null;
  plan: string | null;
  type: InstanceType;
  cpu: number;
  memory: number;
  disk: number;
  bandwidthIn: number;
  bandwidthOut: number;
  /** 每月流量 GB，0 不限 */
  traffic: number;
  /** 本期已用流量（字节） */
  trafficUsed: number;
  trafficMode: TrafficMode;
  overLimitAction: OverLimitAction;
  throttleRate: number;
  /** 公网 IPv4：NAT 共享 / 独立 */
  ipv4: 'NAT' | 'DEDICATED';
  ipv6Count: number;
  image: string | null;
  /** 每期续费价格与周期 */
  renewPrice: Money;
  billingCycle: BillingCycle;
  /** 自助重置流量的价格，null 表示不开放 */
  trafficResetPrice: Money | null;
  expiresAt: DateString;
  instanceStatus: InstanceStatus;
  /** 卖家用户名（部分隐藏） */
  seller: string;
  /** 上架前拨测快照的摘要（功能上线前上架的商品为 null） */
  ping: MarketPingSummaryDTO | null;
  /** 已在交易市场公开（拨测完成后公开，之前只有卖家与管理员能看到） */
  published: boolean;
}

export interface MarketListPageDTO extends Paginated<MarketListingDTO> {
  /** 当前有商品在售的地区，用于筛选 */
  regions: string[];
}

/** 卖家自己的挂牌记录（含实例信息、手续费与成交情况） */
/** 交易市场成交时的实例信息快照（成交记录） */
export interface MarketSaleSnapshotDTO {
  /** 记录时间（成交时） */
  takenAt: DateString;
  instanceId: number;
  /** 实例 ID（Incus 中的名称） */
  instanceName: string;
  hostname: string;
  nodeId: number;
  nodeName: string;
  region: string;
  country: string;
  product: string | null;
  plan: string | null;
  type: import('./enums').InstanceType;
  cpu: number;
  memory: number;
  disk: number;
  bandwidthIn: number;
  bandwidthOut: number;
  traffic: number;
  trafficUsed: number;
  trafficMode: import('./enums').TrafficMode;
  publicIp: string | null;
  privateIp: string | null;
  ipv6: string[];
  image: string | null;
  instanceStatus: import('./enums').InstanceStatus;
  createdAt: DateString;
  expiresAt: DateString;
  billingCycle: import('./enums').BillingCycle;
  renewPrice: Money;
  seller: { id: number; username: string };
  buyer: { id: number; username: string };
  price: Money;
  fee: Money;
  income: Money;
  mode: import('./enums').TransferMode;
}

export interface MarketMineDTO extends MarketListingDTO {
  instanceId: number;
  hostname: string;
  fee: Money;
  /** 扣除手续费后卖家实际到账（挂牌中为预估） */
  income: Money;
  soldAt: DateString | null;
  /** 买家（成交后）与定向买家的用户名 */
  buyer: string | null;
  target: string | null;
  endReason: string | null;
  /** 成交时的实例信息快照（已成交且有记录时） */
  snapshot: MarketSaleSnapshotDTO | null;
}

/** 管理后台的挂牌记录 */
export interface AdminMarketListingDTO extends MarketMineDTO {
  sellerId: number;
  sellerName: string;
  buyerId: number | null;
}

/** 可以挂牌的实例：blocker 不为空时说明不能挂牌的原因 */
export interface MarketSellableDTO {
  id: number;
  hostname: string;
  region: string;
  plan: string | null;
  type: InstanceType;
  cpu: number;
  memory: number;
  disk: number;
  renewPrice: Money;
  billingCycle: BillingCycle;
  expiresAt: DateString;
  status: InstanceStatus;
  hasImage: boolean;
  blocker: string | null;
}

/** 同一套餐最近 30 天的成交价走势 */
export interface MarketHistoryDTO {
  plan: string | null;
  renewPrice: Money;
  currentPrice: Money;
  average: Money | null;
  min: Money | null;
  max: Money | null;
  count: number;
  from: DateString;
  to: DateString;
  points: { t: DateString; price: Money; targeted: boolean }[];
}

// ───────── 智能分流 ─────────

/** Agent 上报的出口状态 */
export interface EgressStatusDTO {
  ok: boolean;
  error: string | null;
  /** WireGuard 最近一次握手时间；代理为 null */
  handshakeAt: DateString | null;
  /** 隧道收发字节（WireGuard） */
  rx: number;
  tx: number;
  /** 连通性检测的延迟（毫秒） */
  latency: number | null;
  checkedAt: DateString;
}

/** 管理端的出口：密钥与密码不返回，只标出是否已设置（保存时留空表示不修改） */
export interface AdminEgressDTO {
  id: number;
  name: string;
  type: import('./enums').EgressType;
  enabled: boolean;
  sortOrder: number;
  remark: string | null;
  wireguard: {
    address: string;
    peerPublicKey: string;
    endpoint: string;
    mtu: number;
    keepalive: number;
    hasPrivateKey: boolean;
    hasPresharedKey: boolean;
  } | null;
  proxy: { host: string; port: number; username: string; hasPassword: boolean } | null;
  /** 正在使用该出口的实例数 */
  instanceCount: number;
  status: EgressStatusDTO | null;
}

/** 宿主机的智能分流配置与 Agent 执行情况 */
export interface AdminNodeEgressDTO {
  enabled: boolean;
  /** 配置版本（每次修改递增）与 Agent 已应用的版本 */
  version: number;
  appliedVersion: number | null;
  appliedAt: DateString | null;
  /** Agent 应用配置时的整体错误（如缺少 wireguard-tools） */
  applyError: string | null;
  agent: { online: boolean; supported: boolean };
  items: AdminEgressDTO[];
}

/** 实例可选的出口（用户在实例管理中切换） */
export interface InstanceEgressDTO {
  /** 能否切换出口：宿主机开启了智能分流、实例为 NAT 类型且有可用出口 */
  available: boolean;
  /** 当前出口（null 为宿主机默认线路） */
  current: number | null;
  options: { id: number; name: string; type: import('./enums').EgressType; remark: string | null; ok: boolean | null }[];
}

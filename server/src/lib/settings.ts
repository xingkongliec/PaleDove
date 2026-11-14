import { DEFAULT_AVATAR_API, type SiteSettings, type MaintenanceSettings, type DocumentDTO, type DocumentCategoryDTO, type DocumentMetadata, type LegalKind } from '../shared/index.ts';
import { prisma, Prisma } from './prisma.ts';
import { invalidateCache } from './cache.ts';
import { publish, subscribe } from './redis.ts';
import { PING_COUNT, PING_INTERVAL_SEC, PING_TARGETS, type PingSettings } from '../shared/index.ts';

/** 进程内设置缓存的有效期：修改时经 Redis 发布订阅通知各进程立即失效，平时不必频繁读数据库 */
const LOCAL_TTL = 60_000;
const SETTINGS_CHANNEL = 'paledove:settings-changed';

/** 设置被修改：清除各进程的本地缓存与 Redis 中的公开配置缓存 */
async function settingsChanged(key: string): Promise<void> {
  await Promise.all([publish(SETTINGS_CHANNEL, key), invalidateCache('settings', 'catalog')]);
}

export const DEFAULT_SETTINGS: SiteSettings = {
  siteName: 'PaleDove',
  allowRegister: true,
  requireEmailVerification: false,
  allowTickets: true,
  signupBonus: 0,
  emailDomainMode: 'OFF',
  emailDomains: [],
  currency: '¥',
  footer: '',
  requireDnsCheck: true,
  acmeEmail: '',
  graceDays: 3,
  autoRenewHours: 24,
  reinstallCooldownMinutes: 0,
  vpcLimit: 5,
  affEnabled: false,
  affRateNew: 8,
  affRateRenew: 3,
  affFreezeDays: 0,
  affMinWithdraw: 10,
  marketEnabled: false,
  marketFeeRate: 5,
  marketMinDays: 3,
  transferFeeMode: 'NONE',
  transferFeeValue: 0,
  avatarApiBase: DEFAULT_AVATAR_API,
  nodeSwitchFee: 0,
};

const SITE_KEY = 'site';
let cache: { value: SiteSettings; at: number } | null = null;

export async function getSettings(): Promise<SiteSettings> {
  if (cache && Date.now() - cache.at < LOCAL_TTL) return cache.value;
  const row = await prisma.setting.findUnique({ where: { key: SITE_KEY } });
  const stored = (row?.value as Record<string, unknown> | null) ?? {};
  // 只保留当前版本的设置项，旧版本存过的字段（如 panelUrl，现改由环境变量 PANEL_URL 配置）不再返回
  const value = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, k in stored ? stored[k] : v])) as unknown as SiteSettings;
  // 旧版本只有白名单：存过后缀列表但没有模式时按白名单处理
  if (!('emailDomainMode' in stored) && value.emailDomains.length) value.emailDomainMode = 'ALLOW';
  cache = { value, at: Date.now() };
  return value;
}

export async function updateSettings(patch: Partial<SiteSettings>): Promise<SiteSettings> {
  const current = await getSettings();
  const value = { ...current, ...patch };
  await prisma.setting.upsert({
    where: { key: SITE_KEY },
    create: { key: SITE_KEY, value: value as unknown as Prisma.InputJsonValue },
    update: { value: value as unknown as Prisma.InputJsonValue },
  });
  cache = { value, at: Date.now() };
  await settingsChanged(SITE_KEY);
  return value;
}

export async function getInternal<T>(key: string): Promise<T | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return (row?.value as T | undefined) ?? null;
}

export async function setInternal(key: string, value: unknown): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: value as Prisma.InputJsonValue },
    update: { value: value as Prisma.InputJsonValue },
  });
}

// ───────── 账号安全相关的设置（第三方登录、实名认证），带默认值，读取有 10 秒缓存 ─────────

/** 第三方登录：每个提供商在其开发者后台创建 OAuth 应用后，把 Client ID / Secret 填到这里 */
export interface OAuthProviderSettings {
  enabled: boolean;
  clientId: string;
  /** Client Secret（加密存储） */
  clientSecretEnc: string;
}
/** 通用 OAuth 2.0 / OIDC 提供商（授权码流程） */
export interface OAuthCustomProvider extends OAuthProviderSettings {
  /** 标识：用在回调地址和绑定记录里，创建后不能修改 */
  id: string;
  /** 显示名称（登录按钮、账号设置） */
  name: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  /** 令牌接口的客户端认证方式：post = 参数放在请求体，basic = HTTP Basic */
  tokenAuth: 'post' | 'basic';
  /** 用户信息里的字段（支持 a.b 嵌套）；邮箱字段可留空 */
  idField: string;
  emailField: string;
  nameField: string;
  /** 信任返回的邮箱：用它找到已有账号或注册新账号；关闭时只能在账号设置里绑定后登录 */
  trustEmail: boolean;
  /** 邮箱已验证的字段（如 email_verified），留空表示不检查 */
  emailVerifiedField: string;
  /** 自定义图标的版本（更新时间戳），0 / 缺省 = 没有图标；图片内容在 oauthIcons，不放这里（oauth 设置读得很频繁） */
  iconVersion?: number;
}
/** 购买实例前必须绑定的第三方账号：any = 绑定其中任意一个，all = 全部绑定 */
export interface OAuthRequirement {
  providers: string[];
  mode: 'any' | 'all';
}
export interface OAuthSettings {
  github: OAuthProviderSettings;
  google: OAuthProviderSettings;
  custom: OAuthCustomProvider[];
  require: OAuthRequirement;
}

/** 实名认证：通过支付宝开放平台「身份验证」产品（姓名 + 身份证号 + 支付宝刷脸）完成 */
export interface RealnameSettings {
  enabled: boolean;
  /** 支付宝开放平台应用 APPID */
  appId: string;
  /** 应用私钥（RSA2，加密存储） */
  privateKeyEnc: string;
  /** 支付宝公钥（不是应用公钥） */
  alipayPublicKey: string;
  gateway: string;
  /** 认证场景：FACE 快捷认证（刷脸）| CERT_PHOTO 证件照 | CERT_PHOTO_FACE 证件照 + 刷脸 | SMART_FACE 智能刷脸 */
  bizCode: 'FACE' | 'CERT_PHOTO' | 'CERT_PHOTO_FACE' | 'SMART_FACE';
}

const DEFAULT_DOCUMENT_CATEGORIES: DocumentCategoryDTO[] = [
  { id: 'general', name: '常规', order: 0 },
  { id: 'getting-started', name: '快速开始', order: 10 },
  { id: 'instances', name: '实例管理', order: 20 },
  { id: 'networking', name: '网络配置', order: 30 },
  { id: 'billing', name: '计费相关', order: 40 },
  { id: 'faq', name: '常见问题', order: 50 },
];

export const settingDefaults = {
  ping: { enabled: true, interval: PING_INTERVAL_SEC, count: PING_COUNT, targets: PING_TARGETS.map(target => ({ ...target, enabled: true })), nodeIds: null } as PingSettings,
  maintenance: { enabled: false, title: '系统维护中', message: '', scope: 'NOTICE', startAt: null, endAt: null, startedAt: null, updates: [], autoSchedule: false, previewHours: 24, allowEmails: [] } as MaintenanceSettings,
  legal: {
    terms: { content: '', updatedAt: '' }, privacy: { content: '', updatedAt: '' }, requireAgree: false,
    documents: [] as DocumentDTO[],
    categories: DEFAULT_DOCUMENT_CATEGORIES,
    categoryDefaultsVersion: 1,
    documentMeta: {} as Partial<Record<LegalKind, DocumentMetadata>>,
  },
  siteIcon: { mime: '', data: '', source: '', updatedAt: '' },
  mail: { enabled: false, host: '', port: 587, secure: false, user: '', passwordEnc: '', fromName: '', fromEmail: '' },
  oauth: {
    github: { enabled: false, clientId: '', clientSecretEnc: '' },
    google: { enabled: false, clientId: '', clientSecretEnc: '' },
    custom: [],
    require: { providers: [], mode: 'any' },
  } as OAuthSettings,
  /** 自定义登录方式的图标：提供商标识 → 图片 */
  oauthIcons: { icons: {} } as { icons: Record<string, { mime: string; data: string; source: string }> },
  realname: { enabled: false, appId: '', privateKeyEnc: '', alipayPublicKey: '', gateway: 'https://openapi.alipay.com/gateway.do', bizCode: 'FACE' } as RealnameSettings,
  /** 首页展示的交易市场商品：挂牌 ID 与展示截止时间（ISO） */
  marketFeatured: { listingId: 0, until: '' },
  popups: {
    notice: { enabled: false, title: '', content: '', revision: '' },
    promotion: { enabled: false, title: '', imageUrl: '', planId: null, revision: '' },
  } as import('../shared/index.ts').PopupSettings,
};

export type SettingKey = keyof typeof settingDefaults;
type SettingValue<K extends SettingKey> = (typeof settingDefaults)[K];

const settingCache = new Map<SettingKey, { value: unknown; at: number }>();

export async function getSetting<K extends SettingKey>(key: K, fresh = false): Promise<SettingValue<K>> {
  const hit = settingCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < LOCAL_TTL) return hit.value as SettingValue<K>;
  const stored = await getInternal<Partial<SettingValue<K>>>(key);
  const value = { ...settingDefaults[key], ...(stored ?? {}) } as SettingValue<K>;
  if (key === 'legal') {
    const legal = value as SettingValue<'legal'>;
    const previous = stored as Partial<SettingValue<'legal'>> | null;
    // Seed older installations once; saving the version lets later deletions remain deleted.
    if ((previous?.categoryDefaultsVersion ?? 0) < settingDefaults.legal.categoryDefaultsVersion) {
      const existing = legal.categories;
      legal.categories = [...existing, ...DEFAULT_DOCUMENT_CATEGORIES.filter(category => !existing.some(item => item.id === category.id || item.name.trim().toLowerCase() === category.name.toLowerCase()))];
      legal.categoryDefaultsVersion = settingDefaults.legal.categoryDefaultsVersion;
    }
  }
  settingCache.set(key, { value, at: Date.now() });
  return value;
}

/** 浅合并后保存 */
export async function setSetting<K extends SettingKey>(key: K, patch: Partial<SettingValue<K>>): Promise<SettingValue<K>> {
  const value = { ...(await getSetting(key)), ...patch } as SettingValue<K>;
  await setInternal(key, value);
  settingCache.set(key, { value, at: Date.now() });
  await settingsChanged(key);
  return value;
}

// 其他进程修改了设置：清除本进程缓存（本进程发出的消息也会收到，清除后下次重新读取，结果一致）
subscribe(SETTINGS_CHANNEL, (key) => {
  if (key === SITE_KEY) cache = null;
  else settingCache.delete(key as SettingKey);
});

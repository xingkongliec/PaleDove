import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { decrypt } from '../lib/crypto.ts';
import { AppError, badRequest } from '../lib/errors.ts';
import { prisma } from '../lib/prisma.ts';
import { getSetting, type OAuthCustomProvider, type OAuthSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';

/** 内置的提供商；其余由管理员添加的通用 OAuth 2.0 / OIDC 提供商（OAuthSettings.custom） */
export const BUILTIN_PROVIDERS = ['github', 'google'] as const;
export type BuiltinProvider = (typeof BUILTIN_PROVIDERS)[number];
const isBuiltin = (p: string): p is BuiltinProvider => (BUILTIN_PROVIDERS as readonly string[]).includes(p);
const BUILTIN_NAME: Record<BuiltinProvider, string> = { github: 'GitHub', google: 'Google' };

/** 自定义提供商的标识：出现在回调地址和绑定记录里，创建后不能修改；不能与路由里的固定路径重名 */
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const RESERVED_PROVIDER_IDS = new Set<string>([...BUILTIN_PROVIDERS, 'accounts', 'requirement', 'custom', 'discover']);

/** 提供商的端点；设置 OAUTH_MOCK_URL 时内置提供商全部指向该地址（仅用于联调 / 测试） */
function builtinEndpoints(p: BuiltinProvider) {
  const mock = process.env.OAUTH_MOCK_URL?.replace(/\/+$/, '');
  if (mock) return { authorize: `${mock}/${p}/authorize`, token: `${mock}/${p}/token`, user: `${mock}/${p}/user`, emails: `${mock}/${p}/emails` };
  if (p === 'github') {
    return {
      authorize: 'https://github.com/login/oauth/authorize',
      token: 'https://github.com/login/oauth/access_token',
      user: 'https://api.github.com/user',
      emails: 'https://api.github.com/user/emails',
    };
  }
  return {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    user: 'https://openidconnect.googleapis.com/v1/userinfo',
    emails: '',
  };
}

/** 回调地址：面板对外地址（PANEL_URL，未设置时按请求推断）+ 固定路径 */
export const callbackUrl = (base: string, p: string) => `${base}/api/auth/oauth/${p}/callback`;

export interface ProviderInfo {
  id: string;
  name: string;
  /** 已启用且配置完整，可以登录 / 绑定 */
  active: boolean;
  /** 自定义图标地址；null 时前端显示内置图标或名称首字 */
  icon: string | null;
}

/** 自定义图标的公开地址（带版本号，更换后浏览器缓存立即失效） */
export const oauthIconUrl = (c: Pick<OAuthCustomProvider, 'id' | 'iconVersion'>) => (c.iconVersion ? `/api/auth/oauth/${c.id}/icon?v=${c.iconVersion}` : null);

const customReady = (c: OAuthCustomProvider) => c.enabled && !!c.clientId && !!c.clientSecretEnc && !!c.authorizeUrl && !!c.tokenUrl && !!c.userinfoUrl;

/** 全部提供商（内置在前，按配置顺序） */
export function listProviders(o: OAuthSettings): ProviderInfo[] {
  return [
    ...BUILTIN_PROVIDERS.map((p) => ({ id: p, name: BUILTIN_NAME[p], active: o[p].enabled && !!o[p].clientId && !!o[p].clientSecretEnc, icon: null })),
    ...o.custom.map((c) => ({ id: c.id, name: c.name, active: customReady(c), icon: oauthIconUrl(c) })),
  ];
}

/** 登录页显示的提供商 */
export async function activeProviders(): Promise<Array<{ id: string; name: string; icon: string | null }>> {
  return listProviders(await getSetting('oauth'))
    .filter((p) => p.active)
    .map(({ id, name, icon }) => ({ id, name, icon }));
}

/** 显示名称；提供商已被删除时用标识代替 */
export async function providerName(id: string) {
  return listProviders(await getSetting('oauth')).find((p) => p.id === id)?.name ?? id;
}

/** 已启用的提供商；不存在或未启用时报错 */
async function resolve(p: string) {
  const o = await getSetting('oauth');
  const info = listProviders(o).find((x) => x.id === p);
  if (!info) throw badRequest(t('oauth.unsupported'));
  if (!info.active) throw badRequest(t('oauth.disabled', { name: info.name }));
  if (isBuiltin(p)) return { name: info.name, builtin: p, custom: null, clientId: o[p].clientId, clientSecret: decrypt(o[p].clientSecretEnc) };
  const c = o.custom.find((x) => x.id === p)!;
  return { name: info.name, builtin: null, custom: c, clientId: c.clientId, clientSecret: decrypt(c.clientSecretEnc) };
}

export async function authorizeUrl(base: string, p: string, state: string) {
  const r = await resolve(p);
  const url = new URL(r.custom ? r.custom.authorizeUrl : builtinEndpoints(r.builtin!).authorize);
  url.searchParams.set('client_id', r.clientId);
  url.searchParams.set('redirect_uri', callbackUrl(base, p));
  url.searchParams.set('state', state);
  url.searchParams.set('response_type', 'code');
  const scope = r.custom ? r.custom.scope : r.builtin === 'github' ? 'read:user user:email' : 'openid email profile';
  if (scope) url.searchParams.set('scope', scope);
  if (r.builtin === 'google') url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

export interface OAuthProfile {
  providerId: string;
  /** 邮箱；trustedEmail 为 false 时只用于显示，不用来匹配 / 注册账号 */
  email: string | null;
  name: string;
  /** 邮箱由提供商验证过，可以用来找到已有账号或注册新账号 */
  trustedEmail: boolean;
}

const json = async (res: Response) => (await res.json().catch(() => ({}))) as Record<string, any>;

/** 按“a.b.c”取嵌套字段 */
export function pick(obj: unknown, path: string): unknown {
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const truthy = (v: unknown) => v === true || v === 'true' || v === 1;

/** 用户信息 → 平台使用的资料（自定义提供商，字段名由管理员配置） */
export function customProfile(c: Pick<OAuthCustomProvider, 'name' | 'idField' | 'emailField' | 'nameField' | 'trustEmail' | 'emailVerifiedField'>, user: unknown): OAuthProfile {
  const id = pick(user, c.idField || 'sub');
  if (id == null || id === '' || typeof id === 'object') throw badRequest(t('oauth.noUserId', { name: c.name, field: c.idField || 'sub' }));
  const rawEmail = c.emailField ? pick(user, c.emailField) : undefined;
  const email = typeof rawEmail === 'string' && /^[^\s@]+@[^\s@]+$/.test(rawEmail.trim()) ? rawEmail.trim().toLowerCase() : null;
  const verified = !c.emailVerifiedField || truthy(pick(user, c.emailVerifiedField));
  const name = [c.nameField, 'name', 'preferred_username', 'username', 'login', 'nickname']
    .filter(Boolean)
    .map((f) => pick(user, f))
    .find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  return { providerId: String(id), email, name: (name ?? email ?? String(id)).trim(), trustedEmail: !!email && c.trustEmail && verified };
}

/** 令牌接口的响应可能是 JSON，也可能是表单格式 */
async function tokenBody(res: Response): Promise<Record<string, any>> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

/** 用授权码换取令牌并读取用户资料；内置提供商只接受已验证的邮箱 */
export async function fetchProfile(base: string, p: string, code: string): Promise<OAuthProfile> {
  const r = await resolve(p);
  const ep = r.custom ? { token: r.custom.tokenUrl, user: r.custom.userinfoUrl, emails: '' } : builtinEndpoints(r.builtin!);
  const form = new URLSearchParams({ code, redirect_uri: callbackUrl(base, p), grant_type: 'authorization_code' });
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' };
  if (r.custom?.tokenAuth === 'basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(r.clientId)}:${encodeURIComponent(r.clientSecret)}`).toString('base64')}`;
  } else {
    form.set('client_id', r.clientId);
    form.set('client_secret', r.clientSecret);
  }
  let tokenRes: Response;
  try {
    tokenRes = await fetch(ep.token, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw badRequest(t('oauth.connectFailed', { name: r.name, message: (e as Error).message }));
  }
  const token = await tokenBody(tokenRes);
  if (!tokenRes.ok || !token.access_token) throw badRequest(t('oauth.tokenFailed', { name: r.name, message: String(token.error_description ?? token.error ?? tokenRes.status) }));
  const auth = { authorization: `Bearer ${token.access_token}`, accept: 'application/json', 'user-agent': 'PaleDove' };

  const userRes = await fetch(ep.user, { headers: auth, signal: AbortSignal.timeout(15_000) });
  const user = await json(userRes);
  if (!userRes.ok) throw badRequest(t('oauth.profileFailed', { name: r.name, status: userRes.status }));

  if (r.custom) return customProfile(r.custom, user);
  if (r.builtin === 'google') {
    if (!user.sub || !user.email) throw badRequest(t('oauth.googleNoEmail'));
    if (user.email_verified !== true && user.email_verified !== 'true') throw badRequest(t('oauth.googleUnverified'));
    return { providerId: String(user.sub), email: String(user.email).toLowerCase(), name: String(user.name ?? user.email), trustedEmail: true };
  }
  // GitHub：用户信息里的邮箱可能为空或未验证，要从邮箱列表里取已验证的主邮箱
  let email: string | null = null;
  const emailsRes = await fetch(ep.emails, { headers: auth, signal: AbortSignal.timeout(15_000) });
  if (emailsRes.ok) {
    const list = (await emailsRes.json().catch(() => [])) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const verified = Array.isArray(list) ? list.filter((e) => e.verified) : [];
    email = (verified.find((e) => e.primary) ?? verified[0])?.email ?? null;
  }
  if (!user.id) throw badRequest(t('oauth.githubProfileFailed'));
  if (!email) throw badRequest(t('oauth.githubNoEmail'));
  return { providerId: String(user.id), email: email.toLowerCase(), name: String(user.name || user.login || email), trustedEmail: true };
}

/** OIDC 自动发现：读取 {issuer}/.well-known/openid-configuration（仅管理员使用） */
export async function discoverOidc(issuer: string) {
  const base = issuer.trim().replace(/\/+$/, '').replace(/\/\.well-known\/openid-configuration$/, '');
  if (!/^https?:\/\//i.test(base)) throw badRequest(t('oauth.issuerInvalid'));
  let res: Response;
  try {
    res = await fetch(`${base}/.well-known/openid-configuration`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw badRequest(t('oauth.issuerUnreachable', { url: base, message: (e as Error).message }));
  }
  const doc = await json(res);
  if (!res.ok || !doc.authorization_endpoint || !doc.token_endpoint) throw badRequest(t('oauth.issuerNoConfig', { status: res.status }));
  const methods = Array.isArray(doc.token_endpoint_auth_methods_supported) ? (doc.token_endpoint_auth_methods_supported as string[]) : [];
  return {
    authorizeUrl: String(doc.authorization_endpoint),
    tokenUrl: String(doc.token_endpoint),
    userinfoUrl: doc.userinfo_endpoint ? String(doc.userinfo_endpoint) : '',
    // 没有声明时按 OIDC 规范默认 client_secret_basic
    tokenAuth: methods.length && !methods.includes('client_secret_basic') && methods.includes('client_secret_post') ? ('post' as const) : ('basic' as const),
    scope: 'openid email profile',
  };
}

// ───────────── 绑定要求：必须绑定指定的第三方账号才能购买实例 ─────────────

export interface OAuthRequirementState {
  mode: 'any' | 'all';
  /** 生效的要求（只计已启用的提供商；为空表示没有要求） */
  required: Array<{ id: string; name: string }>;
  missing: Array<{ id: string; name: string }>;
  satisfied: boolean;
}

export async function oauthRequirement(userId: number): Promise<OAuthRequirementState> {
  const o = await getSetting('oauth');
  const { mode, providers } = o.require;
  // 停用的提供商用户无法绑定，不再作为要求
  const required = listProviders(o)
    .filter((p) => p.active && providers.includes(p.id))
    .map(({ id, name }) => ({ id, name }));
  if (!required.length) return { mode, required, missing: [], satisfied: true };
  const bound = new Set(
    (await prisma.oAuthAccount.findMany({ where: { userId, provider: { in: required.map((p) => p.id) } }, select: { provider: true } })).map((a) => a.provider),
  );
  const missing = required.filter((p) => !bound.has(p.id));
  return { mode, required, missing, satisfied: mode === 'all' ? !missing.length : missing.length < required.length };
}

export const requirementText = (r: Pick<OAuthRequirementState, 'mode' | 'missing'>) => r.missing.map((p) => p.name).join(r.mode === 'all' ? t('oauth.joinAll') : t('oauth.joinAny'));

/** 购买实例前检查；管理员不检查 */
export async function ensureOAuthBound(userId: number, actor?: { role?: string } | null) {
  if (actor?.role === 'ADMIN') return;
  const r = await oauthRequirement(userId);
  if (r.satisfied) return;
  throw new AppError(403, 'OAUTH_BIND_REQUIRED', t('oauth.bindRequired', { names: requirementText(r) }));
}

// ───────────── 流程状态（签名 Cookie，防 CSRF） ─────────────

export interface FlowState {
  state: string;
  provider: string;
  next: string;
  /** 绑定流程：已登录用户的 ID */
  link: number | null;
  /** 推广码：通过推广链接进入时带上，新注册的账号记录邀请人 */
  aff?: string;
  exp: number;
}

const sign = (body: string) => createHmac('sha256', config.APP_SECRET).update(`oauth:${body}`).digest('base64url');

export function packFlow(f: Omit<FlowState, 'exp'>): string {
  const body = Buffer.from(JSON.stringify({ ...f, exp: Date.now() + 10 * 60_000 })).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function unpackFlow(v: string | undefined): FlowState | null {
  if (!v) return null;
  const [body, sig] = v.split('.');
  if (!body || !sig) return null;
  const good = sign(body);
  if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  try {
    const f = JSON.parse(Buffer.from(body, 'base64url').toString()) as FlowState;
    return f.exp > Date.now() ? f : null;
  } catch {
    return null;
  }
}

/** 只允许站内相对路径，防止开放重定向 */
export const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !/[\\\u0000-\u0020\u007f]/.test(n) && n.length <= 512 ? n : '');

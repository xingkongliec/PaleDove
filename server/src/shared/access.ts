import type { Role } from './enums';

export const LEGACY_CONSOLE_PATHS = [
  '/dashboard', '/instances', '/vpc', '/billing', '/invoices', '/invite', '/account',
  '/terminal', '/docs/api', '/transfer', '/activity', '/notifications', '/tickets',
] as const;

/** 旧控制台页面的规范地址；只匹配完整路径段，不处理 API 与公开页面。 */
export function consoleRedirect(pathname: string): string | null {
  return LEGACY_CONSOLE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`)) ? `/console${pathname}` : null;
}

/** 登录后只能返回当前角色所属的后台。 */
export function loginLanding(role: Role, next?: string | null): string {
  const fallback = role === 'ADMIN' ? '/admin' : '/console/dashboard';
  if (!next?.startsWith('/') || next.startsWith('//') || /[\\\u0000-\u0020]/.test(next)) return fallback;
  try {
    const url = new URL(next, 'https://paledove.local');
    const path = decodeURIComponent(url.pathname);
    const adminPath = /^\/admin(?:\/|$)/.test(path);
    if (adminPath !== (role === 'ADMIN') || path === '/login' || path === '/verify-email') return fallback;
    return (consoleRedirect(url.pathname) ?? url.pathname) + url.search + url.hash;
  } catch {
    return fallback;
  }
}

/** 注册邮箱后缀规则：不限制 / 只允许列表中的后缀（白名单）/ 禁止列表中的后缀（黑名单，如一次性邮箱） */
export const EMAIL_DOMAIN_MODES = ['OFF', 'ALLOW', 'DENY'] as const;
export type EmailDomainMode = (typeof EMAIL_DOMAIN_MODES)[number];

/** 规范化邮箱后缀：小写，去掉开头的 @、*. 与点，去掉结尾的点（如 「@QQ.com」「*.edu.cn」「gmail.com.」） */
export const normalizeEmailDomain = (v: string): string =>
  v
    .trim()
    .toLowerCase()
    .replace(/^[@*.]+/, '')
    .replace(/\.+$/, '');

/** 邮箱地址的域名部分（小写，去掉结尾的点） */
export const emailDomainOf = (email: string): string => normalizeEmailDomain(email.trim().split('@').pop() ?? '');

/** 域名是否命中后缀：完全相同，或是它的子域名（edu.cn 命中 xxx.edu.cn） */
const domainMatches = (domain: string, suffix: string) => domain === suffix || domain.endsWith(`.${suffix}`);

/** 邮箱命中的后缀（没有命中为 null） */
export function matchedEmailDomain(email: string, domains: readonly string[]): string | null {
  const domain = emailDomainOf(email);
  return (domain && domains.find((d) => domainMatches(domain, d))) || null;
}

/**
 * 注册邮箱是否符合后缀规则：
 *  - OFF（或列表为空）：不限制；
 *  - ALLOW：只允许列表中的后缀（含子域名）；
 *  - DENY：禁止列表中的后缀（含子域名），其余都可以。
 */
export function emailDomainAllowed(email: string, rule: { mode: EmailDomainMode; domains: readonly string[] }): boolean {
  if (rule.mode === 'OFF' || !rule.domains.length) return true;
  const hit = matchedEmailDomain(email, rule.domains) !== null;
  return rule.mode === 'ALLOW' ? hit : !hit;
}

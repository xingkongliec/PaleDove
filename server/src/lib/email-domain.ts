import type { SiteSettings } from '../shared/index.ts';
import { t } from '../i18n/index.ts';

/** 注册邮箱后缀不符合规则时的提示：白名单列出可用后缀（最多 10 个），黑名单提示换用其他邮箱 */
export function emailDomainError(s: Pick<SiteSettings, 'emailDomainMode' | 'emailDomains'>): string {
  if (s.emailDomainMode === 'DENY') return t('auth.emailDomainBlocked');
  const shown = s.emailDomains.slice(0, 10).join('、');
  return t('auth.emailDomainNotAllowed', { domains: s.emailDomains.length > 10 ? `${shown} …` : shown });
}

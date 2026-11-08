import { prisma } from '../lib/prisma.ts';
import { getSetting, getSettings } from '../lib/settings.ts';
import { translate } from '../i18n/index.ts';
import { sendMail, isMailConfigured } from './mail/mailer.ts';
import { button, escLines, mailLocale, p, renderMail } from './mail/mail-template.ts';

export const visibleAnnouncements = () => ({ published: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });

/** 只通知启用公告邮件且已验证邮箱的有效账号；每次读取一批，避免遗漏用户。 */
export async function emailAnnouncement(a: { title: string; content: string }, baseUrl: string) {
  if (!isMailConfigured(await getSetting('mail'))) return;
  const site = await getSettings();
  const rendered = new Map<string, string>();
  let after = 0;
  for (;;) {
    const users = await prisma.user.findMany({ where: { id: { gt: after }, status: 'ACTIVE', announceEmail: true, emailVerifiedAt: { not: null } }, select: { id: true, email: true, locale: true, role: true }, orderBy: { id: 'asc' }, take: 200 });
    if (!users.length) return;
    for (const user of users) {
      const locale = mailLocale(user.locale);
      const key = `${locale}:${user.role}`;
      if (!rendered.has(key)) {
        const url = `${baseUrl.replace(/\/+$/, '')}${user.role === 'ADMIN' ? '/admin' : '/dashboard'}`;
        rendered.set(key, await renderMail({ title: a.title, preheader: a.content.slice(0, 120), body: p(escLines(a.content)) + button(url, translate(locale, 'announcement.view'), locale), footer: translate(locale, 'announcement.mailFooter'), locale, baseUrl }));
      }
      await sendMail(user.email, `【${site.siteName}】${a.title}`, rendered.get(key)!).catch((error) => console.error('announcement email failed', error));
    }
    after = users[users.length - 1]!.id;
  }
}

import nodemailer from 'nodemailer';
import { decrypt, randomToken, sha256 } from '../../lib/crypto.ts';
import { badRequest } from '../../lib/errors.ts';
import { prisma } from '../../lib/prisma.ts';
import { getSetting, getSettings } from '../../lib/settings.ts';
import { currentLocale, translate } from '../../i18n/index.ts';
import { button, esc, escLines, htmlToText, mailLocale, muted, p, renderMail } from './mail-template.ts';

export type MailSettings = Awaited<ReturnType<typeof getSetting<'mail'>>>;
export function isMailConfigured(mail: MailSettings) {
  return mail.enabled && !!mail.host && !!mail.fromEmail;
}

/** 测试时捕获邮件，避免连接外部 SMTP。 */
let capture: ((mail: { to: string; subject: string; html: string; text: string }) => void) | null = null;
export function setMailCapture(fn: typeof capture) { capture = fn; }

function createTransport(mail: MailSettings) {
  return nodemailer.createTransport({
    host: mail.host, port: mail.port, secure: mail.secure,
    auth: mail.user ? { user: mail.user, pass: mail.passwordEnc ? decrypt(mail.passwordEnc) : '' } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000,
  });
}

/** 测试发送前先校验连接和 SMTP 认证，保持与参考项目的流程一致。 */
export async function verifyMailConnection(mail: MailSettings): Promise<void> {
  if (capture) return;
  const transport = createTransport(mail);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
}

export async function sendMail(to: string, subject: string, html: string, override?: MailSettings) {
  const text = htmlToText(html);
  if (capture) { capture({ to, subject, html, text }); return true; }
  const mail = override ?? await getSetting('mail');
  if (!isMailConfigured(mail)) return false;
  const transport = createTransport(mail);
  try {
    await transport.sendMail({ from: { name: mail.fromName || (await getSettings()).siteName, address: mail.fromEmail }, to, subject, text, html });
    return true;
  } finally { transport.close(); }
}

export async function sendTestEmail(to: string, mail: MailSettings, baseUrl: string, locale?: string | null) {
  const site = await getSettings();
  const l = mailLocale(locale ?? currentLocale());
  const title = translate(l, 'mail.testTitle');
  const body = translate(l, 'mail.testBody');
  return sendMail(to, translate(l, 'mail.testSubject', { site: site.siteName }), await renderMail({
    title, preheader: body, body: p(esc(body)), locale: l, baseUrl,
  }), mail);
}

export async function sendResetEmail(user: { email: string; name?: string | null; username: string; locale?: string | null }, token: string, baseUrl: string) {
  const locale = mailLocale(user.locale ?? currentLocale());
  const site = await getSettings();
  const link = `${baseUrl.replace(/\/+$/, '')}/reset-password#token=${encodeURIComponent(token)}`;
  const title = translate(locale, 'mail.resetTitle');
  const body = p(esc(translate(locale, 'mail.hello', { name: user.name || user.username }))) + p(esc(translate(locale, 'mail.resetBody'))) + button(link, translate(locale, 'mail.resetButton'), locale) + muted(esc(translate(locale, 'mail.resetIgnore')));
  return sendMail(user.email, translate(locale, 'mail.resetSubject', { site: site.siteName }), await renderMail({ title, preheader: translate(locale, 'mail.resetBody'), body, locale, baseUrl }));
}

export async function sendTicketEmail(user: { email: string; locale?: string | null }, ticket: { id: number; subject: string }, content: string, forAdmin: boolean, baseUrl: string) {
  const locale = mailLocale(user.locale);
  const site = await getSettings();
  const excerpt = content.length > 500 ? content.slice(0, 500) + '…' : content;
  const title = translate(locale, 'mail.ticketTitle', { id: ticket.id + 10000, title: ticket.subject });
  const url = `${baseUrl.replace(/\/+$/, '')}/${forAdmin ? 'admin/tickets' : 'tickets'}/${ticket.id}`;
  const body = p(esc(translate(locale, forAdmin ? 'mail.ticketUserMessage' : 'mail.ticketReply'))) + `<blockquote style="margin:18px 0;padding:14px 18px;background:#f8fafc;border-left:3px solid #e5e8ef;font-size:14px;line-height:1.8">${escLines(excerpt)}</blockquote>` + button(url, translate(locale, 'mail.ticketButton'), locale);
  return sendMail(user.email, `【${site.siteName}】${title}`, await renderMail({ title, preheader: excerpt.slice(0, 120), body, locale, baseUrl }));
}

export async function sendVerification(user: { id: number; email: string; name?: string | null; username?: string; locale?: string | null }, baseUrl: string) {
  const token = randomToken(32);
  // 只保存令牌哈希；新链接取代之前未使用的链接。
  await prisma.$transaction(async (tx) => {
    await tx.emailVerificationToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await tx.emailVerificationToken.create({ data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 24 * 3600_000) } });
  });
  const site = await getSettings();
  const url = `${baseUrl.replace(/\/+$/, '')}/verify-email#token=${encodeURIComponent(token)}`;
  const l = mailLocale(user.locale ?? currentLocale());
  const body = p(esc(translate(l, 'mail.hello', { name: user.name || user.username || user.email })))
    + p(esc(translate(l, 'mail.verifyIntro', { site: site.siteName })))
    + button(url, translate(l, 'mail.verifyButton'), l)
    + muted(esc(translate(l, 'mail.verifyIgnore')));
  return sendMail(user.email, translate(l, 'mail.verifySubject', { site: site.siteName }), await renderMail({
    title: translate(l, 'mail.verifyTitle'), preheader: translate(l, 'mail.verifyPreheader'), body, locale: l, baseUrl,
  }));
}

export async function verifyEmailToken(token: string) {
  return prisma.$transaction(async (tx) => {
    const hash = sha256(token);
    const row = await tx.emailVerificationToken.findUnique({ where: { tokenHash: hash } });
    if (!row || row.usedAt || row.expiresAt <= new Date()) throw badRequest(translate(currentLocale(), 'auth.verifyExpired'));
    const used = await tx.emailVerificationToken.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
    if (!used.count) throw badRequest(translate(currentLocale(), 'auth.verifyExpired'));
    await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } });
  });
}

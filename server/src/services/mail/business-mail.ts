import { config } from '../../config.ts';
import { prisma } from '../../lib/prisma.ts';
import { redis } from '../../lib/redis.ts';
import { getSettings, getSetting } from '../../lib/settings.ts';
import { translate } from '../../i18n/index.ts';
import { button, esc, escLines, mailLocale, muted, p, renderMail } from './mail-template.ts';
import { isMailConfigured, sendMail } from './mailer.ts';
import { renewalPrice } from '../coupons.ts';

export type BusinessEvent = 'lowBalance' | 'expiring' | 'expired' | 'released' | 'traffic' | 'renewed';

/** 通知失败或邮件关闭时不记为已发送；周期性检查可在下次重试。 */
export async function sendBusinessNotice(userId: number, event: BusinessEvent, vars: Record<string, string | number>, dedupe: string, ttl = 7 * 86400): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'USER' || user.status !== 'ACTIVE' || !user.emailVerifiedAt || !(event === 'lowBalance' ? user.balanceAlert : user.alertEmail) || !isMailConfigured(await getSetting('mail'))) return false;
  const key = `mail-notice:${userId}:${event}:${dedupe}`;
  if (!(await redis.set(key, '1', 'EX', ttl, 'NX'))) return false;
  try {
    const site = await getSettings(), locale = mailLocale(user.locale);
    const title = translate(locale, `mail.${event}Title`);
    const text = translate(locale, `mail.${event}Body`, vars);
    const baseUrl = config.PANEL_URL ?? '';
    const body = p(esc(translate(locale, 'mail.hello', { name: user.name || user.username }))) + p(esc(text)) + (baseUrl ? button(`${baseUrl}/billing`, translate(locale, 'mail.billingButton'), locale) : '');
    const sent = await sendMail(user.email, `【${site.siteName}】${title}`, await renderMail({ title, preheader: text, body, footer: translate(locale, 'mail.businessOff'), locale, baseUrl }));
    if (!sent) await redis.del(key);
    return sent;
  } catch (error) { await redis.del(key); throw error; }
}

// ───────── 管理员通知邮件 ─────────

const QUEUE_KEY = 'mail:queue';
/** 发送失败时最多重试的次数（每次重新排到队尾） */
const MAX_ATTEMPTS = 3;

interface QueuedMail {
  to: string;
  subject: string;
  html: string;
  attempts: number;
}

/** 管理员发给用户的通知邮件：标题、正文与相关实例，附「查看通知」按钮 */
export async function renderNoticeMail(user: { name: string | null; username: string; locale: string | null }, title: string, content: string, related: string) {
  const site = await getSettings(), locale = mailLocale(user.locale);
  const baseUrl = config.PANEL_URL ?? '';
  const body =
    p(esc(translate(locale, 'mail.hello', { name: user.name || user.username }))) +
    p(escLines(content)) +
    muted(esc(related)) +
    (baseUrl ? button(`${baseUrl}/notifications`, translate(locale, 'mail.noticeButton'), locale) : '');
  return { subject: `【${site.siteName}】${title}`, html: await renderMail({ title, preheader: content.slice(0, 120), body, locale, baseUrl }) };
}

/** 加入发送队列：由定时任务每分钟发送 1 封，避免短时间内集中发信 */
export async function queueMail(to: string, subject: string, html: string): Promise<void> {
  await redis.rpush(QUEUE_KEY, JSON.stringify({ to, subject, html, attempts: 0 } satisfies QueuedMail));
}

export const mailQueueLength = () => redis.llen(QUEUE_KEY);

/** 定时任务：从队列取出 1 封发送；失败的放回队尾重试，超过次数后丢弃 */
export async function sendQueuedMail(log: { warn: (text: string) => void }): Promise<void> {
  const raw = await redis.lpop(QUEUE_KEY);
  if (!raw) return;
  const mail = JSON.parse(raw) as QueuedMail;
  try {
    if (!(await sendMail(mail.to, mail.subject, mail.html))) log.warn(`queued mail to ${mail.to} skipped: mail is not configured`);
  } catch (error) {
    if (mail.attempts + 1 < MAX_ATTEMPTS) await redis.rpush(QUEUE_KEY, JSON.stringify({ ...mail, attempts: mail.attempts + 1 }));
    log.warn(`queued mail to ${mail.to} failed (attempt ${mail.attempts + 1}): ${String(error)}`);
  }
}

/** 在到期前七天提醒，每个续费周期一次；自动续费余额不足每个账号每日一次。 */
export async function runBusinessMailChecks(log: { warn: (text: string) => void }) {
  if (!isMailConfigured(await getSetting('mail'))) return;
  const site = await getSettings();
  const now = new Date(), soon = new Date(now.getTime() + 7 * 86400_000);
  const rows = await prisma.instance.findMany({ where: { expiresAt: { gt: now, lte: soon }, status: { in: ['RUNNING', 'STOPPED', 'SUSPENDED', 'ERROR'] }, provisionedAt: { not: null } }, include: { user: { select: { balance: true } }, coupon: true } });
  for (const inst of rows) {
    // 续费价格按绑定的循环抵扣优惠码计算
    const price = renewalPrice(inst);
    const vars = { name: inst.hostname, time: inst.expiresAt.toISOString(), balance: `${site.currency}${inst.user.balance.toFixed(2)}`, price: `${site.currency}${price.toFixed(2)}` };
    try {
      await sendBusinessNotice(inst.userId, 'expiring', vars, `${inst.id}:${inst.expiresAt.toISOString()}`);
      if (inst.autoRenew && inst.expiresAt.getTime() - now.getTime() <= site.autoRenewHours * 3600_000 && inst.user.balance.lt(price)) await sendBusinessNotice(inst.userId, 'lowBalance', vars, 'renewal', 86400);
    } catch (error) { log.warn(`business email failed for #${inst.id}: ${String(error)}`); }
  }
}

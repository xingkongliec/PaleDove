// 实名认证：中国大陆居民身份证（18 位，含港澳台居民居住证）格式与校验码校验、脱敏、防重复使用的摘要。
// 只校验格式，“姓名与证件号属于同一个真人”由支付宝刷脸核验（services/alipay-certify.ts）。
import { createHmac } from 'node:crypto';
import { config } from '../../config.ts';
import { prisma } from '../../lib/prisma.ts';
import { t } from '../../i18n/index.ts';

const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const CHECK = '10X98765432';

/** 校验 18 位身份证号：地区码首位、出生日期、末位校验码；返回错误信息，合法时返回 null */
export function idNumberError(raw: string, now = new Date()): string | null {
  const id = raw.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return t('realname.idFormat');
  if (!/^[1-8]/.test(id)) return t('realname.idRegion');
  const y = Number(id.slice(6, 10));
  const m = Number(id.slice(10, 12));
  const d = Number(id.slice(12, 14));
  const birth = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || birth.getUTCFullYear() !== y || birth.getUTCMonth() !== m - 1 || birth.getUTCDate() !== d || birth > now) return t('realname.idBirth');
  const sum = WEIGHTS.reduce((s, w, i) => s + w * Number(id[i]), 0);
  if (CHECK[sum % 11] !== id[17]) return t('realname.idChecksum');
  return null;
}

/** 姓名：2-20 个汉字（可含少数民族姓名的间隔号），或 2-50 位英文姓名 */
export function realNameError(raw: string): string | null {
  const n = raw.trim();
  if (/^[一-龥]+([·•][一-龥]+)*$/.test(n) && n.replace(/[·•]/g, '').length >= 2 && n.length <= 20) return null;
  if (/^[A-Za-z][A-Za-z .'-]{1,49}$/.test(n)) return null;
  return t('realname.nameInvalid');
}

export const normalizeId = (id: string) => id.trim().toUpperCase();

/** 张三 → 张*；欧阳娜娜 → 欧**娜 */
export function maskName(name: string) {
  const c = [...name.trim()];
  if (c.length <= 2) return `${c[0]}*`;
  return `${c[0]}${'*'.repeat(c.length - 2)}${c[c.length - 1]}`;
}
/** 110101199003071234 → 110***********1234 */
export const maskId = (id: string) => `${id.slice(0, 3)}${'*'.repeat(id.length - 7)}${id.slice(-4)}`;

/** 证件号摘要（HMAC，密钥来自 APP_SECRET）：判断同一证件是否已被其他账号使用，不能还原证件号 */
export const idNumberHash = (id: string) => createHmac('sha256', `realname:${config.APP_SECRET}`).update(normalizeId(id)).digest('hex');

export async function isRealNameApproved(userId: number) {
  const v = await prisma.realNameVerification.findUnique({ where: { userId }, select: { status: true } });
  return v?.status === 'APPROVED';
}

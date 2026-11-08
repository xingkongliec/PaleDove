import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { config } from '../config.ts';

// 密钥派生的盐值沿用项目改名前的取值：改动会导致已加密的数据（面板证书私钥、支付密钥、实例密码等）无法解密
const KEY_SALT = 'inculark';
const encKey = Buffer.from(hkdfSync('sha256', config.APP_SECRET, KEY_SALT, 'secret-encryption', 32));

/** AES-256-GCM 加密，用于保存实例密码、私钥等敏感数据 */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(payload: string): string {
  const [ver, iv, tag, ct] = payload.split(':');
  if (ver !== 'v1' || !iv || !tag || !ct) throw new Error('decrypt failed: malformed payload');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(hashed: string, password: string): Promise<boolean> {
  try {
    return await verify(hashed, password);
  } catch {
    return false;
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';

/** 生成包含大小写字母与数字的随机密码（排除易混淆字符） */
export function generatePassword(length = 16): string {
  const all = LOWER + UPPER + DIGITS;
  const chars = [
    LOWER[randomInt(LOWER.length)],
    UPPER[randomInt(UPPER.length)],
    DIGITS[randomInt(DIGITS.length)],
  ];
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 生成小写字母 + 数字的随机 ID */
export function randomId(length = 10): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** 随机 MAC 地址（使用 Incus 的 00:16:3e 前缀） */
export function randomMac(): string {
  const b = randomBytes(3);
  return ['00', '16', '3e', ...[...b].map((x) => x.toString(16).padStart(2, '0'))].join(':');
}

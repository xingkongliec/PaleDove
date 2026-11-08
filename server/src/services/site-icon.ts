// 第三方登录的自定义图标：管理员填写图片链接，服务端下载一次并保存（不让浏览器直接加载外部链接：
// 不需要放宽 CSP、原链接失效也不受影响、不会把访客 IP 暴露给第三方）。
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { t } from '../i18n/index.ts';

export const ICON_MAX_BYTES = 512 * 1024;
export const siteIconUrl = (icon: { data: string; updatedAt: string }) => icon.data ? `/api/site/icon?v=${Date.parse(icon.updatedAt) || 0}` : null;

// ───────────── 防止 SSRF：图片链接由管理员填写，不能让服务器去访问内网 ─────────────

const PRIVATE = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

export class BlockedHostError extends Error {}

/** 目标主机解析到的所有地址都必须是公网地址 */
export async function assertPublicHost(hostname: string) {
  const name = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.internal') || name.endsWith('.local')) throw new BlockedHostError();
  const addrs = isIP(name) ? [{ address: name, family: isIP(name) }] : await lookup(name, { all: true });
  for (const a of addrs) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a.address)?.[1];
    if (mapped ? PRIVATE.check(mapped, 'ipv4') : PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) throw new BlockedHostError();
  }
}

/** 只允许 http(s)，手动跟随重定向（最多 3 次），每一跳都检查目标地址 */
export async function safeFetch(input: string | URL, init: RequestInit = {}) {
  let url = new URL(input);
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new BlockedHostError();
    await assertPublicHost(url.hostname);
    const res = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return res;
    url = new URL(loc, url);
  }
  throw new Error(t('icon.tooManyRedirects'));
}

/** 按文件头判断真实类型（不信任对方返回的 Content-Type） */
export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'image/x-icon';
  // SVG：文本开头（允许 BOM、XML 声明、注释、DOCTYPE）后是 <svg
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'image/svg+xml';
  return null;
}

/** 下载图标：只允许 http(s) 公网地址（safeFetch 逐跳检查重定向目标），限制大小，校验确实是图片 */
export async function downloadIcon(raw: string, max = ICON_MAX_BYTES) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(t('icon.badUrl'));
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(t('icon.httpOnly'));
  let res: Response;
  try {
    res = await safeFetch(url, { headers: { accept: 'image/*' } });
  } catch (e) {
    throw new Error(e instanceof BlockedHostError ? t('icon.privateHost') : t('icon.downloadFailed', { message: (e as Error).message }));
  }
  if (!res.ok) throw new Error(t('icon.downloadFailed', { message: `HTTP ${res.status}` }));
  if (Number(res.headers.get('content-length') ?? 0) > max) throw new Error(t('icon.tooLarge', { kb: max / 1024 }));
  // 边读边计数，不完全相信 Content-Length
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new Error(t('icon.downloadFailed', { message: 'empty body' }));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error(t('icon.tooLarge', { kb: max / 1024 }));
    }
    chunks.push(Buffer.from(value));
  }
  const buf = Buffer.concat(chunks);
  const mime = sniffImage(buf);
  if (!mime) throw new Error(t('icon.notImage'));
  return { mime, data: buf.toString('base64'), source: url.toString() };
}

/** 管理员上传的图片（base64）：同样限制大小、按文件头校验类型 */
export function decodeIcon(base64: string, max = ICON_MAX_BYTES) {
  const buf = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64');
  if (!buf.length) throw new Error(t('icon.empty'));
  if (buf.length > max) throw new Error(t('icon.tooLarge', { kb: max / 1024 }));
  const mime = sniffImage(buf);
  if (!mime) throw new Error(t('icon.notImage'));
  return { mime, data: buf.toString('base64'), source: '' };
}

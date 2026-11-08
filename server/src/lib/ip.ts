/** IP 地址工具函数 */
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { t } from '../i18n/index.ts';

export function isIPv4(ip: string): boolean {
  const parts = ip.split('.');
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && (p === '0' || !p.startsWith('0')))
  );
}

export function ipToInt(ip: string): number {
  if (!isIPv4(ip)) throw new Error(t('ip.invalid', { ip }));
  return ip.split('.').reduce((acc, p) => acc * 256 + Number(p), 0);
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export interface Cidr {
  /** 接口地址（如 10.0.0.1） */
  address: string;
  prefix: number;
  network: number;
  broadcast: number;
}

export function parseCidr(cidr: string): Cidr {
  const [address, prefixStr] = cidr.trim().split('/');
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) throw new Error(t('ip.invalidPrefix', { value: cidr }));
  const ip = ipToInt(address);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { address, prefix, network, broadcast };
}

export function cidrContains(cidr: string, ip: string): boolean {
  const c = parseCidr(cidr);
  const n = ipToInt(ip);
  return n >= c.network && n <= c.broadcast;
}

/**
 * 展开 IP 列表输入，支持：
 *  - 单个地址 203.0.113.5
 *  - CIDR 203.0.113.0/29（排除网络地址与广播地址，/31 /32 例外）
 *  - 区间 203.0.113.10-203.0.113.20 或 203.0.113.10-20
 */
export function expandIpInput(input: string, max = 4096): string[] {
  const result: string[] = [];
  const pushRange = (start: number, end: number, label: string) => {
    if (end < start) throw new Error(t('ip.invalidRange', { value: label }));
    // 先校验数量再展开，避免超大网段占满内存
    if (result.length + (end - start + 1) > max) throw new Error(t('ip.tooMany', { max }));
    for (let n = start; n <= end; n++) result.push(intToIp(n));
  };
  for (const raw of input.split(/[\s,;]+/)) {
    const item = raw.trim();
    if (!item) continue;
    if (item.includes('/')) {
      const c = parseCidr(item);
      const usable = c.prefix < 31;
      pushRange(usable ? c.network + 1 : c.network, usable ? c.broadcast - 1 : c.broadcast, item);
    } else if (item.includes('-')) {
      const [a, b] = item.split('-');
      const start = ipToInt(a);
      const end = b.includes('.') ? ipToInt(b) : ipToInt(a.split('.').slice(0, 3).join('.') + '.' + b);
      pushRange(start, end, item);
    } else {
      pushRange(ipToInt(item), ipToInt(item), item);
    }
  }
  return [...new Set(result)];
}

/** 在子网中分配一个未被占用的地址（跳过网关、网络地址、广播地址以及前 9 个保留地址） */
export function allocateFromCidr(cidr: string, used: Set<string>, reserveHead = 10): string | null {
  const c = parseCidr(cidr);
  const gateway = ipToInt(c.address);
  // 优先使用子网后半段，降低与 DHCP 动态分配冲突的概率
  for (let n = c.broadcast - 1; n > c.network + reserveHead; n--) {
    if (n === gateway) continue;
    const ip = intToIp(n);
    if (!used.has(ip)) return ip;
  }
  return null;
}

// ───────── IPv6 ─────────

export interface Ipv6Cidr {
  network: bigint;
  prefix: number;
}

/** IPv6 地址转为 128 位整数；不支持内嵌 IPv4 写法 */
export function ipv6ToBigInt(ip: string): bigint {
  if (isIP(ip) !== 6 || ip.includes('.')) throw new Error(t('ip.badIpv6', { ip }));
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const tl = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array<string>(8 - h.length - tl.length).fill('0'), ...tl] : h;
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** 128 位整数转为压缩格式的 IPv6 地址 */
export function bigIntToIpv6(n: bigint): string {
  const groups = Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16));
  // 交给 URL 解析器做标准压缩（RFC 5952）
  return new URL(`http://[${groups.join(':')}]`).hostname.slice(1, -1);
}

/** 解析 IPv6 子网，网络地址按前缀对齐，例如 2001:db8::5/64 → 2001:db8::/64 */
export function parseIpv6Cidr(cidr: string): Ipv6Cidr {
  const m = /^([0-9a-fA-F:]+)\/(\d{1,3})$/.exec(cidr.trim());
  const prefix = m ? Number(m[2]) : NaN;
  if (!m || !(prefix >= 1 && prefix <= 128)) throw new Error(t('ip.badIpv6Cidr', { cidr }));
  const mask = prefix === 0 ? 0n : ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - prefix)) - 1n);
  return { network: ipv6ToBigInt(m[1]) & mask, prefix };
}

export function formatIpv6Cidr(c: Ipv6Cidr): string {
  return `${bigIntToIpv6(c.network)}/${c.prefix}`;
}

/** 在 IPv6 子网中随机分配一个未占用的地址（跳过网络地址与 ::1，通常为网关） */
export function allocateIpv6(cidr: string, used: Set<string>): string | null {
  const c = parseIpv6Cidr(cidr);
  const hostBits = 128 - c.prefix;
  if (hostBits < 2) return null;
  const size = 1n << BigInt(hostBits);
  for (let i = 0; i < 64; i++) {
    const offset = BigInt(`0x${randomBytes(16).toString('hex')}`) % (size - 2n) + 2n;
    const ip = bigIntToIpv6(c.network + offset);
    if (!used.has(ip)) return ip;
  }
  return null;
}

/** 分配不与已有地址 / 网段重叠的子网；按区间跳跃，避免遍历整个 IPv6 空间。 */
export function allocateIpv6Prefix(cidr: string, prefix: number, used: string[]): string | null {
  const pool = parseIpv6Cidr(cidr);
  if (!Number.isInteger(prefix) || prefix < pool.prefix || prefix > 128) return null;
  const size = 1n << BigInt(128 - prefix);
  const end = pool.network + (1n << BigInt(128 - pool.prefix));
  const ranges = used.map((v) => parseIpv6Cidr(v.includes('/') ? v : `${v}/128`))
    .map((v) => ({ start: v.network, end: v.network + (1n << BigInt(128 - v.prefix)) }))
    .filter((v) => v.end > pool.network && v.start < end)
    .sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
  // 保留首个子网，避免占用宿主机和上游网关所在段。
  let start = pool.network + (prefix === 128 ? 2n : size);
  for (const range of ranges) {
    if (start + size <= range.start) break;
    if (start < range.end) start = pool.network + ((range.end - pool.network + size - 1n) / size) * size;
  }
  return start + size <= end ? `${bigIntToIpv6(start)}/${prefix}` : null;
}

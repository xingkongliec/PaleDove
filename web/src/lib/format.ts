import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime.js';
import { getLocale, t } from '@/i18n';

dayjs.extend(relativeTime);

export { dayjs };

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 字节数格式化（1024 进制） */
/** 部分隐藏 IP：IPv4 保留前两段（5.231.*.*），IPv6 保留前两组（2001:db8:*） */
export function maskIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:*`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : ip;
}

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${+v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

/** 速率格式化：bytes/s → bit/s */
export function formatRate(bytesPerSec: number, digits = 1): string {
  const bits = bytesPerSec * 8;
  const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(digits));
  if (bits < 1000) return `${Math.round(bits)} bps`;
  if (bits < 1e6) return `${fmt(bits / 1e3)} Kbps`;
  if (bits < 1e9) return `${fmt(bits / 1e6)} Mbps`;
  return `${(bits / 1e9).toFixed(2)} Gbps`;
}

export function formatMemory(mib: number): string {
  return mib >= 1024 ? `${+(mib / 1024).toFixed(1)} GB` : `${mib} MB`;
}

export function formatBandwidth(mbps: number): string {
  if (mbps <= 0) return t('common.unlimited');
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)} Gbps` : `${mbps} Mbps`;
}

export function formatTraffic(gb: number): string {
  if (gb <= 0) return t('common.unlimited');
  return gb >= 1024 ? `${+(gb / 1024).toFixed(1)} TB` : `${gb} GB`;
}

export function formatCores(n: number): string {
  return t('fmt.cores', { n });
}

export function formatDate(d: string | Date | null | undefined, fmt = 'YYYY-MM-DD HH:mm'): string {
  if (!d) return '—';
  return dayjs(d).format(fmt);
}

export function fromNow(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return dayjs(d).fromNow();
}

export function daysLeft(d: string | Date): number {
  return Math.ceil(dayjs(d).diff(dayjs(), 'hour') / 24);
}

export function daysLeftText(d: string | Date): string {
  const n = daysLeft(d);
  return n <= 0 ? t('fmt.expired') : t('fmt.daysLeft', { n });
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function moneyFormat(): Intl.NumberFormat {
  const locale = getLocale();
  let f = numberFormats.get(locale);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    numberFormats.set(locale, f);
  }
  return f;
}

/** 金额：-¥5.00 / ¥1,280.00 */
export function formatMoney(amount: string | number, currency = '¥'): string {
  const n = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  return `${sign}${currency}${moneyFormat().format(Math.abs(n))}`;
}

/** 套餐价格：0 显示为「免费」 */
export function formatPrice(amount: string | number, currency = '¥'): string {
  return Number(amount) === 0 ? t('common.priceFree') : formatMoney(amount, currency);
}

export function percent(used: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

/** 紧凑数字：1,284 / 12.9K */
export function compact(n: number): string {
  return new Intl.NumberFormat(getLocale(), { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** 时长（秒） */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return t('fmt.seconds', { s: seconds });
  return t('fmt.minSec', { m: Math.floor(seconds / 60), s: seconds % 60 });
}

/** 较长的时长（秒）：“3 天 4 小时” / “2 小时 5 分” / “5 分钟” */
export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return t('fmt.dayHour', { d, h });
  if (h > 0) return t('fmt.hourMin', { h, m });
  return t('fmt.minutes', { m });
}

/** 月数 → “3 个月” / “1 年” */
export function monthsLabel(months: number): string {
  return months % 12 === 0 ? t('fmt.years', { n: months / 12 }) : t('fmt.months', { n: months });
}

/** 复制到剪贴板，成功返回 true（不支持或被拒绝时返回 false） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

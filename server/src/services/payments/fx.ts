// 实时汇率：1 元人民币折合多少外币。Stripe / Heleket 渠道的计价货币不是 CNY 时，按它换算实际收取的金额。
// 数据源 open.er-api.com（免密钥，每日更新），失败时用 frankfurter（欧洲央行数据）；缓存 1 小时，
// 两个都取不到时沿用 24 小时内的上一次结果。
import { redis } from '../../lib/redis.ts';
import { t } from '../../i18n/index.ts';

const KEY = 'fx:CNY';
const FRESH_MS = 3600_000;
const STALE_MS = 24 * 3600_000;

type Rates = { at: number; rates: Record<string, number> };

async function getJson(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as Record<string, any>;
}

const SOURCES: Array<() => Promise<Record<string, number>>> = [
  async () => {
    const r = await getJson('https://open.er-api.com/v6/latest/CNY');
    if (r.result !== 'success' || !r.rates) throw new Error(r['error-type'] ?? 'bad response');
    return r.rates;
  },
  async () => {
    const r = await getJson('https://api.frankfurter.app/latest?from=CNY');
    if (!r.rates) throw new Error('bad response');
    return r.rates;
  },
];

async function readCache(): Promise<Rates | null> {
  const raw = await redis.get(KEY).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Rates;
  } catch {
    return null;
  }
}

let refreshing: Promise<Rates> | null = null;

/** 重新拉取汇率（同时只发一次），成功后写缓存 */
function refresh(): Promise<Rates> {
  refreshing ??= (async () => {
    const errors: string[] = [];
    try {
      for (const source of SOURCES) {
        try {
          const rates = await source();
          const value = { at: Date.now(), rates: { ...rates, CNY: 1 } };
          await redis.set(KEY, JSON.stringify(value), 'PX', STALE_MS);
          return value;
        } catch (e) {
          errors.push((e as Error).message);
        }
      }
      throw new Error(t('pay.fxFailed', { message: errors.join('; ') }));
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

const pick = (r: Rates, currency: string) => {
  const v = r.rates[currency.toUpperCase()];
  if (!v || !(v > 0)) throw new Error(t('pay.fxMissing', { currency: currency.toUpperCase() }));
  return v;
};

/** 1 元人民币 = 多少 currency（下单时用：缓存过期就重新获取，取不到时用 24 小时内的旧值） */
export async function cnyRate(currency: string): Promise<number> {
  if (currency.toUpperCase() === 'CNY') return 1;
  const hit = await readCache();
  if (hit && Date.now() - hit.at < FRESH_MS) return pick(hit, currency);
  try {
    return pick(await refresh(), currency);
  } catch (e) {
    if (hit) return pick(hit, currency);
    throw e;
  }
}

/** 只读缓存、不等待网络（给前端显示“约合”用）；缓存过期时在后台刷新 */
export async function peekCnyRate(currency: string): Promise<number | null> {
  if (currency.toUpperCase() === 'CNY') return 1;
  const hit = await readCache();
  if (!hit || Date.now() - hit.at >= FRESH_MS) refresh().catch(() => undefined);
  if (!hit) return null;
  try {
    return pick(hit, currency);
  } catch {
    return null;
  }
}

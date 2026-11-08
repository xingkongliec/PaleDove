// Stripe Checkout（直接调用 REST 接口，不引入 SDK）：创建收银台会话、查询会话、校验 Webhook 签名。
// 文档：https://docs.stripe.com/api/checkout/sessions 、https://docs.stripe.com/webhooks#verify-manually
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ZERO_DECIMAL_CURRENCIES } from '../../shared/index.ts';
import { t } from '../../i18n/index.ts';

const API = 'https://api.stripe.com/v1';

export const stripeDecimals = (currency: string) => (ZERO_DECIMAL_CURRENCIES.includes(currency.toUpperCase()) ? 0 : 2);

/** 嵌套参数 → application/x-www-form-urlencoded（a[b][0][c]=1） */
export function stripeForm(obj: Record<string, unknown>, prefix = ''): URLSearchParams {
  const out = new URLSearchParams();
  const walk = (v: unknown, key: string) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${key}[${i}]`));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, key ? `${key}[${k}]` : k);
    else out.append(key, String(v));
  };
  walk(obj, prefix);
  return out;
}

export interface StripeSession {
  id: string;
  url: string | null;
  status: string | null;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  client_reference_id: string | null;
  payment_intent: string | null;
}

async function call<T>(secretKey: string, method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !json) throw new Error(t('pay.stripeError', { message: json?.error?.message ?? `HTTP ${res.status}` }));
  return json;
}

export class StripeClient {
  constructor(private secretKey: string) {}

  /** 创建一次性付款的收银台会话，返回会话 ID 和收银台地址 */
  async createCheckout(o: { outTradeNo: string; name: string; currency: string; minorAmount: number; successUrl: string; cancelUrl: string; email?: string }) {
    const s = await call<StripeSession>(
      this.secretKey,
      'POST',
      '/checkout/sessions',
      stripeForm({
        mode: 'payment',
        client_reference_id: o.outTradeNo,
        metadata: { payment_no: o.outTradeNo },
        success_url: o.successUrl,
        cancel_url: o.cancelUrl,
        customer_email: o.email,
        // 收银台 30 分钟有效（Stripe 允许 30 分钟 ~ 24 小时）
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60 + 60,
        line_items: [{ quantity: 1, price_data: { currency: o.currency.toLowerCase(), unit_amount: o.minorAmount, product_data: { name: o.name } } }],
      }),
    );
    if (!s.url) throw new Error(t('pay.stripeNoUrl'));
    return { id: s.id, url: s.url };
  }

  retrieveSession(id: string) {
    return call<StripeSession>(this.secretKey, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);
  }
}

/**
 * 校验 Webhook：Stripe-Signature 头 t=时间戳,v1=签名（可能有多个 v1），签名 = HMAC-SHA256(密钥, `${t}.${原始请求体}`) 的十六进制。
 * 时间戳超过 tolerance 秒视为重放。通过后返回解析好的事件
 */
export function verifyStripeWebhook(rawBody: string, header: string | undefined, secret: string, toleranceSec = 300, now = Date.now()) {
  if (!header) throw new Error('missing Stripe-Signature');
  const parts = header.split(',').map((p) => p.trim().split('='));
  const ts = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!ts || !sigs.length) throw new Error('malformed Stripe-Signature');
  if (Math.abs(now / 1000 - Number(ts)) > toleranceSec) throw new Error('Stripe event expired');
  const want = Buffer.from(createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex'));
  const match = (s: string) => {
    const b = Buffer.from(s);
    return b.length === want.length && timingSafeEqual(b, want);
  };
  if (!sigs.some(match)) throw new Error('invalid Stripe signature');
  return JSON.parse(rawBody) as { id: string; type: string; data: { object: StripeSession } };
}

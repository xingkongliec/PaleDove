// Heleket 加密货币收款：创建发票、查询发票、校验回调签名。
// 文档：https://doc.heleket.com/methods/payments/creating-invoice 、/payment-information 、/webhook
// 签名 = md5(base64(JSON 请求体) + 收款 API 密钥)；请求时对实际发送的字符串签名。
import { createHash, timingSafeEqual } from 'node:crypto';
import { t } from '../../i18n/index.ts';

const API = 'https://api.heleket.com/v1';

export const heleketSign = (body: string, apiKey: string) =>
  createHash('md5')
    .update(Buffer.from(body, 'utf8').toString('base64') + apiKey)
    .digest('hex');

/** 已成功付款的状态：paid = 金额正好，paid_over = 多付了 */
export const HELEKET_PAID = ['paid', 'paid_over'];

export interface HeleketInvoice {
  uuid: string;
  order_id: string;
  amount: string;
  currency: string;
  url?: string;
  status?: string;
  payment_status?: string;
  is_final?: boolean;
}

export class HeleketClient {
  constructor(
    private merchantId: string,
    private apiKey: string,
  ) {}

  private async post<T>(path: string, data: Record<string, unknown>): Promise<T> {
    const body = JSON.stringify(data);
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: { merchant: this.merchantId, sign: heleketSign(body, this.apiKey), 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => null)) as { state?: number; result?: T; message?: string; errors?: Record<string, string[]> } | null;
    if (!json || json.state !== 0 || !json.result) {
      const errors = json?.errors ? Object.entries(json.errors).map(([k, v]) => `${k}: ${v.join(', ')}`).join('; ') : '';
      throw new Error(t('pay.heleketError', { message: json?.message || errors || `HTTP ${res.status}` }));
    }
    return json.result;
  }

  /** 创建发票（同一个 order_id 重复创建时 Heleket 返回已有的发票） */
  createInvoice(o: { orderId: string; amount: string; currency: string; lifetime: number; urlCallback: string; urlReturn: string; urlSuccess: string }) {
    return this.post<HeleketInvoice>('/payment', {
      amount: o.amount,
      currency: o.currency,
      order_id: o.orderId,
      url_callback: o.urlCallback,
      url_return: o.urlReturn,
      url_success: o.urlSuccess,
      lifetime: o.lifetime,
    });
  }

  /** 按本站订单号查询发票（以查询结果为准入账，不只相信回调内容） */
  info(orderId: string) {
    return this.post<HeleketInvoice>('/payment/info', { order_id: orderId });
  }
}

/**
 * 校验回调签名：去掉 sign 后按 PHP json_encode 的格式重新编码（斜杠转义为 \/，中文不转义）再算签名。
 * 不同语言的 JSON 编码可能有差异，也接受不转义斜杠的写法。入账前仍会调用查询接口确认，签名只用来尽早丢弃伪造的请求
 */
export function verifyHeleketWebhook(body: Record<string, unknown>, apiKey: string) {
  const { sign, ...data } = body;
  if (typeof sign !== 'string' || !sign) return false;
  const json = JSON.stringify(data);
  const want = Buffer.from(sign.toLowerCase());
  return [json.replace(/\//g, '\\/'), json].some((s) => {
    const got = Buffer.from(heleketSign(s, apiKey));
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

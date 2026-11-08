// 易支付 SDK，兼容 v1（MD5 签名，submit.php / mapi.php / api.php）与 v2（RSA-SHA256 签名，/api/pay/*）。
import { createHash, createSign, createVerify, timingSafeEqual } from 'node:crypto';
import type { PayActionDTO } from '../../shared/index.ts';
import { decrypt } from '../../lib/crypto.ts';
import { t } from '../../i18n/index.ts';

/** 客户端用到的渠道字段（密钥为加密后的值） */
export interface EpayConfig {
  version: 'v1' | 'v2';
  mode: 'submit' | 'api';
  apiUrl: string;
  pid: string;
  keyEnc: string;
  merchantPrivateKeyEnc: string;
  platformPublicKey: string;
}

export type Params = Record<string, string | number | undefined | null>;

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** 待签名字符串：去掉 sign、sign_type 与空值，按参数名 ASCII 升序，拼接为 a=1&b=2 */
export function signContent(params: Params) {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

export const signV1 = (params: Params, key: string) => md5(signContent(params) + key);

function pem(key: string, type: 'PRIVATE KEY' | 'PUBLIC KEY') {
  const k = key.trim();
  if (k.includes('-----BEGIN')) return k;
  const body = k.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

export function signV2(params: Params, privateKey: string) {
  return createSign('RSA-SHA256').update(signContent(params), 'utf8').sign(pem(privateKey, 'PRIVATE KEY'), 'base64');
}

export function verifyV2(params: Params, publicKey: string) {
  if (!params.sign) return false;
  try {
    return createVerify('RSA-SHA256')
      .update(signContent(params), 'utf8')
      .verify(pem(publicKey, 'PUBLIC KEY'), String(params.sign), 'base64');
  } catch {
    return false;
  }
}

export interface EpayOrder {
  outTradeNo: string;
  name: string;
  /** 两位小数 */
  money: string;
  /** alipay | wxpay | qqpay */
  type: string;
  notifyUrl: string;
  returnUrl: string;
  clientIp: string;
  /** pc | mobile */
  device?: string;
}

/** 网关地址：去掉末尾的斜杠和 submit.php 等路径 */
export const epayBase = (apiUrl: string) => apiUrl.trim().replace(/\/+$/, '').replace(/\/(submit|mapi|api)\.php$/i, '');

const strParams = (p: Params) =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));

async function postForm(url: string, params: Params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(strParams(params)),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error(t('pay.epayBadResponse', { text: text.slice(0, 200) }));
  }
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export class EpayClient {
  constructor(private cfg: EpayConfig) {}

  private v1Sign(p: Params) {
    return { ...p, sign: signV1(p, decrypt(this.cfg.keyEnc)), sign_type: 'MD5' };
  }

  private v2Sign(p: Params) {
    const withTs = { ...p, timestamp: Math.floor(Date.now() / 1000) };
    return { ...withTs, sign: signV2(withTs, decrypt(this.cfg.merchantPrivateKeyEnc)), sign_type: 'RSA' };
  }

  /** 发起支付，返回前端需要执行的动作 */
  async createPayment(o: EpayOrder): Promise<PayActionDTO> {
    const common: Params = {
      pid: this.cfg.pid,
      type: o.type,
      out_trade_no: o.outTradeNo,
      notify_url: o.notifyUrl,
      return_url: o.returnUrl,
      name: o.name,
      money: o.money,
    };
    const root = epayBase(this.cfg.apiUrl);

    if (this.cfg.version === 'v1') {
      if (this.cfg.mode === 'submit') {
        const signed = strParams(this.v1Sign(common));
        return { kind: 'redirect', url: `${root}/submit.php?${new URLSearchParams(signed)}` };
      }
      const r = await postForm(`${root}/mapi.php`, this.v1Sign({ ...common, clientip: o.clientIp, device: o.device ?? 'pc' }));
      if (Number(r.code) !== 1) throw new Error(t('pay.epayOrderFailed', { message: r.msg ?? JSON.stringify(r) }));
      if (r.payurl) return { kind: 'redirect', url: r.payurl };
      if (r.qrcode) return { kind: 'qrcode', content: r.qrcode };
      if (r.urlscheme) return { kind: 'redirect', url: r.urlscheme };
      throw new Error(t('pay.epayNoUrl'));
    }

    // v2
    if (this.cfg.mode === 'submit') {
      return { kind: 'form', action: `${root}/api/pay/submit`, fields: strParams(this.v2Sign(common)) };
    }
    const r = await postForm(`${root}/api/pay/create`, this.v2Sign({ ...common, method: 'web', device: o.device ?? 'pc', clientip: o.clientIp }));
    if (Number(r.code) !== 0) throw new Error(t('pay.epayOrderFailed', { message: r.msg ?? JSON.stringify(r) }));
    if (r.sign && this.cfg.platformPublicKey && !verifyV2(r, this.cfg.platformPublicKey)) throw new Error(t('pay.epayBadSign'));
    switch (r.pay_type) {
      case 'jump':
      case 'urlscheme':
        return { kind: 'redirect', url: r.pay_info };
      case 'qrcode':
        return { kind: 'qrcode', content: r.pay_info };
      case 'html':
        return { kind: 'html', html: r.pay_info };
      default:
        if (typeof r.pay_info === 'string' && /^https?:\/\//.test(r.pay_info)) return { kind: 'redirect', url: r.pay_info };
        throw new Error(t('pay.epayUnsupported', { type: String(r.pay_type) }));
    }
  }

  /** 校验异步通知 / 同步跳转参数的签名 */
  verifyNotify(params: Params) {
    if (String(params.pid ?? '') !== String(this.cfg.pid)) return false;
    if (this.cfg.version === 'v1') {
      return !!params.sign && sameText(signV1(params, decrypt(this.cfg.keyEnc)), String(params.sign).toLowerCase());
    }
    if (!this.cfg.platformPublicKey) return false;
    const ts = Number(params.timestamp);
    if (ts && Math.abs(Date.now() / 1000 - ts) > 3600) return false;
    return verifyV2(params, this.cfg.platformPublicKey);
  }

  /** 主动查询订单是否已支付 */
  async queryPaid(outTradeNo: string): Promise<{ paid: boolean; tradeNo?: string; money?: string; raw: unknown }> {
    const root = epayBase(this.cfg.apiUrl);
    if (this.cfg.version === 'v1') {
      const q = new URLSearchParams({ act: 'order', pid: this.cfg.pid, key: decrypt(this.cfg.keyEnc), out_trade_no: outTradeNo });
      const res = await fetch(`${root}/api.php?${q}`, { signal: AbortSignal.timeout(15_000) });
      const r = (await res.json()) as Record<string, any>;
      return { paid: Number(r.code) === 1 && Number(r.status) === 1, tradeNo: r.trade_no, money: r.money, raw: r };
    }
    const r = await postForm(`${root}/api/pay/query`, this.v2Sign({ pid: this.cfg.pid, out_trade_no: outTradeNo }));
    return { paid: Number(r.code) === 0 && Number(r.status) === 1, tradeNo: r.trade_no, money: r.money, raw: r };
  }
}

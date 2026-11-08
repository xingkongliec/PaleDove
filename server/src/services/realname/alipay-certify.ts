// 支付宝开放平台「身份验证」（alipay.user.certify.open.*）：初始化 → 用户在支付宝 App 内刷脸 → 查询结果。
// 只支持「公钥模式」RSA2：请求用应用私钥签名，响应用支付宝公钥验签（防止伪造的认证结果）。
import { createSign, createVerify, randomBytes } from 'node:crypto';
import { decrypt } from '../../lib/crypto.ts';
import type { RealnameSettings } from '../../lib/settings.ts';
import { t } from '../../i18n/index.ts';

export const ALIPAY_GATEWAY = 'https://openapi.alipay.com/gateway.do';

export interface CertifyConfig {
  appId: string;
  privateKey: string;
  alipayPublicKey: string;
  gateway: string;
  bizCode: string;
}

export class AlipayError extends Error {
  constructor(
    message: string,
    readonly code = '',
    readonly subCode = '',
  ) {
    super(message);
  }
}

/** 从系统设置得到可用的配置；未启用或缺少参数时返回 null */
export function certifyConfig(s: RealnameSettings): CertifyConfig | null {
  if (!s.enabled || !s.appId || !s.privateKeyEnc || !s.alipayPublicKey) return null;
  return { appId: s.appId, privateKey: decrypt(s.privateKeyEnc), alipayPublicKey: s.alipayPublicKey, gateway: s.gateway || ALIPAY_GATEWAY, bizCode: s.bizCode || 'FACE' };
}

function pem(key: string, type: 'PRIVATE KEY' | 'PUBLIC KEY') {
  const k = key.trim();
  if (k.includes('-----BEGIN')) return k;
  const body = k.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN ${type}-----\n${body}\n-----END ${type}-----`;
}

/** 支付宝要求的北京时间 yyyy-MM-dd HH:mm:ss */
function timestamp(d = new Date()) {
  return new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/** 请求签名：除 sign 外的非空参数（含 sign_type）按名称升序拼成 a=1&b=2，RSA-SHA256 */
export function signParams(params: Record<string, string>, privateKey: string) {
  const content = Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createSign('RSA-SHA256').update(content, 'utf8').sign(pem(privateKey, 'PRIVATE KEY'), 'base64');
}

function requestParams(cfg: CertifyConfig, method: string, biz: object) {
  const params: Record<string, string> = {
    app_id: cfg.appId,
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: timestamp(),
    version: '1.0',
    biz_content: JSON.stringify(biz),
  };
  params.sign = signParams(params, cfg.privateKey);
  return params;
}

/** 取出响应里 `"<node>":{...}` 的原始 JSON 文本（验签针对原文，不能先解析再序列化） */
export function rawNode(text: string, node: string) {
  const at = text.indexOf(`"${node}"`);
  if (at < 0) return null;
  const start = text.indexOf('{', at + node.length + 2);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** 调用开放平台接口；返回已验签的业务数据，业务失败抛 AlipayError */
export async function callAlipay<T extends Record<string, unknown>>(cfg: CertifyConfig, method: string, biz: object): Promise<T> {
  let text: string;
  try {
    const res = await fetch(cfg.gateway, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(requestParams(cfg, method, biz)),
      signal: AbortSignal.timeout(15_000),
    });
    text = await res.text();
  } catch (e) {
    throw new AlipayError(t('alipay.unreachable', { message: (e as Error).message }));
  }
  const node = `${method.replace(/\./g, '_')}_response`;
  const raw = rawNode(text, node) ?? rawNode(text, 'error_response');
  if (!raw) throw new AlipayError(t('alipay.unrecognized'));
  let body: Record<string, unknown>;
  let sign: string | undefined;
  try {
    body = JSON.parse(raw);
    sign = (JSON.parse(text) as { sign?: string }).sign;
  } catch {
    throw new AlipayError(t('alipay.unrecognized'));
  }
  const ok = body.code === '10000';
  // 应用 ID / 签名错误时支付宝不一定带签名；成功的响应必须验签通过
  if (sign || ok) {
    let valid = false;
    try {
      valid = !!sign && createVerify('RSA-SHA256').update(raw, 'utf8').verify(pem(cfg.alipayPublicKey, 'PUBLIC KEY'), sign, 'base64');
    } catch {
      valid = false;
    }
    if (!valid) throw new AlipayError(t('alipay.badSignature'));
  }
  if (!ok) {
    const msg = String(body.sub_msg || body.msg || 'unknown error');
    throw new AlipayError(t('alipay.error', { message: msg }), String(body.code ?? ''), String(body.sub_code ?? ''));
  }
  return body as T;
}

/** 第一步：用姓名和身份证号初始化，得到 certify_id */
export async function initializeCertify(cfg: CertifyConfig, input: { realName: string; idNumber: string; returnUrl: string }) {
  const outerOrderNo = `PD${Date.now()}${randomBytes(4).toString('hex')}`;
  const r = await callAlipay<{ certify_id: string }>(cfg, 'alipay.user.certify.open.initialize', {
    outer_order_no: outerOrderNo,
    biz_code: cfg.bizCode,
    identity_param: { identity_type: 'CERT_INFO', cert_type: 'IDENTITY_CARD', cert_name: input.realName, cert_no: input.idNumber },
    merchant_config: { return_url: input.returnUrl },
  });
  if (!r.certify_id) throw new AlipayError(t('alipay.noCertifyId'));
  return { certifyId: r.certify_id, outerOrderNo };
}

/** 第二步：生成认证页地址（签名后的 GET 链接），用户用支付宝扫码或在手机上打开 */
export function certifyUrl(cfg: CertifyConfig, certifyId: string) {
  return `${cfg.gateway}?${new URLSearchParams(requestParams(cfg, 'alipay.user.certify.open.certify', { certify_id: certifyId }))}`;
}

/** 第三步：查询结果，passed 为 true 表示本人刷脸认证通过 */
export async function queryCertify(cfg: CertifyConfig, certifyId: string) {
  const r = await callAlipay<{ passed?: string; fail_reason?: string }>(cfg, 'alipay.user.certify.open.query', { certify_id: certifyId });
  return { passed: r.passed === 'T', failReason: r.fail_reason ? String(r.fail_reason) : null };
}

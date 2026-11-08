import { createHmac, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encrypt } from '../src/lib/crypto.ts';
import { EpayClient, epayBase, signContent, signV1, signV2, verifyV2, type EpayConfig } from '../src/services/payments/epay.ts';
import { heleketSign, verifyHeleketWebhook } from '../src/services/payments/heleket.ts';
import { feeOf, foreignCharge } from '../src/services/payments/payments.ts';
import { stripeDecimals, stripeForm, verifyStripeWebhook } from '../src/services/payments/stripe.ts';

describe('stripe', () => {
  const secret = 'whsec_test';
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', client_reference_id: 'P1' } } });
  const now = 1_700_000_000_000;
  const header = (t: number, b = body, key = secret) => `t=${t},v1=${createHmac('sha256', key).update(`${t}.${b}`).digest('hex')}`;

  it('verifies webhook signatures', () => {
    const e = verifyStripeWebhook(body, header(now / 1000), secret, 300, now);
    expect(e.type).toBe('checkout.session.completed');
    expect(e.data.object.id).toBe('cs_1');
    // 多个 v1（轮换密钥期间）任一匹配即可
    expect(verifyStripeWebhook(body, `t=${now / 1000},v1=deadbeef,${header(now / 1000).split(',')[1]}`, secret, 300, now)).toBeTruthy();
  });

  it('rejects wrong signatures, tampered bodies, expired events and bad headers', () => {
    expect(() => verifyStripeWebhook(body, header(now / 1000, body, 'whsec_other'), secret, 300, now)).toThrow(/signature/);
    expect(() => verifyStripeWebhook(body.replace('P1', 'P2'), header(now / 1000), secret, 300, now)).toThrow(/signature/);
    expect(() => verifyStripeWebhook(body, header(now / 1000 - 301), secret, 300, now)).toThrow(/expired/);
    expect(() => verifyStripeWebhook(body, undefined, secret, 300, now)).toThrow(/missing/);
    expect(() => verifyStripeWebhook(body, 'v1=abc', secret, 300, now)).toThrow(/malformed/);
    // 非 ASCII 的签名不会让比较抛异常
    expect(() => verifyStripeWebhook(body, `t=${now / 1000},v1=${'签'.repeat(64)}`, secret, 300, now)).toThrow(/signature/);
  });

  it('encodes nested params as a form', () => {
    const f = stripeForm({ mode: 'payment', metadata: { a: 'x' }, line_items: [{ quantity: 1, price_data: { unit_amount: 1000 } }], skip: undefined });
    expect(f.toString()).toBe('mode=payment&metadata%5Ba%5D=x&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1000');
  });

  it('knows zero-decimal currencies', () => {
    expect(stripeDecimals('jpy')).toBe(0);
    expect(stripeDecimals('USD')).toBe(2);
    expect(stripeDecimals('CNY')).toBe(2);
  });
});

describe('heleket', () => {
  const key = 'test-api-key';
  it('signs md5(base64(body) + key)', () => {
    // md5('eyJhIjoxfQ==' + 'k')，eyJhIjoxfQ== 是 {"a":1} 的 base64
    expect(heleketSign('{"a":1}', 'k')).toBe('47eeaea4b5a71243887d9a92a54a58b6');
    expect(heleketSign('{"a":1}', 'k')).not.toBe(heleketSign('{"a":2}', 'k'));
  });

  it('verifies PHP-encoded webhooks and the unescaped form', () => {
    const data = { uuid: 'u-1', order_id: 'P1', status: 'paid', url: 'https://x/y' };
    const php = JSON.stringify(data).replace(/\//g, '\\/');
    expect(verifyHeleketWebhook({ ...data, sign: heleketSign(php, key) }, key)).toBe(true);
    expect(verifyHeleketWebhook({ ...data, sign: heleketSign(JSON.stringify(data), key) }, key)).toBe(true);
    expect(verifyHeleketWebhook({ ...data, status: 'cancel', sign: heleketSign(php, key) }, key)).toBe(false);
    expect(verifyHeleketWebhook({ ...data, sign: heleketSign(php, 'other') }, key)).toBe(false);
    expect(verifyHeleketWebhook(data, key)).toBe(false);
  });
});

describe('epay', () => {
  const key = 'epaykey';
  const notify = {
    pid: '1001',
    trade_no: '2026101112000012345',
    out_trade_no: 'P20261011120000123456',
    type: 'alipay',
    name: 'PaleDove Cloud 余额充值',
    money: '15.00',
    trade_status: 'TRADE_SUCCESS',
    sign_type: 'MD5',
    // 按易支付 SDK 规则（参数排序拼接 + 密钥后 MD5）独立计算
    sign: '1748374302d8579d096729e27d7d6211',
  };
  const v1: EpayConfig = { version: 'v1', mode: 'submit', apiUrl: 'https://pay.example.com/', pid: '1001', keyEnc: encrypt(key), merchantPrivateKeyEnc: '', platformPublicKey: '' };

  it('signs v1 params, ignoring empty values and sign fields', () => {
    const { sign: _s, sign_type: _t, ...rest } = notify;
    expect(signV1({ ...rest, param: '' }, key)).toBe(notify.sign);
    expect(signContent({ b: 2, a: 1, sign: 'x', sign_type: 'MD5', c: '' })).toBe('a=1&b=2');
  });

  it('verifies v1 notifications with the channel key and pid', () => {
    const client = new EpayClient(v1);
    expect(client.verifyNotify(notify)).toBe(true);
    expect(client.verifyNotify({ ...notify, sign: notify.sign.toUpperCase() })).toBe(true);
    expect(client.verifyNotify({ ...notify, money: '150.00' })).toBe(false);
    expect(client.verifyNotify({ ...notify, sign: '' })).toBe(false);
    expect(new EpayClient({ ...v1, pid: '1002' }).verifyNotify(notify)).toBe(false);
  });

  it('builds the v1 submit url', async () => {
    const action = await new EpayClient(v1).createPayment({ outTradeNo: 'P1', name: 'Top-up', money: '9.90', type: 'wxpay', notifyUrl: 'https://panel/n', returnUrl: 'https://panel/r', clientIp: '1.2.3.4' });
    expect(action.kind).toBe('redirect');
    const url = new URL((action as { url: string }).url);
    expect(url.origin + url.pathname).toBe('https://pay.example.com/submit.php');
    const params = Object.fromEntries(url.searchParams);
    expect(params.sign_type).toBe('MD5');
    expect(new EpayClient(v1).verifyNotify(params)).toBe(true);
  });

  it('signs and verifies v2 with RSA, and posts a form in submit mode', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const priv = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const params = { pid: '1001', out_trade_no: 'P1', money: '1.00' };
    const signed = { ...params, sign: signV2(params, priv) };
    expect(verifyV2(signed, pub)).toBe(true);
    expect(verifyV2({ ...signed, money: '2.00' }, pub)).toBe(false);
    // 纯 base64（不带 PEM 头）也能用
    expect(verifyV2(signed, pub.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''))).toBe(true);

    const v2: EpayConfig = { ...v1, version: 'v2', keyEnc: '', merchantPrivateKeyEnc: encrypt(priv), platformPublicKey: pub };
    const action = await new EpayClient(v2).createPayment({ outTradeNo: 'P1', name: 'Top-up', money: '1.00', type: 'alipay', notifyUrl: 'https://panel/n', returnUrl: 'https://panel/r', clientIp: '1.2.3.4' });
    expect(action.kind).toBe('form');
    const form = action as { action: string; fields: Record<string, string> };
    expect(form.action).toBe('https://pay.example.com/api/pay/submit');
    expect(form.fields.sign_type).toBe('RSA');
    expect(verifyV2(form.fields, pub)).toBe(true);
  });

  it('normalises gateway base urls', () => {
    expect(epayBase('https://pay.example.com/')).toBe('https://pay.example.com');
    expect(epayBase('https://pay.example.com/mapi.php')).toBe('https://pay.example.com');
    expect(epayBase('https://pay.example.com/epay/submit.php')).toBe('https://pay.example.com/epay');
  });
});

describe('amounts', () => {
  it('converts CNY at the rate, rounding up to the smallest unit', () => {
    expect(foreignCharge(100, 1).toFixed(2)).toBe('100.00');
    expect(foreignCharge(100, 0.1408).toFixed(2)).toBe('14.08');
    expect(foreignCharge(10, 0.13333).toFixed(2)).toBe('1.34');
    expect(foreignCharge(1000, 20.5, 0).toFixed(0)).toBe('20500');
  });

  it('computes fee = amount × rate + fixed, rounded up to cents', () => {
    expect(feeOf(100, 0, 0).toFixed(2)).toBe('0.00');
    expect(feeOf(100, 5, 0).toFixed(2)).toBe('5.00');
    expect(feeOf(33.33, 0.6, 0).toFixed(2)).toBe('0.20');
    expect(feeOf(10, 2.5, 1).toFixed(2)).toBe('1.25');
  });
});

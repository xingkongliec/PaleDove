import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, verifyTotp } from '../src/lib/totp.ts';
import { parseUserAgent } from '../src/lib/ua.ts';
import { customProfile, packFlow, pick, safeNext, unpackFlow } from '../src/services/oauth.ts';
import { idNumberError, maskId, maskName, realNameError } from '../src/services/realname/realname.ts';
import { rawNode } from '../src/services/realname/alipay-certify.ts';
import { sniffImage } from '../src/services/site-icon.ts';

// RFC 6238 附录 B：密钥 "12345678901234567890"，T=59 时 8 位码为 94287082
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('Base32 编码解码互逆', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello totp 123'))).toString()).toBe('hello totp 123');
  });

  it('HOTP 与 RFC 4226 测试向量一致', () => {
    const secret = Buffer.from('12345678901234567890');
    ['755224', '287082', '359152', '969429', '338314'].forEach((code, i) => expect(hotp(secret, i)).toBe(code));
  });

  it('TOTP 与 RFC 6238 测试向量一致，并允许一个时间步的误差', () => {
    // T=59s → 步 1 → 6 位码 287082
    expect(verifyTotp(RFC_SECRET, '287082', 59_000)).toBe(1);
    expect(verifyTotp(RFC_SECRET, '287082', 59_000 + 30_000)).toBe(1);
    expect(verifyTotp(RFC_SECRET, '287082', 59_000 + 90_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', 59_000)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', 59_000)).toBeNull();
  });
});

describe('User-Agent', () => {
  it('识别系统与浏览器', () => {
    const cases: Array<[string, string, string, string]> = [
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0', 'Windows', 'Edge', 'desktop'],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Windows', 'Chrome', 'desktop'],
      ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iOS', 'Safari', 'mobile'],
      ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'macOS', 'Safari', 'desktop'],
      ['Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0', 'Linux', 'Firefox', 'desktop'],
      ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36', 'Android', 'Chrome', 'mobile'],
    ];
    for (const [ua, os, browser, device] of cases) expect(parseUserAgent(ua)).toEqual({ os, browser, device });
    expect(parseUserAgent(null).os).toBe('未知系统');
  });
});

describe('OAuth', () => {
  const base = { name: 'Demo', idField: 'sub', emailField: 'email', nameField: 'name', trustEmail: true, emailVerifiedField: '' };

  it('按路径读取嵌套字段', () => {
    expect(pick({ data: { user: { id: 7 } } }, 'data.user.id')).toBe(7);
    expect(pick({ data: null }, 'data.id')).toBeUndefined();
    expect(pick('x', 'a')).toBeUndefined();
  });

  it('标准 OIDC 用户信息', () => {
    expect(customProfile(base, { sub: 'abc', email: 'Foo@Example.com', name: 'Foo' })).toEqual({ providerId: 'abc', email: 'foo@example.com', name: 'Foo', trustedEmail: true });
  });

  it('数字 ID、没有邮箱时用用户名（如 Linux.do Connect）', () => {
    expect(customProfile({ ...base, idField: 'id', emailField: '', nameField: '' }, { id: 42, username: 'neo', trust_level: 2 })).toEqual({
      providerId: '42',
      email: null,
      name: 'neo',
      trustedEmail: false,
    });
  });

  it('不信任邮箱、邮箱未验证时不能用来匹配账号', () => {
    expect(customProfile({ ...base, trustEmail: false }, { sub: '1', email: 'a@b.c' }).trustedEmail).toBe(false);
    const v = { ...base, emailVerifiedField: 'email_verified' };
    expect(customProfile(v, { sub: '1', email: 'a@b.c', email_verified: false }).trustedEmail).toBe(false);
    expect(customProfile(v, { sub: '1', email: 'a@b.c', email_verified: 'true' }).trustedEmail).toBe(true);
    // 不是邮箱格式的值不当作邮箱
    expect(customProfile(base, { sub: '1', email: 'not-an-email' }).email).toBeNull();
  });

  it('没有用户标识时报错', () => {
    expect(() => customProfile(base, { email: 'a@b.c' })).toThrow(/没有返回用户标识/);
    expect(() => customProfile({ ...base, idField: 'user' }, { user: { id: 1 } })).toThrow(/没有返回用户标识/);
  });

  it('流程状态签名防篡改，只允许站内跳转', () => {
    const packed = packFlow({ state: 's1', provider: 'github', next: '/dashboard', link: 3 });
    expect(unpackFlow(packed)).toMatchObject({ state: 's1', provider: 'github', next: '/dashboard', link: 3 });
    const [body, sig] = packed.split('.');
    const forged = Buffer.from(JSON.stringify({ state: 's1', provider: 'github', next: '/', link: 1, exp: Date.now() + 60_000 })).toString('base64url');
    expect(unpackFlow(`${forged}.${sig}`)).toBeNull();
    expect(unpackFlow(`${body}.x${sig!.slice(1)}`)).toBeNull();
    expect(safeNext('//evil.com')).toBe('');
    expect(safeNext('https://evil.com')).toBe('');
    expect(safeNext('/\\evil.com')).toBe('');
    expect(safeNext('/account?tab=connections')).toBe('/account?tab=connections');
  });
});

describe('实名认证', () => {
  it('校验身份证号', () => {
    const now = new Date('2026-01-01');
    expect(idNumberError('11010519491231002X', now)).toBeNull();
    expect(idNumberError('11010519491231002x', now)).toBeNull();
    expect(idNumberError('110105194912310021', now)).toMatch(/校验位/);
    expect(idNumberError('91010519491231002X', now)).toMatch(/地区码/);
    expect(idNumberError('110105194902301234', now)).toMatch(/出生日期/);
    expect(idNumberError('1101051949123100', now)).toMatch(/18 位/);
  });

  it('校验姓名并脱敏', () => {
    expect(realNameError('张三')).toBeNull();
    expect(realNameError('阿卜杜·热合曼')).toBeNull();
    expect(realNameError('John Smith')).toBeNull();
    expect(realNameError('张')).not.toBeNull();
    expect(realNameError('张3')).not.toBeNull();
    expect(maskName('张三')).toBe('张*');
    expect(maskName('欧阳娜娜')).toBe('欧**娜');
    expect(maskId('110101199003071234')).toBe('110***********1234');
  });

  it('取出支付宝响应节点的原文用于验签', () => {
    const text = '{"alipay_user_certify_open_query_response":{"code":"10000","msg":"Success","passed":"T","x":"a}\\"b"},"sign":"abc"}';
    expect(rawNode(text, 'alipay_user_certify_open_query_response')).toBe('{"code":"10000","msg":"Success","passed":"T","x":"a}\\"b"}');
    expect(rawNode(text, 'error_response')).toBeNull();
  });
});

describe('图标', () => {
  it('按文件头识别图片类型', () => {
    expect(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe('image/svg+xml');
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
  });
});

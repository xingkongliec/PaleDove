// 在浏览器本地生成 SSH 密钥对（Web Crypto），输出 OpenSSH 格式：公钥一行，私钥为未加密的 OPENSSH PRIVATE KEY。
// 私钥只在本页面里出现，不会发给服务器

export type SshKeyAlgo = 'ed25519' | 'rsa';

export interface SshKeyPair {
  publicKey: string;
  privateKey: string;
}

const enc = new TextEncoder();

/** SSH wire 格式的拼接器：uint32 / string / mpint */
class Writer {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array) {
    this.parts.push(b);
    return this;
  }
  u32(n: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return this.bytes(b);
  }
  string(v: Uint8Array | string) {
    const b = typeof v === 'string' ? enc.encode(v) : v;
    return this.u32(b.length).bytes(b);
  }
  /** 大整数：去掉开头的 0，最高位为 1 时补一个 0（表示正数） */
  mpint(v: Uint8Array) {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    const trimmed = v.subarray(i);
    return this.string(trimmed[0]! & 0x80 ? concat(new Uint8Array([0]), trimmed) : trimmed);
  }
  done(): Uint8Array {
    return concat(...this.parts);
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

/** 组装 openssh-key-v1 私钥文件（不加密） */
function opensshPrivate(type: string, pubBlob: Uint8Array, privFields: (w: Writer) => void, comment: string): string {
  const check = crypto.getRandomValues(new Uint32Array(1))[0]!;
  const w = new Writer().u32(check).u32(check).string(type);
  privFields(w);
  w.string(comment);
  let priv = w.done();
  // 补齐到 8 字节的倍数，填充内容为 1, 2, 3…
  const pad = (8 - (priv.length % 8)) % 8;
  priv = concat(priv, Uint8Array.from({ length: pad }, (_, i) => i + 1));
  const file = new Writer().bytes(enc.encode('openssh-key-v1\0')).string('none').string('none').string('').u32(1).string(pubBlob).string(priv).done();
  const body = b64(file).replace(/.{70}/g, '$&\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}${body.endsWith('\n') ? '' : '\n'}-----END OPENSSH PRIVATE KEY-----\n`;
}

async function ed25519(comment: string): Promise<SshKeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  // PKCS#8 的最后 32 字节是私钥种子
  const seed = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).slice(-32);
  const type = 'ssh-ed25519';
  const blob = new Writer().string(type).string(pub).done();
  return {
    publicKey: `${type} ${b64(blob)} ${comment}`.trim(),
    privateKey: opensshPrivate(type, blob, (w) => w.string(pub).string(concat(seed, pub)), comment),
  };
}

async function rsa(comment: string): Promise<SshKeyPair> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const [n, e, d, p, q, qi] = [jwk.n, jwk.e, jwk.d, jwk.p, jwk.q, jwk.qi].map((v) => fromB64url(v!));
  const type = 'ssh-rsa';
  const blob = new Writer().string(type).mpint(e!).mpint(n!).done();
  return {
    publicKey: `${type} ${b64(blob)} ${comment}`.trim(),
    privateKey: opensshPrivate(type, blob, (w) => w.mpint(n!).mpint(e!).mpint(d!).mpint(qi!).mpint(p!).mpint(q!), comment),
  };
}

/** 浏览器是否支持（需要 HTTPS 或 localhost 下的 Web Crypto） */
export const sshKeygenSupported = () => typeof crypto !== 'undefined' && !!crypto.subtle;

export function generateSshKey(algo: SshKeyAlgo, comment: string): Promise<SshKeyPair> {
  return algo === 'ed25519' ? ed25519(comment) : rsa(comment);
}

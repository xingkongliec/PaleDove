import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { FastifyInstance } from 'fastify';

// ───────── 模拟认证器：最小的 CBOR 编码 + P-256 密钥 ─────────

function cborHead(major: number, n: number) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (major << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cbor(value: unknown): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([cborHead(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([cborHead(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error('unsupported');
}

const RP_ID = 'panel.test';
const ORIGIN = `http://${RP_ID}`;
const b64u = (b: Buffer) => b.toString('base64url');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest();

class Authenticator {
  readonly id = randomBytes(16);
  readonly key: KeyObject;
  readonly pub: { x: string; y: string };
  counter = 0;
  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.pub = { x: jwk.x!, y: jwk.y! };
  }
  register(challenge: string) {
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.pub.x, 'base64url')], [-3, Buffer.from(this.pub.y, 'base64url')]]));
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.id.length);
    // 标志：用户在场 + 用户验证 + 包含凭据数据
    const authData = Buffer.concat([sha(RP_ID), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.id, cose]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false }));
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] },
    };
  }
  assert(challenge: string, counter = ++this.counter) {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(counter);
    const authData = Buffer.concat([sha(RP_ID), Buffer.from([0x05]), count]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
    const signature = sign('sha256', Buffer.concat([authData, sha(clientData)]), this.key);
    return {
      id: b64u(this.id),
      rawId: b64u(this.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature) },
    };
  }
}

describe('passkeys', () => {
  let app: FastifyInstance;
  let db: typeof import('../src/lib/prisma.ts').prisma;
  let directory: string;
  let userCookie: string;
  let otherCookie: string;
  const password = 'test-password-123';
  const request = (options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; cookie?: string; payload?: object }) =>
    app.inject({ method: options.method ?? 'GET', url: options.url, payload: options.payload, headers: { host: RP_ID, 'x-requested-with': 'XMLHttpRequest', ...(options.cookie ? { cookie: options.cookie } : {}) } });
  const cookieOf = (response: { cookies: { name: string; value: string }[] }) => response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  beforeAll(async () => {
    directory = mkdtempSync(resolve(tmpdir(), 'paledove-passkey-test-'));
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: `file:${resolve(directory, 'test.db')}`, REDIS_URL: 'memory://', APP_SECRET: 'test-passkey-secret-1234567890', LOG_LEVEL: 'error', COOKIE_SECURE: 'false', PANEL_URL: ORIGIN });
    const require = createRequire(realpathSync(resolve('node_modules/@prisma/adapter-better-sqlite3/package.json')));
    const Database = require('better-sqlite3');
    new Database(resolve(directory, 'test.db')).close();
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--config', 'prisma.sqlite.config.ts'], { env: process.env, stdio: 'pipe' });
    db = (await import('../src/lib/prisma.ts')).prisma;
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    for (const username of ['member', 'other']) await db.user.create({ data: { username, email: `${username}@example.com`, passwordHash: hash, emailVerifiedAt: new Date() } });
    app = await (await import('../src/app.ts')).buildApp();
    const login = async (account: string) => {
      const response = await request({ method: 'POST', url: '/api/auth/login', payload: { account, password } });
      expect(response.statusCode, response.body).toBe(200);
      return cookieOf(response);
    };
    userCookie = await login('member');
    otherCookie = await login('other');
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await db?.$disconnect();
    if (directory && dirname(directory) === resolve(tmpdir()) && basename(directory).startsWith('paledove-passkey-test-')) rmSync(directory, { recursive: true, force: true });
  });

  const authenticator = new Authenticator();
  let passkeyId: number;

  const signIn = async (device: Authenticator, counter?: number) => {
    const options = await request({ method: 'POST', url: '/api/auth/login/passkey/options' });
    expect(options.statusCode).toBe(200);
    const { challengeId, options: opts } = options.json() as { challengeId: string; options: { challenge: string; rpId: string } };
    expect(opts.rpId).toBe(RP_ID);
    return { challengeId, challenge: opts.challenge, response: await request({ method: 'POST', url: '/api/auth/login/passkey', payload: { challengeId, response: device.assert(opts.challenge, counter) } }) };
  };

  it('registers a passkey for the signed-in account', async () => {
    expect((await request({ method: 'POST', url: '/api/auth/passkeys/options' })).statusCode).toBe(401);
    const options = await request({ method: 'POST', url: '/api/auth/passkeys/options', cookie: userCookie });
    expect(options.statusCode).toBe(200);
    const opts = options.json() as { challenge: string; rp: { id: string }; authenticatorSelection: { residentKey: string } };
    expect(opts.rp.id).toBe(RP_ID);
    expect(opts.authenticatorSelection.residentKey).toBe('required');

    const created = await request({ method: 'POST', url: '/api/auth/passkeys', cookie: userCookie, payload: { response: authenticator.register(opts.challenge), name: 'Laptop' } });
    expect(created.statusCode, created.body).toBe(200);
    passkeyId = created.json().id;
    expect(created.json()).toMatchObject({ name: 'Laptop', deviceType: 'singleDevice', lastUsedAt: null });

    // 同一个挑战不能再用
    expect((await request({ method: 'POST', url: '/api/auth/passkeys', cookie: userCookie, payload: { response: authenticator.register(opts.challenge) } })).statusCode).toBe(400);
    // 再次添加时已有凭据在排除列表里；即使绕过浏览器提交同一个凭据也会被拒绝
    const again = (await request({ method: 'POST', url: '/api/auth/passkeys/options', cookie: userCookie })).json() as { challenge: string; excludeCredentials: { id: string }[] };
    expect(again.excludeCredentials.map((c) => c.id)).toEqual([authenticator.register('x').id]);
    expect((await request({ method: 'POST', url: '/api/auth/passkeys', cookie: userCookie, payload: { response: authenticator.register(again.challenge) } })).statusCode).toBe(409);

    const list = await request({ url: '/api/auth/passkeys', cookie: userCookie });
    expect(list.json().items).toHaveLength(1);
    expect((await request({ url: '/api/auth/passkeys', cookie: otherCookie })).json().items).toHaveLength(0);
  });

  it('rejects a registration signed for another origin', async () => {
    const opts = (await request({ method: 'POST', url: '/api/auth/passkeys/options', cookie: otherCookie })).json() as { challenge: string };
    const response = new Authenticator().register(opts.challenge);
    const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
    response.response.clientDataJSON = b64u(Buffer.from(JSON.stringify({ ...clientData, origin: 'http://evil.test' })));
    expect((await request({ method: 'POST', url: '/api/auth/passkeys', cookie: otherCookie, payload: { response } })).statusCode).toBe(400);
  });

  it('signs in with the passkey and rejects replays and cloned counters', async () => {
    const { challengeId, challenge, response } = await signIn(authenticator);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().user).toMatchObject({ username: 'member' });
    const me = await request({ url: '/api/auth/me', cookie: cookieOf(response) });
    expect(me.json().user).toMatchObject({ username: 'member' });
    // 挑战只能使用一次
    expect((await request({ method: 'POST', url: '/api/auth/login/passkey', payload: { challengeId, response: authenticator.assert(challenge) } })).statusCode).toBe(400);
    // 计数器没有增长：认证器可能被克隆
    expect((await signIn(authenticator, 1)).response.statusCode).toBe(400);
    expect((await signIn(authenticator)).response.statusCode).toBe(200);
    const row = await db.passkey.findUniqueOrThrow({ where: { id: passkeyId } });
    expect(row.lastUsedAt).not.toBeNull();
    // 未添加过的认证器
    expect((await signIn(new Authenticator())).response.statusCode).toBe(400);
  });

  it('renames and removes passkeys only for the owner', async () => {
    expect((await request({ method: 'PATCH', url: `/api/auth/passkeys/${passkeyId}`, cookie: otherCookie, payload: { name: 'x' } })).statusCode).toBe(404);
    expect((await request({ method: 'PATCH', url: `/api/auth/passkeys/${passkeyId}`, cookie: userCookie, payload: { name: ' ' } })).statusCode).toBe(400);
    expect((await request({ method: 'PATCH', url: `/api/auth/passkeys/${passkeyId}`, cookie: userCookie, payload: { name: 'Phone' } })).json()).toMatchObject({ name: 'Phone' });
    expect((await request({ method: 'DELETE', url: `/api/auth/passkeys/${passkeyId}`, cookie: otherCookie })).statusCode).toBe(404);
    expect((await request({ method: 'DELETE', url: `/api/auth/passkeys/${passkeyId}`, cookie: userCookie })).statusCode).toBe(200);
    expect((await signIn(authenticator)).response.statusCode).toBe(400);
  });

  it('lets admins review and reset two-factor authentication and passkeys of a user', async () => {
    const hash = await (await import('../src/lib/crypto.ts')).hashPassword(password);
    await db.user.create({ data: { username: 'boss', email: 'boss@example.com', passwordHash: hash, emailVerifiedAt: new Date(), role: 'ADMIN' } });
    const login = await request({ method: 'POST', url: '/api/auth/login', payload: { account: 'boss', password } });
    expect(login.statusCode, login.body).toBe(200);
    const adminCookie = cookieOf(login);
    const member = await db.user.findUniqueOrThrow({ where: { username: 'member' } });
    const base = `/api/admin/users/${member.id}`;
    // 准备：两个通行密钥、已启用的两步验证
    for (const name of ['Laptop', 'Phone'])
      await db.passkey.create({ data: { userId: member.id, credentialId: `cred-${name}`, publicKey: 'x', deviceType: name === 'Phone' ? 'multiDevice' : 'singleDevice', name } });
    await db.user.update({ where: { id: member.id }, data: { totpEnabledAt: new Date(), totpSecretEnc: 'enc', recoveryCodes: JSON.stringify(['a', 'b', 'c']) } });

    // 普通用户不能使用管理接口
    expect((await request({ url: `${base}/security`, cookie: userCookie })).statusCode).toBe(403);
    const security = (await request({ url: `${base}/security`, cookie: adminCookie })).json();
    expect(security.twofa).toMatchObject({ enabled: true, recoveryRemaining: 3 });
    expect(security.passkeys.map((p: { name: string; deviceType: string }) => [p.name, p.deviceType])).toEqual([
      ['Laptop', 'singleDevice'],
      ['Phone', 'multiDevice'],
    ]);

    // 关闭两步验证：清除密钥与恢复码；再次关闭报错
    expect((await request({ method: 'POST', url: `${base}/2fa/disable`, cookie: adminCookie })).statusCode).toBe(200);
    expect(await db.user.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ totpEnabledAt: null, totpSecretEnc: null, recoveryCodes: '[]' });
    expect((await request({ method: 'POST', url: `${base}/2fa/disable`, cookie: adminCookie })).statusCode).toBe(400);

    // 删除单个（只能删除该用户的）与全部通行密钥
    const [laptop] = security.passkeys as { id: number }[];
    const otherUser = await db.user.findUniqueOrThrow({ where: { username: 'other' } });
    expect((await request({ method: 'DELETE', url: `/api/admin/users/${otherUser.id}/passkeys/${laptop!.id}`, cookie: adminCookie })).statusCode).toBe(404);
    expect((await request({ method: 'DELETE', url: `${base}/passkeys/${laptop!.id}`, cookie: adminCookie })).statusCode).toBe(200);
    expect((await request({ method: 'DELETE', url: `${base}/passkeys`, cookie: adminCookie })).json()).toEqual({ count: 1 });
    expect((await request({ url: `${base}/security`, cookie: adminCookie })).json()).toMatchObject({ twofa: { enabled: false }, passkeys: [] });
    expect(await db.activityLog.count({ where: { action: { in: ['admin.user_2fa_disable', 'admin.user_passkey_remove', 'admin.user_passkeys_remove'] } } })).toBe(3);
  });
});

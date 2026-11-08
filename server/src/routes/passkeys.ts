import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { LoginResultDTO, PasskeyDTO } from '../shared/index.ts';
import { config } from '../config.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { authGuard, idParam, logActivity, panelUrl, parse, requireUser } from '../lib/http.ts';
import { prisma, type Passkey } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';
import { getSettings } from '../lib/settings.ts';
import { parseUserAgent } from '../lib/ua.ts';
import { m, t } from '../i18n/index.ts';
import { finishLogin, requireOwnSession } from './auth.ts';

/** 每个账号最多保存的通行密钥数量 */
const MAX_PASSKEYS = 20;
/** 注册 / 登录挑战的有效期（秒） */
const CHALLENGE_TTL = 300;

const nameSchema = z.string().trim().min(1, m('passkey.nameRequired')).max(64, m('v.tooLong'));
// 浏览器返回的凭据原样交给 @simplewebauthn 校验，这里只检查结构
const credentialSchema = z.looseObject({ id: z.string().min(1).max(1024), rawId: z.string().max(1024), type: z.literal('public-key'), response: z.looseObject({}) });

/** 依赖方（RP）：域名取面板地址的主机名，浏览器会核对它与当前页面的域名 */
function relyingParty(req: FastifyRequest) {
  const url = new URL(panelUrl(req));
  return { rpID: url.hostname, origin: url.origin };
}

/** 稳定且不透露账号 ID 的 WebAuthn 用户句柄 */
const userHandle = (userId: number) => new Uint8Array(createHmac('sha256', config.APP_SECRET).update(`passkey-user:${userId}`).digest().subarray(0, 16));

/** 读出并作废挑战：同一个挑战只能用一次 */
async function takeChallenge(key: string) {
  const challenge = await redis.get(key);
  if (!challenge || !(await redis.del(key))) throw badRequest(t('passkey.challengeExpired'));
  return challenge;
}

export const toPasskey = (p: Passkey): PasskeyDTO => ({
  id: p.id,
  name: p.name,
  deviceType: p.deviceType === 'multiDevice' ? 'multiDevice' : 'singleDevice',
  backedUp: p.backedUp,
  createdAt: p.createdAt.toISOString(),
  lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
});

export default async function passkeyRoutes(app: FastifyInstance) {
  // ───────────── 账号设置：管理通行密钥 ─────────────

  app.get('/api/auth/passkeys', { preHandler: authGuard }, async (req): Promise<{ items: PasskeyDTO[] }> => {
    const user = requireUser(req);
    const rows = await prisma.passkey.findMany({ where: { userId: user.id }, orderBy: { id: 'asc' } });
    return { items: rows.map(toPasskey) };
  });

  /** 开始添加：生成注册选项，已有的凭据放进排除列表，避免同一个认证器重复添加 */
  app.post('/api/auth/passkeys/options', { preHandler: authGuard }, async (req) => {
    const user = requireOwnSession(req);
    const existing = await prisma.passkey.findMany({ where: { userId: user.id }, select: { credentialId: true, transports: true } });
    if (existing.length >= MAX_PASSKEYS) throw conflict(t('passkey.tooMany', { n: MAX_PASSKEYS }));
    const { rpID } = relyingParty(req);
    const options = await generateRegistrationOptions({
      rpName: (await getSettings()).siteName,
      rpID,
      userName: user.email,
      userDisplayName: user.name || user.username,
      userID: userHandle(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: JSON.parse(c.transports) as string[] })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    await redis.set(`passkey:reg:${user.id}`, options.challenge, 'EX', CHALLENGE_TTL);
    return options;
  });

  /** 完成添加：校验认证器返回的凭据并保存；未填写名称时用当前设备的系统和浏览器命名 */
  app.post('/api/auth/passkeys', { preHandler: authGuard, config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req): Promise<PasskeyDTO> => {
    const user = requireOwnSession(req);
    const body = parse(z.object({ response: credentialSchema, name: nameSchema.optional() }), req.body);
    const expectedChallenge = await takeChallenge(`passkey:reg:${user.id}`);
    const { rpID, origin } = relyingParty(req);
    const result = await verifyRegistrationResponse({
      response: body.response as unknown as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
    }).catch((error: unknown) => {
      req.log.warn({ err: error }, 'passkey registration rejected');
      throw badRequest(t('passkey.verifyFailed'));
    });
    if (!result.verified) throw badRequest(t('passkey.verifyFailed'));
    const info = result.registrationInfo;
    if (await prisma.passkey.findUnique({ where: { credentialId: info.credential.id } })) throw conflict(t('passkey.exists'));
    const ua = parseUserAgent(req.headers['user-agent']);
    const row = await prisma.passkey.create({
      data: {
        userId: user.id,
        credentialId: info.credential.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: BigInt(info.credential.counter),
        transports: JSON.stringify(info.credential.transports ?? []),
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        name: body.name ?? `${ua.os} · ${ua.browser}`,
      },
    });
    await logActivity(req, user.id, 'account.passkey_add', row.name);
    return toPasskey(row);
  });

  app.patch('/api/auth/passkeys/:id', { preHandler: authGuard }, async (req): Promise<PasskeyDTO> => {
    const user = requireOwnSession(req);
    const { id } = parse(idParam, req.params);
    const { name } = parse(z.object({ name: nameSchema }), req.body);
    const r = await prisma.passkey.updateMany({ where: { id, userId: user.id }, data: { name } });
    if (!r.count) throw notFound(t('passkey.notFound'));
    return toPasskey(await prisma.passkey.findUniqueOrThrow({ where: { id } }));
  });

  app.delete('/api/auth/passkeys/:id', { preHandler: authGuard }, async (req) => {
    const user = requireOwnSession(req);
    const { id } = parse(idParam, req.params);
    const row = await prisma.passkey.findFirst({ where: { id, userId: user.id } });
    if (!row) throw notFound(t('passkey.notFound'));
    await prisma.passkey.delete({ where: { id } });
    await logActivity(req, user.id, 'account.passkey_remove', row.name);
    return { ok: true };
  });

  // ───────────── 登录 ─────────────

  /** 登录选项：不指定账号，由浏览器列出本机保存的通行密钥（可发现凭据） */
  app.post('/api/auth/login/passkey/options', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { rpID } = relyingParty(req);
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
    const challengeId = randomBytes(16).toString('base64url');
    await redis.set(`passkey:auth:${challengeId}`, options.challenge, 'EX', CHALLENGE_TTL);
    return { challengeId, options };
  });

  /** 通行密钥本身就是“持有的设备 + 本机解锁”，登录时不再要求两步验证码 */
  app.post('/api/auth/login/passkey', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply): Promise<LoginResultDTO> => {
    const body = parse(z.object({ challengeId: z.string().min(16).max(64), response: credentialSchema }), req.body);
    const expectedChallenge = await takeChallenge(`passkey:auth:${body.challengeId}`);
    const passkey = await prisma.passkey.findUnique({ where: { credentialId: body.response.id }, include: { user: true } });
    if (!passkey) throw badRequest(t('passkey.unknown'));
    if (passkey.user.status !== 'ACTIVE') throw forbidden(t('auth.disabled'));
    const { rpID, origin } = relyingParty(req);
    const result = await verifyAuthenticationResponse({
      response: body.response as unknown as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
        counter: Number(passkey.counter),
        transports: JSON.parse(passkey.transports) as string[],
      },
      requireUserVerification: false,
    }).catch((error: unknown) => {
      req.log.warn({ err: error }, 'passkey authentication rejected');
      return null;
    });
    if (!result?.verified) {
      await logActivity(req, passkey.userId, 'auth.login_failed', 'passkey');
      throw badRequest(t('passkey.verifyFailed'));
    }
    await prisma.passkey.update({
      where: { id: passkey.id },
      data: { counter: BigInt(result.authenticationInfo.newCounter), backedUp: result.authenticationInfo.credentialBackedUp, lastUsedAt: new Date() },
    });
    return finishLogin(req, reply, passkey.userId, 'auth.login', `passkey: ${passkey.name}`);
  });
}

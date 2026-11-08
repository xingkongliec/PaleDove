// 实名认证接口：用户填写姓名和身份证号 → 支付宝「身份验证」刷脸 → 查询结果自动通过；
// 管理员只能查看记录、撤销认证和配置支付宝应用，不做人工审核。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RealNameInfoDTO } from '../shared/index.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { adminGuard, consoleGuard, idParam, logActivity, pageQuery, paging, panelUrl, parse, requireAdmin, requireUser } from '../lib/http.ts';
import { prisma, Prisma, type RealNameVerification } from '../lib/prisma.ts';
import { getSetting, setSetting, type RealnameSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { AlipayError, certifyConfig, certifyUrl, initializeCertify, queryCertify, signParams, type CertifyConfig } from '../services/realname/alipay-certify.ts';
import { idNumberError, idNumberHash, maskId, maskName, normalizeId, realNameError } from '../services/realname/realname.ts';

/** 支付宝 certify_id 的有效期约 24 小时，超过后需要重新发起 */
const CERTIFY_TTL_MS = 23 * 3_600_000;
/** 同一份信息在这段时间内重复发起时复用上一次的 certify_id，不再调用初始化接口 */
const REUSE_MS = 30 * 60_000;

/** 按用户计数（同一出口 IP 下的多个用户互不影响） */
const byUser = (req: FastifyRequest) => `realname:${req.user?.id ?? req.ip}`;

const unavailable = () => new AppError(503, 'REALNAME_UNAVAILABLE', t('realname.unavailable'));

/** 认证完成后支付宝跳回的页面 */
const returnUrl = (req: FastifyRequest) => `${panelUrl(req)}/account?tab=realname`;

function view(v: RealNameVerification | null, cfg: CertifyConfig | null): RealNameInfoDTO {
  if (!v) return { status: 'NONE', available: !!cfg };
  const pending = v.status === 'PENDING' && !!v.certifyId && Date.now() - v.submittedAt.getTime() < CERTIFY_TTL_MS;
  return {
    status: v.status,
    nameMasked: v.nameMasked,
    idNumberMasked: v.idNumberMasked,
    reason: v.reason,
    submittedAt: v.submittedAt.toISOString(),
    reviewedAt: v.reviewedAt?.toISOString() ?? null,
    available: !!cfg,
    // 认证中时给出（重新签名的）支付宝认证页地址，前端渲染成二维码
    certifyUrl: pending && cfg ? certifyUrl(cfg, v.certifyId!) : null,
  };
}

const alipayFail = (e: unknown) => (e instanceof AlipayError ? badRequest(e.message) : e);

/** 查询支付宝认证结果并更新记录（幂等；只更新仍处于 PENDING 且 certify_id 未变的记录） */
export async function refreshCertify(userId: number, cfg: CertifyConfig) {
  const v = await prisma.realNameVerification.findUnique({ where: { userId } });
  if (!v || v.status !== 'PENDING' || !v.certifyId) return v;
  const guard = { id: v.id, status: 'PENDING' as const, certifyId: v.certifyId };
  if (Date.now() - v.submittedAt.getTime() >= CERTIFY_TTL_MS) {
    await prisma.realNameVerification.updateMany({ where: guard, data: { status: 'REJECTED', reason: t('realname.expired'), reviewedAt: new Date() } });
    return prisma.realNameVerification.findUnique({ where: { userId } });
  }
  const r = await queryCertify(cfg, v.certifyId);
  if (!r.passed) return v; // 用户可能还没有完成刷脸，保持认证中
  // 同一证件已被其他账号认证通过（并发发起的情况）
  const taken = await prisma.realNameVerification.findFirst({ where: { idNumberHash: v.idNumberHash, userId: { not: userId }, status: 'APPROVED' } });
  await prisma.realNameVerification.updateMany({
    where: guard,
    data: taken ? { status: 'REJECTED', reason: t('realname.idTaken'), reviewedAt: new Date() } : { status: 'APPROVED', reason: null, reviewedAt: new Date() },
  });
  return prisma.realNameVerification.findUnique({ where: { userId } });
}

export default async function realnameRoutes(app: FastifyInstance) {
  app.get('/api/realname', { preHandler: consoleGuard }, async (req) => {
    const user = requireUser(req);
    const [v, s] = await Promise.all([prisma.realNameVerification.findUnique({ where: { userId: user.id } }), getSetting('realname')]);
    return view(v, certifyConfig(s));
  });

  /** 发起认证：校验姓名和证件号，调用支付宝初始化，返回认证页地址 */
  app.post('/api/realname', { preHandler: consoleGuard, config: { rateLimit: { max: 5, timeWindow: '1 day', keyGenerator: byUser } } }, async (req) => {
    const user = requireUser(req);
    const cfg = certifyConfig(await getSetting('realname'));
    if (!cfg) throw unavailable();
    const body = parse(z.object({ realName: z.string().max(64), idNumber: z.string().max(32) }), req.body);
    const nameErr = realNameError(body.realName);
    if (nameErr) throw badRequest(nameErr);
    const idErr = idNumberError(body.idNumber);
    if (idErr) throw badRequest(idErr);
    const id = normalizeId(body.idNumber);
    const name = body.realName.trim();
    const hash = idNumberHash(id);
    const prev = await prisma.realNameVerification.findUnique({ where: { userId: user.id } });
    if (prev?.status === 'APPROVED') throw conflict(t('realname.alreadyApproved'));
    // 刚发起过同一份信息：直接复用，避免重复调用支付宝（按次计费）
    if (prev?.status === 'PENDING' && prev.certifyId && prev.idNumberHash === hash && decrypt(prev.realNameEnc) === name && Date.now() - prev.submittedAt.getTime() < REUSE_MS) {
      return view(prev, cfg);
    }
    const taken = await prisma.realNameVerification.findFirst({ where: { idNumberHash: hash, userId: { not: user.id }, status: 'APPROVED' } });
    if (taken) throw conflict(t('realname.idTakenSubmit'));
    const { certifyId } = await initializeCertify(cfg, { realName: name, idNumber: id, returnUrl: returnUrl(req) }).catch((e) => {
      throw alipayFail(e);
    });
    const data = {
      realNameEnc: encrypt(name),
      idNumberEnc: encrypt(id),
      nameMasked: maskName(name),
      idNumberMasked: maskId(id),
      idNumberHash: hash,
      status: 'PENDING' as const,
      certifyId,
      reason: null,
      submittedAt: new Date(),
      reviewedAt: null,
      reviewerId: null,
    };
    const v = await prisma.realNameVerification.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
    await logActivity(req, user.id, 'realname.submit', v.nameMasked);
    return view(v, cfg);
  });

  /** 查询认证结果（前端在显示二维码期间轮询） */
  app.post('/api/realname/check', { preHandler: consoleGuard, config: { rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator: byUser } } }, async (req) => {
    const user = requireUser(req);
    const cfg = certifyConfig(await getSetting('realname'));
    if (!cfg) throw unavailable();
    const before = await prisma.realNameVerification.findUnique({ where: { userId: user.id }, select: { status: true } });
    const v = await refreshCertify(user.id, cfg).catch((e) => {
      throw alipayFail(e);
    });
    if (before?.status === 'PENDING' && v?.status === 'APPROVED') await logActivity(req, user.id, 'realname.approved', v.nameMasked);
    return view(v, cfg);
  });
}

/** 设置接口返回值：不返回私钥，只给出是否已配置 */
function publicSettings(s: RealnameSettings, req: FastifyRequest) {
  const { privateKeyEnc, ...rest } = s;
  return { ...rest, hasPrivateKey: !!privateKeyEnc, returnUrl: returnUrl(req) };
}

export async function adminRealnameRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/realname', async (req) => {
    const q = parse(pageQuery.extend({ q: z.string().trim().optional(), status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional() }), req.query);
    const where: Prisma.RealNameVerificationWhereInput = { ...(q.status ? { status: q.status } : {}), ...(q.q ? { user: { email: { contains: q.q } } } : {}) };
    const [items, total, counts] = await Promise.all([
      prisma.realNameVerification.findMany({
        where,
        orderBy: { submittedAt: 'desc' },
        ...paging(q),
        include: { user: { select: { id: true, email: true, username: true } } },
      }),
      prisma.realNameVerification.count({ where }),
      prisma.realNameVerification.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    return {
      items: items.map((v) => ({
        id: v.id,
        userId: v.userId,
        nameMasked: v.nameMasked,
        idNumberMasked: v.idNumberMasked,
        status: v.status,
        reason: v.reason,
        submittedAt: v.submittedAt.toISOString(),
        reviewedAt: v.reviewedAt?.toISOString() ?? null,
        user: v.user,
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    };
  });

  /** 查看完整的实名信息（解密），每次查看都会记录操作日志 */
  app.get('/api/admin/realname/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const v = await prisma.realNameVerification.findUnique({ where: { id }, include: { user: { select: { id: true, email: true, username: true, createdAt: true } } } });
    if (!v) throw notFound(t('realname.notFound'));
    await logActivity(req, admin.id, 'admin.realname_view', v.user.email);
    return {
      id: v.id,
      userId: v.userId,
      nameMasked: v.nameMasked,
      idNumberMasked: v.idNumberMasked,
      status: v.status,
      reason: v.reason,
      submittedAt: v.submittedAt.toISOString(),
      reviewedAt: v.reviewedAt?.toISOString() ?? null,
      user: { ...v.user, createdAt: v.user.createdAt.toISOString() },
      realName: decrypt(v.realNameEnc),
      idNumber: decrypt(v.idNumberEnc),
    };
  });

  /** 撤销已通过的认证（例如发现冒用），用户需要重新认证 */
  app.post('/api/admin/realname/:id/revoke', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(200).optional() }), req.body ?? {});
    if (!reason) throw badRequest(t('realname.reasonRequired'));
    const v = await prisma.realNameVerification.findUnique({ where: { id }, include: { user: { select: { email: true } } } });
    if (!v) throw notFound(t('realname.notFound'));
    const r = await prisma.realNameVerification.updateMany({ where: { id: v.id, status: 'APPROVED' }, data: { status: 'REJECTED', reason, reviewedAt: new Date(), reviewerId: admin.id } });
    if (!r.count) throw conflict(t('realname.revokeApprovedOnly'));
    await logActivity(req, admin.id, 'admin.realname_revoke', `${v.user.email}: ${reason}`);
    return { ok: true };
  });

  app.get('/api/admin/realname-settings', async (req) => publicSettings(await getSetting('realname'), req));

  app.put('/api/admin/realname-settings', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        enabled: z.boolean(),
        appId: z.string().trim().max(32).regex(/^\d*$/, t('realname.appIdDigits')),
        /** 留空表示不修改 */
        privateKey: z.string().trim().max(8192).optional(),
        alipayPublicKey: z.string().trim().max(4096),
        gateway: z.string().trim().url(t('realname.gatewayInvalid')).max(255),
        bizCode: z.enum(['FACE', 'CERT_PHOTO', 'CERT_PHOTO_FACE', 'SMART_FACE']),
      }),
      req.body,
    );
    const prev = await getSetting('realname');
    const privateKeyEnc = body.privateKey ? encrypt(body.privateKey) : prev.privateKeyEnc;
    if (body.enabled && (!body.appId || !privateKeyEnc || !body.alipayPublicKey)) throw badRequest(t('realname.configIncomplete'));
    const next: RealnameSettings = { enabled: body.enabled, appId: body.appId, privateKeyEnc, alipayPublicKey: body.alipayPublicKey, gateway: body.gateway, bizCode: body.bizCode };
    // 校验密钥格式，避免保存后用户发起认证时才报错
    try {
      if (body.privateKey) signParams({ test: '1' }, body.privateKey);
    } catch {
      throw badRequest(t('realname.privateKeyInvalid'));
    }
    await setSetting('realname', next);
    await logActivity(req, admin.id, 'admin.realname_settings', `${body.enabled ? 'on' : 'off'} · APPID ${body.appId || '-'}${body.privateKey ? ' · private key updated' : ''}`);
    return publicSettings(next, req);
  });

  /** 用一个不存在的 certify_id 调查询接口：能拿到验签通过的业务错误就说明 APPID / 密钥配置正确 */
  app.post('/api/admin/realname-settings/test', async () => {
    const s = await getSetting('realname');
    const cfg = certifyConfig({ ...s, enabled: true });
    if (!cfg) throw badRequest(t('realname.saveFirst'));
    try {
      await queryCertify(cfg, 'paledove-config-test');
      return { ok: true, message: t('realname.testOk') };
    } catch (e) {
      if (e instanceof AlipayError && e.code === '40004') return { ok: true, message: t('realname.testOkWith', { message: e.message }) };
      if (e instanceof AlipayError && e.subCode === 'isv.insufficient-isv-permissions') throw badRequest(t('realname.noPermission'));
      throw alipayFail(e);
    }
  });
}

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EPAY_METHODS, PAYMENT_STATUSES, type PayChannelsViewDTO } from '../shared/index.ts';
import { adminGuard, consoleGuard, ensureFound, idParam, logActivity, pageQuery, paging, panelUrl, parse, requireAdmin, requireUser } from '../lib/http.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { containsInsensitive, prisma, type Prisma } from '../lib/prisma.ts';
import { m, t } from '../i18n/index.ts';
import { signV2 } from '../services/payments/epay.ts';
import { cnyRate } from '../services/payments/fx.ts';
import { verifyHeleketWebhook } from '../services/payments/heleket.ts';
import {
  adminCompletePayment,
  channelConfigured,
  confirmHeleketOrder,
  confirmStripeSession,
  createPayment,
  handleEpayNotify,
  maskedChannel,
  payChannels,
  paymentCallbacks,
  paymentNames,
  paymentOptions,
  refreshPayment,
  savePayChannels,
  stripeWebhookSecrets,
  verifyHeleketNotify,
  type PayChannelConfig,
} from '../services/payments/payments.ts';
import { verifyStripeWebhook } from '../services/payments/stripe.ts';
import { toPayment } from '../services/serializers.ts';

/** 用户充值接口 */
export async function paymentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);

  app.get('/api/payments/options', async () => paymentOptions());

  app.get('/api/payments', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery, req.query);
    const where = { userId: user.id };
    const [items, total, names] = await Promise.all([
      prisma.payment.findMany({ where, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.payment.count({ where }),
      paymentNames(),
    ]);
    return { items: items.map((p) => toPayment(p, names(p))), total, ...q };
  });

  app.post('/api/payments', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        channelId: z.string().min(1).max(64),
        method: z.string().min(1).max(16),
        amount: z.coerce.number({ message: m('v.amount') }).positive(m('v.amount')),
        device: z.enum(['pc', 'mobile']).default('pc'),
      }),
      req.body,
    );
    const result = await createPayment(user, body, { base: panelUrl(req), clientIp: req.ip });
    const fee = Number(result.fee) > 0 ? ` (+${result.fee})` : '';
    await logActivity(req, user.id, 'billing.recharge_create', `${body.method} ${result.amount}${fee} ${result.no}`);
    return result;
  });

  // 查询订单：仍待支付时向网关确认一次（支付完成跳回、点“我已完成支付”时调用）
  app.get('/api/payments/:no', async (req) => {
    const user = requireUser(req);
    const { no } = parse(z.object({ no: z.string().min(1).max(64) }), req.params);
    const payment = ensureFound(await prisma.payment.findFirst({ where: { no, userId: user.id } }), t('pay.notFound'));
    const fresh = await refreshPayment(payment);
    return toPayment(fresh, (await paymentNames())(fresh));
  });
}

/** 支付网关回调（无需登录，按订单所属渠道的密钥验签） */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  // 保留原始报文用于验签
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/api/pay/stripe/webhook', async (req, reply) => {
    const secrets = await stripeWebhookSecrets();
    if (!secrets.length) return reply.status(400).send({ error: 'STRIPE_NOT_CONFIGURED' });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
    // 每个 Stripe 渠道有自己的签名密钥，逐个尝试
    let event: ReturnType<typeof verifyStripeWebhook> | undefined;
    let error = '';
    for (const secret of secrets) {
      try {
        event = verifyStripeWebhook(raw, req.headers['stripe-signature'] as string | undefined, secret);
        break;
      } catch (e) {
        error = (e as Error).message;
      }
    }
    if (!event) {
      req.log.warn(`stripe webhook rejected: ${error}`);
      return reply.status(400).send({ error: 'INVALID_SIGNATURE' });
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      try {
        await confirmStripeSession(event.data.object);
      } catch (e) {
        // 返回 500 让 Stripe 稍后重试
        req.log.error(e, 'stripe webhook failed');
        return reply.status(500).send({ error: 'FAILED' });
      }
    }
    return { received: true };
  });

  // Heleket：入账以查询接口的结果为准；签名不对的直接丢弃（/webhook 为旧地址，保留兼容）
  const heleket = async (req: { body: unknown; log: FastifyInstance['log'] }, reply: { status: (code: number) => { send: (v: unknown) => unknown } }) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '{}') as Record<string, unknown>;
    } catch {
      /* 非 JSON */
    }
    if (!(await verifyHeleketNotify(body, verifyHeleketWebhook))) {
      req.log.warn({ orderId: body.order_id }, 'heleket notify rejected');
      return reply.status(400).send({ error: 'INVALID_SIGNATURE' });
    }
    try {
      await confirmHeleketOrder(String(body.order_id));
    } catch (e) {
      req.log.error(e, 'heleket notify failed');
      return reply.status(500).send({ error: 'FAILED' });
    }
    return { ok: true };
  };
  app.post('/api/pay/heleket/notify', heleket);
  app.post('/api/pay/heleket/webhook', heleket);

  const epayParams = (req: { query: unknown; body: unknown }): Record<string, string> => {
    const src = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : req.query;
    return Object.fromEntries(Object.entries((src ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]));
  };

  app.route({
    method: ['GET', 'POST'],
    url: '/api/pay/epay/notify',
    handler: async (req, reply) => {
      try {
        if (await handleEpayNotify(epayParams(req))) return reply.type('text/plain').send('success');
        req.log.warn('epay notify rejected');
      } catch (e) {
        req.log.error(e, 'epay notify failed');
      }
      return reply.type('text/plain').send('fail');
    },
  });

  // 同步跳转：验签后尝试入账，再回到面板充值页
  app.get('/api/pay/epay/return', async (req, reply) => {
    const params = epayParams(req);
    const payment = await handleEpayNotify(params).catch((e) => {
      req.log.error(e, 'epay return failed');
      return null;
    });
    const base = panelUrl(req);
    const no = payment?.no ?? (/^P\d{20}$/.test(params.out_trade_no ?? '') ? params.out_trade_no : '');
    return reply.redirect(no ? `${base}/billing?payment=${no}` : `${base}/billing`);
  });
}

// ───────── 管理端：支付渠道 ─────────

const percent = z.number().min(0, m('pay.feeNegative')).max(100, m('pay.feeMax'));
const currency = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/, m('pay.currencyFormat'))
  .transform((v) => v.toUpperCase());
const secret = (max: number) => z.string().trim().max(max).optional();
const base = {
  name: z.string().trim().min(1, m('pay.nameRequired')).max(32),
  enabled: z.boolean(),
  sort: z.number().int().min(0).max(9999),
  minAmount: z.number().min(0.01, m('pay.minAmountMin')).max(1_000_000),
  maxAmount: z.number().min(0).max(10_000_000),
  feeFixed: z.number().min(0, m('pay.feeNegative')).max(10_000),
};

const channelSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('epay'),
    ...base,
    version: z.enum(['v1', 'v2']),
    mode: z.enum(['submit', 'api']),
    apiUrl: z.string().trim().max(255).refine((v) => !v || /^https?:\/\//.test(v), m('pay.urlFormat')),
    pid: z.string().trim().max(64),
    key: secret(256),
    merchantPrivateKey: z.string().max(8192).optional(),
    platformPublicKey: z.string().max(8192),
    methods: z.array(z.object({ method: z.enum(EPAY_METHODS), enabled: z.boolean(), feePercent: percent })),
  }),
  z.object({ type: z.literal('stripe'), ...base, feePercent: percent, currency, secretKey: secret(256), webhookSecret: secret(256) }),
  z.object({
    type: z.literal('heleket'),
    ...base,
    feePercent: percent,
    currency,
    merchantId: z.string().trim().max(64),
    apiKey: secret(512),
    lifetime: z.number().int().min(300, m('pay.lifetimeRange')).max(43200, m('pay.lifetimeRange')),
  }),
]);
type ChannelBody = z.infer<typeof channelSchema>;

async function view(baseUrl: string): Promise<PayChannelsViewDTO> {
  return { channels: (await payChannels()).map(maskedChannel), urls: paymentCallbacks(baseUrl) };
}

const enc = (plain: string | undefined, current: string | undefined) => (plain ? encrypt(plain) : (current ?? ''));

/** 表单 → 渠道配置：密钥不填沿用原值 */
function build(id: string, body: ChannelBody, cur: PayChannelConfig | undefined): PayChannelConfig {
  const common = { id, name: body.name, enabled: body.enabled, sort: body.sort, minAmount: body.minAmount, maxAmount: body.maxAmount, feeFixed: body.feeFixed };
  switch (body.type) {
    case 'epay': {
      const old = cur?.type === 'epay' ? cur : undefined;
      // 支付方式按固定顺序保存，缺的补上（停用）
      const methods = EPAY_METHODS.map((method) => body.methods.find((x) => x.method === method) ?? { method, enabled: false, feePercent: 0 });
      return {
        ...common, type: 'epay', version: body.version, mode: body.mode, apiUrl: body.apiUrl.replace(/\/+$/, ''), pid: body.pid, platformPublicKey: body.platformPublicKey, methods,
        keyEnc: enc(body.key, old?.keyEnc), merchantPrivateKeyEnc: enc(body.merchantPrivateKey?.trim(), old?.merchantPrivateKeyEnc),
      };
    }
    case 'stripe': {
      const old = cur?.type === 'stripe' ? cur : undefined;
      return { ...common, type: 'stripe', feePercent: body.feePercent, currency: body.currency, secretKeyEnc: enc(body.secretKey, old?.secretKeyEnc), webhookSecretEnc: enc(body.webhookSecret, old?.webhookSecretEnc) };
    }
    case 'heleket': {
      const old = cur?.type === 'heleket' ? cur : undefined;
      return { ...common, type: 'heleket', feePercent: body.feePercent, currency: body.currency, merchantId: body.merchantId, lifetime: body.lifetime, apiKeyEnc: enc(body.apiKey, old?.apiKeyEnc) };
    }
  }
}

async function validate(c: PayChannelConfig, body: ChannelBody) {
  if (c.maxAmount > 0 && c.minAmount > c.maxAmount) throw badRequest(t('pay.minGtMax'));
  if (body.type === 'stripe') {
    if (body.secretKey && !/^(sk|rk)_(live|test)_/.test(body.secretKey)) throw badRequest(t('pay.stripeKeyFormat'));
    if (body.webhookSecret && !body.webhookSecret.startsWith('whsec_')) throw badRequest(t('pay.stripeWebhookFormat'));
  }
  if (c.type === 'epay' && c.version === 'v2' && c.merchantPrivateKeyEnc) {
    try {
      signV2({ a: 1 }, decrypt(c.merchantPrivateKeyEnc));
    } catch {
      throw badRequest(t('pay.privateKeyFormat'));
    }
  }
  if (!c.enabled) return;
  if (!channelConfigured(c)) throw badRequest(t(c.type === 'epay' ? (c.version === 'v1' ? 'pay.incompleteEpayV1' : 'pay.incompleteEpayV2') : c.type === 'stripe' ? 'pay.incompleteStripe' : 'pay.incompleteHeleket'));
  if (c.type === 'epay' && !c.methods.some((x) => x.enabled)) throw badRequest(t('pay.methodRequired'));
  if (c.type !== 'epay' && c.currency !== 'CNY') {
    await cnyRate(c.currency).catch((e: Error) => {
      throw badRequest(t('pay.fxUnavailable', { currency: c.currency, message: e.message }));
    });
  }
}

const channelIdParam = z.object({ id: z.string().min(1).max(64) });

/** 管理端：支付渠道与充值记录 */
export async function adminPaymentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/pay-channels', async (req) => view(panelUrl(req)));

  app.post('/api/admin/pay-channels', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(channelSchema, req.body);
    const channels = await payChannels();
    const c = build(randomUUID().replace(/-/g, '').slice(0, 12), body, undefined);
    await validate(c, body);
    await savePayChannels([...channels, c]);
    await logActivity(req, admin.id, 'admin.pay_channel_create', c.name);
    return view(panelUrl(req));
  });

  app.put('/api/admin/pay-channels/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(channelIdParam, req.params);
    const body = parse(channelSchema, req.body);
    const channels = await payChannels();
    const cur = channels.find((c) => c.id === id);
    if (!cur) throw notFound(t('pay.channelNotFound'));
    if (cur.type !== body.type) throw badRequest(t('pay.typeLocked'));
    const c = build(id, body, cur);
    await validate(c, body);
    await savePayChannels(channels.map((x) => (x.id === id ? c : x)));
    await logActivity(req, admin.id, 'admin.pay_channel_update', c.name);
    return view(panelUrl(req));
  });

  app.put('/api/admin/pay-channels/:id/enabled', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(channelIdParam, req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const channels = await payChannels();
    const cur = channels.find((c) => c.id === id);
    if (!cur) throw notFound(t('pay.channelNotFound'));
    if (enabled && !channelConfigured(cur)) throw badRequest(t('pay.channelIncomplete'));
    await savePayChannels(channels.map((x) => (x.id === id ? { ...x, enabled } : x)));
    await logActivity(req, admin.id, enabled ? 'admin.pay_channel_enable' : 'admin.pay_channel_disable', cur.name);
    return view(panelUrl(req));
  });

  app.delete('/api/admin/pay-channels/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(channelIdParam, req.params);
    const channels = await payChannels();
    const cur = channels.find((c) => c.id === id);
    if (!cur) throw notFound(t('pay.channelNotFound'));
    await savePayChannels(channels.filter((c) => c.id !== id));
    await logActivity(req, admin.id, 'admin.pay_channel_delete', cur.name);
    return view(panelUrl(req));
  });

  app.get('/api/admin/payments', async (req) => {
    const q = parse(
      pageQuery.extend({
        status: z.enum(PAYMENT_STATUSES).optional(),
        gateway: z.string().max(20).optional(),
        q: z.string().trim().max(100).optional(),
      }),
      req.query,
    );
    const where: Prisma.PaymentWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.gateway ? { gateway: q.gateway } : {}),
      ...(q.q
        ? {
            OR: [
              { no: { contains: q.q } },
              { externalId: { contains: q.q } },
              { user: { username: containsInsensitive(q.q) } },
              { user: { email: containsInsensitive(q.q) } },
            ],
          }
        : {}),
    };
    const [items, total, paid, names] = await Promise.all([
      prisma.payment.findMany({ where, orderBy: { id: 'desc' }, include: { user: { select: { id: true, username: true } } }, ...paging(q) }),
      prisma.payment.count({ where }),
      prisma.payment.aggregate({ where: { ...where, status: 'PAID' }, _sum: { amount: true } }),
      paymentNames(),
    ]);
    return { items: items.map((p) => toPayment(p, names(p))), total, page: q.page, pageSize: q.pageSize, paidAmount: paid._sum.amount?.toFixed(2) ?? '0.00' };
  });

  app.post('/api/admin/payments/:id/complete', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    await adminCompletePayment(id);
    await logActivity(req, admin.id, 'admin.payment_complete', String(id));
    const p = await prisma.payment.findUniqueOrThrow({ where: { id }, include: { user: { select: { id: true, username: true } } } });
    return toPayment(p, (await paymentNames())(p));
  });
}

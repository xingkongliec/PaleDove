import { randomInt } from 'node:crypto';
import {
  DEFAULT_LOCALE,
  EPAY_METHODS,
  normalizeLocale,
  type CreatePaymentResultDTO,
  type EpayMethod,
  type PayActionDTO,
  type PayChannelDTO,
  type PayOptionDTO,
  type PayOptionsDTO,
} from '../../shared/index.ts';
import { decrypt } from '../../lib/crypto.ts';
import { badRequest, errorMessage, notFound } from '../../lib/errors.ts';
import { prisma, Prisma, type Payment } from '../../lib/prisma.ts';
import { redis } from '../../lib/redis.ts';
import { getInternal, getSettings, setInternal } from '../../lib/settings.ts';
import { isMessageKey, runWithLocale, t } from '../../i18n/index.ts';
import { changeBalance } from '../billing.ts';
import { addAffCredit } from '../aff.ts';
import { EpayClient, type Params } from './epay.ts';
import { cnyRate, peekCnyRate } from './fx.ts';
import { HELEKET_PAID, HeleketClient } from './heleket.ts';
import { StripeClient, stripeDecimals, type StripeSession } from './stripe.ts';

// 支付渠道：易支付（支付宝 / 微信 / QQ 钱包，人民币）、Stripe（银行卡等）、Heleket（加密货币），每种都可以配置多个渠道。
// 订单金额（Payment.amount）是到账的余额，fee 是手续费，用户实际支付 amount + fee；
// 计价货币不是 CNY 的渠道按实时汇率换算（services/fx.ts），实际收取的外币金额记在 payAmount / currency。
// 订单记下 channelId，回调 / 查询都按订单所属渠道的密钥验签（渠道停用后已下的订单仍能入账）。
// Stripe / Heleket 的会话 ID / 发票 UUID 下单时就写进 externalId，入账前核对回调 / 查询结果属于这张订单。

/** 待支付订单的有效期，超时后标记为过期 */
export const PAYMENT_TTL_MS = 24 * 3600_000;

const CHANNELS_KEY = 'payment.channels';
/** 旧版单个网关的配置（迁移成渠道后不再使用） */
const LEGACY_KEY = 'payment.config';

interface ChannelBase {
  id: string;
  name: string;
  enabled: boolean;
  sort: number;
  minAmount: number;
  /** 0 = 不限 */
  maxAmount: number;
  feeFixed: number;
}

export interface EpayChannel extends ChannelBase {
  type: 'epay';
  version: 'v1' | 'v2';
  mode: 'submit' | 'api';
  apiUrl: string;
  pid: string;
  /** v1 商户密钥（加密） */
  keyEnc: string;
  /** v2 商户私钥（加密） */
  merchantPrivateKeyEnc: string;
  /** v2 平台公钥 */
  platformPublicKey: string;
  methods: Array<{ method: EpayMethod; enabled: boolean; feePercent: number }>;
}

export interface StripeChannel extends ChannelBase {
  type: 'stripe';
  feePercent: number;
  currency: string;
  secretKeyEnc: string;
  webhookSecretEnc: string;
}

export interface HeleketChannel extends ChannelBase {
  type: 'heleket';
  feePercent: number;
  currency: string;
  merchantId: string;
  apiKeyEnc: string;
  lifetime: number;
}

export type PayChannelConfig = EpayChannel | StripeChannel | HeleketChannel;
type ChannelOf<T extends PayChannelConfig['type']> = Extract<PayChannelConfig, { type: T }>;

/** 支付方式与商户自定义的渠道名称分别展示。 */
const methodLabel = (method: string) => {
  const key = `pay.channel.${method}`;
  return isMessageKey(key) ? t(key) : method;
};

/** 渠道的接口参数是否填写完整 */
export function channelConfigured(c: PayChannelConfig) {
  switch (c.type) {
    case 'epay':
      return !!c.apiUrl && !!c.pid && (c.version === 'v1' ? !!c.keyEnc : !!c.merchantPrivateKeyEnc && !!c.platformPublicKey);
    case 'stripe':
      return !!c.secretKeyEnc && !!c.webhookSecretEnc && !!c.currency;
    case 'heleket':
      return !!c.merchantId && !!c.apiKeyEnc && !!c.currency;
  }
}

type LegacyConfig = {
  minAmount?: number;
  maxAmount?: number;
  stripe?: { enabled?: boolean; name?: string; secretKey?: string; webhookSecret?: string; currency?: string };
  heleket?: { enabled?: boolean; name?: string; merchantId?: string; apiKey?: string; lifetime?: number; currency?: string };
  epay?: { enabled?: boolean; name?: string; apiUrl?: string; pid?: string; key?: string; channels?: Array<{ id: string; enabled: boolean }> };
};

/** 旧版只有单个的易支付 / Stripe / Heleket 设置：转换成渠道，id 固定为 legacy-<类型>，没有 channelId 的旧订单按网关对应过去 */
async function migrateLegacy(): Promise<PayChannelConfig[]> {
  const p = await getInternal<LegacyConfig>(LEGACY_KEY);
  if (!p) return [];
  const limits = { minAmount: p.minAmount ?? 1, maxAmount: p.maxAmount ?? 0, feeFixed: 0 };
  const out: PayChannelConfig[] = [];
  const e = p.epay;
  if (e && (e.apiUrl || e.pid)) {
    const on = (e.channels ?? []).filter((c) => c.enabled).map((c) => c.id);
    out.push({
      id: 'legacy-epay', type: 'epay', name: e.name || methodLabel('epay'), enabled: !!e.enabled, sort: 0, ...limits,
      version: 'v1', mode: 'submit', apiUrl: e.apiUrl ?? '', pid: e.pid ?? '', keyEnc: e.key ?? '', merchantPrivateKeyEnc: '', platformPublicKey: '',
      methods: EPAY_METHODS.map((method) => ({ method, enabled: on.includes(method), feePercent: 0 })),
    });
  }
  const s = p.stripe;
  if (s?.secretKey) {
    out.push({ id: 'legacy-stripe', type: 'stripe', name: s.name || 'Stripe', enabled: !!s.enabled, sort: 1, ...limits, feePercent: 0, currency: (s.currency || 'CNY').toUpperCase(), secretKeyEnc: s.secretKey, webhookSecretEnc: s.webhookSecret ?? '' });
  }
  const h = p.heleket;
  if (h?.merchantId) {
    out.push({ id: 'legacy-heleket', type: 'heleket', name: h.name || methodLabel('heleket'), enabled: !!h.enabled, sort: 2, ...limits, feePercent: 0, currency: (h.currency || 'USD').toUpperCase(), merchantId: h.merchantId, apiKeyEnc: h.apiKey ?? '', lifetime: h.lifetime ?? 3600 });
  }
  return out;
}

let cache: { value: PayChannelConfig[]; at: number } | null = null;

/** 全部支付渠道（含停用的），按 sort 排序 */
export async function payChannels(): Promise<PayChannelConfig[]> {
  if (cache && Date.now() - cache.at < 5_000) return cache.value;
  const cfg = await getInternal<{ migrated: boolean; channels: PayChannelConfig[] }>(CHANNELS_KEY);
  let channels = cfg?.channels ?? [];
  if (!cfg?.migrated) {
    channels = await migrateLegacy();
    await setInternal(CHANNELS_KEY, { migrated: true, channels });
  }
  const value = [...channels].sort((a, b) => a.sort - b.sort);
  cache = { value, at: Date.now() };
  return value;
}

export async function savePayChannels(channels: PayChannelConfig[]) {
  await setInternal(CHANNELS_KEY, { migrated: true, channels });
  cache = null;
}

/** 返回给管理端：去掉加密字段，只标出是否已配置 */
export function maskedChannel(c: PayChannelConfig): PayChannelDTO {
  switch (c.type) {
    case 'epay': {
      const { keyEnc, merchantPrivateKeyEnc, ...rest } = c;
      return { ...rest, hasKey: !!keyEnc, hasPrivateKey: !!merchantPrivateKeyEnc };
    }
    case 'stripe': {
      const { secretKeyEnc, webhookSecretEnc, ...rest } = c;
      return { ...rest, hasSecretKey: !!secretKeyEnc, hasWebhookSecret: !!webhookSecretEnc };
    }
    case 'heleket': {
      const { apiKeyEnc, ...rest } = c;
      return { ...rest, hasApiKey: !!apiKeyEnc };
    }
  }
}

/** 回调地址：Stripe 的要填到 Stripe 后台，易支付 / Heleket 下单时自动带上 */
export const paymentCallbacks = (base: string) => ({
  epayNotify: `${base}/api/pay/epay/notify`,
  stripeWebhook: `${base}/api/pay/stripe/webhook`,
  heleketNotify: `${base}/api/pay/heleket/notify`,
});

// ───────── 支付方式 ─────────

function channelOptions(c: PayChannelConfig): Omit<PayOptionDTO, 'rate'>[] {
  const base = { channelId: c.id, feeFixed: c.feeFixed, minAmount: c.minAmount, maxAmount: c.maxAmount };
  if (c.type === 'epay') {
    return c.methods.filter((m) => m.enabled).map((m) => ({ ...base, method: m.method, label: methodLabel(m.method), feePercent: m.feePercent, currency: 'CNY' }));
  }
  return [{ ...base, method: c.type, label: c.name, feePercent: c.feePercent, currency: c.currency }];
}

/** 用户可用的充值方式 */
export async function paymentOptions(): Promise<PayOptionsDTO> {
  const channels = (await payChannels()).filter((c) => c.enabled && channelConfigured(c));
  const options: PayOptionDTO[] = await Promise.all(channels.flatMap(channelOptions).map(async (o) => ({ ...o, rate: await peekCnyRate(o.currency) })));
  // 多个易支付渠道都开了同一种支付方式时，后面带上渠道名称区分
  const count = new Map<string, number>();
  for (const o of options) count.set(o.label, (count.get(o.label) ?? 0) + 1);
  for (const o of options) {
    if (count.get(o.label)! > 1 && (EPAY_METHODS as readonly string[]).includes(o.method)) o.label = `${o.label} · ${channels.find((c) => c.id === o.channelId)!.name}`;
  }
  return { enabled: options.length > 0, options };
}

/** 下单时选择的渠道和支付方式（必须是当前可用的） */
async function resolveOption(channelId: string, method: string) {
  const channel = (await payChannels()).find((c) => c.id === channelId && c.enabled && channelConfigured(c));
  const option = channel && channelOptions(channel).find((o) => o.method === method);
  if (!channel || !option) throw badRequest(t('pay.disabled'));
  return { channel, option };
}

/** 手续费 = 金额 × 费率% + 固定费用，向上取到分 */
export const feeOf = (amount: Prisma.Decimal | number | string, percent: number, fixed: number) =>
  new Prisma.Decimal(amount).mul(percent).div(100).plus(fixed).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP);

/** 外币实际收取的金额：人民币金额 × 汇率（1 元折合多少外币），向上取到该货币的最小单位（不少收） */
export const foreignCharge = (cny: Prisma.Decimal | number | string, rate: number, decimals = 2) =>
  new Prisma.Decimal(cny).mul(rate).toDecimalPlaces(decimals, Prisma.Decimal.ROUND_UP);

/** 用户实际支付的人民币金额 */
const payable = (p: Pick<Payment, 'amount' | 'fee'>) => new Prisma.Decimal(p.amount).plus(p.fee);

/** 订单所属的渠道（停用的也算）；旧订单没有 channelId，按网关对应到转换出来的 legacy-<类型> 渠道 */
async function orderChannel<T extends PayChannelConfig['type']>(p: Pick<Payment, 'channelId' | 'gateway'>, type: T): Promise<ChannelOf<T>> {
  const id = p.channelId ?? `legacy-${p.gateway}`;
  const c = (await payChannels()).find((x) => x.id === id);
  if (!c || c.type !== type) throw new Error(t('pay.channelDeleted'));
  return c as ChannelOf<T>;
}

/** 订单列表显示用：支付方式名称和所属渠道名称 */
export async function paymentNames(): Promise<(p: Pick<Payment, 'channelId' | 'gateway' | 'channel'>) => { methodName: string; channelName: string | null }> {
  const channels = await payChannels();
  return (p) => {
    const c = channels.find((x) => x.id === (p.channelId ?? `legacy-${p.gateway}`));
    const method = p.channel ?? p.gateway;
    return { methodName: methodLabel(method), channelName: c?.name ?? p.channelId ?? p.gateway };
  };
}

// ───────── 创建订单 ─────────

function paymentNo(): string {
  const d = new Date();
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `P${stamp}${p(randomInt(1_000_000), 6)}`;
}

export async function createPayment(
  user: { id: number; email: string },
  body: { channelId: string; method: string; amount: number; device: 'pc' | 'mobile' },
  ctx: { base: string; clientIp: string },
): Promise<CreatePaymentResultDTO> {
  if (!/^https?:\/\//.test(ctx.base)) throw badRequest(t('pay.panelUrlMissing'));
  const { channel, option } = await resolveOption(body.channelId, body.method);
  const settings = await getSettings();
  const amount = new Prisma.Decimal(body.amount).toDecimalPlaces(2);
  if (amount.lt(option.minAmount)) throw badRequest(t('pay.minAmount', { amount: `${settings.currency}${option.minAmount}` }));
  if (option.maxAmount > 0 && amount.gt(option.maxAmount)) throw badRequest(t('pay.maxAmount', { amount: `${settings.currency}${option.maxAmount}` }));
  const fee = feeOf(amount, option.feePercent, option.feeFixed);
  const payment = await prisma.payment.create({
    data: {
      no: paymentNo(),
      userId: user.id,
      gateway: channel.type,
      channel: option.method,
      channelId: channel.id,
      amount,
      fee,
      payAmount: amount.plus(fee),
      currency: 'CNY',
    },
  });
  try {
    const action = await startPayment(payment, { name: t('pay.itemName', { site: settings.siteName }), email: user.email, ...ctx, device: body.device });
    if (action.kind === 'redirect') await prisma.payment.update({ where: { id: payment.id }, data: { payUrl: action.url } });
    return { no: payment.no, amount: amount.toFixed(2), fee: fee.toFixed(2), action };
  } catch (err) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', raw: { error: errorMessage(err) } } });
    throw badRequest(t('pay.createFailed', { message: errorMessage(err) }));
  }
}

/** 支付结果页（网关付款完成 / 取消后跳回） */
const backUrl = (base: string, p: Payment, canceled = false) => `${base}/billing?payment=${p.no}${canceled ? '&canceled=1' : ''}`;

/** 向订单的渠道发起支付，返回前端要执行的动作（跳转 / 提交表单 / 二维码 / 页面） */
async function startPayment(p: Payment, ctx: { name: string; email: string; base: string; clientIp: string; device: 'pc' | 'mobile' }): Promise<PayActionDTO> {
  if (p.gateway === 'stripe') {
    const c = await orderChannel(p, 'stripe');
    const decimals = stripeDecimals(c.currency);
    const charge = foreignCharge(payable(p), await cnyRate(c.currency), decimals);
    const s = await new StripeClient(decrypt(c.secretKeyEnc)).createCheckout({
      outTradeNo: p.no,
      name: ctx.name,
      currency: c.currency,
      minorAmount: charge.mul(10 ** decimals).toNumber(),
      successUrl: backUrl(ctx.base, p),
      cancelUrl: backUrl(ctx.base, p, true),
      email: ctx.email,
    });
    await prisma.payment.update({ where: { id: p.id }, data: { externalId: s.id, payAmount: charge, currency: c.currency } });
    return { kind: 'redirect', url: s.url };
  }
  if (p.gateway === 'heleket') {
    const c = await orderChannel(p, 'heleket');
    const charge = foreignCharge(payable(p), await cnyRate(c.currency));
    const inv = await new HeleketClient(c.merchantId, decrypt(c.apiKeyEnc)).createInvoice({
      orderId: p.no,
      amount: charge.toFixed(2),
      currency: c.currency,
      lifetime: c.lifetime,
      urlCallback: paymentCallbacks(ctx.base).heleketNotify,
      urlReturn: backUrl(ctx.base, p, true),
      urlSuccess: backUrl(ctx.base, p),
    });
    if (!inv.url) throw new Error(t('pay.heleketNoUrl'));
    await prisma.payment.update({ where: { id: p.id }, data: { externalId: inv.uuid, payAmount: charge, currency: c.currency } });
    return { kind: 'redirect', url: inv.url };
  }
  const c = await orderChannel(p, 'epay');
  return new EpayClient(c).createPayment({
    outTradeNo: p.no,
    name: ctx.name,
    money: payable(p).toFixed(2),
    type: p.channel ?? 'alipay',
    notifyUrl: paymentCallbacks(ctx.base).epayNotify,
    returnUrl: `${ctx.base}/api/pay/epay/return`,
    clientIp: ctx.clientIp,
    device: ctx.device,
  });
}

// ───────── 入账 ─────────

/**
 * 订单入账（幂等）：仅首次将状态从非 PAID 改为 PAID 的调用会加余额。money 是网关通知的实付金额（人民币），要等于金额 + 手续费。
 * 返回 true 表示本次完成了入账。
 */
export async function completePayment(no: string, extra: { externalId?: string | null; money?: string; raw?: unknown } = {}): Promise<boolean> {
  const payment = await prisma.payment.findUnique({ where: { no }, include: { user: { select: { locale: true } } } });
  if (!payment || payment.status === 'PAID') return false;
  if (extra.money !== undefined && !new Prisma.Decimal(extra.money).eq(payable(payment))) {
    await prisma.payment.update({ where: { id: payment.id }, data: { raw: { mismatch: true, money: extra.money } } });
    throw new Error(t('pay.amountMismatch', { expected: payable(payment).toFixed(2), actual: extra.money }));
  }
  const names = await paymentNames();
  const locale = normalizeLocale(payment.user.locale) ?? DEFAULT_LOCALE;
  return runWithLocale(locale, () =>
    prisma.$transaction(async (tx) => {
      const res = await tx.payment.updateMany({
        where: { id: payment.id, status: { not: 'PAID' } },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          ...(extra.externalId ? { externalId: extra.externalId } : {}),
          ...(extra.raw !== undefined ? { raw: JSON.parse(JSON.stringify(extra.raw)) as Prisma.InputJsonValue } : {}),
        },
      });
      if (res.count === 0) return false;
      await changeBalance(tx, payment.userId, payment.amount, 'RECHARGE', t('log.recharge', { method: names(payment).methodName, no: payment.no }));
      // 支付渠道实际到账的金额（不含手续费）计入可返佣额度
      await addAffCredit(tx, payment.userId, payment.amount);
      return true;
    }),
  );
}

/** 易支付异步通知 / 同步跳转：按订单所属渠道验签，支付成功则入账。返回签名有效的订单 */
export async function handleEpayNotify(params: Params): Promise<Payment | null> {
  const payment = await prisma.payment.findUnique({ where: { no: String(params.out_trade_no ?? '') } });
  if (!payment || payment.gateway !== 'epay') return null;
  const c = await orderChannel(payment, 'epay');
  if (!new EpayClient(c).verifyNotify(params)) return null;
  // 必须带实付金额：入账前核对金额 = 订单金额 + 手续费
  if (params.trade_status === 'TRADE_SUCCESS' && params.money) {
    await completePayment(payment.no, { externalId: params.trade_no ? String(params.trade_no) : null, money: String(params.money), raw: params });
  }
  return payment;
}

/** Stripe Webhook 的签名密钥：每个 Stripe 渠道一个（同一个地址可以配给多个 Stripe 账号，逐个尝试） */
export async function stripeWebhookSecrets() {
  return (await payChannels()).flatMap((c) => (c.type === 'stripe' && c.webhookSecretEnc ? [decrypt(c.webhookSecretEnc)] : []));
}

/** Stripe 会话已付款：核对会话就是这张订单下单时创建的那个（金额由本站设定），然后入账。返回是否已入账 */
export async function confirmStripeSession(session: StripeSession) {
  if (session.payment_status !== 'paid' || !session.client_reference_id) return false;
  const payment = await prisma.payment.findUnique({ where: { no: session.client_reference_id } });
  if (!payment || payment.gateway !== 'stripe' || payment.externalId !== session.id) return false;
  await completePayment(payment.no, { raw: { session: session.id, amount: session.amount_total, currency: session.currency, paymentIntent: session.payment_intent } });
  return true;
}

/** Heleket 回调：按订单所属渠道的密钥验签。订单不存在或签名不对时返回 false */
export async function verifyHeleketNotify(body: Record<string, unknown>, verify: (body: Record<string, unknown>, apiKey: string) => boolean) {
  if (typeof body.order_id !== 'string') return false;
  const payment = await prisma.payment.findUnique({ where: { no: body.order_id } });
  if (!payment || payment.gateway !== 'heleket') return false;
  const c = await orderChannel(payment, 'heleket');
  return verify(body, decrypt(c.apiKeyEnc));
}

/** Heleket：向网关查询发票（不只相信回调内容），发票是这张订单的且已付款才入账。返回是否已入账 */
export async function confirmHeleketOrder(no: string) {
  const payment = await prisma.payment.findUnique({ where: { no } });
  if (!payment || payment.gateway !== 'heleket') return false;
  if (payment.status === 'PAID') return true;
  const c = await orderChannel(payment, 'heleket');
  const inv = await new HeleketClient(c.merchantId, decrypt(c.apiKeyEnc)).info(payment.no);
  if (payment.externalId && inv.uuid !== payment.externalId) return false;
  if (!HELEKET_PAID.includes(inv.payment_status ?? inv.status ?? '')) return false;
  await completePayment(payment.no, { externalId: inv.uuid, raw: inv });
  return true;
}

/** 主动向网关查询订单是否已支付，已支付时入账 */
async function queryOrderPaid(p: Payment) {
  if (p.status === 'PAID') return true;
  if (p.gateway === 'stripe') {
    if (!p.externalId) return false;
    const c = await orderChannel(p, 'stripe');
    return confirmStripeSession(await new StripeClient(decrypt(c.secretKeyEnc)).retrieveSession(p.externalId));
  }
  if (p.gateway === 'heleket') return confirmHeleketOrder(p.no);
  const c = await orderChannel(p, 'epay');
  const r = await new EpayClient(c).queryPaid(p.no);
  if (!r.paid) return false;
  await completePayment(p.no, { externalId: r.tradeNo ?? null, money: r.money, raw: r.raw });
  return true;
}

/** 用户回到面板 / 点“我已完成支付”时主动查询网关确认支付结果（同一订单 8 秒内只查一次） */
export async function refreshPayment(payment: Payment): Promise<Payment> {
  if (payment.status !== 'PENDING') return payment;
  if (!(await redis.set(`pay:refresh:${payment.no}`, '1', 'EX', 8, 'NX'))) return payment;
  try {
    await queryOrderPaid(payment);
  } catch {
    /* 查询失败不影响展示，等待异步通知 */
  }
  return (await prisma.payment.findUnique({ where: { id: payment.id } })) ?? payment;
}

/** 管理员手动确认到账 */
export async function adminCompletePayment(id: number): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id } });
  if (!payment) throw notFound(t('pay.notFound'));
  await completePayment(payment.no, { raw: { manual: true } });
}

/** 过期未支付订单 */
export async function expireStalePayments(): Promise<number> {
  const res = await prisma.payment.updateMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - PAYMENT_TTL_MS) } },
    data: { status: 'EXPIRED' },
  });
  return res.count;
}

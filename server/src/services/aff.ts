import { randomInt } from 'node:crypto';
import type { AffLogDTO, AffSummaryDTO } from '../shared/index.ts';
import { badRequest } from '../lib/errors.ts';
import { prisma, Prisma, type AffLog, type Order, type User } from '../lib/prisma.ts';
import { getSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { changeBalance } from './billing.ts';
import { money } from './serializers.ts';

type Tx = Prisma.TransactionClient;

// 推广码字符：去掉容易看错的 0 / O / 1 / I / L
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 8 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join('');

/** 用户名只显示首尾，例如 al***e */
export function maskName(name: string): string {
  if (name.length <= 2) return `${name[0] ?? ''}***`;
  return `${name.slice(0, 2)}***${name.slice(-1)}`;
}

/** 取得用户的推广码，没有时生成 */
export async function ensureAffCode(user: Pick<User, 'id' | 'affCode'>): Promise<string> {
  if (user.affCode) return user.affCode;
  for (let i = 0; i < 5; i++) {
    const code = newCode();
    const res = await prisma.user.updateMany({ where: { id: user.id, affCode: null }, data: { affCode: code } }).catch((e: unknown) => {
      // 推广码重复时换一个
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null;
      throw e;
    });
    if (res?.count) return code;
    if (res) return (await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { affCode: true } })).affCode!;
  }
  throw new Error('failed to generate aff code');
}

/** 注册时按推广码查找邀请人：功能开启且邀请人是状态正常的普通用户 */
export async function resolveReferrer(code: string | undefined): Promise<number | null> {
  const value = code?.trim().toUpperCase();
  if (!value) return null;
  const { affEnabled } = await getSettings();
  if (!affEnabled) return null;
  const user = await prisma.user.findUnique({ where: { affCode: value }, select: { id: true, role: true, status: true } });
  return user && user.role === 'USER' && user.status === 'ACTIVE' ? user.id : null;
}

/** 改变佣金余额并记一笔明细 */
async function changeAff(tx: Tx, userId: number, amount: Prisma.Decimal, data: Omit<Prisma.AffLogUncheckedCreateInput, 'userId' | 'amount' | 'balanceAfter'>) {
  const { affBalance } = await tx.user.update({ where: { id: userId }, data: { affBalance: { increment: amount } }, select: { affBalance: true } });
  await tx.affLog.create({ data: { ...data, userId, amount, balanceAfter: affBalance } });
  return affBalance;
}

/** 支付渠道充值到账后增加可返佣额度（只计到账金额，不含手续费），与入账在同一事务里 */
export async function addAffCredit(tx: Tx, userId: number, amount: Prisma.Decimal): Promise<void> {
  if (amount.gt(0)) await tx.user.update({ where: { id: userId }, data: { affCredit: { increment: amount } } });
}

/**
 * 被邀请用户付款（首购 / 续费）后给邀请人返佣，与订单在同一事务里。
 * 返佣基数为优惠后的订单净额中由支付渠道充值的部分（可返佣额度），赠送、兑换、调整得到的余额不参与；
 * 设置了冻结期时佣金先记为待生效，到期后才计入可用佣金。
 */
export async function awardCommission(tx: Tx, order: Pick<Order, 'id' | 'userId' | 'amount' | 'type'>): Promise<void> {
  if (order.amount.lte(0)) return;
  const settings = await getSettings();
  const percent = order.type === 'NEW' ? settings.affRateNew : settings.affRateRenew;
  if (!settings.affEnabled || percent <= 0) return;
  const buyer = await tx.user.findUnique({ where: { id: order.userId }, select: { referrerId: true, affCredit: true } });
  if (!buyer?.referrerId || buyer.affCredit.lte(0)) return;
  const referrer = await tx.user.findUnique({ where: { id: buyer.referrerId }, select: { id: true, status: true } });
  if (!referrer || referrer.status !== 'ACTIVE') return;
  const base = Prisma.Decimal.min(order.amount, buyer.affCredit);
  const rate = new Prisma.Decimal(percent);
  const commission = base.mul(rate).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  if (commission.lte(0)) return;
  // 用掉的额度：退款撤回佣金时退回
  await tx.user.update({ where: { id: order.userId }, data: { affCredit: { decrement: base } } });
  const data = { type: 'EARN' as const, inviteeId: order.userId, orderId: order.id, orderAmount: base, rate };
  if (settings.affFreezeDays > 0) {
    const { affBalance } = await tx.user.findUniqueOrThrow({ where: { id: referrer.id }, select: { affBalance: true } });
    const effectiveAt = new Date(Date.now() + settings.affFreezeDays * 86_400_000);
    await tx.affLog.create({ data: { ...data, userId: referrer.id, amount: commission, balanceAfter: affBalance, status: 'PENDING', effectiveAt } });
  } else {
    await changeAff(tx, referrer.id, commission, { ...data, effectiveAt: new Date() });
  }
}

/**
 * 订单退款时处理佣金并退回可返佣额度：冻结期内的佣金直接作废；已生效的撤回（佣金余额可能因此变为负数，之后的佣金先抵扣）
 */
export async function revokeCommission(tx: Tx, orderId: number): Promise<void> {
  const earned = await tx.affLog.findFirst({ where: { orderId, type: 'EARN' } });
  if (!earned || earned.status === 'CANCELED' || (await tx.affLog.count({ where: { orderId, type: 'REVOKE' } }))) return;
  if (earned.inviteeId && earned.orderAmount) await tx.user.update({ where: { id: earned.inviteeId }, data: { affCredit: { increment: earned.orderAmount } } });
  if (earned.status === 'PENDING') {
    // 条件更新：与到期结算并发时只有一方生效
    const res = await tx.affLog.updateMany({ where: { id: earned.id, status: 'PENDING' }, data: { status: 'CANCELED' } });
    if (res.count) return;
  }
  await changeAff(tx, earned.userId, earned.amount.negated(), { type: 'REVOKE', inviteeId: earned.inviteeId, orderId, orderAmount: earned.orderAmount, rate: earned.rate });
}

/** 结算到期的待生效佣金（userId 为空时结算所有用户），返回结算笔数 */
export async function settleAff(userId?: number): Promise<number> {
  const due = await prisma.affLog.findMany({ where: { status: 'PENDING', effectiveAt: { lte: new Date() }, ...(userId ? { userId } : {}) }, select: { id: true } });
  let n = 0;
  for (const { id } of due) {
    const done = await prisma.$transaction(async (tx) => {
      const res = await tx.affLog.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SETTLED' } });
      if (!res.count) return false;
      const log = await tx.affLog.findUniqueOrThrow({ where: { id } });
      const { affBalance } = await tx.user.update({ where: { id: log.userId }, data: { affBalance: { increment: log.amount } }, select: { affBalance: true } });
      await tx.affLog.update({ where: { id }, data: { balanceAfter: affBalance } });
      return true;
    });
    if (done) n++;
  }
  return n;
}

/** 把全部佣金转入账户余额 */
export async function withdrawAff(userId: number): Promise<{ amount: Prisma.Decimal; balance: Prisma.Decimal }> {
  const settings = await getSettings();
  if (!settings.affEnabled) throw badRequest(t('aff.disabled'));
  await settleAff(userId);
  return prisma.$transaction(async (tx) => {
    const { affBalance } = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { affBalance: true } });
    if (affBalance.lte(0) || affBalance.lt(settings.affMinWithdraw)) throw badRequest(t('aff.belowMin', { min: settings.currency + settings.affMinWithdraw.toFixed(2) }));
    // 条件更新防止并发重复转出
    const res = await tx.user.updateMany({ where: { id: userId, affBalance }, data: { affBalance: { decrement: affBalance } } });
    if (!res.count) throw badRequest(t('aff.changed'));
    await tx.affLog.create({ data: { userId, type: 'WITHDRAW', amount: affBalance.negated(), balanceAfter: 0 } });
    const balance = await changeBalance(tx, userId, affBalance, 'AFF', t('aff.withdrawLog'));
    return { amount: affBalance, balance };
  });
}

export async function affSummary(user: Pick<User, 'id' | 'affCode'>): Promise<AffSummaryDTO> {
  const settings = await getSettings();
  await settleAff(user.id);
  const [fresh, earned, pending, invited, paid] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { affBalance: true } }),
    // 已生效：结算后的返佣减去撤回
    prisma.affLog.aggregate({ where: { userId: user.id, OR: [{ type: 'EARN', status: 'SETTLED' }, { type: 'REVOKE' }] }, _sum: { amount: true } }),
    prisma.affLog.aggregate({ where: { userId: user.id, type: 'EARN', status: 'PENDING' }, _sum: { amount: true } }),
    prisma.user.count({ where: { referrerId: user.id } }),
    prisma.affLog.groupBy({ by: ['inviteeId'], where: { userId: user.id, type: 'EARN' } }),
  ]);
  return {
    enabled: settings.affEnabled,
    rateNew: settings.affRateNew,
    rateRenew: settings.affRateRenew,
    freezeDays: settings.affFreezeDays,
    minWithdraw: settings.affMinWithdraw,
    code: settings.affEnabled ? await ensureAffCode(user) : null,
    balance: money(fresh.affBalance),
    pending: money(pending._sum.amount),
    total: money(earned._sum.amount),
    invited,
    paidInvitees: paid.length,
  };
}

type AffLogRow = AffLog & { invitee: Pick<User, 'username'> | null; order: Pick<Order, 'no' | 'type'> | null };

/** 佣金明细的一行：返佣记录，生效后被撤回的显示为已撤回 */
export function toAffLog(l: AffLogRow, revoked: boolean): AffLogDTO {
  return {
    id: l.id,
    type: l.type,
    status: revoked ? 'REVOKED' : l.status,
    amount: money(l.amount),
    orderNo: l.order?.no ?? null,
    orderType: l.order?.type ?? null,
    invitee: l.invitee ? maskName(l.invitee.username) : null,
    orderAmount: l.orderAmount ? money(l.orderAmount) : null,
    rate: l.rate ? l.rate.toString() : null,
    createdAt: l.createdAt.toISOString(),
    effectiveAt: l.effectiveAt?.toISOString() ?? null,
  };
}

/** 佣金明细（只列返佣记录，撤回合并到对应的返佣上；转入余额见账户余额明细） */
export async function affLogs(userId: number, page: number, pageSize: number): Promise<{ items: AffLogDTO[]; total: number }> {
  await settleAff(userId);
  const where = { userId, type: 'EARN' as const };
  const [rows, total] = await Promise.all([
    prisma.affLog.findMany({
      where,
      include: { invitee: { select: { username: true } }, order: { select: { no: true, type: true } } },
      orderBy: { id: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.affLog.count({ where }),
  ]);
  const orderIds = rows.map((r) => r.orderId).filter((x): x is number => x !== null);
  const revoked = new Set((await prisma.affLog.findMany({ where: { userId, type: 'REVOKE', orderId: { in: orderIds } }, select: { orderId: true } })).map((r) => r.orderId));
  return { items: rows.map((r) => toAffLog(r, r.orderId !== null && revoked.has(r.orderId))), total };
}

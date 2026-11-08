import { getIncus } from '../incus/index.ts';
import { badRequest, errorMessage } from '../lib/errors.ts';
import { prisma, type Instance, type Prisma } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';
import { getSettings } from '../lib/settings.ts';
import { nextTrafficReset } from '../lib/time.ts';
import { changeBalance } from './billing.ts';
import { createRenewInvoice } from './invoices.ts';
import { collectNode } from './metrics.ts';
import { sampleNodeBandwidth } from './bandwidth.ts';
import { enqueueTask, hasActiveTask } from './tasks.ts';
import { t } from '../i18n/index.ts';
import { runBusinessMailChecks, sendBusinessNotice } from './mail/business-mail.ts';
import { renewalPrice } from './coupons.ts';
import { cacheNodeArchitecture } from './node-architecture.ts';

type Log = { info: (msg: string) => void; warn: (msg: string) => void };

/** 重置流量计数，必要时解除限速 / 挂起 */
export async function resetTraffic(instanceId: number, opts: { advanceCycle: boolean }): Promise<void> {
  const inst = await prisma.instance.findUniqueOrThrow({ where: { id: instanceId } });
  const now = new Date();
  await prisma.instance.update({
    where: { id: inst.id },
    data: {
      trafficIn: 0n,
      trafficOut: 0n,
      trafficThrottled: false,
      ...(opts.advanceCycle ? { trafficResetAt: nextTrafficReset(now, inst.createdAt) } : {}),
    },
  });
  await redis.del(`traffic-suspend:${inst.id}`);
  if (inst.trafficThrottled) await enqueueTask({ instanceId: inst.id, type: 'APPLY_LIMITS', exclusive: false });
  if (inst.status === 'SUSPENDED' && inst.suspendReason === 'TRAFFIC') {
    await enqueueTask({ instanceId: inst.id, type: 'UNSUSPEND', exclusive: false });
  }
}

/** 用户付费重置流量：按实例的重置价格从余额扣款，再清零本周期已用流量（重置日不变），扣款后重置失败时退款 */
export async function purchaseTrafficReset(inst: Instance): Promise<Prisma.Decimal> {
  if (inst.trafficResetPrice === null) throw badRequest(t('traffic.resetUnavailable'));
  if (inst.traffic <= 0) throw badRequest(t('traffic.unlimited'));
  if (['DELETED', 'DELETING', 'CREATING'].includes(inst.status)) throw badRequest(t('traffic.resetBadStatus'));
  if (inst.status === 'SUSPENDED' && inst.suspendReason !== 'TRAFFIC') throw badRequest(t('traffic.resetBadStatus'));
  const price = inst.trafficResetPrice;
  await prisma.$transaction((tx) => changeBalance(tx, inst.userId, price.negated(), 'TRAFFIC', t('log.trafficReset', { hostname: inst.hostname })));
  try {
    await resetTraffic(inst.id, { advanceCycle: false });
  } catch (err) {
    await prisma.$transaction((tx) => changeBalance(tx, inst.userId, price, 'REFUND', t('log.trafficResetRefund', { hostname: inst.hostname })));
    throw err;
  }
  return price;
}

/**
 * 旧版本在锚点日的 0 点重置流量；现在改为与开通时间相同的时刻。
 * 启动时把仍停在 0 点的重置时间顺延到同一天的开通时刻（只处理一次，之后不再满足条件）。
 */
export async function alignLegacyTrafficResets(log: Log): Promise<void> {
  const rows = await prisma.instance.findMany({
    where: { status: { notIn: ['DELETED', 'DELETING'] } },
    select: { id: true, createdAt: true, trafficResetAt: true },
  });
  const atMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  let count = 0;
  for (const r of rows) {
    if (!atMidnight(r.trafficResetAt) || atMidnight(r.createdAt)) continue;
    const aligned = nextTrafficReset(new Date(r.trafficResetAt.getTime() - 1), r.createdAt);
    if (aligned.getTime() === r.trafficResetAt.getTime()) continue;
    await prisma.instance.update({ where: { id: r.id }, data: { trafficResetAt: aligned } });
    count++;
  }
  if (count) log.info(`aligned traffic reset time to the opening time for ${count} instances`);
}

export async function runTrafficResets(log: Log): Promise<void> {
  const due = await prisma.instance.findMany({
    where: { trafficResetAt: { lte: new Date() }, status: { notIn: ['DELETED', 'DELETING'] } },
    select: { id: true, hostname: true },
    take: 500,
  });
  for (const inst of due) {
    try {
      await resetTraffic(inst.id, { advanceCycle: true });
    } catch (err) {
      log.warn(`traffic reset failed #${inst.id}: ${errorMessage(err)}`);
    }
  }
  if (due.length) log.info(`traffic cycle reset for ${due.length} instances`);
}

/** 自动续费、到期暂停、宽限期后删除 */
export async function runExpiryChecks(log: Log): Promise<void> {
  const settings = await getSettings();
  const now = new Date();

  // 1. 自动续费
  const renewBefore = new Date(now.getTime() + settings.autoRenewHours * 3600_000);
  const toRenew = await prisma.instance.findMany({
    where: {
      autoRenew: true,
      expiresAt: { lte: renewBefore },
      status: { in: ['RUNNING', 'STOPPED', 'SUSPENDED', 'ERROR'] },
      provisionedAt: { not: null },
    },
    select: { id: true, hostname: true },
  });
  for (const inst of toRenew) {
    // 每个实例每 6 小时最多尝试一次，避免余额不足时反复失败
    const guard = await redis.set(`autorenew:${inst.id}`, '1', 'EX', 6 * 3600, 'NX');
    if (!guard) continue;
    try {
      const invoice = await createRenewInvoice((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id }, select: { userId: true } })).userId, inst.id, 1);
      log.info(`auto-renew invoice created #${inst.id} ${inst.hostname} ${invoice.no}`);
    } catch (err) {
      log.warn(`auto-renew failed #${inst.id}: ${errorMessage(err)}`);
      if ((err as { code?: string }).code === 'INSUFFICIENT_BALANCE') {
        const row = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id }, include: { user: true, coupon: true } });
        await sendBusinessNotice(row.userId, 'lowBalance', { name: row.hostname, balance: `${settings.currency}${row.user.balance.toFixed(2)}`, price: `${settings.currency}${renewalPrice(row).toFixed(2)}` }, 'renewal', 86400).catch((error) => log.warn(`balance email failed: ${errorMessage(error)}`));
      }
    }
  }

  // 2. 到期暂停
  const expired = await prisma.instance.findMany({
    where: { expiresAt: { lte: now }, status: { in: ['RUNNING', 'STOPPED', 'ERROR'] }, provisionedAt: { not: null } },
    select: { id: true },
  });
  let suspended = 0;
  for (const inst of expired) {
    if (await hasActiveTask(inst.id)) continue;
    if (!(await redis.set(`expire-suspend:${inst.id}`, '1', 'EX', 1800, 'NX'))) continue;
    await enqueueTask({ instanceId: inst.id, type: 'SUSPEND', payload: { reason: 'EXPIRED' }, exclusive: false });
    suspended++;
  }

  // 3. 宽限期结束后删除
  const terminateBefore = new Date(now.getTime() - settings.graceDays * 86400_000);
  const toDelete = await prisma.instance.findMany({
    where: { expiresAt: { lte: terminateBefore }, status: { in: ['SUSPENDED', 'STOPPED', 'ERROR', 'RUNNING'] } },
    select: { id: true },
  });
  let deleted = 0;
  for (const inst of toDelete) {
    if (await hasActiveTask(inst.id)) continue;
    await enqueueTask({ instanceId: inst.id, type: 'DELETE', payload: { reason: 'expired' }, exclusive: false });
    deleted++;
  }
  if (suspended || deleted) log.info(`expiry: suspended ${suspended}, deleted ${deleted}`);
  await runBusinessMailChecks(log);
}

/** 节点健康检查（待安装的宿主机由安装回调或「验证并连接」接入，不参与检查） */
export async function checkNodes(log: Log): Promise<void> {
  const nodes = await prisma.node.findMany({ where: { enabled: true, status: { not: 'PENDING' } } });
  await Promise.all(
    nodes.map(async (node) => {
      try {
        const incus = await getIncus(node);
        const server = await incus.getServer();
        if (server.auth !== 'trusted') throw new Error(t('node.notTrusted'));
        await prisma.node.update({
          where: { id: node.id },
          // 顺带记录架构：只读取 /1.0，旧宿主机不用重新连接也能补上
          data: { status: 'ONLINE', lastCheckedAt: new Date(), lastError: null },
        });
        await cacheNodeArchitecture(node.id, server.environment?.architectures?.[0]);
      } catch (err) {
        if (node.status !== 'OFFLINE') log.warn(`node ${node.name} offline: ${errorMessage(err)}`);
        await prisma.node.update({
          where: { id: node.id },
          data: { status: 'OFFLINE', lastCheckedAt: new Date(), lastError: errorMessage(err).slice(0, 500) },
        });
      }
    }),
  );
}

export async function collectAllNodes(log: Log): Promise<void> {
  const nodes = await prisma.node.findMany({ where: { enabled: true, status: { notIn: ['OFFLINE', 'PENDING'] } } });
  await Promise.all(
    nodes.map(async (node) => {
      await collectNode(node).catch((err) => log.warn(`metrics collection failed for ${node.name}: ${errorMessage(err)}`));
      // 后台定期采样宿主机网卡，无人查看时也保留带宽曲线
      await sampleNodeBandwidth(node).catch((err) => log.warn(`bandwidth sampling failed for ${node.name}: ${errorMessage(err)}`));
    }),
  );
}

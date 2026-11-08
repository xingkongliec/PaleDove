import { DEFAULT_LOCALE, isVmType, nodeAllowsImage, normalizeLocale, type TransferMode, type TransferSpecDTO } from '../shared/index.ts';
import { encrypt, generatePassword, randomId } from '../lib/crypto.ts';
import { AppError, badRequest, conflict, notFound, paymentRequired } from '../lib/errors.ts';
import { prisma, Prisma, type Image, type Instance, type Node, type User } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { getSettings } from '../lib/settings.ts';
import { runWithLocale, t } from '../i18n/index.ts';
import { changeBalance } from './billing.ts';
import { maskName } from './aff.ts';
import { syncSitesSafe } from './gateway.ts';
import { removePortMapping } from './portmap.ts';
import { isRealNameApproved } from './realname/realname.ts';
import { createTaskRecord, dispatchTask, hasActiveTask } from './tasks.ts';
import { detachInstance } from './vpc.ts';

type InstanceWithNode = Instance & { node: Node };

/** 校验重装使用的镜像：已启用、匹配实例类型、宿主机允许使用（重装系统与全新安装转移共用） */
export async function resolveReinstallImage(inst: Pick<Instance, 'type' | 'nodeId'>, imageId: number): Promise<Image> {
  const image = await prisma.image.findUnique({ where: { id: imageId } });
  if (!image || !image.enabled) throw badRequest(t('image.notAvailable'));
  if (isVmType(inst.type) ? !image.forVm : !image.forContainer) throw badRequest(t('image.typeMismatch'));
  const node = await prisma.node.findUnique({ where: { id: inst.nodeId }, select: { imageIds: true, arch: true } });
  if (!node || !nodeAllowsImage(node, image)) throw badRequest(t('image.notOnNode'));
  return image;
}

type SpecSource = Pick<
  Instance,
  'name' | 'type' | 'cpu' | 'memory' | 'disk' | 'bandwidthIn' | 'bandwidthOut' | 'traffic' | 'trafficMode' | 'billingCycle' | 'price' | 'expiresAt'
> & {
  node: Pick<Node, 'region' | 'country'>;
  image: Pick<Image, 'name'> | null;
  plan: { name: string; product: { name: string } } | null;
};

/** 读取快照需要的关联 */
export const transferSpecInclude = {
  node: { select: { region: true, country: true } },
  image: { select: { name: true } },
  plan: { select: { name: true, product: { select: { name: true } } } },
} as const;

/** 实例快照：转移记录里保存当时的配置、地区、系统和续费价格 */
export function transferSpec(i: SpecSource, image?: Pick<Image, 'name'> | null): TransferSpecDTO {
  return {
    name: i.name,
    type: i.type,
    cpu: i.cpu,
    memory: i.memory,
    disk: i.disk,
    bandwidthIn: i.bandwidthIn,
    bandwidthOut: i.bandwidthOut,
    traffic: i.traffic,
    trafficMode: i.trafficMode,
    region: i.node.region,
    country: i.node.country,
    image: (image ?? i.image)?.name ?? null,
    product: i.plan?.product.name ?? null,
    plan: i.plan?.name ?? null,
    cycle: i.billingCycle,
    price: i.price.toFixed(2),
    expiresAt: i.expiresAt.toISOString(),
  };
}

/** 用户转移实例的手续费：固定金额，或实例续费价格的百分比（向上取到分）；管理员操作不收取 */
export async function transferFee(inst: Pick<Instance, 'price'>, byAdmin: boolean): Promise<Prisma.Decimal> {
  if (byAdmin) return new Prisma.Decimal(0);
  const { transferFeeMode, transferFeeValue } = await getSettings();
  if (transferFeeMode === 'FIXED') return new Prisma.Decimal(transferFeeValue).toDecimalPlaces(2);
  if (transferFeeMode === 'PERCENT') return inst.price.mul(transferFeeValue).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_UP);
  return new Prisma.Decimal(0);
}

/** 转移前检查：接收方是否可用（不可用时返回原因）与手续费 */
export async function checkTransfer(inst: InstanceWithNode, target: string | undefined, byAdmin: boolean) {
  const fee = await transferFee(inst, byAdmin);
  if (!target?.trim()) return { fee, recipient: null, error: null };
  try {
    const user = await findRecipient(target, inst);
    // 按邮箱查到时只显示部分用户名，避免借此把邮箱和用户名对应起来
    const username = byAdmin || user.username === target.trim() ? user.username : maskName(user.username);
    return { fee, recipient: { username }, error: null };
  } catch (e) {
    if (e instanceof AppError) return { fee, recipient: null, error: e.message };
    throw e;
  }
}

/** 按用户名或邮箱查找接收方：只能转给状态正常的普通用户 */
async function findRecipient(account: string, inst: InstanceWithNode): Promise<User> {
  const value = account.trim();
  const user = await prisma.user.findFirst({ where: { OR: [{ username: value }, { email: value.toLowerCase() }] } });
  // 管理员账号与不存在的账号给出相同提示
  if (!user || user.role !== 'USER') throw notFound(t('transfer.targetNotFound'));
  if (user.status !== 'ACTIVE') throw badRequest(t('transfer.targetDisabled'));
  if (user.id === inst.userId) throw badRequest(t('transfer.sameOwner'));
  if (inst.node.requireRealName && !(await isRealNameApproved(user.id))) throw badRequest(t('transfer.targetRealName'));
  return user;
}

/** 用接收者自己的语言发站内信 */
export async function notify(user: Pick<User, 'id' | 'locale'>, build: () => { title: string; content: string }): Promise<void> {
  await runWithLocale(normalizeLocale(user.locale) ?? DEFAULT_LOCALE, async () => {
    await prisma.message.create({ data: { userId: user.id, ...build() } });
  });
}

/**
 * 实例过户：把实例转给另一个用户。
 * KEEP：原样交接，系统盘数据、快照、端口映射、网站绑定与 root 密码全部保留；
 * REINSTALL：交接前用所选系统重装，清空数据与快照，删除自定义端口映射和网站绑定，生成新的 root 密码（只有接收方能查看）。
 * 两种方式都会关闭自动续费，避免未经接收方同意从其余额扣费；剩余时长随实例转移。
 * market：交易市场成交的过户，不收转移手续费（平台收的是成交手续费），也不发转移通知（由交易市场自己通知买卖双方）。
 */
export async function transferInstance(
  inst: InstanceWithNode,
  opts: { actor: Pick<User, 'id' | 'username'>; byAdmin: boolean; target: string; mode: TransferMode; imageId?: number; remark?: string; market?: boolean },
): Promise<User> {
  const recipient = await findRecipient(opts.target, inst);
  const image = opts.mode === 'REINSTALL' ? await resolveReinstallImage(inst, opts.imageId ?? inst.imageId ?? 0) : null;
  const previous = await prisma.user.findUniqueOrThrow({ where: { id: inst.userId }, select: { id: true, username: true, locale: true, balance: true } });
  const fee = await transferFee(inst, opts.byAdmin || !!opts.market);
  // 先检查余额，避免移除端口映射等操作后才发现付不起手续费（扣款时仍会再次校验）
  const { currency } = await getSettings();
  if (fee.gt(previous.balance)) throw paymentRequired(t('transfer.feeInsufficient', { fee: currency + fee.toFixed(2) }));
  const remark = opts.remark?.trim() || null;
  const current = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id }, include: transferSpecInclude });
  const spec = transferSpec(current, image) as unknown as Prisma.InputJsonValue;

  const task = await withLock(`task-enqueue:${inst.id}`, 30_000, async () => {
    if (await hasActiveTask(inst.id)) throw conflict(t('task.busy'));
    // VPC 属于原所有者：过户前移出
    if (inst.vpcId) await detachInstance(inst);
    let removedSites = false;
    if (image) {
      // 自定义端口映射需要先从宿主机上移除（失败时不做任何变更）
      const ports = await prisma.portMapping.findMany({ where: { instanceId: inst.id, system: false } });
      for (const m of ports) await removePortMapping(inst, m);
      removedSites = (await prisma.siteBinding.count({ where: { instanceId: inst.id } })) > 0;
    }
    const created = await prisma.$transaction(async (tx) => {
      if (fee.gt(0)) await changeBalance(tx, inst.userId, fee.negated(), 'TRANSFER', t('log.transferFee', { hostname: inst.hostname, to: recipient.username }));
      await tx.instance.update({ where: { id: inst.id }, data: { userId: recipient.id, autoRenew: false } });
      await tx.instanceTransfer.create({
        data: { instanceId: inst.id, hostname: inst.hostname, fromUserId: inst.userId, toUserId: recipient.id, mode: opts.mode, byAdmin: opts.byAdmin, remark, fee, spec },
      });
      // 实例 ID 改为新所有者：pd-<接收方用户 ID>-<随机编码>（宿主机上的实例随之改名）
      const name = `pd-${recipient.id}-${randomId(8)}`;
      if (!image) return createTaskRecord(tx, { instanceId: inst.id, type: 'RENAME', userId: opts.actor.id, payload: { name } });
      await tx.siteBinding.deleteMany({ where: { instanceId: inst.id } });
      return createTaskRecord(tx, {
        instanceId: inst.id,
        type: 'REINSTALL',
        userId: opts.actor.id,
        payload: { imageId: image.id, password: encrypt(generatePassword()), sshKeys: [], rename: name },
      });
    });
    if (removedSites) await syncSitesSafe(inst.nodeId);
    return created;
  });
  if (task) await dispatchTask(task);
  // 实例转走后，该实例上其他挂牌（例如管理员在挂牌期间过户）随之下架
  if (!opts.market) await prisma.marketListing.updateMany({ where: { instanceId: inst.id, status: 'ACTIVE' }, data: { status: 'REMOVED', endReason: 'transferred' } });
  if (opts.market) return recipient;

  const from = opts.byAdmin ? null : previous.username;
  await notify(recipient, () => ({
    title: t('transfer.msgInTitle', { hostname: inst.hostname }),
    content: [
      from ? t('transfer.msgInFrom', { hostname: inst.hostname, from }) : t('transfer.msgInAdmin', { hostname: inst.hostname }),
      image ? t('transfer.msgInReinstall', { image: image.name }) : t('transfer.msgInKeep'),
      t('transfer.msgAutoRenew'),
      remark ? t('transfer.msgRemark', { remark }) : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }));
  // 转出方也收到通知：管理员操作时告知原因，自己转出时留作记录（含手续费与备注）
  await notify(previous, () => ({
    title: t('transfer.msgOutTitle', { hostname: inst.hostname }),
    content: [
      opts.byAdmin ? t('transfer.msgOut', { hostname: inst.hostname }) : t('transfer.msgOutSelf', { hostname: inst.hostname, to: recipient.username }),
      fee.gt(0) ? t('transfer.msgFee', { fee: currency + fee.toFixed(2) }) : null,
      remark ? t('transfer.msgRemark', { remark }) : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }));
  return recipient;
}

// 切换机房：用户把实例换到同一产品的其他宿主机上（参考规则）。
//  - 每台实例 30 天免费切换一次，不累计，免费切换成功后重新计时；免费次数用完后按系统设置的费用额外切换（0 为不允许），
//    额外切换不推迟下一次免费时间。所有用户相同，不分等级。
//  - 保留到期时间、计费周期、续费价格与套餐（同档套餐重建），保留已用流量与流量周期；
//    流量额度按目标宿主机在产品中的流量倍率换算（switchTraffic）。
//  - 在目标宿主机上用所选系统全新安装：原数据不迁移，公网 IP / 端口会变化；成功后才删除原宿主机上的实例，
//    失败时把网络资源还回原宿主机，原实例不受影响，额外切换的费用退回。
//  - 切换成功后冷却 2 小时；有附加数据盘、挂牌出售中、有进行中任务的实例不能切换。
//  - Agent ICMP 仅检测原 IPv4 的可达性，全部超时也不判墙，不增加免费次数或自动换 IP。
import { isNatType, isPublicIpv4Mode, nodeAllowsImage, productNodeOption } from '../shared/index.ts';
import { checkIpv4 } from './agent/ipv4-check.ts';
export { checkIpv4 } from './agent/ipv4-check.ts';
import { getIncus, IncusError, type IncusApi } from '../incus/index.ts';
import { encrypt, generatePassword } from '../lib/crypto.ts';
import { badRequest, conflict, errorMessage } from '../lib/errors.ts';
import { prisma, Prisma, type Instance, type Node, type User } from '../lib/prisma.ts';
import { getSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { ensureNatNetwork, nodeLoads } from './allocation.ts';
import { changeBalance, nodeFitsIpv6 } from './billing.ts';
import { syncSitesSafe } from './gateway.ts';
import { currentPlacement, place, type MigratingInstance } from './migration.ts';
import { buildCreateRequest } from './spec.ts';
import { enqueueTask, hasActiveTask } from './tasks.ts';
import { detachInstance } from './vpc.ts';
import { assertNotListed } from './market.ts';
import { enforceTrafficLimit } from './metrics.ts';
import { trafficUsedBytes } from './serializers.ts';

/** 免费切换间隔与切换后的冷却时间 */
export const FREE_SWITCH_DAYS = 30;
export const SWITCH_COOLDOWN_MS = 2 * 3600_000;

export interface SwitchTargetDTO {
  id: number;
  name: string;
  region: string;
  country: string;
  /** 有可用资源（未满载、网络类型与套餐匹配，独立 IP 套餐有空闲 IP） */
  available: boolean;
  /** 产品在该机房的流量倍率，与切换后的流量额度（GB，0 为不限） */
  trafficMultiplier: number;
  traffic: number;
}

export interface SwitchInfoDTO {
  current: { id: number; name: string; region: string; country: string; trafficMultiplier: number; traffic: number };
  targets: SwitchTargetDTO[];
  /** 本周期的免费切换是否可用；不可用时下一次免费的时间 */
  free: boolean;
  nextFreeAt: string | null;
  /** 额外切换的费用（0 表示免费次数用完后不能切换） */
  fee: string;
  /** 冷却结束时间（切换成功后 2 小时内不能再次切换） */
  cooldownUntil: string | null;
  /** 不能切换的原因（状态、附加数据盘等） */
  blocked: string | null;
}

type SwitchInstance = Instance & { node: Node; plan: { productId: number; type: Instance['type']; ipv6Count: number; product: { nodeOptions: unknown } } | null };

/**
 * 切换后的流量额度：按源、目标宿主机在产品中的流量倍率等比换算（保留管理员对单台实例的调整），
 * 不限流量（0）保持不限
 */
export function switchTraffic(traffic: number, from: number, to: number): number {
  if (traffic <= 0 || from === to) return traffic;
  return Math.max(1, Math.round((traffic * to) / from));
}

const multiplierOf = (inst: { plan: { product: { nodeOptions: unknown } } | null }, nodeId: number) =>
  inst.plan ? productNodeOption(inst.plan.product.nodeOptions, nodeId).trafficMultiplier : 1;

function freeState(inst: Pick<Instance, 'freeSwitchAt'>, now = Date.now()) {
  const next = inst.freeSwitchAt ? inst.freeSwitchAt.getTime() + FREE_SWITCH_DAYS * 86400_000 : 0;
  return { free: next <= now, nextFreeAt: next > now ? new Date(next).toISOString() : null };
}

/** 同一产品的其他宿主机，以及各自现在能否开通这个实例 */
async function switchTargets(inst: SwitchInstance): Promise<SwitchTargetDTO[]> {
  if (!inst.plan) return [];
  const nodes = await prisma.node.findMany({
    where: { id: { not: inst.nodeId }, enabled: true, products: { some: { id: inst.plan.productId } } },
    orderBy: [{ region: 'asc' }, { sortOrder: 'asc' }, { id: 'asc' }],
  });
  const loads = await nodeLoads(nodes);
  const from = multiplierOf(inst, inst.nodeId);
  return loads.map(({ node, active, freeIps }) => ({
    id: node.id,
    name: node.name,
    region: node.region,
    country: node.country,
    trafficMultiplier: multiplierOf(inst, node.id),
    traffic: switchTraffic(inst.traffic, from, multiplierOf(inst, node.id)),
    available:
      node.status !== 'OFFLINE' &&
      node.status !== 'PENDING' &&
      !!node.endpoint &&
      active < node.maxInstances &&
      isPublicIpv4Mode(node.networkMode) === !isNatType(inst.type) &&
      // IPv6 Only 宿主机没有端口映射，不与有端口映射的宿主机互相切换
      (node.networkMode === 'IPV6_ONLY') === (inst.node.networkMode === 'IPV6_ONLY') &&
      nodeFitsIpv6(node, inst.plan!.ipv6Count) &&
      (inst.type !== 'KVM_IPV4' || freeIps > 0),
  }));
}

/** 不能切换的原因；可以切换时返回 null */
async function blockedReason(inst: SwitchInstance): Promise<string | null> {
  if (!['RUNNING', 'STOPPED'].includes(inst.status)) return t('switch.badStatus');
  if (!inst.plan) return t('switch.noPlan');
  if ((await prisma.marketListing.count({ where: { instanceId: inst.id, status: 'ACTIVE' } })) > 0) return t('switch.listed');
  if ((await prisma.volume.count({ where: { instanceId: inst.id } })) > 0) return t('switch.hasVolumes');
  if (await hasActiveTask(inst.id)) return t('switch.busy');
  return null;
}

async function loadSwitchInstance(id: number): Promise<SwitchInstance> {
  return prisma.instance.findUniqueOrThrow({
    where: { id },
    include: { node: true, plan: { select: { productId: true, type: true, ipv6Count: true, product: { select: { nodeOptions: true } } } } },
  });
}

export async function switchInfo(instanceId: number): Promise<SwitchInfoDTO> {
  const inst = await loadSwitchInstance(instanceId);
  const { free, nextFreeAt } = freeState(inst);
  const cooldown = inst.nodeSwitchedAt && inst.nodeSwitchedAt.getTime() + SWITCH_COOLDOWN_MS > Date.now() ? new Date(inst.nodeSwitchedAt.getTime() + SWITCH_COOLDOWN_MS).toISOString() : null;
  return {
    current: { id: inst.node.id, name: inst.node.name, region: inst.node.region, country: inst.node.country, trafficMultiplier: multiplierOf(inst, inst.nodeId), traffic: inst.traffic },
    targets: await switchTargets(inst),
    free,
    nextFreeAt,
    fee: new Prisma.Decimal((await getSettings()).nodeSwitchFee).toFixed(2),
    cooldownUntil: cooldown,
    blocked: await blockedReason(inst),
  };
}

export interface SwitchRequest {
  targetNodeId: number;
  imageId: number;
  password?: string;
  sshKeys?: string[];
}

/** 提交切换：校验、免费或扣费，然后提交后台任务；返回新的 root 密码 */
export async function requestSwitch(user: User, instanceId: number, req: SwitchRequest): Promise<{ password: string; free: boolean; fee: string; taskId: number }> {
  const inst = await loadSwitchInstance(instanceId);
  await assertNotListed(inst.id);
  const blocked = await blockedReason(inst);
  if (blocked) throw badRequest(blocked);
  if (inst.nodeSwitchedAt && inst.nodeSwitchedAt.getTime() + SWITCH_COOLDOWN_MS > Date.now()) throw conflict(t('switch.cooldown'));
  const target = (await switchTargets(inst)).find((n) => n.id === req.targetNodeId);
  if (!target) throw badRequest(t('switch.targetInvalid'));
  if (!target.available) throw conflict(t('switch.targetFull'));
  const targetNode = await prisma.node.findUniqueOrThrow({ where: { id: target.id } });
  const image = await prisma.image.findUnique({ where: { id: req.imageId } });
  if (!image?.enabled || (inst.type.startsWith('KVM') ? !image.forVm : !image.forContainer)) throw badRequest(t('image.unavailable'));
  if (!nodeAllowsImage(targetNode, image)) throw badRequest(t('switch.imageNotOnTarget'));

  // 等待 Agent 的即时 ICMP 结果；无法检测时保留原有的切换策略。
  const ipv4 = await checkIpv4(inst.id);
  if (ipv4.status === 'pending') throw conflict(t('switch.ipPending'));
  if (ipv4.status === 'blocked') throw conflict(t('switch.ipBlocked'));

  const { free } = freeState(inst);
  const fee = free ? new Prisma.Decimal(0) : new Prisma.Decimal((await getSettings()).nodeSwitchFee);
  if (!free && fee.lte(0)) throw conflict(t('switch.freeUsed'));
  const password = req.password || generatePassword();
  // 额外切换：先扣费（余额不足时 changeBalance 拒绝），任务失败时退回
  if (fee.gt(0)) {
    await prisma.$transaction((tx) => changeBalance(tx, user.id, fee.negated(), 'SWITCH', t('log.switchNode', { hostname: inst.hostname, from: inst.node.name, to: targetNode.name })));
  }
  const queued = await enqueueTask({
    instanceId: inst.id,
    type: 'SWITCH_NODE',
    userId: user.id,
    payload: { targetNodeId: targetNode.id, imageId: image.id, password: encrypt(password), sshKeys: req.sshKeys ?? [], free, fee: fee.toFixed(2) },
  });
  return { password, free, fee: fee.toFixed(2), taskId: queued.id };
}

/** 失败时退回额外切换的费用 */
async function refundFee(inst: Instance, fee: string) {
  if (Number(fee) <= 0) return;
  await prisma.$transaction((tx) => changeBalance(tx, inst.userId, new Prisma.Decimal(fee), 'SWITCH', t('log.switchNodeRefund', { hostname: inst.hostname })));
}

/**
 * 后台任务：在目标宿主机上全新创建实例。原实例在创建成功前保持不动；成功后删除原实例，
 * 失败时把网络资源还回原宿主机并退回费用。
 */
export async function runSwitch(instanceId: number, payload: Record<string, unknown>, sourceIncus: IncusApi, password: string): Promise<void> {
  const loadFull = () => prisma.instance.findUniqueOrThrow({ where: { id: instanceId }, include: { node: true, ipAddress: true, portMappings: true, plan: { include: { product: true } } } });
  let inst = await loadFull();
  const fee = String(payload.fee ?? '0');
  const free = payload.free === true;
  const source = inst.node;
  let target = await prisma.node.findUniqueOrThrow({ where: { id: Number(payload.targetNodeId) } });
  const image = await prisma.image.findUniqueOrThrow({ where: { id: Number(payload.imageId) } });
  const sshKeys = Array.isArray(payload.sshKeys) ? (payload.sshKeys as string[]) : [];
  const prevStatus = inst.status;
  // VPC 只在一台宿主机内有效：切换前移出
  if (inst.vpcId) {
    await detachInstance(inst);
    inst = await loadFull();
  }
  if (isNatType(inst.type)) target = await ensureNatNetwork(target);
  const targetIncus = await getIncus(target);
  const before = currentPlacement(inst as MigratingInstance);
  // 目标宿主机上的系统盘存储池：产品为该宿主机设置的存储池，否则用套餐的
  const pool = (inst.plan ? productNodeOption(inst.plan.product.nodeOptions, target.id).storagePool : null) ?? inst.plan?.storagePool ?? null;
  // 流量额度按目标宿主机的倍率换算；已用流量不变，换算后未超额则解除限速（新实例按正常带宽创建）
  const traffic = switchTraffic(inst.traffic, multiplierOf(inst, source.id), multiplierOf(inst, target.id));
  const throttled = inst.trafficThrottled && traffic > 0 && trafficUsedBytes(inst) >= BigInt(traffic) * 1024n ** 3n;
  await prisma.instance.update({ where: { id: inst.id }, data: { status: 'MIGRATING', lastError: null } });

  let placed = false;
  try {
    await place(inst, target, { ports: before.ports }, true);
    placed = true;
    const moved = await prisma.instance.update({
      where: { id: inst.id },
      data: { storagePool: pool, traffic, trafficThrottled: throttled },
      include: { node: true, ipAddress: true, portMappings: true },
    });
    // 目标宿主机上可能残留同名实例（之前的失败），先删除
    if (await targetIncus.instanceExists(moved.name).catch(() => false)) await targetIncus.deleteInstance(moved.name);
    await targetIncus.createInstance(
      buildCreateRequest({ instance: moved, node: target, image, ip: moved.ipAddress, portMappings: moved.portMappings, vars: { hostname: moved.hostname, password, sshKeys } }),
    );
  } catch (err) {
    const reason = errorMessage(err);
    try {
      if (await targetIncus.instanceExists(inst.name).catch(() => false)) await targetIncus.deleteInstance(inst.name).catch(() => undefined);
      if (placed) await place(inst, source, before, false);
      await prisma.instance.update({ where: { id: inst.id }, data: { status: prevStatus, storagePool: inst.storagePool, traffic: inst.traffic, trafficThrottled: inst.trafficThrottled } });
      await refundFee(inst, fee);
    } catch (rollbackErr) {
      await prisma.instance.update({ where: { id: inst.id }, data: { status: 'ERROR', lastError: t('switch.rollbackFailed', { message: errorMessage(rollbackErr) }) } });
      throw new Error(t('switch.rollbackFailed', { message: `${reason}；${errorMessage(rollbackErr)}` }));
    }
    throw new Error(t('switch.failed', { message: reason }));
  }

  // 新实例已创建：删除原宿主机上的实例（失败只记录提示），快照随原实例删除
  let warning: string | null = null;
  try {
    if (await sourceIncus.instanceExists(inst.name)) {
      await sourceIncus.setState(inst.name, 'stop', { force: true, timeout: 30 }).catch(() => undefined);
      await sourceIncus.deleteInstance(inst.name);
    }
  } catch (err) {
    if (!(err instanceof IncusError && err.isNotFound)) warning = t('switch.sourceLeft', { node: source.name, message: errorMessage(err) });
  }
  const now = new Date();
  await prisma.$transaction([
    prisma.snapshot.deleteMany({ where: { instanceId: inst.id } }),
    prisma.instance.update({
      where: { id: inst.id },
      data: {
        status: 'RUNNING',
        image: { connect: { id: image.id } },
        rootPassword: encrypt(password),
        lastReinstallAt: now,
        nodeSwitchedAt: now,
        // 只有免费切换成功后才重新计时；额外切换不推迟下一次免费时间
        ...(free ? { freeSwitchAt: now } : {}),
        lastError: warning,
      },
    }),
  ]);
  await Promise.all([syncSitesSafe(source.id), syncSitesSafe(target.id)]);
  // 换算后的额度若已用完，按超额策略限速或停机
  await enforceTrafficLimit(await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } }));
}

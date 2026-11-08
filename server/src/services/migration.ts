import { DEFAULT_LOCALE, hasIpv6Mode, isNatType, isPublicIpv4Mode, normalizeLocale, parseIpv6List } from '../shared/index.ts';
import { getIncus, IncusError, type IncusApi } from '../incus/index.ts';
import type { IncusInstance, IncusInstanceCreate } from '../incus/types.ts';
import { badRequest, conflict, errorMessage } from '../lib/errors.ts';
import { prisma, type Instance, type IpAddress, type Node, type PortMapping, type Prisma } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { labels, runWithLocale, t } from '../i18n/index.ts';
import { allocatePrivateIp, allocatePublicIpv6, allocatePublicPort, ensureNatNetwork, isPortInRange, usedPrivateIps, usedPublicIpv6 } from './allocation.ts';
import { syncSitesSafe } from './gateway.ts';
import { detachInstance, VPC_DEVICE } from './vpc.ts';
import { bumpEgressVersion } from './egress.ts';
import { applyConfig, buildIpv6Nic, buildLimitsConfig, buildNic, diskLimits, presentConfig, buildProxyDevices, isManagedProxyDevice, networkConfig } from './spec.ts';

type Tx = Prisma.TransactionClient;
export type MigratingInstance = Instance & { node: Node; ipAddress: IpAddress | null; portMappings: PortMapping[] };

/** 实例在某台宿主机上占用的网络资源 */
interface Placement {
  nodeId: number;
  privateIp: string | null;
  publicIpv6: string | null;
  ipId: number | null;
  /** 端口映射 id → 公网端口 */
  ports: Record<number, number>;
}

/**
 * 迁移后需要重新应用网络配置的虚拟机使用的 user-data：只让 cloud-init 重新配置网络，
 * 不改动系统中已有的用户、密码与 SSH 主机密钥（重新执行原始 user-data 会把用户自己改过的密码重置）
 */
const MIGRATION_USER_DATA = [
  '#cloud-config',
  'preserve_hostname: true',
  'ssh_deletekeys: false',
  'disable_root: false',
  'users: []',
  '',
].join('\n');

/** 校验实例能否迁移到目标宿主机（提交任务时与执行时都会检查） */
export async function assertMigratable(inst: Instance & { node: Node }, target: Node): Promise<void> {
  if (target.id === inst.nodeId) throw badRequest(t('migrate.sameNode'));
  if (!['RUNNING', 'STOPPED', 'SUSPENDED'].includes(inst.status)) throw badRequest(t('migrate.badStatus'));
  if (!target.endpoint || target.status === 'PENDING') throw badRequest(t('migrate.targetNotReady', { node: target.name }));
  if (target.status === 'OFFLINE') throw badRequest(t('migrate.targetOffline', { node: target.name }));
  // NAT 实例只能迁到 NAT / IPv6 宿主机，独立 IPv4 实例只能迁到独立 IPv4 宿主机
  if (isPublicIpv4Mode(target.networkMode) === isNatType(inst.type)) throw badRequest(t('migrate.modeMismatch', { node: target.name }));
  // IPv6 Only 宿主机没有端口映射，与有端口映射的宿主机之间迁移会丢失映射
  if ((target.networkMode === 'IPV6_ONLY') !== (inst.node.networkMode === 'IPV6_ONLY')) throw badRequest(t('migrate.ipv6OnlyMismatch'));
  if (hasIpv6Mode(target.networkMode) && !target.ipv6Subnet) throw badRequest(t('migrate.noIpv6Subnet', { node: target.name }));
  // 自定义存储卷不随实例迁移
  if ((await prisma.volume.count({ where: { instanceId: inst.id } })) > 0) throw badRequest(t('migrate.hasVolumes'));
}

export function currentPlacement(inst: MigratingInstance): Placement {
  return {
    nodeId: inst.nodeId,
    privateIp: inst.privateIp,
    publicIpv6: inst.publicIpv6,
    ipId: inst.ipAddress?.id ?? null,
    ports: Object.fromEntries(inst.portMappings.map((m) => [m.id, m.publicPort])),
  };
}

/**
 * 把实例的网络资源（内网 IP、公网 IPv6、独立 IPv4、端口映射）分配到指定宿主机，并把实例记录指向该宿主机。
 * 尽量沿用 prefer 中的值（迁移时沿用原端口号，回滚时恢复原来的全部资源），被占用时重新分配。
 */
export async function place(inst: Instance, node: Node, prefer: Partial<Placement>, checkCapacity: boolean): Promise<Placement> {
  const run = (tx: Tx) => doPlace(tx, inst, node, prefer, checkCapacity);
  const placement = await withLock(`node-alloc:${node.id}`, 30_000, () => withLock(`node-ports:${node.id}`, 30_000, () => prisma.$transaction(run)));
  // 使用了智能分流出口的实例离开原宿主机：刷新原宿主机的分流配置（内网地址可能分给其他实例）
  if (inst.egressId && node.id !== inst.nodeId) await bumpEgressVersion(inst.nodeId);
  return placement;
}

async function doPlace(tx: Tx, inst: Instance, node: Node, prefer: Partial<Placement>, checkCapacity: boolean): Promise<Placement> {
  if (checkCapacity) {
    const active = await tx.instance.count({ where: { nodeId: node.id, status: { notIn: ['DELETED'] } } });
    if (active >= node.maxInstances) throw conflict(t('migrate.targetFull', { node: node.name }));
  }

  let privateIp: string | null = null;
  if (isNatType(inst.type)) {
    const used = await usedPrivateIps(tx, node);
    privateIp = prefer.privateIp && !used.has(prefer.privateIp) ? prefer.privateIp : await allocatePrivateIp(tx, node);
  }

  let publicIpv6: string | null = null;
  if (hasIpv6Mode(node.networkMode) && node.ipv6Subnet) {
    const want = parseIpv6List(prefer.publicIpv6);
    const used = await usedPublicIpv6(tx, node);
    publicIpv6 = want.length && want.every((a) => !used.has(a)) ? want.join(',') : await allocatePublicIpv6(tx, node, Math.max(1, want.length));
  }

  let ipId: number | null = null;
  if (!isNatType(inst.type)) {
    await tx.ipAddress.updateMany({ where: { instanceId: inst.id }, data: { instanceId: null } });
    const preferred = prefer.ipId ? await tx.ipAddress.findFirst({ where: { id: prefer.ipId, nodeId: node.id, instanceId: null } }) : null;
    const ip = preferred ?? (await tx.ipAddress.findFirst({ where: { nodeId: node.id, instanceId: null, disabled: false }, orderBy: { id: 'asc' } }));
    if (!ip) throw conflict(t('migrate.noFreeIp', { node: node.name }));
    await tx.ipAddress.update({ where: { id: ip.id }, data: { instanceId: inst.id } });
    ipId = ip.id;
  }

  // 逐条搬移端口映射：优先使用原端口号，已被占用或不在目标端口范围内时重新分配
  const ports: Record<number, number> = {};
  let sshPort: number | null = null;
  const mappings = await tx.portMapping.findMany({ where: { instanceId: inst.id }, orderBy: { id: 'asc' } });
  for (const m of mappings) {
    const want = prefer.ports?.[m.id] ?? m.publicPort;
    const free = isPortInRange(node, want) && (await tx.portMapping.count({ where: { nodeId: node.id, publicPort: want } })) === 0;
    const publicPort = free ? want : await allocatePublicPort(tx, node);
    await tx.portMapping.update({ where: { id: m.id }, data: { nodeId: node.id, publicPort } });
    ports[m.id] = publicPort;
    if (m.system && m.privatePort === 22) sshPort = publicPort;
  }

  // 出口属于原宿主机：换到其他宿主机时清除
  await tx.instance.update({ where: { id: inst.id }, data: { nodeId: node.id, privateIp, publicIpv6, sshPort, ...(node.id !== inst.nodeId ? { egressId: null } : {}) } });
  return { nodeId: node.id, privateIp, publicIpv6, ipId, ports };
}

async function loadInstance(id: number): Promise<MigratingInstance> {
  return prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true, ipAddress: true, portMappings: true } });
}

/** 目标宿主机上的实例定义：保留源实例的配置（含 volatile 状态），按新宿主机重建磁盘与网卡设备 */
function buildTargetRequest(src: IncusInstance, inst: MigratingInstance, pool: string): Omit<IncusInstanceCreate, 'source'> {
  const node = inst.node;
  const devices = { ...src.devices };
  for (const name of Object.keys(devices)) {
    // VPC 网卡连接的是源宿主机上的网桥，迁移前已移出 VPC
    if (name === 'root' || name === 'eth0' || name === 'eth1' || name === VPC_DEVICE || isManagedProxyDevice(name)) delete devices[name];
  }
  devices.root = { type: 'disk', path: '/', pool, size: `${inst.disk}GiB`, ...presentConfig(diskLimits(inst)) };
  devices.eth0 = buildNic(inst, node, inst.ipAddress);
  const v6 = buildIpv6Nic(inst, node);
  if (v6) devices.eth1 = v6;
  if (isNatType(inst.type) && inst.privateIp) {
    for (const m of inst.portMappings) Object.assign(devices, buildProxyDevices(node, inst, m));
  }

  const config: Record<string, string> = { ...src.config, 'user.paledove.id': String(inst.id) };
  applyConfig(config, buildLimitsConfig(inst));
  // 虚拟机的静态网络配置发生变化时，生成新的 cloud-init 实例 ID，让系统在首次启动时重新配置网络
  const net = networkConfig(inst, node, inst.ipAddress);
  if ((net ?? '') !== (src.config['cloud-init.network-config'] ?? '')) {
    if (net) config['cloud-init.network-config'] = net;
    else delete config['cloud-init.network-config'];
    delete config['volatile.cloud-init.instance-id'];
    config['cloud-init.user-data'] = MIGRATION_USER_DATA;
  }

  return {
    name: inst.name,
    type: src.type,
    description: src.description,
    config,
    devices,
    profiles: [node.profile],
  };
}

async function rootPool(incus: IncusApi, inst: Instance, node: Node): Promise<string> {
  const names = (await incus.listStoragePools()).map((p) => p.name);
  if (inst.storagePool && names.includes(inst.storagePool)) return inst.storagePool;
  if (!names.includes(node.storagePool)) throw new Error(t('migrate.noPool', { node: node.name, pool: node.storagePool }));
  return node.storagePool;
}

async function stopForMigration(incus: IncusApi, name: string): Promise<void> {
  try {
    await incus.setState(name, 'stop', { timeout: 60 });
  } catch {
    await incus.setState(name, 'stop', { force: true, timeout: 30 });
  }
}

/** 回滚后网络资源与原来不同（原资源已被占用）时，更新源宿主机上实例的网卡与端口映射设备 */
async function restoreSourceDevices(incus: IncusApi, inst: MigratingInstance, before: Placement, after: Placement): Promise<void> {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  await incus.modifyInstance(inst.name, (i) => {
    for (const name of Object.keys(i.devices)) if (name === 'eth1' || isManagedProxyDevice(name)) delete i.devices[name];
    i.devices.eth0 = buildNic(inst, inst.node, inst.ipAddress);
    const v6 = buildIpv6Nic(inst, inst.node);
    if (v6) i.devices.eth1 = v6;
    if (isNatType(inst.type) && inst.privateIp) {
      for (const m of inst.portMappings) Object.assign(i.devices, buildProxyDevices(inst.node, inst, m));
    }
    const net = networkConfig(inst, inst.node, inst.ipAddress);
    if (net) i.config['cloud-init.network-config'] = net;
  });
}

/** 给实例所有者发站内信，说明新的连接信息（使用用户自己的语言） */
async function notifyOwner(inst: MigratingInstance): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: inst.userId }, select: { locale: true } });
  const sites = await prisma.siteBinding.findMany({ where: { instanceId: inst.id }, select: { domain: true } });
  const node = inst.node;
  await runWithLocale(normalizeLocale(user.locale) ?? DEFAULT_LOCALE, async () => {
    const lines = [t('migrate.msgIntro', { hostname: inst.hostname, region: node.region })];
    if (inst.ipAddress) lines.push(t('migrate.msgIpv4', { ip: inst.ipAddress.address }));
    if (inst.sshPort) lines.push(t('migrate.msgSsh', { address: `${node.publicIp}:${inst.sshPort}` }));
    if (inst.publicIpv6) lines.push(t('migrate.msgIpv6', { ip: parseIpv6List(inst.publicIpv6).join(', ') }));
    const userPorts = inst.portMappings.filter((m) => !m.system);
    if (userPorts.length > 0) {
      const list = userPorts.map((m) => `${labels().portProtocol[m.protocol]} ${m.publicPort} → ${m.privatePort}`).join('，');
      lines.push(t('migrate.msgPorts', { list }));
    }
    if (sites.length > 0) lines.push(t('migrate.msgSites', { domains: sites.map((s) => s.domain).join('、'), ip: node.publicIp }));
    await prisma.message.create({ data: { userId: inst.userId, title: t('migrate.msgTitle', { hostname: inst.hostname }), content: lines.join('\n') } });
  });
}

/**
 * 迁移任务：关机 → 在目标宿主机分配网络资源 → 目标宿主机从源宿主机拉取实例（含快照）→ 删除源实例 → 恢复原来的电源状态 → 通知用户。
 * 传输失败时把网络资源恢复到源宿主机并按原状态启动，源宿主机上的实例在成功前不会被删除。
 */
export async function migrateInstance(instanceId: number, targetNodeId: number, sourceIncus: IncusApi): Promise<void> {
  let inst = await loadInstance(instanceId);
  const source = inst.node;
  let target = await prisma.node.findUniqueOrThrow({ where: { id: targetNodeId } });
  await assertMigratable(inst, target);
  // VPC 只在一台宿主机内有效：迁移前先移出
  if (inst.vpcId) {
    await detachInstance(inst);
    inst = await loadInstance(instanceId);
  }
  if (isNatType(inst.type)) target = await ensureNatNetwork(target);
  const targetIncus = await getIncus(target);
  const pool = await rootPool(targetIncus, inst, target);
  const sourceServer = await sourceIncus.getServer();

  const before = currentPlacement(inst);
  const wasRunning = (await sourceIncus.getInstanceState(inst.name)).status === 'Running';
  // 迁移结束（无论成功与否）后恢复原来的状态
  const finalStatus = inst.status === 'SUSPENDED' ? 'SUSPENDED' : wasRunning ? 'RUNNING' : 'STOPPED';
  await prisma.instance.update({ where: { id: inst.id }, data: { status: 'MIGRATING', lastError: null } });

  let placed = false;
  try {
    if (wasRunning) await stopForMigration(sourceIncus, inst.name);
    const srcInstance = await sourceIncus.getInstance(inst.name);
    await place(inst, target, { ports: before.ports }, true);
    placed = true;
    const moved = await loadInstance(inst.id);
    const req = buildTargetRequest(srcInstance, moved, pool);
    const { operation, secrets } = await sourceIncus.startMigration(inst.name);
    await targetIncus.createInstance({
      ...req,
      source: {
        type: 'migration',
        mode: 'pull',
        operation: new URL(operation, source.endpoint!.startsWith('mock://') ? 'https://mock' : source.endpoint!).toString(),
        certificate: sourceServer.environment?.certificate ?? '',
        secrets,
      },
    });
  } catch (err) {
    const reason = errorMessage(err);
    try {
      // 目标宿主机上可能留下了不完整的实例
      if (await targetIncus.instanceExists(inst.name).catch(() => false)) await targetIncus.deleteInstance(inst.name).catch(() => undefined);
      if (placed) {
        const after = await place(inst, source, before, false);
        await restoreSourceDevices(sourceIncus, await loadInstance(inst.id), before, after);
      }
      if (wasRunning) await sourceIncus.setState(inst.name, 'start');
      await prisma.instance.update({ where: { id: inst.id }, data: { status: finalStatus } });
    } catch (rollbackErr) {
      await prisma.instance.update({
        where: { id: inst.id },
        data: { status: 'ERROR', lastError: t('migrate.rollbackFailed', { message: errorMessage(rollbackErr) }) },
      });
      throw new Error(t('migrate.rollbackFailed', { message: `${reason}；${errorMessage(rollbackErr)}` }));
    }
    throw new Error(t('migrate.failed', { message: reason }));
  }

  // 目标宿主机上已有完整实例，删除源实例；删除失败不影响迁移结果，只记录提示
  let warning: string | null = null;
  try {
    await sourceIncus.deleteInstance(inst.name);
  } catch (err) {
    if (!(err instanceof IncusError && err.isNotFound)) warning = t('migrate.sourceLeft', { node: source.name, message: errorMessage(err) });
  }
  if (wasRunning) await targetIncus.setState(inst.name, 'start');
  await prisma.instance.update({
    where: { id: inst.id },
    data: { status: finalStatus, storagePool: pool === target.storagePool ? null : pool, lastError: warning },
  });
  await Promise.all([syncSitesSafe(source.id), syncSitesSafe(target.id)]);
  await notifyOwner(await loadInstance(inst.id)).catch(() => undefined);
}

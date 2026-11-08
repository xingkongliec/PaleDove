import { isNatType, portQuotaCost, portQuotaUsed, type PortProtocol } from '../shared/index.ts';
import { getIncus, IncusError } from '../incus/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { prisma, Prisma, type Instance, type Node, type PortMapping } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { allocatePublicPort } from './allocation.ts';
import { t } from '../i18n/index.ts';
import { buildProxyDevices, ipv6DeviceName, isManagedProxyDevice, proxyDeviceNames } from './spec.ts';

type InstanceWithNode = Instance & { node: Node };

export interface PortMappingInput {
  protocol: PortProtocol;
  privatePort: number;
  publicPort?: number;
  description?: string | null;
}

/** 实例是否已在 Incus 中存在（创建完成之前设备会在创建时一并下发） */
function existsInIncus(inst: Instance): boolean {
  return inst.status !== 'CREATING' && inst.status !== 'DELETED' && inst.status !== 'DELETING';
}

export async function addPortMapping(
  inst: InstanceWithNode,
  input: PortMappingInput,
  opts: { system?: boolean } = {},
): Promise<PortMapping> {
  if (!isNatType(inst.type)) throw badRequest(t('port.natOnly'));
  if (inst.node.networkMode === 'IPV6_ONLY') throw badRequest(t('port.ipv6Only'));
  if (!inst.privateIp) throw badRequest(t('port.noPrivateIp'));
  if (!opts.system) {
    // TCP+UDP 占 2 个配额
    const used = portQuotaUsed(await prisma.portMapping.findMany({ where: { instanceId: inst.id, system: false }, select: { protocol: true, system: true } }));
    const cost = portQuotaCost(input.protocol);
    if (used + cost > inst.portLimit) {
      throw badRequest(used < inst.portLimit ? t('port.limitTcpUdp', { left: inst.portLimit - used }) : t('port.limit', { limit: inst.portLimit }));
    }
  }

  const mapping = await withLock(`node-ports:${inst.nodeId}`, 10_000, async () => {
    const publicPort = await allocatePublicPort(prisma, inst.node, input.publicPort);
    try {
      return await prisma.portMapping.create({
        data: {
          instanceId: inst.id,
          nodeId: inst.nodeId,
          protocol: input.protocol,
          publicPort,
          privatePort: input.privatePort,
          description: input.description || null,
          system: opts.system ?? false,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw conflict(t('port.taken', { port: publicPort }));
      }
      throw err;
    }
  });

  if (existsInIncus(inst)) {
    try {
      const incus = await getIncus(inst.node);
      const devices = buildProxyDevices(inst.node, inst, mapping);
      await incus.modifyInstance(inst.name, (i) => Object.assign(i.devices, devices));
    } catch (err) {
      await prisma.portMapping.delete({ where: { id: mapping.id } }).catch(() => undefined);
      throw err;
    }
  }
  return mapping;
}

export async function removePortMapping(inst: InstanceWithNode, mapping: PortMapping, opts: { force?: boolean } = {}): Promise<void> {
  if (mapping.system && !opts.force) throw badRequest(t('port.systemProtected'));
  if (existsInIncus(inst)) {
    const incus = await getIncus(inst.node);
    try {
      await incus.modifyInstance(inst.name, (i) => {
        for (const name of proxyDeviceNames(mapping)) {
          delete i.devices[name];
          delete i.devices[ipv6DeviceName(name)];
        }
      });
    } catch (err) {
      if (!(err instanceof IncusError && err.isNotFound)) throw err;
    }
  }
  await prisma.portMapping.delete({ where: { id: mapping.id } });
}

/** 以数据库为准，修正 Incus 中的端口映射设备 */
export async function reconcileProxyDevices(inst: InstanceWithNode): Promise<void> {
  if (!isNatType(inst.type) || !inst.privateIp) return;
  const mappings = await prisma.portMapping.findMany({ where: { instanceId: inst.id } });
  const desired: Record<string, Record<string, string>> = {};
  for (const m of mappings) Object.assign(desired, buildProxyDevices(inst.node, inst, m));
  const incus = await getIncus(inst.node);
  await incus.modifyInstance(inst.name, (i) => {
    for (const name of Object.keys(i.devices)) {
      if (isManagedProxyDevice(name) && !desired[name]) delete i.devices[name];
    }
    Object.assign(i.devices, desired);
  });
}

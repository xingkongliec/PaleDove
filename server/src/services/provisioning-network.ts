import type { IncusApi } from '../incus/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { prisma } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { isNatType } from '../shared/index.ts';
import { t } from '../i18n/index.ts';
import { allocatePrivateIp, ensureNatNetwork, hostPrivateIps } from './allocation.ts';
import { bumpEgressVersion } from './egress.ts';
import type { FullInstance } from './operations.ts';
import { buildNic, buildProxyDevices, isManagedProxyDevice, networkConfig } from './spec.ts';

/** 首次开通重试时，把已停止的残留实例同步到数据库中保留的地址。 */
export async function syncProvisioningNetwork(inst: FullInstance, incus: IncusApi): Promise<void> {
  if (inst.provisionedAt || !isNatType(inst.type) || !inst.privateIp) return;
  const remote = await incus.getInstance(inst.name);
  const nic = (remote.expanded_devices ?? remote.devices).eth0;
  if (nic?.['ipv4.address'] === inst.privateIp || remote.status === 'Running') return;
  await incus.modifyInstance(inst.name, (current) => {
    if (current.status !== 'Stopped' || current.config['user.paledove.id'] !== String(inst.id)) {
      throw new Error(t('task.privateIpRepairUnsafe'));
    }
    const currentNic = (current.expanded_devices ?? current.devices).eth0;
    current.devices.eth0 = { ...currentNic, ...buildNic(inst, inst.node, inst.ipAddress) };
    for (const key of Object.keys(current.devices)) if (isManagedProxyDevice(key)) delete current.devices[key];
    for (const mapping of inst.portMappings) Object.assign(current.devices, buildProxyDevices(inst.node, inst, mapping));
    const net = networkConfig(inst, inst.node, inst.ipAddress);
    if (net) current.config['cloud-init.network-config'] = net;
  });
  if (inst.egressId) await bumpEgressVersion(inst.nodeId);
}

/** Incus 仍负责最终冲突校验，覆盖租约读取后抢占地址或其他项目不可见的网卡。 */
export async function withPrivateIpRecovery(inst: FullInstance, incus: IncusApi, start: () => Promise<void>): Promise<void> {
  const rejected = new Set<string>();
  for (let attempt = 0; ; attempt++) {
    try {
      await start();
      return;
    } catch (error) {
      const address = /IP address "([\d.]+)" already defined on another NIC/.exec(errorMessage(error))?.[1];
      if (attempt >= 3 || inst.provisionedAt || !isNatType(inst.type) || !address || address !== inst.privateIp) throw error;
      rejected.add(address);
      const repaired = await withLock(`node-alloc:${inst.nodeId}`, 60_000, async () => {
        const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id }, include: { node: true, image: true, ipAddress: true, portMappings: true } });
        if (fresh.provisionedAt || fresh.status === 'DELETED' || fresh.nodeId !== inst.nodeId || fresh.privateIp !== inst.privateIp) return false;
        if (await incus.instanceExists(inst.name)) {
          const remote = await incus.getInstance(inst.name);
          if (remote.status !== 'Stopped' || remote.config['user.paledove.id'] !== String(inst.id)) return false;
        }
        const node = await ensureNatNetwork(fresh.node);
        const occupied = await hostPrivateIps(node);
        for (const ip of rejected) occupied.add(ip);
        const privateIp = await allocatePrivateIp(prisma, node, occupied);
        const updated = await prisma.instance.updateMany({
          where: { id: fresh.id, nodeId: node.id, provisionedAt: null, privateIp: fresh.privateIp, status: { not: 'DELETED' } },
          data: { privateIp },
        });
        if (!updated.count) return false;
        // 先保留新地址。宿主机更新失败时，下一次重试仍能按此记录完成同步。
        Object.assign(inst, fresh, { node, privateIp });
        return true;
      });
      if (!repaired) throw error;
    }
  }
}

import type { Instance, IpAddress, Node } from '../../lib/prisma.ts';

export type PingInstance = Pick<Instance, 'id' | 'type' | 'status' | 'macAddress'> & {
  node: Pick<Node, 'id' | 'endpoint' | 'publicIp' | 'networkMode' | 'publicNicMode' | 'publicNicParent'>;
  ipAddress: Pick<IpAddress, 'address' | 'gateway'> | null;
};

export interface InstancePingJob {
  id: number;
  ip: string;
  kind: 'nat' | 'dedicated';
  mac?: string;
  gateway?: string;
  bridge?: string;
}

/** 上架拨测与切换机房共用：必须以实例实际对外的 IPv4 和 MAC 发送。 */
export function instancePingJob(id: number, inst: PingInstance): InstancePingJob {
  if (inst.type !== 'KVM_IPV4') return { id, ip: inst.node.publicIp, kind: 'nat' };
  const job: InstancePingJob = { id, ip: inst.ipAddress?.address ?? '', kind: 'dedicated' };
  if (inst.node.publicNicMode === 'BRIDGED' && inst.node.publicNicParent) {
    job.mac = inst.macAddress ?? undefined;
    job.gateway = inst.ipAddress?.gateway ?? undefined;
    job.bridge = inst.node.publicNicParent;
  }
  return job;
}

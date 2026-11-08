import { randomInt } from 'node:crypto';
import { getIncus } from '../incus/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { allocateFromCidr, allocateIpv6Prefix, bigIntToIpv6, isIPv4, parseIpv6Cidr, parseCidr } from '../lib/ip.ts';
import { parseIpv6List } from '../shared/index.ts';
import { prisma, type Node, type Prisma } from '../lib/prisma.ts';
import { t } from '../i18n/index.ts';

type Db = Prisma.TransactionClient | typeof prisma;

/** 确保节点已同步 NAT 网络网段（从 Incus 托管网桥读取 ipv4.address） */
export async function ensureNatNetwork(node: Node): Promise<Node> {
  if (node.natCidr) return node;
  const incus = await getIncus(node);
  const network = await incus.getNetwork(node.natNetwork);
  const cidr = network.config['ipv4.address'];
  if (!cidr || cidr === 'none') throw new Error(t('node.noIpv4Network', { network: node.natNetwork }));
  parseCidr(cidr);
  return prisma.node.update({ where: { id: node.id }, data: { natCidr: cidr } });
}

/** 在数据库事务之外读取；租约查询失败时禁止继续盲分配。 */
export async function hostPrivateIps(node: Node, own?: { name: string; macAddress: string | null }): Promise<Set<string>> {
  const leases = await (await getIncus(node)).getNetworkLeases(node.natNetwork);
  const ownMac = own?.macAddress?.toLowerCase();
  return new Set(leases.filter((lease) => {
    if (!isIPv4(lease.address)) return false;
    const ownLease = ownMac && lease.hwaddr?.toLowerCase() === ownMac &&
      ((lease.type === 'static' && lease.hostname === own?.name) || lease.type === 'dynamic');
    return !ownLease;
  }).map((lease) => lease.address));
}

export async function usedPrivateIps(db: Db, node: Node, hostIps: ReadonlySet<string>, excludeInstanceId?: number): Promise<Set<string>> {
  const rows = await db.instance.findMany({
    where: { nodeId: node.id, privateIp: { not: null }, ...(excludeInstanceId ? { id: { not: excludeInstanceId } } : {}) },
    select: { privateIp: true },
  });
  return new Set([...hostIps, ...rows.map((r) => r.privateIp!)]);
}

export async function allocatePrivateIp(db: Db, node: Node, hostIps: ReadonlySet<string>): Promise<string> {
  if (!node.natCidr) throw new Error(t('node.natNotSynced'));
  const ip = allocateFromCidr(node.natCidr, await usedPrivateIps(db, node, hostIps));
  if (!ip) throw conflict(t('node.privateIpExhausted'));
  return ip;
}

/** 宿主机上已被实例占用的公网 IPv6 */
export async function usedPublicIpv6(db: Db, node: Pick<Node, 'id'>): Promise<Set<string>> {
  const rows = await db.instance.findMany({ where: { nodeId: node.id, publicIpv6: { not: null } }, select: { publicIpv6: true } });
  return new Set(rows.flatMap((r) => parseIpv6List(r.publicIpv6)));
}

/** 调用方持有节点分配锁；每份分配一个地址或一个独占网段及其主地址。 */
export async function allocateIpv6Resources(db: Db, node: Node, count = 1): Promise<{ publicIpv6: string | null; ipv6Prefixes: string | null }> {
  if (count <= 0) return { publicIpv6: null, ipv6Prefixes: null };
  const used = await usedPublicIpv6(db, node);
  const rows = await db.instance.findMany({ where: { nodeId: node.id, ipv6Prefixes: { not: null } }, select: { ipv6Prefixes: true } });
  const occupied = [...used, ...rows.flatMap((r) => parseIpv6List(r.ipv6Prefixes))];
  const out: string[] = [];
  const prefixes: string[] = [];
  for (let i = 0; i < count; i++) {
    const prefix = allocateIpv6Prefix(node.ipv6Subnet, node.ipv6PrefixLength ?? 128, occupied);
    if (!prefix) throw conflict(t('node.ipv6Exhausted'));
    occupied.push(prefix);
    const range = parseIpv6Cidr(prefix);
    out.push(bigIntToIpv6(range.network + (range.prefix < 128 ? 1n : 0n)));
    if (range.prefix < 128) prefixes.push(prefix);
  }
  return { publicIpv6: out.join(','), ipv6Prefixes: prefixes.join(',') || null };
}

export function isPortInRange(node: Pick<Node, 'portRangeStart' | 'portRangeEnd'>, port: number): boolean {
  return port >= node.portRangeStart && port <= node.portRangeEnd;
}

/** 在节点端口范围内分配一个空闲的公网端口；指定 preferred 时校验其可用性 */
export async function allocatePublicPort(db: Db, node: Node, preferred?: number): Promise<number> {
  const rows = await db.portMapping.findMany({ where: { nodeId: node.id }, select: { publicPort: true } });
  const used = new Set(rows.map((r) => r.publicPort));
  if (preferred !== undefined) {
    if (!isPortInRange(node, preferred)) {
      throw badRequest(t('port.outOfRange', { start: node.portRangeStart, end: node.portRangeEnd }));
    }
    if (used.has(preferred)) throw conflict(t('port.taken', { port: preferred }));
    return preferred;
  }
  const span = node.portRangeEnd - node.portRangeStart + 1;
  if (used.size >= span) throw conflict(t('port.exhausted'));
  for (let i = 0; i < 64; i++) {
    const port = node.portRangeStart + randomInt(span);
    if (!used.has(port)) return port;
  }
  for (let port = node.portRangeStart; port <= node.portRangeEnd; port++) if (!used.has(port)) return port;
  throw conflict(t('port.exhausted'));
}

export type NodeLoad = { node: Node; active: number; freeIps: number };

/** 统计节点负载，用于下单时选择节点 */
export async function nodeLoads(nodes: Node[]): Promise<NodeLoad[]> {
  if (nodes.length === 0) return [];
  const ids = nodes.map((n) => n.id);
  const [active, freeIps] = await Promise.all([
    prisma.instance.groupBy({
      by: ['nodeId'],
      where: { nodeId: { in: ids }, status: { not: 'DELETED' } },
      _count: { _all: true },
    }),
    prisma.ipAddress.groupBy({
      by: ['nodeId'],
      where: { nodeId: { in: ids }, instanceId: null, disabled: false },
      _count: { _all: true },
    }),
  ]);
  return nodes.map((node) => ({
    node,
    active: active.find((a) => a.nodeId === node.id)?._count._all ?? 0,
    freeIps: freeIps.find((a) => a.nodeId === node.id)?._count._all ?? 0,
  }));
}

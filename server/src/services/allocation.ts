import { randomInt } from 'node:crypto';
import { getIncus } from '../incus/index.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { allocateFromCidr, allocateIpv6, parseCidr } from '../lib/ip.ts';
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

export async function usedPrivateIps(db: Db, node: Node): Promise<Set<string>> {
  const rows = await db.instance.findMany({
    where: { nodeId: node.id, privateIp: { not: null } },
    select: { privateIp: true },
  });
  return new Set(rows.map((r) => r.privateIp!));
}

export async function allocatePrivateIp(db: Db, node: Node): Promise<string> {
  if (!node.natCidr) throw new Error(t('node.natNotSynced'));
  const ip = allocateFromCidr(node.natCidr, await usedPrivateIps(db, node));
  if (!ip) throw conflict(t('node.privateIpExhausted'));
  return ip;
}

/** 宿主机上已被实例占用的公网 IPv6 */
export async function usedPublicIpv6(db: Db, node: Pick<Node, 'id'>): Promise<Set<string>> {
  const rows = await db.instance.findMany({ where: { nodeId: node.id, publicIpv6: { not: null } }, select: { publicIpv6: true } });
  return new Set(rows.flatMap((r) => parseIpv6List(r.publicIpv6)));
}

/** 从宿主机 IPv6 子网为实例分配 count 个公网 IPv6，返回逗号分隔的地址（调用方需持有节点分配锁） */
export async function allocatePublicIpv6(db: Db, node: Node, count = 1): Promise<string> {
  const used = await usedPublicIpv6(db, node);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const ip = allocateIpv6(node.ipv6Subnet, used);
    if (!ip) throw conflict(t('node.ipv6Exhausted'));
    used.add(ip);
    out.push(ip);
  }
  return out.join(',');
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

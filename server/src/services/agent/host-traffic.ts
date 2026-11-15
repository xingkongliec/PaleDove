import { prisma, type Prisma } from '../../lib/prisma.ts';
import { redis, withLock } from '../../lib/redis.ts';
import { startOfDayUTC } from '../../lib/time.ts';
import { enforceTrafficLimit } from '../metrics.ts';

export interface HostCounter { generation: string; rx: number; tx: number }
export const PUBLIC_TRAFFIC_SCOPE = 'public-v1';
export interface HostTrafficSample { name: string; scope?: string; interfaces: Record<string, HostCounter> }
interface Baseline { source: 'host-public-v1'; interfaces: Record<string, HostCounter>; at?: number }
export const hostTrafficKey = (id: number) => `agent:public-traffic:v1:${id}`;

/** 切换到宿主机来源时只建立基线；同来源重启 / 网卡重建时累计新计数，缺失网卡保留旧基线。 */
export function hostTrafficDelta(previous: unknown, current: Record<string, HostCounter>) {
  const prev = previous as Baseline | null;
  let rx = 0n, tx = 0n;
  const trusted = prev?.source === 'host-public-v1';
  const merged = { ...(trusted ? prev.interfaces : {}) };
  for (const [nic, counter] of Object.entries(current)) {
    const old = trusted ? prev.interfaces[nic] : undefined;
    if (trusted) {
      const diff = (value: number, last?: number) => BigInt(Math.floor(last === undefined || value < last ? value : value - last));
      const same = old?.generation === counter.generation;
      rx += diff(counter.rx, same ? old.rx : undefined);
      tx += diff(counter.tx, same ? old.tx : undefined);
    }
    merged[nic] = counter;
  }
  return { rx, tx, baseline: { source: 'host-public-v1' as const, interfaces: merged } };
}

export async function trafficTargets(nodeId: number, project: string) {
  const [node, instances] = await Promise.all([
    prisma.node.findUniqueOrThrow({ where: { id: nodeId }, select: { publicIp: true, publicIpv6: true, natCidr: true, ipv6Subnet: true } }),
    prisma.instance.findMany({ where: { nodeId, status: { notIn: ['DELETED', 'DELETING', 'MIGRATING'] } }, select: { name: true, privateIp: true, publicIpv6: true, ipv6Prefixes: true, ipv6: true, vpcIp: true, ipAddress: { select: { address: true } } }, orderBy: { id: 'asc' } }),
  ]);
  const addresses = [node.publicIp, node.publicIpv6, node.natCidr, node.ipv6Subnet, ...instances.flatMap((r) => [r.privateIp, r.publicIpv6, r.ipv6Prefixes, r.ipv6, r.vpcIp, r.ipAddress?.address])];
  const excludeCidrs = [...new Set(addresses.flatMap((v) => (v ?? '').split(/[\s,]+/)).filter(Boolean))].sort();
  return { project, names: instances.map((r) => r.name), scope: PUBLIC_TRAFFIC_SCOPE, excludeCidrs };
}

export async function saveHostTraffic(nodeId: number, samples: HostTrafficSample[], at: number) {
  // 旧 Agent 的整张网卡计数无法区分内外网，任何入口都不能将其作为计费兜底。
  samples = samples.filter((sample) => sample.scope === PUBLIC_TRAFFIC_SCOPE);
  if (!samples.length) return;
  const instances = await prisma.instance.findMany({ where: { nodeId, name: { in: samples.map((s) => s.name) }, status: { notIn: ['DELETED', 'DELETING', 'MIGRATING'] } }, select: { id: true, name: true } });
  const byName = new Map(samples.map((s) => [s.name, s]));
  for (const { id, name } of instances) await withLock(`traffic:${id}`, 10_000, async () => {
    const sample = byName.get(name)!;
    if (!Object.keys(sample.interfaces).length) return;
    const updated = await prisma.$transaction(async (tx) => {
      const inst = await tx.instance.findUniqueOrThrow({ where: { id } });
      if (inst.nodeId !== nodeId || inst.name !== name || ['DELETED', 'DELETING', 'MIGRATING'].includes(inst.status)) return;
      if ((inst.trafficCounters as unknown as Baseline | null)?.at && (inst.trafficCounters as unknown as Baseline).at! >= at) return;
      const d = hostTrafficDelta(inst.trafficCounters, sample.interfaces);
      const updated = await tx.instance.update({ where: { id }, data: { trafficCounters: { ...d.baseline, at } as unknown as Prisma.InputJsonValue, trafficIn: { increment: d.rx }, trafficOut: { increment: d.tx } } });
      if (d.rx || d.tx) await tx.trafficDaily.upsert({
        where: { instanceId_date: { instanceId: id, date: startOfDayUTC() } },
        create: { instanceId: id, date: startOfDayUTC(), rx: d.rx, tx: d.tx }, update: { rx: { increment: d.rx }, tx: { increment: d.tx } },
      });
      return updated;
    });
    if (!updated) return;
    const prev = await redis.get(hostTrafficKey(id));
    const cur = { t: Date.now(), ...sample };
    await redis.set(hostTrafficKey(id), JSON.stringify({ cur, prev: prev ? (JSON.parse(prev) as { cur: unknown }).cur : null }), 'EX', 120);
    await enforceTrafficLimit(updated);
  });
}

export async function hostTrafficRates(id: number) {
  const raw = await redis.get(hostTrafficKey(id));
  if (!raw) return null;
  const { cur, prev } = JSON.parse(raw) as { cur: HostTrafficSample & { t: number }; prev: (HostTrafficSample & { t: number }) | null };
  if (Date.now() - cur.t > 60_000) return null;
  let rx = 0, tx = 0;
  for (const nic of Object.values(cur.interfaces)) { rx += nic.rx; tx += nic.tx; }
  const d = prev ? hostTrafficDelta({ source: 'host-public-v1', interfaces: prev.interfaces }, cur.interfaces) : null;
  const dt = prev && cur.t > prev.t ? (cur.t - prev.t) / 1000 : 0;
  return { rx, tx, rxRate: d && dt ? Number(d.rx) / dt : null, txRate: d && dt ? Number(d.tx) / dt : null };
}

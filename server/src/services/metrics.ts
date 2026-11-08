import type { InstanceStateDTO, MetricPoint, NodeUsageDTO, TrafficMode } from '../shared/index.ts';
import { getIncus, type IncusInstanceState } from '../incus/index.ts';
import { prisma, Prisma, type Instance, type Node } from '../lib/prisma.ts';
import { redis, withLock } from '../lib/redis.ts';
import { dayjs, nodeTrafficPeriod, startOfDayUTC } from '../lib/time.ts';
import { config } from '../config.ts';
import { trafficUsedBytes } from './serializers.ts';
import { enqueueTask } from './tasks.ts';
import { ipv6Mac } from './spec.ts';
import { VPC_DEVICE, VPC_IFNAME } from './vpc.ts';
import { agentInstanceSample, agentReportsInstances, clearAgentInstanceState, watchInstance } from './agent/instance-stats.ts';
import { hostTrafficRates } from './agent/host-traffic.ts';

const SERIES_KEY = (id: number) => `metrics:series:${id}`;
const LAST_KEY = (id: number) => `metrics:last:${id}`;
/** 保留约 24 小时的采样点 */
const seriesLength = () => Math.ceil((24 * 3600) / config.METRICS_INTERVAL_SEC);
const GiB = 1024 ** 3;

/**
 * 计费网卡的流量计数器之和：只统计主网卡 eth0 与公网 IPv6 网卡 eth1（容器内按网卡名，虚拟机内按 MAC 识别）。
 * VPC 内网网卡与实例内部的虚拟网卡（docker0、veth 等）不计费，避免内网流量和容器内转发被重复计入。
 * 没有 MAC 记录的旧实例只排除回环与 VPC 网卡。
 */
export function sumCounters(state: IncusInstanceState | null, inst: Pick<Instance, 'macAddress'>): { rx: number; tx: number } {
  const macs = inst.macAddress ? new Set([inst.macAddress, ipv6Mac(inst.macAddress)].map((m) => m.toLowerCase())) : null;
  let rx = 0;
  let tx = 0;
  for (const [name, nic] of Object.entries(state?.network ?? {})) {
    if (name === 'lo' || nic.type === 'loopback') continue;
    const billable = macs ? name === 'eth0' || name === 'eth1' || macs.has((nic.hwaddr ?? '').toLowerCase()) : name !== VPC_IFNAME && name !== VPC_DEVICE;
    if (!billable) continue;
    rx += nic.counters?.bytes_received ?? 0;
    tx += nic.counters?.bytes_sent ?? 0;
  }
  return { rx, tx };
}

function rootDiskUsage(state: IncusInstanceState | null): number | null {
  const root = state?.disk?.root;
  return root && typeof root.usage === 'number' ? root.usage : null;
}

function firstGlobal(state: IncusInstanceState | null, family: 'inet' | 'inet6'): string | null {
  for (const [name, nic] of Object.entries(state?.network ?? {})) {
    if (name === 'lo') continue;
    const addr = nic.addresses?.find((a) => a.family === family && a.scope === 'global');
    if (addr) return addr.address;
  }
  return null;
}

/** 计数器差值：计数器回绕/重置（重启后网卡重建）时以当前值作为增量 */
function delta(current: number, last: bigint): bigint {
  const cur = BigInt(Math.max(0, Math.floor(current)));
  return cur >= last ? cur - last : cur;
}

/** 采集单个节点上所有实例的资源占用，并累计流量 */
export async function collectNode(node: Node): Promise<void> {
  const incus = await getIncus(node);
  const remote = await incus.listInstances();
  const byName = new Map(remote.map((r) => [r.name, r]));
  const instances = await prisma.instance.findMany({
    where: { nodeId: node.id, status: { in: ['RUNNING', 'STOPPED', 'SUSPENDED', 'ERROR', 'REINSTALLING'] } },
    include: { tasks: { where: { status: { in: ['QUEUED', 'RUNNING'] } }, take: 1 } },
  });
  const now = Date.now();
  const today = startOfDayUTC();

  for (const row of instances) await withLock(`traffic:${row.id}`, 10_000, async () => {
    const inst = await prisma.instance.findUniqueOrThrow({ where: { id: row.id }, include: { tasks: { where: { status: { in: ['QUEUED', 'RUNNING'] } }, take: 1 } } });
    if (inst.nodeId !== node.id) return;
    const r = byName.get(inst.name);
    if (!r) return;
    const state = r.state;
    const running = state?.status === 'Running';
    const { rx, tx } = sumCounters(state, inst);
    const hostSource = (inst.trafficCounters as { source?: string } | null)?.source === 'host';
    const host = hostSource ? await hostTrafficRates(inst.id) : null;
    const dRx = running && !hostSource ? delta(rx, inst.lastRxCounter) : 0n;
    const dTx = running && !hostSource ? delta(tx, inst.lastTxCounter) : 0n;

    // CPU 使用率：与上一次采样的 CPU 时间差 / 墙钟时间差 / 核数
    const lastRaw = await redis.get(LAST_KEY(inst.id));
    const last = lastRaw ? (JSON.parse(lastRaw) as { t: number; cpu: number }) : null;
    const cpuNs = state?.cpu?.usage ?? 0;
    let cpuPct = 0;
    let rxRate = 0;
    let txRate = 0;
    if (last && now > last.t) {
      const dtSec = (now - last.t) / 1000;
      if (cpuNs >= last.cpu) cpuPct = Math.min(100, ((cpuNs - last.cpu) / (dtSec * 1e9 * Math.max(1, inst.cpu))) * 100);
      rxRate = Number(dRx) / dtSec;
      txRate = Number(dTx) / dtSec;
    }
    if (hostSource) { rxRate = host?.rxRate ?? 0; txRate = host?.txRate ?? 0; }
    await redis.set(LAST_KEY(inst.id), JSON.stringify({ t: now, cpu: cpuNs }), 'EX', 3600);

    if (running) {
      const point: MetricPoint = {
        t: now,
        cpu: Math.round(cpuPct * 100) / 100,
        mem: state?.memory?.usage ?? 0,
        rx: Math.round(rxRate),
        tx: Math.round(txRate),
      };
      await redis.multi().rpush(SERIES_KEY(inst.id), JSON.stringify(point)).ltrim(SERIES_KEY(inst.id), -seriesLength(), -1).exec();
    }

    const data: Prisma.InstanceUpdateInput = {
      lastRxCounter: BigInt(Math.floor(rx)),
      lastTxCounter: BigInt(Math.floor(tx)),
    };
    if (dRx > 0n || dTx > 0n) {
      data.trafficIn = { increment: dRx };
      data.trafficOut = { increment: dTx };
      await prisma.trafficDaily.upsert({
        where: { instanceId_date: { instanceId: inst.id, date: today } },
        create: { instanceId: inst.id, date: today, rx: dRx, tx: dTx },
        update: { rx: { increment: dRx }, tx: { increment: dTx } },
      });
    }
    const v6 = firstGlobal(state, 'inet6');
    if (v6 && v6 !== inst.ipv6) data.ipv6 = v6;

    // 同步电源状态（仅在没有进行中的任务时，避免与任务冲突）
    if (inst.tasks.length === 0 && (inst.status === 'RUNNING' || inst.status === 'STOPPED')) {
      const actual = running ? 'RUNNING' : 'STOPPED';
      if (actual !== inst.status) data.status = actual;
    }

    const updated = await prisma.instance.update({ where: { id: inst.id }, data });
    await enforceTrafficLimit(updated);
  });
}

/** 流量超额处理：限速或停机 */
export async function enforceTrafficLimit(inst: Instance): Promise<void> {
  if (inst.traffic <= 0 || !['RUNNING', 'STOPPED', 'ERROR'].includes(inst.status)) return;
  const limit = BigInt(inst.traffic) * BigInt(GiB);
  if (trafficUsedBytes(inst) < limit) return;
  if (inst.overLimitAction === 'THROTTLE') {
    if (inst.trafficThrottled) return;
    await prisma.instance.update({ where: { id: inst.id }, data: { trafficThrottled: true } });
    await enqueueTask({ instanceId: inst.id, type: 'APPLY_LIMITS', exclusive: false });
  } else {
    // 防止在挂起任务完成前重复提交
    const guard = await redis.set(`traffic-suspend:${inst.id}`, '1', 'EX', 600, 'NX');
    if (!guard) return;
    await enqueueTask({ instanceId: inst.id, type: 'SUSPEND', payload: { reason: 'TRAFFIC' }, exclusive: false });
  }
}

export async function getMetricSeries(instanceId: number, minutes: number): Promise<MetricPoint[]> {
  const count = Math.ceil((minutes * 60) / config.METRICS_INTERVAL_SEC);
  const raw = await redis.lrange(SERIES_KEY(instanceId), -count, -1);
  const since = Date.now() - minutes * 60_000;
  return raw.map((r) => JSON.parse(r) as MetricPoint).filter((p) => p.t >= since);
}

/**
 * 实时状态（短暂缓存，避免前端轮询频繁请求 Incus）。宿主机 Agent 在线且支持实例资源上报时，
 * 标记实例正在被查看，并优先使用 Agent 上报的状态（source = agent）；没有新鲜的上报时由面板直接查询 Incus。
 */
export async function getLiveState(
  inst: Pick<Instance, 'id' | 'name' | 'cpu' | 'memory' | 'disk' | 'trafficIn' | 'trafficOut' | 'trafficMode' | 'lastRxCounter' | 'lastTxCounter' | 'macAddress'> & Partial<Pick<Instance, 'trafficCounters'>> & { node: Node },
): Promise<InstanceStateDTO> {
  const cacheKey = `state:cache:${inst.id}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as InstanceStateDTO;

  let state: IncusInstanceState;
  let now: number;
  let prev: { t: number; cpu: number; rx?: number; tx?: number } | null;
  let source: InstanceStateDTO['source'] = 'panel';
  const viaAgent = await agentReportsInstances(inst.node.id);
  if (viaAgent) await watchInstance(inst.node.id, inst.name);
  const sample = viaAgent ? await agentInstanceSample(inst.id) : null;
  if (sample) {
    // Agent 上报：CPU 与网络速率由相邻两次上报计算
    source = 'agent';
    state = sample.cur.state;
    now = sample.cur.t;
    prev = sample.prev ? { t: sample.prev.t, cpu: sample.prev.state.cpu?.usage ?? 0, ...sumCounters(sample.prev.state, inst) } : null;
  } else {
    state = await (await getIncus(inst.node)).getInstanceState(inst.name);
    now = Date.now();
    const prevRaw = await redis.get(`state:prev:${inst.id}`);
    prev = prevRaw ? (JSON.parse(prevRaw) as { t: number; cpu: number; rx?: number; tx?: number }) : null;
  }
  const cpuNs = state.cpu?.usage ?? 0;
  let cpuPercent: number | null = null;
  if (prev && now - prev.t >= 1000 && cpuNs >= prev.cpu) {
    cpuPercent = Math.min(100, ((cpuNs - prev.cpu) / (((now - prev.t) / 1000) * 1e9 * Math.max(1, inst.cpu))) * 100);
    cpuPercent = Math.round(cpuPercent * 100) / 100;
  }
  const { rx, tx } = sumCounters(state, inst);
  // 实时网络速率：与上一次查询的网卡计数器差值 / 时间差（计数器回绕或网卡重建时本次不计算）
  let netRxRate: number | null = null;
  let netTxRate: number | null = null;
  if (state.status === 'Running' && prev && prev.rx !== undefined && prev.tx !== undefined && now - prev.t >= 1000 && now - prev.t <= 60_000 && rx >= prev.rx && tx >= prev.tx) {
    const dt = (now - prev.t) / 1000;
    netRxRate = Math.round((rx - prev.rx) / dt);
    netTxRate = Math.round((tx - prev.tx) / dt);
  }
  if (source === 'panel') await redis.set(`state:prev:${inst.id}`, JSON.stringify({ t: now, cpu: cpuNs, rx, tx }), 'EX', 600);

  const addresses: InstanceStateDTO['addresses'] = [];
  for (const [name, nic] of Object.entries(state.network ?? {})) {
    if (name === 'lo') continue;
    for (const a of nic.addresses ?? []) {
      if (a.scope === 'link') continue;
      addresses.push({ family: a.family, address: a.address, scope: a.scope });
    }
  }
  // 本期流量：与每分钟统计的算法一致，加上还没统计进去的计数器增量
  const running = state.status === 'Running';
  const hostSource = (inst.trafficCounters as { source?: string } | null)?.source === 'host';
  const host = hostSource ? await hostTrafficRates(inst.id) : null;
  const trafficIn = inst.trafficIn + (running && !hostSource ? delta(rx, inst.lastRxCounter) : 0n);
  const trafficOut = inst.trafficOut + (running && !hostSource ? delta(tx, inst.lastTxCounter) : 0n);
  const dto: InstanceStateDTO = {
    status: state.status,
    cpuPercent: state.status === 'Running' ? cpuPercent : 0,
    memoryUsage: state.memory?.usage ?? 0,
    memoryTotal: inst.memory * 1024 * 1024,
    swapUsage: state.memory?.swap_usage ?? 0,
    diskUsage: rootDiskUsage(state),
    diskTotal: inst.disk * GiB,
    processes: Math.max(0, state.processes ?? 0),
    netRx: hostSource ? host?.rx ?? 0 : rx,
    netTx: hostSource ? host?.tx ?? 0 : tx,
    netRxRate: state.status === 'Running' ? hostSource ? host?.rxRate ?? null : netRxRate : 0,
    netTxRate: state.status === 'Running' ? hostSource ? host?.txRate ?? null : netTxRate : 0,
    trafficIn: Number(trafficIn),
    trafficOut: Number(trafficOut),
    trafficUsed: Number(trafficUsedBytes({ trafficIn, trafficOut, trafficMode: inst.trafficMode })),
    addresses,
    collectedAt: new Date(now).toISOString(),
    source,
  };
  await redis.set(cacheKey, JSON.stringify(dto), 'EX', 3);
  return dto;
}

export async function clearMetrics(instanceId: number): Promise<void> {
  await redis.del(SERIES_KEY(instanceId), LAST_KEY(instanceId), `state:prev:${instanceId}`, `state:cache:${instanceId}`);
  await clearAgentInstanceState(instanceId);
}

// ───────── 宿主机用量 ─────────

/** 按计算方式得到已用流量 */
function trafficByMode(mode: TrafficMode, rx: bigint, tx: bigint): bigint {
  if (mode === 'IN') return rx;
  if (mode === 'OUT') return tx;
  if (mode === 'MAX') return rx > tx ? rx : tx;
  return rx + tx;
}

/**
 * 宿主机用量：本周期流量（本机所有实例流量之和，按天汇总）、已售出的资源，
 * 以及根据实例最近一次监控采样估算的 CPU 占用。
 */
export async function getNodeUsage(node: Node): Promise<NodeUsageDTO> {
  const { start, end } = nodeTrafficPeriod(node.trafficResetDay);
  const [days, allocated, active] = await Promise.all([
    prisma.trafficDaily.groupBy({
      by: ['date'],
      where: { date: { gte: start, lt: end }, instance: { nodeId: node.id } },
      _sum: { rx: true, tx: true },
      orderBy: { date: 'asc' },
    }),
    prisma.instance.aggregate({
      where: { nodeId: node.id, status: { notIn: ['DELETED'] } },
      _sum: { cpu: true, memory: true, disk: true },
      _count: { _all: true },
    }),
    prisma.instance.findMany({ where: { nodeId: node.id, status: 'RUNNING' }, select: { id: true, cpu: true } }),
  ]);

  // 补齐周期内没有流量的日期，图表按天连续显示到今天
  const byDate = new Map(days.map((d) => [dayjs.utc(d.date).format('YYYY-MM-DD'), d._sum]));
  const daily: NodeUsageDTO['daily'] = [];
  for (let d = dayjs.utc(start); d.isBefore(end) && !d.isAfter(new Date()); d = d.add(1, 'day')) {
    const sum = byDate.get(d.format('YYYY-MM-DD'));
    daily.push({ date: d.format('YYYY-MM-DD'), rx: Number(sum?.rx ?? 0n), tx: Number(sum?.tx ?? 0n) });
  }
  const rx = days.reduce((a, d) => a + (d._sum.rx ?? 0n), 0n);
  const tx = days.reduce((a, d) => a + (d._sum.tx ?? 0n), 0n);

  // 实例 CPU 使用率以其 vCPU 为基数，换算成核数后求和；只使用最近 3 个采样周期内的数据
  let cpuUsed: number | null = null;
  const fresh = Date.now() - config.METRICS_INTERVAL_SEC * 3000;
  for (const inst of active) {
    const [raw] = await redis.lrange(SERIES_KEY(inst.id), -1, -1);
    if (!raw) continue;
    const point = JSON.parse(raw) as MetricPoint;
    if (point.t < fresh) continue;
    cpuUsed = (cpuUsed ?? 0) + (point.cpu / 100) * inst.cpu;
  }

  return {
    period: { start: start.toISOString(), end: end.toISOString(), resetDay: node.trafficResetDay },
    traffic: {
      rx: Number(rx),
      tx: Number(tx),
      used: Number(trafficByMode(node.trafficMode, rx, tx)),
      limit: node.trafficLimit > 0 ? node.trafficLimit * GiB : null,
      mode: node.trafficMode,
    },
    daily,
    allocated: {
      cpu: allocated._sum.cpu ?? 0,
      memory: allocated._sum.memory ?? 0,
      disk: allocated._sum.disk ?? 0,
      instances: allocated._count._all,
    },
    cpuUsed: cpuUsed === null ? null : Math.round(cpuUsed * 100) / 100,
  };
}

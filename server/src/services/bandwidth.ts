import type { NodeBandwidthDTO } from '../shared/index.ts';
import { getIncus } from '../incus/index.ts';
import type { Node } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';

const SERIES_KEY = (id: number) => `node:bw:series:${id}`;
const LAST_KEY = (id: number) => `node:bw:last:${id}`;
const IFACES_KEY = (id: number) => `node:bw:ifaces:${id}`;
/** 图表显示最近一小时 */
const WINDOW_MS = 3600_000;
/** 两次采样的最短间隔：多人同时查看时不重复请求宿主机 */
const MIN_GAP_MS = 2000;
const MAX_POINTS = 1200;

type Sample = { t: number; rx: number; tx: number };

/** 统计带宽的网卡：Incus 资源信息中的物理网口（排除未连接的），缓存 10 分钟 */
async function physicalInterfaces(node: Node): Promise<string[]> {
  const cached = await redis.get(IFACES_KEY(node.id));
  if (cached) return JSON.parse(cached) as string[];
  const res = await (await getIncus(node)).getResources();
  const names = (res.network?.cards ?? []).flatMap((c) => (c.ports ?? []).filter((p) => p.link_detected !== false).map((p) => p.id));
  await redis.set(IFACES_KEY(node.id), JSON.stringify(names), 'EX', 600);
  return names;
}

/**
 * 读取物理网卡的收发字节计数，与上一次采样相减得到速率（字节/秒）。
 * 计数器回绕或网卡重置时跳过本次速率，只更新基准。
 */
export async function sampleNodeBandwidth(node: Node): Promise<void> {
  const now = Date.now();
  const lastRaw = await redis.get(LAST_KEY(node.id));
  const last = lastRaw ? (JSON.parse(lastRaw) as Sample) : null;
  if (last && now - last.t < MIN_GAP_MS) return;

  const names = await physicalInterfaces(node);
  if (names.length === 0) return;
  const incus = await getIncus(node);
  const states = await Promise.all(names.map((n) => incus.getNetworkState(n).catch(() => null)));
  let rx = 0;
  let tx = 0;
  for (const s of states) {
    rx += s?.counters?.bytes_received ?? 0;
    tx += s?.counters?.bytes_sent ?? 0;
  }
  await redis.set(LAST_KEY(node.id), JSON.stringify({ t: now, rx, tx } satisfies Sample), 'EX', 3600);
  if (!last || rx < last.rx || tx < last.tx) return;
  const dt = (now - last.t) / 1000;
  const point: Sample = { t: now, rx: Math.round((rx - last.rx) / dt), tx: Math.round((tx - last.tx) / dt) };
  await redis.multi().rpush(SERIES_KEY(node.id), JSON.stringify(point)).ltrim(SERIES_KEY(node.id), -MAX_POINTS, -1).exec();
}

/** 先采样一次（查看时约每 5 秒刷新），再返回最近一小时的速率曲线 */
export async function getNodeBandwidth(node: Node): Promise<NodeBandwidthDTO> {
  await sampleNodeBandwidth(node);
  const since = Date.now() - WINDOW_MS;
  const series = (await redis.lrange(SERIES_KEY(node.id), 0, -1)).map((r) => JSON.parse(r) as Sample).filter((p) => p.t >= since);
  const latest = series.at(-1);
  return {
    interfaces: await physicalInterfaces(node),
    // 超过 2 分钟没有新采样（例如宿主机离线）时不显示当前速率
    current: latest && Date.now() - latest.t < 120_000 ? { rx: latest.rx, tx: latest.tx } : null,
    series,
  };
}

export async function clearNodeBandwidth(nodeId: number): Promise<void> {
  await redis.del(SERIES_KEY(nodeId), LAST_KEY(nodeId), IFACES_KEY(nodeId));
}

// 节点测试：宿主机 Agent 按配置向目标 Ping，结果保存在 Redis（保留 3 天），在购买页展示。
// Agent 在上报回复里拿到 ping 配置（是否启用、间隔、目标摘要、是否立即测试），按需拉取目标并回传结果。
import { pingTargetsHash, type NodePingDTO, type PingResultDTO, type PingTarget } from '../../shared/index.ts';
import { prisma, type Node } from '../../lib/prisma.ts';
import { redis } from '../../lib/redis.ts';
import { getSetting } from '../../lib/settings.ts';
import { badRequest } from '../../lib/errors.ts';
import { t } from '../../i18n/index.ts';
import { activePingTargets, pingObjectEnabled, pingRunKey } from '../ping-settings.ts';

const RESULT_KEY = (id: number) => `node:ping:${id}`;
const RESULT_TTL_SEC = 3 * 86400;
const TARGETS_KEY = (id: number) => `node:ping:targets:${id}`;

type StoredPing = Omit<NodePingDTO, 'label' | 'country'>;

/** 上报回复中的节点测试配置；未启用时为 undefined（Agent 停止测试） */
export async function pingConfig(node: Node): Promise<{ enabled: true; interval: number; hash: string; runNow: boolean } | undefined> {
  const settings = await getSetting('ping');
  if (!pingObjectEnabled(settings, node)) return undefined;
  // 管理员点了「立即测试」：只下发一次
  const runNow = (await redis.del(pingRunKey(node.id))) === 1;
  return { enabled: true, interval: settings.interval, hash: pingTargetsHash(activePingTargets(settings), settings.count), runNow };
}

/** Agent 拉取的测试目标 */
export async function pingTargets(nodeId: number) {
  const settings = await getSetting('ping');
  const targets = activePingTargets(settings);
  // 保存实际下发的目标；设置变动期间回传的结果仍能匹配原目标信息。
  await redis.set(TARGETS_KEY(nodeId), JSON.stringify(targets), 'EX', RESULT_TTL_SEC);
  return { hash: pingTargetsHash(targets, settings.count), count: settings.count, targets: targets.map(({ id, host, port }) => ({ id, host, port })) };
}

export async function deliveredPingTargets(nodeId: number): Promise<PingTarget[]> {
  const raw = await redis.get(TARGETS_KEY(nodeId));
  return raw ? JSON.parse(raw) as PingTarget[] : activePingTargets(await getSetting('ping'));
}

/** 保存 Agent 回传的结果（忽略未知目标） */
export async function savePingResults(nodeId: number, input: { method: 'icmp' | 'tcp'; results: PingResultDTO[] }): Promise<boolean> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node || !pingObjectEnabled(await getSetting('ping'), node)) return false;
  const targets = await deliveredPingTargets(nodeId);
  const valid = new Set(targets.map(target => target.id));
  const results = input.results
    .filter((r) => valid.delete(r.id))
    .map((r) => ({ id: r.id, latency: r.latency === null ? null : Math.round(r.latency * 10) / 10, loss: Math.round(r.loss) }));
  if (!results.length) return false;
  const stored: StoredPing = { testedAt: new Date().toISOString(), method: input.method, results, targets };
  await redis.set(RESULT_KEY(nodeId), JSON.stringify(stored), 'EX', RESULT_TTL_SEC);
  return true;
}

export async function getPingResults(nodeId: number): Promise<StoredPing | null> {
  const raw = await redis.get(RESULT_KEY(nodeId));
  return raw ? (JSON.parse(raw) as StoredPing) : null;
}

/** 管理员要求立即测试：Agent 下一次上报（约 10 秒内）时开始 */
export async function requestPingRun(nodeId: number): Promise<void> {
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node || !pingObjectEnabled(await getSetting('ping'), node)) throw badRequest(t('ping.disabled'));
  await redis.set(pingRunKey(nodeId), '1', 'EX', 3600);
}

/**
 * 购买页：产品在某地区的宿主机中，启用了节点测试且有结果的宿主机。
 * 不暴露宿主机名称：以地区命名，同一地区有多台时加序号。
 */
export async function productPing(productId: number, region?: string): Promise<{ enabled: boolean; nodes: NodePingDTO[] }> {
  const settings = await getSetting('ping');
  if (!settings.enabled || !activePingTargets(settings).length) return { enabled: false, nodes: [] };
  const nodes = await prisma.node.findMany({
    where: { pingEnabled: true, enabled: true, ...(settings.nodeIds !== null ? { id: { in: settings.nodeIds } } : {}), products: { some: { id: productId } }, ...(region ? { region } : {}) },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
  });
  const out: NodePingDTO[] = [];
  const count = new Map<string, number>();
  for (const n of nodes) count.set(n.region, (count.get(n.region) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const n of nodes) {
    const ping = await getPingResults(n.id);
    if (!ping) continue;
    const i = (seen.get(n.region) ?? 0) + 1;
    seen.set(n.region, i);
    out.push({ label: count.get(n.region)! > 1 ? `${n.region} #${i}` : n.region, country: n.country, ...ping });
  }
  // enabled：有宿主机开启了节点测试（可能还没有结果）
  return { enabled: nodes.length > 0, nodes: out };
}

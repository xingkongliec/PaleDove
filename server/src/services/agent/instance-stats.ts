// 实例资源上报（Agent 能力 instance-stats）：
//  - 实例管理页面查询实时状态时，若宿主机 Agent 在线且支持该能力，记下「正在查看」的实例（20 秒有效）；
//  - Agent 上报心跳时在回复里拿到查看列表，之后每 3 秒读取这些实例在本机 Incus 的状态并上报，
//    上报回复里续期查看列表，页面关闭后列表过期，Agent 随即停止；
//  - 实时状态优先使用 12 秒内的 Agent 上报（CPU 与网络速率由相邻两次上报计算），否则由面板直接查询 Incus。
import type { IncusInstanceState } from '../../incus/index.ts';
import { prisma, type Node } from '../../lib/prisma.ts';
import { redis } from '../../lib/redis.ts';
import { getHostReport } from './agent.ts';

/** Agent 上报实例状态的间隔（秒） */
export const INSTANCE_STATS_INTERVAL = 3;
/** 查看标记的有效期：页面每 5 秒刷新一次实时状态，关闭页面后很快过期 */
const WATCH_TTL_MS = 20_000;
/** Agent 上报在这段时间内视为新鲜，可直接用于实时状态 */
const FRESH_MS = 12_000;
/** 单台宿主机同时上报的实例上限（与 Agent 一致） */
const MAX_WATCHED = 20;

const WATCH_KEY = (nodeId: number) => `agent:watch:${nodeId}`;
const STATE_KEY = (id: number) => `agent:istate:${id}`;
const PREV_KEY = (id: number) => `agent:istate:prev:${id}`;

export interface AgentStateSample {
  /** 面板收到上报的时间（毫秒） */
  t: number;
  state: IncusInstanceState;
}

export interface ReportedInstanceState {
  name: string;
  state?: unknown;
  error?: string;
}

/** 宿主机的 Agent 是否在线且支持实例资源上报 */
export async function agentReportsInstances(nodeId: number): Promise<boolean> {
  const report = await getHostReport(nodeId);
  return !!report?.online && !!report.capabilities?.includes('instance-stats');
}

/** 标记实例正在被查看（Agent 下次心跳或上报时拿到） */
export async function watchInstance(nodeId: number, name: string): Promise<void> {
  await redis.hset(WATCH_KEY(nodeId), name, String(Date.now() + WATCH_TTL_MS));
}

/** 宿主机上正在被查看的实例名称（顺便清理过期的标记） */
export async function watchedInstances(nodeId: number): Promise<string[]> {
  const all = await redis.hgetall(WATCH_KEY(nodeId));
  const now = Date.now();
  const names: string[] = [];
  const expired: string[] = [];
  for (const [name, until] of Object.entries(all)) {
    if (Number(until) > now) names.push(name);
    else expired.push(name);
  }
  if (expired.length) await redis.hdel(WATCH_KEY(nodeId), ...expired);
  return names.slice(0, MAX_WATCHED);
}

/** 下发给 Agent 的查看列表；没有实例被查看时为 null */
export async function instanceWatch(nodeId: number): Promise<{ names: string[]; interval: number } | null> {
  const names = await watchedInstances(nodeId);
  return names.length ? { names, interval: INSTANCE_STATS_INTERVAL } : null;
}

/** 保存 Agent 上报的实例状态：只接受本宿主机上未删除的实例，上一次的样本保留用于计算 CPU 与网络速率 */
export async function saveInstanceStates(node: Pick<Node, 'id'>, states: ReportedInstanceState[]): Promise<number> {
  const valid = states.filter((s) => s.state && typeof s.state === 'object' && typeof (s.state as { status?: unknown }).status === 'string');
  if (!valid.length) return 0;
  const instances = await prisma.instance.findMany({
    where: { nodeId: node.id, name: { in: valid.map((s) => s.name) }, status: { not: 'DELETED' } },
    select: { id: true, name: true },
  });
  const byName = new Map(instances.map((i) => [i.name, i.id]));
  const now = Date.now();
  let saved = 0;
  for (const s of valid) {
    const id = byName.get(s.name);
    if (!id) continue;
    const current = await redis.get(STATE_KEY(id));
    if (current) await redis.set(PREV_KEY(id), current, 'EX', 60);
    // 原样保存 Incus 的状态（字段缺失时读取处按 0 / 空处理）
    await redis.set(STATE_KEY(id), JSON.stringify({ t: now, state: s.state as IncusInstanceState } satisfies AgentStateSample), 'EX', 60);
    saved++;
  }
  return saved;
}

/** 新鲜的 Agent 上报（当前与上一次）；没有或已过期时为 null */
export async function agentInstanceSample(instanceId: number): Promise<{ cur: AgentStateSample; prev: AgentStateSample | null } | null> {
  const [curRaw, prevRaw] = await Promise.all([redis.get(STATE_KEY(instanceId)), redis.get(PREV_KEY(instanceId))]);
  if (!curRaw) return null;
  const cur = JSON.parse(curRaw) as AgentStateSample;
  if (Date.now() - cur.t > FRESH_MS) return null;
  const prev = prevRaw ? (JSON.parse(prevRaw) as AgentStateSample) : null;
  return { cur, prev: prev && prev.t < cur.t ? prev : null };
}

export async function clearAgentInstanceState(instanceId: number): Promise<void> {
  await redis.del(STATE_KEY(instanceId), PREV_KEY(instanceId));
}

// 切换机房前的即时 IPv4 拨测：心跳下发任务，由 Agent 以实例公网 IPv4 发送 ICMP。
import { randomUUID } from 'node:crypto';
import { pingTarget, type InstanceIpv4CheckDTO, type PingResultDTO } from '../../shared/index.ts';
import { prisma } from '../../lib/prisma.ts';
import { redis, withLock } from '../../lib/redis.ts';
import { getHostReport } from './agent.ts';
import { instancePingJob as agentJob, type PingInstance } from './instance-ping.ts';

const TARGET_IDS = ['bj-ct', 'bj-cu', 'sh-cu', 'sh-cm', 'gd-ct', 'gd-cm'];
const TIMEOUT_MS = 90_000;
const CACHE_SEC = 600;
const KEY = (id: number) => `switch:ipv4:v2:${id}`;
const JOBS = (nodeId: number) => `switch:ipv4:jobs:${nodeId}`;

type ProbeJob = ReturnType<typeof agentJob> & {
  requestId: string;
  targets: { id: string; host: string; port: number }[];
};
interface StoredCheck {
  nodeId: number;
  signature: string;
  deadline: number;
  job: ProbeJob;
  result: InstanceIpv4CheckDTO;
}

const load = (id: number) => prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true, ipAddress: true } });
const signature = (inst: PingInstance) => JSON.stringify({ ...agentJob(inst.id, inst), nodeId: inst.node.id, networkMode: inst.node.networkMode, running: inst.type === 'KVM_IPV4' ? inst.status === 'RUNNING' : undefined });
const read = async (id: number): Promise<StoredCheck | null> => {
  const raw = await redis.get(KEY(id));
  return raw ? JSON.parse(raw) as StoredCheck : null;
};
const save = (id: number, check: StoredCheck) => redis.set(KEY(id), JSON.stringify(check), 'EX', CACHE_SEC);

/** 读取检测或发起新检测；重复请求和轮询共用同一任务，重测使用新的随机编号。 */
export async function checkIpv4(instanceId: number, fresh = false): Promise<InstanceIpv4CheckDTO> {
  return withLock(`switch-ipv4:${instanceId}`, 10_000, async () => {
    const inst = await load(instanceId);
    const fingerprint = signature(inst);
    const cached = await read(instanceId);
    if (cached?.signature === fingerprint) {
      if (cached.result.status === 'pending' && cached.deadline > Date.now()) return cached.result;
      if (cached.result.status === 'pending') {
        cached.result = { ...cached.result, status: 'unknown', reason: 'timeout', checkedAt: new Date().toISOString() };
        await redis.hdel(JOBS(cached.nodeId), String(instanceId));
        await save(instanceId, cached);
      }
      if (!fresh) return cached.result;
    }
    const job: ProbeJob = {
      ...agentJob(instanceId, inst), requestId: randomUUID(),
      targets: TARGET_IDS.map((id) => { const target = pingTarget(id)!; return { id, host: target.host, port: target.port }; }),
    };
    const now = new Date().toISOString();
    const result: InstanceIpv4CheckDTO = {
      status: 'unknown', method: null, reason: null, ipv4: job.ip || null,
      reachable: 0, total: 0, requestedAt: now, checkedAt: now,
    };
    if ((job.kind === 'nat' && inst.node.networkMode === 'IPV6_ONLY') || (job.kind === 'dedicated' && !inst.ipAddress)) {
      result.reason = 'noIpv4';
    } else {
      const report = await getHostReport(inst.nodeId);
      if (!report?.online) result.reason = 'agentOffline';
      else if (!report.capabilities?.includes('ipv4-check')) result.reason = 'agentUpgrade';
      else { result.status = 'pending'; result.checkedAt = null; }
    }
    const check: StoredCheck = { nodeId: inst.nodeId, signature: fingerprint, deadline: Date.now() + TIMEOUT_MS, job, result };
    await save(instanceId, check);
    if (result.status === 'pending') {
      await redis.hset(JOBS(inst.nodeId), String(instanceId), JSON.stringify({ requestId: job.requestId, deadline: check.deadline }));
      await redis.expire(JOBS(inst.nodeId), CACHE_SEC);
    }
    return result;
  });
}

/** 仅下发当前宿主机、当前网络参数下仍有效的任务。 */
export async function agentIpv4Checks(nodeId: number): Promise<ProbeJob[]> {
  const jobs = await redis.hgetall(JOBS(nodeId));
  const out: ProbeJob[] = [];
  for (const id of Object.keys(jobs)) {
    const job = await withLock(`switch-ipv4:${id}`, 10_000, async () => {
      // 重测可能已替换同一实例的任务，清理前在锁内读取最新条目。
      const raw = (await redis.hgetall(JOBS(nodeId)))[id];
      if (!raw) return null;
      const queued = JSON.parse(raw) as { requestId: string; deadline: number };
      const check = await read(Number(id));
      const inst = await prisma.instance.findUnique({ where: { id: Number(id) }, include: { node: true, ipAddress: true } });
      if (!check || !inst || inst.nodeId !== nodeId || check.signature !== signature(inst) || check.result.status !== 'pending' || queued.requestId !== check.job.requestId || queued.deadline <= Date.now()) {
        await redis.hdel(JOBS(nodeId), id);
        return null;
      }
      return check.job;
    });
    if (job) out.push(job);
    if (out.length >= 5) break;
  }
  return out.slice(0, 5);
}

export interface AgentIpv4CheckInput {
  id: number;
  requestId: string;
  method?: 'icmp';
  via?: 'local' | 'default' | 'spoof' | 'spoof-l2';
  results?: (PingResultDTO & { error?: string })[];
  error?: string;
}

/** 验证来源与任务编号；旧任务、过期结果和网络已变的实例不能覆盖当前检测。 */
export async function saveAgentIpv4Check(nodeId: number, input: AgentIpv4CheckInput): Promise<boolean> {
  return withLock(`switch-ipv4:${input.id}`, 10_000, async () => {
    const check = await read(input.id);
    if (!check || check.nodeId !== nodeId || check.job.requestId !== input.requestId || check.result.status !== 'pending' || check.deadline <= Date.now()) return false;
    const inst = await load(input.id);
    if (inst.nodeId !== nodeId || check.signature !== signature(inst)) return false;
    const unique = new Map((input.results ?? []).filter((r) => TARGET_IDS.includes(r.id)).map((r) => [r.id, r]));
    const results = [...unique.values()].filter((r) => !r.error);
    const reachable = results.filter((r) => r.latency !== null && r.loss < 100).length;
    const validSource = check.job.kind !== 'dedicated' || (input.via !== undefined && ['local', 'spoof', 'spoof-l2'].includes(input.via));
    const valid = !input.error && input.method === 'icmp' && validSource;
    // 独立 IPv4 关机时上游可能撤回路由；全部未响应不能据此判成被墙。
    const stopped = check.job.kind === 'dedicated' && inst.status !== 'RUNNING';
    const status = !valid ? 'unknown' : reachable > 0 ? 'ok' : results.length === TARGET_IDS.length && !stopped ? 'blocked' : 'unknown';
    check.result = {
      ...check.result, status, method: valid ? 'icmp' : null,
      reason: status === 'unknown' ? (valid && stopped && results.length === TARGET_IDS.length ? 'notRunning' : 'error') : null,
      reachable: valid ? reachable : 0, total: valid ? results.length : 0, checkedAt: new Date().toISOString(),
    };
    await save(input.id, check);
    await redis.hdel(JOBS(nodeId), String(input.id));
    return true;
  });
}

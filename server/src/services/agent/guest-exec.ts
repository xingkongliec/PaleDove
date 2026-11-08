// 虚拟机 incus-agent 离线时，借宿主机 Agent 通过 SSH 执行面板已授权的命令。
import { randomUUID } from 'node:crypto';
import type { ExecResult } from '../../incus/types.ts';
import { decrypt, encrypt } from '../../lib/crypto.ts';
import { prisma } from '../../lib/prisma.ts';
import { redis, withLock } from '../../lib/redis.ts';
import { t } from '../../i18n/index.ts';
import { getHostReport } from './agent.ts';
import { isVmType, parseIpv6List } from '../../shared/index.ts';

interface GuestJob {
  requestId: string; id: number; name: string; project: string; host: string;
  password: string; command: string[]; env: Record<string, string>; timeout: number; deadline: number;
  trustEpoch: string;
}
interface Stored { nodeId: number; deadline: number; encrypted: string }
const queueKey = (nodeId: number) => `agent:guest-jobs:${nodeId}`;
const resultKey = (requestId: string) => `agent:guest-result:${requestId}`;

export function guestAgentUnavailable(error: unknown): boolean {
  return error instanceof Error && /(?:agent.*(?:not.*running|isn't|unavailable|offline|connect)|(?:connect|contact).*agent)/i.test(error.message);
}

export async function execViaHost(nodeId: number, name: string, command: string[], opts?: { env?: Record<string, string>; timeoutSec?: number }): Promise<ExecResult> {
  const inst = await prisma.instance.findFirst({ where: { nodeId, name, status: 'RUNNING' }, include: { node: true, ipAddress: true } });
  const report = await getHostReport(nodeId);
  const host = inst?.privateIp || inst?.ipAddress?.address || parseIpv6List(inst?.publicIpv6)[0];
  if (!inst || !isVmType(inst.type) || !inst.rootPassword || !host || !report?.online || !report.capabilities?.includes('guest-exec')) throw new Error(t('guest.fallbackUnavailable'));
  const job: GuestJob = {
    requestId: randomUUID(), id: inst.id, name, project: inst.node.project, host,
    password: decrypt(inst.rootPassword), command, env: opts?.env ?? {},
    trustEpoch: (inst.lastReinstallAt ?? inst.createdAt).toISOString(),
    timeout: Math.min(60, Math.max(1, opts?.timeoutSec ?? 30)), deadline: Date.now() + 100_000,
  };
  const stored: Stored = { nodeId, deadline: job.deadline, encrypted: encrypt(JSON.stringify(job)) };
  await redis.hset(queueKey(nodeId), job.requestId, JSON.stringify(stored));
  await redis.expire(queueKey(nodeId), 120);
  try {
    while (Date.now() < job.deadline) {
      const raw = await redis.get(resultKey(job.requestId));
      if (raw) {
        const result = JSON.parse(decrypt(raw)) as ExecResult & { error?: boolean };
        if (result.error) throw new Error(t('guest.failed'));
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(t('guest.failed'));
  } finally {
    await redis.hdel(queueKey(nodeId), job.requestId);
    await redis.del(resultKey(job.requestId));
  }
}

export async function guestJobs(nodeId: number): Promise<GuestJob[]> {
  const all = await redis.hgetall(queueKey(nodeId));
  const jobs: GuestJob[] = [];
  for (const [id, raw] of Object.entries(all)) {
    const stored = JSON.parse(raw) as Stored;
    if (stored.deadline <= Date.now()) { await redis.hdel(queueKey(nodeId), id); continue; }
    const job = JSON.parse(decrypt(stored.encrypted)) as GuestJob;
    const inst = await prisma.instance.findFirst({ where: { id: job.id, nodeId, name: job.name, status: 'RUNNING' } });
    if (inst && !await redis.get(resultKey(id))) jobs.push(job);
    if (jobs.length === 2) break;
  }
  return jobs;
}

export async function saveGuestResult(nodeId: number, requestId: string, result: ExecResult & { error?: boolean }) {
  return withLock(`guest-result:${requestId}`, 5000, async () => {
    const raw = (await redis.hgetall(queueKey(nodeId)))[requestId];
    if (!raw) return false;
    const job = JSON.parse(raw) as Stored;
    if (job.nodeId !== nodeId || job.deadline <= Date.now()) return false;
    await redis.set(resultKey(requestId), encrypt(JSON.stringify(result)), 'EX', 120, 'NX');
    return true;
  });
}

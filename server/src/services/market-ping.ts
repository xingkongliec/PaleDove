// 交易市场上架拨测：用户上架实例时，由实例所在宿主机的 Agent 从实例对外的 IPv4 向国内三网目标（与节点测试相同）
// 执行实时 ICMP，疑似屏蔽时以境外目标为对照并再次检测，结果存入上架快照。
// 拨测完成后商品才公开（MarketListing.published）；拨测未完成（Agent 不在线、超时、出错）时商品不公开，卖家可以重新拨测或撤销。
//
// 测的是买家拿到的那个 IP：
//   - LXC / KVM NAT：实例经宿主机公网 IPv4 出入，Agent 以该地址为源（不在本机网卡上时走默认出口）；
//   - 独立 IPv4：Agent 以实例地址为源构造请求、在宿主机网卡上抓回复（bridged 网卡还带上实例 MAC）。
//     上游要把地址路由到实例，所以拨测时实例必须在运行：关机的实例先开机，拨测结束后再关机（挂牌期间实例保持关机）。
// 模拟节点（mock://）直接生成模拟结果。
import {
  MARKET_PING_CONTROLS,
  marketPingVerdict,
  PING_ISPS,
  PING_TARGETS,
  pingTarget,
  pingRegionNeedsIsp,
  type MarketPingDTO,
  type MarketPingReason,
  type MarketPingStatus,
  type MarketPingSummaryDTO,
  type MarketPingVia,
  type MarketPingVerification,
  type PingResultDTO,
  type PingTarget,
} from '../shared/index.ts';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { prisma, Prisma, type Instance } from '../lib/prisma.ts';
import { redis, withLock } from '../lib/redis.ts';
import { getSetting } from '../lib/settings.ts';
import { activePingTargets } from './ping-settings.ts';
import { getHostReport } from './agent/agent.ts';
import { isMockNode } from './gateway.ts';
import { enqueueTask } from './tasks.ts';
import { instancePingJob as agentJob, type InstancePingJob, type PingInstance } from './agent/instance-ping.ts';
export { instancePingJob as agentJob, type PingInstance } from './agent/instance-ping.ts';

/** 宿主机的待执行拨测任务：listingId → 任务（JSON） */
const JOBS_KEY = (nodeId: number) => `market:ping:jobs:${nodeId}`;
/** 同一商品的拨测流程只运行一个 */
const FLOW_KEY = (listingId: number) => `market:ping:flow:${listingId}`;
/** 拨测结果的等待上限（Agent 约 10 秒内拿到任务，93 个目标一般 10～60 秒测完） */
const RESULT_TIMEOUT_MS = 4 * 60_000;
/** 独立 IPv4 实例开机的等待上限 */
const START_TIMEOUT_MS = 3 * 60_000;
const POLL_MS = 2_000;

interface StoredPing {
  status: MarketPingStatus;
  reason?: MarketPingReason | null;
  requestedAt: string;
  testedAt?: string | null;
  method?: 'icmp' | 'tcp' | null;
  via?: MarketPingVia | null;
  results?: PingResultDTO[];
  targets?: PingTarget[];
  requestId?: string;
  verification?: MarketPingVerification;
  /** Agent 报错信息（只给管理员排查，不展示给用户） */
  error?: string | null;
}

interface AgentJob extends InstancePingJob {
  requestId: string;
  targets: { id: string; host: string; port: number; mainland: boolean }[];
  controls: { id: string; host: string; port: number }[];
  count: number;
  /** 任务过期时间（毫秒） */
  exp: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isDedicated = (type: Instance['type']) => type === 'KVM_IPV4';

// ───────── 读取与 DTO ─────────

function readPing(v: Prisma.JsonValue | null | undefined): StoredPing | null {
  const p = v as Partial<StoredPing> | null | undefined;
  if (!p || typeof p !== 'object' || typeof p.status !== 'string' || typeof p.requestedAt !== 'string') return null;
  const ping = p as StoredPing;
  // 流程中断（如面板重启）且超过等待上限仍未完成的，按超时处理
  if (ping.status === 'PENDING' && Date.now() - Date.parse(ping.requestedAt) > START_TIMEOUT_MS + RESULT_TIMEOUT_MS + 60_000) {
    return { ...ping, status: 'FAILED', reason: 'timeout' };
  }
  return ping;
}

function summary(p: StoredPing): MarketPingSummaryDTO {
  const results = p.status === 'DONE' ? (p.results ?? []) : [];
  const v = p.status === 'DONE' ? marketPingVerdict(results, p.targets, p.method === 'icmp' && p.via !== 'mock' ? p.verification : undefined) : null;
  if (v && p.method !== 'icmp') v.verdict = 'UNKNOWN';
  // 三网最快：每个运营商延迟最低的目标
  const fastest: MarketPingSummaryDTO['fastest'] = [];
  for (const isp of ['CT', 'CM', 'CU'] as const) {
    let best: MarketPingSummaryDTO['fastest'][number] | null = null;
    for (const r of results) {
      const target = pingTarget(r.id, p.targets);
      if (!target || target.isp !== isp || r.latency == null) continue;
      if (!best || r.latency < best.latency) best = { isp, province: target.province, provinceEn: target.provinceEn, latency: r.latency };
    }
    if (best) fastest.push(best);
  }
  return {
    status: p.status,
    reason: p.status === 'FAILED' ? (p.reason ?? 'error') : null,
    requestedAt: p.requestedAt,
    testedAt: p.testedAt ?? null,
    verdict: v?.verdict ?? null,
    reachable: v?.reachable ?? 0,
    total: v?.total ?? 0,
    failedProvinces: v?.failedProvinces.length ?? 0,
    fastest,
  };
}

/** 商品卡片上的拨测摘要 */
export function pingSummary(v: Prisma.JsonValue | null | undefined): MarketPingSummaryDTO | null {
  const p = readPing(v);
  return p ? summary(p) : null;
}

/** 拨测快照详情 */
export function pingDetail(v: Prisma.JsonValue | null | undefined, type: Instance['type']): MarketPingDTO | null {
  const p = readPing(v);
  if (!p) return null;
  return {
    ...summary(p),
    method: p.method ?? null,
    via: p.via ?? null,
    ipv4: isDedicated(type) ? 'DEDICATED' : 'NAT',
    results: p.status === 'DONE' ? (p.results ?? []) : [],
    targets: p.targets,
  };
}

/** 保存拨测状态；拨测完成时公开商品 */
async function save(listingId: number, ping: StoredPing): Promise<void> {
  await prisma.marketListing.updateMany({
    where: { id: listingId, status: 'ACTIVE' },
    data: { ping: ping as unknown as Prisma.InputJsonValue, ...(ping.status === 'DONE' ? { published: true } : {}) },
  });
}

async function current(listingId: number): Promise<StoredPing | null> {
  const row = await prisma.marketListing.findUnique({ where: { id: listingId }, select: { ping: true } });
  return readPing(row?.ping);
}

// ───────── 发起 ─────────

/** 模拟节点的拨测耗时（测试环境立即完成） */
const MOCK_DELAY_MS = process.env.NODE_ENV === 'test' ? 0 : 3_000;

/**
 * 上架（或重新拨测）时开始拨测，不等待结果；拨测完成后商品自动公开。
 * 返回 deferStop：独立 IPv4 实例由拨测流程在测完后关机，调用方不要立即关机。
 */
export async function beginListingPing(listingId: number, inst: PingInstance, userId: number): Promise<{ deferStop: boolean }> {
  try {
    return await startPing(listingId, inst, userId);
  } catch (e) {
    await save(listingId, { status: 'FAILED', reason: 'error', requestedAt: new Date().toISOString(), error: e instanceof Error ? e.message.slice(0, 300) : String(e) }).catch(() => undefined);
    return { deferStop: false };
  }
}

/** 拨测失败的商品重新拨测：只有未公开、拨测已结束且未成功的商品可以 */
export function canRetry(row: { status: string; published: boolean; ping: Prisma.JsonValue | null }): boolean {
  if (row.status !== 'ACTIVE' || row.published) return false;
  const p = readPing(row.ping);
  return !p || p.status === 'FAILED';
}

async function startPing(listingId: number, inst: PingInstance, userId: number): Promise<{ deferStop: boolean }> {
  const now = new Date().toISOString();
  const fail = async (reason: MarketPingReason) => {
    await save(listingId, { status: 'FAILED', reason, requestedAt: now });
    return { deferStop: false };
  };
  const dedicated = isDedicated(inst.type);
  // 没有 IPv4：纯 IPv6 宿主机上的 NAT 实例，或独立 IPv4 实例没有分配地址
  if ((!dedicated && inst.node.networkMode === 'IPV6_ONLY') || isIP(agentJob(listingId, inst).ip) !== 4) return fail('noIpv4');
  const settings = await getSetting('ping');
  const targets = activePingTargets(settings);
  if (!targets.length) return fail('error');

  if (isMockNode(inst.node)) {
    const done = () => save(listingId, { status: 'DONE', requestedAt: now, testedAt: new Date().toISOString(), method: 'icmp', via: 'mock', results: mockResults(targets), targets });
    if (!MOCK_DELAY_MS) {
      await done();
    } else {
      await save(listingId, { status: 'PENDING', requestedAt: now });
      void sleep(MOCK_DELAY_MS).then(done).catch(() => undefined);
    }
    return { deferStop: false };
  }

  const report = await getHostReport(inst.node.id);
  if (!report?.online || !report.capabilities?.includes('listing-ping-v2')) return fail('agent');

  const requestId = randomUUID();
  await save(listingId, { status: 'PENDING', requestedAt: now, requestId, targets });
  void runFlow(listingId, inst, userId, requestId, targets, Math.min(4, Math.max(2, settings.count))).catch(async e => {
    const cur = await current(listingId);
    if (cur?.requestId === requestId && cur.status === 'PENDING') await save(listingId, { ...cur, status: 'FAILED', reason: 'error', error: String(e).slice(0, 300) });
  });
  return { deferStop: dedicated };
}

/** 拨测流程：（独立 IPv4 关机时先开机）下发任务 → 等待结果 → （独立 IPv4）关机 */
async function runFlow(listingId: number, inst: PingInstance, userId: number, requestId: string, targets: PingTarget[], count: number): Promise<void> {
  let locked = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    locked = (await redis.set(FLOW_KEY(listingId), requestId, 'PX', START_TIMEOUT_MS + RESULT_TIMEOUT_MS + 60_000, 'NX')) === 'OK';
    if (locked) break;
    await sleep(POLL_MS);
  }
  if (!locked) {
    const p = await current(listingId);
    if (p?.requestId === requestId) await save(listingId, { ...p, status: 'FAILED', reason: 'timeout' });
    return;
  }
  const dedicated = isDedicated(inst.type);
  const pending = await current(listingId);
  if (!pending || pending.requestId !== requestId || pending.status !== 'PENDING') {
    await redis.del(FLOW_KEY(listingId));
    return;
  }
  try {
    if (dedicated && inst.status !== 'RUNNING') {
      // 上游只会把地址路由到运行中的实例，独立 IPv4 关机时先开机
      await enqueueTask({ instanceId: inst.id, type: 'START', userId, exclusive: false });
      if (!(await waitRunning(inst.id))) {
        await save(listingId, { ...pending, status: 'FAILED', reason: 'start' });
        return;
      }
    }
    const active = await prisma.marketListing.findUnique({ where: { id: listingId }, select: { status: true } });
    if (active?.status !== 'ACTIVE') return;
    const job: AgentJob = { ...agentJob(listingId, inst), requestId, targets: targets.map(({ id, host, port, province }) => ({ id, host, port, mainland: pingRegionNeedsIsp(province) })), controls: [...MARKET_PING_CONTROLS], count, exp: Date.now() + RESULT_TIMEOUT_MS };
    await redis.hset(JOBS_KEY(inst.node.id), String(listingId), JSON.stringify(job));
    const deadline = Date.now() + RESULT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const p = await current(listingId);
      if (!p || p.status !== 'PENDING' || p.requestId !== requestId) return;
      if ((await prisma.marketListing.findUnique({ where: { id: listingId }, select: { status: true } }))?.status !== 'ACTIVE') return;
    }
    await redis.hdel(JOBS_KEY(inst.node.id), String(listingId));
    await save(listingId, { ...pending, status: 'FAILED', reason: 'timeout' });
  } catch (e) {
    const cur = await current(listingId).catch(() => null);
    if (cur?.requestId === requestId && cur.status === 'PENDING') await save(listingId, { ...pending, status: 'FAILED', reason: 'error', error: e instanceof Error ? e.message.slice(0, 300) : String(e) }).catch(() => undefined);
  } finally {
    try {
      const raw = (await redis.hgetall(JOBS_KEY(inst.node.id)))[String(listingId)];
      if (raw && (JSON.parse(raw) as AgentJob).requestId === requestId) await redis.hdel(JOBS_KEY(inst.node.id), String(listingId)).catch(() => undefined);
      if (dedicated && (await current(listingId))?.requestId === requestId) await stopIfListed(listingId, inst.id, userId);
    } finally {
      await redis.del(FLOW_KEY(listingId)).catch(() => undefined);
    }
  }
}

async function waitRunning(instanceId: number): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const inst = await prisma.instance.findUnique({ where: { id: instanceId }, select: { status: true } });
    if (!inst) return false;
    if (inst.status === 'RUNNING') return true;
    if (inst.status === 'ERROR') return false;
  }
  return false;
}

/** 拨测结束：实例仍在挂牌（挂牌期间保持关机）时关机 */
async function stopIfListed(listingId: number, instanceId: number, userId: number): Promise<void> {
  const listing = await prisma.marketListing.findUnique({ where: { id: listingId }, select: { status: true, instance: { select: { status: true } } } });
  if (listing?.status !== 'ACTIVE' || listing.instance.status === 'STOPPED') return;
  await enqueueTask({ instanceId, type: 'STOP', userId, exclusive: false }).catch(() => undefined);
}

/** 面板启动时：继续等待中断的拨测（超时则按失败处理），独立 IPv4 实例拨测结束后关机 */
export async function recoverListingPings(): Promise<void> {
  const rows = await prisma.marketListing.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, sellerId: true, ping: true, instance: { select: { id: true, type: true } } },
  });
  for (const row of rows) {
    const p = row.ping as Partial<StoredPing> | null;
    if (p?.status !== 'PENDING' || typeof p.requestedAt !== 'string') continue;
    const requestedAt = p.requestedAt;
    void (async () => {
      if ((await redis.set(FLOW_KEY(row.id), p.requestId ?? 'legacy', 'PX', START_TIMEOUT_MS + RESULT_TIMEOUT_MS + 60_000, 'NX')) !== 'OK') return;
      try {
        const deadline = Date.parse(requestedAt) + START_TIMEOUT_MS + RESULT_TIMEOUT_MS;
        while (Date.now() < deadline) {
          const cur = await current(row.id);
          if (!cur || cur.status !== 'PENDING' || cur.requestId !== p.requestId || cur.requestedAt !== requestedAt) break;
          await sleep(POLL_MS * 2);
        }
        const cur = await current(row.id);
        if (!cur || cur.requestId !== p.requestId || cur.requestedAt !== requestedAt) return;
        if (cur.status === 'PENDING') await save(row.id, { ...cur, status: 'FAILED', reason: 'timeout' });
        if (isDedicated(row.instance.type)) await stopIfListed(row.id, row.instance.id, row.sellerId);
      } finally {
        await redis.del(FLOW_KEY(row.id)).catch(() => undefined);
      }
    })().catch(() => undefined);
  }
}

// ───────── Agent ─────────

/** 上报回复里下发的拨测任务（只发未过期的，顺便清理过期任务） */
export async function agentListingJobs(nodeId: number): Promise<Omit<AgentJob, 'exp'>[]> {
  const all = await redis.hgetall(JOBS_KEY(nodeId));
  const out: Omit<AgentJob, 'exp'>[] = [];
  for (const [id, raw] of Object.entries(all)) {
    let job: AgentJob | null = null;
    try {
      job = JSON.parse(raw) as AgentJob;
    } catch {
      /* 损坏的任务直接删除 */
    }
    if (!job || job.exp < Date.now()) {
      await redis.hdel(JOBS_KEY(nodeId), id);
      continue;
    }
    const { exp: _exp, ...rest } = job;
    if (!job.requestId) continue;
    out.push(rest);
  }
  return out.slice(0, 5);
}

export interface AgentListingPingInput {
  id: number;
  requestId?: string;
  ip?: string;
  method?: 'icmp' | 'tcp';
  via?: 'local' | 'default' | 'spoof' | 'spoof-l2';
  results?: (PingResultDTO & { error?: string })[];
  verification?: {
    results: (PingResultDTO & { error?: string })[];
    controls: (PingResultDTO & { error?: string })[];
    confirmationControls: (PingResultDTO & { error?: string })[];
  };
  error?: string;
}

/** 保存 Agent 回传的拨测结果；不是这台宿主机的任务时返回 false */
export async function saveAgentListingPing(nodeId: number, input: AgentListingPingInput): Promise<boolean> {
  return withLock(`market-ping-result:${input.id}`, 15_000, async () => {
    const raw = (await redis.hgetall(JOBS_KEY(nodeId)))[String(input.id)];
    if (!raw) return false;
    const job = JSON.parse(raw) as AgentJob;
    if (!job.requestId || input.requestId !== job.requestId || job.exp <= Date.now()) return false;
    const cur = await current(input.id);
    const listing = await prisma.marketListing.findUnique({ where: { id: input.id }, include: { instance: { include: { node: true, ipAddress: true } } } });
    if (!cur || cur.status !== 'PENDING' || cur.requestId !== job.requestId || !listing || listing.status !== 'ACTIVE' || listing.instance.nodeId !== nodeId) return false;
    const source = agentJob(input.id, listing.instance);
    const validSource = input.ip === job.ip && source.ip === job.ip && source.kind === job.kind
      && source.mac === job.mac && source.gateway === job.gateway && source.bridge === job.bridge
      && (job.kind === 'nat' ? ['local', 'default'].includes(input.via ?? '') : listing.instance.status === 'RUNNING' && (job.bridge ? ['local', 'spoof-l2'] : ['local', 'spoof']).includes(input.via ?? ''));
    const normalize = (rows: (PingResultDTO & { error?: string })[], expected: { id: string }[]) => {
      const normalized = new Map<string, PingResultDTO | null>();
      for (const r of rows) {
        if (!expected.some(t => t.id === r.id)) continue;
        const valid = !normalized.has(r.id) && !r.error && (!r.targetIp || isIP(r.targetIp) === 4) && Number.isFinite(r.loss) && r.loss >= 0 && r.loss <= 100
          && (r.latency === null ? r.loss === 100 : Number.isFinite(r.latency) && r.latency >= 0 && r.loss < 100);
        normalized.set(r.id, valid ? { id: r.id, latency: r.latency === null ? null : Math.round(r.latency * 10) / 10, loss: r.loss, ...(r.targetIp ? { targetIp: r.targetIp } : {}) } : null);
      }
      return [...normalized.values()].filter((r): r is PingResultDTO => r !== null);
    };
    const results = normalize(input.results ?? [], job.targets);
    await redis.hdel(JOBS_KEY(nodeId), String(input.id));
    if (input.error || input.method !== 'icmp' || !validSource || results.length !== job.targets.length) {
      await save(input.id, { ...cur, status: 'FAILED', reason: 'error', error: (input.error ?? 'incomplete ICMP results or invalid source').slice(0, 300) });
      return true;
    }
    const verification = input.verification ? {
      results: normalize(input.verification.results, job.targets),
      controls: normalize(input.verification.controls, job.controls),
      confirmationControls: normalize(input.verification.confirmationControls, job.controls),
    } : undefined;
    const merged = results.map(r => verification?.results.find(next => next.id === r.id && next.latency !== null) ?? r);
    await save(input.id, { ...cur, status: 'DONE', testedAt: new Date().toISOString(), method: 'icmp', via: input.via, results: merged, verification });
    return true;
  });
}

/** 模拟节点的拨测结果：全部可达，延迟按运营商与省份随机 */
function mockResults(targets: PingTarget[] = PING_TARGETS): PingResultDTO[] {
  const base = 120 + Math.random() * 60;
  return targets.map((t) => ({
    id: t.id,
    latency: Math.round((base + (t.isp ? PING_ISPS.indexOf(t.isp) * 8 : 0) + Math.random() * 40) * 10) / 10,
    loss: 0,
  }));
}

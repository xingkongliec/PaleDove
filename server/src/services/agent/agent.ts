// 宿主机 Agent：
//  - 生成策略：面板只签发「一次性安装令牌」（30 分钟有效、只能使用一次），安装命令与安装脚本里不出现长期密钥；
//    安装脚本用它换取 Agent 密钥（每次安装都重新生成密钥，旧 Agent 随即失效）。
//  - 认证：Go 版 Agent 的每个请求用 HMAC-SHA256 签名（方法、路径、时间戳、随机数、请求体哈希），随机数防重放；
//    面板对回复同样签名，Agent 据此信任升级指令。旧版 bash 上报程序仍使用 Bearer 令牌。
//  - 刷新策略：Agent 按面板回复的间隔上报（默认 10 秒）；超过 max(3 × 间隔, 60 秒) 没有上报视为离线，
//    最后一次上报保留 7 天，离线时仍可查看最后的状态与心跳时间。
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { HostReportDTO } from '../../shared/index.ts';
import { decrypt, encrypt, randomToken, sha256 } from '../../lib/crypto.ts';
import { unauthorized } from '../../lib/errors.ts';
import { prisma, type Node } from '../../lib/prisma.ts';
import { redis, withLock } from '../../lib/redis.ts';
import { t } from '../../i18n/index.ts';
import { vmCpuQuotaUsec, vmCpuWeight } from '../spec.ts';
import { cacheNodeArchitecture } from '../node-architecture.ts';

const REPORT_KEY = (id: number) => `node:host:${id}`;
/** 默认上报间隔（秒），随上报回复下发给 Agent */
export const AGENT_REPORT_INTERVAL = 10;
/** 最后一次上报保留 7 天（离线时仍显示最后状态） */
const REPORT_TTL_SEC = 7 * 86400;
/** 超过 max(3 × 上报间隔, 60 秒) 没有上报视为离线 */
export const offlineAfterSec = (interval = AGENT_REPORT_INTERVAL) => Math.max(interval * 3, 60);

/** 一次性安装令牌：30 分钟有效，只能使用一次 */
const INSTALL_TOKEN_TTL_SEC = 30 * 60;
const INSTALL_KEY = (token: string) => `agent:install:${sha256(token)}`;
const NODE_INSTALL_KEY = (nodeId: number) => `agent:install:node:${nodeId}`;
const INSTALL_LOCK = (nodeId: number) => `agent-install:${nodeId}`;
/** 签名请求的时间戳允许误差与随机数保留时间 */
const SIGNATURE_WINDOW_MS = 5 * 60_000;
const NONCE_TTL_SEC = 15 * 60;

// ───────── 凭据 ─────────

/** 生成新的 Agent 密钥；之前安装的 Agent 随即失效 */
export async function issueAgentToken(nodeId: number): Promise<string> {
  const token = randomToken(32);
  await prisma.node.update({ where: { id: nodeId }, data: { agentTokenHash: sha256(token), agentTokenEnc: encrypt(token) } });
  return token;
}

/** 每台宿主机只保留最新的一次性安装令牌；刷新命令不会中断正在运行的 Agent。 */
export async function issueAgentInstallToken(nodeId: number): Promise<{ token: string; expiresAt: Date }> {
  return withLock(INSTALL_LOCK(nodeId), 30_000, async () => {
    const currentKey = NODE_INSTALL_KEY(nodeId);
    const previous = await redis.get(currentKey);
    const token = `pdi_${randomToken(24)}`;
    const key = INSTALL_KEY(token);
    const expiresAt = new Date(Date.now() + INSTALL_TOKEN_TTL_SEC * 1000);
    const tx = redis.multi();
    if (previous) tx.del(previous);
    await tx.set(key, String(nodeId), 'EX', INSTALL_TOKEN_TTL_SEC).set(currentKey, key, 'EX', INSTALL_TOKEN_TTL_SEC).exec();
    return { token, expiresAt };
  });
}

/** 使用一次性安装令牌：成功后令牌作废，并为宿主机生成新的 Agent 密钥 */
export async function consumeAgentInstallToken(token: string): Promise<{ node: Node; secret: string }> {
  const key = INSTALL_KEY(token);
  const nodeId = Number(await redis.get(key));
  if (!nodeId) throw unauthorized(t('agent.installTokenInvalid'));
  return withLock(INSTALL_LOCK(nodeId), 30_000, async () => {
    // 与签发共用节点锁，避免旧令牌在刷新后继续兑换；并发兑换只允许一次成功。
    if ((await redis.get(NODE_INSTALL_KEY(nodeId))) !== key || (await redis.del(key)) !== 1) throw unauthorized(t('agent.installTokenInvalid'));
    await redis.del(NODE_INSTALL_KEY(nodeId));
    const node = await prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) throw unauthorized(t('agent.installTokenInvalid'));
    return { node, secret: await issueAgentToken(node.id) };
  });
}

/** 旧版 bash 上报程序：Bearer 令牌 */
export async function nodeByAgentToken(token: string): Promise<Node> {
  const node = await prisma.node.findFirst({ where: { agentTokenHash: sha256(token) } });
  if (!node) throw unauthorized(t('agent.tokenInvalid'));
  return node;
}

// ───────── 请求签名 ─────────

export const bodyHash = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

/** 签名内容：方法、路径（含查询参数）、毫秒时间戳、随机数、请求体 sha256，以换行连接 */
export function signingPayload(method: string, path: string, timestamp: string, nonce: string, hash: string): string {
  return [method.toUpperCase(), path, timestamp, nonce, hash.toLowerCase()].join('\n');
}

export const hmacHex = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export interface SignedHeaders {
  node: string | undefined;
  timestamp: string | undefined;
  nonce: string | undefined;
  signature: string | undefined;
}

/**
 * 校验 Go 版 Agent 的签名请求，返回宿主机与密钥（用于回复签名）。
 * 时间戳超出 ±5 分钟、随机数重复、签名不符都拒绝。
 */
export async function verifySignedRequest(h: SignedHeaders, method: string, path: string, rawBody: string): Promise<{ node: Node; secret: string }> {
  const invalid = () => unauthorized(t('agent.tokenInvalid'));
  const nodeId = Number(h.node);
  if (!Number.isSafeInteger(nodeId) || nodeId <= 0 || !h.timestamp || !h.nonce || !h.signature) throw invalid();
  if (!/^\d{13}$/.test(h.timestamp) || Math.abs(Date.now() - Number(h.timestamp)) > SIGNATURE_WINDOW_MS) throw unauthorized(t('agent.clockSkew'));
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(h.nonce) || !/^[0-9a-f]{64}$/i.test(h.signature)) throw invalid();
  const node = await prisma.node.findUnique({ where: { id: nodeId } });
  if (!node?.agentTokenEnc) throw invalid();
  const secret = decrypt(node.agentTokenEnc);
  if (!safeEqualHex(hmacHex(secret, signingPayload(method, path, h.timestamp, h.nonce, bodyHash(rawBody))), h.signature)) throw invalid();
  // 随机数只能使用一次（防重放）
  if ((await redis.set(`agent:nonce:${nodeId}:${h.nonce}`, '1', 'EX', NONCE_TTL_SEC, 'NX')) !== 'OK') throw invalid();
  return { node, secret };
}

/** 回复签名：Agent 用同一密钥校验，确认升级指令确实来自面板 */
export function signResponse(secret: string, nonce: string, body: string): string {
  return hmacHex(secret, ['RESPONSE', nonce, bodyHash(body)].join('\n'));
}

// ───────── 上报 ─────────

/** 上报内容：旧版 bash 上报程序只有 cpu / load / uptime / version，Go 版 Agent（协议 3）上报完整状态 */
export type HostReportInput = Omit<HostReportDTO, 'version' | 'reportedAt' | 'ip' | 'online'> & {
  /** 旧版本上报程序不上报版本，按 1 处理 */
  version?: number;
};

export async function saveHostReport(nodeId: number, input: HostReportInput, ip?: string): Promise<void> {
  const report: Omit<HostReportDTO, 'online'> = { ...input, cpu: Math.round(input.cpu * 100) / 100, version: input.version ?? 1, ip, reportedAt: new Date().toISOString() };
  await redis.set(REPORT_KEY(nodeId), JSON.stringify(report), 'EX', REPORT_TTL_SEC);
  await cacheNodeArchitecture(nodeId, input.arch);
}

/** 最后一次上报（7 天内）；online 表示在离线阈值内有上报 */
export async function getHostReport(nodeId: number): Promise<HostReportDTO | null> {
  const raw = await redis.get(REPORT_KEY(nodeId));
  if (!raw) return null;
  const report = JSON.parse(raw) as Omit<HostReportDTO, 'online'>;
  return { ...report, online: Date.now() - Date.parse(report.reportedAt) <= offlineAfterSec() * 1000 };
}

export async function clearHostReport(nodeId: number): Promise<void> {
  await redis.del(REPORT_KEY(nodeId));
}

/**
 * 上报程序拉取的虚拟机 CPU 限制：每行「项目 实例名 CPU 配额(微秒/秒) CPU 权重」，没有设置的项为 -。
 * 只列出设置了限制的虚拟机；上报程序会解除不在列表中的虚拟机此前被设置的限制。
 */
export async function vmLimitsText(node: Node): Promise<string> {
  const rows = await prisma.instance.findMany({
    where: { nodeId: node.id, type: { in: ['KVM_NAT', 'KVM_IPV4'] }, status: { in: ['RUNNING', 'STOPPED', 'ERROR', 'REINSTALLING'] } },
    select: { name: true, type: true, cpu: true, cpuAllowance: true, cpuPriority: true },
    orderBy: { id: 'asc' },
  });
  const project = node.project || 'default';
  const lines: string[] = [];
  for (const inst of rows) {
    const quota = vmCpuQuotaUsec(inst);
    const weight = vmCpuWeight(inst);
    if (quota === null && weight === null) continue;
    lines.push(`${project} ${inst.name} ${quota ?? '-'} ${weight ?? '-'}`);
  }
  return lines.map((l) => `${l}\n`).join('');
}

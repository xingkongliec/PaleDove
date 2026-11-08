// 智能分流：宿主机出口（WireGuard / SOCKS5 / HTTP）的配置、下发与实例选择。
//  - 管理员在宿主机「智能分流」中配置出口；配置（私钥、密码）加密保存，返回管理端时只标出是否已设置；
//  - 每次修改（出口、开关、实例选择）递增配置版本；Agent 心跳时拿到版本号，变化后拉取完整配置并应用：
//      WireGuard：宿主机建立隧道接口，选择该出口的实例按源地址策略路由进隧道（整机全协议），同一宿主机的实例共享隧道；
//      SOCKS5 / HTTP：Agent 网关透明转发实例的 TCP 连接到上游代理；
//    私钥与密码只下发给宿主机 Agent（签名回复），不会下发到实例；
//  - Agent 应用后回报各出口的状态（握手时间、收发字节、连通性）；
//  - 用户可为 NAT 实例选择出口（宿主机开启智能分流时），迁移 / 切换机房时清除。
import { isNatType, type AdminEgressDTO, type AdminNodeEgressDTO, type EgressStatusDTO, type EgressType, type InstanceEgressDTO } from '../shared/index.ts';
import { z } from 'zod';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { prisma, type Instance, type Node, type NodeEgress } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';
import { m, t } from '../i18n/index.ts';
import { getHostReport } from './agent/agent.ts';

// ───────── 配置 ─────────

export interface WireguardConfig {
  privateKey: string;
  /** 隧道内地址，多个用逗号分隔，如 10.7.0.2/32, fd00::2/128 */
  address: string;
  peerPublicKey: string;
  presharedKey: string;
  /** host:port 或 [ipv6]:port */
  endpoint: string;
  mtu: number;
  keepalive: number;
}

export interface ProxyConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

type EgressConfig = WireguardConfig | ProxyConfig;

const WG_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw480]=$/;
const HOST = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^[0-9a-fA-F:]+$/;
const cidr = (v: string) => {
  const [ip, len] = v.split('/');
  if (!ip || len === undefined || !/^\d+$/.test(len)) return false;
  return IPV4.test(ip) ? Number(len) <= 32 : IPV6.test(ip) && ip.includes(':') && Number(len) <= 128;
};
const endpointOk = (v: string) => {
  const m6 = /^\[([0-9a-fA-F:]+)\]:(\d{1,5})$/.exec(v);
  const m4 = /^([^:\s]+):(\d{1,5})$/.exec(v);
  const port = Number((m6 ?? m4)?.[2]);
  return !!(m6 || (m4 && (IPV4.test(m4[1]!) || HOST.test(m4[1]!)))) && port >= 1 && port <= 65535;
};

/** 保存出口的请求：密钥 / 密码留空表示不修改（新建时 WireGuard 私钥必填） */
export const egressInputSchema = z.object({
  name: z.string().trim().min(1, m('egress.nameRequired')).max(32),
  type: z.enum(['WIREGUARD', 'SOCKS5', 'HTTP']),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
  remark: z.string().trim().max(100).nullable().optional(),
  wireguard: z
    .object({
      privateKey: z.string().trim().refine((v) => v === '' || WG_KEY.test(v), m('egress.wgKeyInvalid')).default(''),
      address: z
        .string()
        .trim()
        .refine((v) => v.split(',').map((s) => s.trim()).filter(Boolean).length > 0 && v.split(',').map((s) => s.trim()).filter(Boolean).every(cidr), m('egress.wgAddressInvalid')),
      peerPublicKey: z.string().trim().regex(WG_KEY, m('egress.wgKeyInvalid')),
      presharedKey: z.string().trim().refine((v) => v === '' || WG_KEY.test(v), m('egress.wgKeyInvalid')).default(''),
      endpoint: z.string().trim().refine(endpointOk, m('egress.wgEndpointInvalid')),
      mtu: z.number().int().min(1280).max(1500).default(1420),
      keepalive: z.number().int().min(0).max(300).default(25),
    })
    .optional(),
  proxy: z
    .object({
      host: z.string().trim().refine((v) => IPV4.test(v) || HOST.test(v), m('egress.proxyHostInvalid')),
      port: z.number().int().min(1).max(65535),
      username: z.string().trim().max(128).default(''),
      password: z.string().max(256).default(''),
    })
    .optional(),
});
export type EgressInput = z.infer<typeof egressInputSchema>;

function readConfig(e: Pick<NodeEgress, 'configEnc'>): EgressConfig {
  return JSON.parse(decrypt(e.configEnc)) as EgressConfig;
}

/** 合并保存的配置：留空的私钥 / 预共享密钥 / 密码沿用原值 */
function buildConfig(input: EgressInput, previous: EgressConfig | null, prevType: EgressType | null): EgressConfig {
  const same = prevType === input.type ? previous : null;
  if (input.type === 'WIREGUARD') {
    const wg = input.wireguard;
    if (!wg) throw badRequest(t('egress.wgRequired'));
    const prev = same as WireguardConfig | null;
    const privateKey = wg.privateKey || prev?.privateKey || '';
    if (!privateKey) throw badRequest(t('egress.wgKeyRequired'));
    return {
      privateKey,
      address: wg.address.split(',').map((s) => s.trim()).filter(Boolean).join(', '),
      peerPublicKey: wg.peerPublicKey,
      presharedKey: wg.presharedKey || prev?.presharedKey || '',
      endpoint: wg.endpoint,
      mtu: wg.mtu,
      keepalive: wg.keepalive,
    };
  }
  const px = input.proxy;
  if (!px) throw badRequest(t('egress.proxyRequired'));
  const prev = same as ProxyConfig | null;
  return { host: px.host, port: px.port, username: px.username, password: px.password || (px.username ? (prev?.password ?? '') : '') };
}

// ───────── 版本与状态 ─────────

const VERSION_KEY = (nodeId: number) => `egress:ver:${nodeId}`;
const STATUS_KEY = (nodeId: number) => `egress:status:${nodeId}`;

/** 配置有变化：递增版本，Agent 下次心跳拉取 */
export async function bumpEgressVersion(nodeId: number): Promise<number> {
  return redis.incr(VERSION_KEY(nodeId));
}

export async function egressVersion(nodeId: number): Promise<number> {
  return Number((await redis.get(VERSION_KEY(nodeId))) ?? 0);
}

interface StoredStatus {
  version: number;
  appliedAt: string;
  error: string | null;
  items: Record<string, EgressStatusDTO>;
}

export interface ReportedEgressStatus {
  version: number;
  error?: string | null;
  items: { id: number; ok: boolean; error?: string | null; handshakeAt?: number | null; rx?: number; tx?: number; latency?: number | null }[];
}

/** 保存 Agent 回报的执行情况 */
export async function saveEgressStatus(nodeId: number, report: ReportedEgressStatus): Promise<void> {
  const now = new Date().toISOString();
  const stored: StoredStatus = {
    version: report.version,
    appliedAt: now,
    error: report.error ?? null,
    items: Object.fromEntries(
      report.items.map((i) => [
        String(i.id),
        {
          ok: i.ok,
          error: i.error ?? null,
          handshakeAt: i.handshakeAt ? new Date(i.handshakeAt * 1000).toISOString() : null,
          rx: i.rx ?? 0,
          tx: i.tx ?? 0,
          latency: i.latency ?? null,
          checkedAt: now,
        } satisfies EgressStatusDTO,
      ]),
    ),
  };
  await redis.set(STATUS_KEY(nodeId), JSON.stringify(stored), 'EX', 7 * 86400);
}

async function loadStatus(nodeId: number): Promise<StoredStatus | null> {
  const raw = await redis.get(STATUS_KEY(nodeId));
  return raw ? (JSON.parse(raw) as StoredStatus) : null;
}

// ───────── 管理端 ─────────

function toAdminEgress(e: NodeEgress & { _count: { instances: number } }, status: StoredStatus | null): AdminEgressDTO {
  const cfg = readConfig(e);
  const wg = e.type === 'WIREGUARD' ? (cfg as WireguardConfig) : null;
  const px = e.type !== 'WIREGUARD' ? (cfg as ProxyConfig) : null;
  return {
    id: e.id,
    name: e.name,
    type: e.type,
    enabled: e.enabled,
    sortOrder: e.sortOrder,
    remark: e.remark,
    wireguard: wg
      ? { address: wg.address, peerPublicKey: wg.peerPublicKey, endpoint: wg.endpoint, mtu: wg.mtu, keepalive: wg.keepalive, hasPrivateKey: !!wg.privateKey, hasPresharedKey: !!wg.presharedKey }
      : null,
    proxy: px ? { host: px.host, port: px.port, username: px.username, hasPassword: !!px.password } : null,
    instanceCount: e._count.instances,
    status: status?.items[String(e.id)] ?? null,
  };
}

const egressInclude = { _count: { select: { instances: { where: { status: { notIn: ['DELETED' as const, 'DELETING' as const] } } } } } };

export async function adminNodeEgress(node: Node): Promise<AdminNodeEgressDTO> {
  const [rows, version, status, report] = await Promise.all([
    prisma.nodeEgress.findMany({ where: { nodeId: node.id }, include: egressInclude, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    egressVersion(node.id),
    loadStatus(node.id),
    getHostReport(node.id),
  ]);
  return {
    enabled: node.egressEnabled,
    version,
    appliedVersion: status?.version ?? null,
    appliedAt: status?.appliedAt ?? null,
    applyError: status?.error ?? null,
    agent: { online: !!report?.online, supported: !!report?.capabilities?.includes('egress') },
    items: rows.map((r) => toAdminEgress(r, status)),
  };
}

export async function createEgress(node: Node, input: EgressInput): Promise<NodeEgress> {
  const config = buildConfig(input, null, null);
  const row = await prisma.nodeEgress.create({
    data: { nodeId: node.id, name: input.name, type: input.type, enabled: input.enabled, sortOrder: input.sortOrder, remark: input.remark || null, configEnc: encrypt(JSON.stringify(config)) },
  });
  await bumpEgressVersion(node.id);
  return row;
}

export async function updateEgress(node: Node, id: number, input: EgressInput): Promise<NodeEgress> {
  const row = await prisma.nodeEgress.findFirst({ where: { id, nodeId: node.id } });
  if (!row) throw notFound(t('egress.notFound'));
  const config = buildConfig(input, readConfig(row), row.type);
  const updated = await prisma.nodeEgress.update({
    where: { id },
    data: { name: input.name, type: input.type, enabled: input.enabled, sortOrder: input.sortOrder, remark: input.remark || null, configEnc: encrypt(JSON.stringify(config)) },
  });
  await bumpEgressVersion(node.id);
  return updated;
}

/** 删除出口：使用它的实例回到默认线路（外键 SetNull） */
export async function deleteEgress(node: Node, id: number): Promise<void> {
  const r = await prisma.nodeEgress.deleteMany({ where: { id, nodeId: node.id } });
  if (!r.count) throw notFound(t('egress.notFound'));
  await bumpEgressVersion(node.id);
}

// ───────── Agent ─────────

export interface AgentEgressConfig {
  version: number;
  enabled: boolean;
  /** 不走出口的目的网段（宿主机 NAT 网段，实例之间与访问宿主机） */
  bypass: string[];
  egresses: ({ id: number; name: string; type: 'WIREGUARD'; wireguard: WireguardConfig } | { id: number; name: string; type: 'SOCKS5' | 'HTTP'; proxy: ProxyConfig })[];
  /** 选择了出口的实例：名称、内网地址与出口 */
  instances: { name: string; ip: string; egressId: number }[];
}

/** 下发给 Agent 的完整配置（含解密后的私钥 / 密码，只通过签名回复发给宿主机 Agent） */
export async function agentEgressConfig(node: Node): Promise<AgentEgressConfig> {
  const version = await egressVersion(node.id);
  if (!node.egressEnabled) return { version, enabled: false, bypass: [], egresses: [], instances: [] };
  const rows = await prisma.nodeEgress.findMany({ where: { nodeId: node.id, enabled: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
  const ids = rows.map((r) => r.id);
  const instances = await prisma.instance.findMany({
    where: { nodeId: node.id, egressId: { in: ids }, privateIp: { not: null }, status: { notIn: ['DELETED', 'DELETING'] } },
    select: { name: true, privateIp: true, egressId: true },
    orderBy: { id: 'asc' },
  });
  return {
    version,
    enabled: true,
    bypass: [node.natCidr].filter((c): c is string => !!c),
    egresses: rows.map((r) =>
      r.type === 'WIREGUARD'
        ? { id: r.id, name: r.name, type: 'WIREGUARD' as const, wireguard: readConfig(r) as WireguardConfig }
        : { id: r.id, name: r.name, type: r.type as 'SOCKS5' | 'HTTP', proxy: readConfig(r) as ProxyConfig },
    ),
    instances: instances.map((i) => ({ name: i.name, ip: i.privateIp!, egressId: i.egressId! })),
  };
}

// ───────── 实例 ─────────

/** 实例可选的出口：宿主机开启智能分流、NAT 实例（有内网地址） */
export async function instanceEgress(inst: Instance & { node: Node }): Promise<InstanceEgressDTO> {
  const usable = inst.node.egressEnabled && isNatType(inst.type) && !!inst.privateIp;
  if (!usable) return { available: false, current: inst.egressId, options: [] };
  const [rows, status] = await Promise.all([
    prisma.nodeEgress.findMany({ where: { nodeId: inst.nodeId, enabled: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    loadStatus(inst.nodeId),
  ]);
  return {
    available: rows.length > 0,
    current: inst.egressId,
    options: rows.map((r) => ({ id: r.id, name: r.name, type: r.type, remark: r.remark, ok: status?.items[String(r.id)]?.ok ?? null })),
  };
}

/** 切换实例的出口（null 为宿主机默认线路） */
export async function setInstanceEgress(inst: Instance & { node: Node }, egressId: number | null): Promise<void> {
  if (egressId !== null) {
    if (!inst.node.egressEnabled || !isNatType(inst.type) || !inst.privateIp) throw badRequest(t('egress.unavailable'));
    const row = await prisma.nodeEgress.findFirst({ where: { id: egressId, nodeId: inst.nodeId, enabled: true } });
    if (!row) throw notFound(t('egress.notFound'));
  }
  if (inst.egressId === egressId) return;
  await prisma.instance.update({ where: { id: inst.id }, data: { egressId } });
  await bumpEgressVersion(inst.nodeId);
}

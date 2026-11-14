import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import { hasIpv6Mode, LOCALES, STORAGE_DRIVERS, type PoolUsage, type NodeHardwareDTO, type NodeResourcesDTO, type StoragePoolDTO } from '../shared/index.ts';
import { createIncusClient, getIncus, invalidateIncus } from '../incus/index.ts';
import { getClientCertificate } from '../incus/certs.ts';
import { buildEndpoint, decodeTrustToken, HttpIncusClient, normalizeFingerprint } from '../incus/client.ts';
import type { IncusConfig, IncusResources, IncusServer } from '../incus/types.ts';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.ts';
import { AppError, badRequest, errorMessage, unauthorized } from '../lib/errors.ts';
import { formatIpv6Cidr, isIPv4, parseCidr, parseIpv6Cidr } from '../lib/ip.ts';
import { prisma, type Node } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';
import { t } from '../i18n/index.ts';
import { issueAgentInstallToken } from './agent/agent.ts';
import { renderNodeInstallScript } from './agent/install-script.ts';
import { cacheNodeArchitecture } from './node-architecture.ts';

const TOKEN_TTL_MS = 24 * 3600_000;

/** 获取 HTTPS 端点的服务端证书指纹（手动接入时的首次信任） */
export async function fetchServerFingerprint(endpoint: string): Promise<string> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw badRequest(t('node.httpsOnlyFingerprint'));
  const { cert, key } = await getClientCertificate();
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host: url.hostname, port: Number(url.port || 8443), servername: isIP(url.hostname) ? undefined : url.hostname, rejectUnauthorized: false, cert, key, timeout: 8000 },
      () => {
        const fp = normalizeFingerprint(socket.getPeerCertificate()?.fingerprint256);
        socket.end();
        if (!fp) reject(new Error(t('node.cannotReadCert')));
        else resolve(fp);
      },
    );
    socket.on('error', (err) => reject(new Error(t('node.connectFailed', { message: err.message }))));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(t('node.connectTimeout')));
    });
  });
}

export interface ConnectResult {
  trusted: boolean;
  serverName: string;
  version: string;
  natCidr: string | null;
  warnings: string[];
}

/**
 * 测试节点连接并同步 NAT 网段；手动接入时可提供信任令牌，把面板证书加入节点信任列表。
 */
export async function connectNode(node: Node, trustToken?: string): Promise<ConnectResult> {
  if (!node.endpoint) throw badRequest(t('node.notInstalled'));
  invalidateIncus(node.id);
  if (trustToken) {
    const token = decodeTrustToken(trustToken);
    if (node.serverFingerprint && node.serverFingerprint !== token.fingerprint) {
      throw badRequest(t('node.tokenFingerprintMismatch'));
    }
    if (!node.serverFingerprint) {
      node = await prisma.node.update({ where: { id: node.id }, data: { serverFingerprint: token.fingerprint } });
    }
    const client = await createIncusClient(node);
    const server = await client.getServer();
    if (server.auth !== 'trusted') await client.joinWithToken(trustToken);
  }
  const incus = await getIncus(node);
  const warnings: string[] = [];
  try {
    const server = await incus.getServer();
    if (server.auth !== 'trusted') throw new Error(t('node.notTrusted'));
    if (!server.api_extensions.includes('instances_rebuild')) warnings.push(t('node.noRebuild'));

    let natCidr: string | null = null;
    try {
      const net = await incus.getNetwork(node.natNetwork);
      const v4 = net.config['ipv4.address'];
      if (v4 && v4 !== 'none') {
        parseCidr(v4);
        natCidr = v4;
      } else warnings.push(t('node.networkNoIpv4', { network: node.natNetwork }));
    } catch (err) {
      warnings.push(t('node.networkReadFailed', { network: node.natNetwork, message: errorMessage(err) }));
    }
    try {
      await incus.getStoragePool(node.storagePool);
    } catch (err) {
      warnings.push(t('node.poolUnavailable', { pool: node.storagePool, message: errorMessage(err) }));
    }

    await prisma.node.update({
      where: { id: node.id },
      data: {
        status: 'ONLINE',
        lastCheckedAt: new Date(),
        lastError: null,
        incusVersion: server.environment?.server_version ?? node.incusVersion,
        ...(natCidr ? { natCidr } : {}),
      },
    });
    await cacheNodeArchitecture(node.id, server.environment?.architectures?.[0]);
    return {
      trusted: true,
      serverName: server.environment?.server_name ?? '',
      version: server.environment?.server_version ?? '',
      natCidr,
      warnings,
    };
  } catch (err) {
    await prisma.node.update({
      where: { id: node.id },
      data: { status: 'OFFLINE', lastCheckedAt: new Date(), lastError: errorMessage(err).slice(0, 500) },
    });
    throw err;
  }
}

// ───────── 一键安装 ─────────

/**
 * 获取安装令牌：有效期内（剩余 1 小时以上）沿用已签发的令牌，查看安装命令不会让之前复制的命令失效；
 * regenerate 为 true 时（管理员点击「重新生成」）才签发新令牌
 */
export async function issueInstallToken(nodeId: number, regenerate = false): Promise<{ token: string; expiresAt: Date }> {
  const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
  if (!regenerate && node.installTokenEnc && node.installTokenExpires && node.installTokenExpires.getTime() > Date.now() + 3600_000) {
    return { token: decrypt(node.installTokenEnc), expiresAt: node.installTokenExpires };
  }
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.node.update({ where: { id: nodeId }, data: { installTokenHash: sha256(token), installTokenEnc: encrypt(token), installTokenExpires: expiresAt } });
  return { token, expiresAt };
}

export async function nodeByInstallToken(token: string): Promise<Node> {
  const node = await prisma.node.findUnique({ where: { installTokenHash: sha256(token) } });
  if (!node || !node.installTokenExpires || node.installTokenExpires < new Date()) throw unauthorized(t('install.tokenInvalid'));
  return node;
}

export async function nodeInstallScript(node: Node, token: string, panelUrl: string, locale?: string): Promise<string> {
  const { cert } = await getClientCertificate();
  return renderNodeInstallScript({
    panelUrl,
    token,
    nodeName: node.name,
    apiPort: node.apiPort,
    poolName: node.storagePool,
    storageDriver: node.storageDriver,
    storageSource: node.storageSource,
    storageSize: node.storageSize,
    natNetwork: node.natNetwork,
    natCidr: node.natCidrInstall,
    portRangeStart: node.portRangeStart,
    portRangeEnd: node.portRangeEnd,
    publicIp: node.publicIp,
    ipv6: hasIpv6Mode(node.networkMode),
    ipv6Parent: node.ipv6Parent,
    panelCert: cert,
    // 每次下载安装脚本都签发新的一次性 Agent 安装令牌，脚本里不出现长期密钥
    agentInstallToken: (await issueAgentInstallToken(node.id)).token,
    installAgent: node.installAgent,
    installFirewall: node.installFirewall,
    enableFirewallRules: node.enableFirewallRules,
    locale,
  });
}

export interface RegisterNodeInput {
  token: string;
  fingerprint: string;
  publicIp: string;
  port: number;
  hostname?: string;
  version?: string;
  /** 脚本检测到的宿主机全局 IPv6（带前缀，例如 2001:db8::5/64）与所在网卡 */
  ipv6Address?: string;
  ipv6Interface?: string;
  /** 终端交互后读取的实际存储与组件配置；旧脚本可以省略。 */
  storagePool?: string;
  storageDriver?: (typeof STORAGE_DRIVERS)[number];
  storageSource?: string;
  storageSize?: string;
  installAgent?: boolean;
  installFirewall?: boolean;
  enableFirewallRules?: boolean;
}

/** IPv6 模式下尚未填写子网时，用脚本检测到的地址前缀作为子网 */
function detectedIpv6(node: Node, input: RegisterNodeInput): { ipv6Subnet: string; ipv6Parent: string } | null {
  if (!hasIpv6Mode(node.networkMode) || node.ipv6Subnet || !input.ipv6Address) return null;
  try {
    const c = parseIpv6Cidr(input.ipv6Address);
    if (c.prefix > 124) return null;
    return { ipv6Subnet: formatIpv6Cidr(c), ipv6Parent: node.ipv6Parent || input.ipv6Interface || '' };
  } catch {
    return null;
  }
}

/** 安装脚本回调：记录证书指纹（连接地址以添加时填写的为准），然后立即测试连接 */
export async function registerNode(
  input: RegisterNodeInput,
): Promise<{ node: Node; result: ConnectResult | null; error: string | null; ipv6: { ipv6Subnet: string; ipv6Parent: string } | null }> {
  const node = await nodeByInstallToken(input.token);
  const ipv6 = detectedIpv6(node, input);
  const updated = await prisma.node.update({
    where: { id: node.id },
    data: {
      ...ipv6,
      ...(input.storagePool !== undefined ? { storagePool: input.storagePool } : {}),
      ...(input.storageDriver !== undefined ? { storageDriver: input.storageDriver } : {}),
      ...(input.storageSource !== undefined ? { storageSource: input.storageSource || null } : {}),
      ...(input.storageSize ? { storageSize: input.storageSize } : {}),
      ...(input.installAgent !== undefined ? { installAgent: input.installAgent } : {}),
      ...(input.installFirewall !== undefined ? { installFirewall: input.installFirewall } : {}),
      ...(input.enableFirewallRules !== undefined ? { enableFirewallRules: input.enableFirewallRules } : {}),
      endpoint: node.endpoint || buildEndpoint(input.publicIp, input.port),
      serverFingerprint: normalizeFingerprint(input.fingerprint),
      publicIp: node.publicIp || (isIPv4(input.publicIp) ? input.publicIp : ''),
      apiPort: input.port,
      incusVersion: input.version || null,
      installedAt: new Date(),
      installTokenHash: null,
      installTokenEnc: null,
      installTokenExpires: null,
      natCidr: null,
      status: 'UNKNOWN',
    },
  });
  invalidateIncus(updated.id);
  try {
    return { node: updated, result: await connectNode(updated), error: null, ipv6 };
  } catch (err) {
    return { node: updated, result: null, error: errorMessage(err), ipv6 };
  }
}

/**
 * 验证并连接新宿主机。安装脚本未能回调面板时（例如宿主机访问不到面板），
 * 首次连接记录服务端证书指纹；确认面板证书已受信任后才写入数据库并标记为已安装，
 * 验证失败时宿主机保持待安装状态。
 */
export async function verifyNode(node: Node): Promise<ConnectResult> {
  if (!node.endpoint) throw badRequest(t('node.notInstalled'));
  let fingerprint = node.serverFingerprint;
  try {
    if (!fingerprint && node.endpoint.startsWith('https://')) fingerprint = await fetchServerFingerprint(node.endpoint);
    const client = await createIncusClient({ ...node, serverFingerprint: fingerprint });
    try {
      const server = await client.getServer();
      if (server.auth !== 'trusted') throw badRequest(t('node.notTrusted'));
    } finally {
      if (client instanceof HttpIncusClient) await client.close().catch(() => undefined);
    }
  } catch (err) {
    // 连接失败属于预期情况，原因直接展示给管理员
    throw err instanceof AppError ? err : badRequest(errorMessage(err));
  }
  const pending = node.status === 'PENDING';
  const updated = await prisma.node.update({
    where: { id: node.id },
    data: {
      serverFingerprint: fingerprint,
      ...(pending ? { status: 'UNKNOWN', installedAt: node.installedAt ?? new Date(), installTokenHash: null, installTokenEnc: null, installTokenExpires: null } : {}),
    },
  });
  return connectNode(updated);
}

/** 中文里香港、澳门的完整名称过长，使用常用简称 */
const SHORT_ZH: Record<string, Record<string, string>> = {
  'zh-CN': { HK: '香港', MO: '澳门' },
  'zh-TW': { HK: '香港', MO: '澳門' },
};

/** 国家或地区的显示名称（ISO 3166-1 alpha-2），用作默认的地区名 */
export function countryName(code: string, locale: string): string {
  const short = SHORT_ZH[locale]?.[code];
  if (short) return short;
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** 地区名是否为按国家自动生成的名称（任一界面语言），没有被管理员改过 */
export function isAutoRegion(region: string, code: string): boolean {
  return LOCALES.some((l) => countryName(code, l) === region);
}

// ───────── 资源与存储池 ─────────

/** Incus 资源信息（缓存 15 秒）；上报程序的实时数据由调用方合并 */
type IncusResourcesDTO = Omit<NodeResourcesDTO, 'host' | 'agentInstalled'>;

export async function getNodeResources(node: Node): Promise<IncusResourcesDTO> {
  if (!node.endpoint) throw badRequest(t('node.notInstalled'));
  const cacheKey = `node:resources:${node.id}`;
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached) as IncusResourcesDTO;
  const incus = await getIncus(node);
  const [server, res, instances] = await Promise.all([incus.getServer(), incus.getResources(), incus.listInstances()]);
  await cacheNodeArchitecture(node.id, server.environment?.architectures?.[0] || res.cpu.architecture);
  let storage: NodeResourcesDTO['storage'] = null;
  try {
    const [pool, poolRes] = await Promise.all([incus.getStoragePool(node.storagePool), incus.getStoragePoolResources(node.storagePool)]);
    storage = { pool: pool.name, driver: pool.driver, total: poolRes.space.total, used: poolRes.space.used };
  } catch {
    /* 存储池不可用 */
  }
  const dto: IncusResourcesDTO = {
    serverVersion: server.environment?.server_version ?? '',
    serverName: server.environment?.server_name ?? '',
    kernel: server.environment?.kernel_version ?? '',
    cpu: { cores: res.cpu.total, model: res.cpu.sockets?.[0]?.name ?? '' },
    memory: { total: res.memory.total, used: res.memory.used },
    storage,
    instances: { total: instances.length, running: instances.filter((i) => i.status === 'Running').length },
    load:
      res.load?.average_1_min === undefined
        ? null
        : {
            avg1: res.load.average_1_min,
            avg5: res.load.average_5_min ?? 0,
            avg15: res.load.average_10_min ?? 0,
            processes: res.load.processes ?? null,
          },
    hardware: toHardware(res, server.environment),
  };
  await redis.set(cacheKey, JSON.stringify(dto), 'EX', 15);
  return dto;
}

/** 整理 Incus 资源信息中的硬件部分；虚拟网卡、可移除磁盘等不关心的条目被过滤 */
function toHardware(res: IncusResources, env: IncusServer['environment']): NodeHardwareDTO {
  const sockets = res.cpu.sockets ?? [];
  const cores = sockets.reduce((n, s) => n + (s.cores?.length ?? 0), 0);
  const first = sockets[0];
  // 虚拟机里磁盘转速与虚拟显卡没有参考意义：不判断 SSD，过滤 bochs / virtio 等虚拟显示设备
  const physical = !res.system?.type || res.system.type === 'physical';
  const virtualGpu = /bochs|virtio|cirrus|qxl|vmware|hyperv/i;
  return {
    system: res.system?.vendor || res.system?.product ? { vendor: res.system.vendor ?? '', product: res.system.product ?? '', type: res.system.type ?? '' } : null,
    os: env ? { name: env.os_name ?? '', version: env.os_version ?? '', kernel: env.kernel_version } : null,
    cpu: {
      model: first?.name ?? '',
      arch: res.cpu.architecture ?? '',
      sockets: sockets.length,
      cores: cores || res.cpu.total,
      threads: res.cpu.total,
      frequency: first?.frequency || null,
      turbo: first?.frequency_turbo || null,
    },
    gpus: (res.gpu?.cards ?? [])
      .filter((g) => !virtualGpu.test(`${g.driver ?? ''} ${g.product ?? ''}`))
      .map((g) => ({ vendor: g.vendor ?? '', product: g.product ?? g.driver ?? '' })),
    disks: (res.storage?.disks ?? [])
      .filter((d) => !d.removable && !d.read_only && (d.size ?? 0) > 0)
      .map((d) => ({ name: d.id, model: d.model ?? '', type: d.type ?? '', size: d.size ?? 0, ssd: !physical || d.rpm === undefined ? null : d.rpm === 0 })),
    nics: (res.network?.cards ?? []).flatMap((c) =>
      (c.ports ?? []).map((p) => ({
        name: p.id,
        vendor: c.vendor ?? '',
        product: c.product ?? c.driver ?? '',
        speed: p.link_detected && p.link_speed ? p.link_speed : null,
        link: !!p.link_detected,
      })),
    ),
  };
}

export async function listStoragePools(node: Node): Promise<StoragePoolDTO[]> {
  if (!node.endpoint) throw badRequest(t('node.notInstalled'));
  const incus = await getIncus(node);
  const pools = await incus.listStoragePools();
  return Promise.all(
    pools.map(async (p) => {
      let space: StoragePoolDTO['space'] = null;
      try {
        space = (await incus.getStoragePoolResources(p.name)).space;
      } catch {
        /* 某些驱动不支持统计 */
      }
      return {
        name: p.name,
        driver: p.driver,
        status: p.status,
        description: p.description ?? '',
        source: p.config.source ?? null,
        size: p.config.size ?? null,
        usedBy: p.used_by?.length ?? 0,
        space,
        isDefault: p.name === node.storagePool,
        usage: p.config[POOL_USAGE_KEY] === 'data' ? 'data' : 'root',
      };
    }),
  );
}

/** 存储池用途记在 Incus 存储池配置中（user.* 键由 Incus 原样保存） */
export const POOL_USAGE_KEY = 'user.paledove.usage';

export interface CreatePoolInput {
  /** create：新建（格式化磁盘或 loop 文件）；import：使用底层已存在、Incus 还不知道的存储 */
  mode: 'create' | 'import';
  name: string;
  driver: (typeof STORAGE_DRIVERS)[number];
  /** create：块设备或分区（dir 为目录，可空）；import：已有的 ZFS 池 / LVM 卷组 / Btrfs 路径 / 目录 */
  source?: string;
  /** create：使用 loop 文件代替物理磁盘 */
  loop?: boolean;
  size?: string;
  /** create：底层 ZFS 池 / LVM 卷组的名称，留空时与存储池同名 */
  poolName?: string;
  usage: PoolUsage;
  description?: string;
}

export async function createStoragePool(node: Node, input: CreatePoolInput): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(input.name)) throw badRequest(t('pool.nameInvalid'));
  const config: IncusConfig = { [POOL_USAGE_KEY]: input.usage };
  if (input.mode === 'import') {
    if (!input.source) throw badRequest(t('pool.importSource'));
    config.source = input.source;
    // 已有的卷组里可能还有其他逻辑卷，允许 Incus 继续使用
    if (input.driver === 'lvm') config['lvm.vg.force_reuse'] = 'true';
  } else if (input.driver === 'dir') {
    if (input.source) config.source = input.source;
  } else {
    if (input.loop) config.size = input.size || '50GiB';
    else if (input.source) config.source = input.source;
    else throw badRequest(t('pool.sourceRequired'));
    if (input.poolName && input.driver === 'zfs') config['zfs.pool_name'] = input.poolName;
    if (input.poolName && input.driver === 'lvm') config['lvm.vg_name'] = input.poolName;
  }
  const incus = await getIncus(node);
  await incus.createStoragePool({ name: input.name, driver: input.driver, description: input.description ?? '', config });
}

export async function deleteStoragePool(node: Node, name: string): Promise<void> {
  if (name === node.storagePool) throw badRequest(t('pool.isDefault'));
  const incus = await getIncus(node);
  await incus.deleteStoragePool(name);
}

import { X509Certificate } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isIP } from 'node:net';
import { NETWORK_MODES, POOL_USAGES, PUBLIC_NIC_MODES, STORAGE_DRIVERS, TRAFFIC_MODES, type InstallCommandDTO, type NodeResourcesDTO, type PanelCertificateDTO, type PanelCertificateStatusDTO } from '../../shared/index.ts';
import { getClientCertificate, getClientCertificatePaths, type ClientCertificate } from '../../incus/certs.ts';
import { buildEndpoint, endpointAddress, normalizeFingerprint } from '../../incus/client.ts';
import { invalidateIncus } from '../../incus/index.ts';
import { AppError, badRequest, conflict, errorMessage } from '../../lib/errors.ts';
import { adminGuard, ensureFound, idParam, logActivity, panelUrl, parse, parsePatch, requireAdmin } from '../../lib/http.ts';
import { expandIpInput, formatIpv6Cidr, isIPv4, parseCidr, parseIpv6Cidr } from '../../lib/ip.ts';
import { prisma, Prisma, skipDuplicates, type Node } from '../../lib/prisma.ts';
import { currentLocale, m, t } from '../../i18n/index.ts';
import { isMockNode, issueCaddyToken, markMockCaddyReady, syncSites, testCaddy } from '../../services/gateway.ts';
import {
  connectNode,
  countryName,
  isAutoRegion,
  createStoragePool,
  deleteStoragePool,
  fetchServerFingerprint,
  getNodeResources,
  issueInstallToken,
  listStoragePools,
  verifyNode,
} from '../../services/nodes.ts';
import { clearHostReport, getHostReport, issueAgentInstallToken } from '../../services/agent/agent.ts';
import { agentManifest } from '../../services/agent/agent-binary.ts';
import { getPingResults, requestPingRun } from '../../services/agent/ping.ts';
import { pingObjectEnabled, syncPingObject } from '../../services/ping-settings.ts';
import { getSetting } from '../../lib/settings.ts';
import { adminNodeEgress, bumpEgressVersion, createEgress, deleteEgress, egressInputSchema, updateEgress } from '../../services/egress.ts';
import { clearNodeBandwidth, getNodeBandwidth } from '../../services/bandwidth.ts';
import { getNodeUsage } from '../../services/metrics.ts';
import { invalidateCache } from '../../lib/cache.ts';
import { toIpAddress, toNode } from '../../services/serializers.ts';

const ipv4 = z.string().trim().refine(isIPv4, m('v.ipv4'));
const optionalIpv4 = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || '')
  .refine((v) => v === '' || isIPv4(v), m('v.ipv4'));

const optionalIpv6 = z
  .string()
  .trim()
  .optional()
  .transform((v) => v || '')
  .refine((v) => v === '' || isIP(v) === 6, m('v.ipv6'));

const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** 添加宿主机时填写的字段 */
const hostFields = {
  name: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/, m('v.nodeName')),
  description: z.string().trim().max(100).default(''),
  /** IPv4、IPv6 或域名；mock:// 为演示节点 */
  address: z
    .string()
    .trim()
    .refine((v) => isIP(v) !== 0 || HOSTNAME.test(v) || /^mock:\/\/\w+$/.test(v), m('v.address')),
  apiPort: z.number().int().min(1).max(65535).default(8443),
  country: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{2}$/.test(v), m('v.country')),
  networkMode: z.enum(NETWORK_MODES).default('NAT'),
  publicIp: optionalIpv4,
  publicIpv6: optionalIpv6,
  natListenAddress: optionalIpv4,
  natListenAddressV6: optionalIpv6,
  ipv6Subnet: z
    .string()
    .trim()
    .optional()
    .transform((v, ctx) => {
      if (!v) return '';
      try {
        const c = parseIpv6Cidr(v);
        if (c.prefix <= 124) return formatIpv6Cidr(c);
      } catch {
        /* 下方统一报错 */
      }
      ctx.addIssue({ code: 'custom', message: m('v.ipv6Subnet') });
      return z.NEVER;
    }),
  ipv6Parent: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || '')
    .refine((v) => v === '' || /^[A-Za-z0-9_.@-]{1,15}$/.test(v), m('v.ifaceName')),
  portRangeStart: z.number().int().min(1024).max(65535).default(20000),
  portRangeEnd: z.number().int().min(1024).max(65535).default(60000),
  publicNicMode: z.enum(PUBLIC_NIC_MODES).default('ROUTED'),
  publicNicParent: z.string().trim().optional().nullable().transform((v) => v || null),
  dnsServers: z.string().trim().default('1.1.1.1,8.8.8.8'),
};

/** 其余字段在编辑页面修改，添加时使用默认值 */
const advancedFields = {
  /** 展示给用户的地区名，留空时取国家或地区的名称 */
  region: z.string().trim().max(64).optional(),
  project: z.string().trim().min(1).default('default'),
  storagePool: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/, m('pool.nameInvalid')).default('default'),
  profile: z.string().trim().min(1).default('default'),
  natNetwork: z.string().trim().min(1).default('incusbr0'),
  maxInstances: z.number().int().min(0).default(100),
  /** 节点测试：由 Agent 每小时向国内三网目标 Ping，结果展示在购买页 */
  pingEnabled: z.boolean().default(false),
  /** 宿主机一键安装脚本选项 */
  installAgent: z.boolean().default(true),
  installFirewall: z.boolean().default(false),
  enableFirewallRules: z.boolean().default(false),
  /** 宿主机公告：显示在该宿主机上全部实例的实例管理页面 */
  announcement: z.string().trim().max(2000).default(''),
  requireRealName: z.boolean().default(false),
  /** null = 使用面板全部默认镜像 */
  imageIds: z.array(z.number().int().positive()).max(1000).nullable().default(null),
  trafficLimit: z.number().int().min(0).default(0),
  trafficResetDay: z.number().int().min(1).max(28).default(1),
  trafficMode: z.enum(TRAFFIC_MODES).default('BOTH'),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  // 安装脚本参数
  storageDriver: z.enum(STORAGE_DRIVERS).default('btrfs'),
  storageSource: z.string().trim().max(200).optional().nullable().transform((v) => v || null),
  storageSize: z.string().trim().regex(/^\d+(\.\d+)?\s*(MiB|GiB|TiB|MB|GB|TB)$/i).default('100GiB'),
  natCidrInstall: z
    .string()
    .trim()
    .default('10.88.0.1/16')
    .refine((v) => {
      try {
        const c = parseCidr(v);
        return c.prefix >= 8 && c.prefix <= 28;
      } catch {
        return false;
      }
    }, m('v.cidr')),
  caddyAdminPort: z.number().int().min(1).max(65535).default(2021),
  serverFingerprint: z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => normalizeFingerprint(v)),
};

async function nodeStats(ids: number[]) {
  const [inst, ipTotal, ipUsed, sites] = await Promise.all([
    prisma.instance.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids }, status: { not: 'DELETED' } }, _count: { _all: true } }),
    prisma.ipAddress.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids } }, _count: { _all: true } }),
    prisma.ipAddress.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids }, instanceId: { not: null } }, _count: { _all: true } }),
    prisma.proxySite.groupBy({ by: ['nodeId'], where: { nodeId: { in: ids } }, _count: { _all: true } }),
  ]);
  return (id: number) => ({
    instanceCount: inst.find((r) => r.nodeId === id)?._count._all ?? 0,
    ipTotal: ipTotal.find((r) => r.nodeId === id)?._count._all ?? 0,
    ipUsed: ipUsed.find((r) => r.nodeId === id)?._count._all ?? 0,
    siteCount: sites.find((r) => r.nodeId === id)?._count._all ?? 0,
  });
}

async function nodeDto(node: Node) {
  return toNode(node, (await nodeStats([node.id]))(node.id));
}

async function installCommand(req: FastifyRequest, node: Node, regenerate = false): Promise<InstallCommandDTO> {
  const { token, expiresAt } = await issueInstallToken(node.id, regenerate);
  const scriptUrl = `${panelUrl(req)}/api/agent/nodes/${token}/install.sh?lang=${currentLocale()}`;
  return {
    command: `curl -fsSL '${scriptUrl}' | bash`,
    scriptUrl,
    expiresAt: expiresAt.toISOString(),
    installOptions: { agent: node.installAgent, firewall: node.installFirewall, firewallRules: node.enableFirewallRules },
  };
}

const regenerateBody = z.object({ regenerate: z.boolean().optional() });

const loadNode = async (id: number) => ensureFound(await prisma.node.findUnique({ where: { id } }), t('node.notFound'));

/** 证书信息（不含私钥）；公钥描述为 RSA 位数或 EC 曲线名 */
function certificateDto(cert: ClientCertificate): PanelCertificateDTO {
  const x509 = new X509Certificate(cert.cert);
  const details = x509.publicKey.asymmetricKeyDetails;
  const size = details?.modulusLength ?? details?.namedCurve;
  return {
    certificate: cert.cert,
    fingerprint: cert.fingerprint,
    subject: x509.subject.split('\n').join(', '),
    validFrom: new Date(x509.validFrom).toISOString(),
    validTo: new Date(x509.validTo).toISOString(),
    keyAlgorithm: `${(x509.publicKey.asymmetricKeyType ?? '').toUpperCase()}${size ? ` ${size}` : ''}`,
  };
}

export default async function adminNodeRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  // 修改成功后，首页与购买页使用的在售目录缓存（Redis）立即失效
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && reply.statusCode < 400) await invalidateCache('catalog');
  });

  // 证书只允许开发者在服务器文件目录部署；后台只读状态与公钥，不接收或导出私钥。
  app.get('/api/admin/certificate', async (_req, reply): Promise<PanelCertificateStatusDTO> => {
    reply.header('cache-control', 'no-store');
    const paths = getClientCertificatePaths();
    try {
      return { ...paths, certificate: certificateDto(await getClientCertificate()), error: null };
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'INCUS_CERTIFICATE_UNAVAILABLE') throw err;
      return { ...paths, certificate: null, error: err.message };
    }
  });

  app.post('/api/admin/nodes/fingerprint', async (req) => {
    const body = parse(z.object({ endpoint: z.string().trim().url() }), req.body);
    return { fingerprint: await fetchServerFingerprint(body.endpoint) };
  });

  app.get('/api/admin/nodes', async () => {
    const nodes = await prisma.node.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const stats = await nodeStats(nodes.map((n) => n.id));
    return nodes.map((n) => toNode(n, stats(n.id)));
  });

  app.get('/api/admin/nodes/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    return nodeDto(await loadNode(id));
  });

  /** 添加宿主机：保存信息并生成安装脚本，宿主机执行脚本后由回调或「验证并连接」完成接入 */
  app.post('/api/admin/nodes', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object({ ...hostFields, ...advancedFields }), req.body);
    if (body.portRangeEnd <= body.portRangeStart) throw badRequest(t('node.badPortRange'));
    const { address, region, imageIds, ...data } = body;
    const node = await prisma.node.create({
      data: {
        ...data,
        enableFirewallRules: data.installFirewall && data.enableFirewallRules,
        imageIds: imageIds ? [...new Set(imageIds)] : Prisma.DbNull,
        region: region || countryName(data.country, currentLocale()),
        endpoint: buildEndpoint(address, data.apiPort),
        status: 'PENDING',
      },
    });
    if (node.pingEnabled) await syncPingObject(node.id, true);
    await logActivity(req, admin.id, 'admin.node_create', `${node.name} ${node.endpoint}`);
    return { node: await nodeDto(node), install: await installCommand(req, node) };
  });

  // 查看安装命令：沿用有效期内的令牌；body.regenerate 为 true 时签发新令牌（之前的命令失效）
  app.post('/api/admin/nodes/:id/install-command', async (req) => {
    const { id } = parse(idParam, req.params);
    const { regenerate } = parse(regenerateBody, req.body ?? {});
    return installCommand(req, await loadNode(id), regenerate);
  });

  // 安装脚本执行完成后验证连接；尚未收到脚本回调时，首次连接记录服务端证书指纹
  app.post('/api/admin/nodes/:id/verify', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    const result = await verifyNode(node);
    await logActivity(req, admin.id, 'admin.node_verify', node.name);
    return { node: await nodeDto(await loadNode(id)), result };
  });

  app.patch('/api/admin/nodes/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parsePatch({ ...hostFields, ...advancedFields }, req.body);
    const existing = await loadNode(id);
    const start = body.portRangeStart ?? existing.portRangeStart;
    const end = body.portRangeEnd ?? existing.portRangeEnd;
    if (end <= start) throw badRequest(t('node.badPortRange'));
    const { address, region, imageIds, ...rest } = body;
    const data: Prisma.NodeUpdateInput = { ...rest };
    if (rest.installFirewall === false || (rest.enableFirewallRules === true && !(rest.installFirewall ?? existing.installFirewall))) {
      data.enableFirewallRules = false;
    }
    if (imageIds !== undefined) data.imageIds = imageIds ? [...new Set(imageIds)] : Prisma.DbNull;
    const country = body.country ?? existing.country;
    if (region !== undefined) data.region = region || countryName(country, currentLocale());
    // 改了国家而地区名仍是旧国家自动生成的名称（表单原样提交回来）时，跟着换成新国家的名称
    if (country !== existing.country && (region === undefined || region === existing.region) && isAutoRegion(existing.region, existing.country)) {
      data.region = countryName(country, currentLocale());
    }
    // 连接地址或 API 端口变化时重新生成端点；换了地址需要重新确认服务端证书
    const oldAddress = endpointAddress(existing.endpoint);
    const endpoint = buildEndpoint(address ?? oldAddress, body.apiPort ?? existing.apiPort);
    if (endpoint !== existing.endpoint && (address !== undefined || body.apiPort !== undefined)) {
      data.endpoint = endpoint;
      const fingerprintKept = body.serverFingerprint === undefined || body.serverFingerprint === existing.serverFingerprint;
      if (address !== undefined && address !== oldAddress && fingerprintKept) data.serverFingerprint = null;
    }
    // 修改网络后需重新同步网段
    if (body.natNetwork && body.natNetwork !== existing.natNetwork) data.natCidr = null;
    const node = await prisma.node.update({ where: { id }, data });
    if (body.pingEnabled !== undefined && body.pingEnabled !== existing.pingEnabled) await syncPingObject(id, node.pingEnabled);
    invalidateIncus(id);
    await logActivity(req, admin.id, 'admin.node_update', node.name);
    return nodeDto(node);
  });

  app.delete('/api/admin/nodes/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const active = await prisma.instance.count({ where: { nodeId: id, status: { not: 'DELETED' } } });
    if (active > 0) throw conflict(t('node.hasInstances', { count: active }));
    await prisma.instance.deleteMany({ where: { nodeId: id, status: 'DELETED' } });
    const node = await prisma.node.delete({ where: { id } });
    invalidateIncus(id);
    await clearNodeBandwidth(id);
    await clearHostReport(id);
    await logActivity(req, admin.id, 'admin.node_delete', node.name);
    return { ok: true };
  });

  app.post('/api/admin/nodes/:id/connect', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ trustToken: z.string().trim().optional() }), req.body);
    return connectNode(await loadNode(id), body.trustToken || undefined);
  });

  app.get('/api/admin/nodes/:id/bandwidth', async (req) => {
    const { id } = parse(idParam, req.params);
    return getNodeBandwidth(await loadNode(id));
  });

  app.get('/api/admin/nodes/:id/usage', async (req) => {
    const { id } = parse(idParam, req.params);
    return getNodeUsage(await loadNode(id));
  });

  // 宿主机上报的 CPU 等数据不缓存，与 Incus 资源信息合并返回
  app.get('/api/admin/nodes/:id/resources', async (req): Promise<NodeResourcesDTO> => {
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    const manifest = agentManifest();
    return { ...(await getNodeResources(node)), host: await getHostReport(id), agentInstalled: !!node.agentTokenHash,
      agentLatestVersion: Object.keys(manifest.files).length ? manifest.version : null };
  });

  // 宿主机 Agent 的安装命令（参考 incudal）：每次生成都签发新的一次性安装令牌（30 分钟内有效、只能使用一次），
  // 安装脚本是通用的、不含密钥，令牌通过环境变量传入；安装时宿主机生成新的 Agent 密钥
  app.post('/api/admin/nodes/:id/agent-command', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    const { token, expiresAt } = await issueAgentInstallToken(id);
    await logActivity(req, admin.id, 'admin.agent_install', node.name);
    return { command: `curl -fsSL '${panelUrl(req)}/api/agent/install.sh' | env PALEDOVE_INSTALL_TOKEN='${token}' bash`, expiresAt: expiresAt.toISOString() };
  });

  // ───────── 智能分流 ─────────

  /** 出口列表（密钥不返回）、开关与 Agent 执行情况 */
  app.get('/api/admin/nodes/:id/egress', async (req) => {
    const { id } = parse(idParam, req.params);
    return adminNodeEgress(await loadNode(id));
  });

  /** 开启 / 关闭智能分流；关闭后 Agent 撤销全部隧道与转发，实例的选择保留 */
  app.put('/api/admin/nodes/:id/egress/enabled', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const node = await prisma.node.update({ where: { id: (await loadNode(id)).id }, data: { egressEnabled: enabled } });
    await bumpEgressVersion(id);
    await logActivity(req, admin.id, 'admin.node_egress_toggle', `${node.name} ${enabled ? 'on' : 'off'}`);
    return adminNodeEgress(node);
  });

  app.post('/api/admin/nodes/:id/egress', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    const body = parse(egressInputSchema, req.body);
    const row = await createEgress(node, body);
    await logActivity(req, admin.id, 'admin.node_egress_create', `${node.name} ${row.type} ${row.name}`);
    return adminNodeEgress(node);
  });

  app.put('/api/admin/nodes/:id/egress/:eid', async (req) => {
    const admin = requireAdmin(req);
    const { id, eid } = parse(z.object({ id: z.coerce.number().int().positive(), eid: z.coerce.number().int().positive() }), req.params);
    const node = await loadNode(id);
    const body = parse(egressInputSchema, req.body);
    const row = await updateEgress(node, eid, body);
    await logActivity(req, admin.id, 'admin.node_egress_update', `${node.name} ${row.type} ${row.name}`);
    return adminNodeEgress(node);
  });

  app.delete('/api/admin/nodes/:id/egress/:eid', async (req) => {
    const admin = requireAdmin(req);
    const { id, eid } = parse(z.object({ id: z.coerce.number().int().positive(), eid: z.coerce.number().int().positive() }), req.params);
    const node = await loadNode(id);
    await deleteEgress(node, eid);
    await logActivity(req, admin.id, 'admin.node_egress_delete', `${node.name} #${eid}`);
    return adminNodeEgress(node);
  });

  // ───────── 节点测试 ─────────

  app.get('/api/admin/nodes/:id/ping', async (req) => {
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    const ping = await getPingResults(id);
    return { enabled: pingObjectEnabled(await getSetting('ping'), node), result: ping ? { label: node.name, country: node.country, ...ping } : null };
  });

  // 立即测试：Agent 下一次上报（约 10 秒内）时开始，约 1 分钟后出结果
  app.post('/api/admin/nodes/:id/ping-run', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    if (!node.pingEnabled) throw badRequest(t('ping.disabled'));
    await requestPingRun(id);
    await logActivity(req, admin.id, 'admin.node_ping_run', node.name);
    return { ok: true };
  });

  // ───────── 存储池 ─────────

  app.get('/api/admin/nodes/:id/storage-pools', async (req) => {
    const { id } = parse(idParam, req.params);
    return listStoragePools(await loadNode(id));
  });

  app.post('/api/admin/nodes/:id/storage-pools', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        mode: z.enum(['create', 'import']).default('create'),
        name: z.string().trim().min(1, m('pool.nameInvalid')),
        driver: z.enum(STORAGE_DRIVERS),
        source: z.string().trim().max(200).optional(),
        loop: z.boolean().default(false),
        poolName: z
          .string()
          .trim()
          .max(64)
          .optional()
          .refine((v) => !v || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v), m('pool.nameInvalid')),
        usage: z.enum(POOL_USAGES).default('root'),
        size: z.string().trim().regex(/^\d+(\.\d+)?\s*(MiB|GiB|TiB|MB|GB|TB)$/i).optional().or(z.literal('').transform(() => undefined)),
        description: z.string().trim().max(200).optional(),
        makeDefault: z.boolean().default(false),
      }),
      req.body,
    );
    const node = await loadNode(id);
    await createStoragePool(node, body);
    // 只有系统盘用途的存储池可以设为默认
    if (body.makeDefault && body.usage === 'root') await prisma.node.update({ where: { id }, data: { storagePool: body.name } });
    await logActivity(req, admin.id, 'admin.pool_create', `${node.name} ${body.name} (${body.driver}, ${body.mode})`);
    return { ok: true };
  });

  app.post('/api/admin/nodes/:id/storage-pools/:name/default', async (req) => {
    const { id, name } = parse(z.object({ id: z.coerce.number().int(), name: z.string().min(1) }), req.params);
    const node = await loadNode(id);
    const pools = await listStoragePools(node);
    const pool = pools.find((p) => p.name === name);
    if (!pool) throw badRequest(t('pool.notFound'));
    if (pool.usage === 'data') throw badRequest(t('pool.dataNotDefault'));
    await prisma.node.update({ where: { id }, data: { storagePool: name } });
    return { ok: true };
  });

  app.delete('/api/admin/nodes/:id/storage-pools/:name', async (req) => {
    const admin = requireAdmin(req);
    const { id, name } = parse(z.object({ id: z.coerce.number().int(), name: z.string().min(1) }), req.params);
    const node = await loadNode(id);
    await deleteStoragePool(node, name);
    await logActivity(req, admin.id, 'admin.pool_delete', `${node.name} ${name}`);
    return { ok: true };
  });

  // ───────── Caddy ─────────

  app.post('/api/admin/nodes/:id/caddy/install-command', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const node = await loadNode(id);
    if (!node.publicIp) throw badRequest(t('node.notInstalled'));
    if (isMockNode(node)) {
      await markMockCaddyReady(node.id);
      return { command: t('caddy.mockReady'), scriptUrl: '', expiresAt: new Date().toISOString() } satisfies InstallCommandDTO;
    }
    const { regenerate } = parse(regenerateBody, req.body ?? {});
    const { token, expiresAt } = await issueCaddyToken(node.id, regenerate);
    const scriptUrl = `${panelUrl(req)}/api/agent/caddy/${token}/install.sh?lang=${currentLocale()}`;
    await logActivity(req, admin.id, 'admin.caddy_install', node.name);
    return { command: `curl -fsSL '${scriptUrl}' | bash`, scriptUrl, expiresAt: expiresAt.toISOString() } satisfies InstallCommandDTO;
  });

  app.post('/api/admin/nodes/:id/caddy/test', async (req) => {
    const { id } = parse(idParam, req.params);
    await testCaddy(await loadNode(id));
    return { ok: true };
  });

  app.post('/api/admin/nodes/:id/caddy/sync', async (req) => {
    const { id } = parse(idParam, req.params);
    await syncSites(id);
    return { ok: true };
  });

  // ───────── IP 地址池 ─────────

  app.get('/api/admin/nodes/:id/ips', async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await prisma.ipAddress.findMany({
      where: { nodeId: id },
      include: { instance: { select: { id: true, name: true, hostname: true } } },
      orderBy: { id: 'asc' },
    });
    return rows.map(toIpAddress);
  });

  app.post('/api/admin/nodes/:id/ips', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    await loadNode(id);
    const body = parse(
      z.object({
        input: z.string().min(1, m('v.ipRequired')),
        prefix: z.number().int().min(1).max(32).default(32),
        gateway: ipv4.optional().or(z.literal('').transform(() => undefined)),
        remark: z.string().trim().max(100).optional(),
      }),
      req.body,
    );
    let ips: string[];
    try {
      ips = expandIpInput(body.input);
    } catch (err) {
      throw badRequest(errorMessage(err));
    }
    // 先排除已存在的地址（SQLite 不支持 skipDuplicates），并发插入的重复仍由 skipDuplicates 兜底
    const existing = await prisma.ipAddress.findMany({ where: { address: { in: ips } }, select: { address: true } });
    const taken = new Set(existing.map((e) => e.address));
    const res = await prisma.ipAddress.createMany({
      data: ips
        .filter((address) => !taken.has(address))
        .map((address) => ({ nodeId: id, address, prefix: body.prefix, gateway: body.gateway ?? null, remark: body.remark || null })),
      ...skipDuplicates,
    });
    await logActivity(req, admin.id, 'admin.ip_add', `node #${id} +${res.count}`);
    return { added: res.count, skipped: ips.length - res.count };
  });

  app.patch('/api/admin/ips/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        disabled: z.boolean().optional(),
        remark: z.string().trim().max(100).nullable().optional(),
        gateway: ipv4.nullable().optional(),
        prefix: z.number().int().min(1).max(32).optional(),
      }),
      req.body,
    );
    const ip = await prisma.ipAddress.update({
      where: { id },
      data: body,
      include: { instance: { select: { id: true, name: true, hostname: true } } },
    });
    return toIpAddress(ip);
  });

  app.delete('/api/admin/ips/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const ip = ensureFound(await prisma.ipAddress.findUnique({ where: { id } }), t('ip.notFound'));
    if (ip.instanceId) throw conflict(t('ip.inUse'));
    await prisma.ipAddress.delete({ where: { id } });
    return { ok: true };
  });
}

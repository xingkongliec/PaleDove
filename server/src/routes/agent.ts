import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logActivity, panelUrl, parse } from '../lib/http.ts';
import { isIPv4 } from '../lib/ip.ts';
import { currentLocale, t } from '../i18n/index.ts';
import { normalizeLocale } from '../shared/index.ts';
import { initialCaddyConfig, nodeByCaddyToken, registerCaddy } from '../services/gateway.ts';
import { renderAgentInstallScript, renderCaddyInstallScript } from '../services/agent/install-script.ts';
import { AGENT_REPORT_INTERVAL, consumeAgentInstallToken, issueAgentInstallToken, nodeByAgentToken, saveHostReport, signResponse, verifySignedRequest, vmLimitsText } from '../services/agent/agent.ts';
import { pingConfig, pingTargets, savePingResults } from '../services/agent/ping.ts';
import { instanceWatch, saveInstanceStates } from '../services/agent/instance-stats.ts';
import { agentListingJobs, saveAgentListingPing } from '../services/market-ping.ts';
import { agentIpv4Checks, saveAgentIpv4Check } from '../services/agent/ipv4-check.ts';
import { agentEgressConfig, egressVersion, saveEgressStatus } from '../services/egress.ts';
import { AGENT_ARCHES, agentBinaryName, agentManifest, downloadAgentBinary, loadAgentManifest, upgradeInstruction } from '../services/agent/agent-binary.ts';
import { agentReleaseVersion } from '../services/agent/agent-release.ts';
import { unauthorized } from '../lib/errors.ts';
import { nodeByInstallToken, nodeInstallScript, registerNode } from '../services/nodes.ts';

/**
 * 宿主机安装脚本与宿主机 Agent 使用的接口（不依赖登录会话）：
 *  - GET  /api/agent/nodes/:token/install.sh   下载节点安装脚本（节点安装令牌，接入后作废）
 *  - POST /api/agent/nodes/register            安装完成后回调
 *  - GET  /api/agent/caddy/:token/install.sh   下载 Caddy 安装脚本（Caddy 安装令牌，接入后作废）
 *  - POST /api/agent/caddy/register            Caddy 安装完成后回调
 *  - GET  /api/agent/install.sh                通用 Agent 安装脚本（不含密钥）
 *  - GET  /api/agent/install-config            用一次性安装令牌换取 Agent 配置
 *  - GET  /api/agent/manifest.json             Agent 版本清单；GET /api/agent/binary/:arch 下载二进制
 *  - POST /api/agent/nodes/report              Agent 上报（签名请求），回复上报间隔与升级指令
 *  - GET  /api/agent/nodes/vm-limits           Agent 拉取虚拟机 CPU 限制
 *  - GET  /api/agent/nodes/ping-targets        节点测试：拉取目标；POST /api/agent/nodes/ping-results 回传结果
 *  - POST /api/agent/nodes/listing-ping        上架拨测：回传结果（任务在上报回复的 listingPings 里下发）
 *  - POST /api/agent/nodes/ipv4-check          切换机房即时 ICMP：回传结果（任务在 ipv4Checks 里下发）
 *  - POST /api/agent/nodes/instance-states     实例资源上报：正在被查看的实例的实时状态，回复续期后的查看列表
 *  - GET  /api/agent/nodes/egress              智能分流：拉取出口与实例分流配置；POST /api/agent/nodes/egress-status 回报状态
 */
const usageSchema = z.object({ total: z.number().min(0), used: z.number().min(0) });

/** 保留原始请求体：Agent 请求签名包含请求体的 sha256 */
type RawBodyRequest = FastifyRequest & { rawBody?: string };

function sendInstallScript(reply: FastifyReply, script: string) {
  return reply
    .header('cache-control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    .header('pragma', 'no-cache')
    .header('expires', '0')
    .type('text/x-shellscript; charset=utf-8')
    .send(script);
}

export default async function agentRoutes(app: FastifyInstance) {
  // 只在本插件（Agent 接口）内生效：解析 JSON 的同时保留原始请求体
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as RawBodyRequest).rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });
  const limit = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const tokenParam = z.object({ token: z.string().min(16).max(128) });
  // 脚本地址携带 ?lang=，脚本回调时以该语言返回提示
  const scriptLocale = (query: unknown) => normalizeLocale((query as { lang?: string } | null)?.lang) ?? currentLocale();

  app.get('/api/agent/nodes/:token/install.sh', limit, async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const node = await nodeByInstallToken(token);
    const script = await nodeInstallScript(node, token, panelUrl(req), scriptLocale(req.query));
    return sendInstallScript(reply, script);
  });

  app.post('/api/agent/nodes/register', limit, async (req) => {
    const body = parse(
      z.object({
        token: z.string().min(16).max(128),
        fingerprint: z.string().regex(/^[0-9a-fA-F:]{64,95}$/),
        publicIp: z.string().trim().refine((v) => isIPv4(v) || v.includes(':')),
        port: z.number().int().min(1).max(65535),
        hostname: z.string().max(255).optional(),
        version: z.string().max(64).optional(),
        ipv6Address: z.string().max(64).optional(),
        ipv6Interface: z.string().max(32).optional(),
      }),
      req.body,
    );
    const { node, result, error, ipv6 } = await registerNode(body);
    await logActivity(req, null, 'agent.node_register', `${node.name} ${node.endpoint} ${error ?? 'ok'}`);
    const detected = ipv6 ? `\n${t('install.ipv6Detected', { subnet: ipv6.ipv6Subnet, iface: ipv6.ipv6Parent || '-' })}` : '';
    if (error) return { ok: false, message: t('install.registerFailed', { name: node.name, message: error }) + detected };
    const warnings = result?.warnings.length ? `\n${result.warnings.map((w) => `  - ${w}`).join('\n')}` : '';
    return { ok: true, message: `${t('install.registered', { name: node.name, version: result?.version ?? '' })}${detected}${warnings}` };
  });

  // ───────── 宿主机 Agent（参考 incudal）─────────

  // 通用安装脚本：不含任何密钥，配合安装命令里的一次性令牌使用
  app.get('/api/agent/install.sh', limit, async (req, reply) => {
    return sendInstallScript(reply, renderAgentInstallScript({ panelUrl: panelUrl(req) }));
  });

  // 旧版安装命令（地址里带长期上报令牌）：令牌有效时签发一次性安装令牌并写入脚本，继续可用
  app.get('/api/agent/reporter/:token/install.sh', limit, async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const node = await nodeByAgentToken(token);
    const install = await issueAgentInstallToken(node.id);
    const script = renderAgentInstallScript({ panelUrl: panelUrl(req), installToken: install.token });
    return sendInstallScript(reply, script);
  });

  // 用一次性安装令牌换取 Agent 配置（令牌放在请求头里，不进入访问日志）；令牌随即作废，宿主机生成新的 Agent 密钥
  app.get('/api/agent/install-config', limit, async (req, reply) => {
    const token = String(req.headers['x-paledove-install-token'] ?? '').trim();
    if (!/^pdi_[A-Za-z0-9_-]{16,64}$/.test(token)) throw unauthorized(t('agent.installTokenInvalid'));
    const { node, secret } = await consumeAgentInstallToken(token);
    await logActivity(req, null, 'agent.install', node.name);
    const env = [`PANEL_URL=${panelUrl(req)}`, `NODE_ID=${node.id}`, `AGENT_SECRET=${secret}`].join('\n');
    return reply.header('cache-control', 'no-store').type('text/plain; charset=utf-8').send(`${env}\n`);
  });

  // 版本清单：各架构二进制的文件名、sha256 与大小；?format=text 为每行「架构 sha256 大小」，供安装脚本解析
  app.get('/api/agent/manifest.json', async (req, reply) => {
    const m = await loadAgentManifest();
    reply.header('cache-control', 'no-store');
    if ((req.query as { format?: string } | null)?.format === 'text') {
      // 旧安装脚本仍读取三列；新脚本显式请求第四列以固定下载版本。
      const pinned = (req.query as { version?: string }).version === '1';
      const lines = Object.entries(m.files).map(([arch, f]) => `${arch} ${f!.sha256} ${f!.size}${pinned ? ` ${m.version}` : ''}`);
      return reply.type('text/plain; charset=utf-8').send(`${lines.join('\n')}\n`);
    }
    return m;
  });

  // 下载 Agent 二进制（不含密钥，公开下载；安装脚本与自动升级都会校验 sha256 与大小）
  app.get('/api/agent/binary/:arch', limit, async (req, reply) => {
    const { arch } = parse(z.object({ arch: z.enum(AGENT_ARCHES) }), req.params);
    const query = parse(z.object({ v: agentReleaseVersion.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }), req.query);
    const data = await downloadAgentBinary(arch, query.v, query.sha256);
    return reply
      .header('cache-control', 'no-store')
      .header('content-length', data.length)
      .header('content-disposition', `attachment; filename="${agentBinaryName(arch)}"`)
      .type('application/octet-stream')
      .send(data);
  });

  /**
   * Agent 请求认证：Go 版 Agent 使用 HMAC 签名（x-paledove-node / -timestamp / -nonce / -signature），
   * 旧版 bash 上报程序使用 Bearer 令牌。签名请求返回密钥与随机数，用于回复签名
   */
  const authenticate = async (req: FastifyRequest) => {
    const h = req.headers;
    if (h['x-paledove-signature']) {
      const signed = await verifySignedRequest(
        { node: h['x-paledove-node'] as string, timestamp: h['x-paledove-timestamp'] as string, nonce: h['x-paledove-nonce'] as string, signature: h['x-paledove-signature'] as string },
        req.method,
        req.raw.url ?? req.url,
        (req as RawBodyRequest).rawBody ?? '',
      );
      return { node: signed.node, secret: signed.secret as string | null, nonce: h['x-paledove-nonce'] as string | null };
    }
    const token = /^Bearer\s+(\S+)$/i.exec(h.authorization ?? '')?.[1];
    if (!token) throw unauthorized(t('agent.tokenInvalid'));
    return { node: await nodeByAgentToken(token), secret: null as string | null, nonce: null as string | null };
  };
  /** 签名请求的回复同样签名，Agent 校验后才执行升级指令 */
  const signedReply = (reply: FastifyReply, auth: { secret: string | null; nonce: string | null }, payload: unknown, type = 'application/json; charset=utf-8') => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (auth.secret && auth.nonce) reply.header('x-paledove-signature', signResponse(auth.secret, auth.nonce, body));
    return reply.header('cache-control', 'no-store').type(type).send(body);
  };

  // Agent 按回复的间隔上报（默认 10 秒）；回复上报间隔、最新版本，以及需要时的自动升级指令
  app.post('/api/agent/nodes/report', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    const node = auth.node;
    const body = parse(
      z.object({
        cpu: z.number().min(0).max(100),
        load: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]),
        uptime: z.number().min(0),
        version: z.number().int().min(1).max(1000).optional(),
        // 以下为 Go 版 Agent（协议 3）上报的完整状态
        release: z.string().max(32).optional(),
        cores: z.number().int().min(0).max(4096).optional(),
        memory: usageSchema.optional(),
        swap: usageSchema.optional(),
        disk: usageSchema.extend({ path: z.string().max(255) }).optional(),
        processes: z.number().int().min(0).max(10_000_000).optional(),
        hostname: z.string().max(255).optional(),
        os: z.string().max(255).optional(),
        kernel: z.string().max(255).optional(),
        arch: z.string().max(32).optional(),
        incus: z.object({ available: z.boolean(), socket: z.string().max(255).optional(), version: z.string().max(64).optional(), error: z.string().max(500).optional() }).optional(),
        capabilities: z.array(z.string().max(64)).max(32).optional(),
      }),
      req.body,
    );
    await saveHostReport(node.id, body, req.ip);
    const latest = agentManifest().version;
    // 自动升级只发给签名认证的 Go 版 Agent（旧版 bash 上报程序需要重新安装）
    const upgrade = auth.secret ? upgradeInstruction(panelUrl(req), body.release, body.arch) : null;
    // 节点测试（启用时）：间隔、目标摘要、是否立即测试
    const ping = auth.secret ? await pingConfig(node) : undefined;
    // 实例资源上报：有实例正在被查看时下发列表（只发给签名认证且支持该能力的 Agent）
    const instances = auth.secret && body.capabilities?.includes('instance-stats') ? await instanceWatch(node.id) : null;
    // 智能分流：只下发配置版本，变化时 Agent 再拉取完整配置（只发给签名认证且支持该能力的 Agent）
    const egress = auth.secret && body.capabilities?.includes('egress') ? { version: await egressVersion(node.id) } : null;
    // 上架拨测：交易市场上架时的待执行任务（只发给签名认证且支持该能力的 Agent）
    const listingPings = auth.secret && body.capabilities?.includes('listing-ping') ? await agentListingJobs(node.id) : [];
    const ipv4Checks = auth.secret && body.capabilities?.includes('ipv4-check') ? await agentIpv4Checks(node.id) : [];
    return signedReply(reply, auth, {
      ok: true,
      interval: AGENT_REPORT_INTERVAL,
      latest,
      ...(upgrade ? { upgrade } : {}),
      ...(ping ? { ping } : {}),
      ...(instances ? { instances } : {}),
      ...(egress ? { egress } : {}),
      ...(listingPings.length ? { listingPings } : {}),
      ...(ipv4Checks.length ? { ipv4Checks } : {}),
    });
  });

  // 上报程序（2 版起）每 30 秒拉取一次虚拟机的 CPU 限制，纯文本便于 bash 解析
  app.get('/api/agent/nodes/vm-limits', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    return signedReply(reply, auth, await vmLimitsText(auth.node), 'text/plain; charset=utf-8');
  });

  // 节点测试：Agent 拉取启用的拨测目标（目标摘要变化时）
  app.get('/api/agent/nodes/ping-targets', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    return signedReply(reply, auth, await pingTargets(auth.node.id));
  });

  // 上架拨测：Agent 回传结果（不论是否启用节点测试）
  app.post('/api/agent/nodes/listing-ping', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth.secret) return signedReply(reply, auth, { ok: false });
    const body = parse(
      z.object({
        id: z.number().int().positive(),
        method: z.enum(['icmp', 'tcp']).optional(),
        via: z.enum(['local', 'default', 'spoof', 'spoof-l2']).optional(),
        results: z.array(z.object({ id: z.string().max(32), latency: z.number().min(0).max(60_000).nullable(), loss: z.number().min(0).max(100) })).max(500).optional(),
        error: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return signedReply(reply, auth, { ok: await saveAgentListingPing(auth.node.id, body) });
  });

  // 切换机房前的即时 IPv4 检测，仅接受签名 Agent 的 ICMP 结果。
  app.post('/api/agent/nodes/ipv4-check', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth.secret) throw unauthorized(t('agent.tokenInvalid'));
    const body = parse(z.object({
      id: z.number().int().positive(), requestId: z.string().uuid(),
      method: z.literal('icmp').optional(),
      via: z.enum(['local', 'default', 'spoof', 'spoof-l2']).optional(),
      results: z.array(z.object({ id: z.string().max(32), latency: z.number().min(0).max(60_000).nullable(), loss: z.number().min(0).max(100), error: z.string().max(1000).optional() })).max(6).optional(),
      error: z.string().max(1000).optional(),
    }), req.body);
    return signedReply(reply, auth, { ok: await saveAgentIpv4Check(auth.node.id, body) });
  });

  // 节点测试：Agent 按配置的间隔回传结果
  app.post('/api/agent/nodes/ping-results', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    const body = parse(
      z.object({
        method: z.enum(['icmp', 'tcp']),
        results: z.array(z.object({ id: z.string().max(32), latency: z.number().min(0).max(60_000).nullable(), loss: z.number().min(0).max(100) })).max(500),
      }),
      req.body,
    );
    return signedReply(reply, auth, { ok: await savePingResults(auth.node.id, body) });
  });

  // 智能分流：Agent 拉取完整配置（含私钥 / 密码，只通过签名回复发给签名认证的 Agent）
  app.get('/api/agent/nodes/egress', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth.secret) throw unauthorized(t('agent.tokenInvalid'));
    return signedReply(reply, auth, await agentEgressConfig(auth.node));
  });

  // 智能分流：Agent 回报应用结果与各出口状态
  app.post('/api/agent/nodes/egress-status', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    if (!auth.secret) throw unauthorized(t('agent.tokenInvalid'));
    const body = parse(
      z.object({
        version: z.number().int().min(0),
        error: z.string().max(1000).nullable().optional(),
        items: z
          .array(
            z.object({
              id: z.number().int().positive(),
              ok: z.boolean(),
              error: z.string().max(500).nullable().optional(),
              handshakeAt: z.number().int().min(0).nullable().optional(),
              rx: z.number().min(0).optional(),
              tx: z.number().min(0).optional(),
              latency: z.number().min(0).max(120_000).nullable().optional(),
            }),
          )
          .max(100),
      }),
      req.body,
    );
    await saveEgressStatus(auth.node.id, body);
    return signedReply(reply, auth, { ok: true });
  });

  // 实例资源上报：Agent 每 3 秒上报正在被查看的实例在本机 Incus 的状态；回复续期后的查看列表
  app.post('/api/agent/nodes/instance-states', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const auth = await authenticate(req);
    // 只接受签名认证的 Go 版 Agent
    if (!auth.secret) throw unauthorized(t('agent.tokenInvalid'));
    const body = parse(
      z.object({
        states: z
          .array(z.object({ name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/), state: z.record(z.string(), z.unknown()).optional(), error: z.string().max(500).optional() }))
          .max(50),
      }),
      req.body,
    );
    await saveInstanceStates(auth.node, body.states);
    return signedReply(reply, auth, { ok: true, watch: await instanceWatch(auth.node.id) });
  });

  app.get('/api/agent/caddy/:token/install.sh', limit, async (req, reply) => {
    const { token } = parse(tokenParam, req.params);
    const node = await nodeByCaddyToken(token);
    const script = renderCaddyInstallScript({
      panelUrl: panelUrl(req),
      token,
      nodeName: node.name,
      adminPort: node.caddyAdminPort,
      initialConfig: await initialCaddyConfig(node),
      locale: scriptLocale(req.query),
    });
    return sendInstallScript(reply, script);
  });

  app.post('/api/agent/caddy/register', limit, async (req) => {
    const body = parse(
      z.object({
        token: z.string().min(16).max(128),
        rootCert: z.string().includes('BEGIN CERTIFICATE').max(10_000),
        version: z.string().max(64).optional(),
        port: z.number().int().min(1).max(65535),
      }),
      req.body,
    );
    try {
      const node = await registerCaddy(body);
      await logActivity(req, null, 'agent.caddy_register', node.name);
      return { ok: true, message: t('caddy.registered', { name: node.name }) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  });
}

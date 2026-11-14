import { Agent } from 'undici';
import { getClientCertificate } from '../incus/certs.ts';
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.ts';
import { badRequest, conflict, errorMessage, unauthorized } from '../lib/errors.ts';
import { prisma, type Node } from '../lib/prisma.ts';
import { redis, withLock } from '../lib/redis.ts';
import { getSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { parseUpstream, pemToDer, renderCaddyConfig, type CaddySite } from './caddy.ts';

export { checkDomainDns, normalizeDomain, parseUpstream, renderCaddyConfig } from './caddy.ts';

/**
 * 宿主机 Caddy：通过安装脚本在宿主机上安装 Caddy 并开启远程管理 API（mTLS，只接受面板客户端证书），
 * 面板据此整体下发反向代理配置（用户网站绑定 + 管理员反代站点）。宿主机本身位于 NAT 网桥上，可直接访问实例内网地址。
 */

const TOKEN_TTL_MS = 24 * 3600_000;

function caddyErrorMessage(error: unknown): string {
  let cause = error;
  for (let depth = 0; depth < 5 && cause instanceof Error; depth++) {
    if ((cause as NodeJS.ErrnoException).code === 'CERT_HAS_EXPIRED') return t('caddy.serverCertificateExpired');
    if ((cause as NodeJS.ErrnoException).code === 'CERT_NOT_YET_VALID') return t('caddy.serverCertificateNotYetValid');
    cause = cause.cause;
  }
  return errorMessage(error);
}

export function isMockNode(node: Pick<Node, 'endpoint'>): boolean {
  return node.endpoint.startsWith('mock://');
}

interface CaddyApi {
  getConfig(): Promise<unknown>;
  load(config: unknown): Promise<void>;
}

interface CaddyRuntimeConfig {
  admin?: { identity?: { issuers?: { module?: string; ca?: string }[] } };
  apps?: { pki?: unknown };
  storage?: unknown;
}

function managedAdminCa(config: CaddyRuntimeConfig | null): string | undefined {
  return config?.admin?.identity?.issuers?.find(
    (issuer) => issuer.module === 'internal' && /^paledove-admin-[a-f0-9]{16}$/.test(issuer.ca ?? ''),
  )?.ca;
}

class HttpCaddyClient implements CaddyApi {
  private agent: Agent;
  private origin: string;

  /** ca 为 null 时不校验服务端证书，只用于首次读取宿主机 Caddy 的本地 CA */
  constructor(host: string, port: number, ca: string | null, cert: string, key: string) {
    this.origin = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
    // 使用宿主机 Caddy 本地 CA 校验证书链；证书标识为宿主机 IP，跳过主机名校验
    this.agent = new Agent({
      connect: ca ? { ca, cert, key, checkServerIdentity: () => undefined, timeout: 10_000 } : { cert, key, rejectUnauthorized: false, timeout: 10_000 },
    });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<string> {
    const res = await this.agent.request({
      origin: this.origin,
      path,
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: 30_000,
      bodyTimeout: 30_000,
    });
    const text = await res.body.text();
    if (res.statusCode >= 400) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        /* 非 JSON 响应 */
      }
      throw new Error(`HTTP ${res.statusCode}: ${message.slice(0, 500)}`);
    }
    return text;
  }

  async getConfig(): Promise<unknown> {
    const text = await this.request('GET', '/config/');
    return text ? JSON.parse(text) : null;
  }

  async load(config: unknown): Promise<void> {
    await this.request('POST', '/load', config);
  }

  /** Caddy 本地 CA 的根证书（远程管理端点的证书由它签发） */
  async rootCertificate(): Promise<string> {
    const config = await this.getConfig() as CaddyRuntimeConfig | null;
    const ca = managedAdminCa(config) ?? 'local';
    const root = (JSON.parse(await this.request('GET', `/pki/ca/${ca}`)) as { root_certificate?: string }).root_certificate?.trim();
    if (!root) throw new Error('Caddy did not return its local CA certificate');
    return root;
  }

  close() {
    void this.agent.close().catch(() => undefined);
  }
}

/** 模拟节点使用的 Caddy：配置保存在 Redis 中 */
class MockCaddyClient implements CaddyApi {
  constructor(private nodeId: number) {}
  async getConfig() {
    const raw = await redis.get(`mock:caddy:${this.nodeId}`);
    return raw ? JSON.parse(raw) : {};
  }
  async load(config: unknown) {
    await redis.set(`mock:caddy:${this.nodeId}`, JSON.stringify(config));
  }
}

const clients = new Map<number, { sig: string; client: HttpCaddyClient }>();

/** 关闭并清空缓存的 Caddy 客户端（例如更换面板证书后，下次请求用新证书重建） */
export function resetCaddyClients(): void {
  for (const { client } of clients.values()) client.close();
  clients.clear();
}

async function caddyClient(node: Node): Promise<CaddyApi> {
  if (isMockNode(node)) return new MockCaddyClient(node.id);
  if (!node.caddyCaCert || !node.publicIp) throw new Error(t('caddy.notInstalled'));
  const { cert, key, fingerprint } = await getClientCertificate();
  const sig = `${node.publicIp}|${node.caddyAdminPort}|${sha256(node.caddyCaCert)}|${fingerprint}`;
  const hit = clients.get(node.id);
  if (hit?.sig === sig) return hit.client;
  hit?.client.close();
  const client = new HttpCaddyClient(node.publicIp, node.caddyAdminPort, node.caddyCaCert, cert, key);
  clients.set(node.id, { sig, client });
  return client;
}

async function adminOptions(node: Node) {
  const { cert } = await getClientCertificate();
  return { adminPort: node.caddyAdminPort, publicIp: node.publicIp, panelCertDer: pemToDer(cert) };
}

/** 安装脚本首次加载的配置（只包含远程管理端点） */
export async function initialCaddyConfig(node: Node) {
  return renderCaddyConfig(await adminOptions(node), []);
}

// ───────── 安装与注册 ─────────

/**
 * 获取 Caddy 安装令牌：有效期内沿用已签发的令牌；查看安装命令不改变 Caddy 的当前状态，
 * 安装脚本回调后才会更新。regenerate 为 true 时签发新令牌
 */
export async function issueCaddyToken(nodeId: number, regenerate = false): Promise<{ token: string; expiresAt: Date }> {
  const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
  if (!regenerate && node.caddyTokenEnc && node.caddyTokenExpires && node.caddyTokenExpires.getTime() > Date.now() + 3600_000) {
    return { token: decrypt(node.caddyTokenEnc), expiresAt: node.caddyTokenExpires };
  }
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await prisma.node.update({
    where: { id: nodeId },
    // 从未安装过时标记为等待安装；已安装的保持原状态
    data: { caddyTokenHash: sha256(token), caddyTokenEnc: encrypt(token), caddyTokenExpires: expiresAt, ...(node.caddyStatus === 'NONE' ? { caddyStatus: 'PENDING' as const } : {}) },
  });
  return { token, expiresAt };
}

export async function nodeByCaddyToken(token: string): Promise<Node> {
  const node = await prisma.node.findUnique({ where: { caddyTokenHash: sha256(token) } });
  if (!node || !node.caddyTokenExpires || node.caddyTokenExpires < new Date()) throw unauthorized(t('install.tokenInvalid'));
  return node;
}

export async function registerCaddy(input: { token: string; rootCert: string; version?: string; port: number }): Promise<Node> {
  const node = await nodeByCaddyToken(input.token);
  const updated = await prisma.node.update({
    where: { id: node.id },
    data: {
      caddyCaCert: input.rootCert.trim(),
      caddyAdminPort: input.port,
      caddyVersion: input.version || null,
    },
  });
  await testCaddy(updated);
  await syncSites(updated.id);
  // Keep the installation token retryable if certificate verification or the first sync fails.
  return prisma.node.update({ where: { id: node.id }, data: { caddyTokenHash: null, caddyTokenEnc: null, caddyTokenExpires: null } });
}

/** 演示用：模拟节点直接视为已安装 */
export async function markMockCaddyReady(nodeId: number): Promise<void> {
  await prisma.node.update({
    where: { id: nodeId },
    data: { caddyStatus: 'READY', caddyError: null, caddyVersion: 'mock', caddyTokenHash: null, caddyTokenEnc: null, caddyTokenExpires: null },
  });
  await syncSitesSafe(nodeId);
}

/**
 * 测试连接宿主机 Caddy，连接成功即标记为已安装。
 * 安装脚本没能回调面板时（例如宿主机访问不到面板地址）面板还没有 Caddy 的 CA 证书：
 * 此时用面板客户端证书直接连接远程管理端点，读取并保存它的本地 CA，之后的连接都用它校验；
 * 这种情况下连接失败不改变状态（仍为等待安装），只返回错误。
 */
export async function testCaddy(node: Node): Promise<void> {
  const firstConnect = !isMockNode(node) && !node.caddyCaCert;
  try {
    let caddyCaCert = node.caddyCaCert;
    if (firstConnect) {
      if (!node.publicIp) throw new Error(t('caddy.notInstalled'));
      const { cert, key } = await getClientCertificate();
      const probe = new HttpCaddyClient(node.publicIp, node.caddyAdminPort, null, cert, key);
      try {
        caddyCaCert = await probe.rootCertificate();
      } finally {
        probe.close();
      }
    }
    const client = await caddyClient({ ...node, caddyCaCert });
    await client.getConfig();
    await prisma.node.update({
      where: { id: node.id },
      data: {
        caddyStatus: 'READY',
        caddyError: null,
        ...(firstConnect ? { caddyCaCert, caddyTokenHash: null, caddyTokenEnc: null, caddyTokenExpires: null } : {}),
      },
    });
  } catch (err) {
    const message = t('caddy.connectFailed', { message: caddyErrorMessage(err) });
    if (!firstConnect) await prisma.node.update({ where: { id: node.id }, data: { caddyStatus: 'ERROR', caddyError: message.slice(0, 1000) } });
    throw badRequest(message);
  }
  if (firstConnect) await syncSitesSafe(node.id);
}

// ───────── 站点同步 ─────────

/** 域名在用户绑定与管理员反代站点中均需唯一 */
export async function assertDomainAvailable(domain: string, exclude: { siteId?: number; proxyId?: number } = {}): Promise<void> {
  const [site, proxy] = await Promise.all([
    prisma.siteBinding.findUnique({ where: { domain } }),
    prisma.proxySite.findUnique({ where: { domain } }),
  ]);
  if ((site && site.id !== exclude.siteId) || (proxy && proxy.id !== exclude.proxyId)) throw conflict(t('site.domainTaken'));
}

/** 重新生成节点的 Caddy 配置并整体下发 */
export async function syncSites(nodeId: number): Promise<void> {
  await withLock(`caddy:${nodeId}`, 120_000, async () => {
    const node = await prisma.node.findUniqueOrThrow({ where: { id: nodeId } });
    const [bindings, proxies] = await Promise.all([
      prisma.siteBinding.findMany({
        where: { instance: { nodeId } },
        include: { instance: { select: { status: true, privateIp: true } } },
        orderBy: { id: 'asc' },
      }),
      prisma.proxySite.findMany({ where: { nodeId }, orderBy: { id: 'asc' } }),
    ]);
    const liveBindings = bindings.filter(
      (s) => s.instance.privateIp && !['SUSPENDED', 'DELETING', 'DELETED'].includes(s.instance.status),
    );
    const parked = bindings.filter((s) => !liveBindings.includes(s));
    if (parked.length) {
      await prisma.siteBinding.updateMany({
        where: { id: { in: parked.map((s) => s.id) } },
        data: { status: 'PENDING', lastError: t('caddy.instanceUnavailable') },
      });
    }

    const mark = async (status: 'PENDING' | 'ACTIVE' | 'ERROR', lastError: string | null) => {
      if (liveBindings.length) {
        await prisma.siteBinding.updateMany({ where: { id: { in: liveBindings.map((s) => s.id) } }, data: { status, lastError } });
      }
      if (proxies.length) {
        await prisma.proxySite.updateMany({ where: { id: { in: proxies.map((s) => s.id) } }, data: { status, lastError } });
      }
    };

    if (node.caddyStatus !== 'READY') {
      await mark('PENDING', t('caddy.notReady'));
      return;
    }

    const sites: CaddySite[] = [
      ...liveBindings.map((s) => ({
        domain: s.domain,
        https: s.https,
        upstream: { dial: `${s.instance.privateIp}:${s.targetPort}`, host: s.instance.privateIp!, tls: false },
      })),
      ...proxies.map((p) => ({ domain: p.domain, https: p.https, upstream: parseUpstream(p.upstream) })),
    ];
    const settings = await getSettings();
    try {
      const client = await caddyClient(node);
      const current = (await client.getConfig()) as CaddyRuntimeConfig | null;
      // Keep the issuer registered by the installer; switching back to local can
      // resurrect its expired chain and invalidate the CA trusted by the panel.
      const config = renderCaddyConfig({ ...(await adminOptions(node)), caId: managedAdminCa(current) }, sites, settings.acmeEmail || undefined);
      if (current?.apps?.pki) config.apps.pki = current.apps.pki;
      await client.load({ ...config, ...(current?.storage !== undefined ? { storage: current.storage } : {}) });
      await mark('ACTIVE', null);
    } catch (err) {
      const message = t('caddy.syncFailed', { message: caddyErrorMessage(err) }).slice(0, 500);
      await mark('ERROR', message);
      throw new Error(message);
    }
  });
}

/** 后台同步，失败只记录不抛出 */
export function syncSitesSafe(nodeId: number): Promise<void> {
  return syncSites(nodeId).catch(() => undefined);
}

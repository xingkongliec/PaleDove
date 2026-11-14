import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { badRequest } from '../lib/errors.ts';
import { t } from '../i18n/index.ts';

/** 域名校验、上游解析与 Caddy JSON 配置生成（纯函数，便于测试） */

const DOMAIN_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+[a-z][a-z0-9-]{0,62}$/;
const HOST_RE = /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-))(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

export function normalizeDomain(input: string): string {
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  if (!DOMAIN_RE.test(domain)) throw badRequest(t('site.invalidDomain'));
  return domain;
}

export async function checkDomainDns(domain: string, expectedIp: string): Promise<void> {
  let addrs: string[] = [];
  try {
    addrs = await dns.resolve4(domain);
  } catch {
    throw badRequest(t('site.dnsUnresolved', { domain, ip: expectedIp }));
  }
  if (!addrs.includes(expectedIp)) {
    throw badRequest(t('site.dnsMismatch', { domain, current: addrs.join(', '), ip: expectedIp }));
  }
}

export interface Upstream {
  /** Caddy dial 地址 host:port */
  dial: string;
  host: string;
  tls: boolean;
}

/** 解析上游地址：10.0.0.5:8080、http://host:port、https://host[:port] */
export function parseUpstream(input: string): Upstream {
  const raw = input.trim();
  let host: string;
  let port: number;
  let tls = false;
  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw badRequest(t('caddy.invalidUpstream'));
    }
    if ((url.pathname && url.pathname !== '/') || url.search || url.username) throw badRequest(t('caddy.invalidUpstream'));
    tls = url.protocol === 'https:';
    host = url.hostname.replace(/^\[|\]$/g, '');
    port = url.port ? Number(url.port) : tls ? 443 : 80;
  } else {
    const m = /^(\[[0-9a-f:.]+\]|[^:/\s]+)(?::(\d{1,5}))?$/i.exec(raw);
    if (!m) throw badRequest(t('caddy.invalidUpstream'));
    host = m[1].replace(/^\[|\]$/g, '');
    port = m[2] ? Number(m[2]) : 80;
  }
  if (!(isIP(host) || HOST_RE.test(host)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest(t('caddy.invalidUpstream'));
  }
  const dialHost = isIP(host) === 6 ? `[${host}]` : host;
  return { dial: `${dialHost}:${port}`, host, tls };
}

export interface CaddySite {
  domain: string;
  https: boolean;
  upstream: Upstream;
}

export interface CaddyAdminOptions {
  /** 远程管理端口 */
  adminPort: number;
  /** 宿主机公网 IP，用于远程管理端点的证书标识 */
  publicIp: string;
  /** 面板客户端证书（Base64 DER），只有持有该证书的客户端可以访问远程管理 API */
  panelCertDer: string;
  /** 安装脚本创建的独立管理 CA；旧节点未设置时继续使用 local */
  caId?: string;
}

export function pemToDer(pem: string): string {
  return pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '');
}

export function caddyAdminBlock(o: CaddyAdminOptions) {
  return {
    listen: 'localhost:2019',
    identity: { identifiers: [o.publicIp], issuers: [{ module: 'internal', ...(o.caId ? { ca: o.caId } : {}) }] },
    remote: { listen: `:${o.adminPort}`, access_control: [{ public_keys: [o.panelCertDer] }] },
  };
}

function route(site: CaddySite) {
  const proxy: Record<string, unknown> = { handler: 'reverse_proxy', upstreams: [{ dial: site.upstream.dial }] };
  if (site.upstream.tls) {
    proxy.transport = { protocol: 'http', tls: {} };
    proxy.headers = { request: { set: { Host: ['{http.reverse_proxy.upstream.hostport}'] } } };
  }
  return { match: [{ host: [site.domain] }], handle: [proxy], terminal: true };
}

/** 生成完整的 Caddy JSON 配置（通过 /load 整体替换） */
export function renderCaddyConfig(admin: CaddyAdminOptions, sites: CaddySite[], acmeEmail?: string) {
  const secure = sites.filter((s) => s.https);
  const plain = sites.filter((s) => !s.https);
  const servers: Record<string, unknown> = {};
  if (secure.length) servers.paledove_https = { listen: [':443'], routes: secure.map(route) };
  // HTTPS 站点的 HTTP→HTTPS 跳转由 Caddy 自动 HTTPS 追加到 :80 服务
  if (plain.length) servers.paledove_http = { listen: [':80'], routes: plain.map(route) };
  const apps: Record<string, unknown> = {};
  if (Object.keys(servers).length) apps.http = { servers };
  if (acmeEmail && secure.length) {
    apps.tls = { automation: { policies: [{ issuers: [{ module: 'acme', email: acmeEmail }] }] } };
  }
  return { admin: caddyAdminBlock(admin), apps };
}

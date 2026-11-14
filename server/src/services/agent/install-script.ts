import { renderInstallTemplate } from '../../install-template.ts';
import { intToIp, parseCidr } from '../../lib/ip.ts';

/** 单引号转义，用于把任意值安全地写入 bash 脚本 */
export function shq(value: string | number): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** NAT 网段中保留给 DHCP 的低位地址段（面板从高位分配固定地址） */
export function dhcpRangeFor(cidr: string): string {
  const c = parseCidr(cidr);
  return `${intToIp(c.network + 2)}-${intToIp(Math.min(c.network + 10, c.broadcast - 1))}`;
}

export interface NodeInstallOptions {
  panelUrl: string;
  token: string;
  nodeName: string;
  apiPort: number;
  poolName: string;
  storageDriver: string;
  storageSource: string | null;
  storageSize: string;
  natNetwork: string;
  natCidr: string;
  portRangeStart: number;
  portRangeEnd: number;
  publicIp: string;
  /** 网络模式包含 IPv6：开启 NDP 代答并回报检测到的 IPv6 */
  ipv6: boolean;
  ipv6Parent: string;
  panelCert: string;
  /** 一次性 Agent 安装令牌：每次下载节点安装脚本时签发（30 分钟有效、只能使用一次） */
  agentInstallToken?: string;
  /** 是否在宿主机安装 Agent；默认 true，保持旧版安装脚本行为 */
  installAgent?: boolean;
  /** 是否部署 RFW 防火墙 */
  installFirewall?: boolean;
  /** 是否启用 RFW 规则并配置 Incus/UFW 网络放行规则 */
  enableFirewallRules?: boolean;
  /** 回调面板时使用的语言（决定注册结果提示的语言） */
  locale?: string;
}

export function renderNodeInstallScript(o: NodeInstallOptions): string {
  const ui = renderInstallTemplate('install-ui.sh', {});
  const uninstall = renderInstallTemplate('node-uninstall.sh', {});
  return renderInstallTemplate('install.sh', {
    NODE_NAME: o.nodeName.replace(/[\r\n]/g, ' '),
    PANEL_URL: shq(o.panelUrl),
    TOKEN: shq(o.token),
    LOCALE: shq(o.locale ?? 'zh-CN'),
    API_PORT: shq(o.apiPort),
    POOL_NAME: shq(o.poolName),
    STORAGE_DRIVER: shq(o.storageDriver),
    STORAGE_SOURCE: shq(o.storageSource ?? ''),
    STORAGE_SIZE: shq(o.storageSize),
    NAT_NETWORK: shq(o.natNetwork),
    NAT_CIDR: shq(o.natCidr),
    DHCP_RANGE: shq(dhcpRangeFor(o.natCidr)),
    PORT_RANGE: shq(`${o.portRangeStart}:${o.portRangeEnd}`),
    PUBLIC_IP: shq(o.publicIp),
    IPV6_ENABLED: shq(o.ipv6 ? 1 : 0),
    IPV6_PARENT: shq(o.ipv6Parent),
    INSTALL_AGENT: shq(o.installAgent !== false ? 1 : 0),
    INSTALL_FIREWALL: shq(o.installFirewall ? 1 : 0),
    ENABLE_FIREWALL_RULES: shq(o.enableFirewallRules ? 1 : 0),
    AGENT_AVAILABLE: shq(o.agentInstallToken ? 1 : 0),
    INSTALL_UI: ui,
    NODE_UNINSTALL: uninstall,
    NODE_MANAGEMENT: renderInstallTemplate('node-manage.sh', { INSTALL_UI: ui, NODE_UNINSTALL: uninstall }),
    PANEL_CERT: o.panelCert.trim(),
    AGENT_INSTALL: o.agentInstallToken ? `${agentSetupSection(o.panelUrl)}

if [ "$INSTALL_AGENT" = 1 ]; then
  info "安装宿主机 Agent / installing the host agent"
  install_paledove_agent ${shq(o.agentInstallToken)} || warn "宿主机 Agent 安装失败，可稍后在面板中重新安装 / agent install failed"
fi

` : '',
  });
}

/**
 * 安装宿主机 Agent 的 bash 函数 install_paledove_agent <一次性安装令牌>（节点安装脚本与通用 Agent 安装脚本共用）：
 *  1. 读取面板的版本清单，按宿主机架构下载 Go 版 Agent 并校验 sha256 与大小；
 *  2. 校验通过后才用一次性安装令牌换取 Agent 密钥（令牌放在请求头里，不进入访问日志；下载失败不会浪费令牌）；
 *  3. 原子替换二进制，写入配置与 systemd 服务并重启。同名的旧版 bash 上报程序会被替换。
 */
export function agentSetupSection(panelUrl: string): string {
  return renderInstallTemplate('agent-setup.sh', {
    PANEL_URL: shq(panelUrl),
  });
}

/**
 * 通用 Agent 安装脚本（不含任何密钥，可以公开下载）：
 * curl -fsSL <面板>/api/agent/install.sh | env PALEDOVE_INSTALL_TOKEN=<一次性令牌> bash
 */
export function renderAgentInstallScript(o: { panelUrl: string; installToken?: string }): string {
  return renderInstallTemplate('agent-install.sh', {
    PANEL_URL_COMMENT: o.panelUrl.replace(/[\r\n]/g, ''),
    LEGACY_INSTALL_TOKEN: o.installToken ? `PALEDOVE_INSTALL_TOKEN="\${PALEDOVE_INSTALL_TOKEN:-}"
[ -n "$PALEDOVE_INSTALL_TOKEN" ] || PALEDOVE_INSTALL_TOKEN=${shq(o.installToken)}
` : '',
    AGENT_SETUP: agentSetupSection(o.panelUrl),
  });
}

export interface CaddyInstallOptions {
  panelUrl: string;
  token: string;
  nodeName: string;
  adminPort: number;
  /** 首次加载的 Caddy JSON 配置（包含远程管理端点） */
  initialConfig: unknown;
  locale?: string;
}

export function renderCaddyInstallScript(o: CaddyInstallOptions): string {
  return renderInstallTemplate('caddy.sh', {
    NODE_NAME: o.nodeName.replace(/[\r\n]/g, ' '),
    PANEL_URL: shq(o.panelUrl),
    TOKEN: shq(o.token),
    LOCALE: shq(o.locale ?? 'zh-CN'),
    ADMIN_PORT: shq(o.adminPort),
    INITIAL_CONFIG: JSON.stringify(o.initialConfig, null, 2),
  });
}

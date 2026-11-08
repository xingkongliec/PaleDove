import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { agentSetupSection, dhcpRangeFor, renderAgentInstallScript, renderCaddyInstallScript, renderNodeInstallScript, shq } from '../src/services/agent/install-script.ts';

const bashCheck = (script: string) => spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });

const nodeOptions = {
  panelUrl: 'https://panel.example.com',
  token: "tok'en$(rm -rf /)",
  nodeName: 'HK-01\nrm -rf /',
  apiPort: 8443,
  poolName: 'default',
  storageDriver: 'zfs',
  storageSource: null,
  storageSize: '200GiB',
  natNetwork: 'incusbr0',
  natCidr: '10.88.0.1/16',
  portRangeStart: 20000,
  portRangeEnd: 29999,
  publicIp: '',
  ipv6: true,
  ipv6Parent: 'eth0.100',
  panelCert: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----',
};

describe('install scripts', () => {
  it('quotes shell values safely', () => {
    expect(shq("a'b")).toBe(`'a'\\''b'`);
    expect(spawnSync('bash', ['-c', `printf %s ${shq("x'$(id)`y")}`], { encoding: 'utf8' }).stdout).toBe("x'$(id)`y");
  });

  it('reserves a small dhcp range', () => {
    expect(dhcpRangeFor('10.88.0.1/16')).toBe('10.88.0.2-10.88.0.10');
    expect(dhcpRangeFor('192.168.5.1/29')).toBe('192.168.5.2-192.168.5.6');
  });

  for (const driver of ['zfs', 'btrfs', 'lvm', 'dir']) {
    it(`renders a syntactically valid node script (${driver})`, () => {
      const script = renderNodeInstallScript({ ...nodeOptions, storageDriver: driver, storageSource: driver === 'lvm' ? '/dev/sdb' : null });
      const res = bashCheck(script);
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      expect(script).toContain(`TOKEN=${shq(nodeOptions.token)}`);
      expect(script).toContain('/api/agent/nodes/register');
      expect(script).toContain("IPV6_ENABLED='1'");
      expect(script).not.toMatch(/@@PALEDOVE_[A-Z0-9_]+@@/);
      // 节点名称中的换行不会逃逸出注释
      expect(script).not.toMatch(/^rm -rf \/$/m);
    });
  }

  it('renders a generic host agent script without secrets', () => {
    const script = renderAgentInstallScript({ panelUrl: "https://panel.example.com/p'q" });
    const res = bashCheck(script);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    // 通用脚本不含任何令牌：一次性令牌由安装命令通过环境变量传入
    expect(script).toContain('PALEDOVE_INSTALL_TOKEN');
    expect(script).not.toMatch(/pdi_/);
    // 读取版本清单、按架构下载并校验 sha256 与大小，校验通过后才用令牌（放在请求头）换取 Agent 配置
    expect(script).toContain(shq("https://panel.example.com/p'q"));
    expect(script).toContain('/api/agent/manifest.json?format=text');
    expect(script).toContain('/api/agent/binary/$arch');
    expect(script).toContain('sha256sum -c --status');
    expect(script.indexOf('sha256sum -c')).toBeLessThan(script.indexOf('x-paledove-install-token'));
    expect(script).toContain('format=text&version=1');
    expect(script).toContain('binary/$arch?v=$version&sha256=$sha');
    // 旧版安装命令：令牌经过转义嵌入脚本
    const token = "pdi_tok'en$(id)";
    const legacy = renderAgentInstallScript({ panelUrl: 'https://panel.example.com', installToken: token });
    expect(bashCheck(legacy).status).toBe(0);
    expect(legacy).toContain(shq(token));
    // 嵌入节点安装脚本时同样语法正确，使用一次性令牌，且安装失败不中断节点安装
    const node = renderNodeInstallScript({ ...nodeOptions, agentInstallToken: 'pdi_abc' });
    expect(bashCheck(node).status).toBe(0);
    expect(node).toContain("install_paledove_agent 'pdi_abc' ||");
  });

  it('keeps the install token unused when a downloaded binary fails verification', () => {
    const script = `
uname() { printf 'x86_64\\n'; }
curl() {
  case "$*" in
    *manifest.json*) printf 'amd64 ${'f'.repeat(64)} 3 0.7.1\\n' ;;
    *binary/*)
      while [ "$#" -gt 0 ]; do
        if [ "$1" = '-o' ]; then printf 'bad' > "$2"; return 0; fi
        shift
      done
      return 1 ;;
    *install-config*) printf 'TOKEN_CONSUMED\\n' >&2; return 1 ;;
  esac
}
${agentSetupSection('https://panel.example.com')}
install_paledove_agent 'unused-install-token'
`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('checksum mismatch');
    expect(result.stderr).not.toContain('TOKEN_CONSUMED');
  });

  it('renders a syntactically valid caddy script', () => {
    const script = renderCaddyInstallScript({
      panelUrl: 'https://panel.example.com',
      token: 'abc',
      nodeName: 'HK-01',
      adminPort: 2021,
      initialConfig: { admin: { listen: 'localhost:2019' }, apps: {} },
    });
    const res = bashCheck(script);
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(script).toContain('/api/agent/caddy/register');
  });
});

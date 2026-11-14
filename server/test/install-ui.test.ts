import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderNodeInstallScript, shq } from '../src/services/agent/install-script.ts';

const ui = readFileSync(new URL('../templates/install-ui.sh', import.meta.url), 'utf8');
const run = (body: string) => spawnSync('bash', ['-s'], {
  encoding: 'utf8',
  input: `set -Eeuo pipefail
info() { printf '%s\\n' "$*"; }
warn() { printf '%s\\n' "$*" >&2; }
die() { warn "$*"; exit 1; }
POOL_NAME=default
STORAGE_DRIVER=btrfs
STORAGE_SOURCE=''
STORAGE_SIZE=100GiB
INSTALL_AGENT=0
INSTALL_FIREWALL=0
ENABLE_FIREWALL_RULES=0
DEFAULT_FIREWALL_RULES=0
AGENT_AVAILABLE=1
UI_TEXT_ONLY=1
# Never use a developer's real Incus or storage devices.
command() { if [ "\${1:-}" = -v ] && [ "\${2:-}" = incus ]; then return 1; fi; builtin command "$@"; }
${ui}
${body}
`,
});

// Keep real menu parsing and terminal output; only replace the user's keystrokes.
const terminal = (body: string, answers: string[]) => run(`exec 9>&1
answers=(${answers.map(shq).join(' ')})
answer_index=0
read() {
  if [ "$#" != 2 ] || [ "$1" != -r ] || [ "$2" != UI_VALUE ]; then builtin read "$@"; return; fi
  [ "$answer_index" -lt "\${#answers[@]}" ] || return 1
  UI_VALUE=\${answers[$answer_index]}
  answer_index=$((answer_index + 1))
}
${body}`);

describe('interactive Incus installer', () => {
  it('uses numbered inline menus even when a host has dialog tools installed', () => {
    const result = terminal(`TERM=xterm-256color
UI_TEXT_ONLY=0
unset NO_COLOR
whiptail() { die MUST_NOT_OPEN_DIALOG; }
ui_init
ui_menu '选择存储池类型' btrfs btrfs Btrfs zfs ZFS lvm LVM dir 目录
printf 'RESULT=%s' "$UI_VALUE"`, ['invalid', '4']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('1)');
    expect(result.stdout).toContain('Btrfs');
    expect(result.stdout).toContain('4)');
    expect(result.stdout).toContain('RESULT=dir');
    expect(result.stdout).toContain(String.fromCharCode(27) + '[1;36m');
    expect(result.stdout).not.toContain(String.fromCharCode(27) + '[44m');
    expect(result.stderr).toContain('无效选项');
    expect(ui).not.toMatch(/whiptail|UI_STYLE|--checklist|--inputbox/);
  });

  for (const setup of ['TERM=dumb; UI_TEXT_ONLY=0; unset NO_COLOR', 'TERM=xterm; UI_TEXT_ONLY=1; unset NO_COLOR', 'TERM=xterm; UI_TEXT_ONLY=0; NO_COLOR=1']) {
    it(`keeps menus uncolored when ${setup}`, () => {
      const result = terminal(`${setup}
ui_init
ui_menu '选择操作' install install 安装 cancel 退出
printf 'RESULT=%s' "$UI_VALUE"`, ['']);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain(String.fromCharCode(27));
      expect(result.stdout).toContain('RESULT=install');
    });
  }

  for (const [answer, expected] of [['y', '1'], ['N', '0'], ['', '0'], ['1', '1'], ['2', '0']]) {
    it(`accepts yes/no input ${JSON.stringify(answer)} without opening a popup`, () => {
      const result = terminal(`ui_toggle '是否安装 Agent？' 0; printf 'RESULT=%s' "$UI_VALUE"`, [answer!]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('[y/N]');
      expect(result.stdout).toContain(`RESULT=${expected}`);
    });
  }

  it('accepts zero to exit and numbered destructive actions without executing them', () => {
    for (const [answer, action] of [['0', 'cancel'], ['4', 'uninstall']]) {
      const result = terminal(`select_node_action; printf 'ACTION=%s' "$NODE_ACTION"`, [answer!]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`ACTION=${action}`);
      expect(result.stdout).toContain('0)');
    }
  });

  it('cancels on q or closed terminal input instead of silently using defaults', () => {
    for (const body of [
      'ui_menu choose install install 安装 cancel 退出',
      'ui_input capacity 100GiB',
      'ui_toggle confirm 1',
    ]) {
      for (const answers of [['q'], []]) {
        const result = terminal(`${body}\nprintf SHOULD_NOT_CONTINUE`, answers);
        expect(result.status).toBe(1);
        expect(result.stdout).not.toContain('SHOULD_NOT_CONTINUE');
        expect(result.stderr).toMatch(/已取消操作|终端输入已关闭/);
      }
    }
  });

  it('runs the actual numbered wizard through storage, components, custom rules and confirmation', () => {
    const result = terminal(`ip() {
  case "$*" in
    'route get 1.1.1.1') printf '1.1.1.1 dev eth0 src 192.0.2.1\\n' ;;
    '-o link show') printf '1: lo: <LOOPBACK>\\n2: eth0: <UP>\\n3: eth1: <UP>\\n' ;;
    *) return 1 ;;
  esac
}
select_node_action
configure_installation
printf 'RESULT=%s|%s|%s|%s|%s|%s|%s' "$STORAGE_DRIVER" "$STORAGE_SOURCE" "$INSTALL_AGENT" "$INSTALL_FIREWALL" "$ENABLE_FIREWALL_RULES" "$RFW_INTERFACE" "\${RFW_FLAGS[*]}"`, ['1', '4', '/srv/incus', 'n', 'y', 'y', '2 6', '2', 'us,jp', 'n', '2', 'y']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('RESULT=dir|/srv/incus|0|1|1|eth1|--block-http --block-quic --allow-only-countries US,JP');
    expect(result.stdout).toContain('4 / 4 · 确认安装配置');
    expect(result.stdout).toContain('跳过，保留现状');
    expect(result.stdout).toContain('eth0 · 默认出口网卡');
    expect(result.stdout.match(/存储来源  :/g)).toHaveLength(1);
    expect(result.stdout).not.toContain('1=是，0=否');
  });

  it('builds custom protocol, GeoIP and logging arguments without applying default protocols', () => {
    const result = run(`rfw_arguments '2 6' whitelist 'us, jp' 1
printf '%s\\n' "\${RFW_FLAGS[@]}"`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['--block-http', '--block-quic', '--allow-only-countries', 'US,JP', '--log-port-access']);
  });

  it('uses default firewall rules in unattended mode', () => {
    const result = run(`prepare_install_ui --yes
INSTALL_FIREWALL=1
ENABLE_FIREWALL_RULES=1
configure_installation
printf 'FLAGS=%s\\n' "\${RFW_FLAGS[*]}"`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('FLAGS=--block-email --block-http --block-socks5 --block-fet-strict --block-wireguard --countries CN');
  });

  it('lets block-all override individual protocols and uses the reference country shortcut', () => {
    const result = run(`rfw_arguments '1 6 7' blacklist cn 0
printf '%s\\n' "\${RFW_FLAGS[@]}"`);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['--block-all-from', 'CN']);
  });

  it('can clear all filters or choose global protocol filtering', () => {
    const cleared = run(`rfw_arguments C none '' 0
printf 'COUNT=%s' "\${#RFW_FLAGS[@]}"`);
    expect(cleared.status).toBe(0);
    expect(cleared.stdout).toBe('COUNT=0');
    const global = run(`rfw_arguments '6' none '' 0
printf '%s' "\${RFW_FLAGS[*]}"`);
    expect(global.status).toBe(0);
    expect(global.stdout).toBe('--block-quic');
  });

  for (const args of ["'8' none '' 0", "'1;id' none '' 0", "'1' blacklist 'CN;id' 0", "'1' unknown CN 0", "'1' none '' 2"]) {
    it(`rejects invalid rule input: ${args}`, () => {
      expect(run(`rfw_arguments ${args}`).status).toBe(1);
    });
  }

  for (const driver of ['zfs', 'btrfs', 'lvm', 'dir']) {
    it(`selects ${driver} at the terminal and clears a source inherited from a different driver`, () => {
      const result = run(`STORAGE_DRIVER=previous
STORAGE_SOURCE=/dev/old-preset
ui_menu() { case "$1" in *'1 / 4'*) UI_VALUE=${driver} ;; *) UI_VALUE=loop ;; esac; }
ui_input() { UI_VALUE="$2"; }
configure_storage
validate_storage
printf 'RESULT=%s|%s|%s' "$STORAGE_DRIVER" "$STORAGE_SOURCE" "$STORAGE_SIZE"`);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(`RESULT=${driver}||100GiB`);
    });
  }

  it('reuses an existing pool without asking to format its source', () => {
    const result = run(`command() { builtin command "$@"; }
incus() { printf '[{"name":"default","driver":"zfs","config":{"source":"existing-zpool"}}]'; }
jq() {
  case "$*" in
    *'select('* ) printf '%s' '{"driver":"zfs","config":{"source":"existing-zpool"}}' ;;
    *'.driver'*) printf zfs ;;
    *'.config.source'*) printf existing-zpool ;;
    *'.config.size'*) printf '' ;;
    *) return 1 ;;
  esac
}
ui_menu() { die UNEXPECTED_MENU; }
validate_storage() { die UNEXPECTED_FORMAT; }
NONINTERACTIVE=1
configure_installation
printf 'RESULT=%s|%s' "$STORAGE_DRIVER" "$STORAGE_SOURCE"`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RESULT=zfs|existing-zpool');
  });

  it('runs the text wizard with custom storage, component and firewall choices', () => {
    const result = run(`NONINTERACTIVE=0
exec 9>/dev/null
answers=(dir no yes yes whitelist no eth1 yes)
answer_index=0
ui_menu() { UI_VALUE=\${answers[$answer_index]}; answer_index=$((answer_index + 1)); }
ui_input() {
  case "$1" in
    *'存储目录'*) UI_VALUE=/srv/incus ;;
    *'协议规则'*) UI_VALUE='2 6' ;;
    *'国家代码'*) UI_VALUE='us,jp' ;;
    *) die UNEXPECTED_INPUT ;;
  esac
}
ip() {
  case "$*" in
    'route get 1.1.1.1') printf '1.1.1.1 dev eth0 src 192.0.2.1\\n' ;;
    '-o link show') printf '1: lo: <LOOPBACK>\\n2: eth0: <UP>\\n3: eth1: <UP>\\n' ;;
    *) return 1 ;;
  esac
}
configure_installation
printf 'RESULT=%s|%s|%s|%s|%s|%s|%s' "$STORAGE_DRIVER" "$STORAGE_SOURCE" "$INSTALL_AGENT" "$INSTALL_FIREWALL" "$ENABLE_FIREWALL_RULES" "$RFW_INTERFACE" "\${RFW_FLAGS[*]}"`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RESULT=dir|/srv/incus|0|1|1|eth1|--block-http --block-quic --allow-only-countries US,JP');
  });

  it('cancels before applying changes when the final confirmation is declined', () => {
    const result = run(`NONINTERACTIVE=0
exec 9>/dev/null
configure_storage() { STORAGE_DRIVER=dir; }
ui_menu() { UI_VALUE=no; }
configure_installation
printf SHOULD_NOT_INSTALL`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('已取消安装');
    expect(result.stdout).not.toContain('SHOULD_NOT_INSTALL');
  });

  for (const size of ['0GiB', '-1GiB', 'arbitrary', '100GiB;id']) {
    it(`rejects invalid unattended storage size ${size}`, () => {
      expect(run(`STORAGE_SIZE='${size}'; validate_storage`).status).toBe(1);
    });
  }

  it('rejects devices as directory sources and refuses missing raw devices', () => {
    expect(run('STORAGE_DRIVER=dir; STORAGE_SOURCE=/dev/sdb; validate_storage').status).toBe(1);
    expect(run('STORAGE_SOURCE=/dev/paledove-test-nonexistent; validate_storage').status).toBe(1);
  });

  const rawDevice = `
STORAGE_SOURCE=/dev/paledove-test-disk
# Simulate a block device without accessing any real disk.
[() { if builtin [ "$#" = 3 ] && builtin [ "$1" = -b ]; then return 0; fi; builtin [ "$@"; }
lsblk() { case "$*" in *TYPE*) printf 'disk\\npart\\n' ;; *) printf '/dev/paledove-test-disk\\n/dev/paledove-test-disk1\\n' ;; esac; }
findmnt() { return 1; }
swapon() { return 0; }
NONINTERACTIVE=1
`;

  it('requires explicit device confirmation in unattended mode', () => {
    const rejected = run(`${rawDevice}\nvalidate_storage`);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('PALEDOVE_ERASE_DEVICE');
    expect(run(`${rawDevice}\nPALEDOVE_ERASE_DEVICE=/dev/paledove-test-disk\nvalidate_storage`).status).toBe(0);
  });

  it('rejects mounted partitions, swap and active device mappings even with erase confirmation', () => {
    for (const [setup, message] of [
      ['findmnt() { return 0; }', '已挂载'],
      ["swapon() { printf '/dev/paledove-test-disk1\\n'; }", '交换空间'],
      ["lsblk() { case \"$*\" in *TYPE*) printf 'disk\\nlvm\\n' ;; *) printf '/dev/paledove-test-disk\\n' ;; esac; }", '活动的 LVM'],
    ] as const) {
      const result = run(`${rawDevice}\nPALEDOVE_ERASE_DEVICE=/dev/paledove-test-disk\n${setup}\nvalidate_storage`);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain(message);
    }
  });

  it('requires the exact erase phrase when using interactive raw storage', () => {
    const cancelled = run(`${rawDevice}\nNONINTERACTIVE=0\nui_input() { UI_VALUE=no; }\nvalidate_storage`);
    expect(cancelled.status).toBe(1);
    expect(cancelled.stderr).toContain('未确认清空设备');
    expect(run(`${rawDevice}\nNONINTERACTIVE=0\nui_input() { UI_VALUE='ERASE /dev/paledove-test-disk'; }\nvalidate_storage`).status).toBe(0);
  });

  it('keeps the Agent available for runtime selection even when the panel default is off', () => {
    const script = renderNodeInstallScript({
      panelUrl: 'https://panel.example.com', token: 'isolated-token', nodeName: 'test',
      apiPort: 8443, poolName: 'default', storageDriver: 'dir', storageSource: null, storageSize: '20GiB',
      natNetwork: 'incusbr0', natCidr: '10.88.0.1/16', portRangeStart: 20000, portRangeEnd: 29999,
      publicIp: '', ipv6: false, ipv6Parent: '', panelCert: 'test-cert',
      agentInstallToken: 'pdi_test', installAgent: false,
    });
    expect(script).toContain("INSTALL_AGENT='0'");
    expect(script).toContain("AGENT_AVAILABLE='1'");
    expect(script).toContain('if [ "$INSTALL_AGENT" = 1 ]; then');
    expect(script).toContain("install_paledove_agent 'pdi_test'");
    const help = spawnSync('bash', ['-s', '--', '--help'], { input: script, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--non-interactive');
    expect(help.stderr).toBe('');
  });
});

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderNodeInstallScript, shq } from '../src/services/agent/install-script.ts';

const ui = readFileSync(new URL('../templates/install-ui.sh', import.meta.url), 'utf8');
const uninstall = readFileSync(new URL('../templates/node-uninstall.sh', import.meta.url), 'utf8');
const jsonFilter = String.raw`
const fs = require('node:fs');
const value = JSON.parse(fs.readFileSync(0, 'utf8'));
const args = process.argv.slice(1), expression = args.at(-1);
let result;
switch (expression) {
  case '.environment | type == "object"': result = [!!value.environment && typeof value.environment === 'object']; break;
  case '.environment.server_clustered == true': result = [value.environment.server_clustered === true]; break;
  case '.[].name': result = value.map(v => v.name); break;
  case '.[].fingerprint': result = value.map(v => v.fingerprint); break;
  case '.[] | select(.type == "custom") | .name': result = value.filter(v => v.type === 'custom').map(v => v.name); break;
  case '.[] | select(.managed == true) | .name': result = value.filter(v => v.managed === true).map(v => v.name); break;
  default: throw new Error('Unexpected JSON filter: ' + expression);
}
if (result.length) console.log(result.join('\n'));
if (args.includes('-e') && !result.at(-1)) process.exit(1);
`;

// Every host mutation is intercepted. Only JSON parsing runs in a real subprocess.
const run = (body: string) => spawnSync('bash', ['-s'], { encoding: 'utf8', input: `set -Eeuo pipefail
exec 3>&2
info() { printf '%s\\n' "$*"; }
warn() { printf '%s\\n' "$*" >&2; }
die() { warn "$*"; exit 1; }
record() { printf 'CALL:%s\\n' "$*" >&3; }
rm() { record "rm $*"; }
rmdir() { record "rmdir $*"; }
systemctl() {
  record "systemctl $*"
  if [ "$1" = is-active ]; then [ "\${TEST_ACTIVE:-0}" = 1 ]; else return 0; fi
}
findmnt() { printf '%s\\n' "\${TEST_MOUNT:-/}"; }
pgrep() { return 1; }
grep() { return 1; }
dpkg-query() { printf 'incus installed\\nincus-client installed\\nincus-base:amd64 installed\\nincus-tools config-files\\nunrelated installed\\n'; }
apt-get() { record "apt-get $*"; [ "\${TEST_PURGE_FAIL:-0}" != 1 ]; }
jq() { ${shq(process.execPath.replaceAll('\\', '/'))} -e ${shq(jsonFilter)} -- "$@"; }
incus() {
  record "incus $*"
  [ "$1" = --force-local ] || die MUST_FORCE_LOCAL
  shift
  local project=default
  if [ "\${1:-}" = --project ]; then project=$2; shift 2; fi
  case "$*" in
    'query /1.0')
      [ "\${TEST_DAEMON_FAIL:-0}" != 1 ] || return 1
      if [ -n "\${TEST_SERVER:-}" ]; then printf '%s' "$TEST_SERVER"; else printf '{"environment":{"server_clustered":false}}'; fi ;;
    'project list -f json') printf '[{"name":"default"},{"name":"tenant"}]' ;;
    'storage list -f json') printf '[{"name":"default"}]' ;;
    'list -f json') printf '[{"name":"%s-vm"}]' "$project" ;;
    'image list -f json') printf '[{"fingerprint":"%s-image"}]' "$project" ;;
    'profile list -f json') printf '[{"name":"default"},{"name":"%s-profile"}]' "$project" ;;
    'storage volume list default -f json') printf '[{"name":"%s-data","type":"custom"},{"name":"image-vol","type":"image"}]' "$project" ;;
    'network list -f json') printf '[{"name":"%s-bridge","managed":true},{"name":"eth0","managed":false}]' "$project" ;;
    'delete default-vm --force') [ "\${TEST_DELETE_FAIL:-0}" != 1 ] ;;
    'profile edit default') cat >/dev/null ;;
    *delete*) return 0 ;;
    *) die "Unexpected Incus command: $*" ;;
  esac
}
${ui}
${uninstall}
NONINTERACTIVE=0
${body}
` });

describe('node removal', { timeout: 20_000 }, () => {
  it('can choose component or node removal from the main menu', () => {
    for (const action of ['uninstall-rfw', 'uninstall-agent', 'uninstall', 'cancel']) {
      const result = run(`ui_menu() { UI_VALUE=${action}; }; select_node_action; printf '%s' "$NODE_ACTION"`);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(action);
      expect(result.stderr).not.toContain('CALL:');
    }
  });

  for (const action of ['uninstall', 'uninstall-agent', 'uninstall-rfw']) {
    it(`refuses unattended ${action} without touching host services or data`, () => {
      for (const setup of [`prepare_install_ui --${action} --yes`, `NONINTERACTIVE=1; prepare_install_ui --${action}`]) {
        const result = run(setup);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--yes 不适用于删除操作');
        expect(result.stderr).not.toContain('CALL:');
      }
    });

    it(`cancels ${action} by default before any mutation`, () => {
      const result = run(`NODE_ACTION=${action}; ui_menu() { UI_VALUE=$2; }; dispatch_node_action`);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('已取消卸载');
      expect(result.stderr).not.toContain('CALL:');
    });
  }

  it('requires the second exact confirmation for full node removal', () => {
    const result = run(`NODE_ACTION=uninstall; ui_menu() { UI_VALUE=yes; }; ui_input() { UI_VALUE=yes; }; dispatch_node_action`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('确认文字不匹配');
    expect(result.stderr).not.toContain('CALL:');
  });

  it('keeps destructive confirmation defaulting to cancel in the inline UI', () => {
    const result = run(`exec 9>&1
read() { UI_VALUE=''; }
NODE_ACTION=uninstall
dispatch_node_action`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[y/N]');
    expect(result.stdout).toContain('已取消卸载');
    expect(result.stderr).not.toContain('CALL:');
  });

  it('removes RFW alone without touching instances, Agent, UFW or packages', () => {
    const result = run(`NODE_ACTION=uninstall-rfw; ui_menu() { UI_VALUE=yes; }; dispatch_node_action`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('systemctl stop rfw.service');
    expect(result.stderr).toContain('rm -rf --one-file-system -- /root/rfw');
    expect(result.stderr).not.toMatch(/CALL:incus|paledove-agent|CALL:apt-get|CALL:ufw/);
  });

  it('removes Agent keys and host fingerprints without touching Incus or RFW', () => {
    const result = run(`NODE_ACTION=uninstall-agent; ui_menu() { UI_VALUE=yes; }; dispatch_node_action`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('systemctl stop paledove-agent.service');
    expect(result.stderr).toContain('/etc/paledove/agent.env');
    expect(result.stderr).toContain('/var/lib/paledove/guest-known-hosts');
    expect(result.stderr).not.toMatch(/CALL:incus|rfw.service|CALL:apt-get/);
  });

  it('deletes resources in all projects before purging packages and fixed data directories', () => {
    const result = run(`NODE_ACTION=uninstall; ui_menu() { UI_VALUE=yes; }; ui_input() { UI_VALUE=YES; }; dispatch_node_action`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('incus --force-local --project tenant delete tenant-vm --force');
    expect(result.stderr).toContain('incus --force-local --project default storage volume delete default custom/default-data');
    expect(result.stderr).toContain('incus --force-local project delete tenant');
    expect(result.stderr).toContain('incus --force-local --project default storage delete default');
    expect(result.stderr).not.toMatch(/network delete eth0|volume delete default custom\/image-vol/);
    expect(result.stderr).toContain('apt-get purge -y -- incus incus-client incus-base:amd64');
    expect(result.stderr).not.toMatch(/purge.*unrelated|purge.*incus-tools|autoremove|pkill/);
    const calls = result.stderr;
    expect(calls.indexOf('delete tenant-vm --force')).toBeLessThan(calls.indexOf('profile edit default'));
    expect(calls.lastIndexOf('profile edit default')).toBeLessThan(calls.indexOf('storage volume delete'));
    expect(calls.indexOf('storage delete default')).toBeLessThan(calls.indexOf('apt-get purge'));
    expect(calls.indexOf('apt-get purge')).toBeLessThan(calls.indexOf('rm -rf --one-file-system -- /var/lib/incus'));
    expect(result.stdout).toContain('Incus 节点已卸载');
  });

  it('refuses clustered or unreachable daemons before stopping services or deleting files', () => {
    for (const [setup, message] of [[`TEST_SERVER='{"environment":{"server_clustered":true}}'`, '集群'], ['TEST_DAEMON_FAIL=1', '无法连接本机 Incus']] as const) {
      const result = run(`${setup}; remove_incus_node`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toMatch(/CALL:systemctl|CALL:rm|CALL:apt-get/);
    }
  });

  it('ignores Incus remote and socket environment overrides when cleaning this host', () => {
    const result = run(`INCUS_SOCKET=/tmp/other-incus.socket
INCUS_DIR=/srv/other-incus
INCUS_CONF=/tmp/other-client
incus() {
  [ "$1" = --force-local ] || die MUST_FORCE_LOCAL
  [ -z "\${INCUS_SOCKET:-}\${INCUS_DIR:-}\${INCUS_CONF:-}" ] || die CUSTOM_SOCKET_IN_USE
  printf '{"environment":{"server_clustered":false}}'
}
check_incus_removal`);
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not purge packages or wipe data if an instance could not be deleted', () => {
    const result = run('TEST_DELETE_FAIL=1; remove_incus_node');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('实例 default-vm 删除失败');
    expect(result.stderr).not.toMatch(/CALL:apt-get|rm -rf.*\/var\/lib\/incus/);
    expect(result.stdout).not.toContain('Incus 节点已卸载');
  });

  it('refuses residual mounts instead of recursively removing mounted data', () => {
    const result = run('TEST_MOUNT=/var/lib/incus/storage-pools/default; remove_incus_node');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('仍存在挂载');
    expect(result.stderr).not.toMatch(/CALL:apt-get|rm -rf.*\/var\/lib\/incus/);
  });

  it('preserves service files if the service has not actually stopped', () => {
    const result = run('TEST_ACTIVE=1; remove_rfw');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('服务仍在运行');
    expect(result.stderr).not.toContain('CALL:rm');
  });

  it('keeps the remaining data directories when package removal fails', () => {
    const result = run('TEST_PURGE_FAIL=1; remove_incus_node');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Incus 软件包卸载失败');
    expect(result.stderr).not.toContain('rm -rf --one-file-system -- /var/lib/incus');
  });

  it('persists a self-contained maintenance command without panel tokens or certificates', () => {
    const script = renderNodeInstallScript({
      panelUrl: 'https://private-panel.example.com', token: 'secret-node-install-token', nodeName: 'test',
      apiPort: 8443, poolName: 'default', storageDriver: 'dir', storageSource: null, storageSize: '20GiB',
      natNetwork: 'incusbr0', natCidr: '10.88.0.1/16', portRangeStart: 20000, portRangeEnd: 29999,
      publicIp: '', ipv6: false, ipv6Parent: '', panelCert: 'PRIVATE-PANEL-CERTIFICATE', agentInstallToken: 'pdi_secret-agent-token',
    });
    const saved = script.split("<<'PALEDOVE_NODE_MANAGEMENT'\n")[1]?.split('\nPALEDOVE_NODE_MANAGEMENT')[0];
    expect(saved).toBeTruthy();
    expect(saved).not.toMatch(/secret-node-install-token|pdi_secret|PRIVATE-PANEL-CERTIFICATE|private-panel.example.com|@@PALEDOVE_/);
    expect(spawnSync('bash', ['-n'], { input: saved, encoding: 'utf8' }).status).toBe(0);
    const help = spawnSync('bash', ['-s', '--', '--help'], { input: saved, encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('用法：paledove ');
    expect(help.stdout).toContain('paledove-node 仍可使用');
    expect(script).not.toContain('whiptail');
    // Exercise command publication with all system-path mutations intercepted.
    const publication = script.split('# Persist a token-free maintenance entry')[1]?.split('install_incus_zabbly()')[0];
    expect(publication).toBeTruthy();
    const published = run(`mktemp() { printf /dev/null; }
chmod() { record "chmod $*"; }
mv() { record "mv $*"; }
ln() { record "ln $*"; }
# The marker's first line is a comment suffix, not part of the publication code.
${publication!.slice(publication!.indexOf('\n') + 1)}`);
    expect(published.status, published.stderr).toBe(0);
    expect(published.stderr).toContain('CALL:chmod 755 /dev/null');
    expect(published.stderr).toContain('CALL:mv -f /dev/null /usr/local/sbin/paledove-node');
    expect(published.stderr).toContain('CALL:ln -sfnT -- /usr/local/sbin/paledove-node /usr/local/bin/paledove');
    const forbidden = spawnSync('bash', ['-s', '--', '--install', '--yes'], { input: saved, encoding: 'utf8' });
    expect(forbidden.status).toBe(1);
    expect(forbidden.stderr).toContain('本地维护命令仅支持卸载');
    expect(script.indexOf('dispatch_node_action\n')).toBeLessThan(script.indexOf('apt-get update'));
  });
});

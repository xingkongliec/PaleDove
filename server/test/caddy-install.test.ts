import { spawnSync } from 'node:child_process';
import forge from 'node-forge';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderCaddyInstallScript, shq } from '../src/services/agent/install-script.ts';

// Stand in for jq on Windows; certificate verification uses the real OpenSSL binary.
const jsonFilter = String.raw`
const fs = require('node:fs'), args = process.argv.slice(1);
if (args[0] === '-s') {
  const initial = JSON.parse(fs.readFileSync(args.at(-2), 'utf8'));
  const current = JSON.parse(fs.readFileSync(args.at(-1), 'utf8')) || {};
  const ca = args[args.indexOf('--arg') + 2];
  const apps = current.apps || {};
  console.log(JSON.stringify({ ...current,
    admin: { ...initial.admin, identity: { ...initial.admin.identity, issuers: [{module:'internal',ca}] } },
    apps: { ...apps, pki: { ...apps.pki, certificate_authorities: { ...apps.pki?.certificate_authorities, [ca]: { name:'PaleDove Admin', install_trust:false } } } },
  }));
} else if (args[0] === '-n') {
  const result = {};
  for (let i = 1; i < args.length - 1; i += 3) result[args[i + 1]] = args[i] === '--argjson' ? JSON.parse(args[i + 2]) : args[i + 2];
  console.log(JSON.stringify(result));
} else {
  const value = JSON.parse(fs.readFileSync(0, 'utf8')), expr = args.at(-1);
  if (expr.startsWith('.root_certificate')) {
    if (!value.root_certificate) process.exit(1);
    console.log(value.root_certificate);
  } else if (expr === '.ok == true') {
    console.log(value.ok === true); process.exit(value.ok === true ? 0 : 1);
  } else if (expr === '.message // .') console.log(value.message ?? JSON.stringify(value));
  else throw new Error('Unexpected JSON filter: ' + expr);
}
`;

describe('Caddy installer certificate readiness and callback', { timeout: 20_000 }, () => {
  let root: string;
  let valid: string;
  let expired: string;

  beforeAll(() => {
    const keys = forge.pki.rsa.generateKeyPair(2048);
    const issue = (cn: string, ca: boolean, issuer?: forge.pki.Certificate, isExpired = false) => {
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      cert.serialNumber = ca ? '01' : isExpired ? '02' : '03';
      cert.validity.notBefore = new Date(Date.now() - 7200_000);
      cert.validity.notAfter = new Date(Date.now() + (isExpired ? -3600_000 : 86400_000));
      cert.setSubject([{ name: 'commonName', value: cn }]);
      cert.setIssuer(issuer?.subject.attributes ?? cert.subject.attributes);
      cert.setExtensions([{ name: 'basicConstraints', cA: ca }, { name: 'extKeyUsage', serverAuth: true }]);
      cert.sign(keys.privateKey, forge.md.sha256.create());
      return cert;
    };
    const ca = issue('local-caddy-root', true);
    root = forge.pki.certificateToPem(ca);
    valid = forge.pki.certificateToPem(issue('local-caddy-server', false, ca));
    expired = forge.pki.certificateToPem(issue('local-caddy-server', false, ca, true));
  });

  const run = (setup: string) => {
    const script = renderCaddyInstallScript({
      panelUrl: 'https://panel.example.test', token: 'installation-token', nodeName: 'Test', adminPort: 2021,
      initialConfig: { admin: { listen: 'localhost:2019', remote: { listen: ':2021' } }, apps: {} },
    });
    // Run the real refresh/readiness/callback section; package and service installation never run.
    const section = script.slice(script.indexOf('info "刷新远程管理'));
    return spawnSync('bash', ['-s'], { encoding: 'utf8', input: `set -Eeuo pipefail
PANEL_URL=https://panel.example.test
TOKEN=installation-token
LOCALE=zh-CN
ADMIN_PORT=2021
UNIT=caddy-api
ATTEMPTS=0
RESPONSE='{"ok":true,"message":"registered"}'
ROOT=${shq(root)}
VALID=${shq(valid)}
EXPIRED=${shq(expired)}
info() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }
ufw() { return 1; }
caddy() { printf 'v2.test\n'; }
jq() { ${shq(process.execPath.replaceAll('\\', '/'))} -e ${shq(jsonFilter)} -- "$@"; }
sleep() { :; }
timeout() { shift; "$@"; }
openssl() {
  if [ "$1" = s_client ]; then
    ATTEMPTS=$((ATTEMPTS + 1))
    printf 'ATTEMPT:%s\n' "$ATTEMPTS" >&2
    if [ "$ATTEMPTS" -le "\${EXPIRED_ATTEMPTS:-0}" ]; then printf '%s' "$EXPIRED"; else printf '%s' "$VALID"; fi
    return 1
  fi
  command openssl "$@"
}
curl() {
  local output='' data='' url='' headers=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -o) output=$2; shift ;;
      --data-binary) data=$2; shift ;;
      -H) headers="$headers $2"; shift ;;
      http*) url=$1 ;;
    esac
    shift
  done
  case "$url" in
    */config/) printf '%s' '{"admin":{"listen":"localhost:2019","identity":{"issuers":[{"module":"internal","ca":"local"}]}},"storage":{"module":"file_system","root":"/srv/caddy"},"apps":{"http":{"servers":{"existing":{"listen":[":80"]}}},"pki":{"certificate_authorities":{"site-ca":{"name":"Existing site CA"}}}}}' > "$output" ;;
    */load)
      [[ "$headers" == *'Cache-Control: must-revalidate'* ]] || die MISSING_FORCED_RELOAD
      printf 'LOAD:' >&2; cat "\${data#@}" >&2; printf '\n' >&2 ;;
    */pki/ca/paledove-admin-*) printf 'CA:%s\n' "\${url##*/}" >&2; printf '{"root_certificate":%s}' "$(printf '%s' "$ROOT" | ${shq(process.execPath.replaceAll('\\', '/'))} -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>console.log(JSON.stringify(s)))')" ;;
    */caddy/register) printf 'REGISTER:%s\n' "$ATTEMPTS" >&2; printf '%s' "$RESPONSE" ;;
    *) die "Unexpected URL: $url" ;;
  esac
}
${setup}
${section}
` });
  };

  it('forces an identical configuration to reload, preserves sites and storage, and waits for a valid certificate', () => {
    const result = run('EXPIRED_ATTEMPTS=1');
    expect(result.status, result.stderr).toBe(0);
    const loaded = JSON.parse(result.stderr.match(/LOAD:(.*)/)![1]);
    expect(loaded).toMatchObject({
      admin: { remote: { listen: ':2021' } }, storage: { module: 'file_system', root: '/srv/caddy' },
      apps: { http: { servers: { existing: { listen: [':80'] } } } },
    });
    const ca = loaded.admin.identity.issuers[0].ca;
    expect(ca).toMatch(/^paledove-admin-[a-f0-9]{16}$/);
    expect(loaded.apps.pki.certificate_authorities).toEqual({
      'site-ca': { name: 'Existing site CA' },
      [ca]: { name: 'PaleDove Admin', install_trust: false },
    });
    expect(result.stderr).toContain(`CA:${ca}`);
    expect(result.stdout).toContain('完成');
    expect(result.stderr).toContain('REGISTER:2');
    expect(result.stderr).not.toContain('certificate has expired');
  });

  it('uses a new admin issuer on each installation instead of reusing an expired certificate cache', () => {
    const first = run('');
    const second = run('');
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const issuer = (output: string) => JSON.parse(output.match(/LOAD:(.*)/)![1]).admin.identity.issuers[0].ca;
    expect(issuer(first.stderr)).not.toBe(issuer(second.stderr));
  });

  it('does not register when the server certificate remains expired', () => {
    const result = run('EXPIRED_ATTEMPTS=999; sleep() { SECONDS=$((CERT_DEADLINE + 1)); }');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('certificate has expired');
    expect(result.stderr).toContain('notAfter=');
    expect(result.stdout).toContain('Host UTC:');
    expect(result.stderr).not.toContain('REGISTER');
    expect(result.stdout).not.toContain('完成');
  });

  it.each(['{"ok":false,"message":"panel clock is incorrect"}', 'not-json'])('returns failure for an unsuccessful callback: %s', (response) => {
    const result = run(`RESPONSE=${shq(response)}`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('panel verification failed');
    expect(result.stdout).not.toContain('完成！');
    if (response.startsWith('{')) expect(result.stderr).toContain('panel clock is incorrect');
  });
});

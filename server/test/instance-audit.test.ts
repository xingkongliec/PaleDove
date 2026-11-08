import { describe, expect, it } from 'vitest';
import { analyzeAuditData, auditProcessList, getBuiltinAuditRuleLibrary, parseAuditConnections, parseAuditProcesses, parseAuditStartupItems, redactAuditCommand } from '../src/services/instance-audit.ts';

describe('instance audit rules', () => {
  it('exposes a stable rule library without server-side regex details', () => {
    const rules = getBuiltinAuditRuleLibrary();
    expect(rules.map((r) => r.id)).toEqual(['mining.xmrig', 'mining.cpu', 'mining.gpu', 'mining.protocol', 'packet.flood', 'scanner.network', 'scanner.password', 'ddos.tools', 'proxy.core']);
    expect(rules[0]).toMatchObject({ source: 'BUILTIN', enabled: true, name: 'XMRig', category: 'MINING', risk: 'HIGH', matches: ['xmrig'] });
    expect(rules.find((rule) => rule.id === 'proxy.core')).toMatchObject({ category: 'PROXY', risk: 'LOW' });
    expect(rules[0]).not.toHaveProperty('pattern');
  });

  it('matches custom keyword rules without evaluating them as regular expressions', () => {
    const rules = [{
      id: 'custom.test', source: 'CUSTOM' as const, enabled: true, name: 'Test tool', category: 'PACKET' as const,
      risk: 'MEDIUM' as const, evidence: 'custom', matches: ['my-packet-tool'],
    }];
    expect(auditProcessList('  55 my-packet-tool --target 10.0.0.1', rules)).toEqual([
      expect.objectContaining({ pid: 55, ruleId: 'custom.test', category: 'PACKET', risk: 'MEDIUM' }),
    ]);
  });

  it('classifies suspicious tools and redacts secrets', () => {
    const findings = auditProcessList([
      '  12 xmrig xmrig --url stratum+tcp://pool.example --user wallet --token super-secret',
      '  22 nmap nmap -sS 10.0.0.0/8',
      '  33 xray xray run -config /etc/xray/config.json',
      '  44 sshd sshd: root@pts/0',
    ].join('\n'));
    expect(findings.map((f) => [f.pid, f.category])).toEqual(
      expect.arrayContaining([
        [12, 'MINING'],
        [22, 'SCANNER'],
        [33, 'PROXY'],
      ]),
    );
    expect(findings.find((f) => f.pid === 12)?.command).not.toContain('super-secret');
  });

  it('limits command output and removes query credentials', () => {
    const safe = redactAuditCommand('curl https://example.test/?token=abc&password=hunter2');
    expect(safe).toContain('token=[redacted]');
    expect(safe).toContain('password=[redacted]');
    expect(redactAuditCommand('x'.repeat(500))).toHaveLength(240);
  });

  it('parses process, network and startup evidence and applies typed rules', () => {
    const processes = parseAuditProcesses('12 1 root S 91.2 0.4 01:02 xmrig xmrig --token secret\n13 sshd sshd: root@pts/0');
    const connections = parseAuditConnections('tcp ESTAB 0 0 10.0.0.2:22 10.0.0.3:40122 users:((' + '"sshd",pid=13,fd=3))\nudp UNCONN 0 0 0.0.0.0:123 0.0.0.0:*');
    const startupItems = parseAuditStartupItems('[systemd]\nxray.service loaded active running\n[cron]\n*/5 * * * * /usr/local/bin/xray');
    expect(processes[0]).toMatchObject({ pid: 12, cpuPercent: 91.2, command: 'xmrig' });
    expect(connections).toHaveLength(2);
    expect(startupItems[1]).toMatchObject({ source: 'cron' });
    const analysis = analyzeAuditData({ processes, connections, startupItems, rules: [{ id: 'custom.xray', source: 'CUSTOM', enabled: true, name: 'Xray startup', category: 'PROXY', risk: 'HIGH', evidence: 'xray', matches: ['xray'], targetTypes: ['startup'], matchType: 'contains' }] });
    expect(analysis.summary.processCount).toBe(2);
    expect(analysis.findings.some((finding) => finding.targetType === 'startup')).toBe(true);
    expect(analysis.findings.some((finding) => finding.ruleId === 'anomaly.high-cpu')).toBe(true);
  });
});

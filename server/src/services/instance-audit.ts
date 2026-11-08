import type {
  InstanceAuditCategory,
  InstanceAuditConnectionDTO,
  InstanceAuditFindingDTO,
  InstanceAuditMatchType,
  InstanceAuditProcessDTO,
  InstanceAuditRisk,
  InstanceAuditRuleDTO,
  InstanceAuditStartupItemDTO,
  InstanceAuditSummaryDTO,
  InstanceAuditTarget,
} from '../shared/index.ts';
import { prisma } from '../lib/prisma.ts';

type Rule = Omit<InstanceAuditRuleDTO, 'enabled'> & { pattern: RegExp };
const RULE_META_PREFIX = '__paledove_audit_meta__:';

function decodeCustomRule(row: { id: number; ruleKey: string; name: string; category: string; risk: string; matches: unknown; enabled: boolean }): InstanceAuditRuleDTO {
  const rawMatches = Array.isArray(row.matches) ? row.matches.filter((value): value is string => typeof value === 'string') : [];
  let metadata: Partial<InstanceAuditRuleDTO> = {};
  const encoded = rawMatches.find((value) => value.startsWith(RULE_META_PREFIX));
  if (encoded) {
    try {
      metadata = JSON.parse(encoded.slice(RULE_META_PREFIX.length)) as Partial<InstanceAuditRuleDTO>;
    } catch {
      metadata = {};
    }
  }
  const matches = rawMatches.filter((value) => !value.startsWith(RULE_META_PREFIX));
  return {
    id: row.ruleKey,
    source: 'CUSTOM',
    databaseId: row.id,
    name: row.name,
    category: row.category as InstanceAuditCategory,
    risk: row.risk as InstanceAuditRisk,
    evidence: 'custom',
    matches,
    enabled: row.enabled,
    targetTypes: metadata.targetTypes ?? ['process'],
    matchType: metadata.matchType ?? 'contains',
    patternText: metadata.patternText ?? matches[0],
    caseSensitive: metadata.caseSensitive ?? false,
    description: metadata.description ?? null,
    recommendation: metadata.recommendation ?? null,
  };
}

// 规则只用于提示管理员进一步核实，不代表单凭进程名即可认定违规。
const RULES: Rule[] = [
  { id: 'mining.xmrig', source: 'BUILTIN', name: 'XMRig', category: 'MINING', risk: 'HIGH', evidence: 'xmrig', matches: ['xmrig'], pattern: /(?:^|[\\/\s])xmrig(?:$|[\s.-])/i },
  { id: 'mining.cpu', source: 'BUILTIN', name: 'CPU miners', category: 'MINING', risk: 'HIGH', evidence: 'cpuminer', matches: ['cpuminer', 'minerd', 'cgminer', 'bfgminer'], pattern: /(?:^|[\\/\s])(?:cpuminer|minerd|cgminer|bfgminer)(?:$|[\s.-])/i },
  { id: 'mining.gpu', source: 'BUILTIN', name: 'GPU miners', category: 'MINING', risk: 'HIGH', evidence: 'miner', matches: ['ethminer', 'nbminer', 't-rex', 'lolminer', 'ccminer', 'phoenixminer', 'nanominer'], pattern: /(?:^|[\\/\s])(?:ethminer|nbminer|t-rex|lolminer|ccminer|phoenixminer|nanominer)(?:$|[\s.-])/i },
  { id: 'mining.protocol', source: 'BUILTIN', name: 'Mining protocols', category: 'MINING', risk: 'MEDIUM', evidence: 'stratum', matches: ['stratum', 'cryptonight', 'kawpow', 'nicehash', 'nanopool'], pattern: /(?:stratum|cryptonight|kawpow|nicehash|nanopool)/i },
  { id: 'packet.flood', source: 'BUILTIN', name: 'Packet generators', category: 'PACKET', risk: 'HIGH', evidence: 'packet tool', matches: ['hping3', 'nping', 'tcpreplay', 'packeth', 'mz', 'sendip', 'pktgen'], pattern: /(?:^|[\\/\s])(?:hping3|nping|tcpreplay|packeth|mz|sendip|pktgen)(?:$|[\s.-])/i },
  { id: 'scanner.network', source: 'BUILTIN', name: 'Network scanners', category: 'SCANNER', risk: 'HIGH', evidence: 'scanner', matches: ['nmap', 'masscan', 'zmap', 'rustscan', 'nikto', 'sqlmap', 'nuclei', 'gobuster', 'dirb', 'ffuf', 'amass', 'zgrab', 'httpx'], pattern: /(?:^|[\\/\s])(?:nmap|masscan|zmap|rustscan|nikto|sqlmap|nuclei|gobuster|dirb|ffuf|amass|zgrab|httpx)(?:$|[\s.-])/i },
  { id: 'scanner.password', source: 'BUILTIN', name: 'Credential scanners', category: 'SCANNER', risk: 'HIGH', evidence: 'password scanner', matches: ['hydra', 'medusa', 'msfconsole', 'metasploit'], pattern: /(?:^|[\\/\s])(?:hydra|medusa|msfconsole|metasploit)(?:$|[\s.-])/i },
  { id: 'ddos.tools', source: 'BUILTIN', name: 'DDoS tools', category: 'DDOS', risk: 'HIGH', evidence: 'ddos tool', matches: ['slowloris', 'torshammer', 'goldeneye', 'hulk', 'xerxes', 'mhddos', 'loic', 'hoic', 'udp-flood', 'tcp-flood', 'syn-flood'], pattern: /(?:^|[\\/\s])(?:slowloris|torshammer|goldeneye|hulk|xerxes|mhddos|loic|hoic|udp[_-]?flood|tcp[_-]?flood|syn[_-]?flood)(?:$|[\s.-])/i },
  { id: 'proxy.core', source: 'BUILTIN', name: 'Proxy cores', category: 'PROXY', risk: 'LOW', evidence: 'proxy core', matches: ['xray', 'v2ray', 'sing-box', 'clash', 'frp', 'gost', 'shadowsocks', 'brook', 'trojan', 'hysteria', 'ngrok', '3proxy', 'tinyproxy', 'squid', 'privoxy', 'microsocks', 'redsocks', 'haproxy', 'tor'], pattern: /(?:^|[\\/\s])(?:xray|xray-core|v2ray|v2ray-plugin|sing-box|singbox|clash|clash-meta|frpc|frps|gost|ss-server|shadowsocks|brook|trojan|hysteria|ngrok|3proxy|tinyproxy|squid|privoxy|microsocks|redsocks|haproxy|tor)(?:$|[\s.-])/i },
];

const MAX_COMMAND_LENGTH = 240;

/** 内置规则库，不暴露服务端正则表达式。 */
export function getBuiltinAuditRuleLibrary(): InstanceAuditRuleDTO[] {
  return RULES.map(({ pattern: _pattern, ...rule }) => ({
    ...rule,
    enabled: true,
    matches: [...rule.matches],
    targetTypes: ['process', 'startup'],
    matchType: 'regex',
    patternText: _pattern.source,
    caseSensitive: false,
  }));
}

/** 加载内置规则与数据库中的自定义规则。禁用规则只在规则管理界面返回。 */
export async function loadAuditRuleLibrary(includeDisabled = false): Promise<InstanceAuditRuleDTO[]> {
  const rows = await prisma.instanceAuditRule.findMany({
    where: includeDisabled ? undefined : { enabled: true },
    orderBy: { id: 'asc' },
  });
  return [...getBuiltinAuditRuleLibrary().map((rule) => ({ ...rule, enabled: true })), ...rows.map(decodeCustomRule)];
}

/** 将扩展规则选项放入现有 JSON 字段，兼容已经部署的规则表。 */
export function encodeCustomRuleMatches(matches: string[], options: Partial<InstanceAuditRuleDTO>): string[] {
  const metadata = {
    targetTypes: options.targetTypes,
    matchType: options.matchType,
    patternText: options.patternText,
    caseSensitive: options.caseSensitive,
    description: options.description,
    recommendation: options.recommendation,
  };
  return [`${RULE_META_PREFIX}${JSON.stringify(metadata)}`, ...matches];
}

/** 删除常见的密码、令牌和 URL 查询参数，避免把敏感值带入管理后台或日志。 */
export function redactAuditCommand(input: string): string {
  return input
    .replace(/([?&](?:token|secret|key|password|passwd|auth)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/((?:pass(?:word|wd)?|token|secret|api[_-]?key|private[_-]?key)\s*(?:=|:)\s*|(?:pass(?:word|wd)?|token|secret|api[_-]?key|private[_-]?key)\s+)[^\s&]+/gi, '$1[redacted]')
    .slice(0, MAX_COMMAND_LENGTH);
}

function normalizeCommand(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function parseNumber(value: string | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 解析 ps -eo pid,ppid,user,stat,pcpu,pmem,etime,comm,args 的输出。 */
export function parseAuditProcesses(stdout: string, limit = 300): InstanceAuditProcessDTO[] {
  const rows: InstanceAuditProcessDTO[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw) continue;
    const full = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(raw);
    const compact = /^(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(raw);
    if (full) {
      rows.push({
        pid: Number(full[1]),
        ppid: parseNumber(full[2]),
        user: full[3]!,
        stat: full[4]!,
        cpuPercent: parseNumber(full[5]),
        memoryPercent: parseNumber(full[6]),
        elapsed: full[7]!,
        command: full[8]!,
        args: normalizeCommand(full[9] ?? full[8]!),
        findings: [],
      });
    } else if (compact) {
      rows.push({
        pid: Number(compact[1]),
        ppid: null,
        user: '',
        stat: '',
        cpuPercent: null,
        memoryPercent: null,
        elapsed: '',
        command: compact[2]!,
        args: normalizeCommand(compact[3] ?? compact[2]!),
        findings: [],
      });
    } else continue;
    if (rows.length >= limit) break;
  }
  return rows;
}

function parseConnectionProcess(value: string): { process: string | null; pid: number | null } {
  const pid = /(?:^|[,\s])pid=(\d+)/i.exec(value)?.[1];
  return { process: value || null, pid: pid ? Number(pid) : null };
}

/** 解析 ss -H -tunap / netstat -tunap，兼容两者常见列顺序。 */
export function parseAuditConnections(stdout: string, limit = 300): InstanceAuditConnectionDTO[] {
  const rows: InstanceAuditConnectionDTO[] = [];
  const states = new Set(['ESTAB', 'ESTABLISHED', 'LISTEN', 'UNCONN', 'TIME-WAIT', 'SYN-SENT', 'SYN-RECV', 'CLOSE-WAIT', 'FIN-WAIT-1', 'FIN-WAIT-2', 'CLOSING', 'LAST-ACK', 'CLOSED']);
  for (const rawLine of stdout.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw || /^(Netid|Proto|Active|State\s)/i.test(raw)) continue;
    const fields = raw.split(/\s+/);
    if (fields.length < 3 || !/^(tcp|udp|unix|sctp)/i.test(fields[0]!)) continue;
    const stateIndex = fields.findIndex((field) => states.has(field.toUpperCase()));
    // ss: proto,state,recv-q,send-q,local,peer; netstat: proto,recv-q,send-q,local,peer,state
    const localIndex = stateIndex === 1 ? 4 : stateIndex >= 5 ? 3 : fields.length >= 5 ? 3 : 1;
    const state = stateIndex >= 0 ? fields[stateIndex]! : (/^udp/i.test(fields[0]!) ? 'UNCONN' : '');
    const local = fields[localIndex] ?? '';
    const peer = fields[localIndex + 1] ?? '';
    const processText = fields.slice(localIndex + 2).join(' ');
    const parsed = parseConnectionProcess(processText);
    rows.push({ protocol: fields[0]!, state, local, peer, process: parsed.process, pid: parsed.pid, evidence: redactAuditCommand(raw), findings: [] });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** 解析带有 [systemd] / [cron] 等分段标记的启动项输出。 */
export function parseAuditStartupItems(stdout: string, limit = 200): InstanceAuditStartupItemDTO[] {
  const rows: InstanceAuditStartupItemDTO[] = [];
  let source = 'startup';
  for (const rawLine of stdout.split(/\r?\n/)) {
    const raw = rawLine.trim();
    if (!raw) continue;
    const section = /^\[([^\]]+)\]$/.exec(raw);
    if (section) {
      source = section[1]!;
      continue;
    }
    rows.push({ source, command: redactAuditCommand(normalizeCommand(raw)), findings: [] });
    if (rows.length >= limit) break;
  }
  return rows;
}

function matchRule(rule: InstanceAuditRuleDTO, text: string): string | null {
  const pattern = rule.patternText?.trim() || rule.matches[0]?.trim();
  if (!pattern) return null;
  const caseSensitive = rule.caseSensitive === true;
  const haystack = caseSensitive ? text : text.toLocaleLowerCase();
  const needle = caseSensitive ? pattern : pattern.toLocaleLowerCase();
  if (rule.matchType === 'exact') return haystack.trim() === needle.trim() ? pattern : null;
  if (rule.matchType === 'regex') {
    try {
      const match = text.match(new RegExp(pattern, caseSensitive ? '' : 'i'));
      return match?.[0] ?? null;
    } catch {
      return null;
    }
  }
  return haystack.includes(needle) ? pattern : null;
}

function severityRank(value: string): number {
  return ({ info: 0, LOW: 1, low: 1, medium: 2, MEDIUM: 2, high: 3, HIGH: 3 } as Record<string, number>)[value] ?? 0;
}

function findingCategory(rule: InstanceAuditRuleDTO | undefined, fallback: InstanceAuditCategory = 'PROXY'): InstanceAuditCategory {
  return rule?.category ?? fallback;
}

/** 对三类采集结果进行规则匹配，并生成风险摘要。不会修改实例内容。 */
export function analyzeAuditData(input: {
  processes: InstanceAuditProcessDTO[];
  connections: InstanceAuditConnectionDTO[];
  startupItems: InstanceAuditStartupItemDTO[];
  rules?: InstanceAuditRuleDTO[];
}): { findings: InstanceAuditFindingDTO[]; summary: InstanceAuditSummaryDTO } {
  const rules = (input.rules ?? getBuiltinAuditRuleLibrary()).filter((rule) => rule.enabled);
  const findings: InstanceAuditFindingDTO[] = [];
  const add = (rule: InstanceAuditRuleDTO | undefined, targetType: InstanceAuditTarget, subject: string, evidence: string, pid?: number | null, matchedText?: string) => {
    if (!rule || !matchedText) return;
    findings.push({
      pid: pid ?? 0,
      process: subject.slice(0, 128),
      ruleId: rule.id,
      category: findingCategory(rule),
      risk: rule.risk,
      command: redactAuditCommand(evidence),
      evidence: rule.evidence,
      targetType,
      ruleName: rule.name,
      matchedText: redactAuditCommand(matchedText),
      recommendation: rule.recommendation ?? null,
      detail: `${targetType} matched ${rule.name}`,
    });
  };
  for (const process of input.processes) {
    const text = `${process.command} ${process.args}`.trim();
    for (const rule of rules) {
      if (!(rule.targetTypes ?? ['process']).includes('process')) continue;
      const matched = rule.source === 'BUILTIN' && !rule.matchType ? (RULES.find((candidate) => candidate.id === rule.id)?.pattern.test(text) ? text : null) : matchRule(rule, text);
      if (!matched) continue;
      process.findings.push(rule.name);
      add(rule, 'process', `PID ${process.pid} (${process.command})`, `${process.command} ${process.args}`, process.pid, matched);
    }
  }
  for (const item of input.startupItems) {
    for (const rule of rules) {
      if (!(rule.targetTypes ?? ['process']).includes('startup')) continue;
      const matched = matchRule(rule, item.command);
      if (!matched) continue;
      item.findings.push(rule.name);
      add(rule, 'startup', `source ${item.source}`, item.command, null, matched);
    }
  }
  for (const connection of input.connections) {
    for (const rule of rules) {
      if (!(rule.targetTypes ?? ['process']).includes('network')) continue;
      const matched = matchRule(rule, connection.evidence);
      if (!matched) continue;
      connection.findings.push(rule.name);
      add(rule, 'network', `${connection.protocol} ${connection.local} -> ${connection.peer}`, connection.evidence, connection.pid, matched);
    }
  }
  const udp = input.connections.filter((connection) => /^udp/i.test(connection.protocol));
  if (udp.length >= 100) {
    findings.push({ pid: 0, process: 'network', ruleId: 'anomaly.udp-volume', category: 'ANOMALY', risk: 'MEDIUM', command: '', evidence: `UDP connections: ${udp.length}`, targetType: 'network', detail: 'UDP connection count is unusually high' });
  }
  for (const process of input.processes.filter((item) => (item.cpuPercent ?? 0) >= 80).slice(0, 5)) {
    findings.push({ pid: process.pid, process: process.command, ruleId: 'anomaly.high-cpu', category: 'ANOMALY', risk: 'MEDIUM', command: redactAuditCommand(`${process.command} ${process.args}`), evidence: `${process.cpuPercent}% CPU`, targetType: 'process', detail: 'CPU usage is unusually high' });
  }
  const risk = findings.reduce<InstanceAuditSummaryDTO['riskLevel']>((current, finding) => {
    if (severityRank(finding.risk) <= severityRank(current)) return current;
    return finding.risk === 'HIGH' ? 'high' : finding.risk === 'MEDIUM' ? 'medium' : 'low';
  }, 'info');
  return {
    findings,
    summary: {
      riskLevel: risk,
      processCount: input.processes.length,
      connectionCount: input.connections.length,
      listeningCount: input.connections.filter((item) => item.state.toUpperCase() === 'LISTEN').length,
      startupItemCount: input.startupItems.length,
      findingCount: findings.length,
    },
  };
}

export function buildAuditCommands(): { process: string; network: string; startup: string } {
  return {
    process: 'ps -eo pid,ppid,user,stat,pcpu,pmem,etime,comm,args --no-headers 2>/dev/null | head -n 300 || true',
    network: '(ss -H -tunap 2>/dev/null || netstat -tunap 2>/dev/null || true) | head -n 300',
    startup: [
      'printf "[systemd]\\n"',
      '(systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null | head -n 80 || true)',
      'printf "[cron]\\n"',
      '(crontab -l 2>/dev/null || true)',
      'printf "[rc-local]\\n"',
      '(test -f /etc/rc.local && sed -n "1,120p" /etc/rc.local || true)',
      'printf "[supervisor]\\n"',
      '(command -v supervisorctl >/dev/null 2>&1 && supervisorctl status 2>/dev/null || true)',
      'printf "[pm2]\\n"',
      '(command -v pm2 >/dev/null 2>&1 && pm2 list --no-color 2>/dev/null || true)',
    ].join('; '),
  };
}

/** 解析 `ps -eo pid=,comm=,args=` 的一行并匹配可疑工具规则。 */
export function auditProcessList(stdout: string, rules: InstanceAuditRuleDTO[] = getBuiltinAuditRuleLibrary()): InstanceAuditFindingDTO[] {
  const findings: InstanceAuditFindingDTO[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const process = match[2]!;
    const command = `${process}${match[3] ? ` ${match[3]}` : ''}`.trim();
    const safeCommand = redactAuditCommand(command);
    for (const rule of rules) {
      const builtin = RULES.find((candidate) => candidate.id === rule.id);
      const matched = builtin ? builtin.pattern.test(command) : rule.matches.some((term) => command.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
      if (!matched) continue;
      const key = `${pid}:${rule.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ pid, process: process.slice(0, 128), ruleId: rule.id, category: rule.category, risk: rule.risk, command: safeCommand, evidence: rule.evidence });
    }
  }
  return findings.slice(0, 500);
}


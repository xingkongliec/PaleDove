// 宿主机运维：通过 Incus API 直接读取宿主机上的全部实例，按面板记录分类（已登记 / 残留 / 其他），
// 以及数据库里应在这台宿主机上但找不到的实例；已登记的实例与面板基线比对，可提交基线同步、网络修复任务，
// 并按面板流程开关机、修改配置、删除（可选退款）；未登记的实例在这里直接开关机、编辑配额、查看配置、删除。
// 运行中的实例都可以打开网页终端（窗口由 TerminalDock 管理，离开运维页时断开）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ellipsis, RefreshCw, Network, ListRestart, SquareTerminal, ShieldAlert, ShieldCheck, ListFilter, Plus, Pencil, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AdminInstanceDTO, BatchResultDTO, DeleteRefundMode, HostInstanceDTO, HostInstancesDTO, InstanceAuditBatchDTO, InstanceAuditResultDTO, InstanceAuditRuleDTO, InstanceDriftDTO, NodeDTO } from '../../../shared/index';
import { TerminalDockProvider, useTerminalDock } from '@/components/TerminalDock';
import { InstanceStatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Modal } from '@/components/ui/dialog';
import { FormField, Input, InputGroup, Textarea } from '@/components/ui/input';
import { DropdownMenu, type MenuItem } from '@/components/ui/menu';
import { Alert, Badge, CodeBlock, Empty, ErrorState, Switch, Tag } from '@/components/ui/misc';
import { Select } from '@/components/ui/select';
import { DataTable } from '@/components/ui/table';
import { useT, type MessageKey } from '@/i18n';
import { api, errorText } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatBytes, fromNow } from '@/lib/format';
import { toast } from '@/lib/toast';
import { BatchConfigDialog } from '../instances/BatchConfigDialog';
import { DeleteDialog } from '../instances/DeleteDialog';

type View = 'all' | 'managed' | 'orphan' | 'other' | 'drift' | 'missing';
type OpsKind = 'baseline' | 'network';

const AUDIT_CATEGORY: Record<InstanceAuditResultDTO['findings'][number]['category'], MessageKey> = {
  MINING: 'ops.auditMining',
  PACKET: 'ops.auditPacket',
  SCANNER: 'ops.auditScanner',
  DDOS: 'ops.auditDdos',
  PROXY: 'ops.auditProxy',
  ANOMALY: 'ops.auditAnomaly',
};
const AUDIT_RISK: Record<InstanceAuditRuleDTO['risk'], MessageKey> = { HIGH: 'ops.auditHigh', MEDIUM: 'ops.auditMedium', LOW: 'ops.auditLow' };
const AUDIT_CATEGORIES: InstanceAuditRuleDTO['category'][] = ['MINING', 'PACKET', 'SCANNER', 'DDOS', 'PROXY'];

const CATEGORY: Record<HostInstanceDTO['category'], [MessageKey, 'success' | 'danger' | 'neutral']> = {
  managed: ['ops.managed', 'success'],
  orphan: ['ops.orphan', 'danger'],
  other: ['ops.other', 'neutral'],
};

/** 差异项的名称 */
const DRIFT_LABEL: Record<string, MessageKey> = {
  'limits.cpu': 'ops.key.cpu',
  'limits.memory': 'ops.key.memory',
  'limits.cpu.allowance': 'ops.key.cpuAllowance',
  'limits.cpu.priority': 'ops.key.cpuPriority',
  'limits.processes': 'ops.key.processes',
  'boot.autostart': 'ops.key.autostart',
  'boot.autostart.delay': 'ops.key.bootDelay',
  'boot.autostart.priority': 'ops.key.bootPriority',
  'boot.stop.priority': 'ops.key.stopPriority',
  'boot.host_shutdown_timeout': 'ops.key.shutdownTimeout',
  'root.limits.read': 'ops.key.rootRead',
  'root.limits.write': 'ops.key.rootWrite',
  'user.paledove.id': 'ops.key.panelId',
  'security.nesting': 'ops.key.nesting',
  'security.secureboot': 'ops.key.secureboot',
  'root.size': 'ops.key.rootSize',
  power: 'ops.key.power',
  eth0: 'ops.key.eth0',
  eth1: 'ops.key.eth1',
  'eth0.limits': 'ops.key.eth0Limits',
  'eth1.limits': 'ops.key.eth1Limits',
  proxy: 'ops.key.proxy',
  'guest.ipv4': 'ops.key.guestIpv4',
  'guest.ipv6': 'ops.key.guestIpv6',
};

const countOf = (i: HostInstanceDTO, kind: InstanceDriftDTO['kind']) => i.drift.filter((d) => d.kind === kind).length;

function PowerState({ status }: { status: string }) {
  const t = useT();
  const running = status === 'Running';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px]', running ? 'text-success-text' : status === 'Stopped' ? 'text-fg-3' : 'text-warning-text')}>
      <span className={cn('size-1.5 rounded-full', running ? 'bg-success' : status === 'Stopped' ? 'bg-fg-4' : 'bg-warning')} />
      {running ? t('ops.running') : status === 'Stopped' ? t('ops.stopped') : status}
    </span>
  );
}

/** 基线比对结果：一致 / 配置偏离 / 网络异常 */
function DriftBadges({ inst, onOpen }: { inst: HostInstanceDTO; onOpen: () => void }) {
  const t = useT();
  if (inst.category !== 'managed') return <span className="text-xs text-fg-4">—</span>;
  const base = countOf(inst, 'baseline');
  const net = countOf(inst, 'network');
  if (!base && !net) return <Badge tone="success" dot>{t('ops.inSync')}</Badge>;
  return (
    <button type="button" onClick={onOpen} className="flex flex-wrap gap-1 text-left hover:opacity-80">
      {base > 0 && <Badge tone="warning" dot>{t('ops.baselineDrift', { n: base })}</Badge>}
      {net > 0 && <Badge tone="danger" dot>{t('ops.networkDrift', { n: net })}</Badge>}
    </button>
  );
}

function AuditStatus({ result }: { result: InstanceAuditResultDTO }) {
  const t = useT();
  if (result.status === 'SUSPICIOUS') return <Badge tone="danger" dot><ShieldAlert className="size-3" />{t('ops.auditSuspicious')}</Badge>;
  if (result.status === 'CLEAN') return <Badge tone="success" dot><ShieldCheck className="size-3" />{t('ops.auditClean')}</Badge>;
  if (result.status === 'STOPPED') return <Badge tone="neutral">{t('ops.auditStopped')}</Badge>;
  if (result.status === 'UNSUPPORTED') return <Badge tone="warning">{t('ops.auditUnsupported')}</Badge>;
  return <Badge tone="warning">{t('ops.auditError')}</Badge>;
}

function AuditRuleFormDialog({ rule, onClose, onSaved }: { rule: InstanceAuditRuleDTO | 'new' | null; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const current = rule && rule !== 'new' ? rule : null;
  const [name, setName] = useState('');
  const [category, setCategory] = useState<InstanceAuditRuleDTO['category']>('MINING');
  const [risk, setRisk] = useState<InstanceAuditRuleDTO['risk']>('MEDIUM');
  const [matches, setMatches] = useState('');
  const [targetTypes, setTargetTypes] = useState<NonNullable<InstanceAuditRuleDTO['targetTypes']>>(['process']);
  const [matchType, setMatchType] = useState<NonNullable<InstanceAuditRuleDTO['matchType']>>('contains');
  const [patternText, setPatternText] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [recommendation, setRecommendation] = useState('');
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setName(current?.name ?? '');
    setCategory(current?.category ?? 'MINING');
    setRisk(current?.risk ?? 'MEDIUM');
    setMatches(current?.matches.join(', ') ?? '');
    setTargetTypes(current?.targetTypes ?? ['process']);
    setMatchType(current?.matchType ?? 'contains');
    setPatternText(current?.patternText ?? '');
    setCaseSensitive(current?.caseSensitive ?? false);
    setRecommendation(current?.recommendation ?? '');
    setEnabled(current?.enabled ?? true);
  }, [current]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), category, risk, matches: matches.split(/[,\n]/).map((item) => item.trim()).filter(Boolean), targetTypes, matchType, patternText: patternText.trim() || undefined, caseSensitive, recommendation: recommendation.trim() || null, enabled };
      return current?.databaseId ? api.patch(`/admin/audit-rules/${current.databaseId}`, body) : api.post('/admin/audit-rules', body);
    },
    onSuccess: () => {
      toast.success(t('ops.auditRuleSaved'));
      onSaved();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  const valid = name.trim().length > 0 && targetTypes.length > 0 && (matchType === 'regex' ? patternText.trim().length > 0 : matches.split(/[,\n]/).some((item) => item.trim()));
  const toggleTarget = (target: (typeof targetTypes)[number]) => setTargetTypes((current) => current.includes(target) ? current.filter((item) => item !== target) : [...current, target]);
  return (
    <Modal
      open={!!rule}
      onOpenChange={(open) => !open && onClose()}
      title={current ? t('ops.auditRuleEdit') : t('ops.auditRuleCreate')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label={t('ops.auditRuleName')} required>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} autoFocus />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('ops.auditRuleCategory')} required>
            <Select value={category} onChange={setCategory} options={AUDIT_CATEGORIES.map((value) => ({ value, label: t(AUDIT_CATEGORY[value]) }))} />
          </FormField>
          <FormField label={t('ops.auditRuleRisk')} required>
            <Select
              value={risk}
              onChange={setRisk}
              options={[
                { value: 'HIGH', label: t('ops.auditHigh') },
                { value: 'MEDIUM', label: t('ops.auditMedium') },
                { value: 'LOW', label: t('ops.auditLow') },
              ]}
            />
          </FormField>
        </div>
        <FormField label={t('ops.auditRuleMatches')} description={t('ops.auditRuleMatchesHint')} required>
          <Textarea rows={4} value={matches} onChange={(e) => setMatches(e.target.value)} placeholder="xmrig, my-miner" />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={t('ops.auditRuleTarget')} required>
            <div className="flex flex-wrap gap-2 text-xs">
              {(['process', 'network', 'startup'] as const).map((target) => <label key={target} className="inline-flex items-center gap-1.5"><input type="checkbox" checked={targetTypes.includes(target)} onChange={() => toggleTarget(target)} />{t(`ops.auditTarget${target[0].toUpperCase()}${target.slice(1)}` as MessageKey)}</label>)}
            </div>
          </FormField>
          <FormField label={t('ops.auditRuleMatchType')}>
            <Select value={matchType} onChange={setMatchType} options={[{ value: 'contains', label: t('ops.auditMatchContains') }, { value: 'regex', label: t('ops.auditMatchRegex') }, { value: 'exact', label: t('ops.auditMatchExact') }]} />
          </FormField>
        </div>
        {matchType === 'regex' && <FormField label={t('ops.auditRulePattern')} description={t('ops.auditRulePatternHint')}><Input value={patternText} maxLength={500} onChange={(e) => setPatternText(e.target.value)} /></FormField>}
        <FormField label={t('ops.auditRuleRecommendation')}><Textarea rows={2} value={recommendation} maxLength={500} onChange={(e) => setRecommendation(e.target.value)} /></FormField>
        <Switch checked={caseSensitive} onCheckedChange={setCaseSensitive} label={t('ops.auditRuleCaseSensitive')} />
        <Switch checked={enabled} onCheckedChange={setEnabled} label={t('ops.auditRuleEnabled')} />
      </div>
    </Modal>
  );
}

function AuditRuleLibraryDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<InstanceAuditRuleDTO | 'new' | null>(null);
  const q = useQuery({ queryKey: ['audit-rules'], queryFn: () => api.get<{ rules: InstanceAuditRuleDTO[] }>('/admin/audit-rules') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['audit-rules'] });
    void qc.invalidateQueries({ queryKey: ['node-audit-rules'] });
  };
  const patch = useMutation({
    mutationFn: (rule: InstanceAuditRuleDTO) => api.patch(`/admin/audit-rules/${rule.databaseId}`, { enabled: !rule.enabled }),
    onSuccess: refresh,
    onError: (e) => toast.fromError(e),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.delete(`/admin/audit-rules/${id}`),
    onSuccess: refresh,
    onError: (e) => toast.fromError(e),
  });
  const rules = q.data?.rules ?? [];
  const askDelete = async (rule: InstanceAuditRuleDTO) => {
    if (!rule.databaseId) return;
    if (!(await confirm({ title: t('ops.auditRuleDeleteTitle', { name: rule.name }), description: t('ops.auditRuleDeleteDesc'), danger: true }))) return;
    remove.mutate(rule.databaseId);
  };
  return (
    <>
      <Modal
        open
        onOpenChange={(open) => !open && onClose()}
        size="xl"
        title={t('ops.auditLibrary')}
        description={t('ops.auditLibraryManageDesc')}
        footer={
          <>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
              {t('ops.auditRuleCreate')}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {q.isLoading && <div className="text-xs text-fg-3">{t('common.loading')}</div>}
          {rules.map((rule) => (
            <div key={rule.id} className={cn('rounded-md bg-surface-2 px-2.5 py-2 text-xs', !rule.enabled && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[11px] text-fg-3">{rule.id}</span>
                <Tag>{t(AUDIT_CATEGORY[rule.category])}</Tag>
                <Badge tone={rule.risk === 'HIGH' ? 'danger' : rule.risk === 'MEDIUM' ? 'warning' : 'neutral'}>{t(AUDIT_RISK[rule.risk])}</Badge>
                <span className="font-medium text-fg-2">{rule.name}</span>
                {rule.source === 'BUILTIN' ? (
                  <Badge>{t('ops.auditBuiltin')}</Badge>
                ) : (
                  <div className="ml-auto flex items-center gap-0.5">
                    <Switch checked={rule.enabled} onCheckedChange={() => patch.mutate(rule)} label={rule.enabled ? t('common.enabled') : t('common.disabled')} />
                    <Button size="icon-sm" variant="ghost" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => setEditing(rule)}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="danger-ghost" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => void askDelete(rule)}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
              <div className="mt-1 break-words text-[11px] text-fg-3">{rule.matches.join(', ')}</div>
            </div>
          ))}
          {!q.isLoading && rules.length === 0 && <Empty title={t('ops.auditRuleEmpty')} />}
        </div>
      </Modal>
      <AuditRuleFormDialog rule={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    </>
  );
}

function AuditDialog({ node, names, onClose }: { node: NodeDTO; names: string[]; onClose: () => void }) {
  const t = useT();
  const [result, setResult] = useState<InstanceAuditBatchDTO | null>(null);
  const rulesQuery = useQuery({
    queryKey: ['node-audit-rules', node.id],
    queryFn: () => api.get<{ rules: InstanceAuditRuleDTO[] }>(`/admin/nodes/${node.id}/ops/audit-rules`),
    staleTime: 5 * 60_000,
  });
  const audit = useMutation({
    mutationFn: () => api.post<InstanceAuditBatchDTO>(`/admin/nodes/${node.id}/ops/audit`, { names }),
    onSuccess: setResult,
    onError: (e) => toast.fromError(e),
  });
  useEffect(() => {
    setResult(null);
  }, [names]);
  const rows = result?.results ?? [];
  const rules = rulesQuery.data?.rules ?? result?.rules ?? [];
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="xl"
      title={t('ops.auditTitle')}
      description={t('ops.auditDesc', { n: names.length })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button variant="primary" icon={<ShieldCheck />} loading={audit.isPending} onClick={() => audit.mutate()}>
            {t('ops.auditRun')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {!result ? (
          <Alert tone="warning" icon={<ShieldAlert />}>
            {t('ops.auditReadonly')}
          </Alert>
        ) : (
          <>
            <Alert tone={rows.some((r) => r.status === 'SUSPICIOUS') ? 'danger' : 'success'}>
              {rows.some((r) => r.status === 'SUSPICIOUS') ? t('ops.auditFound', { n: rows.filter((r) => r.status === 'SUSPICIOUS').length }) : t('ops.auditNoFindings')}
            </Alert>
            {rows.some((r) => r.summary) && (
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                {[
                  ['ops.auditFindingCount', rows.reduce((sum, row) => sum + (row.summary?.findingCount ?? row.findings.length), 0)],
                  ['ops.auditProcessCount', rows.reduce((sum, row) => sum + (row.summary?.processCount ?? row.processes?.length ?? 0), 0)],
                  ['ops.auditConnectionCount', rows.reduce((sum, row) => sum + (row.summary?.connectionCount ?? row.connections?.length ?? 0), 0)],
                  ['ops.auditListeningCount', rows.reduce((sum, row) => sum + (row.summary?.listeningCount ?? 0), 0)],
                  ['ops.auditStartupCount', rows.reduce((sum, row) => sum + (row.summary?.startupItemCount ?? row.startupItems?.length ?? 0), 0)],
                ].map(([label, value]) => <div key={label} className="rounded-md bg-surface-2 px-2.5 py-2"><div className="text-[11px] text-fg-3">{t(label as MessageKey)}</div><div className="mt-0.5 text-lg font-semibold tabular-nums">{value}</div></div>)}
              </div>
            )}
            <div className="divide-y divide-line rounded-lg border border-line">
              {rows.map((r) => (
                <div key={r.name} className="space-y-2 px-3 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-fg" translate="no">{r.name}</span>
                    <AuditStatus result={r} />
                  </div>
                  {r.message && <p className="text-xs text-fg-3">{r.message}</p>}
                  {r.findings.length > 0 && (
                    <div className="space-y-1.5">
                      {r.findings.map((f) => (
                        <div key={`${r.name}-${f.pid}-${f.ruleId}`} className="rounded-md bg-danger-soft px-2.5 py-2 text-xs">
                          <div className="flex flex-wrap items-center gap-1.5 font-medium text-danger-text">
                            <Tag tone="danger">{t(AUDIT_CATEGORY[f.category])}</Tag>
                            <span>{f.process}</span><span className="font-mono opacity-70">PID {f.pid}</span>
                          </div>
                          <div className="mt-1 break-all font-mono text-[11px] text-fg-2" translate="no">{f.command}</div>
                          <div className="mt-1 text-[11px] text-fg-3">{t('ops.auditEvidence')}: {f.evidence} · {f.ruleId}</div>
                          {f.recommendation && <div className="mt-1 text-[11px] text-warning-text">{f.recommendation}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {r.connections && r.connections.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-fg-3">{t('ops.auditConnections')} ({r.connections.length})</summary><div className="mt-1 space-y-1">{r.connections.slice(0, 20).map((connection, index) => <div key={`${connection.evidence}-${index}`} className="rounded bg-surface-2 px-2 py-1 font-mono text-[11px] break-all">{connection.evidence}</div>)}</div></details>}
                  {r.startupItems && r.startupItems.length > 0 && <details className="text-xs"><summary className="cursor-pointer text-fg-3">{t('ops.auditStartup')} ({r.startupItems.length})</summary><div className="mt-1 space-y-1">{r.startupItems.slice(0, 20).map((item, index) => <div key={`${item.source}-${index}`} className="rounded bg-surface-2 px-2 py-1 text-[11px] break-all"><span className="mr-1 text-fg-4">[{item.source}]</span>{item.command}</div>)}</div></details>}
                </div>
              ))}
            </div>
          </>
        )}
        <details className="rounded-lg border border-line" open={!result}>
          <summary className="cursor-pointer px-3 py-2.5 text-[13px] font-medium text-fg-2 hover:text-fg">
            {t('ops.auditLibrary')} {rules.length ? `(${rules.length})` : ''}
          </summary>
          <div className="border-t border-line px-3 py-3">
            <p className="mb-2 text-xs leading-relaxed text-fg-3">{t('ops.auditLibraryDesc')}</p>
            {rulesQuery.isLoading && <div className="text-xs text-fg-3">{t('common.loading')}</div>}
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className="rounded-md bg-surface-2 px-2.5 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-fg-3">{rule.id}</span>
                    <Tag>{t(AUDIT_CATEGORY[rule.category])}</Tag>
                    <Badge tone={rule.risk === 'HIGH' ? 'danger' : rule.risk === 'MEDIUM' ? 'warning' : 'neutral'}>{t(AUDIT_RISK[rule.risk])}</Badge>
                    <span className="font-medium text-fg-2">{rule.evidence}</span>
                  </div>
                  <div className="mt-1 break-words text-[11px] text-fg-3">{rule.matches.join(', ')}</div>
                </div>
              ))}
            </div>
          </div>
        </details>
      </div>
    </Modal>
  );
}

// ───────────── 弹窗 ─────────────

function DriftDialog({ inst, onClose, onRun }: { inst: HostInstanceDTO | null; onClose: () => void; onRun: (kind: OpsKind, ids: number[]) => void }) {
  const t = useT();
  const has = (kind: OpsKind) => !!inst && countOf(inst, kind) > 0;
  return (
    <Modal
      open={!!inst}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={t('ops.driftTitle', { name: inst?.record?.hostname ?? inst?.name ?? '' })}
      description={t('ops.driftDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {has('network') && <Button onClick={() => onRun('network', [inst!.record!.id])}>{t('ops.repairNetwork')}</Button>}
          {has('baseline') && (
            <Button variant="primary" onClick={() => onRun('baseline', [inst!.record!.id])}>
              {t('ops.syncBaseline')}
            </Button>
          )}
        </>
      }
    >
      <div className="divide-y divide-line rounded-lg border border-line">
        {inst?.drift.map((d) => (
          <div key={d.key} className="grid gap-1.5 px-3 py-2.5 text-[13px] sm:grid-cols-[10rem_1fr]">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-fg">
                {DRIFT_LABEL[d.key] ? t(DRIFT_LABEL[d.key]) : d.key}
                <Tag tone={d.kind === 'network' ? 'danger' : 'warning'}>{t(d.kind === 'network' ? 'ops.kindNetwork' : 'ops.kindBaseline')}</Tag>
              </div>
              <div className="truncate font-mono text-[11px] text-fg-4" translate="no">
                {d.key}
              </div>
            </div>
            <div className="min-w-0 space-y-1 font-mono text-xs break-all" translate="no">
              <div>
                <span className="mr-2 font-sans text-fg-3">{t('ops.expected')}</span>
                <span className="text-fg">{d.expected ?? t('ops.unset')}</span>
              </div>
              <div>
                <span className="mr-2 font-sans text-fg-3">{t('ops.actual')}</span>
                <span className="text-danger-text">{d.actual ?? t('ops.unset')}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** 基线同步 / 网络修复：选择范围（全部或有差异的实例）与修复方式 */
function OpsDialog({
  node,
  target,
  data,
  onClose,
  onDone,
}: {
  node: NodeDTO;
  target: { kind: OpsKind; ids?: number[] } | null;
  data: HostInstancesDTO | undefined;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useT();
  const [scope, setScope] = useState<'drift' | 'all'>('drift');
  const [mode, setMode] = useState<'hot' | 'restart'>('hot');
  const kind = target?.kind ?? 'baseline';
  const managed = (data?.items ?? []).filter((i) => i.category === 'managed' && i.record);
  const drifted = managed.filter((i) => countOf(i, kind) > 0);
  const single = target?.ids?.length === 1 ? managed.find((i) => i.record!.id === target.ids![0]) : null;
  const ids = target?.ids ?? (scope === 'drift' ? drifted : managed).map((i) => i.record!.id);
  const run = useMutation({
    mutationFn: () => api.post<BatchResultDTO>(`/admin/nodes/${node.id}/ops/${kind === 'baseline' ? 'sync-baseline' : 'repair-network'}`, { ids, restart: mode === 'restart' }),
    onSuccess: (r) => {
      if (r.failed.length === 0) toast.success(t('ops.submitted', { n: r.ok }));
      else
        toast.error(
          t('batch.partial', { ok: r.ok, failed: r.failed.length }),
          r.failed
            .slice(0, 3)
            .map((f) => `${f.hostname}：${f.message}`)
            .join('\n'),
        );
      onDone();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  const empty = ids.length === 0;
  return (
    <Modal
      open={!!target}
      onOpenChange={(o) => !o && onClose()}
      title={single ? t(kind === 'baseline' ? 'ops.syncTitleOne' : 'ops.repairTitleOne', { name: single.record!.hostname }) : t(kind === 'baseline' ? 'ops.syncTitle' : 'ops.repairTitle')}
      description={t(kind === 'baseline' ? 'ops.syncDesc' : 'ops.repairDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={run.isPending} disabled={empty} onClick={() => run.mutate()}>
            {t('common.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!target?.ids && (
          <FormField label={t('ops.scope')}>
            <Select
              value={scope}
              onChange={setScope}
              options={[
                { value: 'drift', label: t('ops.scopeDrift', { n: drifted.length }), description: t(kind === 'baseline' ? 'ops.scopeDriftBaselineDesc' : 'ops.scopeDriftNetworkDesc') },
                { value: 'all', label: t('ops.scopeAll', { n: managed.length }), description: t('ops.scopeAllDesc') },
              ]}
            />
          </FormField>
        )}
        {kind === 'network' && (
          <FormField label={t('ops.repairMode')}>
            <Select
              value={mode}
              onChange={setMode}
              options={[
                { value: 'hot', label: t('ops.modeHot'), description: t('ops.modeHotDesc') },
                { value: 'restart', label: t('ops.modeRestart'), description: t('ops.modeRestartDesc') },
              ]}
            />
          </FormField>
        )}
        {empty && <Alert tone="success">{t('ops.nothingToDo')}</Alert>}
      </div>
    </Modal>
  );
}

/** 编辑未登记实例的配额与开机设置（留空表示不限制） */
function EditDialog({ node, inst, onClose, onDone }: { node: NodeDTO; inst: HostInstanceDTO | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const [form, setForm] = useState({ cpu: '', memory: '', autostart: false, description: '' });
  const [opened, setOpened] = useState<string | null>(null);
  if (inst && opened !== inst.name) {
    setOpened(inst.name);
    const mem = /^(\d+)MiB$/.exec(inst.memory ?? '')?.[1] ?? (/^(\d+)GiB$/.exec(inst.memory ?? '') ? String(Number(/^(\d+)GiB$/.exec(inst.memory!)![1]) * 1024) : '');
    setForm({ cpu: inst.cpu ?? '', memory: mem, autostart: inst.autostart, description: inst.description });
  }
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/nodes/${node.id}/ops/instances/${inst!.name}`, {
        cpu: form.cpu.trim() ? Number(form.cpu) : null,
        memory: form.memory.trim() ? Number(form.memory) : null,
        autostart: form.autostart,
        description: form.description,
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      onDone();
      onClose();
    },
    onError: (e) => toast.fromError(e),
  });
  return (
    <Modal
      open={!!inst}
      onOpenChange={(o) => {
        if (!o) {
          setOpened(null);
          onClose();
        }
      }}
      title={t('ops.editTitle', { name: inst?.name ?? '' })}
      description={t('ops.editDesc')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label={t('ops.key.cpu')}>
          <InputGroup inputMode="numeric" value={form.cpu} onChange={(e) => setForm({ ...form, cpu: e.target.value.replace(/\D/g, '') })} placeholder={t('ops.unlimited')} suffix="vCPU" />
        </FormField>
        <FormField label={t('ops.key.memory')}>
          <InputGroup inputMode="numeric" value={form.memory} onChange={(e) => setForm({ ...form, memory: e.target.value.replace(/\D/g, '') })} placeholder={t('ops.unlimited')} suffix="MiB" />
        </FormField>
        <FormField label={t('ops.description')} className="sm:col-span-2">
          <Input value={form.description} maxLength={255} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </FormField>
        <div className="sm:col-span-2">
          <Switch checked={form.autostart} onCheckedChange={(v) => setForm({ ...form, autostart: v })} label={t('ops.key.autostart')} description={t('ops.autostartDesc')} />
        </div>
      </div>
    </Modal>
  );
}

function ConfigDialog({ node, name, onClose }: { node: NodeDTO; name: string | null; onClose: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['node-ops-config', node.id, name], queryFn: () => api.get<Record<string, unknown>>(`/admin/nodes/${node.id}/ops/instances/${name}`), enabled: !!name });
  return (
    <Modal open={!!name} onOpenChange={(o) => !o && onClose()} size="xl" title={t('ops.configTitle', { name: name ?? '' })}>
      <CodeBlock className="max-h-[65vh] overflow-auto" wrap={false} value={q.error ? errorText(q.error) : q.data ? JSON.stringify(q.data, null, 2) : t('common.loading')} />
    </Modal>
  );
}

/** 已登记实例：修改配置（读取面板记录后复用单独配置弹窗，提交到实例管理接口） */
function ManagedConfigDialog({ id, onClose, onDone }: { id: number | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const q = useQuery({ queryKey: ['admin-instance-ops', id], queryFn: () => api.get<AdminInstanceDTO>(`/admin/instances/${id}`), enabled: !!id, gcTime: 0 });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/admin/instances/${id}`, body),
    onSuccess: () => {
      toast.success(t('common.saved'));
      onDone();
      onClose();
    },
  });
  useEffect(() => {
    if (q.error) {
      toast.fromError(q.error);
      onClose();
    }
  }, [q.error, onClose]);
  if (!id || !q.data) return null;
  return (
    <BatchConfigDialog
      open
      count={1}
      current={q.data}
      pending={save.isPending}
      error={save.error ? errorText(save.error) : null}
      onClose={onClose}
      onSubmit={(body) => save.mutate(body)}
    />
  );
}

/** 已登记实例：删除（选择退款方式、填写原因，与实例管理一致） */
function ManagedDeleteDialog({ target, onClose, onDone }: { target: { id: number; hostname: string } | null; onClose: () => void; onDone: () => void }) {
  const t = useT();
  const remove = useMutation({
    mutationFn: (v: { refundMode: DeleteRefundMode; note: string }) => api.post(`/admin/instances/${target!.id}/actions`, { action: 'delete', ...v }),
    onSuccess: () => {
      toast.success(t('common.submitted'));
      onDone();
      onClose();
    },
  });
  return (
    <DeleteDialog
      key={target?.id ?? 'none'}
      open={!!target}
      title={t('settings.deleteConfirm', { name: target?.hostname ?? '' })}
      confirmText={target?.hostname ?? ''}
      instanceIds={target ? [target.id] : []}
      pending={remove.isPending}
      error={remove.error ? errorText(remove.error) : null}
      onClose={onClose}
      onSubmit={(v) => remove.mutate(v)}
    />
  );
}

// ───────────── 页面 ─────────────

/** 运维标签页：终端连接只在运维页内保持，离开时全部断开 */
export function NodeOpsTab({ node }: { node: NodeDTO }) {
  return (
    <TerminalDockProvider>
      <NodeOpsPanel node={node} />
    </TerminalDockProvider>
  );
}

function NodeOpsPanel({ node }: { node: NodeDTO }) {
  const t = useT();
  const dock = useTerminalDock();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const installed = node.status !== 'PENDING';
  // 切换到运维页时不读取宿主机，点击「刷新」才读取；之后操作完成会自动重新读取，但不定时轮询
  const [requested, setRequested] = useState(false);
  const q = useQuery({
    queryKey: ['node-ops', node.id],
    queryFn: () => api.get<HostInstancesDTO>(`/admin/nodes/${node.id}/ops/instances`),
    enabled: installed && requested,
    refetchOnWindowFocus: false,
  });
  const refresh = () => (requested ? void q.refetch() : setRequested(true));
  const [view, setView] = useState<View>('all');
  const [kw, setKw] = useState('');
  const [drift, setDrift] = useState<HostInstanceDTO | null>(null);
  const [ops, setOps] = useState<{ kind: OpsKind; ids?: number[] } | null>(null);
  const [edit, setEdit] = useState<HostInstanceDTO | null>(null);
  const [config, setConfig] = useState<string | null>(null);
  const [auditNames, setAuditNames] = useState<string[] | null>(null);
  const [auditRules, setAuditRules] = useState(false);
  const [managedConfig, setManagedConfig] = useState<number | null>(null);
  const [managedDelete, setManagedDelete] = useState<{ id: number; hostname: string } | null>(null);
  // 任务和宿主机上的变化要过一会儿才反映到列表上
  const reload = (delay = 0) => setTimeout(() => void qc.invalidateQueries({ queryKey: ['node-ops', node.id] }), delay);

  const data = q.data;
  const counts = useMemo(() => {
    const c: Record<View, number> = { all: data?.items.length ?? 0, managed: 0, orphan: 0, other: 0, drift: 0, missing: data?.missing.length ?? 0 };
    for (const i of data?.items ?? []) {
      c[i.category]++;
      if (i.drift.length) c.drift++;
    }
    return c;
  }, [data]);
  const rows = useMemo(() => {
    const k = kw.trim().toLowerCase();
    return (data?.items ?? [])
      .filter((i) => view === 'all' || (view === 'drift' ? i.drift.length > 0 : i.category === view))
      .filter((i) => !k || [i.name, i.description, i.record?.hostname, i.record?.user.email, ...i.ipv4, ...i.ipv6].some((s) => s?.toLowerCase().includes(k)));
  }, [data, view, kw]);

  const act = async (title: string, description: string, fn: () => Promise<unknown>, done: string, danger = false, requireText?: string) => {
    if (!(await confirm({ title, description, danger, requireText }))) return;
    try {
      await fn();
      toast.success(done);
      reload(800);
    } catch (e) {
      toast.fromError(e);
    }
  };
  const base = `/admin/nodes/${node.id}/ops/instances`;
  const closeManagedConfig = useCallback(() => setManagedConfig(null), []);
  const power = (i: HostInstanceDTO, action: 'start' | 'stop' | 'restart' | 'force_stop') => api.post(`${base}/${i.name}/state`, { action });
  // 已登记实例按面板流程提交电源任务
  const panelPower = (id: number, action: 'start' | 'stop' | 'restart' | 'force_stop') => api.post(`/admin/instances/${id}/power`, { action });
  const POWER: Record<'start' | 'stop' | 'restart' | 'force_stop', MessageKey> = { start: 'power.start', stop: 'power.stop', restart: 'power.restart', force_stop: 'power.forceStop' };
  // 终端：宿主机上的任意实例都走运维终端接口（按实例名连接）
  const openTerminal = (i: HostInstanceDTO) => dock.open({ id: i.record?.id ?? 0, hostname: i.record?.hostname ?? i.name }, `${base}/${i.name}`);

  const menu = (i: HostInstanceDTO): MenuItem[] => {
    const rec = i.record;
    const managed = i.category === 'managed' && !!rec;
    const running = i.status === 'Running';
    const busy = managed && !['RUNNING', 'STOPPED', 'ERROR'].includes(rec!.status);
    const panelAct = (action: 'start' | 'stop' | 'restart' | 'force_stop', title: string, desc: string, danger = false) =>
      void act(title, desc, () => panelPower(rec!.id, action), t('power.submitted', { action: t(POWER[action]) }), danger);
    return [
      { label: t('terminal.open'), icon: <SquareTerminal />, hidden: !running, onClick: () => openTerminal(i) },
      { separator: true, hidden: !running, label: '' },
      // ── 面板实例：基线比对与修复；开关机、修改配置、删除按面板流程提交任务 ──
      { label: t('ops.viewDrift'), hidden: !managed || !i.drift.length, onClick: () => setDrift(i) },
      { label: t('ops.syncBaseline'), hidden: !managed, onClick: () => setOps({ kind: 'baseline', ids: [rec!.id] }) },
      { label: t('ops.repairNetwork'), hidden: !managed, onClick: () => setOps({ kind: 'network', ids: [rec!.id] }) },
      { separator: true, hidden: !managed, label: '' },
      { label: t('power.start'), hidden: !managed || running, disabled: busy, onClick: () => panelAct('start', t('ops.startTitle', { name: rec!.hostname }), '') },
      { label: t('power.restart'), hidden: !managed || !running, disabled: busy, onClick: () => panelAct('restart', t('ops.restartTitle', { name: rec!.hostname }), t('power.restartDesc')) },
      { label: t('power.stop'), hidden: !managed || !running, disabled: busy, onClick: () => panelAct('stop', t('ops.stopTitle', { name: rec!.hostname }), t('power.stopDesc'), true) },
      { label: t('power.forceStop'), hidden: !managed || !running, disabled: busy, onClick: () => panelAct('force_stop', t('ops.forceStopTitle', { name: rec!.hostname }), t('ops.forceStopDesc'), true) },
      { label: t('ops.editConfig'), hidden: !managed, onClick: () => setManagedConfig(rec!.id) },
      { label: t('ops.openInstance'), hidden: !managed, onClick: () => navigate(`/admin/instances/${rec!.id}`) },
      // ── 未登记的实例：直接操作宿主机 ──
      { label: t('power.start'), hidden: managed || running, onClick: () => void act(t('ops.startTitle', { name: i.name }), '', () => power(i, 'start'), t('ops.started')) },
      { label: t('power.restart'), hidden: managed || !running, onClick: () => void act(t('ops.restartTitle', { name: i.name }), t('power.restartDesc'), () => power(i, 'restart'), t('ops.restarted')) },
      { label: t('power.stop'), hidden: managed || !running, onClick: () => void act(t('ops.stopTitle', { name: i.name }), t('power.stopDesc'), () => power(i, 'stop'), t('ops.stoppedDone'), true) },
      { label: t('power.forceStop'), hidden: managed || !running, onClick: () => void act(t('ops.forceStopTitle', { name: i.name }), t('ops.forceStopDesc'), () => power(i, 'force_stop'), t('ops.stoppedDone'), true) },
      { label: t('common.edit'), hidden: managed, onClick: () => setEdit(i) },
      { label: t('ops.viewConfig'), onClick: () => setConfig(i.name) },
      { label: t('ops.auditInstance'), icon: <ShieldCheck />, onClick: () => setAuditNames([i.name]) },
      { separator: true, label: '' },
      // 面板实例：选择退款方式后提交删除任务
      { label: t('common.delete'), danger: true, hidden: !managed, onClick: () => setManagedDelete({ id: rec!.id, hostname: rec!.hostname }) },
      {
        label: t('common.delete'),
        danger: true,
        hidden: managed,
        onClick: () => void act(t('ops.deleteTitle', { name: i.name }), t(i.category === 'orphan' ? 'ops.deleteOrphanDesc' : 'ops.deleteOtherDesc'), () => api.delete(`${base}/${i.name}`), t('ops.deleted'), true, i.name),
      },
    ];
  };

  if (!installed) return <Empty title={t('ops.notInstalled')} />;
  if (q.error && !data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const tabs: Array<{ value: View; label: string }> = [
    { value: 'all', label: t('ops.viewAll') },
    { value: 'managed', label: t('ops.managed') },
    { value: 'orphan', label: t('ops.orphan') },
    { value: 'other', label: t('ops.other') },
    { value: 'drift', label: t('ops.viewDriftTab') },
    { value: 'missing', label: t('ops.viewMissing') },
  ];
  return (
    <div className="space-y-3">
      {data?.network && !data.network.ok && (
        <Alert tone="danger" title={t('ops.netBad', { name: data.network.name })}>
          {data.network.message}
          {data.network.cidr && (
            <span className="ml-1 font-mono text-xs">
              （{data.network.cidr}
              {data.network.expected && data.network.expected !== data.network.cidr ? ` ≠ ${data.network.expected}` : ''}）
            </span>
          )}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="-mx-1 flex max-w-full min-w-0 gap-1 overflow-x-auto px-1">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setView(tab.value)}
              className={cn(
                'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[13px] whitespace-nowrap transition-colors',
                view === tab.value ? 'border-fg bg-fg text-surface' : 'border-line text-fg-2 hover:border-line-strong',
                view !== tab.value && counts[tab.value] > 0 && (tab.value === 'orphan' || tab.value === 'drift') && 'border-danger/30 text-danger-text',
                view !== tab.value && counts[tab.value] > 0 && tab.value === 'missing' && 'border-warning-icon/40 text-warning-text',
              )}
            >
              {tab.label}
              <span className="tabular-nums opacity-70">{counts[tab.value]}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Input className="h-8 min-w-0 flex-1 text-xs sm:w-48 sm:flex-none" value={kw} onChange={(e) => setKw(e.target.value)} placeholder={t('ops.search')} />
          <Button size="sm" variant={data ? 'secondary' : 'primary'} icon={<RefreshCw />} loading={q.isFetching} onClick={refresh}>
            {t('common.refresh')}
          </Button>
          <Button size="sm" icon={<ListRestart />} disabled={!counts.managed} onClick={() => setOps({ kind: 'baseline' })}>
            {t('ops.syncBaseline')}
          </Button>
          <Button size="sm" icon={<Network />} disabled={!counts.managed} onClick={() => setOps({ kind: 'network' })}>
            {t('ops.repairNetwork')}
          </Button>
          <Button size="sm" variant="secondary" icon={<ShieldCheck />} disabled={!data?.items.length} onClick={() => setAuditNames((data?.items ?? []).map((i) => i.name))}>
            {t('ops.auditAll')}
          </Button>
          <Button size="sm" variant="secondary" icon={<ListFilter />} onClick={() => setAuditRules(true)}>
            {t('ops.auditLibrary')}
          </Button>
        </div>
      </div>

      {view === 'orphan' && counts.orphan > 0 && <Alert tone="warning">{t('ops.orphanHint')}</Alert>}

      {!data && !q.isFetching ? (
        <Empty
          icon={<RefreshCw />}
          title={t('ops.notLoaded')}
          description={t('ops.notLoadedDesc')}
          action={
            <Button size="sm" variant="primary" icon={<RefreshCw />} onClick={refresh}>
              {t('common.refresh')}
            </Button>
          }
        />
      ) : view === 'missing' ? (
        <DataTable
          rows={data?.missing}
          rowKey={(i) => i.id}
          loading={!data}
          empty={t('ops.missingEmpty')}
          columns={[
            {
              key: 'name',
              header: t('ops.instance'),
              cell: (i) => (
                <Link to={`/admin/instances/${i.id}`} className="font-medium text-fg hover:underline">
                  {i.hostname}
                  <span className="ml-1.5 font-mono text-xs font-normal text-fg-4">{i.name}</span>
                </Link>
              ),
            },
            { key: 'user', header: t('ops.owner'), cell: (i) => <span className="text-xs">{i.user.email}</span> },
            { key: 'status', header: t('ops.panelStatus'), cell: (i) => <InstanceStatusBadge status={i.status} /> },
            { key: 'hint', header: t('ops.note'), mobile: 'full', cell: () => <span className="text-xs text-fg-3">{t('ops.missingHint')}</span> },
          ]}
        />
      ) : (
        <DataTable
          rows={rows}
          rowKey={(i) => i.name}
          loading={!data}
          empty={t('ops.empty')}
          columns={[
            {
              key: 'name',
              header: t('ops.instance'),
              cell: (i) => (
                <div className="max-w-64 min-w-0">
                  {i.record && i.category === 'managed' ? (
                    <Link to={`/admin/instances/${i.record.id}`} className="block truncate font-medium text-fg hover:underline">
                      {i.record.hostname}
                    </Link>
                  ) : (
                    <div className="truncate font-medium text-fg" translate="no">
                      {i.name}
                    </div>
                  )}
                  <div className="truncate text-xs text-fg-4" translate="no">
                    {i.category === 'managed' ? `${i.name} · ${i.record?.user.email}` : i.description || (i.type === 'virtual-machine' ? 'VM' : 'LXC')}
                  </div>
                </div>
              ),
            },
            {
              key: 'cat',
              header: t('ops.category'),
              cell: (i) => (
                <div className="flex flex-col items-start gap-0.5">
                  <Tag tone={CATEGORY[i.category][1]}>{t(CATEGORY[i.category][0])}</Tag>
                  {i.category === 'orphan' && <span className="text-[11px] text-fg-4">{i.record ? t('ops.orphanElsewhere', { id: i.record.id }) : i.panelId ? `#${i.panelId}` : ''}</span>}
                </div>
              ),
            },
            { key: 'state', header: t('common.status'), cell: (i) => <PowerState status={i.status} /> },
            {
              key: 'spec',
              header: t('ops.spec'),
              cell: (i) => (
                <span className="text-xs whitespace-nowrap text-fg-2 tabular-nums">
                  {i.cpu ? `${i.cpu} vCPU` : t('ops.cpuUnlimited')} · {i.memory ?? t('ops.memUnlimited')} · {i.disk ?? '—'}
                  {i.memoryUsage != null && <span className="block text-fg-4">{t('ops.memUsed', { size: formatBytes(i.memoryUsage) })}</span>}
                </span>
              ),
            },
            {
              key: 'ip',
              header: t('ops.address'),
              cell: (i) => (
                <div className="font-mono text-xs text-fg-2" translate="no" title={[...i.ipv4, ...i.ipv6].join('\n')}>
                  {i.ipv4[0] ?? i.ipv6[0] ?? '—'}
                  {i.ipv4.length + i.ipv6.length > 1 && <span className="ml-1 text-fg-4">+{i.ipv4.length + i.ipv6.length - 1}</span>}
                </div>
              ),
            },
            { key: 'drift', header: t('ops.baseline'), cell: (i) => <DriftBadges inst={i} onOpen={() => setDrift(i)} /> },
            { key: 'age', header: t('ops.created'), mobile: 'hide', cell: (i) => <span className="text-xs text-fg-3">{fromNow(i.createdAt)}</span> },
            {
              key: 'actions',
              header: '',
              className: 'text-right',
              cell: (i) => (
                <DropdownMenu
                  trigger={
                    <Button size="icon-sm" variant="ghost" aria-label={t('common.actions')}>
                      <Ellipsis />
                    </Button>
                  }
                  items={menu(i)}
                />
              ),
            },
          ]}
        />
      )}
      <p className="text-xs text-fg-3">{t('ops.footer')}</p>

      <DriftDialog
        inst={drift}
        onClose={() => setDrift(null)}
        onRun={(kind, ids) => {
          setDrift(null);
          setOps({ kind, ids });
        }}
      />
      <OpsDialog node={node} target={ops} data={data} onClose={() => setOps(null)} onDone={() => reload(3000)} />
      <EditDialog node={node} inst={edit} onClose={() => setEdit(null)} onDone={() => reload(500)} />
      <ConfigDialog node={node} name={config} onClose={() => setConfig(null)} />
      {auditNames && <AuditDialog node={node} names={auditNames} onClose={() => setAuditNames(null)} />}
      {auditRules && <AuditRuleLibraryDialog onClose={() => setAuditRules(false)} />}
      <ManagedConfigDialog id={managedConfig} onClose={closeManagedConfig} onDone={() => reload(1500)} />
      <ManagedDeleteDialog target={managedDelete} onClose={() => setManagedDelete(null)} onDone={() => reload(3000)} />
    </div>
  );
}

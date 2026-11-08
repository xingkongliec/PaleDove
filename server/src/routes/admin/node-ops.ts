// 宿主机运维（管理员）：通过 Incus API 查看宿主机上的全部实例并比对面板基线（见 services/node-ops.ts）。
// 面板登记的实例通过实例管理的接口操作（前端直接调用）；这里提交基线同步 / 网络修复任务；未登记的（残留、其他）在这里直接开关机、编辑配额、删除。
// 网页终端支持宿主机上的任意实例；实例审查只读读取运行中实例的进程列表。
// 所有操作都先确认实例确实在这台宿主机上，并写入操作日志。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BatchResultDTO, InstanceAuditRuleDTO } from '../../shared/index.ts';
import { getIncus, IncusError } from '../../incus/index.ts';
import type { IncusInstance } from '../../incus/types.ts';
import { badRequest, conflict, errorMessage, notFound } from '../../lib/errors.ts';
import { adminGuard, ensureFound, idParam, logActivity, parse, parsePatch, requireAdmin } from '../../lib/http.ts';
import { randomToken } from '../../lib/crypto.ts';
import { prisma, type Node } from '../../lib/prisma.ts';
import { t } from '../../i18n/index.ts';
import { listHostInstances, OPS_STATUSES, panelIdOf } from '../../services/node-ops.ts';
import { analyzeAuditData, buildAuditCommands, encodeCustomRuleMatches, loadAuditRuleLibrary, parseAuditConnections, parseAuditProcesses, parseAuditStartupItems } from '../../services/instance-audit.ts';
import { enqueueTask } from '../../services/tasks.ts';
import { serveTerminal } from '../../lib/terminal-socket.ts';

const instParams = idParam.extend({ name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/) });
const batchBody = z.object({ ids: z.array(z.number().int().positive()).max(1000).optional() });
const auditBody = z.object({ names: z.array(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/)).min(1).max(100) });
const auditRuleInput = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.enum(['MINING', 'PACKET', 'SCANNER', 'DDOS', 'PROXY']),
  risk: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  matches: z.array(z.string().trim().min(1).max(80)).min(1).max(50).transform((items) => [...new Set(items)]),
  targetTypes: z.array(z.enum(['process', 'network', 'startup'])).min(1).max(3).default(['process']),
  matchType: z.enum(['contains', 'regex', 'exact']).default('contains'),
  patternText: z.string().trim().max(500).optional(),
  caseSensitive: z.boolean().default(false),
  description: z.string().trim().max(500).nullable().optional(),
  recommendation: z.string().trim().max(500).nullable().optional(),
  enabled: z.boolean().default(true),
});
type AuditRuleInput = z.infer<typeof auditRuleInput>;
const auditRuleId = z.object({ id: z.coerce.number().int().positive() });

function persistAuditRuleBody(body: Partial<AuditRuleInput>, current?: InstanceAuditRuleDTO): Record<string, unknown> {
  const matches = body.matches ?? current?.matches ?? [];
  const targetTypes = body.targetTypes ?? current?.targetTypes ?? ['process'];
  const matchType = body.matchType ?? current?.matchType ?? 'contains';
  const patternText = body.patternText ?? current?.patternText ?? matches[0];
  const caseSensitive = body.caseSensitive ?? current?.caseSensitive ?? false;
  const description = body.description ?? current?.description ?? null;
  const recommendation = body.recommendation ?? current?.recommendation ?? null;
  return {
    ...(body.name === undefined ? {} : { name: body.name }),
    ...(body.category === undefined ? {} : { category: body.category }),
    ...(body.risk === undefined ? {} : { risk: body.risk }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
    matches: encodeCustomRuleMatches(matches, { targetTypes, matchType, patternText, caseSensitive, description, recommendation }),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

async function loadNode(id: number): Promise<Node> {
  return ensureFound(await prisma.node.findUnique({ where: { id } }), t('node.notFound'));
}

/** 读取宿主机上的实例；面板登记在这台宿主机上的实例不在这里直接操作 */
async function unmanagedInstance(req: FastifyRequest): Promise<{ node: Node; inst: IncusInstance }> {
  const { id, name } = parse(instParams, req.params);
  const node = await loadNode(id);
  const incus = await getIncus(node);
  const inst = await incus.getInstance(name).catch((err) => {
    if (err instanceof IncusError && err.isNotFound) throw notFound(t('ops.notOnNode'));
    throw err;
  });
  const panelId = panelIdOf(inst);
  const rec = await prisma.instance.findFirst({ where: { OR: [{ name }, ...(panelId ? [{ id: panelId }] : [])], nodeId: node.id, status: { not: 'DELETED' } } });
  if (rec?.name === name) throw conflict(t('ops.managed', { hostname: rec.hostname }));
  return { node, inst };
}

export default async function adminNodeOpsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  /** 自定义规则库：规则只匹配进程名 / 命令行关键字，不执行管理员输入的内容。 */
  app.get('/api/admin/audit-rules', async () => ({ rules: await loadAuditRuleLibrary(true) }));

  app.post('/api/admin/audit-rules', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(auditRuleInput, req.body);
    const row = await prisma.instanceAuditRule.create({
      data: { ruleKey: `custom.${randomToken(10)}`, ...persistAuditRuleBody(body) } as never,
    });
    await logActivity(req, admin.id, 'admin.audit_rule_create', row.ruleKey);
    return { rules: await loadAuditRuleLibrary(true) };
  });

  app.patch('/api/admin/audit-rules/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(auditRuleId, req.params);
    const body = parsePatch(auditRuleInput.shape, req.body);
    const existing = await prisma.instanceAuditRule.findUnique({ where: { id } });
    if (!existing) throw notFound(t('ops.auditRuleNotFound'));
    const current = (await loadAuditRuleLibrary(true)).find((rule) => rule.databaseId === id);
    const row = await prisma.instanceAuditRule.update({ where: { id }, data: persistAuditRuleBody(body as Partial<AuditRuleInput>, current) });
    await logActivity(req, admin.id, 'admin.audit_rule_update', row.ruleKey);
    return { rules: await loadAuditRuleLibrary(true) };
  });

  app.delete('/api/admin/audit-rules/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(auditRuleId, req.params);
    const existing = await prisma.instanceAuditRule.findUnique({ where: { id } });
    if (!existing) throw notFound(t('ops.auditRuleNotFound'));
    await prisma.instanceAuditRule.delete({ where: { id } });
    await logActivity(req, admin.id, 'admin.audit_rule_delete', existing.ruleKey);
    return { rules: await loadAuditRuleLibrary(true) };
  });

  app.get('/api/admin/nodes/:id/ops/instances', async (req) => {
    const { id } = parse(idParam, req.params);
    return listHostInstances(await loadNode(id));
  });

  /** 实例在 Incus 中的原始配置（只读） */
  app.get('/api/admin/nodes/:id/ops/instances/:name', async (req) => {
    const { id, name } = parse(instParams, req.params);
    const incus = await getIncus(await loadNode(id));
    const inst = await incus.getInstance(name).catch((err) => {
      if (err instanceof IncusError && err.isNotFound) throw notFound(t('ops.notOnNode'));
      throw err;
    });
    const { name: _n, config, devices, profiles, expanded_config, expanded_devices } = inst;
    return { config, devices, profiles, expandedConfig: expanded_config ?? null, expandedDevices: expanded_devices ?? null };
  });

  /** 当前节点实例审查使用的规则库；规则库本身不读取节点。 */
  app.get('/api/admin/nodes/:id/ops/audit-rules', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadNode(id);
    return { rules: await loadAuditRuleLibrary(true) };
  });

  /**
   * 只读实例审查：在运行中的实例内读取进程列表，匹配高风险工具规则。
   * 审查不会停止、修改或上传实例内容；虚拟机需要安装并运行 incus-agent 才能执行。
   */
  app.post('/api/admin/nodes/:id/ops/audit', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { names } = parse(auditBody, req.body);
    const node = await loadNode(id);
    const incus = await getIncus(node);
    const auditRules = await loadAuditRuleLibrary();
    const checkedAt = new Date().toISOString();
    const uniqueNames = [...new Set(names)];
    const results = await mapLimit(uniqueNames, 8, async (name) => {
      try {
        const inst = await incus.getInstance(name);
        if (inst.status !== 'Running') {
          return { name, type: inst.type, status: 'STOPPED' as const, message: t('ops.auditStopped'), findings: [], checkedAt };
        }
        try {
          const commands = buildAuditCommands();
          const [processExec, networkExec, startupExec] = await Promise.all([
            incus.exec(name, ['/bin/sh', '-c', `LC_ALL=C ${commands.process}`], { timeoutSec: 20 }),
            incus.exec(name, ['/bin/sh', '-c', `LC_ALL=C ${commands.network}`], { timeoutSec: 20 }),
            incus.exec(name, ['/bin/sh', '-c', `LC_ALL=C ${commands.startup}`], { timeoutSec: 20 }),
          ]);
          if (processExec.exitCode !== 0) {
            return { name, type: inst.type, status: 'ERROR' as const, message: t('ops.auditExecFailed'), findings: [], checkedAt };
          }
          const processes = parseAuditProcesses(processExec.stdout);
          const connections = networkExec.exitCode === 0 ? parseAuditConnections(networkExec.stdout) : [];
          const startupItems = startupExec.exitCode === 0 ? parseAuditStartupItems(startupExec.stdout) : [];
          const analysis = analyzeAuditData({ processes, connections, startupItems, rules: auditRules });
          return {
            name,
            type: inst.type,
            status: analysis.findings.length ? 'SUSPICIOUS' as const : 'CLEAN' as const,
            findings: analysis.findings,
            processes,
            connections,
            startupItems,
            summary: analysis.summary,
            checkedAt,
          };
        } catch (err) {
          // VM 的进程只能在 incus-agent 可用时读取；不把远端 stderr 原样返回给管理员。
          const unsupported = inst.type === 'virtual-machine' && /agent|not supported|not running|failed to connect/i.test(errorMessage(err));
          return { name, type: inst.type, status: unsupported ? 'UNSUPPORTED' as const : 'ERROR' as const, message: unsupported ? t('ops.auditUnsupported') : t('ops.auditExecFailed'), findings: [], checkedAt };
        }
      } catch (err) {
        const message = err instanceof IncusError && err.isNotFound ? t('ops.notOnNode') : t('ops.auditExecFailed');
        return { name, type: 'container' as const, status: 'ERROR' as const, message, findings: [], checkedAt };
      }
    });
    const suspicious = results.filter((r) => r.status === 'SUSPICIOUS').length;
    await logActivity(req, admin.id, 'admin.node_ops_audit', `${node.name} ${results.length} checked, ${suspicious} suspicious`);
    return { results, rules: auditRules, checkedAt };
  });

  /** 网页终端：宿主机上的任意实例（含面板实例），需在运行中 */
  app.get('/api/admin/nodes/:id/ops/instances/:name/terminal', { websocket: true }, (socket, req) =>
    serveTerminal(socket, req, async (opts) => {
      const admin = requireAdmin(req);
      const { id, name } = parse(instParams, req.params);
      const node = await loadNode(id);
      const incus = await getIncus(node);
      const inst = await incus.getInstance(name).catch((err) => {
        if (err instanceof IncusError && err.isNotFound) throw notFound(t('ops.notOnNode'));
        throw err;
      });
      if (inst.status !== 'Running') return t('terminal.notRunning');
      const session = await incus.openTerminal(inst.name, opts);
      await logActivity(req, admin.id, 'admin.node_ops_terminal', `${node.name} ${inst.name}`);
      return session;
    }),
  );

  app.post('/api/admin/nodes/:id/ops/instances/:name/state', async (req) => {
    const admin = requireAdmin(req);
    const { action } = parse(z.object({ action: z.enum(['start', 'stop', 'restart', 'force_stop']) }), req.body);
    const { node, inst } = await unmanagedInstance(req);
    const incus = await getIncus(node);
    if (action === 'start') await incus.setState(inst.name, 'start');
    else if (action === 'restart') await incus.setState(inst.name, 'restart', { timeout: 60 });
    else await incus.setState(inst.name, 'stop', action === 'force_stop' ? { force: true, timeout: 30 } : { timeout: 90 });
    await logActivity(req, admin.id, `admin.node_ops_${action}`, `${node.name} ${inst.name}`);
    return { ok: true };
  });

  /** 编辑未登记实例的配额与开机设置；留空的配额会被移除（不限制） */
  app.patch('/api/admin/nodes/:id/ops/instances/:name', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        cpu: z.number().int().min(1).max(1024).nullable().optional(),
        memory: z.number().int().min(64).nullable().optional(),
        autostart: z.boolean().optional(),
        description: z.string().trim().max(255).optional(),
      }),
      req.body,
    );
    const { node, inst } = await unmanagedInstance(req);
    const incus = await getIncus(node);
    const set = (i: IncusInstance, key: string, v: string | null | undefined) => {
      if (v === undefined) return;
      if (v === null) delete i.config[key];
      else i.config[key] = v;
    };
    await incus.modifyInstance(inst.name, (i) => {
      set(i, 'limits.cpu', body.cpu === undefined ? undefined : body.cpu === null ? null : String(body.cpu));
      set(i, 'limits.memory', body.memory === undefined ? undefined : body.memory === null ? null : `${body.memory}MiB`);
      set(i, 'boot.autostart', body.autostart === undefined ? undefined : String(body.autostart));
      if (body.description !== undefined) i.description = body.description;
    });
    await logActivity(req, admin.id, 'admin.node_ops_update', `${node.name} ${inst.name} ${JSON.stringify(body)}`);
    return { ok: true };
  });

  /** 删除未登记的实例（运行中先强制关机） */
  app.delete('/api/admin/nodes/:id/ops/instances/:name', async (req) => {
    const admin = requireAdmin(req);
    const { node, inst } = await unmanagedInstance(req);
    const incus = await getIncus(node);
    if (inst.status === 'Running') await incus.setState(inst.name, 'stop', { force: true, timeout: 30 });
    await incus.deleteInstance(inst.name);
    await logActivity(req, admin.id, 'admin.node_ops_delete', `${node.name} ${inst.name}`);
    return { ok: true };
  });

  /** 对这台宿主机上的面板实例批量提交任务（不传 ids 表示全部）；有进行中任务的实例跳过并计入失败 */
  const batch = async (req: FastifyRequest, type: 'SYNC_BASELINE' | 'REPAIR_NETWORK', payload: Record<string, unknown>): Promise<BatchResultDTO> => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { ids } = parse(batchBody.passthrough(), req.body);
    const node = await loadNode(id);
    const list = await prisma.instance.findMany({
      where: { nodeId: node.id, status: { in: OPS_STATUSES.filter((s) => s !== 'REINSTALLING') }, provisionedAt: { not: null }, ...(ids ? { id: { in: ids } } : {}) },
      select: { id: true, name: true, hostname: true },
      orderBy: { id: 'asc' },
    });
    if (!list.length) throw badRequest(t('ops.noInstances'));
    const result: BatchResultDTO = { ok: 0, failed: [] };
    const incus = await getIncus(node);
    for (const inst of list) {
      try {
        // 宿主机上找不到的实例（见「面板有、宿主机没有」）不提交任务
        if (!(await incus.instanceExists(inst.name))) throw notFound(t('ops.notOnNode'));
        await enqueueTask({ instanceId: inst.id, type, userId: admin.id, payload });
        result.ok++;
      } catch (err) {
        result.failed.push({ id: inst.id, hostname: inst.hostname, message: errorMessage(err) });
      }
    }
    await logActivity(req, admin.id, `admin.node_ops_${type.toLowerCase()}`, `${node.name} ${result.ok}/${list.length}`);
    return result;
  };

  app.post('/api/admin/nodes/:id/ops/sync-baseline', (req) => batch(req, 'SYNC_BASELINE', {}));

  app.post('/api/admin/nodes/:id/ops/repair-network', (req) => {
    const { restart } = parse(z.object({ restart: z.boolean().default(false) }).passthrough(), req.body);
    return batch(req, 'REPAIR_NETWORK', { restart });
  });
}

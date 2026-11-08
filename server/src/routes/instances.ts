import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isNatType,
  isVmType,
  nodeAllowsImage,
  PORT_PROTOCOLS,
  TASK_STATUSES,
  TASK_TYPES,
  TRANSFER_MODES,
  type CredentialsDTO,
  type TransferCheckDTO,
  type TransferSpecDTO,
  type TransferRecordDTO,
  type TrafficDailyDTO,
} from '../shared/index.ts';
import { decrypt, encrypt, generatePassword } from '../lib/crypto.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { getIncus } from '../incus/index.ts';
import { serveTerminal } from '../lib/terminal-socket.ts';
import { checkIpv4, requestSwitch, switchInfo } from '../services/node-switch.ts';
import { applyConfig, swapValue } from '../services/spec.ts';
import { instanceEgress, setInstanceEgress } from '../services/egress.ts';
import {
  adminGuard,
  consoleGuard,
  hostnameSchema,
  idParam,
  instancePasswordSchema,
  logActivity,
  pageQuery,
  paging,
  parse,
  requireUser,
  sshKeysSchema,
} from '../lib/http.ts';
import { containsInsensitive, prisma, Prisma, type Instance, type Node, type TaskType, type User } from '../lib/prisma.ts';
import { dayjs } from '../lib/time.ts';
import { labels, m, t } from '../i18n/index.ts';
import { getSettings } from '../lib/settings.ts';
import { reinstallCooldownCheck } from '../services/billing.ts';
import { listEnabledImages } from './store.ts';
import { syncInstanceHostname } from '../services/operations.ts';
import { assertDomainAvailable, checkDomainDns, normalizeDomain, syncSitesSafe } from '../services/gateway.ts';
import { getLiveState, getMetricSeries } from '../services/metrics.ts';
import { guestAgentUnavailable } from '../services/agent/guest-exec.ts';
import { addPortMapping, removePortMapping } from '../services/portmap.ts';
import { addVolume, removeVolume, toVolume } from '../services/volumes.ts';
import { assertNotListed } from '../services/market.ts';
import {
  adminInstanceInclude,
  instanceInclude,
  money,
  toAdminInstance,
  toInstance,
  toPortMapping,
  toSite,
  toSnapshot,
  toTask,
} from '../services/serializers.ts';
import { enqueueTask, hasActiveTask } from '../services/tasks.ts';
import { createRenewInvoice, createTrafficResetInvoice, invoiceDto } from '../services/invoices.ts';
import { checkTransfer, resolveReinstallImage, transferInstance, transferSpec, transferSpecInclude } from '../services/transfer.ts';

type InstanceWithNode = Instance & { node: Node };

/** 加载请求者有权访问的实例：管理员可访问全部，普通用户仅限本人且未删除 */
export async function loadInstance(req: FastifyRequest, id: number): Promise<{ inst: InstanceWithNode; user: User; isAdmin: boolean }> {
  const user = requireUser(req);
  const inst = await prisma.instance.findUnique({ where: { id }, include: { node: true } });
  const isAdmin = user.role === 'ADMIN';
  if (!inst || (!isAdmin && (inst.userId !== user.id || inst.status === 'DELETED'))) throw notFound(t('instance.notFound'));
  return { inst, user, isAdmin };
}

/** 校验实例当前是否允许执行用户操作 */
function assertOperable(inst: Instance, isAdmin: boolean): void {
  if (inst.status === 'DELETED' || inst.status === 'DELETING') throw badRequest(t('instance.deleted'));
  if (inst.status === 'CREATING') throw badRequest(t('instance.creating'));
  if (inst.status === 'SUSPENDED' && !isAdmin) {
    // 管理员填写了封禁原因时显示原因
    throw forbidden(t('instance.suspended', { reason: inst.suspendNote || (inst.suspendReason ? labels().suspendReason[inst.suspendReason] : t('reason.unknown')) }));
  }
  if (inst.status === 'REINSTALLING') throw badRequest(t('instance.reinstalling'));
  if (inst.status === 'MIGRATING') throw badRequest(t('instance.migrating'));
}

async function loadDto(id: number, isAdmin: boolean) {
  if (isAdmin) {
    const inst = await prisma.instance.findUniqueOrThrow({ where: { id }, include: adminInstanceInclude });
    return toAdminInstance(inst);
  }
  const inst = await prisma.instance.findUniqueOrThrow({ where: { id }, include: instanceInclude });
  return toInstance(inst);
}

const POWER_ACTIONS = { start: 'START', stop: 'STOP', restart: 'RESTART', force_stop: 'FORCE_STOP' } as const satisfies Record<string, TaskType>;

export default async function instanceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);

  app.get('/api/instances', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.instance.findMany({
      where: { userId: user.id, status: { not: 'DELETED' } },
      include: instanceInclude,
      orderBy: { id: 'desc' },
      take: 500,
    });
    return rows.map(toInstance);
  });

  /** 实例转移记录：转入与转出我的账号的记录（最近 200 条） */
  app.get('/api/transfers', async (req): Promise<TransferRecordDTO[]> => {
    const user = requireUser(req);
    const rows = await prisma.instanceTransfer.findMany({
      where: { OR: [{ fromUserId: user.id }, { toUserId: user.id }] },
      include: {
        fromUser: { select: { username: true } },
        toUser: { select: { username: true } },
        instance: { include: transferSpecInclude },
      },
      orderBy: { id: 'desc' },
      take: 200,
    });
    return rows.map((r) => {
      const direction = r.toUserId === user.id ? 'IN' : 'OUT';
      return {
        id: r.id,
        instanceId: r.instanceId,
        hostname: r.hostname,
        direction,
        // 管理员操作时不显示对方账号
        counterpart: r.byAdmin ? null : direction === 'IN' ? r.fromUser.username : r.toUser.username,
        mode: r.mode,
        byAdmin: r.byAdmin,
        accessible: r.instance.userId === user.id && r.instance.status !== 'DELETED',
        remark: r.remark,
        // 手续费只对转出方显示
        fee: direction === 'OUT' ? money(r.fee) : '0.00',
        // 旧记录没有快照，用实例当前的信息
        spec: (r.spec as TransferSpecDTO | null) ?? transferSpec(r.instance),
        createdAt: r.createdAt.toISOString(),
      };
    });
  });

  // ───────── 跨实例汇总（侧边栏的端口映射 / 网站绑定 / 快照 / 操作日志页面） ─────────

  const instanceRef = { select: { id: true, name: true, hostname: true, type: true, status: true, privateIp: true, ipAddress: { select: { address: true } }, node: { select: { publicIp: true } } } } as const;
  type InstanceRef = { id: number; name: string; hostname: string; type: string; status: string; privateIp: string | null; ipAddress: { address: string } | null; node: { publicIp: string } };
  const ref = (i: InstanceRef) => ({
    id: i.id,
    name: i.name,
    hostname: i.hostname,
    type: i.type,
    status: i.status,
    publicIp: isNatType(i.type as Instance['type']) ? i.node.publicIp : (i.ipAddress?.address ?? null),
    privateIp: i.privateIp,
  });
  const mine = (userId: number) => ({ userId, status: { notIn: ['DELETED', 'DELETING'] as Instance['status'][] } });

  app.get('/api/ports', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.portMapping.findMany({
      where: { instance: mine(user.id) },
      include: { instance: instanceRef },
      orderBy: [{ instanceId: 'desc' }, { system: 'desc' }, { id: 'asc' }],
      take: 1000,
    });
    return rows.map((r) => ({ ...toPortMapping(r), instance: ref(r.instance) }));
  });

  app.get('/api/sites', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.siteBinding.findMany({
      where: { instance: mine(user.id) },
      include: { instance: instanceRef },
      orderBy: { id: 'desc' },
      take: 1000,
    });
    return rows.map((r) => ({ ...toSite(r), instance: ref(r.instance) }));
  });

  app.get('/api/snapshots', async (req) => {
    const user = requireUser(req);
    const rows = await prisma.snapshot.findMany({
      where: { instance: mine(user.id) },
      include: { instance: instanceRef },
      orderBy: { id: 'desc' },
      take: 1000,
    });
    return rows.map((r) => ({ ...toSnapshot(r), instance: ref(r.instance) }));
  });

  app.get('/api/tasks', async (req) => {
    const user = requireUser(req);
    const q = parse(pageQuery.extend({ status: z.enum(TASK_STATUSES).optional(), type: z.enum(TASK_TYPES).optional(), q: z.string().trim().max(100).optional() }), req.query);
    const where: Prisma.TaskWhereInput = {
      instance: { userId: user.id },
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      // 搜索实例名、主机名或错误信息
      ...(q.q ? { OR: [{ instance: { name: containsInsensitive(q.q) } }, { instance: { hostname: containsInsensitive(q.q) } }, { error: containsInsensitive(q.q) }] } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: { instance: { select: { name: true } }, user: { select: { id: true, username: true } } },
        orderBy: { id: 'desc' },
        ...paging(q),
      }),
      prisma.task.count({ where }),
    ]);
    return { items: items.map(toTask), total, page: q.page, pageSize: q.pageSize };
  });

  await app.register(instanceDetailRoutes, { prefix: '/api/instances' });
}

/** 实例操作共用实现，各后台使用独立路径与角色校验。 */
export async function instanceDetailRoutes(app: FastifyInstance, { admin = false }: { admin?: boolean }) {
  app.addHook('preHandler', admin ? adminGuard : consoleGuard);

  // 挂牌出售期间实例已关机并锁定：卖家只能查看、续费和开关自动续费，其他操作（含网页终端）都要先撤销挂牌；管理员不受限
  if (!admin) {
    app.addHook('preHandler', async (req) => {
      const { id } = (req.params ?? {}) as { id?: string };
      if (!id || !/^\d+$/.test(id)) return;
      const url = req.routeOptions.url ?? '';
      const readOnly = (req.method === 'GET' || req.method === 'HEAD') && !url.endsWith('/terminal') && !url.endsWith('/console');
      if (readOnly || url.endsWith('/:id/renew')) return;
      const body = req.body as Record<string, unknown> | null | undefined;
      if (req.method === 'PATCH' && url.endsWith('/:id') && body && typeof body === 'object' && Object.keys(body).every((k) => k === 'autoRenew')) return;
      await assertNotListed(Number(id));
    });
  }

  app.get('/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { isAdmin } = await loadInstance(req, id);
    return loadDto(id, isAdmin);
  });

  // 管理员的 PATCH 接口由 routes/admin/instances.ts 提供。
  if (!admin) app.patch('/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    const body = parse(z.object({ hostname: hostnameSchema.optional(), autoRenew: z.boolean().optional() }), req.body);
    if (inst.status === 'DELETED') throw badRequest(t('instance.deleted'));
    await prisma.instance.update({ where: { id }, data: body });
    syncInstanceHostname(inst, body.hostname);
    await logActivity(req, user.id, 'instance.update', `#${id} ${JSON.stringify(body)}`);
    return loadDto(id, isAdmin);
  });

  app.delete('/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    // 挂牌出售期间卖家不能删除（管理员可以，删除时挂牌自动下架）
    if (!isAdmin) await assertNotListed(id);
    const body = parse(z.object({ confirm: z.string() }), req.body);
    if (body.confirm !== inst.hostname) throw badRequest(t('instance.confirmMismatch'));
    if (inst.status === 'DELETED' || inst.status === 'DELETING') throw badRequest(t('instance.deleted'));
    await enqueueTask({ instanceId: id, type: 'DELETE', userId: user.id });
    await logActivity(req, user.id, 'instance.delete', `#${id} ${inst.hostname}`);
    return { ok: true };
  });

  // ───────── SWAP ─────────

  // 启用 / 关闭 SWAP（仅容器、套餐提供 SWAP 时），立即下发到宿主机；下发失败时恢复原状态
  app.post('/:id/swap', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    assertOperable(inst, isAdmin);
    if (isVmType(inst.type) || inst.swap <= 0) throw badRequest(t('swap.unavailable'));
    if (inst.swapEnabled !== enabled) {
      const next = { ...inst, swapEnabled: enabled };
      await (await getIncus(inst.node)).modifyInstance(inst.name, (i) => applyConfig(i.config, { 'limits.memory.swap': swapValue(next) }));
      await prisma.instance.update({ where: { id }, data: { swapEnabled: enabled } });
      await logActivity(req, user.id, 'instance.swap', `#${id} ${enabled ? 'on' : 'off'}`);
    }
    return loadDto(id, isAdmin);
  });

  // ───────── 智能分流 ─────────

  // 可选出口与当前出口（宿主机开启智能分流、NAT 实例）
  app.get('/:id/egress', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst } = await loadInstance(req, id);
    return instanceEgress(inst);
  });

  // 切换出口：null 为宿主机默认线路；Agent 约 10 秒内应用
  app.put('/:id/egress', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    const { egressId } = parse(z.object({ egressId: z.number().int().positive().nullable() }), req.body);
    assertOperable(inst, isAdmin);
    await setInstanceEgress(inst, egressId);
    await logActivity(req, user.id, 'instance.egress', `#${id} → ${egressId ?? 'direct'}`);
    return instanceEgress(await prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true } }));
  });

  // ───────── 切换机房 ─────────

  // 可切换的机房、本周期免费次数、额外切换费用与冷却时间
  app.get('/:id/switch-node', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    return switchInfo(id);
  });

  // 即时 Agent ICMP 检测：轮询等待任务完成，?fresh=1 重测（进行中时复用任务）。
  app.get('/:id/switch-node/check', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const { fresh } = parse(z.object({ fresh: z.enum(['0', '1']).optional() }), req.query);
    return checkIpv4(id, fresh === '1');
  });

  // 提交切换：在目标机房用所选系统全新安装，返回新的 root 密码（只显示一次）
  app.post('/:id/switch-node', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const body = parse(
      z.object({
        targetNodeId: z.number().int().positive(),
        imageId: z.number().int().positive(m('v.imageRequired')),
        password: instancePasswordSchema.optional().or(z.literal('').transform(() => undefined)),
        sshKeys: sshKeysSchema,
      }),
      req.body,
    );
    // 管理员代操作时费用记在实例所有者名下
    const owner = isAdmin ? await prisma.user.findUniqueOrThrow({ where: { id: inst.userId } }) : user;
    const result = await requestSwitch(owner, id, body);
    await logActivity(req, user.id, 'instance.switch_node', `#${id} ${inst.hostname} → node #${body.targetNodeId}${result.free ? ' free' : ` fee=${result.fee}`}`);
    return { password: result.password, free: result.free, fee: result.fee };
  });

  // ───────── 网页终端 ─────────

  app.get('/:id/console', { websocket: true }, (socket, req) => {
    const vga = (req.query as { type?: string }).type === 'vga';
    return serveTerminal(socket, req, async (opts) => {
      const { id } = parse(idParam, req.params);
      const { inst, user, isAdmin } = await loadInstance(req, id);
      assertOperable(inst, isAdmin);
      if (inst.status !== 'RUNNING') return t('terminal.notRunning');
      if (vga && !isVmType(inst.type)) return t('terminal.vgaVmOnly');
      const session = await (await getIncus(inst.node)).openConsole(inst.name, vga ? 'vga' : 'console', opts);
      await logActivity(req, user.id, 'instance.console', `#${id} ${vga ? 'vga' : 'serial'}`);
      return session;
    }, vga);
  });

  /** 浏览器 ⇄ WebSocket ⇄ Incus exec（root 交互式 shell），见 lib/terminal-socket.ts */
  app.get('/:id/terminal', { websocket: true }, (socket, req) =>
    serveTerminal(socket, req, async (opts) => {
      const { id } = parse(idParam, req.params);
      const { inst, user, isAdmin } = await loadInstance(req, id);
      assertOperable(inst, isAdmin);
      if (inst.status !== 'RUNNING') return t('terminal.notRunning');
      const client = await getIncus(inst.node);
      const session = await client.openTerminal(inst.name, opts).catch(async (error: unknown) => {
        if (!isVmType(inst.type) || !guestAgentUnavailable(error)) throw error;
        opts.onData(Buffer.from(t('terminal.serialFallback') + '\r\n'));
        return client.openConsole(inst.name, 'console', opts);
      });
      await logActivity(req, user.id, 'instance.terminal', `#${id} ${inst.hostname}`);
      return session;
    }),
  );

  // ───────── 状态与监控 ─────────

  app.get('/:id/state', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst } = await loadInstance(req, id);
    if (['CREATING', 'DELETING', 'DELETED'].includes(inst.status)) throw conflict(t('instance.stateUnavailable'));
    const state = await getLiveState(inst);
    // 被动状态同步：宿主机上的实际电源状态与面板记录不一致时立即更正（与每分钟统计同样的规则：只在开机 / 关机之间、且没有进行中的任务）
    if (inst.status === 'RUNNING' || inst.status === 'STOPPED') {
      const actual = state.status === 'Running' ? 'RUNNING' : state.status === 'Stopped' ? 'STOPPED' : null;
      if (actual && actual !== inst.status && !(await hasActiveTask(inst.id))) {
        await prisma.instance.updateMany({ where: { id: inst.id, status: inst.status }, data: { status: actual } });
      }
    }
    return state;
  });

  app.get('/:id/metrics', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const q = parse(z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60) }), req.query);
    return getMetricSeries(id, q.minutes);
  });

  app.get('/:id/traffic', async (req): Promise<TrafficDailyDTO[]> => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const since = dayjs().subtract(30, 'day').startOf('day').toDate();
    const rows = await prisma.trafficDaily.findMany({ where: { instanceId: id, date: { gte: since } }, orderBy: { date: 'asc' } });
    return rows.map((r) => ({ date: dayjs(r.date).format('YYYY-MM-DD'), rx: Number(r.rx), tx: Number(r.tx) }));
  });

  app.get('/:id/credentials', async (req): Promise<CredentialsDTO> => {
    const { id } = parse(idParam, req.params);
    const { inst, user } = await loadInstance(req, id);
    const ip = isNatType(inst.type) ? inst.node.publicIp : (await prisma.ipAddress.findUnique({ where: { instanceId: id } }))?.address;
    await logActivity(req, user.id, 'instance.credentials', `#${id}`);
    return {
      username: 'root',
      password: inst.rootPassword ? decrypt(inst.rootPassword) : null,
      host: ip ?? null,
      port: isNatType(inst.type) ? (inst.sshPort ?? 22) : 22,
    };
  });

  app.get('/:id/tasks', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const rows = await prisma.task.findMany({
      where: { instanceId: id },
      include: { user: { select: { id: true, username: true } } },
      orderBy: { id: 'desc' },
      take: 50,
    });
    return rows.map(toTask);
  });

  // ───────── 电源 / 重装 / 密码 / 续费 ─────────

  app.post('/:id/power', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    const body = parse(z.object({ action: z.enum(['start', 'stop', 'restart', 'force_stop']) }), req.body);
    assertOperable(inst, isAdmin);
    if (inst.status === 'SUSPENDED') throw badRequest(t('instance.unsuspendFirst'));
    const task = await enqueueTask({ instanceId: id, type: POWER_ACTIONS[body.action], userId: user.id });
    await logActivity(req, user.id, `instance.${body.action}`, `#${id}`);
    return toTask(task);
  });

  /** 重装可选的镜像：宿主机提供的、支持该实例类型的已启用镜像 */
  app.get('/:id/images', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst } = await loadInstance(req, id);
    const node = await prisma.node.findUnique({ where: { id: inst.nodeId }, select: { imageIds: true, arch: true } });
    const images = await listEnabledImages();
    return images.filter((i) => (isVmType(inst.type) ? i.forVm : i.forContainer) && !!node && nodeAllowsImage(node, i));
  });

  app.post('/:id/reinstall', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    if (!isAdmin) await assertNotListed(id);
    const body = parse(
      z.object({
        imageId: z.number().int().positive(),
        password: instancePasswordSchema.optional().or(z.literal('').transform(() => undefined)),
        sshKeys: sshKeysSchema,
      }),
      req.body,
    );
    if (inst.status !== 'ERROR' || !isAdmin) assertOperable(inst, isAdmin);
    if (!isAdmin) await reinstallCooldownCheck(inst);
    const image = await resolveReinstallImage(inst, body.imageId);
    const password = body.password || generatePassword();
    const task = await enqueueTask({
      instanceId: id,
      type: 'REINSTALL',
      userId: user.id,
      payload: { imageId: image.id, password: encrypt(password), sshKeys: body.sshKeys },
    });
    await logActivity(req, user.id, 'instance.reinstall', `#${id} → ${image.name}`);
    return { task: toTask(task), password };
  });

  /** 转移前检查接收方账号并计算手续费（输入账号时实时调用） */
  app.get('/:id/transfer/check', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req): Promise<TransferCheckDTO> => {
    const { id } = parse(idParam, req.params);
    const { inst, isAdmin } = await loadInstance(req, id);
    const { target } = parse(z.object({ target: z.string().trim().max(128).optional() }), req.query);
    const r = await checkTransfer(inst, target, isAdmin);
    return { fee: money(r.fee), recipient: r.recipient, error: r.error };
  });

  /** 转移实例（过户）给另一个用户：完整转移或全新安装后转移 */
  app.post('/:id/transfer', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    if (!isAdmin) await assertNotListed(id);
    const body = parse(
      z.object({
        target: z.string().trim().min(1, m('transfer.targetRequired')).max(128),
        mode: z.enum(TRANSFER_MODES),
        imageId: z.number().int().positive().optional(),
        remark: z.string().trim().max(200, m('v.tooLong')).optional(),
        confirm: z.string(),
      }),
      req.body,
    );
    if (body.confirm !== inst.hostname) throw badRequest(t('instance.confirmMismatch'));
    assertOperable(inst, isAdmin);
    const recipient = await transferInstance(inst, { actor: user, byAdmin: isAdmin, target: body.target, mode: body.mode, imageId: body.imageId, remark: body.remark });
    const detail = `#${id} ${inst.hostname} ${body.mode}`;
    await logActivity(req, user.id, 'instance.transfer_out', `${detail} → ${recipient.username}`);
    await logActivity(req, recipient.id, 'instance.transfer_in', `${detail} ← ${isAdmin ? 'admin' : user.username}`);
    return { ok: true, target: { id: recipient.id, username: recipient.username } };
  });

  // 用户付费重置流量（管理员在实例管理里直接重置，不收费）
  if (!admin)
    app.post('/:id/reset-traffic', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { id } = parse(idParam, req.params);
      const { inst, user } = await loadInstance(req, id);
      if (inst.userId !== user.id) throw forbidden(t('instance.notFound'));
      const invoice = await createTrafficResetInvoice(user.id, id);
      await logActivity(req, user.id, 'billing.invoice_create', invoice.no);
      return { invoice: invoiceDto(invoice) };
    });

  app.post('/:id/reset-password', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    if (!isAdmin) await assertNotListed(id);
    const body = parse(
      z.object({ password: instancePasswordSchema.optional().or(z.literal('').transform(() => undefined)) }),
      req.body,
    );
    assertOperable(inst, isAdmin);
    if (inst.status !== 'RUNNING') throw badRequest(t('instance.mustBeRunning'));
    const password = body.password || generatePassword();
    const task = await enqueueTask({
      instanceId: id,
      type: 'RESET_PASSWORD',
      userId: user.id,
      payload: { password: encrypt(password) },
    });
    await logActivity(req, user.id, 'instance.reset_password', `#${id}`);
    return { task: toTask(task), password };
  });

  if (!admin) app.post('/:id/renew', async (req) => {
    const { id } = parse(idParam, req.params);
    const { user, isAdmin } = await loadInstance(req, id);
    const body = parse(z.object({ periods: z.number().int().min(1).max(36).default(1), couponCode: z.string().trim().max(32).optional().transform((v) => v || undefined) }), req.body);
    const invoice = await createRenewInvoice(user.id, id, body.periods, body.couponCode);
    await logActivity(req, user.id, 'billing.invoice_create', invoice.no);
    return { invoice: invoiceDto(invoice) };
  });

  // ───────── 端口映射 ─────────

  app.get('/:id/ports', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const rows = await prisma.portMapping.findMany({ where: { instanceId: id }, orderBy: [{ system: 'desc' }, { id: 'asc' }] });
    return rows.map(toPortMapping);
  });

  app.post('/:id/ports', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const body = parse(
      z.object({
        protocol: z.enum(PORT_PROTOCOLS).default('TCP_UDP'),
        privatePort: z.number().int().min(1, m('v.portRange')).max(65535, m('v.portRange')),
        publicPort: z.number().int().min(1).max(65535).optional(),
        description: z.string().trim().max(64).optional(),
      }),
      req.body,
    );
    const mapping = await addPortMapping(inst, body);
    await logActivity(req, user.id, 'instance.port_add', `#${id} ${mapping.publicPort} → ${mapping.privatePort}/${mapping.protocol}`);
    return toPortMapping(mapping);
  });

  /** 修改端口映射的备注（端口与协议不可修改，需要删除后重新添加） */
  app.patch('/:id/ports/:mid', async (req) => {
    const { id, mid } = parse(z.object({ id: z.coerce.number().int(), mid: z.coerce.number().int() }), req.params);
    const { inst, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const body = parse(z.object({ description: z.string().trim().max(64).nullable() }), req.body);
    const mapping = await prisma.portMapping.findFirst({ where: { id: mid, instanceId: id } });
    if (!mapping) throw notFound(t('port.notFound'));
    const updated = await prisma.portMapping.update({ where: { id: mid }, data: { description: body.description || null } });
    return toPortMapping(updated);
  });

  app.delete('/:id/ports/:mid', async (req) => {
    const { id, mid } = parse(z.object({ id: z.coerce.number().int(), mid: z.coerce.number().int() }), req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const mapping = await prisma.portMapping.findFirst({ where: { id: mid, instanceId: id } });
    if (!mapping) throw notFound(t('port.notFound'));
    await removePortMapping(inst, mapping, { force: isAdmin });
    await logActivity(req, user.id, 'instance.port_remove', `#${id} ${mapping.publicPort}`);
    return { ok: true };
  });

  // ───────── 网站绑定 ─────────

  app.get('/:id/sites', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const rows = await prisma.siteBinding.findMany({ where: { instanceId: id }, orderBy: { id: 'asc' } });
    return rows.map(toSite);
  });

  app.post('/:id/sites', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    if (!isNatType(inst.type)) throw badRequest(t('site.ipv4Direct'));
    if (inst.node.networkMode === 'IPV6_ONLY') throw badRequest(t('site.ipv6Only'));
    const body = parse(
      z.object({
        domain: z.string().min(1, m('v.domainRequired')),
        targetPort: z.number().int().min(1).max(65535).default(80),
        https: z.boolean().default(true),
      }),
      req.body,
    );
    const domain = normalizeDomain(body.domain);
    const count = await prisma.siteBinding.count({ where: { instanceId: id } });
    if (count >= inst.siteLimit) throw badRequest(t('site.limit', { limit: inst.siteLimit }));
    await assertDomainAvailable(domain);
    const settings = await getSettings();
    if (settings.requireDnsCheck && !isAdmin) await checkDomainDns(domain, inst.node.publicIp);
    let site;
    try {
      site = await prisma.siteBinding.create({
        data: { instanceId: id, domain, targetPort: body.targetPort, https: body.https },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict(t('site.domainTaken'));
      throw err;
    }
    await syncSitesSafe(inst.nodeId);
    await logActivity(req, user.id, 'instance.site_add', `#${id} ${domain}`);
    return toSite(await prisma.siteBinding.findUniqueOrThrow({ where: { id: site.id } }));
  });

  app.patch('/:id/sites/:sid', async (req) => {
    const { id, sid } = parse(z.object({ id: z.coerce.number().int(), sid: z.coerce.number().int() }), req.params);
    const { inst, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const body = parse(
      z.object({ targetPort: z.number().int().min(1).max(65535).optional(), https: z.boolean().optional() }),
      req.body,
    );
    const site = await prisma.siteBinding.findFirst({ where: { id: sid, instanceId: id } });
    if (!site) throw notFound(t('site.notFound'));
    await prisma.siteBinding.update({ where: { id: sid }, data: { ...body, status: 'PENDING' } });
    await syncSitesSafe(inst.nodeId);
    return toSite(await prisma.siteBinding.findUniqueOrThrow({ where: { id: sid } }));
  });

  app.delete('/:id/sites/:sid', async (req) => {
    const { id, sid } = parse(z.object({ id: z.coerce.number().int(), sid: z.coerce.number().int() }), req.params);
    const { inst, user } = await loadInstance(req, id);
    const site = await prisma.siteBinding.findFirst({ where: { id: sid, instanceId: id } });
    if (!site) throw notFound(t('site.notFound'));
    await prisma.siteBinding.delete({ where: { id: sid } });
    await syncSitesSafe(inst.nodeId);
    await logActivity(req, user.id, 'instance.site_remove', `#${id} ${site.domain}`);
    return { ok: true };
  });

  // ───────── 快照 ─────────

  // ───────── 数据盘：用户可查看，只有管理员可以添加与删除 ─────────

  app.get('/:id/volumes', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const rows = await prisma.volume.findMany({ where: { instanceId: id }, orderBy: { id: 'asc' } });
    return rows.map(toVolume);
  });

  app.post('/:id/volumes', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    if (!isAdmin) throw forbidden();
    const body = parse(
      z.object({
        pool: z.string().trim().min(1),
        size: z.number().int().min(1).max(16384),
        path: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    const vol = await addVolume(inst, body);
    await logActivity(req, user.id, 'admin.volume_add', `#${id} ${vol.pool}/${vol.name} ${vol.size}GiB`);
    return toVolume(vol);
  });

  app.delete('/:id/volumes/:vid', async (req) => {
    const { id, vid } = parse(z.object({ id: z.coerce.number().int(), vid: z.coerce.number().int() }), req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    if (!isAdmin) throw forbidden();
    await removeVolume(inst, vid);
    await logActivity(req, user.id, 'admin.volume_remove', `#${id} volume ${vid}`);
    return { ok: true };
  });

  app.get('/:id/snapshots', async (req) => {
    const { id } = parse(idParam, req.params);
    await loadInstance(req, id);
    const rows = await prisma.snapshot.findMany({ where: { instanceId: id }, orderBy: { id: 'desc' } });
    return rows.map(toSnapshot);
  });

  app.post('/:id/snapshots', async (req) => {
    const { id } = parse(idParam, req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const body = parse(z.object({ description: z.string().trim().max(100).optional() }), req.body);
    const count = await prisma.snapshot.count({ where: { instanceId: id } });
    if (count >= inst.snapshotLimit) throw badRequest(t('snapshot.limit', { limit: inst.snapshotLimit }));
    const name = `snap-${dayjs().format('YYYYMMDD-HHmmss')}`;
    const task = await enqueueTask({
      instanceId: id,
      type: 'SNAPSHOT_CREATE',
      userId: user.id,
      payload: { name, description: body.description ?? '' },
    });
    await logActivity(req, user.id, 'instance.snapshot_create', `#${id} ${name}`);
    return toTask(task);
  });

  app.post('/:id/snapshots/:sid/restore', async (req) => {
    const { id, sid } = parse(z.object({ id: z.coerce.number().int(), sid: z.coerce.number().int() }), req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const snap = await prisma.snapshot.findFirst({ where: { id: sid, instanceId: id } });
    if (!snap) throw notFound(t('snapshot.notFound'));
    const task = await enqueueTask({ instanceId: id, type: 'SNAPSHOT_RESTORE', userId: user.id, payload: { snapshotId: sid } });
    await logActivity(req, user.id, 'instance.snapshot_restore', `#${id} ${snap.name}`);
    return toTask(task);
  });

  app.delete('/:id/snapshots/:sid', async (req) => {
    const { id, sid } = parse(z.object({ id: z.coerce.number().int(), sid: z.coerce.number().int() }), req.params);
    const { inst, user, isAdmin } = await loadInstance(req, id);
    assertOperable(inst, isAdmin);
    const snap = await prisma.snapshot.findFirst({ where: { id: sid, instanceId: id } });
    if (!snap) throw notFound(t('snapshot.notFound'));
    const task = await enqueueTask({ instanceId: id, type: 'SNAPSHOT_DELETE', userId: user.id, payload: { snapshotId: sid } });
    await logActivity(req, user.id, 'instance.snapshot_delete', `#${id} ${snap.name}`);
    return toTask(task);
  });
}

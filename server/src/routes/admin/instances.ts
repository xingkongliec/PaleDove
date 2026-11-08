import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILLING_CYCLES, CPU_PRIORITY_MAX, DEFAULT_LOCALE, DELETE_REFUND_MODES, type DeleteRefundMode, INSTANCE_STATUSES, INSTANCE_TYPES, IPV6_COUNT_MAX, normalizeLocale, OVER_LIMIT_ACTIONS, PROCESS_LIMIT_MIN, TRAFFIC_MODES, type BatchResultDTO, type DeleteRefundPreviewDTO } from '../../shared/index.ts';
import { badRequest, errorMessage } from '../../lib/errors.ts';
import { adminGuard, hostnameSchema, idParam, instancePasswordSchema, logActivity, pageQuery, paging, parse, requireAdmin, sshKeysSchema } from '../../lib/http.ts';
import { adminCreateInstance, previewRefundOnDelete } from '../../services/billing.ts';
import { containsInsensitive, prisma, Prisma } from '../../lib/prisma.ts';
import { dayjs } from '../../lib/time.ts';
import { assertMigratable } from '../../services/migration.ts';
import { resetTraffic } from '../../services/lifecycle.ts';
import { refreshPowerStatus, syncInstanceHostname } from '../../services/operations.ts';
import { adminInstanceInclude, toAdminInstance, toTask } from '../../services/serializers.ts';
import { enqueueTask } from '../../services/tasks.ts';
import { assertDiskLimits } from '../../services/spec.ts';
import { queueMail, renderNoticeMail } from '../../services/mail/business-mail.ts';
import { isMailConfigured, sendMail } from '../../services/mail/mailer.ts';
import { getSetting } from '../../lib/settings.ts';
import { m, runWithLocale, t } from '../../i18n/index.ts';

/** 自助重置流量的价格：空值表示不开放；修改时不传表示不变 */
const resetPrice = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => (v === undefined ? undefined : v === null || v === '' ? null : new Prisma.Decimal(v)))
  .refine((v) => v == null || (v.isFinite() && !v.isNegative()), m('v.price'));

/** 封禁 / 删除原因（选填，用户可见） */
const actionNote = z
  .string()
  .trim()
  .max(500)
  .optional()
  .transform((v) => v || undefined);

/** 删除任务的参数：指定了退款方式时按方式退款并通知用户，否则只退还未开通的实例 */
function deletePayload(body: { refund?: boolean; refundMode?: DeleteRefundMode; note?: string }) {
  return body.refundMode ? { refundMode: body.refundMode, note: body.note ?? null } : { refund: body.refund ?? true };
}

async function migrationTarget(id: number | undefined) {
  if (!id) throw badRequest(t('migrate.targetRequired'));
  const node = await prisma.node.findUnique({ where: { id } });
  if (!node) throw badRequest(t('migrate.targetRequired'));
  return node;
}

export default async function adminInstanceRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/instances', async (req) => {
    const q = parse(
      pageQuery.extend({
        q: z.string().trim().optional(),
        status: z.enum(INSTANCE_STATUSES).optional(),
        type: z.enum(INSTANCE_TYPES).optional(),
        nodeId: z.coerce.number().int().optional(),
        userId: z.coerce.number().int().optional(),
        includeDeleted: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    const where: Prisma.InstanceWhereInput = {
      ...(q.status ? { status: q.status } : q.includeDeleted ? {} : { status: { not: 'DELETED' } }),
      ...(q.type ? { type: q.type } : {}),
      ...(q.nodeId ? { nodeId: q.nodeId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.q
        ? {
            OR: [
              { hostname: containsInsensitive(q.q) },
              { name: containsInsensitive(q.q) },
              { privateIp: { contains: q.q } },
              { ipAddress: { address: { contains: q.q } } },
              { user: { username: containsInsensitive(q.q) } },
              { user: { email: containsInsensitive(q.q) } },
              ...(/^\d+$/.test(q.q) ? [{ id: Number(q.q) }] : []),
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      prisma.instance.findMany({ where, include: adminInstanceInclude, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.instance.count({ where }),
    ]);
    return { items: items.map(toAdminInstance), total, page: q.page, pageSize: q.pageSize };
  });

  /** 为用户创建实例：规格自由填写，直接指定宿主机；可选择从用户余额扣除首期费用 */
  app.post('/api/admin/instances', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        userId: z.number().int().positive(),
        nodeId: z.number().int().positive(),
        planId: z.number().int().positive().nullable().default(null),
        type: z.enum(INSTANCE_TYPES),
        imageId: z.number().int().positive(),
        hostname: hostnameSchema,
        password: instancePasswordSchema.optional().or(z.literal('').transform(() => undefined)),
        sshKeys: sshKeysSchema,
        cpu: z.number().int().min(1).max(256),
        cpuAllowance: z.number().int().min(1).max(100).nullable().default(null),
        cpuPriority: z.number().int().min(0).max(CPU_PRIORITY_MAX).nullable().default(null),
        processLimit: z.number().int().min(PROCESS_LIMIT_MIN).max(1_000_000).nullable().default(null),
        memory: z.number().int().min(64),
        swap: z.number().int().min(0).max(65536).default(0),
        disk: z.number().int().min(1),
        diskRead: z.number().int().min(0).max(100_000).default(0),
        diskWrite: z.number().int().min(0).max(100_000).default(0),
        diskReadIops: z.number().int().min(0).max(10_000_000).default(0),
        diskWriteIops: z.number().int().min(0).max(10_000_000).default(0),
        bandwidthIn: z.number().int().min(0),
        bandwidthOut: z.number().int().min(0),
        traffic: z.number().int().min(0),
        trafficMode: z.enum(TRAFFIC_MODES),
        overLimitAction: z.enum(OVER_LIMIT_ACTIONS),
        throttleRate: z.number().int().min(1),
        trafficResetPrice: resetPrice,
        portLimit: z.number().int().min(0),
        siteLimit: z.number().int().min(0),
        snapshotLimit: z.number().int().min(0),
        storagePool: z.string().trim().max(64).nullable().optional().transform((v) => v || null),
        ipv6Count: z.number().int().min(0).max(IPV6_COUNT_MAX).optional(),
        privileged: z.boolean().default(false),
        nesting: z.boolean().default(true),
        billingCycle: z.enum(BILLING_CYCLES),
        price: z
          .union([z.string(), z.number()])
          .transform((v) => new Prisma.Decimal(v))
          .refine((v) => v.isFinite() && !v.isNegative(), m('v.price')),
        expiresAt: z.coerce.date().refine((d) => d.getTime() > Date.now(), m('adminCreate.expiresPast')),
        autoRenew: z.boolean().default(false),
        remark: z.string().trim().max(500).nullable().optional().transform((v) => v || null),
        charge: z.boolean().default(false),
      }),
      req.body,
    );
    assertDiskLimits(body);
    const instance = await adminCreateInstance(admin, body);
    const charged = body.charge ? ` charge=${body.price}` : '';
    await logActivity(req, admin.id, 'admin.instance_create', `#${instance.id} ${instance.hostname} user=${body.userId} node=${body.nodeId}${charged}`);
    return { instanceId: instance.id };
  });

  app.patch('/api/admin/instances/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        hostname: hostnameSchema.optional(),
        cpu: z.number().int().min(1).optional(),
        cpuAllowance: z.number().int().min(1).max(100).nullable().optional(),
        cpuPriority: z.number().int().min(0).max(CPU_PRIORITY_MAX).nullable().optional(),
        processLimit: z.number().int().min(PROCESS_LIMIT_MIN).max(1_000_000).nullable().optional(),
        memory: z.number().int().min(64).optional(),
        swap: z.number().int().min(0).max(65536).optional(),
        disk: z.number().int().min(1).optional(),
        diskRead: z.number().int().min(0).max(100_000).optional(),
        diskWrite: z.number().int().min(0).max(100_000).optional(),
        diskReadIops: z.number().int().min(0).max(10_000_000).optional(),
        diskWriteIops: z.number().int().min(0).max(10_000_000).optional(),
        bandwidthIn: z.number().int().min(0).optional(),
        bandwidthOut: z.number().int().min(0).optional(),
        traffic: z.number().int().min(0).optional(),
        trafficMode: z.enum(TRAFFIC_MODES).optional(),
        overLimitAction: z.enum(OVER_LIMIT_ACTIONS).optional(),
        throttleRate: z.number().int().min(1).optional(),
        trafficResetPrice: resetPrice,
        portLimit: z.number().int().min(0).optional(),
        siteLimit: z.number().int().min(0).optional(),
        snapshotLimit: z.number().int().min(0).optional(),
        expiresAt: z.coerce.date().optional(),
        price: z.union([z.string(), z.number()]).transform((v) => new Prisma.Decimal(v)).optional(),
        autoRenew: z.boolean().optional(),
        remark: z.string().trim().max(500).nullable().optional(),
        userId: z.number().int().optional(),
      }),
      req.body,
    );
    const before = await prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
    if (body.hostname && ['DELETED', 'DELETING'].includes(before.status)) throw badRequest(t('instance.deleted'));
    if (body.disk !== undefined && body.disk < before.disk) throw badRequest(t('instance.diskShrink'));
    assertDiskLimits(body, before);
    if (body.userId) await prisma.user.findUniqueOrThrow({ where: { id: body.userId } });
    await prisma.instance.update({ where: { id }, data: body });
    syncInstanceHostname(before, body.hostname);
    const limitKeys = ['cpu', 'cpuAllowance', 'cpuPriority', 'processLimit', 'memory', 'swap', 'disk', 'diskRead', 'diskWrite', 'diskReadIops', 'diskWriteIops', 'bandwidthIn', 'bandwidthOut', 'throttleRate'] as const;
    const needApply = limitKeys.some((k) => body[k] !== undefined && body[k] !== before[k]);
    if (needApply && !['CREATING', 'DELETED', 'DELETING'].includes(before.status)) {
      await enqueueTask({ instanceId: id, type: 'APPLY_LIMITS', userId: admin.id, exclusive: false });
    }
    await logActivity(req, admin.id, 'admin.instance_update', `#${id} ${JSON.stringify(body)}`);
    const inst = await prisma.instance.findUniqueOrThrow({ where: { id }, include: adminInstanceInclude });
    return toAdminInstance(inst);
  });

  /**
   * 批量操作（实例列表多选）：逐个处理，单个失败不影响其他实例，返回成功数与失败明细。
   *  - sync / suspend / unsuspend / delete：与单个实例的操作相同
   *  - extend：赠送时长（天），已过期的实例从现在起算；因到期被封停的实例自动解封
   *  - config：批量修改规格、性能限制、带宽与流量、配额和续费设置，只修改填写了的字段；变化的资源限制会下发到宿主机
   *  - notify：给所选实例的所有者发站内信（每个用户一封，附上相关实例）
   */
  // 删除前的退款预览：列出每个实例在各退款方式下的退款金额与合计（已删除的实例跳过）
  app.post('/api/admin/instances/refund-preview', async (req): Promise<DeleteRefundPreviewDTO> => {
    const body = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(200) }), req.body);
    const list = await prisma.instance.findMany({
      where: { id: { in: body.ids }, status: { not: 'DELETED' } },
      include: { user: { select: { username: true } } },
      orderBy: { id: 'asc' },
    });
    const zero = () => ({ REMAINING: new Prisma.Decimal(0), FULL: new Prisma.Decimal(0), NONE: new Prisma.Decimal(0) });
    const total = zero();
    const items: DeleteRefundPreviewDTO['items'] = [];
    for (const inst of list) {
      const refund = await previewRefundOnDelete(inst);
      for (const mode of DELETE_REFUND_MODES) total[mode] = total[mode].plus(refund[mode]);
      items.push({
        id: inst.id,
        hostname: inst.hostname,
        username: inst.user.username,
        refund: { REMAINING: refund.REMAINING.toFixed(2), FULL: refund.FULL.toFixed(2), NONE: refund.NONE.toFixed(2) },
      });
    }
    return { items, total: { REMAINING: total.REMAINING.toFixed(2), FULL: total.FULL.toFixed(2), NONE: total.NONE.toFixed(2) } };
  });

  app.post('/api/admin/instances/batch', async (req): Promise<BatchResultDTO> => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        ids: z.array(z.number().int().positive()).min(1).max(200),
        action: z.enum(['sync', 'suspend', 'unsuspend', 'delete', 'extend', 'config', 'notify', 'migrate']),
        targetNodeId: z.number().int().positive().optional(),
        refund: z.boolean().optional(),
        days: z.number().int().min(1).max(3650).optional(),
        // 只修改传入的字段；可为空的字段传 null 表示取消限制 / 恢复默认
        config: z
          .object({
            cpu: z.number().int().min(1).optional(),
            cpuAllowance: z.number().int().min(1).max(100).nullable().optional(),
            cpuPriority: z.number().int().min(0).max(CPU_PRIORITY_MAX).nullable().optional(),
            processLimit: z.number().int().min(PROCESS_LIMIT_MIN).max(1_000_000).nullable().optional(),
            memory: z.number().int().min(64).optional(),
            swap: z.number().int().min(0).max(65536).optional(),
            disk: z.number().int().min(1).optional(),
            diskRead: z.number().int().min(0).max(100_000).optional(),
            diskWrite: z.number().int().min(0).max(100_000).optional(),
            diskReadIops: z.number().int().min(0).max(10_000_000).optional(),
            diskWriteIops: z.number().int().min(0).max(10_000_000).optional(),
            bandwidthIn: z.number().int().min(0).optional(),
            bandwidthOut: z.number().int().min(0).optional(),
            traffic: z.number().int().min(0).optional(),
            trafficMode: z.enum(TRAFFIC_MODES).optional(),
            overLimitAction: z.enum(OVER_LIMIT_ACTIONS).optional(),
            throttleRate: z.number().int().min(1).optional(),
            trafficResetPrice: resetPrice,
            portLimit: z.number().int().min(0).optional(),
            siteLimit: z.number().int().min(0).optional(),
            snapshotLimit: z.number().int().min(0).optional(),
            price: z
              .union([z.string(), z.number()])
              .transform((v) => new Prisma.Decimal(v))
              .refine((v) => v.isFinite() && !v.isNegative(), m('v.price'))
              .optional(),
            autoRenew: z.boolean().optional(),
          })
          .optional(),
        title: z.string().trim().max(200).optional(),
        content: z.string().trim().max(5000).optional(),
        // 通知用户时同时发送邮件
        email: z.boolean().optional(),
        note: actionNote,
        refundMode: z.enum(DELETE_REFUND_MODES).optional(),
      }),
      req.body,
    );
    if (body.action === 'extend' && !body.days) throw badRequest(t('batch.daysRequired'));
    if (body.action === 'config' && !Object.values(body.config ?? {}).some((v) => v !== undefined)) throw badRequest(t('batch.configRequired'));
    if (body.action === 'notify' && (!body.title || !body.content)) throw badRequest(t('batch.messageRequired'));
    const target = body.action === 'migrate' ? await migrationTarget(body.targetNodeId) : null;

    const instances = await prisma.instance.findMany({ where: { id: { in: body.ids } }, include: { node: true } });
    const result: BatchResultDTO = { ok: 0, failed: [] };

    if (body.action === 'notify') {
      if (body.email && !isMailConfigured(await getSetting('mail'))) throw badRequest(t('batch.mailOff'));
      // 按用户去重：每个用户一封，附上相关实例
      const byUser = new Map<number, string[]>();
      for (const inst of instances) byUser.set(inst.userId, [...(byUser.get(inst.userId) ?? []), inst.hostname]);
      await prisma.message.createMany({
        data: [...byUser].map(([userId, hosts]) => ({
          userId,
          title: body.title!,
          content: `${body.content}\n\n${t('batch.relatedInstances', { list: hosts.join('、') })}`,
        })),
      });
      result.ok = instances.length;
      result.notified = { users: byUser.size, mailSent: 0, mailQueued: 0 };
      if (body.email) {
        // 只发给已设置邮箱、状态正常的用户；单个收件人立即发送，多个收件人进入队列每分钟发 1 封
        const users = await prisma.user.findMany({ where: { id: { in: [...byUser.keys()] }, status: 'ACTIVE', email: { not: '' } } });
        for (const u of users) {
          const mail = await runWithLocale(normalizeLocale(u.locale) ?? DEFAULT_LOCALE, () =>
            renderNoticeMail(u, body.title!, body.content!, t('batch.relatedInstances', { list: byUser.get(u.id)!.join('、') })),
          );
          if (users.length === 1) {
            if (await sendMail(u.email, mail.subject, mail.html)) result.notified.mailSent++;
          } else {
            await queueMail(u.email, mail.subject, mail.html);
            result.notified.mailQueued++;
          }
        }
      }
      await logActivity(req, admin.id, 'admin.instance_batch_notify', `${byUser.size} users / ${instances.length} instances${body.email ? ' +email' : ''}: ${body.title}`);
      return result;
    }

    // 这些字段变化后需要下发到宿主机
    const limitKeys = ['cpu', 'cpuAllowance', 'cpuPriority', 'processLimit', 'memory', 'swap', 'disk', 'diskRead', 'diskWrite', 'diskReadIops', 'diskWriteIops', 'bandwidthIn', 'bandwidthOut', 'throttleRate'] as const;
    for (const inst of instances) {
      try {
        switch (body.action) {
          case 'sync':
            await refreshPowerStatus(inst);
            break;
          case 'suspend':
            if (inst.status === 'SUSPENDED') throw badRequest(t('instance.alreadySuspended'));
            if (inst.status === 'DELETED') throw badRequest(t('instance.deleted'));
            await enqueueTask({ instanceId: inst.id, type: 'SUSPEND', userId: admin.id, payload: { reason: 'ADMIN', note: body.note ?? null } });
            break;
          case 'unsuspend':
            if (inst.status !== 'SUSPENDED') throw badRequest(t('instance.notSuspended'));
            await enqueueTask({ instanceId: inst.id, type: 'UNSUSPEND', userId: admin.id });
            break;
          case 'delete':
            if (inst.status === 'DELETED' || inst.status === 'DELETING') throw badRequest(t('instance.deleted'));
            await enqueueTask({ instanceId: inst.id, type: 'DELETE', userId: admin.id, payload: deletePayload(body), exclusive: false });
            break;
          case 'extend': {
            if (inst.status === 'DELETED') throw badRequest(t('instance.deleted'));
            const base = inst.expiresAt > new Date() ? inst.expiresAt : new Date();
            const expiresAt = dayjs(base).add(body.days!, 'day').toDate();
            await prisma.instance.update({ where: { id: inst.id }, data: { expiresAt } });
            if (inst.status === 'SUSPENDED' && inst.suspendReason === 'EXPIRED') await enqueueTask({ instanceId: inst.id, type: 'UNSUSPEND', userId: admin.id });
            break;
          }
          case 'migrate':
            await assertMigratable(inst, target!);
            await enqueueTask({ instanceId: inst.id, type: 'MIGRATE', userId: admin.id, payload: { targetNodeId: target!.id } });
            break;
          case 'config': {
            if (inst.status === 'DELETED') throw badRequest(t('instance.deleted'));
            const data = body.config!;
            // 系统盘不能缩小；磁盘读写限制每个方向只能按速率或 IOPS 其中一种
            if (data.disk !== undefined && data.disk < inst.disk) throw badRequest(t('instance.diskShrink'));
            assertDiskLimits(data, inst);
            await prisma.instance.update({ where: { id: inst.id }, data });
            const needApply = limitKeys.some((k) => data[k] !== undefined && data[k] !== inst[k]);
            if (needApply && !['CREATING', 'DELETING'].includes(inst.status)) {
              await enqueueTask({ instanceId: inst.id, type: 'APPLY_LIMITS', userId: admin.id, exclusive: false });
            }
            break;
          }
        }
        result.ok++;
      } catch (err) {
        result.failed.push({ id: inst.id, hostname: inst.hostname, message: errorMessage(err) });
      }
    }
    const extra = [body.action === 'delete' && body.refundMode ? `refund=${body.refundMode}` : '', body.note ?? ''].filter(Boolean).join(' ');
    await logActivity(req, admin.id, `admin.instance_batch_${body.action}`, `${result.ok}/${instances.length} ${body.ids.join(',')}${extra ? ` ${extra}` : ''}`);
    return result;
  });

  app.post('/api/admin/instances/:id/actions', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        action: z.enum(['suspend', 'unsuspend', 'reset_traffic', 'retry_create', 'apply_limits', 'delete', 'sync', 'migrate']),
        refund: z.boolean().optional(),
        targetNodeId: z.number().int().positive().optional(),
        note: actionNote,
        refundMode: z.enum(DELETE_REFUND_MODES).optional(),
      }),
      req.body,
    );
    const inst = await prisma.instance.findUniqueOrThrow({ where: { id }, include: { node: true } });
    let task = null;
    switch (body.action) {
      case 'suspend':
        if (inst.status === 'SUSPENDED') throw badRequest(t('instance.alreadySuspended'));
        task = await enqueueTask({ instanceId: id, type: 'SUSPEND', userId: admin.id, payload: { reason: 'ADMIN', note: body.note ?? null } });
        break;
      case 'unsuspend':
        if (inst.status !== 'SUSPENDED') throw badRequest(t('instance.notSuspended'));
        task = await enqueueTask({ instanceId: id, type: 'UNSUSPEND', userId: admin.id });
        break;
      case 'reset_traffic':
        await resetTraffic(id, { advanceCycle: false });
        break;
      case 'retry_create':
        if (inst.status !== 'ERROR' || inst.provisionedAt) throw badRequest(t('instance.retryOnlyFailed'));
        task = await enqueueTask({ instanceId: id, type: 'CREATE', userId: admin.id });
        break;
      case 'apply_limits':
        task = await enqueueTask({ instanceId: id, type: 'APPLY_LIMITS', userId: admin.id });
        break;
      case 'delete':
        if (inst.status === 'DELETED' || inst.status === 'DELETING') throw badRequest(t('instance.deleted'));
        task = await enqueueTask({
          instanceId: id,
          type: 'DELETE',
          userId: admin.id,
          payload: deletePayload(body),
          exclusive: false,
        });
        break;
      case 'sync':
        await refreshPowerStatus(inst);
        break;
      case 'migrate': {
        const target = await migrationTarget(body.targetNodeId);
        await assertMigratable(inst, target);
        task = await enqueueTask({ instanceId: id, type: 'MIGRATE', userId: admin.id, payload: { targetNodeId: target.id } });
        break;
      }
    }
    const detail = body.action === 'migrate' ? ` → node #${body.targetNodeId}` : body.action === 'delete' && body.refundMode ? ` refund=${body.refundMode}` : '';
    await logActivity(req, admin.id, `admin.instance_${body.action}`, `#${id}${detail}${body.note ? ` ${body.note}` : ''}`);
    return { task: task ? toTask(task) : null };
  });
}

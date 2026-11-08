import { DELETE_REFUND_MODES, isNatType, type DeleteRefundMode } from '../shared/index.ts';
import { getIncus, IncusError, type IncusApi } from '../incus/index.ts';
import { decrypt, encrypt } from '../lib/crypto.ts';
import { errorMessage } from '../lib/errors.ts';
import { prisma, Prisma, type Image, type Instance, type IpAddress, type Node, type PortMapping, type SuspendReason, type Task } from '../lib/prisma.ts';
import { refundOnDelete, refundUnprovisioned } from './billing.ts';
import { syncSitesSafe } from './gateway.ts';
import { runWithLocale, t } from '../i18n/index.ts';
import { DEFAULT_LOCALE, normalizeLocale } from '../shared/index.ts';
import { reconcileProxyDevices } from './portmap.ts';
import { applyConfig, applyDiskLimits, autostartValue, buildCreateRequest, buildLimitsConfig, cloudInitConfig, imageSource, nicLimits } from './spec.ts';
import { runSwitch } from './node-switch.ts';
import { migrateInstance } from './migration.ts';
import { repairNetwork, syncBaseline } from './node-ops.ts';
import { deleteInstanceVolumes } from './volumes.ts';
import { reapplyVpcGuest } from './vpc.ts';
import { sendBusinessNotice } from './mail/business-mail.ts';
import { bumpEgressVersion } from './egress.ts';
import { invalidateCache } from '../lib/cache.ts';
import { getSettings } from '../lib/settings.ts';
import { syncProvisioningNetwork, withPrivateIpRecovery } from './provisioning-network.ts';

export type FullInstance = Instance & {
  node: Node;
  image: Image | null;
  ipAddress: IpAddress | null;
  portMappings: PortMapping[];
};

/** 尽力同步系统内主机名；实例记录保存成功后不等待宿主机。 */
export function syncInstanceHostname(inst: Instance & { node: Node }, hostname?: string): void {
  if (!hostname || hostname === inst.hostname || inst.status !== 'RUNNING') return;
  void getIncus(inst.node)
    .then((incus) => incus.exec(inst.name, ['sh', '-c', 'hostname "$H" 2>/dev/null; echo "$H" > /etc/hostname'], {
      env: { H: hostname }, timeoutSec: 15,
    }))
    .catch(() => undefined);
}

export async function loadFullInstance(id: number): Promise<FullInstance> {
  return prisma.instance.findUniqueOrThrow({
    where: { id },
    include: { node: true, image: true, ipAddress: true, portMappings: true },
  });
}

interface Ctx {
  task: Task;
  inst: FullInstance;
  incus: IncusApi;
  payload: Record<string, unknown>;
}

const setStatus = (id: number, data: Prisma.InstanceUpdateInput) => prisma.instance.update({ where: { id }, data });

async function isRunning(incus: IncusApi, name: string): Promise<boolean> {
  const st = await incus.getInstanceState(name);
  return st.status === 'Running';
}

async function ensureStopped(ctx: Ctx, force = true): Promise<void> {
  if (await isRunning(ctx.incus, ctx.inst.name)) {
    await ctx.incus.setState(ctx.inst.name, 'stop', { force, timeout: force ? 30 : 60 });
  }
}

/** 重命名实例（需已停止）：宿主机上改名并更新面板记录；实例在宿主机上不存在时只更新记录 */
async function renameStopped(ctx: Ctx, newName: string): Promise<void> {
  if (ctx.inst.name === newName) return;
  if (await ctx.incus.instanceExists(ctx.inst.name)) await ctx.incus.renameInstance(ctx.inst.name, newName);
  await setStatus(ctx.inst.id, { name: newName });
  ctx.inst.name = newName;
}

async function ensureStarted(ctx: Ctx): Promise<void> {
  if (!(await isRunning(ctx.incus, ctx.inst.name))) await ctx.incus.setState(ctx.inst.name, 'start');
}

/** 由 Incus 实际状态回填数据库中的电源状态 */
export async function refreshPowerStatus(inst: Pick<Instance, 'id' | 'name' | 'status'> & { node: Node }): Promise<void> {
  try {
    const incus = await getIncus(inst.node);
    const running = await isRunning(incus, inst.name);
    if (inst.status === 'RUNNING' || inst.status === 'STOPPED' || inst.status === 'ERROR') {
      await setStatus(inst.id, { status: running ? 'RUNNING' : 'STOPPED' });
    }
  } catch {
    /* 节点不可达时保持原状态 */
  }
}

function cloudInitVars(ctx: Ctx, password: string) {
  const keys = Array.isArray(ctx.payload.sshKeys) ? (ctx.payload.sshKeys as string[]) : [];
  return { hostname: ctx.inst.hostname, password, sshKeys: keys };
}

function payloadPassword(ctx: Ctx): string {
  if (typeof ctx.payload.password === 'string') return decrypt(ctx.payload.password);
  if (ctx.inst.rootPassword) return decrypt(ctx.inst.rootPassword);
  throw new Error(t('task.noPassword'));
}

// ───────── 处理器 ─────────

const handlers: Record<Task['type'], (ctx: Ctx) => Promise<void>> = {
  async CREATE(ctx) {
    const { inst, incus } = ctx;
    if (!inst.image) throw new Error(t('task.noImage'));
    await setStatus(inst.id, { status: 'CREATING', lastError: null });
    await withPrivateIpRecovery(inst, incus, async () => {
      if (!(await incus.instanceExists(inst.name))) {
        const req = buildCreateRequest({
          instance: inst,
          node: inst.node,
          image: inst.image!,
          ip: inst.ipAddress,
          portMappings: inst.portMappings,
          vars: cloudInitVars(ctx, payloadPassword(ctx)),
        });
        await incus.createInstance(req);
      } else {
        await syncProvisioningNetwork(inst, incus);
        await ensureStarted(ctx);
      }
    });
    // 创建期间新增的端口映射在此补齐
    await reconcileProxyDevices(inst);
    await setStatus(inst.id, { status: 'RUNNING', provisionedAt: inst.provisionedAt ?? new Date(), lastError: null });
    await syncSitesSafe(inst.nodeId);
  },

  async START(ctx) {
    await withPrivateIpRecovery(ctx.inst, ctx.incus, async () => {
      await syncProvisioningNetwork(ctx.inst, ctx.incus);
      await ensureStarted(ctx);
    });
    await setStatus(ctx.inst.id, { status: 'RUNNING', provisionedAt: ctx.inst.provisionedAt ?? new Date(), lastError: null });
  },

  async STOP(ctx) {
    if (await isRunning(ctx.incus, ctx.inst.name)) {
      await ctx.incus.setState(ctx.inst.name, 'stop', { timeout: 90 });
    }
    await setStatus(ctx.inst.id, { status: 'STOPPED' });
  },

  async FORCE_STOP(ctx) {
    await ensureStopped(ctx, true);
    await setStatus(ctx.inst.id, { status: 'STOPPED' });
  },

  async RESTART(ctx) {
    if (await isRunning(ctx.incus, ctx.inst.name)) {
      try {
        await ctx.incus.setState(ctx.inst.name, 'restart', { timeout: 90 });
      } catch {
        // 优雅重启超时则强制重启
        await ctx.incus.setState(ctx.inst.name, 'restart', { force: true, timeout: 30 });
      }
    } else {
      await ctx.incus.setState(ctx.inst.name, 'start');
    }
    await setStatus(ctx.inst.id, { status: 'RUNNING', lastError: null });
  },

  async REINSTALL(ctx) {
    const { inst, incus } = ctx;
    const imageId = Number(ctx.payload.imageId);
    const image = await prisma.image.findUniqueOrThrow({ where: { id: imageId } });
    const password = payloadPassword(ctx);
    await setStatus(inst.id, { status: 'REINSTALLING', lastError: null });
    await ensureStopped(ctx, true);
    // 过户后全新安装：趁已关机把实例 ID 改为新所有者
    if (typeof ctx.payload.rename === 'string') await renameStopped(ctx, ctx.payload.rename);
    // 重装前删除所有快照（rebuild 要求实例无快照）
    for (const snap of await incus.listSnapshots(inst.name)) await incus.deleteSnapshot(inst.name, snap);
    await prisma.snapshot.deleteMany({ where: { instanceId: inst.id } });
    const ci = cloudInitConfig({ instance: inst, node: inst.node, image, ip: inst.ipAddress, vars: cloudInitVars(ctx, password) });
    // 更新 cloud-init 配置；rebuild 后根文件系统为全新镜像，cloud-init 会重新执行
    await incus.modifyInstance(inst.name, (i) => Object.assign(i.config, ci));
    await incus.rebuildInstance(inst.name, imageSource(image));
    await incus.setState(inst.name, 'start');
    await setStatus(inst.id, {
      status: 'RUNNING',
      image: { connect: { id: image.id } },
      rootPassword: encrypt(password),
      lastReinstallAt: new Date(),
    });
  },

  /** 过户后重命名：关机、改名，原来在运行的再开机 */
  async RENAME(ctx) {
    const name = String(ctx.payload.name);
    if (ctx.inst.name === name) return;
    const exists = await ctx.incus.instanceExists(ctx.inst.name);
    const wasRunning = exists && (await isRunning(ctx.incus, ctx.inst.name));
    if (wasRunning) await ensureStopped(ctx, false);
    await renameStopped(ctx, name);
    if (wasRunning) await ctx.incus.setState(name, 'start');
  },

  async RESET_PASSWORD(ctx) {
    const password = payloadPassword(ctx);
    if (!(await isRunning(ctx.incus, ctx.inst.name))) throw new Error(t('task.notRunningPassword'));
    const result = await ctx.incus.exec(
      ctx.inst.name,
      ['sh', '-c', 'printf "root:%s\\n" "$INK_PW" | chpasswd'],
      { env: { INK_PW: password }, timeoutSec: 60 },
    );
    if (result.exitCode !== 0) {
      throw new Error(t('task.passwordFailed', { detail: (result.stderr || result.stdout || '').trim().slice(0, 300) || `exit ${result.exitCode}` }));
    }
    // 同步更新 cloud-init，保证后续重装前密码一致
    if (ctx.inst.image) {
      const ci = cloudInitConfig({ instance: ctx.inst, node: ctx.inst.node, image: ctx.inst.image, ip: ctx.inst.ipAddress, vars: cloudInitVars(ctx, password) });
      await ctx.incus
        .modifyInstance(ctx.inst.name, (i) => {
          i.config['cloud-init.user-data'] = ci['cloud-init.user-data'];
        })
        .catch(() => undefined);
    }
    await setStatus(ctx.inst.id, { rootPassword: encrypt(password) });
  },

  async SNAPSHOT_CREATE(ctx) {
    const name = String(ctx.payload.name);
    await ctx.incus.createSnapshot(ctx.inst.name, name);
    await prisma.snapshot.upsert({
      where: { instanceId_name: { instanceId: ctx.inst.id, name } },
      create: { instanceId: ctx.inst.id, name, description: (ctx.payload.description as string) || null },
      update: {},
    });
  },

  async SNAPSHOT_RESTORE(ctx) {
    const snap = await prisma.snapshot.findUniqueOrThrow({ where: { id: Number(ctx.payload.snapshotId) } });
    const wasRunning = await isRunning(ctx.incus, ctx.inst.name);
    if (wasRunning) await ctx.incus.setState(ctx.inst.name, 'stop', { force: true, timeout: 30 });
    await ctx.incus.restoreSnapshot(ctx.inst.name, snap.name);
    if (wasRunning) await ctx.incus.setState(ctx.inst.name, 'start');
    await setStatus(ctx.inst.id, { status: wasRunning ? 'RUNNING' : 'STOPPED' });
  },

  async SNAPSHOT_DELETE(ctx) {
    const snap = await prisma.snapshot.findUnique({ where: { id: Number(ctx.payload.snapshotId) } });
    if (!snap) return;
    try {
      await ctx.incus.deleteSnapshot(ctx.inst.name, snap.name);
    } catch (err) {
      if (!(err instanceof IncusError && err.isNotFound)) throw err;
    }
    await prisma.snapshot.delete({ where: { id: snap.id } });
  },

  async SUSPEND(ctx) {
    const reason = (ctx.payload.reason as SuspendReason) || 'ADMIN';
    await ensureStopped(ctx, true);
    await ctx.incus.modifyInstance(ctx.inst.name, (i) => {
      i.config['boot.autostart'] = 'false';
    });
    // 管理员填写的封禁原因（用户可见）；到期、流量超额的封禁没有
    const note = typeof ctx.payload.note === 'string' && ctx.payload.note ? ctx.payload.note : null;
    await setStatus(ctx.inst.id, { status: 'SUSPENDED', suspendReason: reason, suspendNote: note });
    await syncSitesSafe(ctx.inst.nodeId);
  },

  async UNSUSPEND(ctx) {
    const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: ctx.inst.id } });
    if (fresh.status !== 'SUSPENDED') return;
    // 仍处于到期状态则不解除
    if (fresh.expiresAt < new Date()) throw new Error(t('task.stillExpired'));
    await ctx.incus.modifyInstance(ctx.inst.name, (i) => {
      applyConfig(i.config, { 'boot.autostart': autostartValue({ ...fresh, status: 'RUNNING' }) });
    });
    await ensureStarted(ctx);
    await setStatus(ctx.inst.id, { status: 'RUNNING', suspendReason: null, suspendNote: null });
    await syncSitesSafe(ctx.inst.nodeId);
  },

  async APPLY_LIMITS(ctx) {
    const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: ctx.inst.id } });
    await ctx.incus.modifyInstance(ctx.inst.name, (i) => {
      applyConfig(i.config, buildLimitsConfig(fresh));
      applyDiskLimits(i.devices, fresh);
      // eth1 为公网 IPv6 网卡（如有），与 eth0 使用相同的限速
      for (const nic of [i.devices.eth0, i.devices.eth1]) {
        if (!nic) continue;
        delete nic['limits.ingress'];
        delete nic['limits.egress'];
        Object.assign(nic, nicLimits(fresh));
      }
      if (i.devices.root) i.devices.root.size = `${fresh.disk}GiB`;
    });
    if (isNatType(fresh.type)) await reconcileProxyDevices({ ...fresh, node: ctx.inst.node });
  },

  async DELETE(ctx) {
    const { inst, incus } = ctx;
    // 重复的删除任务（例如对删除中的实例再次提交）直接跳过，避免重复退款
    if ((await prisma.instance.findUniqueOrThrow({ where: { id: inst.id }, select: { status: true } })).status === 'DELETED') return;
    await setStatus(inst.id, { status: 'DELETING' });
    try {
      await ensureStopped(ctx, true);
      await incus.deleteInstance(inst.name);
    } catch (err) {
      if (!(err instanceof IncusError && err.isNotFound)) throw err;
    }
    // 实例删除后其数据盘设备随之移除，再删除对应的卷
    await deleteInstanceVolumes(inst.id, incus);
    const hadSites = (await prisma.siteBinding.count({ where: { instanceId: inst.id } })) > 0;
    const requested = ctx.payload.refundMode as DeleteRefundMode | undefined;
    const mode = requested && DELETE_REFUND_MODES.includes(requested) ? requested : null;
    let refunded = new Prisma.Decimal(0);
    await prisma.$transaction(async (tx) => {
      await tx.portMapping.deleteMany({ where: { instanceId: inst.id } });
      await tx.siteBinding.deleteMany({ where: { instanceId: inst.id } });
      await tx.snapshot.deleteMany({ where: { instanceId: inst.id } });
      // 实例删除后，它的交易市场挂牌随之下架
      await tx.marketListing.updateMany({ where: { instanceId: inst.id, status: 'ACTIVE' }, data: { status: 'REMOVED', endReason: 'instance deleted' } });
      await tx.ipAddress.updateMany({ where: { instanceId: inst.id }, data: { instanceId: null } });
      // 管理员删除时指定退款方式；其他情况（用户删除、到期释放）只退还从未开通的实例
      if (mode) refunded = await refundOnDelete(tx, inst, mode);
      else if (ctx.payload.refund !== false) await refundUnprovisioned(tx, inst);
      await tx.instance.update({
        where: { id: inst.id },
        data: { status: 'DELETED', deletedAt: new Date(), privateIp: null, publicIpv6: null, ipv6Prefixes: null, sshPort: null, rootPassword: null, vpcId: null, vpcIp: null },
      });
    });
    if (hadSites) await syncSitesSafe(inst.nodeId);
    // 使用了智能分流出口：刷新宿主机分流配置，撤销该实例（已释放的内网地址）的规则
    if (inst.egressId) await bumpEgressVersion(inst.nodeId);
    // 库存变化：在售目录缓存失效
    await invalidateCache('catalog');
    // 管理员删除：站内信告知用户删除原因与退款金额
    if (mode) await notifyAdminDelete(inst, typeof ctx.payload.note === 'string' ? ctx.payload.note : '', refunded);
  },

  async MIGRATE(ctx) {
    await migrateInstance(ctx.inst.id, Number(ctx.payload.targetNodeId), ctx.incus);
  },

  async SYNC_BASELINE(ctx) {
    await syncBaseline(ctx.inst, ctx.incus);
  },

  async REPAIR_NETWORK(ctx) {
    await repairNetwork(ctx.inst, ctx.incus, { restart: ctx.payload.restart === true });
  },

  /** 用户切换机房：在同产品的其他宿主机上全新安装（见 services/node-switch.ts） */
  async SWITCH_NODE(ctx) {
    await runSwitch(ctx.inst.id, ctx.payload, ctx.incus, payloadPassword(ctx));
  },
};

/** 任务失败后的实例状态处理 */
async function onFailure(task: Task, inst: FullInstance, message: string): Promise<void> {
  switch (task.type) {
    case 'CREATE':
    case 'REINSTALL':
      await setStatus(inst.id, { status: 'ERROR', lastError: message });
      break;
    case 'DELETE':
      await setStatus(inst.id, { status: 'ERROR', lastError: t('task.deleteFailed', { message }) });
      break;
    case 'MIGRATE':
    case 'SWITCH_NODE': {
      // 迁移 / 切换机房任务自己负责回滚与恢复状态；回滚也失败时实例停留在迁移中，标记为异常
      const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id }, select: { status: true } });
      await setStatus(inst.id, { lastError: message, ...(fresh.status === 'MIGRATING' ? { status: 'ERROR' as const } : {}) });
      break;
    }
    default:
      await setStatus(inst.id, { lastError: message });
      await refreshPowerStatus(inst);
  }
}

/** 执行一个任务；状态与错误写回 Task 表，不向外抛出。错误消息使用发起用户的语言 */
/** 管理员删除实例后给所有者发站内信：删除原因与退款金额（使用所有者的语言） */
async function notifyAdminDelete(inst: Instance, note: string, refunded: Prisma.Decimal): Promise<void> {
  const owner = await prisma.user.findUnique({ where: { id: inst.userId }, select: { locale: true } });
  const { currency } = await getSettings();
  await runWithLocale(normalizeLocale(owner?.locale) ?? DEFAULT_LOCALE, () =>
    prisma.message.create({
      data: {
        userId: inst.userId,
        title: t('delete.msgTitle', { hostname: inst.hostname }),
        content: [
          t('delete.msgBody', { hostname: inst.hostname }),
          note ? t('delete.msgReason', { note }) : null,
          refunded.gt(0) ? t('delete.msgRefund', { amount: `${currency}${refunded.toFixed(2)}` }) : t('delete.msgNoRefund'),
        ]
          .filter(Boolean)
          .join('\n'),
      },
    }),
  );
}

export async function runTask(taskId: number): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, include: { user: { select: { locale: true } } } });
  if (!task || task.status === 'SUCCESS' || task.status === 'FAILED') return;
  const locale = normalizeLocale(task.user?.locale) ?? DEFAULT_LOCALE;
  await runWithLocale(locale, () => executeTask(task));
}

async function executeTask(task: Task): Promise<void> {
  if (!task.instanceId) {
    await prisma.task.update({ where: { id: task.id }, data: { status: 'FAILED', error: t('task.missingInstance'), finishedAt: new Date() } });
    return;
  }
  await prisma.task.update({ where: { id: task.id }, data: { status: 'RUNNING', startedAt: new Date() } });
  const inst = await loadFullInstance(task.instanceId);
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  // 任务结束后清除载荷中的敏感字段
  const sanitized = { ...payload };
  delete sanitized.password;
  try {
    if (inst.status === 'DELETED') throw new Error(t('task.instanceDeleted'));
    const incus = await getIncus(inst.node);
    await handlers[task.type]({ task, inst, incus, payload });
    // 开机、重装、恢复快照后确认实例内的 VPC 内网地址（重装会清空系统盘）
    if (inst.vpcId && ['CREATE', 'START', 'RESTART', 'REINSTALL', 'UNSUSPEND', 'SNAPSHOT_RESTORE'].includes(task.type)) reapplyVpcGuest(inst.id);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'SUCCESS', finishedAt: new Date(), payload: sanitized as Prisma.InputJsonValue },
    });
    // 只在操作成功后通知；失败的任务不会声称已停机或已释放。
    const event = task.type === 'DELETE' && payload.reason === 'expired' ? 'released' : task.type === 'SUSPEND' && payload.reason === 'EXPIRED' ? 'expired' : task.type === 'SUSPEND' && payload.reason === 'TRAFFIC' ? 'traffic' : null;
    if (event) {
      const { graceDays } = await getSettings();
      const releaseAt = new Date(inst.expiresAt.getTime() + graceDays * 86400_000).toISOString();
      void sendBusinessNotice(inst.userId, event, { name: inst.hostname, time: releaseAt }, `${inst.id}:${event === 'traffic' ? inst.trafficResetAt.toISOString() : inst.expiresAt.toISOString()}`).catch((error) => console.error('instance notification email failed', error));
    }
  } catch (err) {
    const message = errorMessage(err).slice(0, 2000);
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'FAILED', error: message, finishedAt: new Date(), payload: sanitized as Prisma.InputJsonValue },
    });
    await onFailure(task, inst, message).catch(() => undefined);
  }
}

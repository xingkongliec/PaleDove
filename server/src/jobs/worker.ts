import { DelayedError, Worker } from 'bullmq';
import type { FastifyBaseLogger } from 'fastify';
import { config } from '../config.ts';
import { prisma } from '../lib/prisma.ts';
import { acquireLock, redis } from '../lib/redis.ts';
import { alignLegacyTrafficResets, checkNodes, collectAllNodes, runExpiryChecks, runTrafficResets } from '../services/lifecycle.ts';
import { runTask } from '../services/operations.ts';
import { expireStalePayments } from '../services/payments/payments.ts';
import { settleAff } from '../services/aff.ts';
import { sendQueuedMail } from '../services/mail/business-mail.ts';
import { t as tr } from '../i18n/index.ts';
import {
  addTaskJob,
  CRON_QUEUE,
  getCronQueue,
  hasTaskJob,
  memoryTaskQueue,
  queueConnection,
  TASK_QUEUE,
  type TaskJobData,
} from './queue.ts';
import type { MemoryTaskQueue } from './memory-queue.ts';

const CRON_JOBS: { name: string; every: number }[] = [
  { name: 'collect-metrics', every: config.METRICS_INTERVAL_SEC * 1000 },
  { name: 'check-nodes', every: 60_000 },
  { name: 'traffic-reset', every: 10 * 60_000 },
  { name: 'expiry', every: 5 * 60_000 },
  { name: 'payments-expire', every: 30 * 60_000 },
  { name: 'aff-settle', every: 10 * 60_000 },
  // 批量通知邮件：每分钟发送 1 封
  { name: 'mail-queue', every: 60_000 },
];

type CronLog = { info: (m: string) => void; warn: (m: string) => void };

/** 执行任务；同一实例的任务串行执行，锁被占用时返回 false 由调用方延迟重试，而不是占着 Worker 并发槽等待 */
async function processTask(taskId: number): Promise<boolean> {
  const task = await prisma.task.findUnique({ where: { id: taskId }, select: { instanceId: true, type: true } });
  if (!task) return true;
  // 迁移需要传输整个磁盘，执行锁给更长的时间
  const release = await acquireLock(`inst-exec:${task.instanceId}`, (task.type === 'MIGRATE' ? 8 * 60 : 45) * 60_000);
  if (!release) return false;
  try {
    await runTask(taskId);
  } finally {
    await release();
  }
  return true;
}

async function runCronJob(name: string, log: CronLog): Promise<unknown> {
  switch (name) {
    case 'collect-metrics':
      return collectAllNodes(log);
    case 'check-nodes':
      return checkNodes(log);
    case 'traffic-reset':
      return runTrafficResets(log);
    case 'expiry':
      return runExpiryChecks(log);
    case 'payments-expire':
      await Promise.all([
        prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now()-7*86400_000) } } }),
        prisma.emailVerificationToken.deleteMany({ where: { expiresAt: { lt: new Date(Date.now()-7*86400_000) } } }),
      ]);
      return expireStalePayments();
    case 'aff-settle':
      // 冻结期已过的佣金计入可用佣金
      return settleAff();
    case 'mail-queue':
      return sendQueuedMail(log);
  }
}

export async function startWorkers(log: FastifyBaseLogger): Promise<() => Promise<void>> {
  log = log.child({ scope: 'WORKER' });
  // 上次进程退出时仍在执行的任务已中断（执行锁已过期/不存在），标记为失败；排队中的任务会被 BullMQ 继续执行
  const running = await prisma.task.findMany({ where: { status: 'RUNNING' } });
  for (const t of running) {
    if (await redis.exists(`lock:inst-exec:${t.instanceId}`)) continue;
    await prisma.task.update({
      where: { id: t.id },
      data: { status: 'FAILED', error: tr('task.interrupted'), finishedAt: new Date() },
    });
    if (t.instanceId && ['CREATE', 'REINSTALL', 'DELETE'].includes(t.type)) {
      await prisma.instance.update({
        where: { id: t.instanceId },
        data: { status: 'ERROR', lastError: tr('task.interruptedRetry') },
      });
    }
    // 迁移中断时实例可能停留在任一宿主机上，需要管理员确认
    if (t.instanceId && (t.type === 'MIGRATE' || t.type === 'SWITCH_NODE')) {
      await prisma.instance.update({ where: { id: t.instanceId }, data: { status: 'ERROR', lastError: tr('migrate.interrupted') } });
    }
    log.warn({ taskId: t.id }, '重启前未完成的任务已标记为失败');
  }

  // 补发数据库中排队但不在队列里的任务（例如 Redis 数据丢失；内存队列在重启后总是为空）
  const queued = await prisma.task.findMany({ where: { status: 'QUEUED' }, select: { id: true }, orderBy: { id: 'asc' } });
  for (const t of queued) {
    if (!(await hasTaskJob(t.id))) await addTaskJob(t.id);
  }

  const cronLog: CronLog = {
    info: (m: string) => log.info({ scope: 'CRON' }, m),
    warn: (m: string) => log.warn({ scope: 'CRON' }, m),
  };
  await alignLegacyTrafficResets(cronLog).catch((err) => log.warn({ scope: 'CRON', err }, '对齐流量重置时间失败'));
  const stop = memoryTaskQueue ? startMemoryWorkers(memoryTaskQueue, log, cronLog) : await startBullWorkers(log, cronLog);
  log.debug({ concurrency: config.WORKER_CONCURRENCY, schedulerCount: CRON_JOBS.length }, '后台任务与定时调度已就绪');
  return stop;
}

async function startBullWorkers(log: FastifyBaseLogger, cronLog: CronLog): Promise<() => Promise<void>> {
  const taskWorker = new Worker<TaskJobData>(
    TASK_QUEUE,
    async (job, token) => {
      if (!(await processTask(job.data.taskId))) {
        await job.moveToDelayed(Date.now() + 3000, token);
        throw new DelayedError();
      }
    },
    { connection: queueConnection(), concurrency: config.WORKER_CONCURRENCY, lockDuration: 120_000 },
  );
  taskWorker.on('failed', (job, err) => log.error({ scope: 'TASK', taskId: job?.data.taskId, err }, '实例任务执行失败'));

  const cronQueue = getCronQueue();
  for (const job of CRON_JOBS) {
    await cronQueue.upsertJobScheduler(job.name, { every: job.every }, { name: job.name });
  }
  const cronWorker = new Worker(
    CRON_QUEUE,
    async (job) => {
      try {
        return await runCronJob(job.name, cronLog);
      } catch (err) {
        log.error({ scope: 'CRON', job: job.name, err }, '定时任务执行失败');
        throw err;
      }
    },
    { connection: queueConnection(), concurrency: 2 },
  );

  return async () => {
    await Promise.all([taskWorker.close(), cronWorker.close()]);
  };
}

/** 内存模式：进程内队列执行任务，定时任务用定时器驱动（启动后立即执行一次，同一定时任务不重叠执行） */
function startMemoryWorkers(queue: MemoryTaskQueue, log: FastifyBaseLogger, cronLog: CronLog): () => Promise<void> {
  queue.start(processTask, config.WORKER_CONCURRENCY, (taskId, err) =>
    log.error({ scope: 'TASK', taskId, err }, '实例任务执行失败'),
  );

  const running = new Map<string, Promise<void>>();
  const tick = (name: string) => {
    if (running.has(name)) return;
    const run = runCronJob(name, cronLog)
      .then(() => undefined)
      .catch((err) => log.error({ scope: 'CRON', job: name, err }, '定时任务执行失败'))
      .finally(() => running.delete(name));
    running.set(name, run);
  };
  const timers = CRON_JOBS.map((job) => {
    setImmediate(() => tick(job.name));
    return setInterval(() => tick(job.name), job.every);
  });

  return async () => {
    for (const t of timers) clearInterval(t);
    await queue.close();
    await Promise.all(running.values());
  };
}

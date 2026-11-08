import { conflict } from '../lib/errors.ts';
import { prisma, Prisma, type Task, type TaskType } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { addTaskJob } from '../jobs/queue.ts';
import { t } from '../i18n/index.ts';

export interface EnqueueOptions {
  instanceId: number;
  type: TaskType;
  payload?: Record<string, unknown>;
  userId?: number | null;
  /** 默认 true：实例存在进行中的任务时拒绝提交；系统任务可设为 false 排队执行 */
  exclusive?: boolean;
}

export async function hasActiveTask(instanceId: number): Promise<boolean> {
  const count = await prisma.task.count({ where: { instanceId, status: { in: ['QUEUED', 'RUNNING'] } } });
  return count > 0;
}

/** 在事务中创建任务记录（不入队），事务提交后需调用 dispatchTask */
export function createTaskRecord(tx: Prisma.TransactionClient, opts: EnqueueOptions): Promise<Task> {
  return tx.task.create({
    data: {
      instanceId: opts.instanceId,
      type: opts.type,
      userId: opts.userId ?? null,
      payload: (opts.payload ?? {}) as Prisma.InputJsonValue,
    },
  });
}

export async function dispatchTask(task: Pick<Task, 'id'>): Promise<void> {
  await addTaskJob(task.id);
}

export async function enqueueTask(opts: EnqueueOptions): Promise<Task> {
  const task = await withLock(`task-enqueue:${opts.instanceId}`, 10_000, async () => {
    if (opts.exclusive !== false && (await hasActiveTask(opts.instanceId))) {
      throw conflict(t('task.busy'));
    }
    return createTaskRecord(prisma, opts);
  });
  await dispatchTask(task);
  return task;
}

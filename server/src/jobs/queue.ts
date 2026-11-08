import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { config } from '../config.ts';
import { createQueueConnection } from '../lib/redis.ts';
import { MemoryTaskQueue } from './memory-queue.ts';

export const TASK_QUEUE = 'paledove-tasks';
export const CRON_QUEUE = 'paledove-cron';

export interface TaskJobData {
  taskId: number;
}

let taskQueue: Queue<TaskJobData> | null = null;
let cronQueue: Queue | null = null;
/** 传入 BullMQ 的连接不会被其自动关闭，需要自行释放 */
const connections: Redis[] = [];

/** REDIS_URL=memory:// 时用进程内队列代替 BullMQ */
export const memoryTaskQueue = config.memoryRedis ? new MemoryTaskQueue() : null;

export function queueConnection(): Redis {
  const conn = createQueueConnection();
  connections.push(conn);
  return conn;
}

export function getTaskQueue(): Queue<TaskJobData> {
  taskQueue ??= new Queue<TaskJobData>(TASK_QUEUE, {
    connection: queueConnection(),
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000, attempts: 1 },
  });
  return taskQueue;
}

export function getCronQueue(): Queue {
  cronQueue ??= new Queue(CRON_QUEUE, {
    connection: queueConnection(),
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
  });
  return cronQueue;
}

/** 投递任务；同一任务重复投递会被忽略 */
export async function addTaskJob(taskId: number): Promise<void> {
  if (memoryTaskQueue) return memoryTaskQueue.add(taskId);
  await getTaskQueue().add('task', { taskId }, { jobId: `task-${taskId}` });
}

/** 任务是否已在队列中（排队、延迟或执行中） */
export async function hasTaskJob(taskId: number): Promise<boolean> {
  if (memoryTaskQueue) return memoryTaskQueue.has(taskId);
  return Boolean(await getTaskQueue().getJob(`task-${taskId}`));
}

export async function closeQueues(): Promise<void> {
  await memoryTaskQueue?.close();
  await Promise.all([taskQueue?.close(), cronQueue?.close()]);
  await Promise.all(connections.map((c) => c.quit().catch(() => c.disconnect())));
  connections.length = 0;
  taskQueue = null;
  cronQueue = null;
}

/**
 * 进程内任务队列（REDIS_URL=memory://），代替 BullMQ：
 * 按投递顺序执行、限制并发、同一任务去重；处理函数返回 false 时延迟后重新排队。
 * 未启动 Worker 前投递的任务会暂存，start 后开始执行。
 */
export type TaskHandler = (taskId: number) => Promise<boolean>;

const RETRY_DELAY_MS = 3000;

export class MemoryTaskQueue {
  private readonly pending: number[] = [];
  /** 排队、延迟重试或执行中的任务 */
  private readonly known = new Set<number>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private handler: TaskHandler | null = null;
  private concurrency = 1;
  private active = 0;
  private closed = false;
  private onError: (taskId: number, err: unknown) => void = () => {};

  async add(taskId: number): Promise<void> {
    if (this.closed || this.known.has(taskId)) return;
    this.known.add(taskId);
    this.pending.push(taskId);
    this.pump();
  }

  async has(taskId: number): Promise<boolean> {
    return this.known.has(taskId);
  }

  start(handler: TaskHandler, concurrency: number, onError: (taskId: number, err: unknown) => void): void {
    this.handler = handler;
    this.concurrency = concurrency;
    this.onError = onError;
    this.pump();
  }

  /** 停止接收与调度新任务，等待执行中的任务结束 */
  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    while (this.active > 0) await new Promise((r) => setTimeout(r, 50));
  }

  private pump() {
    while (this.handler && !this.closed && this.active < this.concurrency && this.pending.length > 0) {
      void this.run(this.handler, this.pending.shift()!);
    }
  }

  private async run(handler: TaskHandler, taskId: number) {
    this.active++;
    let done = true;
    try {
      done = await handler(taskId);
    } catch (err) {
      this.onError(taskId, err);
    } finally {
      this.active--;
    }
    if (done || this.closed) {
      this.known.delete(taskId);
    } else {
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.pending.push(taskId);
        this.pump();
      }, RETRY_DELAY_MS);
      this.retryTimers.add(timer);
    }
    this.pump();
  }
}

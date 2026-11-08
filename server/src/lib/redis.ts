import { resolve } from 'node:path';
import { Redis } from 'ioredis';
import { config } from '../config.ts';
import { MemoryRedis } from './memory-redis.ts';

/** REDIS_URL=memory:// 时的进程内存储，数据保存在 data/memory-redis.json */
const memoryStore = config.memoryRedis ? new MemoryRedis(config.NODE_ENV === 'test' ? undefined : resolve('data', 'memory-redis.json')) : null;

/**
 * 通用 Redis 连接（缓存、会话、指标、限流、锁）：
 *  - enableAutoPipelining：同一事件循环中发出的命令合并为一次往返，并发请求时显著减少网络开销；
 *  - keepAlive：保持 TCP 长连接，避免空闲后被中间设备断开。
 */
export const redis: Redis = memoryStore
  ? asRedis(memoryStore)
  : new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3, enableAutoPipelining: true, keepAlive: 30_000, connectionName: 'paledove' });

/** 释放锁的脚本：注册为命令后以 EVALSHA 执行，不必每次发送脚本内容 */
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
if (!memoryStore) redis.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_LOCK });

// ───────── 发布订阅（多进程之间同步缓存失效） ─────────

let subscriber: Redis | null = null;
const listeners = new Map<string, Set<(message: string) => void>>();

/** 订阅频道（共用一条订阅连接）；内存模式只有一个进程，本进程内直接回调 */
export function subscribe(channel: string, handler: (message: string) => void): void {
  let set = listeners.get(channel);
  if (!set) {
    set = new Set();
    listeners.set(channel, set);
    if (!memoryStore) {
      if (!subscriber) {
        subscriber = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, keepAlive: 30_000, connectionName: 'paledove-sub' });
        subscriber.on('message', (ch: string, msg: string) => listeners.get(ch)?.forEach((fn) => fn(msg)));
        subscriber.on('error', () => undefined);
      }
      void subscriber.subscribe(channel).catch(() => undefined);
    }
  }
  set.add(handler);
}

/** 发布消息：其他进程（与本进程）的订阅者收到 */
export async function publish(channel: string, message: string): Promise<void> {
  if (memoryStore) {
    listeners.get(channel)?.forEach((fn) => fn(message));
    return;
  }
  await redis.publish(channel, message).catch(() => undefined);
}

/** 以 ioredis 的类型对外提供内存存储；调用未实现的命令时给出明确错误，而不是 undefined is not a function */
function asRedis(store: MemoryRedis): Redis {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop !== 'then' && !(prop in target)) {
        throw new Error(`memory redis: command "${prop}" is not implemented (see src/lib/memory-redis.ts)`);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as Redis;
}

/** BullMQ 要求阻塞连接不限制重试次数 */
export function createQueueConnection(): Redis {
  return new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
}

/** 简单的分布式锁：返回释放函数，获取失败返回 null */
export async function acquireLock(key: string, ttlMs: number): Promise<(() => Promise<void>) | null> {
  const token = Math.random().toString(36).slice(2);
  const ok = await redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
  if (!ok) return null;
  return async () => {
    // 仅释放自己持有的锁
    if (memoryStore) {
      await memoryStore.compareAndDelete(`lock:${key}`, token);
      return;
    }
    await (redis as Redis & { releaseLock(key: string, token: string): Promise<number> }).releaseLock(`lock:${key}`, token);
  };
}

/** 获取锁失败时等待重试 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = await acquireLock(key, ttlMs);
    if (release) {
      try {
        return await fn();
      } finally {
        await release();
      }
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for lock: ${key}`);
    await new Promise((r) => setTimeout(r, 100 + Math.random() * 150));
  }
}

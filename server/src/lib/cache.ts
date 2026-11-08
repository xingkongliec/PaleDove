// Redis 共享缓存：多个 API 进程共用，按命名空间整体失效。
//  - 键为 cache:<ns>:v<版本>:<key>；失效时递增命名空间版本（cache:ver:<ns>），旧键随过期时间自然清理，不需要扫描删除；
//  - 同一进程内相同键的并发请求只加载一次（single-flight），缓存失效瞬间不会把请求全部打到数据库；
//  - Redis 不可用时直接加载，不影响接口可用性。
import { redis } from './redis.ts';

/** 缓存命名空间：catalog 为在售套餐 / 产品 / 镜像，settings 为公开配置 */
export type CacheNamespace = 'catalog' | 'settings';

const VERSION_KEY = (ns: CacheNamespace) => `cache:ver:${ns}`;
const inflight = new Map<string, Promise<unknown>>();

/** 读取缓存，没有时调用 load 并写入（ttlSec 秒后过期） */
export async function cached<T>(ns: CacheNamespace, key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  let fullKey: string;
  try {
    const version = (await redis.get(VERSION_KEY(ns))) ?? '0';
    fullKey = `cache:${ns}:v${version}:${key}`;
    const hit = await redis.get(fullKey);
    if (hit !== null) return JSON.parse(hit) as T;
  } catch {
    return load();
  }
  const pending = inflight.get(fullKey) as Promise<T> | undefined;
  if (pending) return pending;
  const task = (async () => {
    try {
      const value = await load();
      await redis.set(fullKey, JSON.stringify(value), 'EX', ttlSec).catch(() => undefined);
      return value;
    } finally {
      inflight.delete(fullKey);
    }
  })();
  inflight.set(fullKey, task);
  return task;
}

/** 让命名空间下的全部缓存失效（各进程下一次读取时重新加载） */
export async function invalidateCache(...namespaces: CacheNamespace[]): Promise<void> {
  await Promise.all(namespaces.map((ns) => redis.incr(VERSION_KEY(ns)).catch(() => undefined)));
}

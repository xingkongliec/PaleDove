import type { SystemInfoDTO } from '../shared/index.ts';
import { config } from '../config.ts';
import { isSqlite, prisma } from './prisma.ts';
import { redis } from './redis.ts';

const CHECK_TIMEOUT_MS = 2000;

/** 执行检查并计时；超时或出错视为不可用（避免依赖故障时拖住仪表盘接口） */
async function probe<T>(fn: () => Promise<T>): Promise<{ ok: boolean; value: T | null; latencyMs: number | null }> {
  const start = performance.now();
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS).unref()),
    ]);
    return { ok: true, value, latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, value: null, latencyMs: null };
  }
}

/** 实时检测数据库与缓存的连通性和版本，并附带本进程的运行信息 */
export async function getSystemInfo(): Promise<SystemInfoDTO> {
  const [db, cache] = await Promise.all([
    probe(async () => {
      const rows = isSqlite
        ? await prisma.$queryRaw<{ v: string }[]>`SELECT sqlite_version() AS v`
        : await prisma.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version') AS v`;
      // PostgreSQL 可能返回 "16.4 (Debian 16.4-1.pgdg120+2)"，只取版本号
      return rows[0]?.v.split(' ')[0] ?? null;
    }),
    config.memoryRedis
      ? Promise.resolve({ ok: true, value: null, latencyMs: null })
      : probe(async () => {
          const info = await redis.info('server');
          return /^redis_version:(.+)$/m.exec(info)?.[1]?.trim() ?? null;
        }),
  ]);

  return {
    status: db.ok && cache.ok ? 'ok' : 'degraded',
    database: { kind: isSqlite ? 'SQLite' : 'PostgreSQL', version: db.value, ok: db.ok, latencyMs: db.latencyMs },
    cache: { kind: config.memoryRedis ? 'memory' : 'Redis', version: cache.value, ok: cache.ok, latencyMs: cache.latencyMs },
    queue: config.memoryRedis ? 'memory' : 'BullMQ',
    worker: config.RUN_WORKER,
    uptime: Math.round(process.uptime()),
    memory: process.memoryUsage().rss,
    node: process.version,
  };
}

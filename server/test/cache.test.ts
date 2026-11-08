import { describe, expect, it } from 'vitest';

describe('redis shared cache', () => {
  it('caches loads, coalesces concurrent misses and invalidates by namespace', async () => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'file:./data/cache-test-unused.db', REDIS_URL: 'memory://', APP_SECRET: 'test-cache-secret-1234567890', LOG_LEVEL: 'error' });
    const { cached, invalidateCache } = await import('../src/lib/cache.ts');
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 20));
      return { n: loads, at: 'x' };
    };
    // 并发的未命中只加载一次
    const [a, b, c] = await Promise.all([cached('catalog', 'k', 60, load), cached('catalog', 'k', 60, load), cached('catalog', 'k', 60, load)]);
    expect(loads).toBe(1);
    expect([a, b, c]).toEqual([{ n: 1, at: 'x' }, { n: 1, at: 'x' }, { n: 1, at: 'x' }]);
    // 命中缓存
    expect(await cached('catalog', 'k', 60, load)).toEqual({ n: 1, at: 'x' });
    expect(loads).toBe(1);
    // 其他命名空间不受影响；本命名空间失效后重新加载
    await invalidateCache('settings');
    expect(await cached('catalog', 'k', 60, load)).toEqual({ n: 1, at: 'x' });
    await invalidateCache('catalog');
    expect(await cached('catalog', 'k', 60, load)).toEqual({ n: 2, at: 'x' });
    expect(loads).toBe(2);
    // 加载失败不写入缓存，下次重试
    await expect(cached('catalog', 'fail', 60, async () => Promise.reject(new Error('db down')))).rejects.toThrow('db down');
    expect(await cached('catalog', 'fail', 60, async () => 'ok')).toBe('ok');
  });

  it('notifies subscribers of published messages', async () => {
    const { publish, subscribe } = await import('../src/lib/redis.ts');
    const got: string[] = [];
    subscribe('test-channel', (m) => got.push(m));
    await publish('test-channel', 'hello');
    expect(got).toEqual(['hello']);
  });
});

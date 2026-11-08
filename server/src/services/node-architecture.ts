import { normalizeArch } from '../shared/index.ts';
import { invalidateCache } from '../lib/cache.ts';
import { prisma } from '../lib/prisma.ts';
import { redis } from '../lib/redis.ts';

/** 架构是宿主机的持久属性；仅收到非空的新值时更新，离线或缺少字段不会清除。 */
export async function cacheNodeArchitecture(nodeId: number, input: string | null | undefined, options: { onlyIfUnknown?: boolean } = {}): Promise<string | null> {
  const arch = normalizeArch(input);
  if (!arch) return null;
  const changed = await prisma.node.updateMany({ where: { id: nodeId, ...(options.onlyIfUnknown ? { arch: null } : { OR: [{ arch: null }, { arch: { not: arch } }] }) }, data: { arch } });
  if (changed.count) await invalidateCache('catalog');
  // 回填期间可能已经收到新心跳，不能让旧报告覆盖已持久保存的架构。
  if (options.onlyIfUnknown && !changed.count) return normalizeArch((await prisma.node.findUnique({ where: { id: nodeId }, select: { arch: true } }))?.arch);
  return arch;
}

/** 兼容旧宿主机：从最后一次 Agent 心跳恢复架构，不依赖宿主机当前在线。 */
export async function resolveNodeArchitectures<T extends { id: number; arch?: string | null }>(nodes: T[]): Promise<Array<T & { arch: string | null }>> {
  return Promise.all(nodes.map(async node => {
    const saved = normalizeArch(node.arch);
    if (saved) return { ...node, arch: saved };
    const raw = await redis.get(`node:host:${node.id}`).catch(() => null);
    let reported: string | undefined;
    try {
      const report = raw ? JSON.parse(raw) as { arch?: unknown } : null;
      if (typeof report?.arch === 'string') reported = report.arch;
    } catch {
      // 临时状态损坏时保持架构未知，等待下一次有效上报。
    }
    const arch = await cacheNodeArchitecture(node.id, reported, { onlyIfUnknown: true });
    return { ...node, arch };
  }));
}

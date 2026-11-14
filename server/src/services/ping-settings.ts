import { pingTargetIsp, type AdminPingSettingsDTO, type ManagedPingTarget, type PingSettings, type PingTarget } from '../shared/index.ts';
import { prisma } from '../lib/prisma.ts';
import { getSetting, setSetting } from '../lib/settings.ts';
import { redis, withLock } from '../lib/redis.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { t } from '../i18n/index.ts';
import { getHostReport } from './agent/agent.ts';

export const PING_SETTINGS_LOCK = 'settings:ping';
export const pingRunKey = (id: number) => `node:ping:run:${id}`;
export const activePingTargets = (settings: PingSettings): PingTarget[] => settings.targets.filter(target => target.enabled).map(({ enabled: _enabled, ...target }) => ({ ...target, isp: pingTargetIsp(target) }));
export const pingObjectEnabled = (settings: PingSettings, node: { id: number; enabled: boolean; pingEnabled: boolean }) => settings.enabled && node.enabled && node.pingEnabled && (settings.nodeIds === null || settings.nodeIds.includes(node.id)) && settings.targets.some(target => target.enabled);

export async function adminPingSettings(): Promise<AdminPingSettingsDTO> {
  const [settings, nodes] = await Promise.all([getSetting('ping'), prisma.node.findMany({ select: { id: true, name: true, region: true, enabled: true, pingEnabled: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] })]);
  const ids = new Set(settings.nodeIds ?? nodes.filter(node => node.pingEnabled).map(node => node.id));
  const all = await Promise.all(nodes.map(async node => {
    const [report, raw] = await Promise.all([getHostReport(node.id), ids.has(node.id) ? redis.get(`node:ping:${node.id}`) : null]);
    const result = raw ? JSON.parse(raw) as { testedAt?: string } : null;
    return { id: node.id, name: node.name, region: node.region, enabled: node.pingEnabled, nodeEnabled: node.enabled, online: !!report?.online, testedAt: result?.testedAt ?? null };
  }));
  return { ...settings, targets: settings.targets.map(target => ({ ...target, isp: pingTargetIsp(target) })), objects: all.filter(node => ids.has(node.id)), available: all.filter(node => !ids.has(node.id)).map(({ testedAt: _testedAt, ...node }) => node) };
}

/** Serialize target changes and object changes against the same persisted settings. */
export async function updatePingSettings(update: (current: PingSettings) => Partial<PingSettings>): Promise<void> {
  await withLock(PING_SETTINGS_LOCK, 15_000, async () => {
    const current = await getSetting('ping', true);
    const next = { ...current, ...update(current) };
    if (next.enabled && !next.targets.some(target => target.enabled)) throw badRequest(t('probe.targetsRequired'));
    await setSetting('ping', next);
    const nodes = await prisma.node.findMany({ where: { pingEnabled: true, ...(next.nodeIds !== null ? { id: { in: next.nodeIds } } : {}) }, select: { id: true } });
    await Promise.all(nodes.map(node => next.enabled ? redis.set(pingRunKey(node.id), '1', 'EX', 3600) : redis.del(pingRunKey(node.id))));
  });
}

export async function changePingObject(id: number, action: 'add' | 'remove' | 'enable' | 'disable') {
  return withLock(PING_SETTINGS_LOCK, 15_000, async () => {
    const current = await getSetting('ping', true);
    const node = await prisma.node.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!node) throw notFound();
    const ids = new Set(current.nodeIds ?? (await prisma.node.findMany({ where: { pingEnabled: true }, select: { id: true } })).map(item => item.id));
    if (action !== 'add' && !ids.has(id)) throw notFound();
    if (action === 'remove') ids.delete(id); else ids.add(id);
    const enabled = action === 'add' || action === 'enable';
    await prisma.node.update({ where: { id }, data: { pingEnabled: enabled } });
    await setSetting('ping', { nodeIds: [...ids] });
    if (enabled && current.enabled) await redis.set(pingRunKey(id), '1', 'EX', 3600);
    else await redis.del(pingRunKey(id));
    return node.name;
  });
}

/** 宿主机表单仍可开启拨测；已显式管理对象时同步加入列表。关闭时保留对象。 */
export async function syncPingObject(id: number, enabled: boolean): Promise<void> {
  await withLock(PING_SETTINGS_LOCK, 15_000, async () => {
    const settings = await getSetting('ping', true);
    if (enabled && settings.nodeIds !== null && !settings.nodeIds.includes(id)) {
      await setSetting('ping', { nodeIds: [...settings.nodeIds, id] });
    }
    if (enabled && settings.enabled) await redis.set(pingRunKey(id), '1', 'EX', 3600);
    else await redis.del(pingRunKey(id));
  });
}

export function updatedTarget(targets: ManagedPingTarget[], id: string, input: ManagedPingTarget): ManagedPingTarget[] {
  if (!targets.some(target => target.id === id)) throw notFound(t('probe.targetMissing'));
  return targets.map(target => target.id === id ? input : target);
}

import { isVmType, type VolumeDTO } from '../shared/index.ts';
import { getIncus, IncusError, type IncusApi } from '../incus/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { prisma, type Instance, type Node, type Volume } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { t } from '../i18n/index.ts';
import { listStoragePools } from './nodes.ts';
import { diskLimits, presentConfig } from './spec.ts';

type InstanceWithNode = Instance & { node: Node };

/** 实例上挂载数据盘的设备名 */
export const volumeDevice = (id: number) => `data${id}`;

/** 不允许挂载到系统目录，避免覆盖系统文件 */
const RESERVED_PATHS = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/tmp', '/usr', '/var'];
const MAX_VOLUMES = 8;

export function toVolume(v: Volume): VolumeDTO {
  return { id: v.id, pool: v.pool, name: v.name, size: v.size, path: v.path, device: volumeDevice(v.id), createdAt: v.createdAt.toISOString() };
}

export interface AddVolumeInput {
  pool: string;
  /** GiB */
  size: number;
  /** 容器内的挂载目录；虚拟机忽略 */
  path?: string;
}

/**
 * 创建数据盘并挂载到实例：只能使用「存储盘」用途的存储池。
 * 容器使用 filesystem 卷挂载到目录；虚拟机使用 block 卷，作为磁盘接入，需在系统内自行分区格式化。
 * 任一步失败都会回滚已创建的卷与记录。
 */
export async function addVolume(inst: InstanceWithNode, input: AddVolumeInput): Promise<Volume> {
  if (inst.status === 'CREATING' || inst.status === 'DELETING' || inst.status === 'DELETED') throw badRequest(t('volume.notReady'));
  const vm = isVmType(inst.type);
  let path: string | null = null;
  if (!vm) {
    path = (input.path ?? '').trim().replace(/\/+$/, '');
    if (!/^\/[A-Za-z0-9._\-/]+$/.test(path) || path.includes('..') || RESERVED_PATHS.includes(path)) throw badRequest(t('volume.badPath'));
  }
  const pools = await listStoragePools(inst.node);
  const pool = pools.find((p) => p.name === input.pool);
  if (!pool) throw badRequest(t('pool.notFound'));
  if (pool.usage !== 'data') throw badRequest(t('volume.notDataPool'));

  return withLock(`instance-volumes:${inst.id}`, 60_000, async () => {
    const existing = await prisma.volume.findMany({ where: { instanceId: inst.id } });
    if (existing.length >= MAX_VOLUMES) throw conflict(t('volume.limit', { limit: MAX_VOLUMES }));
    if (path && existing.some((v) => v.path === path)) throw conflict(t('volume.pathTaken', { path }));

    const row = await prisma.volume.create({ data: { instanceId: inst.id, pool: input.pool, name: '', size: input.size, path } });
    const name = `${inst.name}-data${row.id}`;
    const incus = await getIncus(inst.node);
    try {
      await incus.createVolume(input.pool, {
        name,
        content_type: vm ? 'block' : 'filesystem',
        description: `paledove #${inst.id} ${inst.hostname}`,
        config: { size: `${input.size}GiB` },
      });
    } catch (err) {
      await prisma.volume.delete({ where: { id: row.id } });
      throw err;
    }
    try {
      await incus.modifyInstance(inst.name, (i) => {
        const limits = presentConfig(diskLimits(inst));
        i.devices[volumeDevice(row.id)] = vm ? { type: 'disk', pool: input.pool, source: name, ...limits } : { type: 'disk', pool: input.pool, source: name, path: path!, ...limits };
      });
    } catch (err) {
      await incus.deleteVolume(input.pool, name).catch(() => undefined);
      await prisma.volume.delete({ where: { id: row.id } });
      throw err;
    }
    return prisma.volume.update({ where: { id: row.id }, data: { name } });
  });
}

/** 卸载并删除数据盘（卷中的数据一并删除） */
export async function removeVolume(inst: InstanceWithNode, volumeId: number): Promise<void> {
  const vol = await prisma.volume.findFirst({ where: { id: volumeId, instanceId: inst.id } });
  if (!vol) throw notFound(t('volume.notFound'));
  const incus = await getIncus(inst.node);
  if (inst.status !== 'DELETED' && inst.status !== 'DELETING') {
    try {
      await incus.modifyInstance(inst.name, (i) => {
        delete i.devices[volumeDevice(vol.id)];
      });
    } catch (err) {
      if (!(err instanceof IncusError && err.isNotFound)) throw err;
    }
  }
  await deleteIncusVolume(incus, vol);
  await prisma.volume.delete({ where: { id: vol.id } });
}

async function deleteIncusVolume(incus: IncusApi, vol: Volume): Promise<void> {
  try {
    await incus.deleteVolume(vol.pool, vol.name);
  } catch (err) {
    if (!(err instanceof IncusError && err.isNotFound)) throw err;
  }
}

/** 实例删除后清理其数据盘（实例已删除，设备随之移除，只需删除卷） */
export async function deleteInstanceVolumes(instanceId: number, incus: IncusApi): Promise<void> {
  const vols = await prisma.volume.findMany({ where: { instanceId } });
  for (const vol of vols) await deleteIncusVolume(incus, vol);
  await prisma.volume.deleteMany({ where: { instanceId } });
}

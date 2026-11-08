// 宿主机运维：直接读取宿主机上 Incus 的全部实例，按数据库记录分类，并与面板的配置基线比对。
//   managed：数据库里有记录且在这台宿主机上（完整管理在实例详情里）；
//   orphan：带面板标记或与面板实例同名，但数据库里没有记录、已删除或属于其他宿主机（删除中途失败、迁移残留等）；
//   other：不是面板创建的实例；
//   missing：数据库里应该在这台宿主机上、但 Incus 里找不到的实例。
// 基线：由面板记录推导出的配额、开机设置、网卡与端口映射。基线同步、网络修复都以数据库为准修正 Incus。
import { isNatType, isPublicIpv4Mode, isVmType, parseIpv6List, type HostInstanceDTO, type HostInstancesDTO, type InstanceDriftDTO } from '../shared/index.ts';
import { getIncus, type IncusApi } from '../incus/index.ts';
import type { IncusDevice, IncusDevices, IncusInstance, IncusInstanceState } from '../incus/types.ts';
import { errorMessage } from '../lib/errors.ts';
import { prisma, type InstanceStatus, type Node } from '../lib/prisma.ts';
import { t } from '../i18n/index.ts';
import { ensureNatNetwork } from './allocation.ts';
import { syncSitesSafe } from './gateway.ts';
import type { FullInstance } from './operations.ts';
import { applyConfig, applyDiskLimits, buildIpv6Nic, buildLimitsConfig, buildNic, buildProxyDevices, diskLimits, isVolumeDevice, isManagedProxyDevice, networkConfig, nicLimits } from './spec.ts';

/** 已开通、应当在宿主机上存在的实例状态 */
export const OPS_STATUSES: InstanceStatus[] = ['RUNNING', 'STOPPED', 'SUSPENDED', 'ERROR', 'REINSTALLING'];

const NIC_LIMIT_KEYS = ['limits.ingress', 'limits.egress'];

/** 实例上的面板标记 user.paledove.id */
export function panelIdOf(inst: Pick<IncusInstance, 'config'>): number | null {
  const id = Number(inst.config?.['user.paledove.id']);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** 面板管理的实例配置项；null 表示不应设置 */
export function baselineConfig(inst: FullInstance): Record<string, string | null> {
  const vm = isVmType(inst.type);
  return {
    // 含开机设置：暂停的实例不随宿主机开机启动
    ...buildLimitsConfig(inst),
    'user.paledove.id': String(inst.id),
    ...(vm
      ? { 'security.secureboot': 'false' }
      : { 'security.nesting': inst.nesting ? 'true' : null, 'security.privileged': inst.privileged ? 'true' : null }),
  };
}

/** 面板记录对应的网卡：eth0 为主网卡，eth1 为公网 IPv6 网卡（没有时为 null） */
export function baselineNics(inst: FullInstance): { eth0: IncusDevice; eth1: IncusDevice | null } {
  return { eth0: buildNic(inst, inst.node, inst.ipAddress), eth1: buildIpv6Nic(inst, inst.node) };
}

/** 面板记录对应的端口映射设备 */
export function baselineProxies(inst: FullInstance): IncusDevices {
  const out: IncusDevices = {};
  if (!isNatType(inst.type) || !inst.privateIp) return out;
  for (const m of inst.portMappings) Object.assign(out, buildProxyDevices(inst.node, inst, m));
  return out;
}

/** 设备的文字形式（按键名排序），用于比对与展示；limits 控制是否包含限速项 */
function devText(d: IncusDevice | null | undefined, limits = true): string | null {
  if (!d) return null;
  return Object.keys(d)
    .filter((k) => limits || !NIC_LIMIT_KEYS.includes(k))
    .sort()
    .map((k) => `${k}=${d[k]}`)
    .join(', ');
}

function limitText(d: IncusDevice): string | null {
  return NIC_LIMIT_KEYS.filter((k) => d[k]).map((k) => `${k}=${d[k]}`).join(', ') || null;
}

/** 实例内的全局地址（不含回环） */
function guestAddresses(state: IncusInstanceState | null | undefined, family: 'inet' | 'inet6'): string[] {
  const out: string[] = [];
  for (const [name, nic] of Object.entries(state?.network ?? {})) {
    if (name === 'lo') continue;
    for (const a of nic.addresses ?? []) if (a.family === family && a.scope === 'global') out.push(a.address);
  }
  return out;
}

/** 与基线的差异 */
export function instanceDrift(inst: FullInstance, remote: IncusInstance & { state?: IncusInstanceState | null }): InstanceDriftDTO[] {
  const out: InstanceDriftDTO[] = [];
  const push = (kind: InstanceDriftDTO['kind'], key: string, expected: string | null | undefined, actual: string | null | undefined) => {
    if ((expected ?? null) !== (actual ?? null)) out.push({ kind, key, expected: expected ?? null, actual: actual ?? null });
  };
  for (const [k, v] of Object.entries(baselineConfig(inst))) push('baseline', k, v, remote.config[k]);
  if (remote.devices.root) push('baseline', 'root.size', `${inst.disk}GiB`, remote.devices.root.size);
  const io = diskLimits(inst);
  for (const [name, dev] of Object.entries(remote.devices)) {
    if (dev.type !== 'disk' || (name !== 'root' && !isVolumeDevice(name))) continue;
    for (const [k, v] of Object.entries(io)) push('baseline', `${name}.${k}`, v, dev[k]);
  }
  if (inst.status === 'SUSPENDED') push('baseline', 'power', 'Stopped', remote.status === 'Running' ? 'Running' : remote.status);

  let nics: ReturnType<typeof baselineNics> | null = null;
  try {
    nics = baselineNics(inst);
  } catch (err) {
    out.push({ kind: 'network', key: 'eth0', expected: errorMessage(err), actual: devText(remote.devices.eth0) });
  }
  if (nics) {
    for (const [name, want] of Object.entries(nics)) {
      const have = remote.devices[name];
      push('network', name, devText(want, false), devText(have, false));
      if (want && have) push('baseline', `${name}.limits`, limitText(want), limitText(have));
    }
  }

  // 端口映射：缺少、多出或内容不一致的设备（内容不一致的在实际值里以 * 标出）
  const want = baselineProxies(inst);
  const have = Object.fromEntries(Object.entries(remote.devices).filter(([n]) => isManagedProxyDevice(n)));
  const bad = Object.keys(want).some((n) => devText(want[n]) !== devText(have[n])) || Object.keys(have).some((n) => !want[n]);
  if (bad) {
    const names = (o: IncusDevices, mark: boolean) => Object.keys(o).sort().map((n) => (mark && want[n] && devText(want[n]) !== devText(o[n]) ? `${n}*` : n)).join(', ') || null;
    out.push({ kind: 'network', key: 'proxy', expected: names(want, false), actual: names(have, true) });
  }

  // 实例内的地址（虚拟机没有 incus-agent 时读不到，跳过）
  if (remote.status === 'Running' && remote.state?.network) {
    const v4 = guestAddresses(remote.state, 'inet');
    const wantV4 = isNatType(inst.type) ? inst.privateIp : inst.ipAddress?.address;
    if (wantV4 && !v4.includes(wantV4)) out.push({ kind: 'network', key: 'guest.ipv4', expected: wantV4, actual: v4.join(', ') || null });
    const v6 = guestAddresses(remote.state, 'inet6');
    const wantV6 = parseIpv6List(inst.publicIpv6);
    if (wantV6.some((a) => !v6.includes(a))) out.push({ kind: 'network', key: 'guest.ipv6', expected: wantV6.join(', '), actual: v6.join(', ') || null });
  }
  return out;
}

/** 检查 NAT 网桥：存在、有 IPv4 网段且与面板记录一致、开启了 NAT */
async function checkNatNetwork(node: Node, incus: IncusApi): Promise<HostInstancesDTO['network']> {
  const name = node.natNetwork;
  try {
    const net = await incus.getNetwork(name);
    const cidr = net.config['ipv4.address'] && net.config['ipv4.address'] !== 'none' ? net.config['ipv4.address'] : null;
    let message: string | null = null;
    if (!cidr) message = t('ops.netNoIpv4');
    else if (node.natCidr && cidr !== node.natCidr) message = t('ops.netCidrChanged');
    else if (net.config['ipv4.nat'] !== 'true') message = t('ops.netNoNat');
    else if (net.status && net.status !== 'Created') message = t('ops.netStatus', { status: net.status });
    return { name, ok: !message, cidr, expected: node.natCidr, message };
  } catch (err) {
    return { name, ok: false, cidr: null, expected: node.natCidr, message: errorMessage(err) };
  }
}

const recordInclude = { image: true, ipAddress: true, portMappings: true, user: { select: { id: true, email: true } } } as const;

/** 宿主机上的全部实例（直接读取 Incus），按数据库记录分类并比对基线 */
export async function listHostInstances(node: Node): Promise<HostInstancesDTO> {
  const incus = await getIncus(node);
  const remote = await incus.listInstances();
  const usesNat = !isPublicIpv4Mode(node.networkMode) || remote.some((r) => r.devices.eth0?.network === node.natNetwork);
  const network = usesNat ? await checkNatNetwork(node, incus) : null;

  const ids = remote.map(panelIdOf).filter((x): x is number => x !== null);
  const records = await prisma.instance.findMany({ where: { OR: [{ id: { in: ids } }, { name: { in: remote.map((r) => r.name) } }] }, include: recordInclude });
  const byId = new Map(records.map((r) => [r.id, r]));
  const byName = new Map(records.map((r) => [r.name, r]));

  const items: HostInstanceDTO[] = remote.map((r) => {
    const panelId = panelIdOf(r);
    const rec = (panelId ? byId.get(panelId) : undefined) ?? byName.get(r.name);
    const managed = !!rec && rec.name === r.name && rec.nodeId === node.id && rec.status !== 'DELETED';
    const disk = r.state?.disk?.root;
    return {
      name: r.name,
      type: r.type,
      status: r.status,
      description: r.description,
      cpu: r.config['limits.cpu'] ?? null,
      memory: r.config['limits.memory'] ?? null,
      disk: r.devices.root?.size ?? r.expanded_devices?.root?.size ?? null,
      autostart: r.config['boot.autostart'] === 'true',
      ipv4: guestAddresses(r.state, 'inet'),
      ipv6: guestAddresses(r.state, 'inet6'),
      memoryUsage: r.status === 'Running' ? (r.state?.memory?.usage ?? null) : null,
      diskUsage: disk?.usage ?? null,
      createdAt: r.created_at,
      category: managed ? 'managed' : panelId || rec ? 'orphan' : 'other',
      panelId,
      record: rec ? { id: rec.id, hostname: rec.hostname, status: rec.status, type: rec.type, user: rec.user } : null,
      drift: managed ? instanceDrift({ ...rec, node }, r) : [],
    };
  });
  const order = { managed: 0, orphan: 1, other: 2 };
  items.sort((a, b) => order[a.category] - order[b.category] || a.name.localeCompare(b.name));

  const present = new Set(remote.map((r) => r.name));
  const expected = await prisma.instance.findMany({
    where: { nodeId: node.id, status: { in: OPS_STATUSES }, provisionedAt: { not: null } },
    select: { id: true, hostname: true, name: true, status: true, user: { select: { id: true, email: true } } },
    orderBy: { id: 'asc' },
  });
  return { network, items, missing: expected.filter((i) => !present.has(i.name)) };
}

// ───────── 任务 ─────────

/** 基线同步：按面板记录修正配额、限速、系统盘大小、开机设置与端口映射；暂停的实例确保已关机 */
export async function syncBaseline(inst: FullInstance, incus: IncusApi): Promise<void> {
  const config = baselineConfig(inst);
  await incus.modifyInstance(inst.name, (i) => {
    applyConfig(i.config, config);
    if (i.devices.root) i.devices.root.size = `${inst.disk}GiB`;
    applyDiskLimits(i.devices, inst);
    for (const nic of [i.devices.eth0, i.devices.eth1]) {
      if (!nic) continue;
      for (const k of NIC_LIMIT_KEYS) delete nic[k];
      Object.assign(nic, nicLimits(inst));
    }
    if (isNatType(inst.type) && inst.privateIp) {
      const proxies = baselineProxies(inst);
      for (const name of Object.keys(i.devices)) if (isManagedProxyDevice(name) && !proxies[name]) delete i.devices[name];
      Object.assign(i.devices, proxies);
    }
  });
  if (inst.status === 'SUSPENDED' && (await incus.getInstanceState(inst.name)).status === 'Running') {
    await incus.setState(inst.name, 'stop', { force: true, timeout: 30 });
  }
}

/** 在实例内重新加载网络配置（兼容 netplan / systemd-networkd / NetworkManager / ifupdown / OpenRC） */
const GUEST_NET_RELOAD = [
  'for i in $(ls /sys/class/net); do [ "$i" = lo ] || ip link set "$i" up 2>/dev/null; done',
  'if command -v netplan >/dev/null 2>&1; then netplan apply',
  'elif systemctl is-active -q systemd-networkd 2>/dev/null; then systemctl restart systemd-networkd',
  'elif systemctl is-active -q NetworkManager 2>/dev/null; then nmcli networking off; nmcli networking on',
  'elif command -v rc-service >/dev/null 2>&1; then rc-service networking restart',
  'elif systemctl cat networking.service >/dev/null 2>&1; then systemctl restart networking',
  'elif command -v ifup >/dev/null 2>&1; then ifdown -a; ifup -a',
  'fi',
].join('\n');

/**
 * 网络修复：确认 NAT 网桥，按面板记录重建网卡与端口映射，更新虚拟机的网络配置，并在实例内重新加载网络。
 * 网卡的网络、地址等属性不能在运行中修改，这类差异（或选择了重启）会先关机、修改后再开机。
 */
export async function repairNetwork(inst: FullInstance, incus: IncusApi, opts: { restart?: boolean } = {}): Promise<void> {
  const node = isNatType(inst.type) ? await ensureNatNetwork(inst.node) : inst.node;
  const full: FullInstance = { ...inst, node };
  const { eth0, eth1 } = baselineNics(full);
  const proxies = baselineProxies(full);
  const netConfig = networkConfig(full, node, inst.ipAddress);
  const remote = await incus.getInstance(inst.name);
  const running = remote.status === 'Running';
  const nicChanged = devText(remote.devices.eth0, false) !== devText(eth0, false) || devText(remote.devices.eth1, false) !== devText(eth1, false);
  const cold = running && (nicChanged || !!opts.restart);
  if (cold) await incus.setState(inst.name, 'stop', { force: true, timeout: 30 });
  try {
    await incus.modifyInstance(inst.name, (i) => {
      i.devices.eth0 = eth0;
      if (eth1) i.devices.eth1 = eth1;
      else delete i.devices.eth1;
      for (const name of Object.keys(i.devices)) if (isManagedProxyDevice(name) && !proxies[name]) delete i.devices[name];
      Object.assign(i.devices, proxies);
      if (netConfig) i.config['cloud-init.network-config'] = netConfig;
    });
  } finally {
    if (cold) await incus.setState(inst.name, 'start');
  }
  // 不重启时在实例内重新加载网络；虚拟机没有 incus-agent 等情况下忽略失败
  if (running && !cold) await incus.exec(inst.name, ['sh', '-c', GUEST_NET_RELOAD], { timeoutSec: 60 }).catch(() => undefined);
  await syncSitesSafe(inst.nodeId);
}

import { isVmType, type VpcDTO } from '../shared/index.ts';
import { getIncus, IncusError, type IncusApi } from '../incus/index.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { intToIp, ipToInt, isIPv4, parseCidr } from '../lib/ip.ts';
import { prisma, type Instance, type Node, type Vpc } from '../lib/prisma.ts';
import { withLock } from '../lib/redis.ts';
import { getSettings } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';

/** 实例上 VPC 网卡的设备名 */
export const VPC_DEVICE = 'vpc0';
/** 容器内的 VPC 网卡名（虚拟机内由系统命名，按 MAC 识别） */
export const VPC_IFNAME = 'eth2';

/** 私有地址段：10/8、172.16/12、192.168/16 */
const PRIVATE_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(parseCidr);

type InstanceWithNode = Instance & { node: Node };

/** 校验并规范化网段（如 10.10.0.5/24 → 10.10.0.0/24）：必须是私有地址，掩码 16–29，不能与宿主机的 NAT 网段重叠 */
export function normalizeVpcCidr(input: string, node: Pick<Node, 'natCidr'>): string {
  let c;
  try {
    c = parseCidr(input);
  } catch {
    throw badRequest(t('vpc.badCidr'));
  }
  if (!input.includes('/') || c.prefix < 16 || c.prefix > 29) throw badRequest(t('vpc.badPrefix'));
  if (!PRIVATE_RANGES.some((r) => c.network >= r.network && c.broadcast <= r.broadcast)) throw badRequest(t('vpc.notPrivate'));
  if (node.natCidr) {
    const nat = parseCidr(node.natCidr);
    if (c.network <= nat.broadcast && nat.network <= c.broadcast) throw badRequest(t('vpc.overlapNat', { cidr: `${intToIp(nat.network)}/${nat.prefix}` }));
  }
  return `${intToIp(c.network)}/${c.prefix}`;
}

/** 自动选择网段：从 10.10.0.0/24 起依次尝试，跳过与宿主机 NAT 网段、该用户已有 VPC 重叠的 */
function autoCidr(node: Pick<Node, 'natCidr'>, taken: string[]): string {
  const used = [...taken, ...(node.natCidr ? [node.natCidr] : [])].map(parseCidr);
  const candidates = [...Array.from({ length: 241 }, (_, i) => `10.${i + 10}.0.0/24`), ...Array.from({ length: 16 }, (_, i) => `172.${i + 16}.0.0/24`)];
  for (const cidr of candidates) {
    const c = parseCidr(cidr);
    if (!used.some((u) => c.network <= u.broadcast && u.network <= c.broadcast)) return cidr;
  }
  throw conflict(t('vpc.noFreeCidr'));
}

/** 用户实例所在的宿主机才能建 VPC（用户看不到宿主机，以“与哪些实例在同一台宿主机”表示位置） */
const activeStatus = { notIn: ['DELETED' as const, 'DELETING' as const] };

export function toVpc(v: Vpc & { node: Pick<Node, 'region' | 'country'>; instances: Pick<Instance, 'id' | 'name' | 'hostname' | 'vpcIp' | 'status'>[] }): VpcDTO {
  return {
    id: v.id,
    name: v.name,
    cidr: v.cidr,
    nodeId: v.nodeId,
    region: v.node.region,
    country: v.node.country,
    createdAt: v.createdAt.toISOString(),
    members: v.instances.map((i) => ({ instanceId: i.id, name: i.name, hostname: i.hostname, ip: i.vpcIp ?? '', status: i.status })),
  };
}

/** 创建 VPC；不填网段时自动分配。管理员代用户创建时不受「未开放」与数量上限限制（ignoreLimit） */
export async function createVpc(userId: number, input: { name: string; cidr?: string; nodeId: number }, opts: { ignoreLimit?: boolean } = {}): Promise<Vpc> {
  if (!opts.ignoreLimit) {
    const { vpcLimit } = await getSettings();
    if (!vpcLimit) throw badRequest(t('vpc.disabled'));
    if ((await prisma.vpc.count({ where: { userId } })) >= vpcLimit) throw conflict(t('vpc.limit', { n: vpcLimit }));
  }
  const own = await prisma.instance.findFirst({ where: { userId, nodeId: input.nodeId, status: activeStatus }, include: { node: true } });
  if (!own) throw badRequest(t('vpc.badLocation'));
  const cidr = input.cidr
    ? normalizeVpcCidr(input.cidr, own.node)
    : autoCidr(own.node, (await prisma.vpc.findMany({ where: { userId }, select: { cidr: true } })).map((v) => v.cidr));
  const row = await prisma.vpc.create({ data: { userId, nodeId: input.nodeId, name: input.name, cidr, network: `pending-${userId}-${Date.now()}` } });
  // Incus 网络名最长 15 个字符
  const network = `pdvpc-${row.id}`;
  try {
    const incus = await getIncus(own.node);
    // 纯二层网桥：宿主机侧不配地址、不做 NAT 和路由，VPC 之间、VPC 与宿主机之间都不互通
    await incus.createNetwork({ name: network, type: 'bridge', description: `paledove vpc #${row.id} user #${userId}`, config: { 'ipv4.address': 'none', 'ipv6.address': 'none' } });
  } catch (err) {
    await prisma.vpc.delete({ where: { id: row.id } });
    throw err;
  }
  return prisma.vpc.update({ where: { id: row.id }, data: { network } });
}

/** 删除 VPC：需要先移出全部实例 */
export async function deleteVpc(vpc: Vpc & { node: Node }): Promise<void> {
  if (await prisma.instance.count({ where: { vpcId: vpc.id, status: activeStatus } })) throw conflict(t('vpc.notEmpty'));
  try {
    await (await getIncus(vpc.node)).deleteNetwork(vpc.network);
  } catch (err) {
    if (!(err instanceof IncusError && err.isNotFound)) throw err;
  }
  await prisma.instance.updateMany({ where: { vpcId: vpc.id }, data: { vpcId: null, vpcIp: null } });
  await prisma.vpc.delete({ where: { id: vpc.id } });
}

/** 分配内网地址：指定的地址需在网段内且未被占用；未指定时从网段开头依次分配 */
async function pickIp(vpc: Vpc, wanted?: string): Promise<string> {
  const c = parseCidr(vpc.cidr);
  const used = new Set(
    (await prisma.instance.findMany({ where: { vpcId: vpc.id, status: activeStatus }, select: { vpcIp: true } })).map((i) => i.vpcIp).filter((x): x is string => !!x),
  );
  if (wanted) {
    if (!isIPv4(wanted)) throw badRequest(t('vpc.badIp'));
    const n = ipToInt(wanted);
    if (n <= c.network || n >= c.broadcast) throw badRequest(t('vpc.ipOutOfRange', { cidr: vpc.cidr }));
    if (used.has(wanted)) throw conflict(t('vpc.ipTaken', { ip: wanted }));
    return wanted;
  }
  for (let n = c.network + 1; n < c.broadcast; n++) if (!used.has(intToIp(n))) return intToIp(n);
  throw conflict(t('vpc.full'));
}

/** 实例能否加入 / 移出 VPC：需要已开通且没有进行中的变更 */
function ensureReady(inst: Instance) {
  if (['CREATING', 'DELETING', 'DELETED', 'REINSTALLING', 'MIGRATING'].includes(inst.status)) throw badRequest(t('vpc.instanceBusy'));
}

/** 加入 VPC：接入网卡，并在实例内配置内网地址；返回实例内是否已配置成功（实例关机或没有代理时为 false） */
export async function attachInstance(vpc: Vpc, inst: InstanceWithNode, wantedIp?: string): Promise<{ ip: string; configured: boolean }> {
  ensureReady(inst);
  if (inst.userId !== vpc.userId) throw notFound(t('instance.notFound'));
  if (inst.nodeId !== vpc.nodeId) throw badRequest(t('vpc.otherHost'));
  return withLock(`instance-vpc:${inst.id}`, 60_000, async () => {
    const fresh = await prisma.instance.findUniqueOrThrow({ where: { id: inst.id } });
    if (fresh.vpcId) throw conflict(t('vpc.alreadyJoined'));
    const ip = await pickIp(vpc, wantedIp);
    const incus = await getIncus(inst.node);
    await incus.modifyInstance(inst.name, (i) => {
      i.devices[VPC_DEVICE] = { type: 'nic', network: vpc.network, ...(isVmType(inst.type) ? {} : { name: VPC_IFNAME }) };
    });
    await prisma.instance.update({ where: { id: inst.id }, data: { vpcId: vpc.id, vpcIp: ip } });
    const configured = await configureGuest(incus, inst.name, vpc.cidr, ip);
    return { ip, configured };
  });
}

/** 移出 VPC：先清理实例内的配置，再拔掉网卡 */
export async function detachInstance(inst: InstanceWithNode): Promise<void> {
  if (!inst.vpcId) return;
  await withLock(`instance-vpc:${inst.id}`, 60_000, async () => {
    if (!['DELETING', 'DELETED'].includes(inst.status)) {
      const incus = await getIncus(inst.node);
      await runGuest(incus, inst.name, GUEST_REMOVE, {}).catch(() => false);
      try {
        await incus.modifyInstance(inst.name, (i) => {
          delete i.devices[VPC_DEVICE];
        });
      } catch (err) {
        if (!(err instanceof IncusError && err.isNotFound)) throw err;
      }
    }
    await prisma.instance.update({ where: { id: inst.id }, data: { vpcId: null, vpcIp: null } });
  });
}

/** 开机、重装等之后重新确认实例内的内网配置（重装会清空系统盘；虚拟机的代理启动较慢，多试几次） */
export function reapplyVpcGuest(instanceId: number): void {
  void (async () => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const inst = await prisma.instance.findUnique({ where: { id: instanceId }, include: { node: true, vpc: true } });
      if (!inst?.vpc || !inst.vpcIp || inst.status !== 'RUNNING') return;
      const incus = await getIncus(inst.node).catch(() => null);
      if (incus && (await configureGuest(incus, inst.name, inst.vpc.cidr, inst.vpcIp))) return;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  })().catch(() => undefined);
}

// ───────── 实例内配置 ─────────

/**
 * 在实例内为 VPC 网卡配置静态地址，并保证重启后仍然生效：
 * NetworkManager 用连接配置；systemd-networkd 用 .network 文件；其他 systemd 系统用开机服务；OpenRC 用 local.d。
 * 网卡按 MAC 地址查找。只依赖 sh 与 ip 命令。
 */
const GUEST_APPLY = String.raw`
IF=""
for d in /sys/class/net/*; do [ "$(cat "$d/address" 2>/dev/null)" = "$VPC_MAC" ] && IF="${'$'}{d##*/}"; done
[ -n "$IF" ] || { echo "vpc interface not found" >&2; exit 3; }
ip link set dev "$IF" up
if command -v nmcli >/dev/null 2>&1 && nmcli -t general status >/dev/null 2>&1; then
  nmcli connection delete paledove-vpc >/dev/null 2>&1 || true
  nmcli connection add type ethernet con-name paledove-vpc ifname "$IF" ipv4.method manual ipv4.addresses "$VPC_ADDR" ipv4.never-default yes ipv6.method disabled connection.autoconnect yes >/dev/null
  nmcli connection up paledove-vpc >/dev/null
  exit 0
fi
if command -v networkctl >/dev/null 2>&1 && systemctl is-active -q systemd-networkd 2>/dev/null; then
  mkdir -p /etc/systemd/network
  printf '[Match]\nMACAddress=%s\n\n[Network]\nAddress=%s\nLinkLocalAddressing=no\n' "$VPC_MAC" "$VPC_ADDR" > /etc/systemd/network/10-paledove-vpc.network
  networkctl reload && networkctl reconfigure "$IF"
  exit 0
fi
mkdir -p /usr/local/sbin
printf '#!/bin/sh\n# PaleDove VPC：按 MAC 找到内网网卡并配置地址（由面板生成）\nfor d in /sys/class/net/*; do [ "$(cat "$d/address" 2>/dev/null)" = "%s" ] && IF="${'$'}{d##*/}"; done\n[ -n "$IF" ] || exit 0\nip link set dev "$IF" up\nip -4 addr flush dev "$IF" 2>/dev/null\nip addr add %s dev "$IF"\n' "$VPC_MAC" "$VPC_ADDR" > /usr/local/sbin/paledove-vpc
chmod 755 /usr/local/sbin/paledove-vpc
/usr/local/sbin/paledove-vpc
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  printf '[Unit]\nDescription=PaleDove VPC private network\nAfter=network-pre.target\nBefore=network.target\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/paledove-vpc\nRemainAfterExit=yes\n\n[Install]\nWantedBy=multi-user.target\n' > /etc/systemd/system/paledove-vpc.service
  systemctl daemon-reload && systemctl enable paledove-vpc.service >/dev/null 2>&1 || true
elif [ -d /etc/local.d ]; then
  printf '#!/bin/sh\n/usr/local/sbin/paledove-vpc\n' > /etc/local.d/paledove-vpc.start
  chmod 755 /etc/local.d/paledove-vpc.start
  command -v rc-update >/dev/null 2>&1 && rc-update add local default >/dev/null 2>&1 || true
fi
exit 0
`;

/** 清理实例内的 VPC 配置 */
const GUEST_REMOVE = String.raw`
command -v nmcli >/dev/null 2>&1 && nmcli connection delete paledove-vpc >/dev/null 2>&1
if [ -f /etc/systemd/network/10-paledove-vpc.network ]; then rm -f /etc/systemd/network/10-paledove-vpc.network; command -v networkctl >/dev/null 2>&1 && networkctl reload; fi
if [ -f /etc/systemd/system/paledove-vpc.service ]; then systemctl disable paledove-vpc.service >/dev/null 2>&1; rm -f /etc/systemd/system/paledove-vpc.service; systemctl daemon-reload; fi
rm -f /etc/local.d/paledove-vpc.start /usr/local/sbin/paledove-vpc
exit 0
`;

async function runGuest(incus: IncusApi, name: string, script: string, env: Record<string, string>): Promise<boolean> {
  const r = await incus.exec(name, ['sh', '-c', script], { env, timeoutSec: 60 });
  return r.exitCode === 0;
}

/** 实例运行中时在实例内配置地址；失败（关机、虚拟机没有代理等）返回 false，开机后会再试 */
async function configureGuest(incus: IncusApi, name: string, cidr: string, ip: string): Promise<boolean> {
  try {
    const remote = await incus.getInstance(name);
    if (remote.status !== 'Running') return false;
    const mac = remote.config[`volatile.${VPC_DEVICE}.hwaddr`];
    if (!mac) return false;
    return await runGuest(incus, name, GUEST_APPLY, { VPC_MAC: mac.toLowerCase(), VPC_ADDR: `${ip}/${parseCidr(cidr).prefix}` });
  } catch {
    return false;
  }
}

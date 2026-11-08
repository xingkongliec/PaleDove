import { bootOptions, isNatType, isVmType, parseIpv6List } from '../shared/index.ts';
import type { IncusDevice, IncusDevices, IncusImageSource, IncusInstanceCreate } from '../incus/types.ts';
import type { Image, Instance, IpAddress, Node, PortMapping } from '../lib/prisma.ts';
import { t } from '../i18n/index.ts';
import { badRequest } from '../lib/errors.ts';

/** 端口映射设备名前缀：pm<id>-tcp / pm<id>-udp */
export const PROXY_DEVICE_PREFIX = 'pm';

export function proxyDeviceNames(mapping: Pick<PortMapping, 'id' | 'protocol'>): string[] {
  const names: string[] = [];
  if (mapping.protocol === 'TCP' || mapping.protocol === 'TCP_UDP') names.push(`${PROXY_DEVICE_PREFIX}${mapping.id}-tcp`);
  if (mapping.protocol === 'UDP' || mapping.protocol === 'TCP_UDP') names.push(`${PROXY_DEVICE_PREFIX}${mapping.id}-udp`);
  return names;
}

/** IPv6 监听设备名：在 IPv4 设备名后加 6，例如 pm12-tcp6 */
export const ipv6DeviceName = (name: string) => `${name}6`;

/**
 * IPv4 端口映射的监听地址。NAT 模式的 proxy 设备必须监听宿主机网卡上的具体地址（Incus 拒绝 0.0.0.0），
 * 未设置监听地址（或填了 0.0.0.0）时使用宿主机的公网 IPv4。
 */
export function natListenIpv4(node: Pick<Node, 'natListenAddress' | 'publicIp'>): string {
  const addr = node.natListenAddress && node.natListenAddress !== '0.0.0.0' ? node.natListenAddress : node.publicIp;
  if (!addr) throw new Error(t('spec.natNoListen'));
  return addr;
}

export function isManagedProxyDevice(name: string): boolean {
  return /^pm\d+-(tcp|udp)6?$/.test(name);
}

/**
 * 构建端口映射对应的 proxy 设备。IPv4 使用 NAT 模式（内核 DNAT 转发）；
 * 宿主机设置了公网 IPv6 时，容器额外监听 IPv6 并转发到实例的 IPv4。
 * NAT 模式不能跨地址族，所以 IPv6 走转发进程；虚拟机的 proxy 设备只支持 NAT 模式，因此不做 IPv6 映射。
 */
export function buildProxyDevices(
  node: Pick<Node, 'natListenAddress' | 'natListenAddressV6' | 'publicIp' | 'publicIpv6'>,
  inst: Pick<Instance, 'type' | 'privateIp'>,
  mapping: Pick<PortMapping, 'id' | 'protocol' | 'publicPort' | 'privatePort'>,
): IncusDevices {
  if (!inst.privateIp) throw new Error(t('spec.natNoPrivateIp'));
  const ipv6 = !!node.publicIpv6 && !isVmType(inst.type);
  const devices: IncusDevices = {};
  const listen4 = natListenIpv4(node);
  for (const name of proxyDeviceNames(mapping)) {
    const proto = name.endsWith('-udp') ? 'udp' : 'tcp';
    const connect = `${proto}:${inst.privateIp}:${mapping.privatePort}`;
    devices[name] = { type: 'proxy', listen: `${proto}:${listen4}:${mapping.publicPort}`, connect, nat: 'true' };
    if (ipv6) devices[ipv6DeviceName(name)] = { type: 'proxy', listen: `${proto}:[${node.natListenAddressV6 || '::'}]:${mapping.publicPort}`, connect };
  }
  return devices;
}

export function imageSource(image: Pick<Image, 'alias' | 'server' | 'protocol'>): IncusImageSource {
  return { type: 'image', alias: image.alias, server: image.server, protocol: image.protocol, mode: 'pull' };
}

type SpecInstance = Pick<
  Instance,
  | 'id'
  | 'name'
  | 'hostname'
  | 'type'
  | 'cpu'
  | 'cpuAllowance'
  | 'cpuPriority'
  | 'processLimit'
  | 'memory'
  | 'swap'
  | 'swapEnabled'
  | 'disk'
  | 'diskRead'
  | 'diskWrite'
  | 'diskReadIops'
  | 'diskWriteIops'
  | 'bandwidthIn'
  | 'bandwidthOut'
  | 'throttleRate'
  | 'trafficThrottled'
  | 'privateIp'
  | 'publicIpv6'
  | 'macAddress'
  | 'storagePool'
  | 'privileged'
  | 'nesting'
  | 'boot'
  | 'status'
> & Partial<Pick<Instance, 'ipv6Prefixes'>>;

/** 根据是否处于超额限速状态返回网卡限速值 */
export function nicLimits(inst: Pick<Instance, 'bandwidthIn' | 'bandwidthOut' | 'throttleRate' | 'trafficThrottled'>) {
  const rateIn = inst.trafficThrottled ? Math.min(inst.throttleRate, inst.bandwidthIn) : inst.bandwidthIn;
  const rateOut = inst.trafficThrottled ? Math.min(inst.throttleRate, inst.bandwidthOut) : inst.bandwidthOut;
  const limits: IncusDevice = {};
  if (rateIn > 0) limits['limits.ingress'] = `${rateIn}Mbit`;
  if (rateOut > 0) limits['limits.egress'] = `${rateOut}Mbit`;
  return limits;
}

export function buildNic(inst: SpecInstance, node: Node, ip: IpAddress | null): IncusDevice {
  const vm = isVmType(inst.type);
  let nic: IncusDevice;
  if (isNatType(inst.type)) {
    if (!inst.privateIp) throw new Error(t('spec.natNoPrivateIp'));
    nic = { type: 'nic', network: node.natNetwork, 'ipv4.address': inst.privateIp };
  } else {
    if (!ip) throw new Error(t('spec.noPublicIp'));
    if (node.publicNicMode === 'ROUTED') {
      nic = { type: 'nic', nictype: 'routed', 'ipv4.address': ip.address };
      if (node.publicNicParent) nic.parent = node.publicNicParent;
    } else {
      if (!node.publicNicParent) throw new Error(t('spec.noBridge'));
      nic = { type: 'nic', nictype: 'bridged', parent: node.publicNicParent };
    }
  }
  if (!vm) nic.name = 'eth0';
  if (inst.macAddress) nic.hwaddr = inst.macAddress;
  return { ...nic, ...nicLimits(inst) };
}

/** 公网 IPv6 网卡（eth1）的 MAC：由 eth0 的 MAC 派生，虚拟机内按 MAC 匹配网卡 */
export function ipv6Mac(mac: string): string {
  const parts = mac.split(':');
  parts[3] = (parseInt(parts[3], 16) ^ 0x80).toString(16).padStart(2, '0');
  return parts.join(':');
}

/**
 * 公网 IPv6 网卡（routed）：宿主机通过父接口代答 NDP 并把地址路由到实例。
 * 容器内由 Incus 自动配置地址与默认路由，虚拟机通过 cloud-init 网络配置。
 */
export function buildIpv6Nic(inst: SpecInstance, node: Pick<Node, 'ipv6Parent'>): IncusDevice | null {
  if (!inst.publicIpv6) return null;
  const nic: IncusDevice = { type: 'nic', nictype: 'routed', 'ipv6.address': inst.publicIpv6 };
  if (inst.ipv6Prefixes) nic['ipv6.routes'] = inst.ipv6Prefixes;
  if (node.ipv6Parent) nic.parent = node.ipv6Parent;
  if (!isVmType(inst.type)) nic.name = 'eth1';
  if (inst.macAddress) nic.hwaddr = ipv6Mac(inst.macAddress);
  return { ...nic, ...nicLimits(inst) };
}

/** 容器安全选项：嵌套（容器内运行 Docker 等）与特权容器；关闭的项不写入 */
export function containerSecurity(inst: Pick<Instance, 'privileged' | 'nesting'>): Record<string, string> {
  const config: Record<string, string> = {};
  if (inst.nesting) config['security.nesting'] = 'true';
  if (inst.privileged) config['security.privileged'] = 'true';
  return config;
}

/**
 * 容器 CPU 配额的硬限制（CFS 时间片）：配额为分配核数的百分比，例如 1 核 10% → 10ms/100ms，2 核 50% → 100ms/100ms。
 * Incus 的百分比写法（如 10%）只是 CPU 权重，宿主机空闲时不起作用，因此不用。
 */
export function cpuAllowanceValue(inst: Pick<Instance, 'type' | 'cpu' | 'cpuAllowance'>): string | null {
  if (isVmType(inst.type) || !inst.cpuAllowance) return null;
  return `${Math.max(1, Math.round(inst.cpuAllowance * inst.cpu))}ms/100ms`;
}

/**
 * 虚拟机的 CPU 配额（每秒可用的 CPU 时间，微秒）：Incus 不支持限制虚拟机，由宿主机上报程序把 QEMU 进程放入带 CPUQuota 的 systemd scope。
 * 与容器相同按分配核数的百分比计算，例如 2 核 50% → 1 秒 1,000,000 微秒（1 核）。
 */
export function vmCpuQuotaUsec(inst: Pick<Instance, 'type' | 'cpu' | 'cpuAllowance'>): number | null {
  if (!isVmType(inst.type) || !inst.cpuAllowance) return null;
  return Math.max(10_000, Math.round(inst.cpuAllowance * inst.cpu * 10_000));
}

/** 虚拟机的 CPU 权重（systemd CPUWeight 1~100，100 为默认）：由 CPU 优先级 0~10 换算 */
export function vmCpuWeight(inst: Pick<Instance, 'type' | 'cpuPriority'>): number | null {
  if (!isVmType(inst.type) || inst.cpuPriority == null) return null;
  return Math.max(1, inst.cpuPriority * 10);
}

/** 开机自启：暂停的实例不随宿主机开机启动；「恢复之前的状态」不设置该项（Incus 默认恢复关机前的状态） */
export function autostartValue(inst: Pick<Instance, 'status' | 'boot'>): string | null {
  if (inst.status === 'SUSPENDED') return 'false';
  const mode = bootOptions(inst.boot).autostart;
  return mode === 'LAST_STATE' ? null : String(mode === 'ALWAYS');
}

/**
 * 容器的 SWAP（limits.memory.swap）：启用时为 SWAP 大小（Incus 的 instance_memory_swap_bytes），
 * 未启用或套餐不提供时为 false（不使用宿主机 SWAP）；虚拟机不设置
 */
export function swapValue(inst: Pick<Instance, 'type' | 'swap' | 'swapEnabled'>): string | null {
  if (isVmType(inst.type)) return null;
  return inst.swap > 0 && inst.swapEnabled ? `${inst.swap}MiB` : 'false';
}

/**
 * 面板管理的实例配置：CPU、内存、进程数等资源限制与启动设置；null 表示不应设置（使用 Incus 默认值）。
 * 进程数与 CPU 优先级只对容器生效（虚拟机的优先级由上报程序设置）。
 */
export function buildLimitsConfig(inst: SpecInstance): Record<string, string | null> {
  const vm = isVmType(inst.type);
  const boot = bootOptions(inst.boot);
  const num = (v: number | null) => (v == null ? null : String(v));
  return {
    'limits.cpu': String(inst.cpu),
    'limits.memory': `${inst.memory}MiB`,
    'limits.memory.swap': swapValue(inst),
    'limits.cpu.allowance': cpuAllowanceValue(inst),
    'limits.cpu.priority': vm ? null : num(inst.cpuPriority),
    'limits.processes': vm ? null : num(inst.processLimit),
    'boot.autostart': autostartValue(inst),
    'boot.autostart.delay': boot.delay ? String(boot.delay) : null,
    'boot.autostart.priority': num(boot.priority),
    'boot.stop.priority': num(boot.stopPriority),
    'boot.host_shutdown_timeout': num(boot.shutdownTimeout),
  };
}

/** 按 null = 删除的约定把配置写入实例 */
export function applyConfig(target: Record<string, string>, config: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(config)) {
    if (v === null) delete target[k];
    else target[k] = v;
  }
}

/** 去掉值为 null 的项（新建实例时使用） */
export function presentConfig(config: Record<string, string | null>): Record<string, string> {
  return Object.fromEntries(Object.entries(config).filter((e): e is [string, string] => e[1] !== null));
}

const DISK_LIMIT_KEYS = ['limits.read', 'limits.write'] as const;

/**
 * 磁盘 I/O 限制（limits.read / limits.write）：每个方向按速率（如 100MB）或 IOPS（如 3000iops）限制，二选一
 * （Incus 每个方向只接受一种）；都为 0 时不限制。同时用于系统盘与数据盘，避免通过数据盘绕过限制。
 */
export function diskLimits(inst: DiskIo): Record<(typeof DISK_LIMIT_KEYS)[number], string | null> {
  const value = (mb: number, iops: number) => (iops > 0 ? `${iops}iops` : mb > 0 ? `${mb}MB` : null);
  return { 'limits.read': value(inst.diskRead, inst.diskReadIops), 'limits.write': value(inst.diskWrite, inst.diskWriteIops) };
}

type DiskIo = Pick<Instance, 'diskRead' | 'diskWrite' | 'diskReadIops' | 'diskWriteIops'>;

/** 校验磁盘限制：同一方向不能同时设置速率与 IOPS（patch 时与当前值合并后检查） */
export function assertDiskLimits(input: Partial<DiskIo>, current?: DiskIo): void {
  const v = { diskRead: 0, diskWrite: 0, diskReadIops: 0, diskWriteIops: 0, ...current, ...Object.fromEntries(Object.entries(input).filter(([, x]) => x !== undefined)) };
  if ((v.diskRead > 0 && v.diskReadIops > 0) || (v.diskWrite > 0 && v.diskWriteIops > 0)) throw badRequest(t('limits.diskEither'));
}

/** 面板创建的数据盘设备名：data<卷 ID> */
export const isVolumeDevice = (name: string) => /^data\d+$/.test(name);

/** 把磁盘 I/O 限制写入系统盘与数据盘设备 */
export function applyDiskLimits(devices: IncusDevices, inst: DiskIo): void {
  const limits = diskLimits(inst);
  for (const [name, dev] of Object.entries(devices)) {
    if (dev.type !== 'disk' || (name !== 'root' && !isVolumeDevice(name))) continue;
    applyConfig(dev, limits);
  }
}

// ───────── cloud-init ─────────

const DEFAULT_USER_DATA = `#cloud-config
hostname: {{hostname}}
manage_etc_hosts: true
ssh_pwauth: true
disable_root: false
chpasswd:
  expire: false
  users:
    - name: root
      password: {{password}}
      type: text
users:
  - name: root
    lock_passwd: false
    ssh_authorized_keys: {{ssh_authorized_keys}}
package_update: true
packages:
  - {{ssh_package}}
runcmd:
  - [sh, -c, "if [ -c /dev/ttyS0 ]; then systemctl enable --now serial-getty@ttyS0.service 2>/dev/null || true; fi"]
  - [sh, -c, "mkdir -p /etc/ssh/sshd_config.d; printf 'PermitRootLogin yes\\\\nPasswordAuthentication yes\\\\n' > /etc/ssh/sshd_config.d/00-paledove.conf"]
  - [sh, -c, "sed -i -E 's/^#?PermitRootLogin.*/PermitRootLogin yes/; s/^#?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config"]
  - [sh, -c, "systemctl enable ssh 2>/dev/null; systemctl enable sshd 2>/dev/null; systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || (rc-update add sshd default; rc-service sshd restart) || true"]
`;

export interface CloudInitVars {
  hostname: string;
  password: string;
  sshKeys: string[];
}

function sshPackage(family: string): string {
  return ['alpine', 'arch', 'archlinux', 'gentoo'].includes(family.toLowerCase()) ? 'openssh' : 'openssh-server';
}

/**
 * 渲染 cloud-init user-data。
 * 模板占位符：{{hostname}} {{password}} {{ssh_authorized_keys}} {{ssh_package}}
 * 其中 password 与 ssh_authorized_keys 输出为 JSON（同时也是合法 YAML），避免注入。
 */
export function renderUserData(image: Pick<Image, 'cloudInit' | 'family'>, vars: CloudInitVars): string {
  const template = image.cloudInit?.trim() ? image.cloudInit : DEFAULT_USER_DATA;
  return template
    .replaceAll('{{hostname}}', vars.hostname)
    .replaceAll('{{password}}', JSON.stringify(vars.password))
    .replaceAll('{{ssh_authorized_keys}}', JSON.stringify(vars.sshKeys))
    .replaceAll('{{ssh_package}}', sshPackage(image.family));
}

/** 公网 IPv6 网卡（eth1）的 cloud-init 配置：静态地址，默认路由经 Incus routed 网卡的 fe80::1 */
function ipv6Ethernet(mac: string, ipv6: string): string[] {
  const addresses = parseIpv6List(ipv6)
    .map((a) => JSON.stringify(`${a}/128`))
    .join(', ');
  return [
    '  eth1:',
    '    match:',
    `      macaddress: "${ipv6Mac(mac)}"`,
    '    set-name: eth1',
    `    addresses: [${addresses}]`,
    '    routes:',
    '      - to: "::/0"',
    '        via: "fe80::1"',
    '        on-link: true',
  ];
}

/** 独立 IP 实例的静态网络配置（cloud-init network-config v2）；带公网 IPv6 时追加 eth1 */
export function renderNetworkConfig(node: Node, ip: IpAddress, mac: string, ipv6?: string | null): string {
  const dns = node.dnsServers
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((s) => JSON.stringify(s));
  const routed = node.publicNicMode === 'ROUTED';
  const address = routed ? `${ip.address}/32` : `${ip.address}/${ip.prefix}`;
  const gateway = routed ? '169.254.0.1' : ip.gateway;
  if (!gateway) throw new Error(t('spec.ipNoGateway', { ip: ip.address }));
  return [
    'version: 2',
    'ethernets:',
    '  eth0:',
    '    match:',
    `      macaddress: "${mac}"`,
    '    set-name: eth0',
    `    addresses: ["${address}"]`,
    '    routes:',
    '      - to: 0.0.0.0/0',
    `        via: ${gateway}`,
    ...(routed ? ['        on-link: true'] : []),
    '    nameservers:',
    `      addresses: [${dns.join(', ')}]`,
    ...(ipv6 ? ipv6Ethernet(mac, ipv6) : []),
    '',
  ].join('\n');
}

/** NAT 虚拟机带公网 IPv6 时的网络配置：eth0 通过 DHCP 获取内网 IPv4，eth1 为静态公网 IPv6 */
export function renderIpv6NetworkConfig(mac: string, ipv6: string): string {
  return [
    'version: 2',
    'ethernets:',
    '  eth0:',
    '    match:',
    `      macaddress: "${mac}"`,
    '    set-name: eth0',
    '    dhcp4: true',
    ...ipv6Ethernet(mac, ipv6),
    '',
  ].join('\n');
}

export interface BuildSpecInput {
  instance: SpecInstance;
  node: Node;
  image: Image;
  ip: IpAddress | null;
  portMappings: PortMapping[];
  vars: CloudInitVars;
}

/** 虚拟机的静态网络配置（独立 IPv4 / 公网 IPv6）；其余情况由 DHCP 或 Incus 配置，返回 undefined */
export function networkConfig(instance: SpecInstance, node: Node, ip: IpAddress | null): string | undefined {
  if (instance.type === 'KVM_IPV4' && ip) {
    if (!instance.macAddress) throw new Error(t('spec.noMac'));
    return renderNetworkConfig(node, ip, instance.macAddress, instance.publicIpv6);
  }
  if (isVmType(instance.type) && instance.publicIpv6) {
    if (!instance.macAddress) throw new Error(t('spec.noMac'));
    return renderIpv6NetworkConfig(instance.macAddress, instance.publicIpv6);
  }
  return undefined;
}

export function cloudInitConfig(input: Omit<BuildSpecInput, 'portMappings'>): Record<string, string> {
  const { instance, node, image, ip, vars } = input;
  const config: Record<string, string> = {
    'cloud-init.user-data': renderUserData(image, vars),
  };
  const net = networkConfig(instance, node, ip);
  if (net) config['cloud-init.network-config'] = net;
  return config;
}

export function buildCreateRequest(input: BuildSpecInput): IncusInstanceCreate {
  const { instance, node, image, ip, portMappings } = input;
  const vm = isVmType(instance.type);
  const devices: IncusDevices = {
    root: { type: 'disk', path: '/', pool: instance.storagePool || node.storagePool, size: `${instance.disk}GiB`, ...presentConfig(diskLimits(instance)) },
    eth0: buildNic(instance, node, ip),
  };
  const v6 = buildIpv6Nic(instance, node);
  if (v6) devices.eth1 = v6;
  if (isNatType(instance.type) && instance.privateIp) {
    for (const m of portMappings) Object.assign(devices, buildProxyDevices(node, instance, m));
  }
  const config: Record<string, string> = {
    ...presentConfig(buildLimitsConfig(instance)),
    ...cloudInitConfig(input),
    'user.paledove.id': String(instance.id),
  };
  if (vm) config['security.secureboot'] = 'false';
  else Object.assign(config, containerSecurity(instance));
  return {
    name: instance.name,
    type: vm ? 'virtual-machine' : 'container',
    description: `paledove #${instance.id} ${instance.hostname}`,
    source: imageSource(image),
    config,
    devices,
    profiles: [node.profile],
    start: true,
  };
}

import { describe, expect, it } from 'vitest';
import type { Image, Instance, IpAddress, Node, PortMapping } from '../src/lib/prisma.ts';
import { trafficUsedBytes } from '../src/services/serializers.ts';
import { sumCounters } from '../src/services/metrics.ts';
import type { IncusInstanceState } from '../src/incus/types.ts';
import {
  applyDiskLimits,
  assertDiskLimits,
  buildCreateRequest,
  buildLimitsConfig,
  cpuAllowanceValue,
  diskLimits,
  vmCpuQuotaUsec,
  vmCpuWeight,
  buildIpv6Nic,
  buildProxyDevices,
  ipv6Mac,
  isManagedProxyDevice,
  nicLimits,
  proxyDeviceNames,
  renderIpv6NetworkConfig,
  renderNetworkConfig,
  renderUserData,
} from '../src/services/spec.ts';

const node = (over: Partial<Node> = {}): Node =>
  ({
    id: 1,
    name: 'n1',
    region: 'HK',
    endpoint: 'mock://x',
    project: 'default',
    storagePool: 'pool1',
    profile: 'default',
    publicIp: '203.0.113.10',
    natNetwork: 'incusbr0',
    natCidr: '10.0.0.1/24',
    natListenAddress: '',
    portRangeStart: 20000,
    portRangeEnd: 30000,
    publicNicMode: 'ROUTED',
    publicNicParent: null,
    dnsServers: '1.1.1.1, 8.8.8.8',
    ...over,
  }) as Node;

const image = (over: Partial<Image> = {}): Image =>
  ({ id: 1, name: 'Debian 12', family: 'debian', alias: 'debian/12/cloud', server: 'https://images.linuxcontainers.org', protocol: 'simplestreams', cloudInit: null, ...over }) as Image;

const instance = (over: Partial<Instance> = {}): Instance =>
  ({
    id: 7,
    name: 'pd-abc',
    hostname: 'web-01',
    type: 'LXC_NAT',
    cpu: 2,
    cpuAllowance: 50,
    memory: 1024,
    disk: 10,
    bandwidthIn: 100,
    bandwidthOut: 50,
    throttleRate: 1,
    trafficThrottled: false,
    privateIp: '10.0.0.254',
    macAddress: '00:16:3e:aa:bb:cc',
    privileged: false,
    nesting: true,
    ...over,
  }) as Instance;

const mapping = (over: Partial<PortMapping> = {}): PortMapping =>
  ({ id: 3, protocol: 'TCP_UDP', publicPort: 25000, privatePort: 443, ...over }) as PortMapping;

describe('proxy devices', () => {
  it('creates tcp/udp NAT proxies', () => {
    expect(proxyDeviceNames(mapping({ protocol: 'TCP' }))).toEqual(['pm3-tcp']);
    expect(proxyDeviceNames(mapping())).toEqual(['pm3-tcp', 'pm3-udp']);
    expect(buildProxyDevices(node(), instance(), mapping())).toEqual({
      'pm3-tcp': { type: 'proxy', listen: 'tcp:203.0.113.10:25000', connect: 'tcp:10.0.0.254:443', nat: 'true' },
      'pm3-udp': { type: 'proxy', listen: 'udp:203.0.113.10:25000', connect: 'udp:10.0.0.254:443', nat: 'true' },
    });
    // NAT 模式不能监听 0.0.0.0：留空或填 0.0.0.0 时使用公网 IPv4，设置了监听地址时使用它
    expect(buildProxyDevices(node({ natListenAddress: '0.0.0.0' }), instance(), mapping({ protocol: 'TCP' }))['pm3-tcp'].listen).toBe('tcp:203.0.113.10:25000');
    expect(buildProxyDevices(node({ natListenAddress: '10.1.2.3' }), instance(), mapping({ protocol: 'TCP' }))['pm3-tcp'].listen).toBe('tcp:10.1.2.3:25000');
    expect(() => buildProxyDevices(node({ publicIp: '' }), instance(), mapping())).toThrow();
    expect(isManagedProxyDevice('pm12-udp')).toBe(true);
    expect(isManagedProxyDevice('pm12-tcp6')).toBe(true);
    expect(isManagedProxyDevice('eth0')).toBe(false);
    expect(isManagedProxyDevice('http')).toBe(false);
  });

  it('adds IPv6 listeners for containers when the host has a public IPv6', () => {
    const v6 = node({ publicIpv6: '2001:db8::1', natListenAddressV6: '' });
    expect(buildProxyDevices(v6, instance({ type: 'LXC_NAT' }), mapping({ protocol: 'TCP' }))).toEqual({
      'pm3-tcp': { type: 'proxy', listen: 'tcp:203.0.113.10:25000', connect: 'tcp:10.0.0.254:443', nat: 'true' },
      'pm3-tcp6': { type: 'proxy', listen: 'tcp:[::]:25000', connect: 'tcp:10.0.0.254:443' },
    });
    expect(buildProxyDevices(node({ publicIpv6: '2001:db8::1', natListenAddressV6: '2001:db8::2' }), instance({ type: 'LXC_NAT' }), mapping())['pm3-udp6'].listen).toBe(
      'udp:[2001:db8::2]:25000',
    );
    // 虚拟机的 proxy 设备只支持 NAT 模式，不做 IPv6 映射
    expect(Object.keys(buildProxyDevices(v6, instance({ type: 'KVM_NAT' }), mapping()))).toEqual(['pm3-tcp', 'pm3-udp']);
  });

  it('adds a routed IPv6 NIC when the instance has a public IPv6', () => {
    const v6node = node({ networkMode: 'NAT_IPV6', ipv6Subnet: '2001:db8::/64', ipv6Parent: 'eth0' });
    expect(buildIpv6Nic(instance(), v6node)).toBeNull();
    const lxc = instance({ type: 'LXC_NAT', publicIpv6: '2001:db8::abc' });
    expect(buildIpv6Nic(lxc, v6node)).toEqual({
      type: 'nic',
      nictype: 'routed',
      'ipv6.address': '2001:db8::abc',
      parent: 'eth0',
      name: 'eth1',
      hwaddr: '00:16:3e:2a:bb:cc',
      'limits.ingress': '100Mbit',
      'limits.egress': '50Mbit',
    });
    expect(ipv6Mac('00:16:3e:aa:bb:cc')).toBe('00:16:3e:2a:bb:cc');
    // 虚拟机：网卡名由系统决定，通过 cloud-init 按 MAC 配置静态 IPv6
    const vm = instance({ type: 'KVM_NAT', publicIpv6: '2001:db8::abc' });
    expect(buildIpv6Nic(vm, v6node)?.name).toBeUndefined();
    // 创建请求：容器带 eth1；虚拟机带 eth1 并通过 cloud-init 配置网络
    const vars = { hostname: 'v6', password: 'Secret123', sshKeys: [] };
    const lxcReq = buildCreateRequest({ instance: lxc, node: v6node, image: image(), ip: null, portMappings: [], vars });
    expect(lxcReq.devices.eth1).toMatchObject({ nictype: 'routed', 'ipv6.address': '2001:db8::abc', parent: 'eth0', name: 'eth1' });
    expect(lxcReq.config['cloud-init.network-config']).toBeUndefined();
    const vmReq = buildCreateRequest({ instance: vm, node: v6node, image: image(), ip: null, portMappings: [], vars });
    expect(vmReq.devices.eth1).toMatchObject({ nictype: 'routed', 'ipv6.address': '2001:db8::abc' });
    expect(vmReq.config['cloud-init.network-config']).toContain('2001:db8::abc/128');
    expect(buildCreateRequest({ instance: instance(), node: node(), image: image(), ip: null, portMappings: [], vars }).devices.eth1).toBeUndefined();
    // 独立 IPv4 + IPv6：eth0 静态公网 IPv4，eth1 静态公网 IPv6
    const dedicated = buildCreateRequest({
      instance: instance({ type: 'KVM_IPV4', privateIp: null, publicIpv6: '2001:db8::abd' }),
      node: node({ networkMode: 'IPV4_IPV6', ipv6Subnet: '2001:db8::/64', ipv6Parent: 'eth0', publicNicParent: 'eth0' }),
      image: image(),
      ip: { address: '198.51.100.7', prefix: 32, gateway: null } as IpAddress,
      portMappings: [],
      vars,
    });
    expect(dedicated.devices.eth0).toMatchObject({ nictype: 'routed', 'ipv4.address': '198.51.100.7' });
    expect(dedicated.devices.eth1).toMatchObject({ nictype: 'routed', 'ipv6.address': '2001:db8::abd' });
    expect(dedicated.config['cloud-init.network-config']).toContain('198.51.100.7/32');
    expect(dedicated.config['cloud-init.network-config']).toContain('2001:db8::abd/128');
    const cfg = renderIpv6NetworkConfig('00:16:3e:aa:bb:cc', '2001:db8::abc');
    expect(cfg).toContain('dhcp4: true');
    expect(cfg).toContain('macaddress: "00:16:3e:2a:bb:cc"');
    expect(cfg).toContain('addresses: ["2001:db8::abc/128"]');
  });

  it('assigns several public IPv6 addresses to one instance', () => {
    const v6node = node({ networkMode: 'NAT_IPV6', ipv6Subnet: '2001:db8::/64', ipv6Parent: 'eth0' });
    const list = '2001:db8::a1,2001:db8::a2,2001:db8::a3';
    const vars = { hostname: 'v6', password: 'Secret123', sshKeys: [] };
    // routed 网卡的地址为逗号分隔列表
    expect(buildIpv6Nic(instance({ publicIpv6: list }), v6node)?.['ipv6.address']).toBe(list);
    // 虚拟机通过 cloud-init 在 eth1 上配置全部地址
    const vm = buildCreateRequest({ instance: instance({ type: 'KVM_NAT', publicIpv6: list }), node: v6node, image: image(), ip: null, portMappings: [], vars });
    expect(vm.config['cloud-init.network-config']).toContain('addresses: ["2001:db8::a1/128", "2001:db8::a2/128", "2001:db8::a3/128"]');
  });

  it('throttles NIC limits when over quota', () => {
    expect(nicLimits(instance())).toEqual({ 'limits.ingress': '100Mbit', 'limits.egress': '50Mbit' });
    expect(nicLimits(instance({ trafficThrottled: true, throttleRate: 2 }))).toEqual({
      'limits.ingress': '2Mbit',
      'limits.egress': '2Mbit',
    });
  });
});

describe('cloud-init', () => {
  it('escapes the password and keys as JSON', () => {
    const out = renderUserData(image(), { hostname: 'web-01', password: 'pa"ss\nword: x', sshKeys: ['ssh-ed25519 AAAA test'] });
    expect(out).toContain('password: "pa\\"ss\\nword: x"');
    expect(out).toContain('ssh_authorized_keys: ["ssh-ed25519 AAAA test"]');
    expect(out).toContain('hostname: web-01');
    expect(out).toContain('- openssh-server');
    expect(out.startsWith('#cloud-config')).toBe(true);
  });

  it('uses the right ssh package and custom templates', () => {
    expect(renderUserData(image({ family: 'alpine' }), { hostname: 'h', password: 'p', sshKeys: [] })).toContain('- openssh\n');
    const custom = renderUserData(image({ cloudInit: '#cloud-config\nhostname: {{hostname}}\npw: {{password}}' }), {
      hostname: 'box',
      password: 'secret',
      sshKeys: [],
    });
    expect(custom).toBe('#cloud-config\nhostname: box\npw: "secret"');
  });

  it('renders routed and bridged network configs', () => {
    const ip = { address: '198.51.100.7', prefix: 24, gateway: '198.51.100.1' } as IpAddress;
    const routed = renderNetworkConfig(node(), ip, '00:16:3e:aa:bb:cc');
    expect(routed).toContain('addresses: ["198.51.100.7/32"]');
    expect(routed).toContain('via: 169.254.0.1');
    expect(routed).toContain('on-link: true');
    expect(routed).toContain('addresses: ["1.1.1.1", "8.8.8.8"]');
    const bridged = renderNetworkConfig(node({ publicNicMode: 'BRIDGED', publicNicParent: 'br0' }), ip, '00:16:3e:aa:bb:cc');
    expect(bridged).toContain('addresses: ["198.51.100.7/24"]');
    expect(bridged).toContain('via: 198.51.100.1');
    expect(bridged).not.toContain('on-link');
  });
});

describe('instance create request', () => {
  it('builds an LXC NAT container', () => {
    const req = buildCreateRequest({
      instance: instance(),
      node: node(),
      image: image(),
      ip: null,
      portMappings: [mapping({ id: 1, protocol: 'TCP', publicPort: 24000, privatePort: 22 })],
      vars: { hostname: 'web-01', password: 'Secret123', sshKeys: [] },
    });
    expect(req.type).toBe('container');
    expect(req.config['limits.cpu']).toBe('2');
    expect(req.config['limits.memory']).toBe('1024MiB');
    // 硬限制：2 核的 50% = 每 100ms 最多 100ms CPU 时间（约 1 核）
    expect(req.config['limits.cpu.allowance']).toBe('100ms/100ms');
    expect(cpuAllowanceValue({ type: 'LXC_NAT', cpu: 1, cpuAllowance: 10 })).toBe('10ms/100ms');
    expect(cpuAllowanceValue({ type: 'KVM_NAT', cpu: 1, cpuAllowance: 10 })).toBeNull();
    expect(cpuAllowanceValue({ type: 'LXC_NAT', cpu: 4, cpuAllowance: null })).toBeNull();
    expect(req.config['security.nesting']).toBe('true');
    expect(req.config['security.privileged']).toBeUndefined();
    expect(req.devices.root).toEqual({ type: 'disk', path: '/', pool: 'pool1', size: '10GiB' });
    expect(req.devices.eth0).toMatchObject({ type: 'nic', network: 'incusbr0', 'ipv4.address': '10.0.0.254', name: 'eth0' });
    expect(req.devices['pm1-tcp']).toMatchObject({ connect: 'tcp:10.0.0.254:22', listen: 'tcp:203.0.113.10:24000' });
    expect(req.config['cloud-init.network-config']).toBeUndefined();
  });

  it('applies the container security options of the instance', () => {
    const build = (over: Partial<Instance>) =>
      buildCreateRequest({ instance: instance(over), node: node(), image: image(), ip: null, portMappings: [], vars: { hostname: 'web-01', password: 'Secret123', sshKeys: [] } }).config;
    const privileged = build({ privileged: true, nesting: false, storagePool: 'fast' });
    expect(privileged['security.privileged']).toBe('true');
    expect(privileged['security.nesting']).toBeUndefined();
    // 虚拟机不使用容器安全选项
    expect(build({ type: 'KVM_NAT', privileged: true })['security.privileged']).toBeUndefined();
  });

  it('builds a KVM VM with a routed public IPv4', () => {
    const req = buildCreateRequest({
      instance: instance({ type: 'KVM_IPV4', privateIp: null }),
      node: node({ publicNicParent: 'eth0' }),
      image: image(),
      ip: { address: '198.51.100.7', prefix: 32, gateway: null } as IpAddress,
      portMappings: [],
      vars: { hostname: 'kvm', password: 'Secret123', sshKeys: [] },
    });
    expect(req.type).toBe('virtual-machine');
    expect(req.config['security.secureboot']).toBe('false');
    expect(req.config['limits.cpu.allowance']).toBeUndefined();
    expect(req.devices.eth0).toMatchObject({ nictype: 'routed', 'ipv4.address': '198.51.100.7', parent: 'eth0', hwaddr: '00:16:3e:aa:bb:cc' });
    expect(req.devices.eth0.name).toBeUndefined();
    expect(req.config['cloud-init.network-config']).toContain('198.51.100.7/32');
  });
});

describe('resource limits and boot options', () => {
  const create = (over: Partial<Instance>) =>
    buildCreateRequest({ instance: instance(over), node: node(), image: image(), ip: null, portMappings: [], vars: { hostname: 'web-01', password: 'Secret123', sshKeys: [] } });

  it('limits disk I/O by rate and IOPS on the root and data disks', () => {
    // Incus 每个方向只接受速率或 IOPS 中的一种
    expect(diskLimits({ diskRead: 100, diskWrite: 0, diskReadIops: 0, diskWriteIops: 500 })).toEqual({ 'limits.read': '100MB', 'limits.write': '500iops' });
    expect(() => assertDiskLimits({ diskRead: 100, diskReadIops: 3000 })).toThrow();
    expect(() => assertDiskLimits({ diskReadIops: 3000 }, { diskRead: 100, diskWrite: 0, diskReadIops: 0, diskWriteIops: 0 })).toThrow();
    expect(() => assertDiskLimits({ diskRead: 0, diskReadIops: 3000 }, { diskRead: 100, diskWrite: 0, diskReadIops: 0, diskWriteIops: 0 })).not.toThrow();
    expect(diskLimits({ diskRead: 0, diskWrite: 0, diskReadIops: 0, diskWriteIops: 0 })).toEqual({ 'limits.read': null, 'limits.write': null });
    const req = create({ diskRead: 200, diskWrite: 100 });
    expect(req.devices.root).toEqual({ type: 'disk', path: '/', pool: 'pool1', size: '10GiB', 'limits.read': '200MB', 'limits.write': '100MB' });
    // 修改限制时：系统盘与数据盘都更新，取消的限制被删除，其他磁盘设备不动
    const devices = { root: { type: 'disk', path: '/', 'limits.read': '200MB' }, data3: { type: 'disk', source: 'v' }, share: { type: 'disk', source: '/srv' }, eth0: { type: 'nic' } };
    applyDiskLimits(devices, { diskRead: 0, diskWrite: 50, diskReadIops: 0, diskWriteIops: 0 });
    expect(devices.root).toEqual({ type: 'disk', path: '/', 'limits.write': '50MB' });
    expect(devices.data3).toEqual({ type: 'disk', source: 'v', 'limits.write': '50MB' });
    expect(devices.share).toEqual({ type: 'disk', source: '/srv' });
  });

  it('sets process limits and CPU priority on containers only', () => {
    const lxc = create({ processLimit: 512, cpuPriority: 3 }).config;
    expect(lxc['limits.processes']).toBe('512');
    expect(lxc['limits.cpu.priority']).toBe('3');
    const vm = create({ type: 'KVM_NAT', processLimit: 512, cpuPriority: 3, cpuAllowance: 50 }).config;
    expect(vm['limits.processes']).toBeUndefined();
    expect(vm['limits.cpu.priority']).toBeUndefined();
    expect(buildLimitsConfig(instance({ cpuPriority: null, processLimit: null }))).toMatchObject({ 'limits.cpu.priority': null, 'limits.processes': null });
  });

  it('caps virtual machine CPU through the host agent', () => {
    // 2 核 50% → 每秒 1 秒 CPU 时间；优先级 3 → 权重 30
    expect(vmCpuQuotaUsec({ type: 'KVM_NAT', cpu: 2, cpuAllowance: 50 })).toBe(1_000_000);
    expect(vmCpuQuotaUsec({ type: 'KVM_IPV4', cpu: 1, cpuAllowance: 1 })).toBe(10_000);
    expect(vmCpuQuotaUsec({ type: 'LXC_NAT', cpu: 2, cpuAllowance: 50 })).toBeNull();
    expect(vmCpuQuotaUsec({ type: 'KVM_NAT', cpu: 2, cpuAllowance: null })).toBeNull();
    expect(vmCpuWeight({ type: 'KVM_NAT', cpuPriority: 3 })).toBe(30);
    expect(vmCpuWeight({ type: 'KVM_NAT', cpuPriority: 0 })).toBe(1);
    expect(vmCpuWeight({ type: 'LXC_NAT', cpuPriority: 3 })).toBeNull();
  });

  it('applies the boot options of the product', () => {
    expect(create({}).config).toMatchObject({ 'boot.autostart': 'true' });
    const boot = { autostart: 'NEVER', delay: 10, priority: 5, stopPriority: 0, shutdownTimeout: 120 };
    expect(create({ boot }).config).toMatchObject({ 'boot.autostart': 'false', 'boot.autostart.delay': '10', 'boot.autostart.priority': '5', 'boot.stop.priority': '0', 'boot.host_shutdown_timeout': '120' });
    // 恢复之前的状态：不设置 boot.autostart（Incus 默认行为）；暂停的实例始终不自启
    expect(create({ boot: { autostart: 'LAST_STATE' } }).config['boot.autostart']).toBeUndefined();
    expect(buildLimitsConfig(instance({ boot: { autostart: 'LAST_STATE' }, status: 'SUSPENDED' }))['boot.autostart']).toBe('false');
    expect(buildLimitsConfig(instance({ boot: { autostart: 'ALWAYS', delay: 0 } }))).toMatchObject({ 'boot.autostart.delay': null, 'boot.autostart.priority': null });
  });

  it('bills only the primary and public IPv6 NICs', () => {
    const nic = (hwaddr: string, rx: number) => ({ hwaddr, counters: { bytes_received: rx, bytes_sent: rx * 2 } });
    const state = (network: Record<string, unknown>) => ({ network }) as unknown as IncusInstanceState;
    const mac = '00:16:3e:aa:bb:cc';
    // 容器：eth0 / eth1 计费，VPC 网卡 eth2 与容器内的 docker0、veth 不计费
    const lxc = state({ lo: nic('', 9), eth0: nic(mac, 100), eth1: nic(ipv6Mac(mac), 10), eth2: nic('00:16:3e:11:22:33', 1000), docker0: nic('02:42:00:00:00:01', 500), veth1: nic('aa:bb:cc:00:00:01', 500) });
    expect(sumCounters(lxc, { macAddress: mac })).toEqual({ rx: 110, tx: 220 });
    // 虚拟机内的网卡名由系统决定：按 MAC 识别
    const vm = state({ enp5s0: nic(mac.toUpperCase(), 100), enp6s0: nic('00:16:3e:11:22:33', 1000) });
    expect(sumCounters(vm, { macAddress: mac })).toEqual({ rx: 100, tx: 200 });
    // 没有 MAC 记录的旧实例：只排除 VPC 网卡
    expect(sumCounters(lxc, { macAddress: null })).toEqual({ rx: 1110, tx: 2220 });
  });
});

describe('traffic accounting modes', () => {
  const t = (mode: Instance['trafficMode']) => trafficUsedBytes({ trafficIn: 300n, trafficOut: 100n, trafficMode: mode });
  it('applies each billing mode', () => {
    expect(t('IN')).toBe(300n);
    expect(t('OUT')).toBe(100n);
    expect(t('BOTH')).toBe(400n);
    expect(t('MAX')).toBe(300n);
  });
});

describe('avatar url', async () => {
  const { avatarUrl, AVATAR_STYLES } = await import('../src/shared/index.ts');
  it('builds DiceBear URLs from the style and hashed seed', () => {
    expect(avatarUrl('https://api.dicebear.com/9.x/', { style: 'pixelArt', seed: 'abc', variant: 0 }, 64)).toBe('https://api.dicebear.com/9.x/pixel-art/svg?seed=abc&size=64&backgroundColor=transparent');
    // 未知风格退回默认风格；尺寸限制在 16~256
    expect(avatarUrl(undefined, { style: 'nope' as (typeof AVATAR_STYLES)[number], seed: 'abc', variant: 7 }, 999)).toBe('https://api.dicebear.com/9.x/big-smile/svg?seed=abc-7&size=256&backgroundColor=transparent');
    // 未配置 API 或缺少种子时显示首字母
    expect(avatarUrl('', { style: 'bigSmile', seed: 'abc', variant: 0 })).toBeNull();
    expect(avatarUrl('https://a.example', null)).toBeNull();
    // 不收录带方形底色的风格
    expect(AVATAR_STYLES).toHaveLength(21);
    expect(AVATAR_STYLES).not.toContain('initials');
  });
});

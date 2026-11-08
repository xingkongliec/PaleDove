import { randomUUID } from 'node:crypto';
import { redis } from '../lib/redis.ts';
import {
  IncusError,
  type ExecResult,
  type IncusApi,
  type IncusImageSource,
  type IncusInstance,
  type IncusInstanceCreate,
  type IncusInstanceFull,
  type IncusInstanceState,
  type IncusNetwork,
  type IncusNetworkCreate,
  type IncusNetworkState,
  type IncusVolumeCreate,
  type IncusResources,
  type IncusServer,
  type IncusStoragePool,
  type IncusStoragePoolCreate,
  type IncusStoragePoolResources,
  type TerminalOptions,
  type TerminalSession,
} from './types.ts';

/**
 * 模拟 Incus 节点（endpoint 以 mock:// 开头），用于开发与演示。
 * 状态保存在 Redis 中，资源占用与流量为随机模拟数据。
 */

interface MockRecord {
  instance: IncusInstance;
  snapshots: string[];
  /** 累计 CPU 时间（纳秒） */
  cpuNs: number;
  rx: number;
  tx: number;
  diskUsage: number;
  lastTick: number;
  /** 本次启动以来的模拟流量速率（bytes/s） */
  rate: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseSize(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB|KB|MB|GB|TB)?$/i.exec(v.trim());
  if (!m) return fallback;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'B').toLowerCase();
  const mul: Record<string, number> = {
    b: 1,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
  };
  return Math.round(n * (mul[unit] ?? 1));
}

export class MockIncusClient implements IncusApi {
  readonly endpoint: string;
  private readonly scope: string;
  private readonly subnetOctet: number;

  constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.scope = endpoint.slice('mock://'.length) || 'default';
    let h = 0;
    for (const ch of this.scope) h = (h * 31 + ch.charCodeAt(0)) % 200;
    this.subnetOctet = 20 + h;
  }

  private key(name: string) {
    return `mock:incus:${this.scope}:inst:${name}`;
  }

  private async load(name: string): Promise<MockRecord> {
    const raw = await redis.get(this.key(name));
    if (!raw) throw new IncusError('Instance not found', 404);
    return JSON.parse(raw) as MockRecord;
  }

  private async save(rec: MockRecord): Promise<void> {
    await redis.set(this.key(rec.instance.name), JSON.stringify(rec));
    await redis.sadd(`mock:incus:${this.scope}:names`, rec.instance.name);
  }

  /** 推进模拟时钟：累计 CPU 时间、流量与磁盘占用 */
  private tick(rec: MockRecord): void {
    const now = Date.now();
    const dt = Math.max(0, (now - rec.lastTick) / 1000);
    rec.lastTick = now;
    if (rec.instance.status !== 'Running') return;
    const cores = Number(rec.instance.config['limits.cpu'] ?? '1') || 1;
    const load = 0.05 + Math.random() * 0.35;
    rec.cpuNs += dt * 1e9 * cores * load;
    const burst = Math.random() < 0.1 ? 8 : 1;
    rec.rx += Math.round(dt * rec.rate * (0.6 + Math.random()) * burst);
    rec.tx += Math.round(dt * rec.rate * 1.6 * (0.6 + Math.random()) * burst);
    rec.diskUsage += Math.round(dt * 2048 * Math.random());
  }

  async getServer(): Promise<IncusServer> {
    return {
      api_extensions: ['instances_rebuild', 'explicit_trust_token'],
      api_status: 'stable',
      api_version: '1.0',
      auth: 'trusted',
      environment: {
        server_name: `mock-${this.scope}`,
        server_version: '6.0.0-mock',
        architectures: ['x86_64', 'i686'],
        kernel: 'Linux',
        kernel_version: '6.8.0-mock',
        os_name: 'Debian GNU/Linux',
        os_version: '12',
        storage: 'zfs',
      },
    };
  }

  async getResources(): Promise<IncusResources> {
    const names = await redis.smembers(`mock:incus:${this.scope}:names`);
    let used = 2 * 1024 ** 3;
    for (const n of names) {
      const raw = await redis.get(this.key(n));
      if (!raw) continue;
      const rec = JSON.parse(raw) as MockRecord;
      if (rec.instance.status === 'Running') used += parseSize(rec.instance.config['limits.memory'], 512 * 1024 ** 2) * 0.5;
    }
    // 负载随时间缓慢波动，便于开发时观察界面变化
    const wave = Math.sin(Date.now() / 600_000);
    return {
      cpu: {
        total: 32,
        architecture: 'x86_64',
        sockets: [
          {
            name: 'AMD EPYC 7B13 64-Core Processor (mock)',
            vendor: 'AuthenticAMD',
            cores: Array.from({ length: 16 }, () => ({ threads: [{}, {}], frequency: 2450 })),
            frequency: 2450,
            frequency_turbo: 3500,
          },
        ],
      },
      memory: { total: 128 * 1024 ** 3, used: Math.round(used) },
      network: {
        cards: [
          {
            vendor: 'Intel Corporation',
            product: 'Ethernet Controller X710 for 10GbE SFP+',
            driver: 'i40e',
            ports: [
              { id: 'eth0', link_detected: true, link_speed: 10000, port_type: 'fibre' },
              { id: 'eth1', link_detected: false, link_speed: 0, port_type: 'fibre' },
            ],
          },
        ],
      },
      storage: {
        disks: [
          { id: 'nvme0n1', model: 'SAMSUNG MZQL21T9HCJR', type: 'nvme', size: 1920383410176, rpm: 0 },
          { id: 'nvme1n1', model: 'SAMSUNG MZQL21T9HCJR', type: 'nvme', size: 1920383410176, rpm: 0 },
        ],
      },
      system: { vendor: 'Supermicro', product: 'AS -1114S-WTRT', type: 'physical' },
      load: { processes: 412, average_1_min: 1.8 + wave, average_5_min: 1.6 + wave * 0.6, average_10_min: 1.5 + wave * 0.3 },
    };
  }

  private volumesKey(pool: string) {
    return `mock:incus:${this.scope}:volumes:${pool}`;
  }

  async createVolume(pool: string, req: IncusVolumeCreate): Promise<void> {
    if (!(await this.listStoragePools()).some((p) => p.name === pool)) throw new IncusError('Storage pool not found', 404);
    if (await redis.hexists(this.volumesKey(pool), req.name)) throw new IncusError('Volume by that name already exists', 409);
    await sleep(300);
    await redis.hset(this.volumesKey(pool), req.name, JSON.stringify(req));
  }

  async deleteVolume(pool: string, name: string): Promise<void> {
    if (!(await redis.hexists(this.volumesKey(pool), name))) throw new IncusError('Storage volume not found', 404);
    await redis.hdel(this.volumesKey(pool), name);
  }

  /** 网卡计数器：速率按正弦缓慢变化，计数器单调递增（对时间积分） */
  async getNetworkState(name: string): Promise<IncusNetworkState> {
    if (name !== 'eth0') return { state: 'down', counters: { bytes_received: 0, bytes_sent: 0 } };
    const t = Date.now() / 1000 - 1.7e9;
    const integral = (base: number, amp: number, period: number) => Math.round(base * t - amp * period * Math.cos(t / period));
    return {
      state: 'up',
      mtu: 1500,
      counters: { bytes_received: integral(12e6, 9e6, 90) + 1e12, bytes_sent: integral(28e6, 20e6, 150) + 1e12 },
    };
  }

  private poolsKey() {
    return `mock:incus:${this.scope}:pools`;
  }

  async listStoragePools(): Promise<IncusStoragePool[]> {
    const raw = await redis.hgetall(this.poolsKey());
    const pools = Object.values(raw).map((v) => JSON.parse(v) as IncusStoragePool);
    if (!pools.some((p) => p.name === 'default')) {
      pools.unshift({ name: 'default', driver: 'btrfs', status: 'Created', description: '', config: { size: '200GiB', source: '/var/lib/incus/disks/default.img' }, used_by: [] });
    }
    return pools;
  }

  async createStoragePool(req: IncusStoragePoolCreate): Promise<void> {
    if ((await this.listStoragePools()).some((p) => p.name === req.name)) throw new IncusError('Storage pool already exists', 409);
    await sleep(600);
    const pool: IncusStoragePool = { name: req.name, driver: req.driver, status: 'Created', description: req.description ?? '', config: req.config, used_by: [] };
    await redis.hset(this.poolsKey(), req.name, JSON.stringify(pool));
  }

  async deleteStoragePool(name: string): Promise<void> {
    if (!(await redis.hexists(this.poolsKey(), name))) throw new IncusError('Storage pool not found', 404);
    await redis.hdel(this.poolsKey(), name);
  }

  async getStoragePool(pool: string): Promise<IncusStoragePool> {
    const found = (await this.listStoragePools()).find((p) => p.name === pool);
    if (!found) throw new IncusError('Storage pool not found', 404);
    return found;
  }

  async getStoragePoolResources(): Promise<IncusStoragePoolResources> {
    const names = await redis.smembers(`mock:incus:${this.scope}:names`);
    let used = 20 * 1024 ** 3;
    for (const n of names) {
      const raw = await redis.get(this.key(n));
      if (raw) used += (JSON.parse(raw) as MockRecord).diskUsage;
    }
    return { space: { total: 2 * 1024 ** 4, used } };
  }

  private networksKey() {
    return `mock:incus:${this.scope}:networks`;
  }

  async createNetwork(req: IncusNetworkCreate): Promise<void> {
    if (await redis.hexists(this.networksKey(), req.name)) throw new IncusError('Network already exists', 409);
    const network: IncusNetwork = { name: req.name, type: req.type, managed: true, status: 'Created', config: req.config };
    await redis.hset(this.networksKey(), req.name, JSON.stringify(network));
  }

  async deleteNetwork(name: string): Promise<void> {
    if (!(await redis.hexists(this.networksKey(), name))) throw new IncusError('Network not found', 404);
    await redis.hdel(this.networksKey(), name);
  }

  async getNetwork(name: string): Promise<IncusNetwork> {
    const created = (await redis.hgetall(this.networksKey()))[name];
    if (created) return JSON.parse(created) as IncusNetwork;
    return {
      name,
      type: 'bridge',
      managed: true,
      status: 'Created',
      config: { 'ipv4.address': `10.${this.subnetOctet}.0.1/24`, 'ipv4.nat': 'true', 'ipv6.address': 'none' },
    };
  }

  async listInstances(): Promise<IncusInstanceFull[]> {
    const names = await redis.smembers(`mock:incus:${this.scope}:names`);
    const out: IncusInstanceFull[] = [];
    for (const n of names) {
      try {
        const rec = await this.load(n);
        this.tick(rec);
        await this.save(rec);
        out.push({ ...rec.instance, state: this.buildState(rec) });
      } catch {
        /* 已删除 */
      }
    }
    return out;
  }

  async getInstance(name: string): Promise<IncusInstance> {
    return (await this.load(name)).instance;
  }

  private buildState(rec: MockRecord): IncusInstanceState {
    const running = rec.instance.status === 'Running';
    const memLimit = parseSize(rec.instance.config['limits.memory'], 512 * 1024 ** 2);
    const nic = rec.instance.devices.eth0 ?? {};
    const ipv4 = nic['ipv4.address'] ?? (rec.instance.config['user.paledove.public_ip'] || '');
    return {
      status: rec.instance.status,
      status_code: running ? 103 : 102,
      disk: { root: { usage: rec.diskUsage, total: parseSize(rec.instance.devices.root?.size, 10 * 1024 ** 3) } },
      memory: {
        usage: running ? Math.round(memLimit * (0.25 + Math.random() * 0.3)) : 0,
        usage_peak: running ? Math.round(memLimit * 0.7) : 0,
        total: memLimit,
        swap_usage: 0,
        swap_usage_peak: 0,
      },
      network: running
        ? {
            eth0: {
              addresses: [
                ...(ipv4 ? [{ family: 'inet' as const, address: ipv4, netmask: '24', scope: 'global' }] : []),
                {
                  family: 'inet6',
                  address: `fd42:${this.subnetOctet.toString(16)}::${rec.instance.name.length.toString(16)}`,
                  netmask: '64',
                  scope: 'global',
                },
              ],
              counters: { bytes_received: rec.rx, bytes_sent: rec.tx, packets_received: 0, packets_sent: 0 },
              hwaddr: nic.hwaddr ?? '00:16:3e:00:00:00',
              host_name: `veth${rec.instance.name.slice(-6)}`,
              mtu: 1500,
              state: 'up',
              type: 'broadcast',
            },
          }
        : null,
      pid: running ? 1000 + rec.instance.name.length : 0,
      processes: running ? 20 + Math.floor(Math.random() * 30) : 0,
      cpu: { usage: Math.round(rec.cpuNs) },
    };
  }

  async getInstanceState(name: string): Promise<IncusInstanceState> {
    const rec = await this.load(name);
    this.tick(rec);
    await this.save(rec);
    return this.buildState(rec);
  }

  async instanceExists(name: string): Promise<boolean> {
    return (await redis.exists(this.key(name))) === 1;
  }

  async startMigration(name: string): Promise<{ operation: string; secrets: Record<string, string> }> {
    const rec = await this.load(name);
    const id = randomUUID();
    // 模拟环境中由目标「宿主机」按操作 id 读取这份记录，相当于传输了磁盘
    await redis.set(`mock:migration:${id}`, JSON.stringify(rec), 'EX', 3600);
    return { operation: `/1.0/operations/${id}`, secrets: { control: 'mock', fs: 'mock' } };
  }

  async createInstance(req: IncusInstanceCreate): Promise<void> {
    if (await this.instanceExists(req.name)) throw new IncusError('Instance already exists', 409);
    if (req.source.type === 'migration') {
      const id = req.source.operation.split('/').pop() ?? '';
      const raw = await redis.get(`mock:migration:${id}`);
      if (!raw) throw new IncusError('Migration source not found', 404);
      await sleep(3000);
      // 用于测试回滚：地址含 failmigrate 的模拟宿主机拒绝迁入
      if (this.scope.includes('failmigrate')) throw new IncusError('Mock migration failure', 500);
      const src = JSON.parse(raw) as MockRecord;
      const rec: MockRecord = {
        ...src,
        instance: { ...src.instance, name: req.name, status: 'Stopped', status_code: 102, config: req.config, devices: req.devices, profiles: req.profiles },
        lastTick: Date.now(),
      };
      await this.save(rec);
      await redis.del(`mock:migration:${id}`);
      return;
    }
    const image = req.source;
    await sleep(req.type === 'virtual-machine' ? 4000 : 2500);
    const rec: MockRecord = {
      instance: {
        name: req.name,
        type: req.type,
        status: req.start ? 'Running' : 'Stopped',
        status_code: req.start ? 103 : 102,
        description: req.description ?? '',
        architecture: 'x86_64',
        config: { ...req.config, 'image.description': image.alias },
        devices: req.devices,
        profiles: req.profiles,
        ephemeral: false,
        stateful: false,
        created_at: new Date().toISOString(),
      },
      snapshots: [],
      cpuNs: 0,
      rx: 0,
      tx: 0,
      diskUsage: 600 * 1024 ** 2,
      lastTick: Date.now(),
      rate: 5_000 + Math.random() * 60_000,
    };
    await this.save(rec);
  }

  async modifyInstance(name: string, mutate: (inst: IncusInstance) => void): Promise<void> {
    const rec = await this.load(name);
    mutate(rec.instance);
    await this.save(rec);
  }

  async setState(name: string, action: 'start' | 'stop' | 'restart', opts: { force?: boolean } = {}): Promise<void> {
    const rec = await this.load(name);
    this.tick(rec);
    await sleep(opts.force ? 300 : 1200);
    if (action === 'start' && rec.instance.status === 'Running') throw new IncusError('The instance is already running', 400);
    if (action === 'stop' && rec.instance.status !== 'Running') throw new IncusError('The instance is already stopped', 400);
    const running = action !== 'stop';
    rec.instance.status = running ? 'Running' : 'Stopped';
    rec.instance.status_code = running ? 103 : 102;
    // 网卡重建后计数器清零（与真实 Incus 行为一致）
    rec.rx = 0;
    rec.tx = 0;
    rec.lastTick = Date.now();
    await this.save(rec);
  }

  async deleteInstance(name: string): Promise<void> {
    const rec = await this.load(name);
    if (rec.instance.status === 'Running') throw new IncusError('Instance is running', 400);
    await sleep(500);
    await redis.del(this.key(name));
    await redis.srem(`mock:incus:${this.scope}:names`, name);
  }

  async renameInstance(name: string, newName: string): Promise<void> {
    const rec = await this.load(name);
    if (rec.instance.status === 'Running') throw new IncusError('Renaming of running instance not allowed', 400);
    if (await redis.exists(this.key(newName))) throw new IncusError('Name already in use', 409);
    await redis.del(this.key(name));
    await redis.srem(`mock:incus:${this.scope}:names`, name);
    rec.instance.name = newName;
    await this.save(rec);
  }

  async rebuildInstance(name: string, source: IncusImageSource): Promise<void> {
    const rec = await this.load(name);
    if (rec.instance.status === 'Running') throw new IncusError('Instance must be stopped to be rebuilt', 400);
    await sleep(3000);
    rec.instance.config['image.description'] = source.alias;
    rec.diskUsage = 600 * 1024 ** 2;
    await this.save(rec);
  }

  async listSnapshots(name: string): Promise<string[]> {
    return (await this.load(name)).snapshots;
  }

  async createSnapshot(name: string, snapshot: string): Promise<void> {
    const rec = await this.load(name);
    if (rec.snapshots.includes(snapshot)) throw new IncusError('Snapshot already exists', 409);
    await sleep(1000);
    rec.snapshots.push(snapshot);
    await this.save(rec);
  }

  async deleteSnapshot(name: string, snapshot: string): Promise<void> {
    const rec = await this.load(name);
    if (!rec.snapshots.includes(snapshot)) throw new IncusError('Snapshot not found', 404);
    rec.snapshots = rec.snapshots.filter((s) => s !== snapshot);
    await this.save(rec);
  }

  async restoreSnapshot(name: string, snapshot: string): Promise<void> {
    const rec = await this.load(name);
    if (!rec.snapshots.includes(snapshot)) throw new IncusError('Snapshot not found', 404);
    await sleep(1500);
  }

  async exec(name: string, command: string[]): Promise<ExecResult> {
    const rec = await this.load(name);
    if (rec.instance.status !== 'Running') throw new IncusError('Instance is not running', 400);
    await sleep(300);
    return { exitCode: 0, stdout: `mock exec: ${command.join(' ')}\n`, stderr: '' };
  }

  /** 模拟终端：回显输入，支持几个常用命令，便于在没有 Incus 的环境下调试网页终端 */
  async openConsole(name: string, type: 'console' | 'vga', opts: TerminalOptions): Promise<TerminalSession> {
    if (type === 'vga') throw new IncusError('Mock nodes do not provide a graphical display', 400);
    return this.openTerminal(name, opts);
  }

  async openTerminal(name: string, opts: TerminalOptions): Promise<TerminalSession> {
    const rec = await this.load(name);
    if (rec.instance.status !== 'Running') throw new IncusError('Instance is not running', 400);
    const prompt = `\x1b[1;32mroot@${name}\x1b[0m:\x1b[1;34m~\x1b[0m# `;
    let size = { cols: opts.cols, rows: opts.rows };
    let line = '';
    let closed = false;
    const out = (s: string) => !closed && opts.onData(Buffer.from(s, 'utf8'));
    const exit = () => {
      if (closed) return;
      out('logout\r\n');
      closed = true;
      opts.onExit();
    };
    const run = (cmd: string) => {
      const [bin = ''] = cmd.split(/\s+/);
      const results: Record<string, () => string> = {
        hostname: () => name,
        whoami: () => 'root',
        pwd: () => '/root',
        date: () => new Date().toString(),
        'uname -a': () => `Linux ${name} 6.8.0-mock #1 SMP x86_64 GNU/Linux`,
        'stty size': () => `${size.rows} ${size.cols}`,
        clear: () => '\x1b[2J\x1b[H',
      };
      if (!cmd) return '';
      const hit = results[cmd] ?? results[bin];
      if (hit) return bin === 'clear' ? hit() : `${hit()}\r\n`;
      return `-bash: ${bin}: command not found\r\n`;
    };
    setTimeout(() => out(`Welcome to PaleDove mock shell (${name})\r\n\r\n${prompt}`), 100);
    return {
      write: (input) => {
        for (const ch of input.toString()) {
          if (closed) return;
          if (ch === '\r') {
            const cmd = line.trim();
            line = '';
            out('\r\n');
            if (cmd === 'exit' || cmd === 'logout') return exit();
            out(run(cmd) + prompt);
          } else if (ch === '\x7f' || ch === '\b') {
            if (line) {
              line = line.slice(0, -1);
              out('\b \b');
            }
          } else if (ch === '\x03') {
            line = '';
            out(`^C\r\n${prompt}`);
          } else if (ch === '\x04') {
            if (!line) exit();
          } else if (ch >= ' ') {
            line += ch;
            out(ch);
          }
        }
      },
      resize: (cols, rows) => {
        size = { cols, rows };
      },
      close: () => {
        closed = true;
      },
    };
  }

  async pushFile(name: string, path: string, content: string | Buffer): Promise<void> {
    await this.load(name);
    await redis.set(`mock:incus:${this.scope}:file:${name}:${path}`, content.toString());
  }

  async joinWithToken(): Promise<void> {
    await sleep(200);
  }
}

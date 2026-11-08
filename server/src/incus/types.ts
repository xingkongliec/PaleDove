/** Incus REST API 中本项目用到的数据结构（仅包含需要的字段） */

export type IncusInstanceType = 'container' | 'virtual-machine';
export type IncusDevice = Record<string, string>;
export type IncusDevices = Record<string, IncusDevice>;
export type IncusConfig = Record<string, string>;

export interface IncusImageSource {
  type: 'image';
  alias: string;
  server: string;
  protocol: string;
  mode?: 'pull';
}

/** 迁移源：目标宿主机从源宿主机的迁移操作拉取实例（pull 模式，数据直接在两台宿主机之间传输） */
export interface IncusMigrationSource {
  type: 'migration';
  mode: 'pull';
  /** 源宿主机上迁移操作的完整地址，如 https://203.0.113.10:8443/1.0/operations/<id> */
  operation: string;
  /** 源宿主机的服务端证书（PEM），目标宿主机用来校验连接 */
  certificate: string;
  secrets: Record<string, string>;
}

export interface IncusInstanceCreate {
  name: string;
  type: IncusInstanceType;
  description?: string;
  source: IncusImageSource | IncusMigrationSource;
  config: IncusConfig;
  devices: IncusDevices;
  profiles: string[];
  start?: boolean;
}

export interface IncusInstance {
  name: string;
  type: IncusInstanceType;
  status: string;
  status_code: number;
  description: string;
  architecture: string;
  config: IncusConfig;
  devices: IncusDevices;
  expanded_config?: IncusConfig;
  expanded_devices?: IncusDevices;
  profiles: string[];
  ephemeral: boolean;
  stateful: boolean;
  created_at: string;
  last_used_at?: string;
  location?: string;
  project?: string;
}

export interface IncusNetworkAddress {
  family: 'inet' | 'inet6';
  address: string;
  netmask: string;
  scope: string;
}

export interface IncusInstanceState {
  status: string;
  status_code: number;
  disk: Record<string, { usage: number; total?: number }> | null;
  memory: {
    usage: number;
    usage_peak: number;
    total?: number;
    swap_usage: number;
    swap_usage_peak: number;
  };
  network: Record<
    string,
    {
      addresses: IncusNetworkAddress[];
      counters: {
        bytes_received: number;
        bytes_sent: number;
        packets_received: number;
        packets_sent: number;
      };
      hwaddr: string;
      host_name: string;
      mtu: number;
      state: string;
      type: string;
    }
  > | null;
  pid: number;
  processes: number;
  cpu: { usage: number; allocated_time?: number };
}

export interface IncusInstanceFull extends IncusInstance {
  state: IncusInstanceState | null;
}

export interface IncusServer {
  api_extensions: string[];
  api_status: string;
  api_version: string;
  auth: 'trusted' | 'untrusted';
  environment?: {
    server_name: string;
    server_version: string;
    /** 宿主机支持的架构，第一个为本机架构（如 x86_64、aarch64） */
    architectures?: string[];
    kernel: string;
    kernel_version: string;
    os_name?: string;
    os_version?: string;
    storage?: string;
    certificate?: string;
    certificate_fingerprint?: string;
  };
}

/** GET /1.0/resources（只列出面板用到的字段，旧版本可能缺少部分字段） */
export interface IncusResources {
  cpu: {
    total: number;
    architecture?: string;
    sockets: {
      name: string;
      vendor?: string;
      cores: { threads?: unknown[]; frequency?: number }[];
      frequency?: number;
      frequency_turbo?: number;
    }[];
  };
  memory: { total: number; used: number };
  gpu?: { cards?: { vendor?: string; product?: string; driver?: string }[] };
  network?: {
    cards?: {
      vendor?: string;
      product?: string;
      driver?: string;
      ports?: { id: string; link_detected?: boolean; link_speed?: number; port_type?: string }[];
    }[];
  };
  storage?: {
    disks?: { id: string; model?: string; type?: string; size?: number; rpm?: number; removable?: boolean; read_only?: boolean }[];
  };
  system?: { vendor?: string; product?: string; type?: string };
  /** resources_load 扩展：系统负载 */
  load?: { processes?: number; average_1_min?: number; average_5_min?: number; average_10_min?: number };
}

export interface IncusVolumeCreate {
  name: string;
  content_type: 'filesystem' | 'block';
  description?: string;
  config: IncusConfig;
}

/** GET /1.0/networks/{name}/state */
export interface IncusNetworkState {
  state?: string;
  mtu?: number;
  counters?: { bytes_received?: number; bytes_sent?: number; packets_received?: number; packets_sent?: number };
}

export interface IncusStoragePool {
  name: string;
  driver: string;
  status: string;
  description?: string;
  config: IncusConfig;
  used_by?: string[];
}

export interface IncusStoragePoolCreate {
  name: string;
  driver: string;
  description?: string;
  config: IncusConfig;
}

export interface IncusStoragePoolResources {
  space: { used: number; total: number };
}

export interface IncusNetworkCreate {
  name: string;
  type: 'bridge';
  description?: string;
  config: IncusConfig;
}

export interface IncusNetwork {
  name: string;
  type: string;
  managed: boolean;
  status?: string;
  config: IncusConfig;
}

export interface IncusOperation {
  id: string;
  class: string;
  description: string;
  status: string;
  status_code: number;
  err: string;
  metadata: Record<string, unknown> | null;
  resources: Record<string, string[]> | null;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** 交互式终端会话（网页终端） */
export interface TerminalSession {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface TerminalOptions {
  cols: number;
  rows: number;
  /** 终端输出（原始字节，可能包含不完整的 UTF-8 序列） */
  onData: (data: Buffer) => void;
  /** 会话结束（shell 退出或连接断开）；reason 为异常原因 */
  onExit: (reason?: string) => void;
}

export interface IncusApi {
  readonly endpoint: string;
  getServer(): Promise<IncusServer>;
  getResources(): Promise<IncusResources>;
  getStoragePool(pool: string): Promise<IncusStoragePool>;
  getStoragePoolResources(pool: string): Promise<IncusStoragePoolResources>;
  listStoragePools(): Promise<IncusStoragePool[]>;
  createStoragePool(req: IncusStoragePoolCreate): Promise<void>;
  deleteStoragePool(name: string): Promise<void>;
  getNetwork(name: string): Promise<IncusNetwork>;
  createNetwork(req: IncusNetworkCreate): Promise<void>;
  deleteNetwork(name: string): Promise<void>;
  getNetworkState(name: string): Promise<IncusNetworkState>;
  /** 在存储池中创建自定义卷（容器用 filesystem，虚拟机用 block） */
  createVolume(pool: string, req: IncusVolumeCreate): Promise<void>;
  deleteVolume(pool: string, name: string): Promise<void>;

  listInstances(): Promise<IncusInstanceFull[]>;
  getInstance(name: string): Promise<IncusInstance>;
  getInstanceState(name: string): Promise<IncusInstanceState>;
  instanceExists(name: string): Promise<boolean>;
  createInstance(req: IncusInstanceCreate): Promise<void>;
  /** 在源宿主机上发起迁移（含快照），返回迁移操作的路径与密钥；操作在目标宿主机拉取完成后结束 */
  startMigration(name: string): Promise<{ operation: string; secrets: Record<string, string> }>;
  /** 读取 → 修改 → 写回（PUT，带 ETag 校验），可用于增删设备 */
  modifyInstance(name: string, mutate: (inst: IncusInstance) => void): Promise<void>;
  setState(name: string, action: 'start' | 'stop' | 'restart', opts?: { force?: boolean; timeout?: number }): Promise<void>;
  deleteInstance(name: string): Promise<void>;
  /** 重命名（实例需已停止） */
  renameInstance(name: string, newName: string): Promise<void>;
  rebuildInstance(name: string, source: IncusImageSource): Promise<void>;

  listSnapshots(name: string): Promise<string[]>;
  createSnapshot(name: string, snapshot: string): Promise<void>;
  deleteSnapshot(name: string, snapshot: string): Promise<void>;
  restoreSnapshot(name: string, snapshot: string): Promise<void>;

  exec(name: string, command: string[], opts?: { env?: Record<string, string>; timeoutSec?: number }): Promise<ExecResult>;
  pushFile(name: string, path: string, content: string | Buffer, opts?: { mode?: string; uid?: number; gid?: number }): Promise<void>;
  /** 以 root 打开交互式 shell（虚拟机需要 incus-agent） */
  openTerminal(name: string, opts: TerminalOptions): Promise<TerminalSession>;

  /** 使用信任令牌把面板证书加入节点信任列表 */
  joinWithToken(token: string): Promise<void>;
}

export class IncusError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'IncusError';
  }

  get isNotFound(): boolean {
    return this.statusCode === 404;
  }
}

/** 产品在某台宿主机上的设置：系统盘存储池（null 为宿主机默认）与流量倍率 */
export interface ProductNodeOption {
  storagePool: string | null;
  trafficMultiplier: number;
}

export const DEFAULT_NODE_OPTION: ProductNodeOption = { storagePool: null, trafficMultiplier: 1 };

/** 流量倍率的取值范围 */
export const TRAFFIC_MULTIPLIER_MIN = 0.1;
export const TRAFFIC_MULTIPLIER_MAX = 100;

/** 产品保存的宿主机设置（JSON，以宿主机 ID 为键）→ 某台宿主机的设置，缺省值补齐 */
export function productNodeOption(options: unknown, nodeId: number): ProductNodeOption {
  const raw = options && typeof options === 'object' ? (options as Record<string, unknown>)[String(nodeId)] : null;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_NODE_OPTION };
  const o = raw as Record<string, unknown>;
  const m = Number(o.trafficMultiplier);
  return {
    storagePool: typeof o.storagePool === 'string' && o.storagePool ? o.storagePool : null,
    trafficMultiplier: Number.isFinite(m) && m >= TRAFFIC_MULTIPLIER_MIN && m <= TRAFFIC_MULTIPLIER_MAX ? m : 1,
  };
}

/** 按倍率计算实例流量（GB）；0 表示不限，倍率不改变 */
export const scaleTraffic = (traffic: number, multiplier: number) => (traffic > 0 ? Math.max(1, Math.round(traffic * multiplier)) : 0);

/** 倍率显示：1 → 1x，1.5 → 1.5x */
export const formatMultiplier = (m: number) => `${+m.toFixed(2)}x`;

/** 每个实例最多分配的公网 IPv6 数量 */
export const IPV6_COUNT_MAX = 16;

/** 实例的公网 IPv6 以逗号分隔保存（可有多个），解析为地址数组 */
export function parseIpv6List(v: string | null | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ───────── 启动设置 ─────────

/** 宿主机（Incus）启动时是否自动开机：始终 / 恢复之前的状态 / 不自动开机 */
export const BOOT_AUTOSTART_MODES = ['ALWAYS', 'LAST_STATE', 'NEVER'] as const;
export type BootAutostart = (typeof BOOT_AUTOSTART_MODES)[number];

/** 产品的启动设置，对应实例的 boot.* 配置；null 表示使用 Incus 默认值 */
export interface BootOptions {
  autostart: BootAutostart;
  /** boot.autostart.delay：本实例启动后等待多少秒再启动下一个 */
  delay: number | null;
  /** boot.autostart.priority：数值越大越先启动 */
  priority: number | null;
  /** boot.stop.priority：数值越大越先关机 */
  stopPriority: number | null;
  /** boot.host_shutdown_timeout：宿主机关机时等待实例关机的秒数，超时强制关机 */
  shutdownTimeout: number | null;
}

export const DEFAULT_BOOT_OPTIONS: BootOptions = { autostart: 'ALWAYS', delay: null, priority: null, stopPriority: null, shutdownTimeout: null };

/** 启动设置数值的取值范围 */
export const BOOT_LIMITS = { delay: 3600, priority: 100, stopPriority: 100, shutdownTimeout: 3600 } as const;

/** 保存的启动设置（JSON）→ 完整的启动设置，非法值使用默认值 */
export function bootOptions(raw: unknown): BootOptions {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOOT_OPTIONS };
  const o = raw as Record<string, unknown>;
  const int = (k: keyof typeof BOOT_LIMITS) => {
    const v = o[k];
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= BOOT_LIMITS[k] ? v : null;
  };
  return {
    autostart: BOOT_AUTOSTART_MODES.includes(o.autostart as BootAutostart) ? (o.autostart as BootAutostart) : 'ALWAYS',
    delay: int('delay'),
    priority: int('priority'),
    stopPriority: int('stopPriority'),
    shutdownTimeout: int('shutdownTimeout'),
  };
}

// ───────── 资源限制 ─────────

/** CPU 优先级（limits.cpu.priority）取值 0~10，10 为默认（最高） */
export const CPU_PRIORITY_MAX = 10;

/** 进程数限制的下限：太小会导致系统无法启动 */
export const PROCESS_LIMIT_MIN = 64;

/**
 * 宿主机 Agent 的上报协议版本：2 起支持限制虚拟机的 CPU 配额与优先级；3 起为 Go 版，上报完整的宿主机状态。
 * 低于此版本时面板提示升级（重新安装）。
 */
export const HOST_AGENT_VERSION = 3;
/** 面板附带的 Agent 发布版本（构建 agent 时写入二进制），用于显示「最新 / 可更新」 */
export const HOST_AGENT_RELEASE = '0.7.2';

/** 比较 Agent 发布版本；开发版或非法版本返回 null，避免误判升级或降级。 */
export function compareHostAgentReleases(a: string, b: string): number | null {
  const pattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;
  const left = pattern.exec(a);
  const right = pattern.exec(b);
  if (!left || !right) return null;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return Math.sign(difference);
  }
  if (left[4] === right[4]) return 0;
  if (!left[4]) return 1;
  if (!right[4]) return -1;
  const lp = left[4].split('.');
  const rp = right[4].split('.');
  for (let i = 0; i < Math.max(lp.length, rp.length); i++) {
    if (lp[i] === rp[i]) continue;
    if (lp[i] === undefined) return -1;
    if (rp[i] === undefined) return 1;
    const ln = /^\d+$/.test(lp[i]);
    const rn = /^\d+$/.test(rp[i]);
    if (ln && rn) return Math.sign(Number(lp[i]) - Number(rp[i]));
    if (ln !== rn) return ln ? -1 : 1;
    return lp[i] < rp[i] ? -1 : 1;
  }
  return 0;
}

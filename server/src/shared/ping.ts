// 节点测试：宿主机 Agent 按配置向拨测目标发送 ICMP Ping（无权限时退回 TCP 连接测速），
// 面板按省份汇总后在购买页的「节点测试」里展示中国地图、三网概览与节点列表。

/** 运营商：电信、联通、移动 */
export const PING_ISPS = ['CT', 'CU', 'CM'] as const;
export type PingIsp = (typeof PING_ISPS)[number];

/** 测试间隔：一小时一次 */
export const PING_INTERVAL_SEC = 3600;
/** 每个目标发送的探测次数 */
export const PING_COUNT = 4;

/** 省份：目标域名前缀、中文名、英文名 */
export const PING_PROVINCES = [
  ['bj', '北京', 'Beijing'],
  ['tj', '天津', 'Tianjin'],
  ['he', '河北', 'Hebei'],
  ['sx', '山西', 'Shanxi'],
  ['nm', '内蒙古', 'Inner Mongolia'],
  ['ln', '辽宁', 'Liaoning'],
  ['jl', '吉林', 'Jilin'],
  ['hl', '黑龙江', 'Heilongjiang'],
  ['sh', '上海', 'Shanghai'],
  ['js', '江苏', 'Jiangsu'],
  ['zj', '浙江', 'Zhejiang'],
  ['ah', '安徽', 'Anhui'],
  ['fj', '福建', 'Fujian'],
  ['jx', '江西', 'Jiangxi'],
  ['sd', '山东', 'Shandong'],
  ['ha', '河南', 'Henan'],
  ['hb', '湖北', 'Hubei'],
  ['hn', '湖南', 'Hunan'],
  ['gd', '广东', 'Guangdong'],
  ['gx', '广西', 'Guangxi'],
  ['hi', '海南', 'Hainan'],
  ['cq', '重庆', 'Chongqing'],
  ['sc', '四川', 'Sichuan'],
  ['gz', '贵州', 'Guizhou'],
  ['yn', '云南', 'Yunnan'],
  ['xz', '西藏', 'Tibet'],
  ['sn', '陕西', 'Shaanxi'],
  ['gs', '甘肃', 'Gansu'],
  ['qh', '青海', 'Qinghai'],
  ['nx', '宁夏', 'Ningxia'],
  ['xj', '新疆', 'Xinjiang'],
] as const;

export interface PingTarget {
  /** 如 gd-ct */
  id: string;
  name?: string;
  /** 省份中文名（与地图数据的省份短名一致） */
  province: string;
  provinceEn: string;
  isp: PingIsp;
  host: string;
  /** ICMP 不可用时 TCP 测速使用的端口 */
  port: number;
}

export interface ManagedPingTarget extends PingTarget { enabled: boolean }
export interface PingSettings {
  enabled: boolean;
  interval: number;
  count: number;
  targets: ManagedPingTarget[];
  /** null 表示沿用原有的节点拨测开关；管理对象后改为明确的节点列表。 */
  nodeIds: number[] | null;
}
export interface PingObjectDTO {
  id: number;
  name: string;
  region: string;
  enabled: boolean;
  nodeEnabled: boolean;
  online: boolean;
  testedAt: string | null;
}
export interface AdminPingSettingsDTO extends PingSettings {
  objects: PingObjectDTO[];
  available: Omit<PingObjectDTO, 'testedAt'>[];
}

/** 内置目标：31 个省份 × 三网，共 93 个 */
export const PING_TARGETS: PingTarget[] = PING_PROVINCES.flatMap(([code, zh, en]) =>
  PING_ISPS.map((isp) => ({ id: `${code}-${isp.toLowerCase()}`, province: zh, provinceEn: en, isp, host: `${code}-${isp.toLowerCase()}-v4.ip.zstaticcdn.com`, port: 80 })),
);

export const pingTarget = (id: string, targets: PingTarget[] = PING_TARGETS) => targets.find((t) => t.id === id);

/** 单个目标的测试结果：平均延迟（毫秒，全部超时为 null）与丢包率（%） */
export interface PingResultDTO {
  id: string;
  latency: number | null;
  loss: number;
}

/** 一台宿主机最近一次的测试结果 */
export interface NodePingDTO {
  /** 展示名：地区（同一地区有多台宿主机时带序号） */
  label: string;
  country: string;
  testedAt: string;
  /** icmp：ICMP Ping；tcp：没有原始套接字权限时按 TCP 连接耗时测速 */
  method: 'icmp' | 'tcp';
  results: PingResultDTO[];
  targets?: PingTarget[];
}

/** 延迟分档（地图与列表着色）：0 超时，1 >250，2 201-250，3 101-200，4 51-100，5 ≤50 */
export function latencyLevel(latency: number | null | undefined): 0 | 1 | 2 | 3 | 4 | 5 {
  if (latency == null) return 0;
  if (latency > 250) return 1;
  if (latency > 200) return 2;
  if (latency > 100) return 3;
  if (latency > 50) return 4;
  return 5;
}

export interface PingSummary {
  /** 按省份：三网结果与最低延迟 */
  provinces: Map<string, { province: string; best: number | null; reachable: number; total: number; byIsp: Partial<Record<PingIsp, PingResultDTO>> }>;
  /** 按运营商：最快的目标、可达数 / 总数、最慢的可达目标 */
  isps: Record<PingIsp, { fastest: { target: PingTarget; latency: number } | null; slowest: { target: PingTarget; latency: number } | null; reachable: number; total: number }>;
  reachable: number;
  total: number;
}

/** 汇总测试结果：地图按省份取最低延迟，三网概览按运营商统计 */
export function summarizePing(results: PingResultDTO[], targets: PingTarget[] = PING_TARGETS): PingSummary {
  const provinces: PingSummary['provinces'] = new Map();
  const isps = Object.fromEntries(PING_ISPS.map((i) => [i, { fastest: null, slowest: null, reachable: 0, total: 0 }])) as PingSummary['isps'];
  let reachable = 0;
  for (const r of results) {
    const target = pingTarget(r.id, targets);
    if (!target) continue;
    const p = provinces.get(target.province) ?? { province: target.province, best: null, reachable: 0, total: 0, byIsp: {} };
    const previous = p.byIsp[target.isp];
    if (!previous || (r.latency !== null && (previous.latency === null || r.latency < previous.latency))) p.byIsp[target.isp] = r;
    p.total++;
    const s = isps[target.isp];
    s.total++;
    if (r.latency != null) {
      p.reachable++;
      p.best = p.best === null ? r.latency : Math.min(p.best, r.latency);
      s.reachable++;
      reachable++;
      if (!s.fastest || r.latency < s.fastest.latency) s.fastest = { target, latency: r.latency };
      if (!s.slowest || r.latency > s.slowest.latency) s.slowest = { target, latency: r.latency };
    }
    provinces.set(target.province, p);
  }
  return { provinces, isps, reachable, total: results.length };
}

/** 目标列表的摘要：Agent 据此判断目标是否变化 */
export function pingTargetsHash(targets: PingTarget[] = PING_TARGETS, count = PING_COUNT): string {
  let h = 2166136261;
  for (const c of JSON.stringify([count, targets.map(t => [t.id, t.host, t.port, t.name ?? '', t.province, t.provinceEn, t.isp])])) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

// ───────── 交易市场上架拨测 ─────────
// 上架时宿主机 Agent 从实例对外的 IPv4（NAT 为宿主机公网 IP，独立 IPv4 为实例地址）向上面的目标 Ping 一次，
// 结果作为「上架前拨测快照」存档在商品上，买卖双方都能查看。

/** 超过这么多个省份无法 Ping 通时判定 IP 异常 */
export const MARKET_PING_MAX_FAILED_PROVINCES = 5;

/** 拨测结论：NORMAL 全部可达（IP 正常）；PARTIAL 部分目标超时；ABNORMAL 超过 5 个省份无法 Ping 通（IP 异常） */
export type MarketPingVerdict = 'NORMAL' | 'PARTIAL' | 'ABNORMAL';
export type MarketPingStatus = 'PENDING' | 'DONE' | 'FAILED';
/** 未能拨测的原因：agent 宿主机 Agent 不在线或版本过旧；timeout 超时未回传；noIpv4 实例没有 IPv4；start 独立 IPv4 实例无法开机；error Agent 报错 */
export type MarketPingReason = 'agent' | 'timeout' | 'noIpv4' | 'start' | 'error';
/** 发送方式：local 绑定本机地址；default 宿主机默认出口；spoof 以实例 IP 为源；spoof-l2 以实例 IP 与 MAC 为源；mock 模拟节点 */
export type MarketPingVia = 'local' | 'default' | 'spoof' | 'spoof-l2' | 'mock';

/**
 * 判定拨测结论：某个省份有目标（任一运营商）完全不通即计为「无法 Ping 通的省份」。
 * 全部目标可达为正常；无法 Ping 通的省份超过 5 个为异常；其余为部分超时。
 */
export function marketPingVerdict(results: PingResultDTO[], targets: PingTarget[] = PING_TARGETS): { verdict: MarketPingVerdict; failedProvinces: string[]; reachable: number; total: number } {
  const failed = new Set<string>();
  let reachable = 0;
  let total = 0;
  for (const r of results) {
    const target = pingTarget(r.id, targets);
    if (!target) continue;
    total++;
    if (r.latency == null) failed.add(target.province);
    else reachable++;
  }
  const failedProvinces = [...failed];
  const verdict: MarketPingVerdict = total > 0 && reachable === total ? 'NORMAL' : failedProvinces.length > MARKET_PING_MAX_FAILED_PROVINCES || reachable === 0 ? 'ABNORMAL' : 'PARTIAL';
  return { verdict, failedProvinces, reachable, total };
}

/** 商品卡片上的拨测摘要 */
export interface MarketPingSummaryDTO {
  status: MarketPingStatus;
  reason: MarketPingReason | null;
  requestedAt: string;
  testedAt: string | null;
  verdict: MarketPingVerdict | null;
  reachable: number;
  total: number;
  /** 无法 Ping 通的省份数 */
  failedProvinces: number;
  /** 三网最快（电信、移动、联通） */
  fastest: { isp: PingIsp; province: string; provinceEn: string; latency: number }[];
}

/** 拨测快照详情：摘要 + 全部目标结果 */
export interface MarketPingDTO extends MarketPingSummaryDTO {
  method: 'icmp' | 'tcp' | null;
  via: MarketPingVia | null;
  /** 实例类型对应的 IP 类型 */
  ipv4: 'NAT' | 'DEDICATED';
  results: PingResultDTO[];
  targets?: PingTarget[];
}

/**
 * 常用系统镜像（images.linuxcontainers.org 的 cloud 变体，带 cloud-init）。
 * 别名已对照官方镜像列表（streams/v1/images.json）核对；部分发行版官方只提供容器镜像（forVm: false）。
 * 初始化数据（seed）与管理后台“添加常用镜像”共用这份列表。
 * arm64：aarch64 上的情况（同样对照官方镜像列表）；不写时与 x86_64 相同，ct 为只有容器镜像，false 为没有 arm64 版本。
 * 顺序：同一系列放在一起，按资源占用从小到大排列（Alpine → Debian 系 → Arch → Ubuntu → RHEL 系 → …）；系列内旧版本在前，滚动 / 测试版（edge、testing、Tumbleweed）放在最后。
 */
export interface ImagePreset {
  name: string;
  family: string;
  alias: string;
  forVm: boolean;
  arm64?: 'ct' | false;
}

export const IMAGE_PRESETS: ImagePreset[] = [
  { name: 'Alpine 3.21', family: 'alpine', alias: 'alpine/3.21/cloud', forVm: true },
  { name: 'Alpine 3.22', family: 'alpine', alias: 'alpine/3.22/cloud', forVm: true },
  { name: 'Alpine 3.23', family: 'alpine', alias: 'alpine/3.23/cloud', forVm: true },
  { name: 'Alpine 3.24', family: 'alpine', alias: 'alpine/3.24/cloud', forVm: true },
  { name: 'Alpine edge', family: 'alpine', alias: 'alpine/edge/cloud', forVm: true },
  { name: 'Debian 12', family: 'debian', alias: 'debian/12/cloud', forVm: true },
  { name: 'Debian 13', family: 'debian', alias: 'debian/13/cloud', forVm: true },
  { name: 'Debian 14', family: 'debian', alias: 'debian/14/cloud', forVm: true },
  { name: 'Devuan 5', family: 'devuan', alias: 'devuan/daedalus/cloud', forVm: false },
  { name: 'Arch Linux', family: 'archlinux', alias: 'archlinux/cloud', forVm: true, arm64: false },
  { name: 'Ubuntu 22.04 LTS', family: 'ubuntu', alias: 'ubuntu/22.04/cloud', forVm: true },
  { name: 'Ubuntu 24.04 LTS', family: 'ubuntu', alias: 'ubuntu/24.04/cloud', forVm: true },
  { name: 'Ubuntu 26.04 LTS', family: 'ubuntu', alias: 'ubuntu/26.04/cloud', forVm: true },
  { name: 'Rocky Linux 8', family: 'rocky', alias: 'rockylinux/8/cloud', forVm: true, arm64: 'ct' },
  { name: 'Rocky Linux 9', family: 'rocky', alias: 'rockylinux/9/cloud', forVm: true, arm64: 'ct' },
  { name: 'Rocky Linux 10', family: 'rocky', alias: 'rockylinux/10/cloud', forVm: true, arm64: 'ct' },
  { name: 'AlmaLinux 8', family: 'almalinux', alias: 'almalinux/8/cloud', forVm: true, arm64: 'ct' },
  { name: 'AlmaLinux 9', family: 'almalinux', alias: 'almalinux/9/cloud', forVm: true, arm64: 'ct' },
  { name: 'AlmaLinux 10', family: 'almalinux', alias: 'almalinux/10/cloud', forVm: true, arm64: 'ct' },
  { name: 'CentOS Stream 9', family: 'centos', alias: 'centos/9-Stream/cloud', forVm: true, arm64: 'ct' },
  { name: 'CentOS Stream 10', family: 'centos', alias: 'centos/10-Stream/cloud', forVm: true, arm64: 'ct' },
  { name: 'Oracle Linux 8', family: 'oracle', alias: 'oracle/8/cloud', forVm: false },
  { name: 'Oracle Linux 9', family: 'oracle', alias: 'oracle/9/cloud', forVm: false },
  { name: 'Oracle Linux 10', family: 'oracle', alias: 'oracle/10/cloud', forVm: false },
  { name: 'openEuler 24.03 LTS', family: 'openeuler', alias: 'openeuler/24.03/cloud', forVm: true, arm64: 'ct' },
  { name: 'Fedora 43', family: 'fedora', alias: 'fedora/43/cloud', forVm: true },
  { name: 'Fedora 44', family: 'fedora', alias: 'fedora/44/cloud', forVm: true },
  { name: 'openSUSE Leap 16.0', family: 'opensuse', alias: 'opensuse/16.0/cloud', forVm: true },
  { name: 'openSUSE Tumbleweed', family: 'opensuse', alias: 'opensuse/tumbleweed/cloud', forVm: true },
  { name: 'Kali Linux', family: 'kali', alias: 'kali/cloud', forVm: false },
  { name: 'Linux Mint 22.3', family: 'mint', alias: 'mint/zena/cloud', forVm: false, arm64: false },
];

/** 某个架构可用的常用镜像（aarch64 去掉没有 arm64 版本的，只有容器镜像的不支持 KVM） */
export function presetsFor(arch: string): ImagePreset[] {
  if (arch !== 'aarch64') return IMAGE_PRESETS;
  return IMAGE_PRESETS.filter((p) => p.arm64 !== false).map((p) => (p.arm64 === 'ct' ? { ...p, forVm: false } : p));
}

/** 常用镜像的排序值（与列表顺序一致，间隔 10 方便在中间插入自定义镜像）；不是常用镜像时返回 null */
export function presetSortOrder(alias: string): number | null {
  const i = IMAGE_PRESETS.findIndex((p) => p.alias === alias);
  return i < 0 ? null : (i + 1) * 10;
}

/** 滚动更新或测试中的版本：不作为默认选择 */
export const isRollingImage = (name: string) => /\b(edge|testing|tumbleweed|rawhide|sid|unstable)\b/i.test(name);

/** 一组镜像（同一发行版或全部）里默认选中的：最新的稳定版本；全是滚动版时取最后一个 */
export function preferredImage<T extends { name: string }>(list: T[]): T | undefined {
  return [...list].reverse().find((i) => !isRollingImage(i.name)) ?? list[list.length - 1];
}

/** 宿主机保存的镜像列表（JSON）→ ID 数组；null / 无效值表示使用面板全部默认镜像 */
export function nodeImageIds(v: unknown): number[] | null {
  return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x > 0) : null;
}

/** Incus 报告的架构名统一成镜像架构；无法识别的架构原样保留（不会匹配任何镜像） */
export function normalizeArch(v: string | null | undefined): string | null {
  const arch = v?.trim();
  if (!arch) return null;
  if (arch.toLowerCase() === 'x86_64' || arch.toLowerCase() === 'amd64') return 'x86_64';
  if (arch.toLowerCase() === 'aarch64' || arch.toLowerCase() === 'arm64') return 'aarch64';
  return arch;
}

/** 宿主机是否提供某个镜像：在宿主机勾选的镜像中（未勾选为全部镜像），且架构一致（宿主机架构尚未读取时不限制） */
export const nodeAllowsImage = (node: { imageIds?: unknown; arch?: string | null }, image: { id: number; arch: string }) => {
  const ids = nodeImageIds(node.imageIds);
  return (ids === null || ids.includes(image.id)) && (!node.arch || node.arch === image.arch);
};

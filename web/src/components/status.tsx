import type {
  CaddyStatus,
  InstanceStatus,
  InstanceType,
  NodeStatus,
  PaymentStatus,
  SiteStatus,
  SuspendReason,
  TaskDTO,
  TaskStatus,
} from '../shared/index';
import {
  siAlmalinux,
  siAlpinelinux,
  siArchlinux,
  siCentos,
  siDebian,
  siDevuan,
  siFedora,
  siFreebsd,
  siGentoo,
  siKalilinux,
  siLinux,
  siLinuxmint,
  siManjaro,
  siNixos,
  siOpensuse,
  siOpenwrt,
  siRedhat,
  siRockylinux,
  siSuse,
  siUbuntu,
  siVoidlinux,
  type SimpleIcon,
} from 'simple-icons';
import type { CSSProperties } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/cn';
import { Badge, Tag, type Tone } from './ui/misc';

export const statusTone: Record<InstanceStatus, Tone> = {
  CREATING: 'neutral',
  RUNNING: 'success',
  STOPPED: 'neutral',
  REINSTALLING: 'neutral',
  MIGRATING: 'neutral',
  SUSPENDED: 'danger',
  ERROR: 'danger',
  DELETING: 'neutral',
  DELETED: 'neutral',
};

export function InstanceStatusBadge({
  status,
  reason,
  activeTask,
}: {
  status: InstanceStatus;
  reason?: SuspendReason | null;
  activeTask?: TaskDTO | null;
}) {
  const { t, L } = useI18n();
  if (activeTask && status !== 'CREATING' && status !== 'REINSTALLING' && status !== 'MIGRATING' && status !== 'DELETING') {
    return (
      <Badge tone="neutral" dot pulse>
        {t('status.taskRunning', { task: L.taskType[activeTask.type] })}
      </Badge>
    );
  }
  const busy = status === 'CREATING' || status === 'REINSTALLING' || status === 'MIGRATING' || status === 'DELETING';
  return (
    <Badge tone={statusTone[status]} dot pulse={busy}>
      {L.instanceStatus[status]}
      {/* 管理员封禁不再重复原因，到期、流量超额仍注明 */}
      {status === 'SUSPENDED' && reason && reason !== 'ADMIN' ? ` · ${L.suspendReason[reason]}` : ''}
    </Badge>
  );
}

export function TypeBadge({ type }: { type: InstanceType }) {
  const { L } = useI18n();
  return <Tag tone={type === 'KVM_IPV4' ? 'primary' : 'neutral'}>{L.instanceType[type]}</Tag>;
}

const taskTone: Record<TaskStatus, Tone> = { QUEUED: 'neutral', RUNNING: 'neutral', SUCCESS: 'success', FAILED: 'danger' };

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const { L } = useI18n();
  return (
    <Badge tone={taskTone[status]} dot pulse={status === 'RUNNING'}>
      {L.taskStatus[status]}
    </Badge>
  );
}

const nodeTone: Record<NodeStatus, Tone> = { PENDING: 'warning', ONLINE: 'success', OFFLINE: 'danger', UNKNOWN: 'neutral' };

export function NodeStatusBadge({ status }: { status: NodeStatus }) {
  const { L } = useI18n();
  return (
    <Badge tone={nodeTone[status]} dot pulse={status === 'PENDING'}>
      {L.nodeStatus[status]}
    </Badge>
  );
}

const caddyTone: Record<CaddyStatus, Tone> = { NONE: 'neutral', PENDING: 'warning', READY: 'success', ERROR: 'danger' };

export function CaddyStatusBadge({ status }: { status: CaddyStatus }) {
  const { L } = useI18n();
  return (
    <Badge tone={caddyTone[status]} dot pulse={status === 'PENDING'}>
      {L.caddyStatus[status]}
    </Badge>
  );
}

const siteTone: Record<SiteStatus, Tone> = { PENDING: 'warning', ACTIVE: 'success', ERROR: 'danger' };

export function SiteStatusBadge({ status }: { status: SiteStatus }) {
  const { L } = useI18n();
  return (
    <Badge tone={siteTone[status]} dot>
      {L.siteStatus[status]}
    </Badge>
  );
}

const paymentTone: Record<PaymentStatus, Tone> = { PENDING: 'warning', PAID: 'success', EXPIRED: 'neutral', FAILED: 'danger' };

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const { L } = useI18n();
  return (
    <Badge tone={paymentTone[status]} dot>
      {L.paymentStatus[status]}
    </Badge>
  );
}

/** 镜像 family（忽略大小写与非字母字符）对应的发行版标志，含常见别名 */
const OS_LOGOS: Record<string, SimpleIcon> = {
  debian: siDebian,
  devuan: siDevuan,
  ubuntu: siUbuntu,
  linuxmint: siLinuxmint,
  mint: siLinuxmint,
  kali: siKalilinux,
  kalilinux: siKalilinux,
  rocky: siRockylinux,
  rockylinux: siRockylinux,
  alma: siAlmalinux,
  almalinux: siAlmalinux,
  centos: siCentos,
  centosstream: siCentos,
  fedora: siFedora,
  rhel: siRedhat,
  redhat: siRedhat,
  alpine: siAlpinelinux,
  alpinelinux: siAlpinelinux,
  arch: siArchlinux,
  archlinux: siArchlinux,
  manjaro: siManjaro,
  opensuse: siOpensuse,
  suse: siSuse,
  gentoo: siGentoo,
  nixos: siNixos,
  void: siVoidlinux,
  voidlinux: siVoidlinux,
  openwrt: siOpenwrt,
  freebsd: siFreebsd,
  linux: siLinux,
};

/** 没有收录标志的发行版：用品牌色显示首字母 */
const OS_COLORS: Record<string, string> = {
  oracle: 'C74634',
  oraclelinux: 'C74634',
  openeuler: '002FA7',
  anolis: 'F05A28',
  opencloudos: '0052D9',
};

/** 标志本身是多色、图标库里只给了近乎黑色的发行版：改用标志里辨识度高的颜色 */
const LOGO_COLOR_OVERRIDE: Record<string, string> = {
  almalinux: '0069DA',
  centos: '932279',
  suse: '30BA78',
};

/** 颜色的相对亮度（0 黑 ~ 1 白） */
function luminance(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** 品牌色：浅色主题原样使用；太暗的颜色在深色主题下提亮，保证看得清（见 styles.css 的 .os-logo） */
function brandColors(hex: string) {
  const base = `#${hex}`;
  return { '--os': base, '--os-dark': luminance(hex) < 0.1 ? `color-mix(in srgb, ${base} 45%, white)` : base } as CSSProperties;
}

/** 发行版标识：品牌色的发行版标志（随构建打包，不依赖外部资源）；未收录标志的显示首字母 */
export function OsIcon({ family, className = 'size-8 text-xs' }: { family: string; className?: string }) {
  const key = family.toLowerCase().replace(/[^a-z]/g, '');
  const logo = OS_LOGOS[key];
  const hex = (logo && LOGO_COLOR_OVERRIDE[logo.slug]) ?? logo?.hex ?? OS_COLORS[key];
  return (
    <span
      aria-hidden
      style={hex ? brandColors(hex) : undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md border border-line bg-surface-2 font-semibold uppercase',
        hex ? 'os-logo' : 'text-fg-2',
        className,
      )}
    >
      {logo ? (
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-[58%]">
          <path d={logo.path} />
        </svg>
      ) : (
        family.slice(0, 1)
      )}
    </span>
  );
}

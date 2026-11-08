import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Meter } from '@base-ui/react/meter';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { Check, CircleAlert, CircleCheck, Copy, Eye, EyeOff, Inbox, Info, LoaderCircle, TriangleAlert } from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useLoadingWhileMounted } from '@/lib/loading';
import { toast } from '@/lib/toast';

// ───────────── 卡片 / 分节 ─────────────

export function Card({ className, children, ...rest }: ComponentProps<'div'>) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-line bg-surface', className)} {...rest}>
      {children}
    </div>
  );
}

/** 卡片标题栏：左侧标题（可带说明），右侧附加操作；icon 参数保留以兼容旧调用，不再渲染 */
export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5', className)}>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] leading-6 font-semibold text-fg">{title}</h3>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-3">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 text-[13px]">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('p-4 sm:p-5', className)}>{children}</div>;
}

/** 无边框分节：标题在外，内容自带边框（详情页“基本信息”等） */
export function Section({ title, extra, children, className }: { title: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0', className)}>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
        {extra && <div className="flex items-center gap-2 text-xs text-fg-3">{extra}</div>}
      </div>
      {children}
    </section>
  );
}

/** 创建页的表单分节卡片：序号 + 标题 + 说明，右上角可放附加操作 */
export function FormCard({
  step,
  title,
  description,
  extra,
  children,
  className,
}: {
  step?: number;
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('min-w-0 rounded-lg border border-line bg-surface', className)}>
      <header className="flex items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          {step != null && (
            <span className="tabular mt-px flex size-5 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-fg">
              {step}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="text-[15px] leading-5 font-semibold">{title}</h3>
            {description && <p className="mt-1 text-xs leading-relaxed text-fg-3">{description}</p>}
          </div>
        </div>
        {extra && <div className="flex shrink-0 items-center gap-2">{extra}</div>}
      </header>
      <div className="px-4 pt-4 pb-5 sm:px-5">{children}</div>
    </section>
  );
}

// ───────────── 状态标签 ─────────────

export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-fg-2 ring-fg-3/15',
  primary: 'bg-primary-soft text-fg ring-fg/15',
  success: 'bg-success-soft text-success-text ring-success-icon/15',
  warning: 'bg-warning-soft text-warning-text ring-warning-icon/20',
  danger: 'bg-danger-soft text-danger-text ring-danger/15',
};
const dots: Record<Tone, string> = {
  neutral: 'bg-fg-4',
  primary: 'bg-fg-2',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/** 状态胶囊：圆点 + 文字；进行中的状态（pulse）以转圈图标代替圆点 */
export function Badge({ tone = 'neutral', dot, pulse, className, children }: { tone?: Tone; dot?: boolean; pulse?: boolean; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset transition-colors duration-300',
        tones[tone],
        className,
      )}
    >
      {dot && (pulse ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <span className={cn('size-1.5 rounded-full', dots[tone])} />)}
      {children}
    </span>
  );
}

/** 小标签（类型、协议等） */
export function Tag({ tone = 'neutral', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset', tones[tone], className)}>
      {children}
    </span>
  );
}

const alertTones: Record<Tone, { box: string; icon: ReactNode }> = {
  neutral: { box: 'border-line bg-surface-2 text-fg-2', icon: <Info /> },
  primary: { box: 'border-line bg-surface-2 text-fg', icon: <Info /> },
  success: { box: 'border-success-icon/25 bg-success-soft text-success-text', icon: <CircleCheck /> },
  warning: { box: 'border-warning-icon/30 bg-warning-soft text-warning-text', icon: <TriangleAlert /> },
  danger: { box: 'border-danger/25 bg-danger-soft text-danger-text', icon: <CircleAlert /> },
};

/** 提示条 */
export function Alert({
  tone = 'primary',
  title,
  children,
  className,
  action,
  icon,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  const s = alertTones[tone];
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-4 py-2.5 text-[13px]', s.box, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="mt-[3px] shrink-0 opacity-80 [&>svg]:size-3.5">{icon ?? s.icon}</span>
      <div className="min-w-0 flex-1 leading-relaxed">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5 opacity-90')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}

// ───────────── 加载 / 空状态 ─────────────

export function Spinner({ className }: { className?: string }) {
  const t = useT();
  return <LoaderCircle className={cn('size-4 animate-spin text-fg-3', className)} aria-label={t('common.loading')} />;
}

/** 页面加载占位：标题 + 卡片 + 列表的骨架，延迟出现（加载很快时不闪） */
/** 整页加载（布局尚未渲染，如校验登录、加载首页）：顶部细进度条；加载很快时不出现 */
export function FullPageLoading() {
  const t = useT();
  return (
    <div className="fade-in-delay fixed inset-x-0 top-0 z-50 h-0.5 overflow-hidden" role="progressbar" aria-busy="true" aria-label={t('common.loading')}>
      <div className="loading-bar h-full w-1/3 rounded-full bg-fg/60" />
    </div>
  );
}

/** 页面内容加载（布局内）：与页面结构相近的骨架屏 */
export function PageLoading() {
  const t = useT();
  // 页面代码下载期间显示顶部进度条
  useLoadingWhileMounted();
  return (
    <div className="fade-in-delay space-y-5" aria-busy="true" aria-label={t('common.loading')}>
      <div className="space-y-2.5">
        <div className="skeleton h-6 w-44" />
        <div className="skeleton h-3.5 w-72 max-w-full" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3 rounded-lg border border-line p-5">
            <div className="skeleton h-3 w-20" />
            <div className="skeleton h-6 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-3.5 rounded-lg border border-line p-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton h-4" style={{ width: `${88 - i * 13}%` }} />
        ))}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  // 快速请求不显示一闪而过的骨架；慢请求仍会在短暂延迟后显示加载反馈。
  return <div className={cn('skeleton fade-in-delay', className)} />;
}

export function Empty({ title, description, icon, action }: { title?: string; description?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  const t = useT();
  return (
    <div className="fade-in flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="text-fg-4 [&>svg]:size-9 [&>svg]:stroke-1">{icon ?? <Inbox />}</div>
      <p className="mt-1 text-[13px] text-fg-3">{title ?? t('common.noData')}</p>
      {description && <p className="max-w-sm text-xs leading-relaxed text-fg-4">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** kind：load 数据加载失败；render 页面渲染出错（错误边界） */
export function ErrorState({ error, onRetry, kind = 'load' }: { error: unknown; onRetry?: () => void; kind?: 'load' | 'render' }) {
  const t = useT();
  return (
    <div className="fade-in flex flex-col items-center gap-2 px-4 py-12 text-center">
      <CircleAlert className="size-9 stroke-1 text-danger" />
      <p className="mt-1 text-[13px] font-medium text-fg">{t(kind === 'render' ? 'common.renderFailed' : 'common.loadFailed')}</p>
      <p className="max-w-md text-xs break-words text-fg-3">{error instanceof Error ? error.message : String(error)}</p>
      {onRetry && (
        <button className="mt-1 text-xs font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg" onClick={onRetry}>
          {t('common.retry')}
        </button>
      )}
    </div>
  );
}

// ───────────── 表单控件 ─────────────

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
  description,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className={cn('inline-flex items-start gap-2.5 text-[13px] text-fg', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v)}
        disabled={disabled}
        className="relative mt-px inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring data-checked:bg-primary"
      >
        <BaseSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-200 ease-spring data-checked:translate-x-[18px] data-checked:bg-primary-fg" />
      </BaseSwitch.Root>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block leading-5">{label}</span>}
          {description && <span className="mt-0.5 block text-xs leading-relaxed text-fg-3">{description}</span>}
        </span>
      )}
    </label>
  );
}

/** 设置列表中的一行开关：左侧标题和说明，右侧开关；整行可点击 */
export function SwitchRow({
  checked,
  onCheckedChange,
  disabled,
  title,
  description,
  className,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex items-center justify-between gap-6 py-3.5 first:pt-0 last:pb-0', disabled ? 'opacity-60' : 'cursor-pointer', className)}>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-fg">{title}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-fg-3">{description}</span>}
      </span>
      <BaseSwitch.Root
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v)}
        disabled={disabled}
        className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-line-strong transition-colors duration-200 outline-none focus-visible:ring-3 focus-visible:ring-ring data-checked:bg-primary"
      >
        <BaseSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform duration-200 ease-spring data-checked:translate-x-[18px] data-checked:bg-primary-fg" />
      </BaseSwitch.Root>
    </label>
  );
}

export function Checkbox({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('inline-flex items-center gap-2 text-[13px] text-fg', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <BaseCheckbox.Root
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v)}
        disabled={disabled}
        className="flex size-4 shrink-0 items-center justify-center rounded border border-line-strong bg-surface text-primary-fg transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring data-checked:border-primary data-checked:bg-primary"
      >
        <BaseCheckbox.Indicator className="flex transition-[scale,opacity] duration-200 ease-spring data-ending-style:scale-50 data-ending-style:opacity-0 data-starting-style:scale-50 data-starting-style:opacity-0 data-unchecked:hidden">
          <Check className="size-3" strokeWidth={3} />
        </BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      {label}
    </label>
  );
}

export function Tooltip({ content, children, side }: { content: ReactNode; children: React.ReactElement; side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6} side={side} className="z-[80]">
          <BaseTooltip.Popup className="popup-anim max-w-xs rounded-md bg-fg px-2.5 py-1.5 text-xs leading-relaxed text-bg shadow-card">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

// ───────────── 用量 ─────────────

const usageLevel = (pct: number) => (pct >= 95 ? 'danger' : pct >= 80 ? 'warning' : 'normal');

/** 用量条：数值超过阈值时切换为警告/危险色，并在标签中给出文字提示 */
export function UsageMeter({ label, value, max, valueText, hint, className }: { label: ReactNode; value: number; max: number; valueText: ReactNode; hint?: ReactNode; className?: string }) {
  const t = useT();
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const level = usageLevel(pct);
  return (
    <Meter.Root value={pct} className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <Meter.Label className="min-w-0 truncate text-fg-3">{label}</Meter.Label>
        <span className="tabular shrink-0 text-fg-2">
          {valueText}
          {level !== 'normal' && (
            <span className={cn('ml-1.5', level === 'danger' ? 'text-danger-text' : 'text-warning-text')}>
              {level === 'danger' ? t('common.usageCritical') : t('common.usageHigh')}
            </span>
          )}
        </span>
      </div>
      <Meter.Track className="h-1.5 overflow-hidden rounded-full bg-surface-3">
        <Meter.Indicator
          className={cn(
            'rounded-full transition-[width,background-color] duration-700 ease-smooth',
            level === 'danger' ? 'bg-danger' : level === 'warning' ? 'bg-warning' : 'bg-fg-2',
          )}
        />
      </Meter.Track>
      {hint && <div className="tabular truncate text-[11px] text-fg-4">{hint}</div>}
    </Meter.Root>
  );
}

/** 环形用量表：中间显示百分比 */
export function RingMeter({ value, max = 100, size = 44, label, className }: { value: number; max?: number; size?: number; label?: ReactNode; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const level = usageLevel(pct);
  const r = 16;
  const c = 2 * Math.PI * r;
  const color = level === 'danger' ? 'var(--danger)' : level === 'warning' ? 'var(--warning)' : 'var(--success)';
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }} role="meter" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <svg viewBox="0 0 40 40" className="size-full -rotate-90">
        <circle cx="20" cy="20" r={r} fill="none" stroke="var(--surface-3)" strokeWidth="3.5" />
        <circle
          cx="20"
          cy="20"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
          style={{ transition: 'stroke-dashoffset 700ms var(--ease-smooth), stroke 300ms' }}
        />
      </svg>
      <span className="tabular absolute inset-0 flex items-center justify-center text-[11px] font-medium" style={{ color }}>
        {label ?? `${Math.round(pct)}%`}
      </span>
    </div>
  );
}

// ───────────── 复制 / 代码 ─────────────

export function CopyButton({ value, className, label }: { value: string; className?: string; label?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label ?? t('common.copy')}
      title={label ?? t('common.copy')}
      className={cn('inline-flex shrink-0 items-center gap-1 rounded p-1 text-fg-4 transition-[color,background-color,scale] hover:bg-surface-3 hover:text-fg active:scale-90', className)}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error(t('common.copyFailed'));
        }
      }}
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** 命令 / 代码块（深色底），带复制按钮 */
export function CodeBlock({ value, className, wrap = true }: { value: string; className?: string; wrap?: boolean }) {
  return (
    <div className={cn('group relative rounded-lg bg-code-bg', className)}>
      <pre className={cn('scrollbar-thin overflow-x-auto px-4 py-3.5 pr-11 font-mono text-xs leading-5 text-code-fg', wrap && 'break-all whitespace-pre-wrap')}>{value}</pre>
      <CopyButton value={value} className="absolute top-2 right-2 text-white/50 hover:bg-white/10 hover:text-white" />
    </div>
  );
}

export function Secret({ value, onReveal }: { value: string | null; onReveal?: () => void }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  return (
    <span className="inline-flex items-center gap-1">
      <code className="font-mono text-[13px]">{shown && value ? value : '••••••••••••'}</code>
      <button
        type="button"
        aria-label={shown ? t('common.hide') : t('common.show')}
        className="rounded p-1 text-fg-4 hover:bg-surface-3 hover:text-fg"
        onClick={() => {
          if (!shown) onReveal?.();
          setShown(!shown);
        }}
      >
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      {shown && value && <CopyButton value={value} />}
    </span>
  );
}

// ───────────── 信息展示 ─────────────

/** 键值对展示：窄屏上下排列，宽屏左右对齐 */
/** 标签 + 值的列表；dense 用于并排的小卡片（行距更小、标签列更窄） */
export function InfoList({ items, className, dense }: { items: { label: ReactNode; value: ReactNode }[]; className?: string; dense?: boolean }) {
  return (
    <dl className={cn('divide-y divide-line/70 text-[13px]', className)}>
      {items.map((it, i) => (
        <div key={i} className={cn('flex flex-col gap-0.5 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline', dense ? 'py-1.5 sm:gap-4' : 'py-2.5 sm:gap-6')}>
          <dt className={cn('shrink-0 text-fg-3', dense ? 'sm:w-20' : 'sm:w-28')}>{it.label}</dt>
          <dd className="min-w-0 break-words text-fg">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 多列信息网格：标签在上、值在下（详情页“基本信息”） */
export function InfoGrid({ items, className }: { items: { label: ReactNode; value: ReactNode; hidden?: boolean }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-8 gap-y-4 rounded-lg border border-line px-5 py-4 sm:grid-cols-2 xl:grid-cols-3', className)}>
      {items
        .filter((it) => !it.hidden)
        .map((it, i) => (
          <div key={i} className="min-w-0">
            <dt className="text-xs text-fg-3">{it.label}</dt>
            <dd className="mt-1 min-w-0 text-[13px] break-words text-fg">{it.value ?? '-'}</dd>
          </div>
        ))}
    </dl>
  );
}

export type StatTone = 'brand' | 'green' | 'amber' | 'slate';
const statTones: Record<StatTone, string> = {
  brand: 'bg-primary-soft text-fg',
  green: 'bg-success-soft text-success-icon',
  amber: 'bg-warning-soft text-warning-icon',
  slate: 'bg-surface-3 text-fg-2',
};

/** 统计卡片：左上标签、右上着色图标、大号数值、底部说明 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  tone = 'brand',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 rounded-xl border border-line bg-surface p-5', className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="truncate text-[13px] text-fg-3">{label}</div>
        {icon && <div className={cn('rounded-lg p-2 [&>svg]:size-4', statTones[tone])}>{icon}</div>}
      </div>
      <div className={cn('tabular text-2xl font-semibold tracking-tight text-fg', icon ? 'mt-1' : 'mt-2')}>{value}</div>
      {hint && <div className="mt-1 truncate text-xs text-fg-3">{hint}</div>}
    </div>
  );
}
export const StatCard = StatTile;

/** 指标条：一组指标拼接在同一个边框里，以细线分隔（总览页）；cols 为宽屏下的列数 */
export function KpiStrip({ children, className, cols = 4 }: { children: ReactNode; className?: string; cols?: 3 | 4 | 5 }) {
  const wide = { 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5' }[cols];
  return <div className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line', wide, className)}>{children}</div>;
}

export function Kpi({ label, value, unit, hint, icon }: { label: ReactNode; value: ReactNode; unit?: ReactNode; hint?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-5 py-4.5">
      <div className="flex items-center gap-2 text-[13px] text-fg-3">
        {icon && <span className="flex size-6 items-center justify-center rounded-md bg-surface-3 text-fg-2 [&>svg]:size-3.5">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div className="tabular mt-2 flex items-baseline gap-1 text-2xl font-bold tracking-tight text-fg">
        {value}
        {unit && <span className="text-sm font-normal text-fg-3">{unit}</span>}
      </div>
      {hint && <div className="mt-1.5 truncate text-[13px] text-fg-3">{hint}</div>}
    </div>
  );
}

/** 表单分节 */
export function FormSection({ title, description, children, className }: { title: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('grid gap-4 lg:grid-cols-[14rem_1fr] lg:gap-8', className)}>
      <div>
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        {description && <p className="mt-1 text-xs leading-relaxed text-fg-3">{description}</p>}
      </div>
      <div className="min-w-0 space-y-4">{children}</div>
    </section>
  );
}

/** 设置表单的一行：左侧标签，右侧控件与说明（窄屏时上下排列） */
export function FormRow({ label, children, hint, required }: { label: ReactNode; children: ReactNode; hint?: ReactNode; required?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-2 py-3 sm:grid-cols-[140px_1fr] sm:gap-6">
      <div className="pt-1.5 text-[13px] font-medium text-fg-2">
        {required && <span className="mr-0.5 text-danger-text">*</span>}
        {label}
      </div>
      <div className="min-w-0">
        {children}
        {hint && <div className="mt-1.5 text-xs text-fg-3">{hint}</div>}
      </div>
    </div>
  );
}

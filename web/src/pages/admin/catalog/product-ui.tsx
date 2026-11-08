import type { ReactNode } from 'react';
import { CountryFlag } from '@/components/country';
import { Card } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

/** 产品页通用的紧凑卡片：细标题栏 + 内容；flush 时内容不加内边距（列表、表格） */
export function Panel({ title, extra, children, flush, compact, className }: { title: ReactNode; extra?: ReactNode; children: ReactNode; flush?: boolean; compact?: boolean; className?: string }) {
  return (
    <Card className={cn('overflow-hidden', className)}>
      <div className={cn('flex items-center justify-between gap-3 border-b border-line px-4', compact ? 'min-h-10 py-1.5' : 'min-h-11 py-2')}>
        <h3 className="text-[13px] font-semibold text-fg">{title}</h3>
        {extra && <div className="flex items-center gap-2 text-xs text-fg-3">{extra}</div>}
      </div>
      <div className={flush ? undefined : compact ? 'px-3.5 py-2.5' : 'px-4 py-3.5'}>{children}</div>
    </Card>
  );
}

/** 指标条：一组小指标拼在同一个边框里 */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line lg:grid-cols-4', className)}>{children}</div>;
}

export function Stat({ icon, label, value, unit, hint, compact }: { icon?: ReactNode; label: ReactNode; value: ReactNode; unit?: ReactNode; hint?: ReactNode; compact?: boolean }) {
  return (
    <div className={cn('min-w-0 bg-surface px-3.5', compact ? 'py-2.5' : 'py-3')}>
      <div className="flex items-center gap-1.5 text-xs text-fg-3 [&>svg]:size-3.5 [&>svg]:text-fg-4">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn('tabular flex items-baseline gap-1 truncate font-semibold tracking-tight text-fg', compact ? 'mt-0.5 text-base leading-6' : 'mt-1 text-lg leading-7')}>
        {value}
        {unit && <span className="text-xs font-normal text-fg-3">{unit}</span>}
      </div>
      {hint && <div className="truncate text-xs text-fg-3">{hint}</div>}
    </div>
  );
}

/** 产品头像：首个地区的旗帜，没有地区时显示名称首字 */
export function ProductAvatar({ country, name, size = 'md' }: { country?: string; name: string; size?: 'md' | 'lg' }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center', size === 'lg' ? 'w-9' : 'w-7')}>
      {country ? (
        <CountryFlag code={country} className={cn('ring-0', size === 'lg' ? 'h-6 w-9 rounded' : 'h-[18px] w-7 rounded-[3px]')} />
      ) : (
        <span className={cn('flex items-center justify-center rounded bg-surface-3 text-xs font-semibold text-fg-3', size === 'lg' ? 'h-6 w-9' : 'h-[18px] w-7')}>{name.slice(0, 1)}</span>
      )}
    </span>
  );
}

/** 状态圆点 + 文本 */
export function StatusDot({ on, children }: { on: boolean; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap text-fg-2">
      <span className={cn('size-1.5 rounded-full', on ? 'bg-success' : 'bg-fg-4')} />
      {children}
    </span>
  );
}

/** 两行单元格：主值 + 灰色补充 */
export function TwoLine({ main, sub }: { main: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 text-[13px] leading-5">
      <div className="truncate text-fg">{main}</div>
      {sub && <div className="truncate text-xs text-fg-3">{sub}</div>}
    </div>
  );
}

/** 表单分节卡片：标题在卡片内，下方为字段网格（编辑套餐、产品配置） */
export function Block({ title, description, extra, children }: { title: ReactNode; description?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-fg-3">{description}</p>}
        </div>
        {extra}
      </div>
      <div className="space-y-4">{children}</div>
    </Card>
  );
}

/** 表单字段网格：窄屏单列，宽屏三列 */
export const GRID = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3';

/** 带边框的开关组：每行标题 + 说明 + 右侧开关 */
export function ToggleGroup({ children }: { children: ReactNode }) {
  return <div className="divide-y divide-line overflow-hidden rounded-lg border border-line">{children}</div>;
}

/** ToggleGroup 内的一行：上下留白一致，悬停时浅色背景 */
export const toggleRow = 'px-3.5 py-3 first:pt-3 last:pb-3 transition-colors hover:bg-surface-2/50';

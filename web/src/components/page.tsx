import { ChevronLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { Tooltip } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

/**
 * 标题左侧的返回按钮：无边框的圆形图标按钮，悬停时出现浅色底并向左轻移；返回目标的名称以提示显示。
 * 左侧负边距让箭头与下方内容的左边缘对齐。
 */
export function BackButton({ to, label, className }: { to: string; label: string; className?: string }) {
  return (
    <Tooltip content={label} side="bottom">
      <Link
        to={to}
        aria-label={label}
        className={cn(
          'group -ml-2 inline-flex size-8 shrink-0 items-center justify-center rounded-full text-fg-3 transition-colors duration-150 hover:bg-surface-3 hover:text-fg focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none',
          className,
        )}
      >
        <ChevronLeft className="size-5 transition-transform duration-150 ease-out group-hover:-translate-x-0.5" strokeWidth={2.25} />
      </Link>
    </Tooltip>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  back,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { to: string; label: string };
  meta?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      {/* 返回按钮放在标题左侧，与标题第一行垂直居中 */}
      <div className="flex min-w-0 items-start gap-1.5">
        {back && <BackButton to={back.to} label={back.label} />}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-2xl leading-8 font-bold tracking-tight break-all text-fg">{title}</h1>
            {meta}
          </div>
          {description && <div className="mt-1.5 text-sm text-fg-3">{description}</div>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * 列表工具栏：左侧筛选、右侧操作。窄屏下筛选区自行换行，右侧按钮保持在右上角
 */
export function Toolbar({ children, right, className }: { children?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start gap-2 border-b border-line px-4', children ? 'py-3' : 'py-1.5', className)}>
      <div className="flex min-w-0 flex-[1_1_15rem] flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">{children}</div>
      {right && <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">{right}</div>}
    </div>
  );
}

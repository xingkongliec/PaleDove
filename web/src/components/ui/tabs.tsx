import { Tabs as BaseTabs } from '@base-ui/react/tabs';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** 数量角标 */
  count?: number | null;
  hidden?: boolean;
}

/**
 * 标签栏（受控）：图标 + 数量角标，选中背景在标签间滑动。
 * 窄屏可横向滚动并自动滚动到选中项；variant="pill" 为灰底胶囊样式，选中项白底
 */
export function TabBar<T extends string>({
  value,
  onChange,
  items,
  className,
  listClassName,
  variant = 'line',
}: {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  className?: string;
  listClassName?: string;
  variant?: 'line' | 'pill';
}) {
  const pill = variant === 'pill';
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[data-active]');
    if (!list || !el) return;
    // 只滚动标签栏；scrollIntoView 会同时滚动页面，切页后看起来会跳一下。
    const left = el.offsetLeft;
    const right = left + el.offsetWidth;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth;
  }, [value]);
  return (
    <BaseTabs.Root value={value} onValueChange={(v) => onChange(v as T)} className={cn('relative', className)}>
      <BaseTabs.List
        ref={listRef}
        className={cn(
          'scrollbar-none relative isolate flex overflow-x-auto overflow-y-hidden',
          pill ? 'w-fit max-w-full gap-0.5 rounded-lg border border-line bg-surface-2 p-1' : 'gap-1.5 border-b border-line pb-3',
          listClassName,
        )}
      >
        {items
          .filter((t) => !t.hidden)
          .map((t) => (
            <BaseTabs.Tab
              key={t.value}
              value={t.value}
              className={cn(
                'inline-flex shrink-0 items-center gap-2 rounded-md px-3 text-[13px] whitespace-nowrap text-fg-2 transition-colors duration-200 outline-none hover:text-fg focus-visible:ring-3 focus-visible:ring-ring data-active:font-medium data-active:text-fg [&_svg]:size-4 [&_svg]:text-fg-3',
                pill ? 'h-8' : 'h-9 hover:bg-surface-2 data-active:hover:bg-transparent',
              )}
            >
              {t.icon}
              {t.label}
              {t.count != null && (
                <span className="tabular min-w-5 rounded bg-surface-3 px-1.5 text-center text-[11px] leading-[18px] font-normal text-fg-3">{t.count}</span>
              )}
            </BaseTabs.Tab>
          ))}
        <BaseTabs.Indicator
          className={cn(
            'absolute top-[var(--active-tab-top)] left-[var(--active-tab-left)] -z-10 h-[var(--active-tab-height)] w-[var(--active-tab-width)] rounded-md transition-[left,top,width,height] duration-300 ease-smooth',
            pill ? 'bg-surface shadow-xs ring-1 ring-line/60' : 'bg-surface-4/80',
          )}
        />
      </BaseTabs.List>
    </BaseTabs.Root>
  );
}

/** 分段选择器：选中背景随选项滑动 */
export function Segmented<T extends string | number>({
  value,
  onChange,
  items,
  className,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  className?: string;
  'aria-label'?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; width: number } | null>(null);
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const measure = () => {
      const el = box.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!el) return;
      const next = { left: el.offsetLeft, width: el.offsetWidth };
      // 位置没变时不更新，避免尺寸观察回调引起多余的重新渲染
      setPos((prev) => (prev && prev.left === next.left && prev.width === next.width ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) ro.observe(box.current);
    return () => ro.disconnect();
  }, [value, items.length]);
  // 首次定位不做动画
  useEffect(() => {
    if (pos && !ready) {
      const id = requestAnimationFrame(() => setReady(true));
      return () => cancelAnimationFrame(id);
    }
  }, [pos, ready]);
  return (
    <div
      ref={box}
      className={cn('scrollbar-none relative inline-flex max-w-full overflow-x-auto rounded-lg bg-surface-3 p-0.5', className)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {pos && (
        <span
          aria-hidden
          className={cn('absolute top-0.5 bottom-0.5 rounded-md bg-surface shadow-xs ring-1 ring-line/50', ready && 'transition-[left,width] duration-300 ease-smooth')}
          style={{ left: pos.left, width: pos.width }}
        />
      )}
      {items.map((it) => (
        <button
          key={String(it.value)}
          type="button"
          role="radio"
          aria-checked={it.value === value}
          onClick={() => onChange(it.value)}
          className={cn(
            'relative min-h-7 flex-1 rounded-md px-3 py-1 text-[13px] leading-[1.35] whitespace-nowrap transition-colors duration-200 outline-none',
            it.value === value ? 'font-medium text-fg' : 'text-fg-2 hover:text-fg',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

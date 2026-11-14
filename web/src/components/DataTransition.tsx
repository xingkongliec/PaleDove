import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useMediaQuery } from '@/hooks/media-query';
import { cn } from '@/lib/cn';

/** 首次取数与筛选完成后淡入内容；后台刷新只显示局部进度，保留现有数据。 */
export function DataTransition({ pending = false, refreshing = false, children, className }: { pending?: boolean; refreshing?: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const waiting = useRef(pending);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  useLayoutEffect(() => {
    const wasPending = waiting.current;
    waiting.current = pending;
    if (!wasPending || pending || reducedMotion || !ref.current?.animate) return;
    const animation = ref.current.animate([{ opacity: 0.65 }, { opacity: 1 }], { duration: 220, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
    animation.id = 'data-enter';
    return () => animation.cancel();
  }, [pending, reducedMotion]);

  return (
    <div ref={ref} className={cn('data-transition relative min-w-0', className)} aria-busy={pending || refreshing || undefined} data-loading-content>
      {(pending || refreshing) && <div className="data-loading-progress pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden" aria-hidden><div className="loading-bar h-full w-1/3 rounded-full bg-fg/35" /></div>}
      {children}
    </div>
  );
}

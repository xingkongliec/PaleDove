import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { useMediaQuery } from '@/hooks/media-query';
import { cn } from '@/lib/cn';

/** 只在路由提交时轻移内容；保留布局和非零透明度，刷新数据不会重复播放。 */
export function PageTransition({ children, className, preserveAnimations = false, fadeOnly = false }: { children: ReactNode; className?: string; preserveAnimations?: boolean; fadeOnly?: boolean }) {
  const { pathname } = useLocation();
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || reducedMotion || !element.animate) return;
    let animation: Animation | undefined;
    let observer: MutationObserver | undefined;
    const enter = () => {
      // 整页骨架先保持稳定，等真实内容就绪再播放；局部取数和轮询不重播。
      if (!element.querySelector('h1') && element.querySelector('[aria-busy="true"]')) return;
      observer?.disconnect();
      animation = element.animate(
        fadeOnly ? [{ opacity: 0.82 }, { opacity: 1 }] : [{ opacity: 0.82, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
        { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      );
      animation.id = 'page-enter';
    };
    enter();
    if (!animation) {
      observer = new MutationObserver(enter);
      observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
    }
    return () => { observer?.disconnect(); animation?.cancel(); };
  }, [pathname, reducedMotion, fadeOnly]);

  return <div ref={ref} className={cn(!preserveAnimations && 'route-view', className)} data-route-content>{children}</div>;
}

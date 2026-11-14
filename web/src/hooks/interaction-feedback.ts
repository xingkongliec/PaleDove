import { useEffect } from 'react';
import { useMediaQuery } from './media-query';

/** 快速点击、键盘激活与原生按钮共用一次回弹，不依赖鼠标按住的时间。 */
export function useInteractionFeedback() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  useEffect(() => {
    if (reducedMotion) return;
    const active = new Map<Element, Animation>();
    const press = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[href], [role="button"]') : null;
      if (!element?.animate || element.matches(':disabled, [aria-disabled="true"], [data-disabled]') || element.closest('[inert]')) return;
      active.get(element)?.cancel();
      // 浮层与折叠触发器必须和 CSS 按压样式一样保持尺寸稳定。
      const changesExpansion = element.matches('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded], [role="combobox"]');
      const animation = element.animate(
        changesExpansion ? [{ opacity: 0.7 }, { opacity: 1 }] : [{ scale: '0.97' }, { scale: '1' }],
        { duration: 240, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' },
      );
      animation.id = 'button-feedback';
      active.set(element, animation);
      void animation.finished.catch(() => {}).finally(() => {
        if (active.get(element) === animation) active.delete(element);
      });
    };
    document.addEventListener('click', press, { capture: true });
    return () => {
      document.removeEventListener('click', press, { capture: true });
      for (const animation of active.values()) animation.cancel();
    };
  }, [reducedMotion]);
}

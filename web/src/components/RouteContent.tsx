import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { readRouteData } from '@/lib/route-prefetch';

/** 放在稳定的 Suspense 内，首次数据与代码就绪后一起切换，避免骨架和空状态轮流闪现。 */
export function RouteContent({ children }: { children: ReactNode }) {
  const location = useLocation();
  readRouteData(`${location.pathname}${location.search}`);
  return children;
}

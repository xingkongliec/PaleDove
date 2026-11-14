import { useEffect } from 'react';
import type { MeDTO, PublicConfigDTO } from '../shared/index';
import { consoleRedirect } from '../shared/index';
import { api } from './api';
import { marketListOptions } from './market-query';
import { invoiceDetailOptions, invoiceListOptions } from './invoice-query';
import { queryClient } from './queries';
import { prefetchRoute } from './routes';

/** 仅预取用户即将打开的页面；与页面本身共用查询缓存，请求失败由页面正常处理。 */
type RouteQuery = { queryKey: readonly unknown[]; queryFn: () => Promise<unknown> };

function routeQueries(path: string): RouteQuery[] {
  const url = new URL(path, window.location.origin);
  if (url.origin !== window.location.origin) return [];
  const pathname = consoleRedirect(url.pathname) ?? url.pathname;
  const me = queryClient.getQueryData<MeDTO | null>(['me']);
  const site = queryClient.getQueryData<PublicConfigDTO>(['public-config']);
  const queries: RouteQuery[] = [];
  const warm = (queryKey: readonly unknown[], endpoint: string) => queries.push({ queryKey, queryFn: () => api.get(endpoint) });
  if ((pathname.startsWith('/admin') && me?.role !== 'ADMIN') || (pathname.startsWith('/console') && me?.role !== 'USER')) return queries;
  if (pathname === '/market' || pathname === '/console/marketplace') {
    if (site?.marketEnabled === false) return queries;
    queries.push(marketListOptions({ region: 'ALL', type: 'ALL', sort: 'NEWEST', keyword: (url.searchParams.get('q') ?? '').trim(), page: 1 }, me?.id ?? 0));
  } else if (pathname === '/console/dashboard') {
    warm(['dashboard'], '/dashboard');
    warm(['instances'], '/instances');
    warm(['billing-summary'], '/billing/summary');
  } else if (pathname === '/console/instances') warm(['instances'], '/instances');
  else if (/^\/console\/instances\/\d+$/.test(pathname)) {
    const id = Number(pathname.split('/').at(-1));
    warm(['instance', id, `/instances/${id}`], `/instances/${id}`);
  } else if (pathname === '/console/vpc') warm(['vpcs'], '/vpcs');
  else if (pathname === '/console/billing') warm(['billing-summary'], '/billing/summary');
  else if (pathname === '/console/invoices') queries.push(invoiceListOptions());
  else if (/^\/console\/invoices\/\d+$/.test(pathname)) {
    const id = Number(pathname.split('/').at(-1));
    queries.push(invoiceDetailOptions(id));
  } else if (pathname === '/console/documents' || pathname === '/help') warm(['public-documents'], '/public/documents');
  else if (pathname === '/store' || pathname === '/console/store') {
    warm(['store-plans'], '/public/plans');
    warm(['store-products'], '/public/products');
  } else if (pathname === '/admin') warm(['admin-stats'], '/admin/stats');
  else if (pathname === '/admin/nodes') warm(['admin-nodes'], '/admin/nodes');
  else if (/^\/admin\/users\/\d+$/.test(pathname)) {
    const id = Number(pathname.split('/').at(-1));
    if (Number.isSafeInteger(id) && id > 0) warm(['admin-user', id], `/admin/users/${id}`);
  } else if (/^\/admin\/nodes\/\d+$/.test(pathname)) {
    const id = Number(pathname.split('/').at(-1));
    warm(['admin-node', id], `/admin/nodes/${id}`);
  } else if (/^\/admin\/instances\/\d+$/.test(pathname)) {
    const id = Number(pathname.split('/').at(-1));
    warm(['instance', id, `/admin/instances/${id}`], `/admin/instances/${id}`);
  }
  return queries;
}

export function prefetchRouteData(path: string): void {
  for (const options of routeQueries(path)) void queryClient.prefetchQuery(options);
}

const pendingRoutes = new Map<string, { ready: boolean; promise: Promise<void> }>();

/** 首次打开页面时并行准备代码与关键数据；已有缓存时立即显示并沿用页面的后台刷新策略。 */
export function readRouteData(path: string): void {
  const queries = routeQueries(path);
  const missing = queries.filter(({ queryKey }) => {
    const state = queryClient.getQueryState(queryKey);
    return state?.data === undefined && state?.status !== 'error';
  });
  if (!missing.length) return;
  const key = JSON.stringify(queries.map(({ queryKey }) => queryKey));
  const pending = pendingRoutes.get(key);
  if (pending) {
    if (!pending.ready) throw pending.promise;
    return;
  }
  prefetchRoute(path);
  const entry = { ready: false, promise: Promise.resolve() };
  entry.promise = new Promise<void>((resolve) => {
    // 慢接口最多延后切页 1.2 秒，之后由目标页面显示加载状态，避免停在旧页面。
    const timer = window.setTimeout(() => { entry.ready = true; resolve(); }, 1200);
    void Promise.all(missing.map((options) => queryClient.prefetchQuery(options))).finally(() => {
      window.clearTimeout(timer);
      entry.ready = true;
      pendingRoutes.delete(key);
      resolve();
    });
  });
  pendingRoutes.set(key, entry);
  throw entry.promise;
}

/** 链接统一支持鼠标、键盘和触屏意图预加载，不需要每个页面单独接入。 */
export function useRoutePrefetch(): void {
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType ?? '')) return;
    let timer: number | undefined;
    const prepare = (event: Event) => {
      if (event instanceof PointerEvent && event.type === 'pointerover' && event.pointerType !== 'mouse') return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.target === '_blank' || link.hasAttribute('download') || link.origin !== window.location.origin) return;
      if (link.pathname === window.location.pathname && link.search === window.location.search) return;
      window.clearTimeout(timer);
      const path = `${link.pathname}${link.search}`;
      prefetchRoute(path);
      timer = window.setTimeout(() => prefetchRouteData(path), event.type === 'pointerover' ? 80 : 0);
    };
    document.addEventListener('pointerover', prepare, { passive: true });
    document.addEventListener('pointerdown', prepare, { passive: true });
    document.addEventListener('focusin', prepare);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerover', prepare);
      document.removeEventListener('pointerdown', prepare);
      document.removeEventListener('focusin', prepare);
    };
  }, []);
}

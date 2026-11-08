// 全局加载状态：页面代码下载、页面首次取数时计数，顶部进度条据此显示
import { useIsFetching } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

let count = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** 单次加载最多占用进度条这么久：慢接口或挂起的请求不会让进度条一直卡住 */
const MAX_HOLD_MS = 8000;

export function beginLoading() {
  count++;
  emit();
  let done = false;
  const end = () => {
    if (done) return;
    done = true;
    window.clearTimeout(timer);
    count--;
    emit();
  };
  const timer = window.setTimeout(end, MAX_HOLD_MS);
  return end;
}

/** 跟踪一个 Promise 的加载过程 */
export function trackLoading<T>(p: Promise<T>) {
  const end = beginLoading();
  return p.finally(end);
}

/** 组件挂载期间视为加载中（用于 Suspense 的占位） */
export function useLoadingWhileMounted() {
  useEffect(() => beginLoading(), []);
}

/**
 * 是否有加载在进行：页面代码下载（Suspense 占位）、页面首次取数（还没有数据的查询）。
 * 后台刷新、轮询不算，不打扰。
 */
export function useGlobalLoading() {
  const pending = useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => count > 0,
  );
  const firstFetch = useIsFetching({ predicate: (q) => q.state.data === undefined && q.state.status !== 'error' });
  return pending || firstFetch > 0;
}

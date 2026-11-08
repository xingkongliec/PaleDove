import { useSyncExternalStore } from 'react';

export interface ChartColors {
  series1: string;
  series2: string;
  grid: string;
  axis: string;
  surface: string;
  fg: string;
}

function read(): ChartColors {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    series1: v('--series-1'),
    series2: v('--series-2'),
    grid: v('--grid'),
    axis: v('--fg-3'),
    surface: v('--surface'),
    fg: v('--fg'),
  };
}

// 全部图表共用一份颜色：只在主题变化时重新读取 CSS 变量。
// （以前每个图表各自读取，一个页面多张图表时会反复强制样式计算，切换到监控页时明显卡顿）
let current: ChartColors | null = null;
const listeners = new Set<() => void>();
let watching = false;

function refresh() {
  current = read();
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (!watching) {
    watching = true;
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  }
  return () => listeners.delete(fn);
}

function snapshot(): ChartColors {
  if (!current) current = read();
  return current;
}

/** 读取当前主题下的图表颜色；主题切换（手动或跟随系统）时自动更新 */
export function useChartColors(): ChartColors {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

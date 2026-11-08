export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'paledove-theme';
/** 主题变化时（任意位置调用 applyTheme）派发的窗口事件 */
export const THEME_EVENT = 'paledove-theme-change';

export function getThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* 隐私模式等情况下无法访问 localStorage */
  }
  return 'system';
}

/** 当前实际生效的明暗（跟随系统时按系统设置） */
export function resolvedTheme(mode: ThemeMode = getThemeMode()): 'light' | 'dark' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

/** 在浅色 / 深色之间切换；支持时整页交叉淡入 */
export function toggleTheme(): 'light' | 'dark' {
  const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
  // 与系统设置一致时回到“跟随系统”，之后系统切换也能自动跟随
  const sys = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const mode: ThemeMode = next === sys ? 'system' : next;
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(() => applyTheme(mode));
  else applyTheme(mode);
  return next;
}

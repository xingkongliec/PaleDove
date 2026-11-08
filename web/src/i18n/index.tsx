import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn.js';
import 'dayjs/locale/zh-tw.js';
import { createContext, Fragment, use, useCallback, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, enumLabels, LOCALES, normalizeLocale, type EnumLabels, type Locale } from '../shared/index';
import { en } from './en';
import { zhCN, type MessageKey } from './zh-CN';
import { zhTW } from './zh-TW';

export type { MessageKey };
export type Vars = Record<string, string | number>;

const catalogs: Record<Locale, Record<MessageKey, string>> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en };
const DAYJS_LOCALE: Record<Locale, string> = { 'zh-CN': 'zh-cn', 'zh-TW': 'zh-tw', en: 'en' };
const STORAGE_KEY = 'paledove-locale';

function stored(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && (LOCALES as readonly string[]).includes(v) ? (v as Locale) : null;
  } catch {
    return null;
  }
}

/** 用户是否手动选择过语言（未选择时可沿用账户中保存的偏好） */
export function hasStoredLocale(): boolean {
  return stored() !== null;
}

function detect(): Locale {
  const nav = typeof navigator !== 'undefined' ? (navigator.languages?.join(',') ?? navigator.language) : null;
  return stored() ?? normalizeLocale(nav) ?? DEFAULT_LOCALE;
}

let current: Locale = DEFAULT_LOCALE;
function apply(locale: Locale) {
  current = locale;
  dayjs.locale(DAYJS_LOCALE[locale]);
  document.documentElement.lang = locale;
}
apply(detect());

/** 当前语言（供非 React 代码使用，如请求头与格式化函数） */
export function getLocale(): Locale {
  return current;
}

/**
 * 翻译并插值 {name}。英文可用 “单数||复数” 写法，按 vars.n 选择。
 */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  let s = catalogs[locale][key] ?? zhCN[key] ?? key;
  if (s.includes('||')) {
    const [one, other] = s.split('||');
    s = vars && Number(vars.n) === 1 ? one : other;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

export function t(key: MessageKey, vars?: Vars): string {
  return translate(current, key, vars);
}

/** 带 React 节点占位的翻译：rich('site.dnsHint', { ip: <b>1.2.3.4</b> }) */
export function richText(template: string, nodes: Record<string, ReactNode>): ReactNode {
  const parts = template.split(/\{(\w+)\}/g);
  return parts.map((p, i) => (i % 2 === 1 ? <Fragment key={i}>{p in nodes ? nodes[p] : `{${p}}`}</Fragment> : p));
}

export type TFunction = (key: MessageKey, vars?: Vars) => string;

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: TFunction;
  /** 枚举标签 */
  L: EnumLabels;
  rich: (key: MessageKey, nodes: Record<string, ReactNode>, vars?: Vars) => ReactNode;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children, onChange }: { children: ReactNode; onChange?: (locale: Locale) => void }) {
  const [locale, setLocaleState] = useState<Locale>(current);
  const setLocale = useCallback(
    (next: Locale) => {
      apply(next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* 隐私模式等情况下无法写入 */
      }
      setLocaleState(next);
      onChange?.(next);
    },
    [onChange],
  );
  const value = useMemo<I18nContextValue>(() => {
    const tr: TFunction = (key, vars) => translate(locale, key, vars);
    return {
      locale,
      setLocale,
      t: tr,
      L: enumLabels(locale),
      rich: (key, nodes, vars) => richText(tr(key, vars), nodes),
    };
  }, [locale, setLocale]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18nContextValue {
  const ctx = use(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export function useT(): TFunction {
  return useI18n().t;
}

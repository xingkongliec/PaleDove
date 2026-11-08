import { AsyncLocalStorage } from 'node:async_hooks';
import { DEFAULT_LOCALE, enumLabels, type EnumLabels, type Locale } from '../shared/index.ts';
import { en } from './en.ts';
import { zhCN, type ServerMessageKey } from './zh-CN.ts';
import { zhTW } from './zh-TW.ts';

export type { ServerMessageKey };

const catalogs: Record<Locale, Record<ServerMessageKey, string>> = { 'zh-CN': zhCN, 'zh-TW': zhTW, en };

interface LocaleStore {
  locale: Locale;
  /** 请求显式指定了语言（x-locale 请求头） */
  explicit: boolean;
}

const storage = new AsyncLocalStorage<LocaleStore>();

export function currentLocale(): Locale {
  return storage.getStore()?.locale ?? DEFAULT_LOCALE;
}

/** 在指定语言环境中执行（后台任务按发起用户的语言生成消息） */
export function runWithLocale<T>(locale: Locale, fn: () => T, explicit = false): T {
  return storage.run({ locale, explicit }, fn);
}

export function localeStore(): LocaleStore | undefined {
  return storage.getStore();
}

export function isMessageKey(key: string): key is ServerMessageKey {
  return Object.prototype.hasOwnProperty.call(zhCN, key);
}

/** 标注消息键（用于 Zod 等静态声明的校验消息，校验失败时再翻译） */
export const m = <K extends ServerMessageKey>(key: K): K => key;

export function translate(locale: Locale, key: ServerMessageKey, vars?: Record<string, string | number>): string {
  const template = catalogs[locale]?.[key] ?? zhCN[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (all, name: string) => (name in vars ? String(vars[name]) : all));
}

export function t(key: ServerMessageKey, vars?: Record<string, string | number>): string {
  return translate(currentLocale(), key, vars);
}

/** 当前语言下的枚举标签 */
export function labels(): EnumLabels {
  return enumLabels(currentLocale());
}

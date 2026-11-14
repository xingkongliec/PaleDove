import { nextLocalMidnight, popupDismissed, type PopupDismissMode, type PopupDismissal } from '../shared/index';

const fallback = { session: new Map<string, unknown>(), local: new Map<string, unknown>() };
const browserStorage = (kind: 'session' | 'local') => (globalThis as unknown as Record<'sessionStorage' | 'localStorage', { getItem(key: string): string | null; setItem(key: string, value: string): void }>)[kind === 'session' ? 'sessionStorage' : 'localStorage'];

function read(kind: 'session' | 'local', key: string): unknown {
  if (fallback[kind].has(key)) return fallback[kind].get(key);
  try {
    const raw = browserStorage(kind).getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return fallback[kind].get(key);
  }
}

function write(kind: 'session' | 'local', key: string, value: unknown) {
  try {
    browserStorage(kind).setItem(key, JSON.stringify(value));
    fallback[kind].delete(key);
  } catch {
    fallback[kind].set(key, value);
  }
}

const storageKey = (scope: string, kind: string) => `pd:popup:${scope}:${kind}`;

export function isPopupHidden(scope: string, kind: string, revision: string, now = Date.now()): boolean {
  const key = storageKey(scope, kind);
  return read('session', key) === revision || popupDismissed(read('local', key), revision, now);
}

export function dismissPopup(scope: string, kind: string, revision: string, mode: PopupDismissMode, now = new Date()) {
  const key = storageKey(scope, kind);
  if (mode === 'session') write('session', key, revision);
  else write('local', key, { revision, until: mode === 'forever' ? 'forever' : nextLocalMidnight(now) } satisfies PopupDismissal);
}

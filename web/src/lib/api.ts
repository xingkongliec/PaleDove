import type { ApiErrorBody } from '../shared/index';
import { getLocale, hasStoredLocale, t } from '@/i18n';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const url = `/api${path}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let res: Response;
  const headers: Record<string, string> = { 'x-requested-with': 'XMLHttpRequest' };
  // 仅在用户手动选择过语言时显式声明（服务端会保存为账户偏好）；否则由服务端按账户偏好 / Accept-Language 决定
  if (hasStoredLocale()) headers['x-locale'] = getLocale();
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers['content-type'] = 'application/json';
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : multipart ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', t('common.networkError'));
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiErrorBody>;
    if (res.status === 503 && err.error === 'MAINTENANCE') window.dispatchEvent(new Event('pd:maintenance'));
    if (res.status === 401 && onUnauthorized && !path.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(res.status, err.error ?? 'ERROR', err.message ?? t('common.requestFailed', { status: res.status }), err.details);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>('GET', path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),
};

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

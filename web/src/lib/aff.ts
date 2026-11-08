// 推广码：通过推广链接（任意页面带 ?aff=CODE）进入时记下，30 天内注册（含第三方登录注册）都会带上
const KEY = 'pd-aff';
const TTL = 30 * 86400_000;

export function captureAff(): void {
  try {
    const code = new URLSearchParams(location.search).get('aff')?.trim().toUpperCase();
    if (code && /^[A-Z0-9]{4,16}$/.test(code)) localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
  } catch {
    // 无法使用本地存储时忽略
  }
}

export function storedAff(): string | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { code: string; at: number } | null;
    return v && Date.now() - v.at < TTL ? v.code : undefined;
  } catch {
    return undefined;
  }
}

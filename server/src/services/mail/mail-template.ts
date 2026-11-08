// 邮件 HTML 模板：与站点一致的黑 / 白 / 灰风格（白色卡片、黑色按钮、中性灰文字），
// 用表格布局和内联样式，兼容 Outlook、Gmail、QQ 邮箱等客户端；所有外部传入的文字都要经过 esc。
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from '../../shared/index.ts';
import { config } from '../../config.ts';
import { getSetting, getSettings } from '../../lib/settings.ts';

export type MailLocale = Locale;
export const mailLocale = (locale?: string | null): MailLocale => normalizeLocale(locale) ?? DEFAULT_LOCALE;

/** 与站点一致的颜色（web/src/index.css 的浅色主题） */
const C = { ink: '#111111', text: '#334155', muted: '#64748b', faint: '#94a3b8', line: '#e5e8ef', page: '#f6f7f9', soft: '#f8fafc' };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',Helvetica,Arial,sans-serif";

/** HTML 转义：昵称、站点名、工单标题、公告内容等都可能被用户控制，不能原样拼进邮件 */
export const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
/** 转义并保留换行 */
export const escLines = (s: string) => esc(s).replace(/\r?\n/g, '<br>');

const FOOTER: Record<MailLocale, string> = {
  'zh-CN': '此邮件由系统自动发送，请勿直接回复。',
  'zh-TW': '此郵件由系統自動發送，請勿直接回覆。',
  en: 'This email was sent automatically. Please do not reply.',
};
const FALLBACK: Record<MailLocale, string> = {
  'zh-CN': '如果按钮无法点击，请复制下面的链接到浏览器打开：',
  'zh-TW': '如果按鈕無法點擊，請複製下面的連結到瀏覽器開啟：',
  en: 'If the button does not work, copy this link into your browser:',
};

/** 站点图标：邮件客户端普遍不显示 SVG，自定义图标是 SVG 时只显示站点名 */
async function logoUrl(baseUrl: string) {
  if (!baseUrl) return null;
  const icon = await getSetting('siteIcon');
  if (icon.data) return icon.mime === 'image/svg+xml' ? null : `${baseUrl}/api/site/icon?v=${Date.parse(icon.updatedAt) || 0}`;
  return `${baseUrl}/logo.png`;
}

// ───────────── 正文组件 ─────────────

export const p = (html: string) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.75;color:${C.text}">${html}</p>`;

export const muted = (html: string) => `<p style="margin:18px 0 0;font-size:12px;line-height:1.7;color:${C.faint}">${html}</p>`;

/** 主按钮 + 备用链接（按钮无法点击时复制） */
export const button = (url: string, text: string, l: MailLocale) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 6px"><tr>
<td style="border-radius:8px;background:${C.ink}"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:11px 22px;font-family:${FONT};font-size:14px;font-weight:600;line-height:1;color:#ffffff;text-decoration:none;border-radius:8px">${esc(text)}</a></td>
</tr></table>
<p style="margin:14px 0 0;font-size:12px;line-height:1.6;color:${C.faint}">${FALLBACK[l]}<br><a href="${esc(url)}" target="_blank" style="color:${C.muted};word-break:break-all">${esc(url)}</a></p>`;

/** 引用块（工单内容等） */
export const quote = (html: string) =>
  `<div style="margin:4px 0 6px;padding:14px 16px;background:${C.soft};border:1px solid ${C.line};border-left:3px solid ${C.ink};border-radius:8px;font-size:14px;line-height:1.75;color:${C.text}">${html}</div>`;

/** 键值信息表（余额、费用等）；值已是安全的 HTML */
export const facts = (rows: Array<[string, string]>) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:6px 0 8px;background:${C.soft};border:1px solid ${C.line};border-radius:8px;border-collapse:separate">${rows
    .map(
      ([k, v], i) =>
        `<tr><td style="padding:11px 16px;font-size:13px;color:${C.muted};${i ? `border-top:1px solid ${C.line};` : ''}">${esc(k)}</td><td align="right" style="padding:11px 16px;font-size:14px;font-weight:600;color:${C.ink};${i ? `border-top:1px solid ${C.line};` : ''}">${v}</td></tr>`,
    )
    .join('')}</table>`;

/** 小标签（公告级别等） */
export const tag = (text: string, tone: 'gray' | 'amber' | 'red' = 'gray') => {
  const t = { gray: ['#f1f5f9', '#475569'], amber: ['#fffbeb', '#b45309'], red: ['#fef2f2', '#b91c1c'] }[tone];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:${t[0]};color:${t[1]};font-size:12px;font-weight:600;line-height:1.6">${esc(text)}</span>`;
};

// ───────────── 整体布局 ─────────────

/**
 * 邮件外框：站点图标 + 名称、白色卡片（标题 + 正文）、页脚。
 * preheader 是收件箱列表里标题后面显示的摘要文字（正文中不可见）。
 */
export async function renderMail(opts: { title: string; body: string; preheader?: string; footer?: string; locale?: string | null; badge?: string; baseUrl?: string }) {
  const l = mailLocale(opts.locale);
  const site = await getSettings();
  const name = esc(site.siteName);
  const baseUrl = (opts.baseUrl ?? config.PANEL_URL ?? '').replace(/\/+$/, '');
  const logo = await logoUrl(baseUrl);
  const host = baseUrl.replace(/^https?:\/\//, '');
  return `<!doctype html>
<html lang="${l === 'en' ? 'en' : l === 'zh-TW' ? 'zh-TW' : 'zh-CN'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(opts.preheader ?? '')}&#8203;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT}">
  <tr><td style="padding:0 4px 18px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      ${logo ? `<td style="padding-right:10px;vertical-align:middle"><img src="${esc(logo)}" width="28" height="28" alt="" style="display:block;width:28px;height:28px;border:0;border-radius:6px"></td>` : ''}
      <td style="vertical-align:middle;font-size:16px;font-weight:600;color:${C.ink};letter-spacing:-0.01em">${name}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background:#ffffff;border:1px solid ${C.line};border-radius:12px;padding:32px 32px 28px">
    ${opts.badge ? `<div style="margin:0 0 12px">${opts.badge}</div>` : ''}
    <h1 style="margin:0 0 18px;font-size:20px;line-height:1.4;font-weight:600;color:${C.ink};letter-spacing:-0.01em">${esc(opts.title)}</h1>
    ${opts.body}
  </td></tr>
  <tr><td style="padding:20px 4px 0;font-size:12px;line-height:1.7;color:${C.faint}">
    ${opts.footer ?? FOOTER[l]}<br>
    ${baseUrl ? `<a href="${esc(baseUrl)}" target="_blank" style="color:${C.muted};text-decoration:none">${name} · ${esc(host)}</a>` : name}
  </td></tr>
</table>
</td></tr></table>
</body>
</html>`;
}

/** 纯文本版本（multipart/alternative，提高送达率，也方便不显示 HTML 的客户端） */
export function htmlToText(html: string) {
  return html
    .replace(/<(head|style|title)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, '')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && t !== href ? `${t}（${href}）` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|tr|table)>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8203;/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((s) => s.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

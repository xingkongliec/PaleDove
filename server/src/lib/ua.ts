import { t } from '../i18n/index.ts';

/** 从 User-Agent 粗略识别操作系统和浏览器，用于“登录设备”列表展示 */
export function parseUserAgent(ua: string | null | undefined): { os: string; browser: string; device: 'mobile' | 'desktop' } {
  const s = ua ?? '';
  let os = t('ua.unknownOs');
  if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux|X11/.test(s)) os = 'Linux';

  let browser = t('ua.unknownBrowser');
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/MicroMessenger/.test(s)) browser = t('ua.wechat');
  else if (/FxiOS|Firefox\//.test(s)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  else if (/curl\//i.test(s)) browser = 'curl';
  else if (/node|undici/i.test(s)) browser = t('ua.apiClient');

  return { os, browser, device: /Mobile|iPhone|iPad|Android/.test(s) ? 'mobile' : 'desktop' };
}

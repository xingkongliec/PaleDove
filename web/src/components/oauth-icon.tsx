// 第三方登录的图标：GitHub / Google 用品牌图标；管理员添加的登录方式用上传的图标，没有时显示名称首字
export const GithubIcon = () => (
  <svg viewBox="0 0 24 24" className="size-[18px]" fill="currentColor" aria-hidden>
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.69 1.25 3.34.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.62 1.59.23 2.76.11 3.05.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.39-5.25 5.68.41.35.78 1.06.78 2.14 0 1.55-.01 2.79-.01 3.17 0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
  </svg>
);
export const GoogleIcon = () => (
  <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
    <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z" />
    <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.92l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24Z" />
    <path fill="#FBBC05" d="M5.29 14.28A7.2 7.2 0 0 1 4.91 12c0-.79.14-1.56.38-2.28V6.62H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.38l4.01-3.1Z" />
    <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77Z" />
  </svg>
);

/** 自定义登录方式没有图标：显示名称首字 */
const InitialIcon = ({ name }: { name: string }) => (
  <span className="grid size-[18px] shrink-0 place-items-center rounded bg-fg text-[11px] leading-none font-semibold text-bg" aria-hidden>
    {Array.from(name.trim())[0]?.toUpperCase() ?? '?'}
  </span>
);
/** 管理员设置的图标（本站地址，服务端已下载保存） */
const ImageIcon = ({ src }: { src: string }) => <img src={src} alt="" aria-hidden className="size-[18px] shrink-0 rounded-[3px] object-contain" />;
export const oauthIcon = (id: string, name: string, icon?: string | null) =>
  icon ? <ImageIcon src={icon} /> : id === 'github' ? <GithubIcon /> : id === 'google' ? <GoogleIcon /> : <InitialIcon name={name} />;

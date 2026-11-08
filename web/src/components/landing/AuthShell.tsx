import type { ReactNode } from 'react';
import { GalaxyParticles } from '@/components/landing/GalaxyParticles';
import { PublicHeader } from '@/components/landing/PublicShell';
import { cn } from '@/lib/cn';
import { usePublicConfig } from '@/lib/queries';

/**
 * 登录 / 注册 / 找回密码 / 邮箱验证页的外壳，风格与首页一致：
 * 悬浮顶栏 + 星河粒子背景；有 aside 时宽屏左侧为介绍、右侧为表单卡片，否则表单卡片居中
 */
export function AuthShell({ aside, children, className }: { aside?: ReactNode; children: ReactNode; className?: string }) {
  const { data: cfg } = usePublicConfig();
  const siteName = cfg?.siteName ?? 'PaleDove';
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip bg-bg">
      <PublicHeader active="auth" />
      <section className="relative isolate flex flex-1 items-center overflow-hidden">
        {/* 与首页首屏相同的粒子背景：窄屏淡化，宽屏铺在右侧 2/3 */}
        <GalaxyParticles className="absolute inset-y-0 right-0 -z-10 h-full w-full opacity-35 sm:opacity-60 lg:w-[66%] lg:opacity-100 [mask-image:linear-gradient(90deg,transparent,#000_24%)]" />
        <div
          className={cn(
            'mx-auto grid w-full max-w-7xl gap-12 px-4 pt-24 pb-12 sm:px-6 sm:pt-28',
            aside ? 'lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:items-center lg:gap-16' : 'justify-items-center',
          )}
        >
          {aside && <div className="hidden min-w-0 lg:block">{aside}</div>}
          <div
            className={cn(
              'page-enter w-full max-w-[440px] justify-self-center rounded-2xl border border-line bg-surface/80 p-6 shadow-card backdrop-blur-xl backdrop-saturate-150 sm:p-8 lg:justify-self-end',
              !aside && 'lg:justify-self-center',
              className,
            )}
          >
            {children}
          </div>
        </div>
      </section>
      <footer className="px-4 pb-6 text-center text-xs text-fg-4">{cfg?.footer || `© ${new Date().getFullYear()} ${siteName}`}</footer>
    </div>
  );
}

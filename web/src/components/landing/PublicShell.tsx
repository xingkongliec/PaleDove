import { Menu as BaseMenu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ChevronDown, Menu, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { LanguageMenu, Logo, ThemeMenu } from '@/layouts/AppShell';
import { CountryFlag } from '@/components/country';
import { Tag } from '@/components/ui/misc';
import { LinkButton } from '@/components/ui/button';
import { PageTransition } from '@/components/PageTransition';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMe, usePublicConfig } from '@/lib/queries';
import type { PlanDTO, ProductDTO } from '../../shared/index';

/** 页内锚点平滑滚动；id 为 top 时回到页面顶部 */
export function scrollToId(id: string) {
  if (id === 'top') window.scrollTo({ top: 0, behavior: 'smooth' });
  else document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export interface PublicLink {
  /** 首页的板块 id，或 market 等独立页面的标识 */
  id: string;
  label: string;
  to: string;
}

/** 公开页顶栏的导航：首页 + 交易市场（未开放时页面里提示暂未开放） */
export function usePublicLinks(): PublicLink[] {
  const { t } = useI18n();
  return [
    { id: 'top', label: t('lp.nav.home'), to: '/' },
    { id: 'market', label: t('lp.nav.market'), to: '/market' },
  ];
}

/** 在售的地区（有在售套餐的地区，旗帜取自产品绑定的宿主机），供顶栏「云服务器」菜单使用 */
export function useSaleRegions() {
  const plans = useQuery({ queryKey: ['public-plans'], queryFn: () => api.get<PlanDTO[]>('/public/plans'), staleTime: 60_000 });
  const products = useQuery({ queryKey: ['public-products'], queryFn: () => api.get<ProductDTO[]>('/public/products'), staleTime: 60_000 });
  return useMemo(() => {
    const out: { name: string; country: string }[] = [];
    for (const plan of plans.data ?? []) {
      const product = (products.data ?? []).find((p) => p.id === plan.productId);
      for (const region of plan.regions) if (!out.some((r) => r.name === region)) out.push({ name: region, country: product?.regionCountry[region] ?? '' });
    }
    return out;
  }, [plans.data, products.data]);
}

const regionHref = (name: string) => `/store?region=${encodeURIComponent(name)}`;

/** 顶栏「云服务器」：鼠标悬停或点击展开，列出各地区，点击进入对应地区的购买页 */
function ServersMenu({ active, item }: { active: boolean; item: (on: boolean) => string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const regions = useSaleRegions();
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger openOnHover delay={80} closeDelay={120} onClick={() => navigate('/store')} className={cn(item(active), 'inline-flex items-center gap-1.5 outline-none focus-visible:ring-3 focus-visible:ring-ring')}>
        {t('lp.nav.cloud')}
        <Tag tone="warning" className="px-1.5 py-0 text-[10px] leading-4">
          HOT
        </Tag>
        <ChevronDown className="size-3.5 text-fg-4 transition-transform duration-200 in-data-popup-open:rotate-180" />
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner className="z-[70] outline-none" sideOffset={10} align="start">
          <BaseMenu.Popup className="popup-anim scrollbar-thin max-h-[70dvh] min-w-64 overflow-y-auto rounded-[12px] border border-line bg-surface p-2 shadow-[0_18px_50px_-12px_rgb(0_0_0/0.28)] outline-none">
            <div className="px-3 pt-1.5 pb-1 text-xs font-medium tracking-wide text-fg-4">{t('lp.nav.pickRegion')}</div>
            {regions.length === 0 && <div className="px-3 py-3 text-[13px] text-fg-3">{t('lp.nav.noRegions')}</div>}
            {regions.map((r) => (
              <BaseMenu.LinkItem
                key={r.name}
                render={<Link to={regionHref(r.name)} />}
                className="group/item flex cursor-pointer items-center gap-3 rounded-[8px] px-3 py-2 text-sm font-medium text-fg outline-none transition-colors duration-150 data-highlighted:bg-surface-3"
              >
                <CountryFlag code={r.country} className="h-5 w-[30px] rounded-[3px] shadow-sm ring-1 ring-line transition-transform duration-200 group-data-highlighted/item:scale-105" />
                <span className="min-w-0 flex-1 truncate">{t('lp.nav.regionServers', { region: r.name })}</span>
                <ArrowRight className="size-4 shrink-0 -translate-x-1 text-fg-4 opacity-0 transition-[opacity,translate] duration-200 group-data-highlighted/item:translate-x-0 group-data-highlighted/item:opacity-100" />
              </BaseMenu.LinkItem>
            ))}
            <div className="mx-1 mt-1.5 border-t border-line pt-1.5">
              <BaseMenu.LinkItem
                render={<Link to="/store" />}
                className="flex cursor-pointer items-center justify-between rounded-[8px] px-3 py-1.5 text-[13px] text-fg-3 outline-none transition-colors data-highlighted:bg-surface-3 data-highlighted:text-fg"
              >
                {t('lp.nav.allPlans')}
                <ArrowRight className="size-3.5" />
              </BaseMenu.LinkItem>
            </div>
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

/** 页脚「产品」栏：首页的各个板块 + 交易市场 */
function useFooterLinks(): PublicLink[] {
  const { t } = useI18n();
  const links = usePublicLinks();
  return [
    { id: 'servers', label: t('lp.nav.servers'), to: '/#servers' },
    { id: 'images', label: t('lp.nav.images'), to: '/#images' },
    { id: 'perks', label: t('lp.nav.perks'), to: '/#perks' },
    ...links.filter((l) => l.id === 'market'),
  ];
}

/** 链接点击：已经在首页时平滑滚动到板块，否则正常跳转（首页会按地址里的 # 滚动到对应板块） */
export function useLinkClick() {
  const { pathname } = useLocation();
  return (l: PublicLink, after?: () => void) => (e: MouseEvent) => {
    after?.();
    if (pathname === '/' && l.to.startsWith('/') && !l.to.startsWith('/market')) {
      e.preventDefault();
      scrollToId(l.id);
    }
  };
}

/** 悬浮在页面顶部的导航：顶部时透明，滚动后变成带边框的圆角胶囊 */
export function PublicHeader({ active }: { active: string }) {
  const { t } = useI18n();
  const { data: me } = useMe();
  const { data: cfg } = usePublicConfig();
  const links = usePublicLinks();
  const regions = useSaleRegions();
  const click = useLinkClick();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  const siteName = cfg?.siteName ?? 'PaleDove';
  const allowRegister = cfg?.allowRegister ?? true;
  const consoleHref = me ? (me.role === 'ADMIN' ? '/admin' : '/console/dashboard') : null;
  const consoleLabel = me?.role === 'ADMIN' ? t('shell.adminConsole') : t('home.nav.console');
  const item = (on: boolean) => cn('rounded-[8px] px-3 py-2 text-sm transition-colors', on ? 'bg-surface-3 font-medium text-fg' : 'text-fg-2 hover:bg-surface-3/70 hover:text-fg');
  return (
    <header className="fixed inset-x-0 top-0 z-40 px-3 pt-3 sm:px-4">
      <div
        className={cn(
          'mx-auto flex h-14 items-center gap-1 rounded-[12px] border px-3 transition-[max-width,background-color,border-color,box-shadow] duration-300 sm:px-4',
          scrolled ? 'max-w-[92rem]' : 'max-w-7xl',
          scrolled ? 'border-line bg-surface/80 shadow-card backdrop-blur-xl backdrop-saturate-150' : 'border-transparent bg-transparent',
        )}
      >
        <button type="button" aria-label={t('lp.nav.menu')} aria-expanded={open} onClick={() => setOpen(!open)} className="mr-1 flex size-9 items-center justify-center rounded-[8px] text-fg-2 hover:bg-surface-3 md:hidden">
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
        <Link to="/" onClick={click(links[0]!)} className="mr-3 rounded-md">
          <Logo name={siteName} compact />
        </Link>
        <nav className="hidden items-center gap-0.5 md:flex">
          {links.map((l) => (
            <Fragment key={l.id}>
              <Link to={l.to} onClick={click(l)} className={item(active === l.id)} aria-current={active === l.id ? 'page' : undefined}>
                {l.label}
              </Link>
              {l.id === 'top' && <ServersMenu active={active === 'store'} item={item} />}
            </Fragment>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeMenu />
          <LanguageMenu />
          {consoleHref ? (
            <LinkButton to={consoleHref} variant="primary" className="ml-1 rounded-[8px]">
              {consoleLabel}
              <ArrowRight />
            </LinkButton>
          ) : (
            <>
              <LinkButton to="/login" variant="secondary" className="ml-1 rounded-[8px]">
                {t('login.signIn')}
              </LinkButton>
              <LinkButton to={allowRegister ? '/register' : '/login'} variant="primary" className="rounded-[8px]">
                {t('lp.signUp')}
              </LinkButton>
            </>
          )}
        </div>
      </div>
      {open && (
        <nav className="mx-auto mt-2 max-w-7xl rounded-[12px] border border-line bg-surface/95 p-2 shadow-card backdrop-blur-xl md:hidden">
          {links.map((l) => (
            <Fragment key={l.id}>
              <Link to={l.to} onClick={click(l, () => setOpen(false))} className={cn(item(active === l.id), 'block')}>
                {l.label}
              </Link>
              {l.id === 'top' && (
                <div className="my-1 border-y border-line/70 py-1">
                  <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-1 text-xs text-fg-4">
                    {t('lp.nav.cloud')}
                    <Tag tone="warning" className="px-1.5 py-0 text-[10px] leading-4">
                      HOT
                    </Tag>
                  </div>
                  {regions.map((r) => (
                    <Link key={r.name} to={regionHref(r.name)} onClick={() => setOpen(false)} className="flex items-center gap-2.5 rounded-[8px] px-3 py-2 text-sm text-fg-2 hover:bg-surface-3/70 hover:text-fg">
                      <CountryFlag code={r.country} className="h-4 w-6 rounded-[3px]" />
                      {t('lp.nav.regionServers', { region: r.name })}
                    </Link>
                  ))}
                </div>
              )}
            </Fragment>
          ))}
        </nav>
      )}
    </header>
  );
}

function FooterColumn({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-[13px] font-semibold text-fg">{title}</h4>
      <div className="mt-4 flex flex-col gap-2.5 text-[13px] text-fg-3 [&>a]:transition-colors [&>a:hover]:text-fg">{children}</div>
    </div>
  );
}

export function PublicFooter({ wide = false }: { wide?: boolean }) {
  const { t } = useI18n();
  const { data: me } = useMe();
  const { data: cfg } = usePublicConfig();
  const links = useFooterLinks();
  const click = useLinkClick();
  const siteName = cfg?.siteName ?? 'PaleDove';
  const isAdmin = me?.role === 'ADMIN';
  const consoleHref = me ? (isAdmin ? '/admin' : '/console/dashboard') : null;
  return (
    <footer className="border-t border-line bg-surface-2/40">
      <div className={cn('mx-auto grid gap-10 px-4 py-14 sm:px-6 md:grid-cols-[1.7fr_1fr_1fr_1fr]', wide ? 'max-w-[92rem]' : 'max-w-7xl')}>
        <div>
          <Logo name={siteName} />
          <p className="mt-4 max-w-xs text-[13px] leading-relaxed text-fg-3">{t('home.footer.desc')}</p>
          <p className="mt-4 text-xs text-fg-4">{cfg?.footer || `© ${new Date().getFullYear()} ${siteName}. ${t('lp.footer.rights')}`}</p>
        </div>
        <FooterColumn title={t('lp.footer.product')}>
          {links.map((l) => (
            <Link key={l.id} to={l.to} onClick={click(l)}>
              {l.label}
            </Link>
          ))}
        </FooterColumn>
        <FooterColumn title={t('lp.footer.center')}>
          <Link to={consoleHref ?? '/login'}>{t('home.nav.console')}</Link>
          <Link to={me && !isAdmin ? '/console/instances' : '/login'}>{t('lp.footer.instances')}</Link>
          <Link to={me && !isAdmin ? '/console/billing' : '/login'}>{t('lp.footer.billing')}</Link>
          <Link to={me && !isAdmin ? '/console/tickets' : '/login'}>{t('lp.footer.tickets')}</Link>
        </FooterColumn>
        <FooterColumn title={t('lp.footer.legal')}>
          <Link to="/terms">{t('legal.terms')}</Link>
          <Link to="/privacy">{t('legal.privacy')}</Link>
          <Link to="/help">{t('documents.publicCenter')}</Link>
        </FooterColumn>
      </div>
    </footer>
  );
}

/** 公开页（交易市场等）的整体布局：悬浮导航 + 内容 + 页脚 */
export function PublicLayout({ active }: { active: string }) {
  return (
    <div className="flex min-h-dvh flex-col overflow-x-clip bg-bg">
      <PublicHeader active={active} />
      {/* 左右边距与顶栏一致，页面内容与 Logo 左边缘对齐 */}
      <main className="flex-1 px-3 pt-24 pb-16 sm:px-4 sm:pt-28">
        <div className="mx-auto max-w-[92rem] px-3 sm:px-4">
          <PageTransition><Outlet /></PageTransition>
        </div>
      </main>
      <PublicFooter wide />
    </div>
  );
}

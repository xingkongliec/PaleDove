import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronsUpDown, ExternalLink, Languages, LogOut, Moon, PanelLeft, Plus, Search, Settings, Shield, Sun, UserRound, Wallet } from 'lucide-react';
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { LOCALE_NAMES, LOCALES, type Locale, type MeDTO } from '../shared/index';
import { hasStoredLocale, useI18n, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatMoney } from '@/lib/format';
import { OAuthBindBanner } from '@/components/OAuthBindBanner';
import { MaintenanceBanner, MaintenancePage } from '@/components/Maintenance';
import { usePreferenceSync } from '@/lib/preferences';
import { prefetchAll, prefetchRoute } from '@/lib/routes';
import { useCurrency, useMe, usePublicConfig } from '@/lib/queries';
import { resolvedTheme, THEME_EVENT, toggleTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PageTransition } from '@/components/PageTransition';
import { UserAvatar } from '@/components/UserAvatar';
import { DropdownMenu } from '@/components/ui/menu';
import { PageLoading, Tooltip } from '@/components/ui/misc';
import { CommandPalette } from './CommandPalette';
import { Notifications } from './Notifications';
import { TasksPopover } from './TasksPopover';

export interface NavItem {
  to: string;
  label: MessageKey;
  icon: ReactNode;
  end?: boolean;
  /** 不在侧边栏单列、但归属此项的页面（如购买实例归属“实例”） */
  also?: string[];
}

export interface NavGroup {
  title?: MessageKey;
  items: NavItem[];
}

/** 统一的品牌图片；自定义图标加载失败时使用项目默认 Logo。 */
export function LogoMark({ className }: { className?: string }) {
  const { data: cfg } = usePublicConfig();
  const [failedIcon, setFailedIcon] = useState<string | null>(null);
  if (cfg?.icon && failedIcon !== cfg.icon) return <img src={cfg.icon} alt="" className={cn('shrink-0 object-contain', className)} onError={() => setFailedIcon(cfg.icon)} />;
  return <img src="/logo.png" alt="" className={cn('shrink-0 rounded-lg object-contain', className)} />;
}

export function Logo({ name, compact }: { name?: string; compact?: boolean }) {
  const { data: cfg } = usePublicConfig();
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <LogoMark className="size-7" />
      <span className={cn('max-w-40 truncate text-[15px] font-semibold text-fg', compact && 'hidden min-[380px]:inline')}>{name ?? cfg?.siteName ?? 'PaleDove'}</span>
    </span>
  );
}

const iconBtn = 'flex size-8 shrink-0 items-center justify-center rounded-md text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg data-popup-open:bg-surface-3 [&>svg]:size-[17px]';

export function LanguageMenu({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <DropdownMenu
      trigger={
        <button type="button" aria-label={t('shell.language')} title={t('shell.language')} className={cn(iconBtn, className)}>
          <Languages />
        </button>
      }
      items={LOCALES.map((l) => ({ label: LOCALE_NAMES[l], checked: l === locale, onClick: () => setLocale(l) }))}
      className="min-w-36"
    />
  );
}

/** 明暗切换：单个按钮，太阳 / 月亮图标随当前主题切换 */
export function ThemeMenu({ className }: { className?: string }) {
  const { t } = useI18n();
  const [theme, setTheme] = useState(() => resolvedTheme());
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setTheme(resolvedTheme());
    mq.addEventListener('change', sync);
    window.addEventListener(THEME_EVENT, sync);
    return () => {
      mq.removeEventListener('change', sync);
      window.removeEventListener(THEME_EVENT, sync);
    };
  }, []);
  return (
    <button type="button" aria-label={t('shell.toggleTheme')} title={t('shell.toggleTheme')} className={cn(iconBtn, className)} onClick={() => toggleTheme()}>
      {theme === 'dark' ? <Moon /> : <Sun />}
    </button>
  );
}

function ImpersonationBanner({ me }: { me: MeDTO }) {
  const { rich, t } = useI18n();
  const stop = useMutation({
    mutationFn: () => api.post('/auth/stop-impersonate'),
    // 整页跳转：避免用户控制台的页面用管理员会话重新请求而报无权限
    onSuccess: () => window.location.assign('/admin/users'),
    onError: (e) => toast.fromError(e),
  });
  if (!me.impersonatedBy) return null;
  return (
    <div className="flex h-9 shrink-0 items-center justify-center gap-3 truncate border-b border-warning-icon/20 bg-warning-soft px-4 text-xs text-warning-text">
      <Shield className="size-3.5 shrink-0" />
      <span className="truncate">{rich('shell.impersonating', { admin: <b>{me.impersonatedBy.username}</b>, user: <b>{me.username}</b> })}</span>
      <button className="shrink-0 font-semibold underline underline-offset-2" onClick={() => stop.mutate()} disabled={stop.isPending}>
        {t('shell.backToAdmin')}
      </button>
    </div>
  );
}

// ───────────── 侧边栏 ─────────────

const COLLAPSE_KEY = 'paledove-sidebar-collapsed';
const GROUPS_KEY = 'paledove-nav-groups';

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式等情况下忽略 */
  }
}

/** 当前路径匹配的导航项（取最长匹配），用于顶栏标题与分组自动展开 */
const underPath = (pathname: string, to: string) => pathname === to || pathname.startsWith(`${to}/`);

function activeItem(nav: NavGroup[], pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of nav.flatMap((g) => g.items)) {
    const hit = item.end ? pathname === item.to : underPath(pathname, item.to) || !!item.also?.some((p) => underPath(pathname, p));
    if (hit && (!best || item.to.length > best.to.length)) best = item;
  }
  return best;
}

function NavLinkItem({ item, collapsed, onNavigate }: { item: NavItem; collapsed?: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const aliasActive = !!item.also?.some((p) => underPath(pathname, p));
  const link = (
    <NavLink
      to={item.to}
      end={item.end}
      onClick={onNavigate}
      // 悬停或获得焦点时预加载页面代码，点击后不用再等下载
      onMouseEnter={() => prefetchRoute(item.to)}
      onFocus={() => prefetchRoute(item.to)}
      aria-label={collapsed ? t(item.label) : undefined}
      className={({ isActive }) =>
        cn(
          'group/item flex h-8 items-center gap-2.5 rounded-md text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring',
          collapsed ? 'w-8 justify-center' : 'px-2',
          isActive || aliasActive ? 'bg-surface-3 font-medium text-fg [&_svg]:text-fg' : 'text-fg-2 hover:bg-surface-3/70 hover:text-fg [&_svg]:text-fg-3 hover:[&_svg]:text-fg-2',
        )
      }
    >
      <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4 [&>svg]:stroke-[1.75] [&>svg]:transition-colors">{item.icon}</span>
      {!collapsed && <span className="truncate">{t(item.label)}</span>}
    </NavLink>
  );
  return collapsed ? (
    <Tooltip content={t(item.label)} side="right">
      {link}
    </Tooltip>
  ) : (
    link
  );
}

/** 导航分组：标题可点击折叠（状态保存在本机），包含当前页面的分组始终展开 */
function Navigation({ nav, collapsed, onNavigate }: { nav: NavGroup[]; collapsed?: boolean; onNavigate?: () => void }) {
  const { t } = useI18n();
  const { pathname } = useLocation();
  const [closed, setClosed] = useState<string[]>(() => readStored<string[]>(GROUPS_KEY, []));
  const current = activeItem(nav, pathname);
  const toggle = (title: string) => {
    const next = closed.includes(title) ? closed.filter((x) => x !== title) : [...closed, title];
    setClosed(next);
    writeStored(GROUPS_KEY, next);
  };
  return (
    <nav aria-label={t('shell.mainNav')} className={cn('space-y-5', collapsed && 'flex flex-col items-center space-y-3')}>
      {nav.map((group, gi) => {
        const open = !group.title || collapsed || !closed.includes(group.title) || group.items.some((i) => i === current);
        return (
          <div key={gi} className={cn(collapsed && 'flex flex-col items-center')}>
            {group.title &&
              (collapsed ? (
                <div className="mb-3 h-px w-6 bg-line" />
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(group.title!)}
                  aria-expanded={open}
                  className="group/label mb-0.5 flex h-7 w-full items-center justify-between rounded-md px-2 text-xs font-medium text-fg-3 transition-colors hover:text-fg-2"
                >
                  {t(group.title)}
                  <ChevronDown className={cn('size-3.5 text-fg-4 transition-[transform,opacity] duration-200 group-hover/label:opacity-100', open ? 'opacity-0' : '-rotate-90 opacity-100')} />
                </button>
              ))}
            <div className={cn('grid transition-[grid-template-rows] duration-200 ease-smooth', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
              <div className={cn('min-h-0 space-y-0.5 overflow-hidden', collapsed && 'flex flex-col items-center')}>
                {group.items.map((item) => (
                  <NavLinkItem key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
                ))}
              </div>
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/** 当前用户头像（风格在账户设置中选择） */
function Avatar({ me, className }: { me: MeDTO; className?: string }) {
  return <UserAvatar avatar={me.avatar} name={me.name || me.username} size={32} className={className} />;
}

/** 侧边栏底部的账户菜单 */
function AccountMenu({ me, area, collapsed, onLogout }: { me: MeDTO; area: 'user' | 'admin'; collapsed?: boolean; onLogout: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const currency = useCurrency();
  return (
    <DropdownMenu
      align={collapsed ? 'start' : 'center'}
      trigger={
        <button
          type="button"
          aria-label={t('shell.accountMenu')}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg text-left outline-none transition-colors hover:bg-surface-3/70 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-surface-3',
            collapsed ? 'justify-center p-1' : 'p-2',
          )}
        >
          <Avatar me={me} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-medium text-fg">{me.name || me.username}</span>
                <span className="block truncate text-xs text-fg-3">{me.email}</span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-fg-3" />
            </>
          )}
        </button>
      }
      header={
        <div className="mb-1 flex items-center gap-2.5 border-b border-line px-2 pt-1.5 pb-2.5">
          <Avatar me={me} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-fg">{me.name || me.username}</span>
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-surface-3 px-1.5 py-px text-[10px] text-fg-2">
                {me.role === 'ADMIN' ? t('shell.roleAdmin') : t('shell.roleUser')}
              </span>
            </div>
            <div className="truncate text-xs text-fg-3">{me.email}</div>
          </div>
          {area === 'user' && <span className="tabular shrink-0 text-xs font-medium text-fg">{formatMoney(me.balance, currency)}</span>}
        </div>
      }
      items={[
        { label: t('nav.account'), icon: <UserRound />, onClick: () => navigate(area === 'admin' ? '/admin/account' : '/console/account') },
        { label: t('nav.billing'), icon: <Wallet />, hidden: area === 'admin', onClick: () => navigate('/console/billing') },
        { separator: true, label: '' },
        { label: t('shell.logout'), icon: <LogOut />, onClick: onLogout, danger: true },
      ]}
      className="min-w-60"
    />
  );
}

/** 侧边栏内容：顶部品牌、中间导航、底部账户（桌面端与手机抽屉共用） */
function SidebarContent({
  nav,
  area,
  me,
  collapsed,
  onNavigate,
  onLogout,
}: {
  nav: NavGroup[];
  area: 'user' | 'admin';
  me: MeDTO;
  collapsed?: boolean;
  onNavigate?: () => void;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const { data: cfg } = usePublicConfig();
  return (
    <div className="flex h-full flex-col">
      <Link
        to={area === 'admin' ? '/admin' : '/console/dashboard'}
        onClick={onNavigate}
        className={cn('mt-2 flex shrink-0 items-center gap-2.5 rounded-lg transition-colors hover:bg-surface-3/70', collapsed ? 'mx-1.5 justify-center p-1' : 'mx-3 p-2')}
      >
        <LogoMark className="size-8 rounded-lg" />
        {!collapsed && (
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-[14px] font-semibold text-fg">{cfg?.siteName ?? 'PaleDove'}</span>
            <span className="block truncate text-xs text-fg-3">{area === 'admin' ? t('shell.adminConsole') : t('shell.console')}</span>
          </span>
        )}
      </Link>
      <div className={cn('scrollbar-thin min-h-0 flex-1 overflow-x-hidden overflow-y-auto pt-3 pb-4', collapsed ? 'px-1.5' : 'px-3')}>
        <Navigation nav={nav} collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      <div className={cn('shrink-0 pb-[max(0.5rem,env(safe-area-inset-bottom))]', collapsed ? 'px-1.5' : 'px-3')}>
        <AccountMenu me={me} area={area} collapsed={collapsed} onLogout={onLogout} />
      </div>
    </div>
  );
}

// ───────────── 外壳 ─────────────

const SIDEBAR_W = 'lg:pl-[15.5rem]';
const SIDEBAR_W_COLLAPSED = 'lg:pl-14';

export function AppShell({ nav, area }: { nav: NavGroup[]; area: 'user' | 'admin' }) {
  const { t, locale, setLocale } = useI18n();
  const { data: me } = useMe();
  usePreferenceSync(me);
  // 登录后在浏览器空闲时预加载该角色会用到的页面
  useEffect(() => prefetchAll(area === 'admin'), [area]);
  const { data: cfg } = usePublicConfig();
  const maintenance = cfg?.maintenance;
  const blocked = area === 'user' && maintenance?.state === 'active' && maintenance.scope === 'FULL' && !maintenance.exempt;
  const currency = useCurrency();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => readStored<boolean>(COLLAPSE_KEY, false));
  const [searchOpen, setSearchOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // 桌面端内容在圆角面板内滚动；顶栏高度供页面里的吸顶元素避让
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const [headerH, setHeaderH] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeaderH(el.offsetHeight));
    ro.observe(el);
    setHeaderH(el.offsetHeight);
    return () => ro.disconnect();
  }, [me]);

  // 内容滚动后顶栏才显示分隔线
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    const onScroll = () => setScrolled((el?.scrollTop ?? 0) > 0 || window.scrollY > 0);
    el?.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el?.removeEventListener('scroll', onScroll);
      window.removeEventListener('scroll', onScroll);
    };
  }, [me]);

  useEffect(() => setMobileOpen(false), [location.pathname]);
  // 切换页面时回到顶部（桌面端滚动的是内容面板，手机端是窗口）
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }, [location.pathname]);
  useEffect(() => {
    if (cfg?.siteName) document.title = area === 'admin' ? t('shell.adminTitle', { site: cfg.siteName }) : cfg.siteName;
  }, [cfg?.siteName, area, t]);
  // 未在本机选择过语言时，沿用账户中保存的语言偏好
  useEffect(() => {
    if (me?.locale && !hasStoredLocale() && me.locale !== locale && (LOCALES as readonly string[]).includes(me.locale)) {
      setLocale(me.locale as Locale);
    }
  }, [me?.locale, locale, setLocale]);
  // Ctrl / ⌘ + K 打开全局搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writeStored(COLLAPSE_KEY, !c);
      return !c;
    });
  };

  const logout = useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSettled: () => {
      qc.clear();
      navigate('/login', { replace: true });
      toast.success(t('shell.signedOutToast'));
    },
  });

  // 第三方登录由服务端完成后跳回控制台，带 ?signed_in=1：提示登录成功并从地址栏移除
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (!params.has('signed_in') || !me) return;
    toast.success(t('login.signedInToast'), t('login.welcome', { name: me.name || me.username }));
    params.delete('signed_in');
    const qs = params.toString();
    navigate(`${location.pathname}${qs ? `?${qs}` : ''}`, { replace: true });
  }, [location.search, location.pathname, me, navigate, t]);

  if (!me) return null;
  const style = { '--header-h': `${headerH ?? 56}px` } as CSSProperties;
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const current = activeItem(nav, location.pathname);

  const quickActions =
    area === 'admin'
      ? [{ label: t('nav.admin.addNode'), to: '/admin/nodes/new', icon: <Plus /> }]
      : [
          { label: t('nav.store'), to: '/console/store', icon: <Plus /> },
          { label: t('shell.topUp'), to: '/console/billing?topup=1', icon: <Wallet /> },
        ];
  const headerLink = (to: string, label: string, icon: ReactNode, external = false) => (
    <Tooltip content={label} side="bottom">
      {external ? (
        <a href={to} target="_blank" rel="noreferrer" aria-label={label} className={iconBtn}>
          {icon}
        </a>
      ) : (
        <Link to={to} aria-label={label} className={iconBtn}>
          {icon}
        </Link>
      )}
    </Tooltip>
  );

  return (
    <div className="min-h-dvh bg-sidebar" style={style}>
      {/* 桌面端侧边栏：可收起为图标栏 */}
      <aside
        className={cn('fixed inset-y-0 left-0 z-30 hidden overflow-hidden transition-[width] duration-300 ease-smooth lg:block', collapsed ? 'w-14' : 'w-[15.5rem]', blocked && 'lg:hidden')}
      >
        <SidebarContent nav={nav} area={area} me={me} collapsed={collapsed} onLogout={() => logout.mutate()} />
      </aside>

      {/* 手机端抽屉 */}
      <div className={cn('fixed inset-0 z-50 lg:hidden', !mobileOpen && 'pointer-events-none')} aria-hidden={!mobileOpen} inert={!mobileOpen}>
        <div className={cn('absolute inset-0 bg-overlay transition-opacity duration-300', mobileOpen ? 'opacity-100' : 'opacity-0')} onClick={() => setMobileOpen(false)} />
        <aside className={cn('drawer-panel absolute inset-y-0 left-0 w-72 max-w-[85vw] border-r border-line bg-sidebar shadow-card', mobileOpen ? 'translate-x-0' : '-translate-x-full')}>
          <SidebarContent nav={nav} area={area} me={me} onNavigate={() => setMobileOpen(false)} onLogout={() => logout.mutate()} />
        </aside>
      </div>

      {/* 内容面板建立定位边界，避免绝对定位的隐藏标签越过滚动区域撑高整页。 */}
      <div className={cn('transition-[padding] duration-300 ease-smooth lg:py-2 lg:pr-2', blocked ? '' : collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W)}>
        <div
          ref={scrollRef}
          className="scrollbar-thin console-scroll relative flex min-h-dvh flex-col bg-bg lg:h-[calc(100dvh-1rem)] lg:min-h-0 lg:overflow-y-auto lg:overscroll-y-contain lg:rounded-xl lg:border lg:border-line lg:shadow-xs"
        >
          <header
            ref={headerRef}
            className={cn('sticky top-0 z-20 shrink-0 border-b bg-bg/95 transition-colors', scrolled ? 'border-line' : 'border-transparent')}
          >
            <ImpersonationBanner me={me} />
            <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
              <button className={cn(iconBtn, 'lg:hidden')} onClick={() => setMobileOpen(true)} aria-label={t('shell.openMenu')}>
                <PanelLeft />
              </button>
              <Tooltip content={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')} side="bottom">
                <button className={cn(iconBtn, 'hidden lg:flex')} onClick={toggleCollapsed} aria-label={collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')}>
                  <PanelLeft />
                </button>
              </Tooltip>
              <span className="h-4 w-px shrink-0 bg-line" />
              <span className="min-w-0 truncate pl-1 text-[14px] font-medium text-fg">{current ? t(current.label) : area === 'admin' ? t('shell.adminConsole') : t('shell.console')}</span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setSearchOpen(true)}
                className="mr-1 hidden h-8 w-48 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[13px] text-fg-4 transition-colors hover:border-line-strong xl:flex"
              >
                <Search className="size-3.5" />
                <span className="flex-1 text-left">{t('shell.search')}</span>
                <kbd className="rounded border border-line px-1.5 font-mono text-[10px] leading-4 text-fg-4">{isMac ? '⌘ K' : 'Ctrl K'}</kbd>
              </button>
              <div className="flex items-center gap-0.5">
                <button className={cn(iconBtn, 'xl:hidden')} onClick={() => setSearchOpen(true)} aria-label={t('shell.search')}>
                  <Search />
                </button>
                {area === 'user' && (
                  <Link
                    to="/console/billing"
                    title={t('shell.balance')}
                    className="mr-1 hidden h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-[13px] transition-colors hover:border-line-strong sm:flex"
                  >
                    <Wallet className="size-3.5 text-fg-3" />
                    <span className="tabular font-medium text-fg">{formatMoney(me.balance, currency)}</span>
                  </Link>
                )}
                <Notifications />
                {area === 'admin' && <span className="hidden sm:contents"><TasksPopover /></span>}
                <span className="hidden sm:contents">{headerLink('/', t('shell.visitSite'), <ExternalLink />, true)}</span>
                {area === 'admin' && <span className="hidden sm:contents">{headerLink('/admin/settings', t('nav.admin.settings'), <Settings />)}</span>}
                <LanguageMenu className="hidden min-[400px]:flex" />
                <ThemeMenu />
              </div>
            </div>
            {maintenance && <MaintenanceBanner m={maintenance} admin={area === 'admin'} />}
          </header>

          <main className="w-full flex-1 p-4 lg:px-6 lg:py-7">
            {area === 'user' && !blocked && <OAuthBindBanner />}
            <div className="route-view">
              {/* 保持边界挂载：代码下载期间由路由 transition 保留当前页，准备好后再切换。 */}
              {blocked ? <MaintenancePage m={maintenance!} /> : (
                <ErrorBoundary resetKey={location.pathname}>
                  <Suspense fallback={<PageLoading />}>
                    <PageTransition><Outlet key={location.pathname} /></PageTransition>
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          </main>
          {cfg?.footer && <footer className="px-6 pb-8 text-center text-xs text-fg-4">{cfg.footer}</footer>}
        </div>
      </div>

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} nav={nav} area={area} extra={quickActions} />
    </div>
  );
}

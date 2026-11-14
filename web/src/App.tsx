import {
  ArrowRightLeft,
  Boxes,
  Gift,
  BookOpen,
  IdCard,
  Layers,
  LayoutGrid,
  ListChecks,
  Megaphone,
  MessagesSquare,
  Package,
  Calculator,
  TicketPercent,
  ScrollText,
  Network,
  Server,
  Settings,
  Store as MarketIcon,
  Tag as TagIcon,
  SquareTerminal,
  UserCog,
  Users,
  Wallet,
  ReceiptText,
  Radar,
  MoonStar,
} from 'lucide-react';
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router';
import { AppShell, type NavGroup } from './layouts/AppShell';
import { TopProgress } from './components/TopProgress';
import { RouteContent } from './components/RouteContent';
import { PageTransition } from './components/PageTransition';
import { SitePopups } from './components/SitePopups';
import { FullPageLoading } from './components/ui/misc';
import { setUnauthorizedHandler } from './lib/api';
import { queryClient, useMe, usePublicConfig } from './lib/queries';
import { loaders } from './lib/routes';
import { trackLoading } from './lib/loading';
import { useRoutePrefetch } from './lib/route-prefetch';
import { useInteractionFeedback } from './hooks/interaction-feedback';
import { PublicLayout } from './components/landing/PublicShell';
import LoginPage from './pages/auth/Login';
import { consoleRedirect, LEGACY_CONSOLE_PATHS } from './shared/index';

// 页面按路由拆分：首屏只加载布局和当前页，其余在访问时下载；加载函数与预加载共用（lib/routes.ts）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const def = (load: () => Promise<unknown>) => lazy(() => trackLoading(load()) as Promise<{ default: ComponentType<any> }>);

const HomePage = def(loaders.home);
const Dashboard = def(loaders.dashboard);
const Store = def(loaders.store);
const NightMarket = def(loaders.nightMarket);
const AdminNightMarket = def(loaders.adminNightMarket);
const Instances = def(loaders.instances);
const Vpcs = def(loaders.vpcs);
const InstanceDetail = def(loaders.instanceDetail);
const Billing = def(loaders.billing);
const Invoices = def(loaders.invoices);
const InvoiceDetail = def(loaders.invoiceDetail);
const Affiliate = def(loaders.affiliate);
const Account = def(loaders.account);
const TerminalPage = def(loaders.terminal);
const TransferPage = def(loaders.transfer);
const ApiDocs = def(loaders.apiDocs);
const Activity = def(loaders.activity);
const Notifications = def(loaders.notifications);
const Tickets = def(loaders.tickets);
const VerifyEmail = def(loaders.verifyEmail);
const LegalPage = def(loaders.legal);
const DocumentsPage = def(loaders.documents);
const DocumentDetail = def(loaders.documentDetail);
const MarketPage = def(loaders.market);
const MyListingsPage = def(loaders.marketMine);
const AdminMarket = def(loaders.adminMarket);
const PasswordReset = def(loaders.passwordReset);

const AdminDashboard = def(loaders.adminDashboard);
const AdminInstances = def(loaders.adminInstances);
const AdminNodes = def(loaders.adminNodes);
const AdminPing = def(loaders.adminPing);
const AdminNodeDetail = def(loaders.adminNodeDetail);
const AdminNodeCreate = def(loaders.adminNodeCreate);
const AdminNodeEdit = def(loaders.adminNodeEdit);
const AdminPlans = def(loaders.adminPlans);
const AdminPlanEdit = def(loaders.adminPlanEdit);
const AdminProductDetail = def(loaders.adminProductDetail);
const AdminInstanceCreate = def(loaders.adminInstanceCreate);
const AdminImages = def(loaders.adminImages);
const AdminUsers = def(loaders.adminUsers);
const AdminUserCreate = def(loaders.adminUserCreate);
const AdminUserDetail = def(loaders.adminUserDetail);
const AdminRealname = def(loaders.adminRealname);
const AdminBilling = def(loaders.adminBilling);
const AdminInvoiceDetail = def(loaders.adminInvoiceDetail);
const AdminPromotions = def(loaders.adminPromotions);
const AdminAffiliate = def(loaders.adminAffiliate);
const AdminCouponEdit = def(loaders.adminCouponEdit);
const AdminAnnouncements = def(loaders.adminAnnouncements);
const AdminDocuments = def(loaders.adminDocuments);
const AdminTasks = def(loaders.adminTasks);
const AdminSettings = def(loaders.adminSettings);

/** 用户侧边栏；「邀请推广」在管理员开启推广返利后显示 */
const userNav = (aff: boolean, nightMarket: boolean): NavGroup[] => [
  { items: [{ to: '/console/dashboard', label: 'nav.dashboard', icon: <LayoutGrid />, end: true }] },
  {
    title: 'nav.group.cloud',
    items: [
      // 购买实例不单列，从实例列表等入口进入，侧边栏高亮“实例”
      { to: '/console/instances', label: 'nav.instances', icon: <Server />, also: ['/console/store'] },
      { to: '/console/vpc', label: 'nav.vpc', icon: <Network /> },
      { to: '/console/terminal', label: 'nav.terminal', icon: <SquareTerminal /> },
      { to: '/console/transfer', label: 'nav.transfer', icon: <ArrowRightLeft /> },
      { to: '/console/marketplace', label: 'nav.market', icon: <MarketIcon />, end: true },
      { to: '/console/marketplace/mine', label: 'nav.marketMine', icon: <TagIcon /> },
      ...(nightMarket ? [{ to: '/console/night-market', label: 'night.title' as const, icon: <MoonStar /> }] : []),
    ],
  },
  {
    title: 'nav.group.manage',
    items: [
      { to: '/console/activity', label: 'nav.activity', icon: <ScrollText /> },
      { to: '/console/billing', label: 'nav.billing', icon: <Wallet /> },
      { to: '/console/invoices', label: 'nav.invoices', icon: <ReceiptText /> },
      ...(aff ? [{ to: '/console/invite', label: 'nav.invite' as const, icon: <Gift /> }] : []),
      { to: '/console/tickets', label: 'ticket.title', icon: <MessagesSquare /> },
      { to: '/console/documents', label: 'documents.publicCenter', icon: <BookOpen /> },
      // API 文档从“账号设置 → API 令牌”进入
      { to: '/console/account', label: 'nav.account', icon: <UserCog />, also: ['/console/docs/api'] },
    ],
  },
];

const adminNav: NavGroup[] = [
  { items: [{ to: '/admin', label: 'nav.admin.dashboard', icon: <LayoutGrid />, end: true }] },
  {
    title: 'nav.group.resources',
    items: [
      { to: '/admin/users', label: 'nav.admin.users', icon: <Users /> },
      { to: '/admin/instances', label: 'nav.admin.instances', icon: <Boxes /> },
      { to: '/admin/realname', label: 'nav.admin.realname', icon: <IdCard /> },
    ],
  },
  {
    title: 'nav.group.infra',
    items: [
      { to: '/admin/nodes', label: 'nav.admin.nodes', icon: <Server /> },
      { to: '/admin/ping', label: 'nav.admin.ping', icon: <Radar /> },
      { to: '/admin/plans', label: 'nav.admin.plans', icon: <Package />, also: ['/admin/products'] },
      { to: '/admin/images', label: 'nav.admin.images', icon: <Layers /> },
    ],
  },
  {
    title: 'nav.group.business',
    items: [
      { to: '/admin/billing', label: 'nav.admin.billing', icon: <Calculator /> },
      { to: '/admin/market', label: 'nav.admin.market', icon: <MarketIcon /> },
      { to: '/admin/promotions', label: 'nav.admin.promotions', icon: <TicketPercent /> },
      { to: '/admin/affiliate', label: 'nav.admin.affiliate', icon: <Gift /> },
      { to: '/admin/night-market', label: 'night.adminTitle', icon: <MoonStar /> },
      { to: '/admin/announcements', label: 'nav.admin.announcements', icon: <Megaphone /> },
      { to: '/admin/documents', label: 'nav.admin.documents', icon: <BookOpen /> },
      { to: '/admin/tasks', label: 'nav.admin.tasks', icon: <ListChecks /> },
      { to: '/admin/tickets', label: 'ticket.title', icon: <MessagesSquare /> },
      { to: '/admin/settings', label: 'nav.admin.settings', icon: <Settings /> },
      { to: '/admin/account', label: 'nav.account', icon: <UserCog /> },
    ],
  },
];

function RequireAuth({ admin = false, children }: { admin?: boolean; children: ReactNode }) {
  const { data: me, isLoading } = useMe();
  const location = useLocation();
  if (isLoading) return <FullPageLoading />;
  if (!me) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search + location.hash)}`} replace />;
  if (admin && me.role !== 'ADMIN') return <Navigate to="/console/dashboard" replace />;
  if (!admin && me.role !== 'USER') return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

/** 交易市场与购买页：登录与否都使用公开页外壳（顶栏 + 页脚），不跳进控制台；管理员访问购买页时回到后台 */
function MarketLayout({ active, adminTo }: { active: string; adminTo?: string }) {
  const { data: me, isLoading } = useMe();
  if (isLoading) return <FullPageLoading />;
  if (me?.role === 'ADMIN' && adminTo) return <Navigate to={adminTo} replace />;
  return <PublicLayout active={active} />;
}

function LegacyConsoleRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={`${consoleRedirect(pathname) ?? '/console/dashboard'}${search}${hash}`} replace />;
}

export default function App() {
  useRoutePrefetch();
  useInteractionFeedback();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: site } = usePublicConfig();
  const { data: me } = useMe();
  useEffect(() => { void queryClient.invalidateQueries({ queryKey: ['public-config'] }); }, [me?.id]);
  useEffect(() => {
    const reload = () => { void queryClient.invalidateQueries({ queryKey: ['public-config'] }); };
    window.addEventListener('pd:maintenance', reload);
    return () => window.removeEventListener('pd:maintenance', reload);
  }, []);
  useEffect(() => {
    let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.append(icon); }
    icon.href = site?.icon || '/logo.png';
    icon.removeAttribute('type');
  }, [site?.icon]);
  useEffect(() => {
    if (site?.siteName && ['/', '/login', '/verify-email'].includes(location.pathname)) document.title = site.siteName;
  }, [site?.siteName, location.pathname]);
  useEffect(() => {
    // 会话失效时清空缓存并回到登录页
    setUnauthorizedHandler(() => {
      queryClient.setQueryData(['me'], null);
      navigate(`/login?redirect=${encodeURIComponent(window.location.pathname + window.location.search + window.location.hash)}`, { replace: true });
    });
  }, [navigate]);

  return (
    <>
    <TopProgress />
    <SitePopups />
    <Suspense fallback={<FullPageLoading />}>
    <RouteContent>
    <Routes>
      <Route element={<PageTransition fadeOnly preserveAnimations={location.pathname === '/'}><Outlet /></PageTransition>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<LoginPage mode="register" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/help" element={<DocumentsPage />} />
        <Route path="/help/:slug" element={<LegalPage />} />
        <Route path="/forgot-password" element={<PasswordReset />} />
        <Route path="/reset-password" element={<PasswordReset reset />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
      </Route>
      {/* 交易市场：从首页进入时，登录与否都在公开页外壳里；控制台侧边栏的「交易市场」「我的上架」是 /console/marketplace 与 /console/marketplace/mine */}
      {/* 购买页：从首页进入时登录与否都在公开页外壳里，游客也能浏览并选配置，付款时再登录；管理员回到后台。控制台里的购买页是 /console/store */}
      <Route element={<MarketLayout active="store" adminTo="/admin" />}>
        <Route path="/store" element={<Store />} />
      </Route>
      <Route element={<MarketLayout active="market" />}>
        <Route path="/market" element={<MarketPage />} />
      </Route>
      {LEGACY_CONSOLE_PATHS.map((path) => <Route key={path} path={`${path}/*`} element={<LegacyConsoleRedirect />} />)}
      <Route
        path="/console"
        element={
          <RequireAuth>
            <AppShell nav={userNav(!!site?.affEnabled, !!site?.nightMarketEnabled)} area="user" />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/console/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="instances" element={<Instances />} />
        <Route path="vpc" element={<Vpcs />} />
        <Route path="instances/:id" element={<InstanceDetail />} />
        <Route path="billing" element={<Billing />} />
        <Route path="invoices" element={<Invoices />} />
        <Route path="invoices/:id" element={<InvoiceDetail />} />
        <Route path="invite" element={<Affiliate />} />
        <Route path="account" element={<Account />} />
        <Route path="terminal" element={<TerminalPage />} />
        <Route path="docs/api" element={<ApiDocs />} />
        <Route path="transfer" element={<TransferPage />} />
        {/* 控制台里的购买页与交易市场（/console/...）；从首页进入的 /store、/market 在公开页外壳里 */}
        <Route path="store" element={<Store />} />
        <Route path="night-market" element={<NightMarket />} />
        <Route path="marketplace" element={<MarketPage />} />
        <Route path="marketplace/mine" element={<MyListingsPage />} />
        <Route path="documents" element={<DocumentsPage consoleView />} />
        <Route path="documents/:slug" element={<DocumentDetail />} />
        <Route path="activity" element={<Activity />} />
        <Route path="notifications" element={<Notifications />} />
        <Route path="tickets" element={<Tickets />} />
        <Route path="tickets/new" element={<Tickets create />} />
        <Route path="tickets/:id" element={<Tickets />} />
      </Route>
      <Route
        path="/admin"
        element={
          <RequireAuth admin>
            <AppShell nav={adminNav} area="admin" />
          </RequireAuth>
        }
      >
        <Route index element={<AdminDashboard />} />
        <Route path="instances" element={<AdminInstances />} />
        <Route path="instances/new" element={<AdminInstanceCreate />} />
        <Route path="instances/:id" element={<InstanceDetail admin />} />
        <Route path="nodes" element={<AdminNodes />} />
        <Route path="ping" element={<AdminPing />} />
        <Route path="nodes/new" element={<AdminNodeCreate />} />
        <Route path="nodes/:id" element={<AdminNodeDetail />} />
        <Route path="nodes/:id/edit" element={<AdminNodeEdit />} />
        <Route path="plans" element={<AdminPlans />} />
        <Route path="plans/new" element={<AdminPlanEdit />} />
        <Route path="plans/:id/edit" element={<AdminPlanEdit />} />
        <Route path="products/:id" element={<AdminProductDetail />} />
        <Route path="images" element={<AdminImages />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="users/new" element={<AdminUserCreate />} />
        <Route path="users/:id" element={<AdminUserDetail />} />
        <Route path="realname" element={<AdminRealname />} />
        <Route path="finance" element={<Navigate to="/admin/billing?tab=orders" replace />} />
        <Route path="billing" element={<AdminBilling />} />
        <Route path="billing/invoices/:id" element={<AdminInvoiceDetail />} />
        <Route path="market" element={<AdminMarket />} />
        <Route path="promotions" element={<AdminPromotions />} />
        <Route path="affiliate" element={<AdminAffiliate />} />
        <Route path="night-market" element={<AdminNightMarket />} />
        <Route path="promotions/coupons/:id" element={<AdminCouponEdit />} />
        <Route path="payments" element={<Navigate to="/admin/billing?tab=recharge" replace />} />
        <Route path="announcements" element={<AdminAnnouncements />} />
        <Route path="documents" element={<AdminDocuments />} />
        <Route path="tasks" element={<AdminTasks />} />
        <Route path="tickets" element={<Tickets admin />} />
        <Route path="tickets/:id" element={<Tickets admin />} />
        <Route path="settings" element={<AdminSettings />} />
        <Route path="account" element={<Account />} />
        <Route path="notifications" element={<Notifications />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </RouteContent>
    </Suspense>
    </>
  );
}

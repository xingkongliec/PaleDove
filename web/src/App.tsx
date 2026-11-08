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
} from 'lucide-react';
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router';
import { AppShell, type NavGroup } from './layouts/AppShell';
import { TopProgress } from './components/TopProgress';
import { FullPageLoading, PageLoading } from './components/ui/misc';
import { setUnauthorizedHandler } from './lib/api';
import { queryClient, useMe, usePublicConfig } from './lib/queries';
import { loaders } from './lib/routes';
import { PublicLayout } from './components/landing/PublicShell';
import LoginPage from './pages/auth/Login';

// 页面按路由拆分：首屏只加载布局和当前页，其余在访问时下载；加载函数与预加载共用（lib/routes.ts）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const def = (load: () => Promise<unknown>) => lazy(load as () => Promise<{ default: ComponentType<any> }>);

const HomePage = def(loaders.home);
const Dashboard = def(loaders.dashboard);
const Store = def(loaders.store);
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
const AdminRealname = def(loaders.adminRealname);
const AdminBilling = def(loaders.adminBilling);
const AdminPromotions = def(loaders.adminPromotions);
const AdminCouponEdit = def(loaders.adminCouponEdit);
const AdminAnnouncements = def(loaders.adminAnnouncements);
const AdminDocuments = def(loaders.adminDocuments);
const AdminTasks = def(loaders.adminTasks);
const AdminSettings = def(loaders.adminSettings);

/** 用户侧边栏；「邀请推广」在管理员开启推广返利后显示 */
const userNav = (aff: boolean): NavGroup[] => [
  { items: [{ to: '/dashboard', label: 'nav.dashboard', icon: <LayoutGrid />, end: true }] },
  {
    title: 'nav.group.cloud',
    items: [
      // 购买实例不单列，从实例列表等入口进入，侧边栏高亮“实例”
      { to: '/instances', label: 'nav.instances', icon: <Server />, also: ['/console/store'] },
      { to: '/vpc', label: 'nav.vpc', icon: <Network /> },
      { to: '/terminal', label: 'nav.terminal', icon: <SquareTerminal /> },
      { to: '/transfer', label: 'nav.transfer', icon: <ArrowRightLeft /> },
      { to: '/console/marketplace', label: 'nav.market', icon: <MarketIcon />, end: true },
      { to: '/console/marketplace/mine', label: 'nav.marketMine', icon: <TagIcon /> },
    ],
  },
  {
    title: 'nav.group.manage',
    items: [
      { to: '/activity', label: 'nav.activity', icon: <ScrollText /> },
      { to: '/billing', label: 'nav.billing', icon: <Wallet /> },
      { to: '/invoices', label: 'nav.invoices', icon: <ReceiptText /> },
      ...(aff ? [{ to: '/invite', label: 'nav.invite' as const, icon: <Gift /> }] : []),
      { to: '/tickets', label: 'ticket.title', icon: <MessagesSquare /> },
      { to: '/console/documents', label: 'documents.publicCenter', icon: <BookOpen /> },
      // API 文档从“账号设置 → API 令牌”进入
      { to: '/account', label: 'nav.account', icon: <UserCog />, also: ['/docs/api'] },
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
  if (!me) return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (admin && me.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;
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

/** 懒加载页面；布局外的整页（如首页）传入 FullPageLoading 作为占位 */
function Lazy({ children, fallback = <PageLoading /> }: { children: ReactNode; fallback?: ReactNode }) {
  return <Suspense fallback={fallback}>{children}</Suspense>;
}

export default function App() {
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
      navigate(`/login?redirect=${encodeURIComponent(window.location.pathname)}`, { replace: true });
    });
  }, [navigate]);

  return (
    <>
    <TopProgress />
    <Routes>
      <Route path="/" element={<Lazy fallback={<FullPageLoading />}><HomePage /></Lazy>} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<LoginPage mode="register" />} />
      <Route path="/terms" element={<Lazy fallback={<FullPageLoading />}><LegalPage kind="terms" /></Lazy>} />
      <Route path="/privacy" element={<Lazy fallback={<FullPageLoading />}><LegalPage kind="privacy" /></Lazy>} />
      <Route path="/help" element={<Lazy fallback={<FullPageLoading />}><DocumentsPage /></Lazy>} />
      <Route path="/help/:slug" element={<Lazy fallback={<FullPageLoading />}><LegalPage /></Lazy>} />
      <Route path="/forgot-password" element={<Lazy fallback={<FullPageLoading />}><PasswordReset /></Lazy>} />
      <Route path="/reset-password" element={<Lazy fallback={<FullPageLoading />}><PasswordReset reset /></Lazy>} />
      <Route path="/verify-email" element={<Lazy fallback={<FullPageLoading />}><VerifyEmail /></Lazy>} />
      {/* 交易市场：从首页进入时，登录与否都在公开页外壳里；控制台侧边栏的「交易市场」「我的上架」是 /console/marketplace 与 /console/marketplace/mine */}
      {/* 购买页：从首页进入时登录与否都在公开页外壳里，游客也能浏览并选配置，付款时再登录；管理员回到后台。控制台里的购买页是 /console/store */}
      <Route element={<MarketLayout active="store" adminTo="/admin" />}>
        <Route path="/store" element={<Lazy><Store /></Lazy>} />
      </Route>
      <Route element={<MarketLayout active="market" />}>
        <Route path="/market" element={<Lazy><MarketPage /></Lazy>} />
      </Route>
      <Route
        element={
          <RequireAuth>
            <AppShell nav={userNav(!!site?.affEnabled)} area="user" />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<Lazy><Dashboard /></Lazy>} />
        <Route path="/instances" element={<Lazy><Instances /></Lazy>} />
        <Route path="/vpc" element={<Lazy><Vpcs /></Lazy>} />
        <Route path="/instances/:id" element={<Lazy><InstanceDetail /></Lazy>} />
        <Route path="/billing" element={<Lazy><Billing /></Lazy>} />
        <Route path="/invoices" element={<Lazy><Invoices /></Lazy>} />
        <Route path="/invoices/:id" element={<Lazy><InvoiceDetail /></Lazy>} />
        <Route path="/invite" element={<Lazy><Affiliate /></Lazy>} />
        <Route path="/account" element={<Lazy><Account /></Lazy>} />
        <Route path="/terminal" element={<Lazy><TerminalPage /></Lazy>} />
        <Route path="/docs/api" element={<Lazy><ApiDocs /></Lazy>} />
        <Route path="/transfer" element={<Lazy><TransferPage /></Lazy>} />
        {/* 控制台里的购买页与交易市场（/console/...）；从首页进入的 /store、/market 在公开页外壳里 */}
        <Route path="/console/store" element={<Lazy><Store /></Lazy>} />
        <Route path="/console/marketplace" element={<Lazy><MarketPage /></Lazy>} />
        <Route path="/console/marketplace/mine" element={<Lazy><MyListingsPage /></Lazy>} />
        <Route path="/console/documents" element={<Lazy><DocumentsPage consoleView /></Lazy>} />
        <Route path="/console/documents/:slug" element={<Lazy><DocumentDetail /></Lazy>} />
        <Route path="/activity" element={<Lazy><Activity /></Lazy>} />
        <Route path="/notifications" element={<Lazy><Notifications /></Lazy>} />
        <Route path="/tickets" element={<Lazy><Tickets /></Lazy>} />
        <Route path="/tickets/new" element={<Lazy><Tickets create /></Lazy>} />
        <Route path="/tickets/:id" element={<Lazy><Tickets /></Lazy>} />
      </Route>
      <Route
        path="/admin"
        element={
          <RequireAuth admin>
            <AppShell nav={adminNav} area="admin" />
          </RequireAuth>
        }
      >
        <Route index element={<Lazy><AdminDashboard /></Lazy>} />
        <Route path="instances" element={<Lazy><AdminInstances /></Lazy>} />
        <Route path="instances/new" element={<Lazy><AdminInstanceCreate /></Lazy>} />
        <Route path="instances/:id" element={<Lazy><InstanceDetail admin /></Lazy>} />
        <Route path="nodes" element={<Lazy><AdminNodes /></Lazy>} />
        <Route path="ping" element={<Lazy><AdminPing /></Lazy>} />
        <Route path="nodes/new" element={<Lazy><AdminNodeCreate /></Lazy>} />
        <Route path="nodes/:id" element={<Lazy><AdminNodeDetail /></Lazy>} />
        <Route path="nodes/:id/edit" element={<Lazy><AdminNodeEdit /></Lazy>} />
        <Route path="plans" element={<Lazy><AdminPlans /></Lazy>} />
        <Route path="plans/new" element={<Lazy><AdminPlanEdit /></Lazy>} />
        <Route path="plans/:id/edit" element={<Lazy><AdminPlanEdit /></Lazy>} />
        <Route path="products/:id" element={<Lazy><AdminProductDetail /></Lazy>} />
        <Route path="images" element={<Lazy><AdminImages /></Lazy>} />
        <Route path="users" element={<Lazy><AdminUsers /></Lazy>} />
        <Route path="realname" element={<Lazy><AdminRealname /></Lazy>} />
        <Route path="finance" element={<Navigate to="/admin/billing?tab=orders" replace />} />
        <Route path="billing" element={<Lazy><AdminBilling /></Lazy>} />
        <Route path="market" element={<Lazy><AdminMarket /></Lazy>} />
        <Route path="promotions" element={<Lazy><AdminPromotions /></Lazy>} />
        <Route path="promotions/coupons/:id" element={<Lazy><AdminCouponEdit /></Lazy>} />
        <Route path="payments" element={<Navigate to="/admin/billing?tab=recharge" replace />} />
        <Route path="announcements" element={<Lazy><AdminAnnouncements /></Lazy>} />
        <Route path="documents" element={<Lazy><AdminDocuments /></Lazy>} />
        <Route path="tasks" element={<Lazy><AdminTasks /></Lazy>} />
        <Route path="tickets" element={<Lazy><Tickets admin /></Lazy>} />
        <Route path="tickets/:id" element={<Lazy><Tickets admin /></Lazy>} />
        <Route path="settings" element={<Lazy><AdminSettings /></Lazy>} />
        <Route path="account" element={<Lazy><Account /></Lazy>} />
        <Route path="notifications" element={<Lazy><Notifications /></Lazy>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}

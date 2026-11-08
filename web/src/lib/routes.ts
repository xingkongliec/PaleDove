// 页面代码分块的加载函数：路由懒加载（App.tsx）和预加载（侧边栏悬停、登录后空闲时）共用同一个 import()，
// 浏览器只会下载一次，预加载完成后切换页面不再等待网络。
type Loader = () => Promise<unknown>;

export const loaders = {
  home: () => import('@/pages/Home'),
  dashboard: () => import('@/pages/console/Dashboard'),
  store: () => import('@/pages/console/Store'),
  instances: () => import('@/pages/console/Instances'),
  vpcs: () => import('@/pages/console/Vpcs'),
  instanceDetail: () => import('@/pages/instance/InstanceDetail'),
  billing: () => import('@/pages/console/billing/Billing'),
  invoices: () => import('@/pages/console/billing/Invoices'),
  invoiceDetail: () => import('@/pages/console/billing/InvoiceDetail'),
  affiliate: () => import('@/pages/console/Affiliate'),
  account: () => import('@/pages/console/account/Account'),
  terminal: () => import('@/pages/console/TerminalPage'),
  transfer: () => import('@/pages/console/TransferPage'),
  apiDocs: () => import('@/pages/console/ApiDocs'),
  activity: () => import('@/pages/console/Activity'),
  notifications: () => import('@/pages/Notifications'),
  tickets: () => import('@/pages/tickets'),
  verifyEmail: () => import('@/pages/auth/VerifyEmail'),
  legal: () => import('@/pages/Legal'),
  documents: () => import('@/pages/documents/Documents'),
  documentDetail: () => import('@/pages/documents/DocumentDetail'),
  passwordReset: () => import('@/pages/auth/PasswordReset'),
  market: () => import('@/pages/market/Market'),
  marketMine: () => import('@/pages/market/MyListings'),
  adminDashboard: () => import('@/pages/admin/Dashboard'),
  adminInstances: () => import('@/pages/admin/instances/Instances'),
  adminNodes: () => import('@/pages/admin/nodes/Nodes'),
  adminPing: () => import('@/pages/admin/PingSettings'),
  adminNodeDetail: () => import('@/pages/admin/nodes/NodeDetail'),
  adminNodeCreate: () => import('@/pages/admin/nodes/NodeCreate'),
  adminNodeEdit: () => import('@/pages/admin/nodes/NodeEdit'),
  adminPlans: () => import('@/pages/admin/catalog/Plans'),
  adminPlanEdit: () => import('@/pages/admin/catalog/PlanEdit'),
  adminProductDetail: () => import('@/pages/admin/catalog/ProductDetail'),
  adminInstanceCreate: () => import('@/pages/admin/instances/InstanceCreate'),
  adminImages: () => import('@/pages/admin/catalog/Images'),
  adminUsers: () => import('@/pages/admin/Users'),
  adminRealname: () => import('@/pages/admin/Realname'),
  adminBilling: () => import('@/pages/admin/billing/BillingAdmin'),
  adminPromotions: () => import('@/pages/admin/billing/Promotions'),
  adminCouponEdit: () => import('@/pages/admin/billing/CouponEdit'),
  adminAnnouncements: () => import('@/pages/admin/Announcements'),
  adminDocuments: () => import('@/pages/admin/Documents'),
  adminTasks: () => import('@/pages/admin/Tasks'),
  adminSettings: () => import('@/pages/admin/settings/Settings'),
  adminMarket: () => import('@/pages/admin/MarketAdmin'),
};

const L = loaders;
/** 路径 → 需要的代码块（按顺序匹配，具体的写在前面） */
const ROUTES: Array<[RegExp, Loader[]]> = [
  [/^\/(admin\/)?tickets/, [L.tickets]],
  [/^\/verify-email/, [L.verifyEmail]],
  [/^\/(terms|privacy)$/, [L.legal]],
  [/^\/help\/[^/]+/, [L.legal]],
  [/^\/help\/?$/, [L.documents]],
  [/^\/console\/documents\/[^/]+/, [L.documentDetail]],
  [/^\/console\/documents\/?$/, [L.documents]],
  [/^\/(forgot-password|reset-password)$/, [L.passwordReset]],
  [/^\/dashboard/, [L.dashboard]],
  [/^\/(console\/)?store/, [L.store]],
  [/^\/instances\/[^/]+/, [L.instanceDetail]],
  [/^\/instances/, [L.instances]],
  [/^\/vpc/, [L.vpcs]],
  [/^\/billing/, [L.billing]],
  [/^\/invoices\/[^/]+/, [L.invoiceDetail]],
  [/^\/invoices/, [L.invoices]],
  [/^\/invite/, [L.affiliate]],
  [/^\/console\/marketplace\/mine/, [L.marketMine]],
  [/^\/(market|console\/marketplace)/, [L.market]],
  [/^\/admin\/market/, [L.adminMarket]],
  [/^\/(admin\/)?account/, [L.account]],
  [/^\/terminal/, [L.terminal]],
  [/^\/transfer/, [L.transfer]],
  [/^\/docs\/api/, [L.apiDocs]],
  [/^\/activity/, [L.activity]],
  [/^\/(admin\/)?notifications/, [L.notifications]],
  [/^\/admin\/?$/, [L.adminDashboard]],
  [/^\/admin\/instances\/new/, [L.adminInstanceCreate]],
  [/^\/admin\/instances\/[^/]+/, [L.instanceDetail]],
  [/^\/admin\/instances/, [L.adminInstances]],
  [/^\/admin\/nodes\/new/, [L.adminNodeCreate]],
  [/^\/admin\/nodes\/[^/]+\/edit/, [L.adminNodeEdit]],
  [/^\/admin\/nodes\/[^/]+/, [L.adminNodeDetail]],
  [/^\/admin\/nodes/, [L.adminNodes]],
  [/^\/admin\/ping/, [L.adminPing]],
  [/^\/admin\/plans\/.+/, [L.adminPlanEdit]],
  [/^\/admin\/products\/.+/, [L.adminProductDetail]],
  [/^\/admin\/plans/, [L.adminPlans]],
  [/^\/admin\/images/, [L.adminImages]],
  [/^\/admin\/users/, [L.adminUsers]],
  [/^\/admin\/realname/, [L.adminRealname]],
  [/^\/admin\/billing/, [L.adminBilling]],
  [/^\/admin\/promotions\/coupons\/.+/, [L.adminCouponEdit]],
  [/^\/admin\/promotions/, [L.adminPromotions]],
  [/^\/admin\/announcements/, [L.adminAnnouncements]],
  [/^\/admin\/documents/, [L.adminDocuments]],
  [/^\/admin\/tasks/, [L.adminTasks]],
  [/^\/admin\/settings/, [L.adminSettings]],
];

const started = new Set<Loader>();

/** 预加载某个代码块（重复调用只会下载一次；失败后允许重试） */
export function preload(fn: Loader) {
  if (started.has(fn)) return;
  started.add(fn);
  fn().catch(() => started.delete(fn));
}

/** 预加载某个路径需要的页面代码，用于链接悬停 / 获得焦点时 */
export function prefetchRoute(path: string) {
  const hit = ROUTES.find(([re]) => re.test(path));
  hit?.[1].forEach(preload);
}

/** 登录后在浏览器空闲时逐个预加载该角色会用到的页面（省流量模式下不预加载） */
export function prefetchAll(admin: boolean) {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData || conn?.effectiveType === '2g' || conn?.effectiveType === 'slow-2g') return () => {};
  const list = admin
    ? [L.adminInstances, L.adminNodes, L.adminNodeDetail, L.adminPing, L.adminUsers, L.instanceDetail, L.adminSettings, L.adminPlans, L.adminBilling, L.adminPromotions, L.adminTasks, L.adminImages, L.adminAnnouncements, L.adminDocuments, L.adminRealname, L.account]
    : [L.instances, L.instanceDetail, L.store, L.billing, L.invoices, L.vpcs, L.account, L.activity, L.dashboard, L.documents];
  let cancelled = false;
  let i = 0;
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const idle = (cb: () => void) => (ric ? ric(cb, { timeout: 3000 }) : window.setTimeout(cb, 400));
  const next = () => {
    if (cancelled || i >= list.length) return;
    const fn = list[i++]!;
    if (started.has(fn)) return next();
    started.add(fn);
    fn()
      .catch(() => started.delete(fn))
      .finally(() => idle(next));
  };
  const t = window.setTimeout(() => idle(next), 1200);
  return () => {
    cancelled = true;
    window.clearTimeout(t);
  };
}

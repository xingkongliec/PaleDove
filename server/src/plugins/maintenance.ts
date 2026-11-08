import fp from 'fastify-plugin';
import { isMaintenanceExempt, maintenanceState } from '../shared/index.ts';
import { AppError } from '../lib/errors.ts';
import { getSetting } from '../lib/settings.ts';
import { t } from '../i18n/index.ts';
import { routePath } from './session.ts';

// 认证、公开信息、上报及支付回调在维护期间仍可用。
const ALWAYS_ALLOWED = [/^\/api\/auth\//, /^\/api\/site\/icon$/, /^\/api\/health$/, /^\/api\/public\//, /^\/api\/pay\//, /^\/api\/agent\//];
const SUPPORT = /^\/api\/(tickets|announcements)(\/|$)/;
// WebSocket 终端虽以 GET 建连，也能写入资源。
const TERMINAL = /\/(terminal|console)(\/|$)/;

export default fp(async (app) => {
  app.addHook('onRequest', async (req) => {
    const path = routePath(req);
    if (!path.startsWith('/api/') || req.user?.role === 'ADMIN') return;
    const m = await getSetting('maintenance');
    if (m.scope === 'NOTICE' || maintenanceState(m) !== 'active' || isMaintenanceExempt(m, req.user?.email)) return;
    if (ALWAYS_ALLOWED.some((r) => r.test(path))) return;
    if (m.scope === 'READONLY' && (SUPPORT.test(path) || (['GET', 'HEAD'].includes(req.method) && !TERMINAL.test(path)))) return;
    throw new AppError(503, 'MAINTENANCE', t(m.scope === 'FULL' ? 'maintenance.full' : 'maintenance.readonly', { title: m.title }));
  });
});

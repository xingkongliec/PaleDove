import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './config.ts';
import { IncusError } from './incus/types.ts';
import { AppError } from './lib/errors.ts';
import { isMessageKey, runWithLocale, t } from './i18n/index.ts';
import { DEFAULT_LOCALE, normalizeLocale } from './shared/index.ts';
import { Prisma } from './lib/prisma.ts';
import { redis } from './lib/redis.ts';
import sessionPlugin from './plugins/session.ts';
import maintenancePlugin from './plugins/maintenance.ts';
import passwordResetRoutes from './routes/password-reset.ts';
import settingsOperationsRoutes, { publicLegalRoutes } from './routes/settings-operations.ts';
import documentRoutes, { publicDocumentRoutes } from './routes/documents.ts';
import adminBillingRoutes from './routes/admin/billing.ts';
import adminPromotionRoutes from './routes/admin/promotions.ts';
import adminCatalogRoutes from './routes/admin/catalog.ts';
import adminInstanceRoutes from './routes/admin/instances.ts';
import adminNodeRoutes from './routes/admin/nodes.ts';
import adminPingRoutes from './routes/admin/ping.ts';
import adminNodeOpsRoutes from './routes/admin/node-ops.ts';
import adminSecurityRoutes from './routes/admin/security.ts';
import adminSiteRoutes from './routes/admin/sites.ts';
import adminSystemRoutes from './routes/admin/system.ts';
import adminUserRoutes from './routes/admin/users.ts';
import agentRoutes from './routes/agent.ts';
import authRoutes from './routes/auth.ts';
import instanceRoutes, { instanceDetailRoutes } from './routes/instances.ts';
import oauthRoutes from './routes/oauth.ts';
import passkeyRoutes from './routes/passkeys.ts';
import vpcRoutes, { adminUserVpcRoutes } from './routes/vpcs.ts';
import realnameRoutes, { adminRealnameRoutes } from './routes/realname.ts';
import tokenRoutes from './routes/tokens.ts';
import sshKeyRoutes from './routes/ssh-keys.ts';
import marketRoutes from './routes/market.ts';
import ticketRoutes from './routes/tickets.ts';
import { adminPaymentRoutes, paymentRoutes, paymentWebhookRoutes } from './routes/payments.ts';
import storeRoutes, { notificationRoutes } from './routes/store.ts';
import invoiceRoutes from './routes/invoices.ts';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
    logger: {
      level: config.LOG_LEVEL,
      ...(config.isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
      redact: ['req.headers.cookie', 'req.headers.authorization'],
    },
  });

  // 请求语言：x-locale 请求头 > 用户偏好（会话插件中应用）> Accept-Language > 默认。须先于其他插件注册
  app.addHook('onRequest', (req, _reply, done) => {
    const explicit = normalizeLocale(req.headers['x-locale'] as string | undefined);
    const locale = explicit ?? normalizeLocale(req.headers['accept-language']) ?? DEFAULT_LOCALE;
    runWithLocale(locale, done, !!explicit);
  });

  await app.register(cookie);
  await app.register(multipart);
  // 网页终端（实例详情）使用 WebSocket
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  // 内存模式下使用插件自带的本地计数器
  await app.register(rateLimit, { global: false, ...(config.memoryRedis ? {} : { redis }), nameSpace: 'ratelimit:' });
  await app.register(sessionPlugin);
  await app.register(maintenancePlugin);

  // 安全响应头：禁止被其他网站嵌入 iframe（防点击劫持：诱导用户在透明框架里点删除 / 转移）、
  // 禁止按内容猜测类型、跨站时不带完整 Referer。路由自己设置过的（如工单附件的 CSP）保持不变
  app.addHook('onSend', async (_req, reply, payload) => {
    if (!reply.hasHeader('x-frame-options')) reply.header('x-frame-options', 'DENY');
    if (!reply.hasHeader('content-security-policy')) reply.header('content-security-policy', "frame-ancestors 'none'");
    if (!reply.hasHeader('x-content-type-options')) reply.header('x-content-type-options', 'nosniff');
    if (!reply.hasHeader('referrer-policy')) reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    return payload;
  });

  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      // 校验消息使用消息键声明，在此按请求语言翻译；未声明的内置消息统一提示字段无效
      const translateIssue = (i: (typeof err.issues)[number]) =>
        isMessageKey(i.message) ? t(i.message) : t('err.invalidField', { field: i.path.join('.') || '-' });
      const first = err.issues[0];
      return reply.status(400).send({
        error: 'VALIDATION',
        message: first ? translateIssue(first) : t('err.validation'),
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: translateIssue(i) })),
      });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2025') return reply.status(404).send({ error: 'NOT_FOUND', message: t('err.recordNotFound') });
      if (err.code === 'P2002') return reply.status(409).send({ error: 'CONFLICT', message: t('err.duplicate') });
      if (err.code === 'P2003') return reply.status(409).send({ error: 'CONFLICT', message: t('err.relationExists') });
    }
    if (err instanceof IncusError) {
      req.log.warn({ err }, 'incus request failed');
      return reply.status(502).send({ error: 'INCUS_ERROR', message: t('err.incus', { message: err.message }) });
    }
    const status = (err as FastifyError).statusCode;
    if (status === 429) return reply.status(429).send({ error: 'RATE_LIMITED', message: t('err.tooManyRequests') });
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({ error: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'INTERNAL', message: t('err.internal') });
  });

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(passwordResetRoutes);
  await app.register(publicLegalRoutes);
  await app.register(settingsOperationsRoutes);
  await app.register(publicDocumentRoutes);
  await app.register(documentRoutes);
  await app.register(oauthRoutes);
  await app.register(passkeyRoutes);
  await app.register(vpcRoutes);
  await app.register(adminUserVpcRoutes);
  await app.register(tokenRoutes);
  await app.register(sshKeyRoutes);
  await app.register(marketRoutes);
  await app.register(ticketRoutes, { prefix: '/api/tickets' });
  await app.register(ticketRoutes, { prefix: '/api/admin/tickets', admin: true });
  await app.register(realnameRoutes);
  await app.register(agentRoutes);
  await app.register(paymentWebhookRoutes);
  await app.register(storeRoutes);
  await app.register(invoiceRoutes);
  await app.register(notificationRoutes);
  await app.register(instanceRoutes);
  await app.register(instanceDetailRoutes, { prefix: '/api/admin/instances', admin: true });
  await app.register(paymentRoutes);
  await app.register(adminNodeRoutes);
  await app.register(adminPingRoutes);
  await app.register(adminNodeOpsRoutes);
  await app.register(adminSiteRoutes);
  await app.register(adminPaymentRoutes);
  await app.register(adminBillingRoutes);
  await app.register(adminPromotionRoutes);
  await app.register(adminCatalogRoutes);
  await app.register(adminInstanceRoutes);
  await app.register(adminUserRoutes);
  await app.register(adminSystemRoutes);
  await app.register(adminSecurityRoutes);
  await app.register(adminRealnameRoutes);

  // 托管前端构建产物（单页应用，未匹配的非 API 路径回退到 index.html）
  const webDist = config.webDist;
  if (webDist && existsSync(resolve(webDist, 'index.html'))) {
    // 带哈希的静态资源可长期缓存；index.html 始终不缓存，保证发布后立即生效
    await app.register(fastifyStatic, {
      root: webDist,
      setHeaders: (res, filePath) => {
        res.header('cache-control', filePath.includes('/static/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/') || req.method !== 'GET') {
        return reply.status(404).send({ error: 'NOT_FOUND', message: t('err.routeNotFound') });
      }
      // 带扩展名的路径视为静态资源，不存在时返回 404 而不是页面
      if (/\.[a-z0-9]+$/i.test(path)) return reply.status(404).type('text/plain').send('Not Found');
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
    app.log.info(`serving web assets from ${webDist}`);
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'NOT_FOUND', message: t('err.routeNotFound') }));
  }

  return app;
}

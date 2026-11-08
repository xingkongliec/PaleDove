import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { INSTANCE_TYPES, MARKET_LISTING_STATUSES, MARKET_SORTS } from '../shared/index.ts';
import { adminGuard, consoleGuard, idParam, logActivity, pageQuery, parse, requireAdmin, requireUser } from '../lib/http.ts';
import { m } from '../i18n/index.ts';
import { adminListings, adminUpdateListing, buyListing, cancelListing, createListing, featuredListing, listingHistory, listingPing, listMarket, myListings, myPurchases, removeListing, retryListingPing, sellableInstances, updateListing } from '../services/market.ts';

const price = z.union([z.string(), z.number()]).refine((v) => Number.isFinite(Number(v)), m('v.amount'));

/**
 * 交易市场接口：
 *  - 公开：商品列表与成交价走势（未登录也能浏览；登录后能看到定向给自己的商品）
 *  - 用户：可挂牌的实例、我的挂牌、挂牌 / 改价 / 撤销、购买
 *  - 管理员：全部挂牌与下架
 */
export default async function marketRoutes(app: FastifyInstance) {
  // ───────── 公开 ─────────

  app.get('/api/public/market', async (req) => {
    const q = parse(
      pageQuery.extend({
        region: z.string().trim().max(64).optional(),
        q: z.string().trim().max(100).optional(),
        type: z.enum(INSTANCE_TYPES).optional(),
        sort: z.enum(MARKET_SORTS).default('NEWEST'),
      }),
      req.query,
    );
    return listMarket(q, req.user ?? null);
  });

  /** 首页推荐的商品（每天随机一个，被买走或下架时重新抽取）；没有时返回 { listing: null } */
  app.get('/api/public/market/featured', async () => ({ listing: await featuredListing() }));

  app.get('/api/public/market/:id/history', async (req) => {
    const { id } = parse(idParam, req.params);
    const { kind } = parse(z.object({ kind: z.enum(['ALL', 'PUBLIC', 'TARGETED']).default('ALL') }), req.query);
    return listingHistory(id, req.user ?? null, kind);
  });

  /** 上架前拨测快照（在售商品公开；已结束的只有买卖双方与管理员） */
  app.get('/api/public/market/:id/ping', async (req) => {
    const { id } = parse(idParam, req.params);
    return listingPing(id, req.user ?? null);
  });

  // ───────── 用户 ─────────

  app.get('/api/market/sellable', { preHandler: consoleGuard }, async (req) => sellableInstances(requireUser(req)));

  app.get('/api/market/mine', { preHandler: consoleGuard }, async (req) => myListings(requireUser(req)));

  /** 我买到的实例（成交记录与上架前拨测快照） */
  app.get('/api/market/purchases', { preHandler: consoleGuard }, async (req) => myPurchases(requireUser(req)));

  app.post('/api/market/listings', { preHandler: consoleGuard, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const body = parse(
      z.object({
        instanceId: z.number().int().positive(),
        price,
        target: z.string().trim().max(128).optional(),
      }),
      req.body,
    );
    const listing = await createListing(user, body);
    await logActivity(req, user.id, 'market.list', `#${listing.id} instance #${body.instanceId} ${listing.price}${body.target ? ` → ${body.target}` : ''}`);
    return listing;
  });

  app.patch('/api/market/listings/:id', { preHandler: consoleGuard }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const body = parse(z.object({ price }), req.body);
    const listing = await updateListing(user, id, body);
    await logActivity(req, user.id, 'market.update', `#${id} ${listing.price}`);
    return listing;
  });

  /** 拨测未完成的商品重新拨测 */
  app.post('/api/market/listings/:id/ping', { preHandler: consoleGuard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = parse(idParam, req.params);
    return retryListingPing(requireUser(req), id);
  });

  app.delete('/api/market/listings/:id', { preHandler: consoleGuard }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    await cancelListing(user, id);
    await logActivity(req, user.id, 'market.cancel', `#${id}`);
    return { ok: true };
  });

  app.post('/api/market/listings/:id/buy', { preHandler: consoleGuard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParam, req.params);
    const result = await buyListing(id, user);
    await logActivity(req, user.id, 'market.buy', `#${id} instance #${result.instanceId}`);
    return result;
  });

  // ───────── 管理员 ─────────

  app.get('/api/admin/market', { preHandler: adminGuard }, async (req) => {
    const q = parse(pageQuery.extend({ status: z.enum(MARKET_LISTING_STATUSES).optional(), q: z.string().trim().max(100).optional() }), req.query);
    return adminListings(q);
  });

  // 修改出售中的商品：售价、定向买家（空字符串为公开出售），有变化时通知卖家
  app.patch('/api/admin/market/:id', { preHandler: adminGuard }, async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        price: z.union([z.number(), z.string().trim().min(1)]).optional(),
        target: z.string().trim().max(254).optional(),
        note: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    const listing = await adminUpdateListing(id, body);
    await logActivity(req, admin.id, 'admin.market_update', `#${id} ${JSON.stringify(body)}`);
    return listing;
  });

  app.post('/api/admin/market/:id/remove', { preHandler: adminGuard }, async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    await removeListing(id, reason ?? '');
    await logActivity(req, admin.id, 'admin.market_remove', `#${id}${reason ? ` ${reason}` : ''}`);
    return { ok: true };
  });
}

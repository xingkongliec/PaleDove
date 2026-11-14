import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILLING_CYCLES, NIGHT_QUALITIES, NIGHT_DISCOUNT_MODES, defaultNightDrawRules } from '../shared/index.ts';
import { adminGuard, consoleGuard, logActivity, parse, requireAdmin, requireUser } from '../lib/http.ts';
import { m } from '../i18n/index.ts';
import { adminNightMarket, getUserNightMarket, nightCheckoutQuote, revealNightOffer, saveNightConfig } from '../services/night-market.ts';

export const nightConfigSchema = z.object({
  enabled: z.boolean(),
  startsAt: z.iso.datetime(),
  refreshHours: z.number().int().min(1).max(8760),
  activeHours: z.number().int().min(1).max(8760),
  drawRules: z.object({
    guaranteeEnabled: z.boolean(),
    guaranteeCount: z.number().int().min(1).max(6),
    guaranteeQuality: z.enum(NIGHT_QUALITIES),
    qualityProbabilities: z.object({
      SELECT: z.number().int().min(0).max(100), DELUXE: z.number().int().min(0).max(100),
      PREMIUM: z.number().int().min(0).max(100), EXCLUSIVE: z.number().int().min(0).max(100),
    }).strict().refine(p => NIGHT_QUALITIES.reduce((sum, q) => sum + p[q], 0) === 100, { message: m('night.invalidProbabilities') }),
  }).strict().default(defaultNightDrawRules),
  prizes: z.array(z.object({
    id: z.string().uuid(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(400),
    planId: z.number().int().positive(), cycle: z.enum(BILLING_CYCLES), quality: z.enum(NIGHT_QUALITIES),
    discountMin: z.number().int().min(1).max(99).default(10), discountMax: z.number().int().min(1).max(99).default(49),
    discountMode: z.enum(NIGHT_DISCOUNT_MODES).default('ONCE'),
    groupKey: z.string().trim().min(1).max(80), eligibleFromPeriod: z.number().int().min(1).max(1000000), enabled: z.boolean(),
  }).strict().refine(p => p.discountMin <= p.discountMax, { message: m('night.invalidDiscountRange'), path: ['discountMax'] })).max(200),
}).strict().refine(c => c.activeHours <= c.refreshHours, { message: m('night.invalidDuration'), path: ['activeHours'] })
  .refine(c => new Set(c.prizes.map(p => p.id)).size === c.prizes.length, { message: m('night.duplicatePrize'), path: ['prizes'] });

export default async function nightMarketRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);
  app.get('/api/night-market', req => getUserNightMarket(requireUser(req).id));
  const idOf = (params: unknown) => parse(z.object({ id: z.coerce.number().int().positive() }), params).id;
  app.post('/api/night-market/offers/:id/reveal', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, req => revealNightOffer(requireUser(req).id, idOf(req.params)));
  app.get('/api/night-market/offers/:id', req => nightCheckoutQuote(requireUser(req).id, idOf(req.params)));
}

export async function adminNightMarketRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  app.get('/api/admin/night-market', adminNightMarket);
  app.put('/api/admin/night-market', async req => {
    const config = parse(nightConfigSchema, req.body);
    await saveNightConfig(config);
    await logActivity(req, requireAdmin(req).id, 'admin.night_market', `enabled=${config.enabled}; prizes=${config.prizes.length}`);
    return adminNightMarket();
  });
}

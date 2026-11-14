import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AFF_LOG_STATUSES, AFF_LOG_TYPES } from '../../shared/index.ts';
import { adminGuard, pageQuery, parse } from '../../lib/http.ts';
import { adminAffLogs } from '../../services/admin-aff.ts';
import { m } from '../../i18n/index.ts';

export default async function adminAffRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/aff/logs', async req => {
    const filters = parse(pageQuery.extend({
      q: z.string().trim().max(100).optional(),
      type: z.enum(AFF_LOG_TYPES).optional(),
      status: z.enum(AFF_LOG_STATUSES).optional(),
      startAt: z.iso.datetime({ offset: true }).optional(),
      endAt: z.iso.datetime({ offset: true }).optional(),
    }).refine(v => !v.startAt || !v.endAt || new Date(v.startAt) < new Date(v.endAt), { path: ['endAt'], message: m('invoice.invalidDateRange') }), req.query);
    return adminAffLogs(filters);
  });
}

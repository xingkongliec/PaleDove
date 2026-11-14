import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PING_ISPS, PING_REGIONS, pingRegionNeedsIsp, pingTargetIsp } from '../../shared/index.ts';
import { adminGuard, logActivity, parse, requireAdmin } from '../../lib/http.ts';
import { badRequest, notFound } from '../../lib/errors.ts';
import { m, t } from '../../i18n/index.ts';
import { adminPingSettings, changePingObject, updatedTarget, updatePingSettings } from '../../services/ping-settings.ts';

const hostSchema = z.string().trim().toLowerCase().max(253).refine(host => isIP(host) === 4 || (!/^[\d.]+$/.test(host) && host.includes('.') && host.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))), m('probe.invalidHost'));
const targetSchema = z.object({
  name: z.string().trim().max(80).default(''),
  province: z.string().refine(value => PING_REGIONS.some(region => region[1] === value), m('probe.invalidProvince')),
  isp: z.enum(PING_ISPS).nullish(),
  host: hostSchema,
  port: z.number().int().min(1).max(65535),
  enabled: z.boolean(),
}).refine(value => !pingRegionNeedsIsp(value.province) || value.isp != null, { path: ['isp'], message: m('probe.ispRequired') });
const idOf = (params: unknown) => parse(z.object({ id: z.string().max(32) }), params).id;

export default async function adminPingRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  app.get('/api/admin/ping', adminPingSettings);
  app.patch('/api/admin/ping', async req => {
    const input = parse(z.object({ enabled: z.boolean().optional(), interval: z.number().int().min(600).max(86400).optional(), count: z.number().int().min(1).max(10).optional() }).strict(), req.body);
    await updatePingSettings(() => input);
    await logActivity(req, requireAdmin(req).id, 'admin.ping_settings', JSON.stringify(input));
    return adminPingSettings();
  });
  for (const method of ['POST', 'PATCH'] as const) app.route({ method, url: method === 'POST' ? '/api/admin/ping/targets' : '/api/admin/ping/targets/:id', handler: async req => {
    const input = parse(targetSchema, req.body);
    const id = method === 'POST' ? `custom-${randomUUID().slice(0, 16)}` : idOf(req.params);
    const target = { ...input, id, isp: pingTargetIsp({ province: input.province, isp: input.isp ?? null }), provinceEn: PING_REGIONS.find(region => region[1] === input.province)![2] };
    await updatePingSettings(current => {
      if (method === 'POST' && current.targets.length >= 200) throw badRequest(t('probe.targetLimit'));
      if (current.targets.some(item => item.id !== id && item.host === input.host && item.port === input.port)) throw badRequest(t('probe.duplicateTarget'));
      return { targets: method === 'POST' ? [...current.targets, target] : updatedTarget(current.targets, id, target) };
    });
    await logActivity(req, requireAdmin(req).id, 'admin.ping_target_save', target.name || target.host);
    return target;
  } });
  app.delete('/api/admin/ping/targets/:id', async req => {
    const id = idOf(req.params);
    await updatePingSettings(current => {
      if (!current.targets.some(target => target.id === id)) throw notFound(t('probe.targetMissing'));
      return { targets: current.targets.filter(target => target.id !== id) };
    });
    await logActivity(req, requireAdmin(req).id, 'admin.ping_target_delete', id);
    return { ok: true };
  });
  app.post('/api/admin/ping/objects', async req => {
    const { nodeId } = parse(z.object({ nodeId: z.number().int().positive() }), req.body);
    const name = await changePingObject(nodeId, 'add');
    await logActivity(req, requireAdmin(req).id, 'admin.ping_object_add', name);
    return { ok: true };
  });
  app.patch('/api/admin/ping/objects/:id', async req => {
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const name = await changePingObject(id, enabled ? 'enable' : 'disable');
    await logActivity(req, requireAdmin(req).id, 'admin.ping_object_toggle', `${name}: ${enabled}`);
    return { ok: true };
  });
  app.delete('/api/admin/ping/objects/:id', async req => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const name = await changePingObject(id, 'remove');
    await logActivity(req, requireAdmin(req).id, 'admin.ping_object_delete', name);
    return { ok: true };
  });
}

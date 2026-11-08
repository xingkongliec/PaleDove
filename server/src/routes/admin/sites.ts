import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SITE_STATUSES, type AdminSiteBindingDTO, type Paginated } from '../../shared/index.ts';
import { errorMessage, notFound } from '../../lib/errors.ts';
import { adminGuard, ensureFound, idParam, logActivity, pageQuery, paging, parse, requireAdmin } from '../../lib/http.ts';
import { containsInsensitive, prisma, type Prisma } from '../../lib/prisma.ts';
import { m, t } from '../../i18n/index.ts';
import { assertDomainAvailable, normalizeDomain, parseUpstream, syncSites, syncSitesSafe } from '../../services/gateway.ts';
import { toProxySite, toSite } from '../../services/serializers.ts';

const include = { node: { select: { id: true, name: true } } } as const;

export default async function adminSiteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);

  app.get('/api/admin/proxy-sites', async (req) => {
    const q = parse(z.object({ nodeId: z.coerce.number().int().optional() }), req.query);
    const rows = await prisma.proxySite.findMany({ where: q.nodeId ? { nodeId: q.nodeId } : {}, include, orderBy: { id: 'desc' } });
    return rows.map(toProxySite);
  });

  app.post('/api/admin/proxy-sites', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(
      z.object({
        nodeId: z.number().int().positive(),
        domain: z.string().min(1, m('v.domainRequired')),
        upstream: z.string().trim().min(1),
        https: z.boolean().default(true),
        remark: z.string().trim().max(200).optional(),
      }),
      req.body,
    );
    ensureFound(await prisma.node.findUnique({ where: { id: body.nodeId } }), t('node.notFound'));
    const domain = normalizeDomain(body.domain);
    parseUpstream(body.upstream);
    await assertDomainAvailable(domain);
    const site = await prisma.proxySite.create({
      data: { nodeId: body.nodeId, domain, upstream: body.upstream, https: body.https, remark: body.remark || null },
    });
    await syncSitesSafe(body.nodeId);
    await logActivity(req, admin.id, 'admin.proxy_create', `${domain} -> ${body.upstream}`);
    return toProxySite(await prisma.proxySite.findUniqueOrThrow({ where: { id: site.id }, include }));
  });

  app.patch('/api/admin/proxy-sites/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        domain: z.string().min(1).optional(),
        upstream: z.string().trim().min(1).optional(),
        https: z.boolean().optional(),
        remark: z.string().trim().max(200).nullable().optional(),
      }),
      req.body,
    );
    const site = ensureFound(await prisma.proxySite.findUnique({ where: { id } }), t('site.notFound'));
    const domain = body.domain ? normalizeDomain(body.domain) : undefined;
    if (domain && domain !== site.domain) await assertDomainAvailable(domain, { proxyId: id });
    if (body.upstream) parseUpstream(body.upstream);
    await prisma.proxySite.update({ where: { id }, data: { ...body, domain, status: 'PENDING' } });
    await syncSitesSafe(site.nodeId);
    return toProxySite(await prisma.proxySite.findUniqueOrThrow({ where: { id }, include }));
  });

  app.delete('/api/admin/proxy-sites/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const site = ensureFound(await prisma.proxySite.findUnique({ where: { id } }), t('site.notFound'));
    await prisma.proxySite.delete({ where: { id } });
    await syncSitesSafe(site.nodeId);
    await logActivity(req, admin.id, 'admin.proxy_delete', site.domain);
    return { ok: true };
  });

  /**
   * 重新生成并下发 Caddy 配置：指定宿主机，或全部已安装 Caddy 的宿主机。
   * 逐台执行，单台失败不影响其他宿主机；站点状态由同步结果更新。
   */
  app.post('/api/admin/proxy-sites/sync', async (req) => {
    const admin = requireAdmin(req);
    const { nodeId } = parse(z.object({ nodeId: z.number().int().positive().optional() }), req.body ?? {});
    const nodes = await prisma.node.findMany({
      where: nodeId ? { id: nodeId } : { caddyStatus: { not: 'NONE' } },
      select: { id: true, name: true },
      orderBy: { id: 'asc' },
    });
    if (nodeId && !nodes.length) throw notFound(t('node.notFound'));
    const result: { ok: number; failed: Array<{ id: number; name: string; message: string }> } = { ok: 0, failed: [] };
    for (const n of nodes) {
      try {
        await syncSites(n.id);
        result.ok++;
      } catch (err) {
        result.failed.push({ id: n.id, name: n.name, message: errorMessage(err) });
      }
    }
    await logActivity(req, admin.id, 'admin.sites_sync', nodeId ? `node=${nodeId}` : `all ${result.ok}/${nodes.length}`);
    return result;
  });

  // ───────── 用户绑定的网站 ─────────

  /** 分页列出用户的网站绑定：按域名 / 实例 / 用户搜索，按宿主机、状态筛选 */
  app.get('/api/admin/site-bindings', async (req): Promise<Paginated<AdminSiteBindingDTO>> => {
    const q = parse(
      pageQuery.extend({
        q: z.string().trim().optional(),
        nodeId: z.coerce.number().int().positive().optional(),
        status: z.enum(SITE_STATUSES).optional(),
      }),
      req.query,
    );
    const where: Prisma.SiteBindingWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.nodeId ? { instance: { nodeId: q.nodeId } } : {}),
      ...(q.q
        ? {
            OR: [
              { domain: containsInsensitive(q.q) },
              { instance: { hostname: containsInsensitive(q.q) } },
              { instance: { user: { username: containsInsensitive(q.q) } } },
              { instance: { user: { email: containsInsensitive(q.q) } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.siteBinding.findMany({ where, include: bindingInclude, orderBy: { id: 'desc' }, ...paging(q) }),
      prisma.siteBinding.count({ where }),
    ]);
    return { items: rows.map(toAdminBinding), total, page: q.page, pageSize: q.pageSize };
  });

  /** 修改用户的网站绑定：域名、目标端口、HTTPS（不受用户侧的数量与 DNS 检查限制） */
  app.patch('/api/admin/site-bindings/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const body = parse(
      z.object({
        domain: z.string().min(1, m('v.domainRequired')).optional(),
        targetPort: z.number().int().min(1).max(65535).optional(),
        https: z.boolean().optional(),
      }),
      req.body,
    );
    const site = ensureFound(await prisma.siteBinding.findUnique({ where: { id }, include: { instance: { select: { nodeId: true } } } }), t('site.notFound'));
    const domain = body.domain ? normalizeDomain(body.domain) : undefined;
    if (domain && domain !== site.domain) await assertDomainAvailable(domain, { siteId: id });
    await prisma.siteBinding.update({ where: { id }, data: { ...body, domain, status: 'PENDING', lastError: null } });
    await syncSitesSafe(site.instance.nodeId);
    await logActivity(req, admin.id, 'admin.site_update', `${site.domain} ${JSON.stringify(body)}`);
    return toAdminBinding(await prisma.siteBinding.findUniqueOrThrow({ where: { id }, include: bindingInclude }));
  });

  app.delete('/api/admin/site-bindings/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const site = ensureFound(await prisma.siteBinding.findUnique({ where: { id }, include: { instance: { select: { nodeId: true } } } }), t('site.notFound'));
    await prisma.siteBinding.delete({ where: { id } });
    await syncSitesSafe(site.instance.nodeId);
    await logActivity(req, admin.id, 'admin.site_delete', site.domain);
    return { ok: true };
  });
}

const bindingInclude = {
  instance: {
    select: { id: true, hostname: true, status: true, privateIp: true, node: { select: { id: true, name: true } }, user: { select: { id: true, username: true, email: true } } },
  },
} as const;

function toAdminBinding(s: Prisma.SiteBindingGetPayload<{ include: typeof bindingInclude }>): AdminSiteBindingDTO {
  return {
    ...toSite(s),
    upstream: `${s.instance.privateIp ?? '-'}:${s.targetPort}`,
    instance: { id: s.instance.id, hostname: s.instance.hostname, status: s.instance.status },
    node: s.instance.node,
    user: s.instance.user,
  };
}

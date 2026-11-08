import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { VpcDTO, VpcListDTO, VpcLocationDTO } from '../shared/index.ts';
import { notFound } from '../lib/errors.ts';
import { adminGuard, consoleGuard, idParam, logActivity, parse, requireUser } from '../lib/http.ts';
import { prisma } from '../lib/prisma.ts';
import { getSettings } from '../lib/settings.ts';
import { attachInstance, createVpc, deleteVpc, detachInstance, toVpc } from '../services/vpc.ts';
import { m, t } from '../i18n/index.ts';

const activeStatus = { notIn: ['DELETED' as const, 'DELETING' as const] };
const vpcInclude = {
  node: { select: { region: true, country: true } },
  instances: { where: { status: activeStatus }, select: { id: true, name: true, hostname: true, vpcIp: true, status: true }, orderBy: { id: 'asc' as const } },
};
const nameSchema = z.string().trim().min(1, m('vpc.nameRequired')).max(32, m('v.tooLong'));

/**
 * VPC 接口，用户与管理员共用：
 *  - 用户：/api/vpcs，操作自己的 VPC，受系统设置的数量上限约束；
 *  - 管理员：/api/admin/users/:uid/vpcs，在用户管理里代该用户操作，不受上限与「未开放」限制，操作记在管理员的日志里。
 */
function registerVpcRoutes(app: FastifyInstance, scope: { prefix: string; admin: boolean; ownerId: (req: FastifyRequest) => Promise<number> }) {
  const { prefix, admin } = scope;
  const loadVpc = async (userId: number, id: number) => {
    const vpc = await prisma.vpc.findFirst({ where: { id, userId }, include: { node: true } });
    if (!vpc) throw notFound(t('vpc.notFound'));
    return vpc;
  };
  const dto = async (id: number): Promise<VpcDTO> => toVpc(await prisma.vpc.findUniqueOrThrow({ where: { id }, include: vpcInclude }));
  /** 操作日志：管理员代操作时记在管理员名下并注明用户 */
  const log = (req: FastifyRequest, ownerId: number, action: string, detail: string) =>
    logActivity(req, requireUser(req).id, admin ? `admin.${action.replace('instance.', '')}` : action, admin ? `user #${ownerId} ${detail}` : detail);

  /** VPC 列表，以及可以建 VPC 的位置（用户实例所在的宿主机） */
  app.get(prefix, async (req): Promise<VpcListDTO> => {
    const userId = await scope.ownerId(req);
    const [rows, instances, settings] = await Promise.all([
      prisma.vpc.findMany({ where: { userId }, include: vpcInclude, orderBy: { id: 'asc' } }),
      prisma.instance.findMany({
        where: { userId, status: activeStatus },
        select: { id: true, name: true, hostname: true, vpcId: true, nodeId: true, node: { select: { region: true, country: true } } },
        orderBy: { id: 'asc' },
      }),
      getSettings(),
    ]);
    const locations = new Map<number, VpcLocationDTO>();
    for (const i of instances) {
      const loc = locations.get(i.nodeId) ?? { nodeId: i.nodeId, region: i.node.region, country: i.node.country, instances: [] };
      loc.instances.push({ id: i.id, name: i.name, hostname: i.hostname, vpcId: i.vpcId });
      locations.set(i.nodeId, loc);
    }
    return { items: rows.map(toVpc), locations: [...locations.values()], limit: settings.vpcLimit };
  });

  app.post(prefix, { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req): Promise<VpcDTO> => {
    const userId = await scope.ownerId(req);
    const body = parse(
      z.object({ name: nameSchema, cidr: z.string().trim().max(32).optional().transform((v) => v || undefined), nodeId: z.number().int().positive() }),
      req.body,
    );
    const vpc = await createVpc(userId, body, { ignoreLimit: admin });
    await log(req, userId, 'instance.vpc_create', `${vpc.name} ${vpc.cidr}`);
    return dto(vpc.id);
  });

  app.patch(`${prefix}/:id`, async (req): Promise<VpcDTO> => {
    const userId = await scope.ownerId(req);
    const { id } = parse(idParam.passthrough(), req.params);
    const { name } = parse(z.object({ name: nameSchema }), req.body);
    await loadVpc(userId, id);
    await prisma.vpc.update({ where: { id }, data: { name } });
    return dto(id);
  });

  app.delete(`${prefix}/:id`, async (req) => {
    const userId = await scope.ownerId(req);
    const { id } = parse(idParam.passthrough(), req.params);
    const vpc = await loadVpc(userId, id);
    await deleteVpc(vpc);
    await log(req, userId, 'instance.vpc_delete', vpc.name);
    return { ok: true };
  });

  /** 加入实例：不填地址时自动分配；返回实例内是否已配置好地址 */
  app.post(`${prefix}/:id/instances`, async (req) => {
    const userId = await scope.ownerId(req);
    const { id } = parse(idParam.passthrough(), req.params);
    const body = parse(z.object({ instanceId: z.number().int().positive(), ip: z.string().trim().max(15).optional().transform((v) => v || undefined) }), req.body);
    const vpc = await loadVpc(userId, id);
    const inst = await prisma.instance.findFirst({ where: { id: body.instanceId, userId, status: activeStatus }, include: { node: true } });
    if (!inst) throw notFound(t('instance.notFound'));
    const r = await attachInstance(vpc, inst, body.ip);
    await log(req, userId, 'instance.vpc_attach', `#${inst.id} → ${vpc.name} ${r.ip}`);
    return { ...r, vpc: await dto(id) };
  });

  app.delete(`${prefix}/:id/instances/:instanceId`, async (req) => {
    const userId = await scope.ownerId(req);
    const { id, instanceId } = parse(z.object({ id: z.coerce.number().int().positive(), instanceId: z.coerce.number().int().positive() }).passthrough(), req.params);
    await loadVpc(userId, id);
    const inst = await prisma.instance.findFirst({ where: { id: instanceId, userId, vpcId: id }, include: { node: true } });
    if (!inst) throw notFound(t('vpc.notMember'));
    await detachInstance(inst);
    await log(req, userId, 'instance.vpc_detach', `#${inst.id} ← ${id}`);
    return dto(id);
  });
}

/** 用户：自己的 VPC */
export default async function vpcRoutes(app: FastifyInstance) {
  app.addHook('preHandler', consoleGuard);
  registerVpcRoutes(app, { prefix: '/api/vpcs', admin: false, ownerId: async (req) => requireUser(req).id });
}

/** 管理员：在用户管理里管理该用户的 VPC */
export async function adminUserVpcRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  registerVpcRoutes(app, {
    prefix: '/api/admin/users/:uid/vpcs',
    admin: true,
    ownerId: async (req) => {
      const { uid } = parse(z.object({ uid: z.coerce.number().int().positive() }).passthrough(), req.params);
      const user = await prisma.user.findUnique({ where: { id: uid }, select: { id: true } });
      if (!user) throw notFound(t('user.notFound'));
      return user.id;
    },
  });
}

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BOOT_AUTOSTART_MODES, BOOT_LIMITS, bootOptions, CPU_PRIORITY_MAX, IMAGE_ARCHES, INSTANCE_TYPES, IPV6_COUNT_MAX, isNatType, isPublicIpv4Mode, isVmType, OVER_LIMIT_ACTIONS, PROCESS_LIMIT_MIN, TRAFFIC_MODES, TRAFFIC_MULTIPLIER_MAX, TRAFFIC_MULTIPLIER_MIN, type InstanceType, type ProductNodeOption } from '../../shared/index.ts';
import { badRequest, conflict } from '../../lib/errors.ts';
import { adminGuard, ensureFound, idParam, logActivity, parse, parsePatch, requireAdmin } from '../../lib/http.ts';
import { prisma, Prisma } from '../../lib/prisma.ts';
import { toAdminImage, toAdminPlan, toAdminProduct } from '../../services/serializers.ts';
import { m, t } from '../../i18n/index.ts';
import { loadSalePlans } from '../store.ts';
import { enqueueTask } from '../../services/tasks.ts';
import { assertDiskLimits } from '../../services/spec.ts';
import { invalidateCache } from '../../lib/cache.ts';
import { OPS_STATUSES } from '../../services/node-ops.ts';

const imageFields = {
  name: z.string().trim().min(1, m('v.nameRequired')).max(64),
  family: z.string().trim().toLowerCase().min(1).max(32).default('linux'),
  alias: z.string().trim().min(1, m('v.aliasRequired')).max(200),
  server: z.string().trim().url().default('https://images.linuxcontainers.org'),
  protocol: z.enum(['simplestreams', 'incus', 'oci']).default('simplestreams'),
  forContainer: z.boolean().default(true),
  forVm: z.boolean().default(true),
  arch: z.enum(IMAGE_ARCHES).default('x86_64'),
  cloudInit: z.string().max(20_000).nullable().optional().transform((v) => (v?.trim() ? v : null)),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
};

const price = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : new Prisma.Decimal(v)))
  .refine((v) => v === null || (v.isFinite() && !v.isNegative()), m('v.price'));

const productFields = {
  name: z.string().trim().min(1, m('v.productNameRequired')).max(64),
  type: z.enum(INSTANCE_TYPES).default('LXC_NAT'),
  description: z.string().trim().max(2000).nullable().optional().transform((v) => v || null),
  // 去重、去空白，最多 8 个
  tags: z
    .array(z.string().trim().max(32))
    .max(8)
    .default([])
    .transform((v) => [...new Set(v.filter(Boolean))]),
  privileged: z.boolean().default(false),
  nesting: z.boolean().default(true),
  // 启动设置：数值留空（null）使用 Incus 默认值
  boot: z
    .object({
      autostart: z.enum(BOOT_AUTOSTART_MODES).default('ALWAYS'),
      delay: z.number().int().min(0).max(BOOT_LIMITS.delay).nullable().default(null),
      priority: z.number().int().min(0).max(BOOT_LIMITS.priority).nullable().default(null),
      stopPriority: z.number().int().min(0).max(BOOT_LIMITS.stopPriority).nullable().default(null),
      shutdownTimeout: z.number().int().min(0).max(BOOT_LIMITS.shutdownTimeout).nullable().default(null),
    })
    .default({ autostart: 'ALWAYS', delay: null, priority: null, stopPriority: null, shutdownTimeout: null }),
  // 以宿主机 ID 为键：系统盘存储池（空为宿主机默认）与流量倍率
  nodeOptions: z
    .record(
      z.string().regex(/^\d+$/),
      z.object({
        storagePool: z
          .string()
          .trim()
          .max(64)
          .nullable()
          .optional()
          .transform((v) => v || null)
          .refine((v) => v === null || /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(v), m('pool.nameInvalid')),
        trafficMultiplier: z.number().min(TRAFFIC_MULTIPLIER_MIN, m('v.multiplier')).max(TRAFFIC_MULTIPLIER_MAX, m('v.multiplier')).default(1),
      }),
    )
    .default({}),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
  nodeIds: z.array(z.number().int()).default([]),
};

/** 只保留已绑定宿主机上与默认值不同的设置 */
function cleanNodeOptions(options: Record<string, ProductNodeOption>, nodeIds: number[]): Prisma.InputJsonObject {
  return Object.fromEntries(
    Object.entries(options)
      .filter(([id, o]) => nodeIds.includes(Number(id)) && (o.storagePool !== null || o.trafficMultiplier !== 1))
      .map(([id, o]) => [id, { storagePool: o.storagePool, trafficMultiplier: o.trafficMultiplier }]),
  );
}

const planFields = {
  productId: z.number().int().positive(m('v.productRequired')),
  name: z.string().trim().min(1, m('v.planNameRequired')).max(64),
  description: z.string().trim().max(500).nullable().optional(),
  // 实例类型跟随所属产品，客户端传入的值会被忽略
  type: z.enum(INSTANCE_TYPES).optional(),
  cpu: z.number().int().min(1).max(256),
  cpuAllowance: z.number().int().min(1).max(100).nullable().optional(),
  cpuPriority: z.number().int().min(0).max(CPU_PRIORITY_MAX).nullable().optional(),
  processLimit: z.number().int().min(PROCESS_LIMIT_MIN).max(1_000_000).nullable().optional(),
  memory: z.number().int().min(64),
  swap: z.number().int().min(0).max(65536).default(0),
  disk: z.number().int().min(1),
  diskRead: z.number().int().min(0).max(100_000).default(0),
  diskWrite: z.number().int().min(0).max(100_000).default(0),
  diskReadIops: z.number().int().min(0).max(10_000_000).default(0),
  diskWriteIops: z.number().int().min(0).max(10_000_000).default(0),
  bandwidthIn: z.number().int().min(0),
  bandwidthOut: z.number().int().min(0),
  traffic: z.number().int().min(0).default(0),
  trafficMode: z.enum(TRAFFIC_MODES).default('OUT'),
  overLimitAction: z.enum(OVER_LIMIT_ACTIONS).default('THROTTLE'),
  throttleRate: z.number().int().min(1).default(1),
  trafficResetPrice: price,
  portLimit: z.number().int().min(0).default(10),
  siteLimit: z.number().int().min(0).default(0),
  snapshotLimit: z.number().int().min(0).default(1),
  ipv6Count: z.number().int().min(0).max(IPV6_COUNT_MAX).default(0),
  storagePool: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .optional()
    .transform((v) => v || null),
  priceMonthly: price,
  priceQuarterly: price,
  priceSemiannual: price,
  priceAnnual: price,
  stock: z.number().int().min(0).nullable().optional(),
  enabled: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
};

const productInclude = {
  nodes: { select: { id: true, name: true, region: true, enabled: true, country: true, networkMode: true }, orderBy: { id: 'asc' } },
  plans: { select: { id: true } },
} as const;

/** 后台产品列表：附带实例数与是否出现在购买页 */
async function adminProducts(where: Prisma.ProductWhereInput = {}) {
  const [rows, counts, sale] = await Promise.all([
    prisma.product.findMany({ where, include: productInclude, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] }),
    prisma.instance.groupBy({ by: ['planId'], where: { status: { not: 'DELETED' }, planId: { not: null } }, _count: { _all: true } }),
    loadSalePlans(),
  ]);
  const plans = await prisma.plan.findMany({ where: { id: { in: counts.map((c) => c.planId!) } }, select: { id: true, productId: true } });
  return rows.map((p) => {
    const mine = new Set(plans.filter((x) => x.productId === p.id).map((x) => x.id));
    return toAdminProduct(p, {
      activeInstances: counts.filter((c) => mine.has(c.planId!)).reduce((n, c) => n + c._count._all, 0),
      listed: p.enabled && sale.some((x) => x.productId === p.id),
    });
  });
}

const planInclude = { product: { select: { nodeOptions: true, nodes: { select: { id: true, region: true, enabled: true, networkMode: true } } } } } as const;

async function loadProduct(id: number) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product) throw badRequest(t('product.notFound'));
  return product;
}

/** 绑定的宿主机网络模式必须与产品类型匹配（NAT 类型 ↔ NAT / IPv6 宿主机，独立 IPv4 ↔ IPv4 宿主机） */
async function ensureNodesFit(type: InstanceType, nodeIds: number[]) {
  const nodes = await prisma.node.findMany({ where: { id: { in: nodeIds } }, select: { name: true, networkMode: true } });
  const bad = nodes.find((n) => isPublicIpv4Mode(n.networkMode) === isNatType(type));
  if (bad) throw badRequest(t('product.nodeMismatch', { name: bad.name }));
}

/** 独立 IPv4 套餐没有端口映射与建站；虚拟机没有进程数限制与 SWAP */
const typeLimits = (type: InstanceType) => ({ ...(type === 'KVM_IPV4' ? { portLimit: 0, siteLimit: 0 } : {}), ...(isVmType(type) ? { processLimit: null, swap: 0 } : {}) });

async function planWithCount(id: number) {
  const plan = await prisma.plan.findUniqueOrThrow({ where: { id }, include: planInclude });
  const count = await prisma.instance.count({ where: { planId: id, status: { not: 'DELETED' } } });
  return toAdminPlan(plan, count);
}

export default async function adminCatalogRoutes(app: FastifyInstance) {
  app.addHook('preHandler', adminGuard);
  // 修改成功后，首页与购买页使用的在售目录缓存（Redis）立即失效
  app.addHook('onResponse', async (req, reply) => {
    if (req.method !== 'GET' && reply.statusCode < 400) await invalidateCache('catalog');
  });

  // ───────── 镜像 ─────────

  app.get('/api/admin/images', async () => {
    const rows = await prisma.image.findMany({ orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    return rows.map(toAdminImage);
  });

  app.post('/api/admin/images', async (req) => {
    const admin = requireAdmin(req);
    const body = parse(z.object(imageFields), req.body);
    const image = await prisma.image.create({ data: body });
    await logActivity(req, admin.id, 'admin.image_create', image.name);
    return toAdminImage(image);
  });

  app.patch('/api/admin/images/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const body = parsePatch(imageFields, req.body);
    return toAdminImage(await prisma.image.update({ where: { id }, data: body }));
  });

  app.delete('/api/admin/images/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const image = await prisma.image.delete({ where: { id } });
    await logActivity(req, admin.id, 'admin.image_delete', image.name);
    return { ok: true };
  });

  // ───────── 产品 ─────────

  app.get('/api/admin/products', () => adminProducts());

  app.post('/api/admin/products', async (req) => {
    const admin = requireAdmin(req);
    const { nodeIds, nodeOptions, ...data } = parse(z.object(productFields), req.body);
    await ensureNodesFit(data.type, nodeIds);
    const product = await prisma.product.create({
      data: { ...data, nodeOptions: cleanNodeOptions(nodeOptions, nodeIds), nodes: { connect: nodeIds.map((id) => ({ id })) } },
    });
    await logActivity(req, admin.id, 'admin.product_create', product.name);
    return (await adminProducts({ id: product.id }))[0];
  });

  app.patch('/api/admin/products/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { nodeIds, nodeOptions, ...data } = parsePatch(productFields, req.body);
    const current = ensureFound(await prisma.product.findUnique({ where: { id }, include: { nodes: { select: { id: true } } } }), t('product.notFound'));
    const bound = nodeIds ?? current.nodes.map((n) => n.id);
    const type = data.type ?? current.type;
    await ensureNodesFit(type, bound);
    // 解绑宿主机时一并清掉它的设置
    const options = nodeOptions ?? (current.nodeOptions as Record<string, ProductNodeOption> | null) ?? {};
    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id },
        data: { ...data, nodeOptions: cleanNodeOptions(options, bound), ...(nodeIds ? { nodes: { set: nodeIds.map((n) => ({ id: n })) } } : {}) },
      });
      // 类型变化时其下套餐一起改变；已开通的实例保留自己的类型
      if (type !== current.type) await tx.plan.updateMany({ where: { productId: id }, data: { type, ...typeLimits(type) } });
      return updated;
    });
    // 启动设置变化时同步到产品下的实例，并下发到宿主机
    if (data.boot && JSON.stringify(bootOptions(current.boot)) !== JSON.stringify(bootOptions(data.boot))) {
      await prisma.instance.updateMany({ where: { plan: { productId: id }, status: { not: 'DELETED' } }, data: { boot: data.boot } });
      const active = await prisma.instance.findMany({ where: { plan: { productId: id }, status: { in: OPS_STATUSES }, provisionedAt: { not: null } }, select: { id: true } });
      for (const inst of active) await enqueueTask({ instanceId: inst.id, type: 'APPLY_LIMITS', userId: admin.id, exclusive: false });
    }
    await logActivity(req, admin.id, 'admin.product_update', product.name);
    return (await adminProducts({ id: product.id }))[0];
  });

  app.delete('/api/admin/products/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const plans = await prisma.plan.count({ where: { productId: id } });
    if (plans > 0) throw conflict(t('product.hasPlans', { count: plans }));
    const product = await prisma.product.delete({ where: { id } });
    await logActivity(req, admin.id, 'admin.product_delete', product.name);
    return { ok: true };
  });

  // ───────── 套餐 ─────────

  app.get('/api/admin/plans', async () => {
    const plans = await prisma.plan.findMany({ include: planInclude, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] });
    const counts = await prisma.instance.groupBy({
      by: ['planId'],
      where: { status: { not: 'DELETED' } },
      _count: { _all: true },
    });
    return plans.map((p) => toAdminPlan(p, counts.find((c) => c.planId === p.id)?._count._all ?? 0));
  });

  app.get('/api/admin/plans/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    ensureFound(await prisma.plan.findUnique({ where: { id } }), t('plan.notFound'));
    return planWithCount(id);
  });

  app.post('/api/admin/plans', async (req) => {
    const admin = requireAdmin(req);
    const data = parse(z.object(planFields), req.body);
    assertDiskLimits(data);
    const product = await loadProduct(data.productId);
    const plan = await prisma.plan.create({ data: { ...data, type: product.type, ...typeLimits(product.type) } });
    await logActivity(req, admin.id, 'admin.plan_create', plan.name);
    return planWithCount(plan.id);
  });

  app.patch('/api/admin/plans/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const { type: _ignored, ...data } = parsePatch(planFields, req.body);
    // 换到其他产品时类型随新产品
    const product = data.productId ? await loadProduct(data.productId) : null;
    const current = await prisma.plan.findUniqueOrThrow({ where: { id } });
    assertDiskLimits(data, current);
    const type = product?.type ?? current.type;
    const plan = await prisma.plan.update({ where: { id }, data: { ...data, type, ...typeLimits(type) } });
    await logActivity(req, admin.id, 'admin.plan_update', plan.name);
    return planWithCount(id);
  });

  app.delete('/api/admin/plans/:id', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(idParam, req.params);
    const active = await prisma.instance.count({ where: { planId: id, status: { not: 'DELETED' } } });
    if (active > 0) throw conflict(t('plan.hasInstances', { count: active }));
    const plan = await prisma.plan.delete({ where: { id } });
    await logActivity(req, admin.id, 'admin.plan_delete', plan.name);
    return { ok: true };
  });
}

/**
 * 初始化数据：
 *  - 管理员账户（ADMIN_EMAIL / ADMIN_USERNAME / ADMIN_PASSWORD）
 *  - 常用系统镜像
 *  - SEED_DEMO=true 时额外创建模拟节点、套餐与演示用户
 */
import 'dotenv/config';
import { IMAGE_PRESETS } from '../src/shared/index.ts';
import { hashPassword } from '../src/lib/crypto.ts';
import { prisma, Prisma } from '../src/lib/prisma.ts';
import { redis } from '../src/lib/redis.ts';
import { initializeAdmin } from '../src/services/admin-init.ts';

/** 常用系统镜像：与管理后台“添加常用镜像”共用同一份列表 */
const IMAGES = IMAGE_PRESETS;

async function main() {
  const admin = await initializeAdmin();
  console.log(admin.created ? `✔ 已创建管理员 ${admin.username} / ${admin.email}` : '• 数据库中已有管理员，跳过初始化');

  if ((await prisma.image.count()) === 0) {
    await prisma.image.createMany({
      data: IMAGES.map((img, i) => ({
        name: img.name,
        family: img.family,
        alias: img.alias,
        forContainer: true,
        forVm: img.forVm,
        sortOrder: (i + 1) * 10,
      })),
    });
    console.log(`✔ 已创建 ${IMAGES.length} 个系统镜像`);
  }

  if (process.env.SEED_DEMO === 'true' && (await prisma.node.count()) === 0) {
    const hk = await prisma.node.create({
      data: {
        name: 'HK-Demo-01',
        region: '香港',
        country: 'HK',
        description: 'Hong Kong DC1',
        networkMode: 'NAT',
        endpoint: 'mock://hk1',
        publicIp: '203.0.113.10',
        portRangeStart: 20000,
        portRangeEnd: 29999,
        status: 'ONLINE',
      },
    });
    const jp = await prisma.node.create({
      data: {
        name: 'JP-Demo-01',
        region: '日本东京',
        country: 'JP',
        description: 'Tokyo DC2',
        networkMode: 'IPV4',
        endpoint: 'mock://jp1',
        publicIp: '198.51.100.20',
        portRangeStart: 30000,
        portRangeEnd: 39999,
        status: 'ONLINE',
      },
    });
    await prisma.ipAddress.createMany({
      data: Array.from({ length: 6 }, (_, i) => ({ nodeId: hk.id, address: `203.0.113.${100 + i}` })),
    });
    await prisma.ipAddress.createMany({
      data: Array.from({ length: 4 }, (_, i) => ({ nodeId: jp.id, address: `198.51.100.${50 + i}` })),
    });

    const D = (v: number) => new Prisma.Decimal(v);
    // 产品绑定宿主机，产品下的套餐跟随产品的宿主机
    // 产品决定实例类型，并只绑定网络模式匹配的宿主机（NAT 类型 ↔ NAT 宿主机，独立 IPv4 ↔ IPv4 宿主机）
    const nat = { connect: [{ id: hk.id }] };
    const lxc = await prisma.product.create({ data: { name: 'LXC 容器', type: 'LXC_NAT', description: '轻量容器，开通快、价格低，适合建站、代理与小工具', tags: ['NAT', '秒级开通'], sortOrder: 1, nodes: nat } });
    const kvm = await prisma.product.create({ data: { name: 'KVM 虚拟机', type: 'KVM_NAT', description: '独立内核，可运行 Docker / WireGuard', tags: ['独立内核'], sortOrder: 2, nodes: nat } });
    const ipv4 = await prisma.product.create({ data: { name: 'KVM 独立 IPv4', type: 'KVM_IPV4', description: '独立公网 IPv4，无需端口映射', tags: ['独立 IPv4'], sortOrder: 3, nodes: { connect: [{ id: jp.id }] } } });
    const plans: Array<Omit<Prisma.PlanUncheckedCreateInput, 'productId'> & { product: number }> = [
      {
        product: lxc.id, name: 'LXC NAT 入门', type: 'LXC_NAT', cpu: 1, cpuAllowance: 50, memory: 512, disk: 5, bandwidthIn: 100, bandwidthOut: 50,
        traffic: 200, trafficMode: 'OUT', portLimit: 10, siteLimit: 2, snapshotLimit: 1,
        priceMonthly: D(5), priceQuarterly: D(14), priceAnnual: D(50), description: '适合建站、代理、小工具', sortOrder: 1,
      },
      {
        product: lxc.id, name: 'LXC NAT 标准', type: 'LXC_NAT', cpu: 2, memory: 1024, disk: 10, bandwidthIn: 200, bandwidthOut: 100,
        traffic: 500, trafficMode: 'OUT', portLimit: 20, siteLimit: 5, snapshotLimit: 2,
        priceMonthly: D(9.9), priceQuarterly: D(28), priceSemiannual: D(54), priceAnnual: D(99), sortOrder: 2,
      },
      {
        product: kvm.id, name: 'KVM NAT 标准', type: 'KVM_NAT', cpu: 2, memory: 2048, disk: 20, bandwidthIn: 300, bandwidthOut: 100,
        traffic: 800, trafficMode: 'BOTH', overLimitAction: 'THROTTLE', throttleRate: 2, portLimit: 20, siteLimit: 5, snapshotLimit: 2,
        priceMonthly: D(19), priceQuarterly: D(54), priceAnnual: D(199), description: '独立内核，可运行 Docker / WireGuard', sortOrder: 3,
      },
      {
        product: ipv4.id, name: 'KVM 独立 IPv4', type: 'KVM_IPV4', cpu: 2, memory: 4096, disk: 40, bandwidthIn: 1000, bandwidthOut: 200,
        traffic: 2000, trafficMode: 'MAX', overLimitAction: 'STOP', portLimit: 0, siteLimit: 0, snapshotLimit: 3,
        priceMonthly: D(49), priceQuarterly: D(139), priceSemiannual: D(269), priceAnnual: D(499), stock: 10, sortOrder: 4,
      },
    ];
    for (const { product, ...p } of plans) {
      await prisma.plan.create({ data: { ...p, productId: product } });
    }

    await prisma.user.create({
      data: {
        email: 'demo@example.com',
        username: 'demo',
        passwordHash: await hashPassword('demo123456'),
        balance: D(200),
        balanceLogs: { create: { type: 'ADJUST', amount: D(200), balanceAfter: D(200), description: '演示账户初始余额' } },
      },
    });
    await prisma.announcement.create({
      data: {
        title: '欢迎使用 PaleDove',
        content: '这是一个演示环境，节点为模拟节点（mock://），实例数据与资源占用均为模拟值。\n演示账户：demo / demo123456',
        pinned: true,
      },
    });
    console.log('✔ 已创建演示节点、套餐与用户 demo / demo123456');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    redis.disconnect();
  });

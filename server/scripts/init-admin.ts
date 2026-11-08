import 'dotenv/config';
import { prisma } from '../src/lib/prisma.ts';
import { AdminInitializationError, initializeAdmin } from '../src/services/admin-init.ts';

try {
  const admin = await initializeAdmin();
  console.log(admin.created ? `✔ 已创建管理员 ${admin.username} / ${admin.email}` : '• 数据库中已有管理员，跳过初始化');
} catch (error) {
  console.error(error instanceof AdminInitializationError ? error.message : '管理员初始化失败，请检查数据库连接和迁移状态。');
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}

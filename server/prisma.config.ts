import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // generate 不需要数据库连接；migrate 等命令在未配置时会给出明确错误
    url: process.env.DATABASE_URL ?? '',
  },
});

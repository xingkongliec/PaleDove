// 首次启动自动构建缺失的页面；pnpm start 还会准备服务端构建产物。
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startupBuilds(serverDir, env = process.env, startServer = false) {
  const builds = [];
  const webDist = resolve(serverDir, env.WEB_DIST ?? '../web/dist');
  if (env.SKIP_WEB_BUILD !== '1' && env.WEB_DIST !== '' && !existsSync(resolve(webDist, 'index.html'))) builds.push('@paledove/web');
  if (startServer) {
    const sqlite = (env.DATABASE_URL ?? (env.NODE_ENV === 'production' ? '' : 'file:./data/dev.db')).startsWith('file:');
    if (!existsSync(resolve(serverDir, 'dist/index.js')) || (sqlite && !existsSync(resolve(serverDir, 'dist/prisma-sqlite.js')))) builds.push('@paledove/server');
  }
  return builds;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const serverDir = fileURLToPath(new URL('../', import.meta.url));
  for (const name of startupBuilds(serverDir, process.env, process.argv.includes('--server'))) {
    console.log(`未找到 ${name} 所需的构建产物，正在构建…`);
    const result = spawnSync(`pnpm --filter ${name} build`, {
      cwd: resolve(serverDir, '..'), stdio: 'inherit', shell: true,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

// 将服务端打包为单个 ESM 文件；node_modules 中的依赖保持外部引用，
// src/shared 内的共用代码与 Prisma 生成代码会被打包进来。
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {});

await build({
  entryPoints: { index: 'src/index.ts', seed: 'prisma/seed.ts', 'init-admin': 'scripts/init-admin.ts', 'prisma-sqlite': 'src/lib/prisma-sqlite.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  // SQLite 单独打包、按需加载；生产镜像只安装 PostgreSQL 的运行依赖。
  external: [...external, ...external.map((d) => `${d}/*`), '@prisma/adapter-better-sqlite3'],
  plugins: [{
    name: 'sqlite-runtime',
    setup(builder) {
      builder.onResolve({ filter: /^\.\/prisma-sqlite\.ts$/ }, () => ({ path: './prisma-sqlite.js', external: true }));
    },
  }],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
});

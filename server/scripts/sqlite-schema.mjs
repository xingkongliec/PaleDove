// 由 prisma/schema.prisma（PostgreSQL）派生本地开发用的 SQLite schema，避免维护两份模型定义。
// 输出 prisma/sqlite/schema.prisma，客户端生成到 src/generated/prisma-sqlite。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');

const out = src
  .replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"')
  .replace(/output\s*=\s*"\.\.\/src\/generated\/prisma"/, 'output       = "../../src/generated/prisma-sqlite"')
  // SQLite 不支持原生类型注解（@db.Decimal(12, 2)、@db.Date 等）
  .replace(/\s*@db\.\w+(\([^)]*\))?/g, '');

if (!out.includes('provider = "sqlite"') || !out.includes('prisma-sqlite')) {
  throw new Error('sqlite-schema: failed to rewrite datasource / generator block');
}

mkdirSync(new URL('../prisma/sqlite/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../prisma/sqlite/schema.prisma', import.meta.url),
  `// 自动生成，请勿编辑：由 scripts/sqlite-schema.mjs 根据 prisma/schema.prisma 生成\n\n${out}`,
);

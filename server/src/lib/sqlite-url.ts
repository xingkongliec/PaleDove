import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * 把 file:./data/dev.db 规范为绝对路径（相对于工作目录，即 server），
 * 保证 Prisma CLI 与运行时打开的是同一个文件，并确保目录存在。
 */
export function sqliteUrl(url: string): string {
  const raw = url.replace(/^file:/, '');
  const file = isAbsolute(raw) ? raw : resolve(raw);
  mkdirSync(dirname(file), { recursive: true });
  return `file:${file}`;
}

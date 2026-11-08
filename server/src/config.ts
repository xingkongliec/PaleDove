import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .optional()
    .transform((v) => (v === undefined ? def : ['true', '1', 'yes'].includes(v)));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required').prefault(process.env.NODE_ENV === 'production' ? '' : 'file:./data/dev.db'),
  REDIS_URL: z.string().default(process.env.NODE_ENV === 'production' ? 'redis://127.0.0.1:6379/0' : 'memory://'),
  APP_SECRET: z.string().min(16, 'APP_SECRET must be at least 16 characters'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** 会话有效期（小时） */
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /** 是否只通过 HTTPS 发送 Cookie；未设置时生产环境默认开启 */
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  /** 位于反向代理之后时开启，以获取真实客户端 IP */
  TRUST_PROXY: bool(false),
  /** 本进程是否运行 HTTP API */
  RUN_API: bool(true),
  /** 本进程是否运行后台任务 Worker 与定时任务 */
  RUN_WORKER: bool(true),
  /** 面板对外访问地址（宿主机安装脚本回连、支付回调使用），如 https://panel.example.com；未设置时根据请求推断 */
  PANEL_URL: z.union([z.url('PANEL_URL must be a URL like https://panel.example.com'), z.literal('')]).optional().transform((v) => v?.replace(/\/+$/, '') || undefined),
  /** 前端构建产物目录，设置后由后端直接托管 */
  WEB_DIST: z.string().default('../web/dist'),
  /** 宿主机 Agent 二进制目录（pnpm build:agent 的输出），默认 ../agent/dist */
  AGENT_DIST: z.string().optional(),
  /** 正式 Agent 从本项目的 GitHub Release 下载；未设置时使用本地构建 */
  AGENT_RELEASE_REPOSITORY: z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).or(z.literal('')).optional().transform((v) => v || undefined),
  AGENT_RELEASE_TOKEN: z.string().trim().optional(),
  /** 可选磁盘缓存；默认使用操作系统临时目录，写入失败不影响下载 */
  AGENT_RELEASE_CACHE_DIR: z.string().trim().optional(),
  /** 开发者提供的 Incus 客户端证书目录；相对路径以 server 为基准 */
  INCUS_CERT_DIR: z.string().trim().min(1).default('certs/incus'),
  /** 资源采集间隔（秒） */
  METRICS_INTERVAL_SEC: z.coerce.number().int().min(10).default(60),
  /** 任务并发数 */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(4),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  ...env,
  // 源码位于 src/config.ts，生产包位于 dist/index.js，两者的上一级均为服务目录。
  webDist: env.WEB_DIST ? resolve(fileURLToPath(new URL('../', import.meta.url)), env.WEB_DIST) : undefined,
  incusCertificateDirectory: resolve(fileURLToPath(new URL('../', import.meta.url)), env.INCUS_CERT_DIR),
  agentBinaryDirectory: resolve(fileURLToPath(new URL('../', import.meta.url)), env.AGENT_DIST || '../agent/dist'),
  agentReleaseCacheDirectory: env.AGENT_RELEASE_CACHE_DIR ? resolve(fileURLToPath(new URL('../', import.meta.url)), env.AGENT_RELEASE_CACHE_DIR) : undefined,
  isProd: env.NODE_ENV === 'production',
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
  /** REDIS_URL 为空或 memory:// 时使用进程内存储与任务队列，仅适用于单进程的本地开发 */
  memoryRedis: env.REDIS_URL === '' || env.REDIS_URL.startsWith('memory:'),
};

export type AppConfig = typeof config;

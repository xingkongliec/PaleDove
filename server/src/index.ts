import { config } from './config.ts';
import { buildApp } from './app.ts';
import { getClientCertificate, getClientCertificatePaths } from './incus/certs.ts';
import { closeQueues } from './jobs/queue.ts';
import { startWorkers } from './jobs/worker.ts';
import { isSqlite, prisma } from './lib/prisma.ts';
import { redis } from './lib/redis.ts';
import { recoverListingPings } from './services/market-ping.ts';
import { errorMessage } from './lib/errors.ts';
import { logStartup } from './lib/logger.ts';

const startedAt = performance.now();
const app = await buildApp();
app.log.info({ scope: 'SYSTEM' }, '正在启动后端，检查运行环境');

if (config.memoryRedis) {
  if (config.isProd) app.log.warn({ scope: 'STORAGE' }, '生产环境正在使用内存缓存与队列，请配置 REDIS_URL');
  if (!config.RUN_WORKER) app.log.warn({ scope: 'WORKER' }, '内存队列无法跨进程共享，RUN_WORKER=false 时排队任务不会执行');
}
if (isSqlite && config.isProd) app.log.warn({ scope: 'STORAGE' }, '生产环境正在使用 SQLite，请配置 PostgreSQL');

// 证书由开发者部署；缺失时仍允许进入后台查看配置，真实节点连接会明确报错。
let certificateReady = false;
try {
  await getClientCertificate();
  certificateReady = true;
} catch (err) {
  app.log.warn({ scope: 'INCUS', reason: errorMessage(err) }, '节点证书未就绪，请将 client.crt 和 client.key 放入 INCUS_CERT_DIR');
  app.log.debug({ scope: 'INCUS', err, ...getClientCertificatePaths() }, '节点证书检查详情');
}

let stopWorkers: (() => Promise<void>) | null = null;
if (config.RUN_WORKER) {
  app.log.info({ scope: 'WORKER' }, '正在恢复任务队列与定时调度');
  stopWorkers = await startWorkers(app.log);
}

if (config.RUN_API) {
  await app.listen({ host: config.HOST, port: config.PORT, listenTextResolver: (address) => `API 监听 ${address}` });
  if (config.isProd && !config.PANEL_URL) {
    app.log.warn({ scope: 'MAIL' }, 'PANEL_URL 未配置，找回密码与验证邮箱的邮件无法发送，请在 .env 中设置');
  }
  // 继续等待重启前未完成的上架拨测
  void recoverListingPings().catch((err) => app.log.warn({ scope: 'TASK', err }, '恢复上架拨测失败'));
}

const serverAddress = app.server.address();
const host = config.HOST === '0.0.0.0' ? '127.0.0.1' : config.HOST === '::' ? '[::1]' : config.HOST.includes(':') ? `[${config.HOST}]` : config.HOST;
logStartup(app.log, {
  environment: config.isProd ? '生产环境' : config.NODE_ENV === 'test' ? '测试环境' : '开发环境',
  address: config.RUN_API ? `http://${host}:${typeof serverAddress === 'object' && serverAddress ? serverAddress.port : config.PORT}` : null,
  worker: config.RUN_WORKER,
  concurrency: config.WORKER_CONCURRENCY,
  sqlite: isSqlite,
  memoryRedis: config.memoryRedis,
  certificate: certificateReady,
  duration: performance.now() - startedAt,
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ scope: 'SYSTEM', signal }, '正在关闭服务');
  try {
    await app.close();
    await stopWorkers?.();
    await closeQueues();
    await prisma.$disconnect();
    redis.disconnect();
    app.log.info({ scope: 'SYSTEM' }, '服务已安全关闭');
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

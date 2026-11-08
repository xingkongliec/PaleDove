import { config } from './config.ts';
import { buildApp } from './app.ts';
import { getClientCertificate, getClientCertificatePaths } from './incus/certs.ts';
import { closeQueues } from './jobs/queue.ts';
import { startWorkers } from './jobs/worker.ts';
import { isSqlite, prisma } from './lib/prisma.ts';
import { redis } from './lib/redis.ts';
import { recoverListingPings } from './services/market-ping.ts';

const app = await buildApp();

if (config.memoryRedis) {
  app.log.warn('REDIS_URL=memory:// — using in-process store and task queue (single process, local development only)');
  if (!config.RUN_WORKER) app.log.warn('RUN_WORKER=false has no effect on other processes in memory mode: queued tasks will not run');
}
if (isSqlite) app.log.warn('DATABASE_URL=file:... — using SQLite (local development only)');

// 证书由开发者部署；缺失时仍允许进入后台查看配置，真实节点连接会明确报错。
try {
  await getClientCertificate();
} catch (err) {
  app.log.warn({ err, ...getClientCertificatePaths() }, 'Incus client certificate unavailable; deploy client.crt and client.key to INCUS_CERT_DIR');
}

let stopWorkers: (() => Promise<void>) | null = null;
if (config.RUN_WORKER) stopWorkers = await startWorkers(app.log);

if (config.RUN_API) {
  await app.listen({ host: config.HOST, port: config.PORT });
  if (config.isProd && !config.PANEL_URL) {
    app.log.warn('PANEL_URL 未配置：找回密码与验证邮箱的邮件不会发送（不使用可伪造的请求 Host 生成链接），请在 .env 中设置 PANEL_URL');
  }
  // 继续等待重启前未完成的上架拨测
  void recoverListingPings().catch((e) => app.log.warn(e, 'recover listing pings failed'));
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`received ${signal}, shutting down`);
  try {
    await app.close();
    await stopWorkers?.();
    await closeQueues();
    await prisma.$disconnect();
    redis.disconnect();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

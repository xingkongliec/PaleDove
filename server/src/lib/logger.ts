import { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import pretty from 'pino-pretty';

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;
type LogDestination = NonNullable<LoggerOptions['stream']>;

export interface LoggingConfig {
  LOG_LEVEL: string;
  LOG_FORMAT: 'pretty' | 'json';
}

/** Only replace routine access messages; retain Fastify's internal error diagnostics. */
export class CompactLogController extends LogController {
  override incomingRequest(): void {}
  override routeNotFound(): void {}
  override requestCompleted(error: Error | null | undefined, request: FastifyRequest, reply: FastifyReply): void {
    if (error) super.requestCompleted(error, request, reply);
  }
}

/** Query strings and installer path tokens must never enter access logs. */
export function logPath(url: string): string {
  return url.split(/[?#]/, 1)[0]
    .replace(/(\/api\/agent\/(?:nodes|reporter|caddy)\/)[^/]+(?=\/install\.sh$)/, '$1[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
}

const singleLine = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

export function prettyOptions(colorize = pretty.isColorSupported): pretty.PrettyOptions {
  return {
    colorize,
    colorizeObjects: false,
    useOnlyCustomProps: false,
    translateTime: 'SYS:HH:MM:ss',
    singleLine: true,
    ignore: 'pid,hostname,reqId,scope,method,url,statusCode,responseTime,startup',
    customPrettifiers: {
      level: (_value, _key, _log, { label, labelColorized }) => labelColorized + ' '.repeat(Math.max(0, 5 - label.length)),
    },
    messageFormat(log, messageKey, _levelLabel, { colors }) {
      const scope = colors.cyan(singleLine(log.scope || 'APP').padEnd(7));
      if (log.scope === 'HTTP' && typeof log.statusCode === 'number') {
        const code = String(log.statusCode);
        const status = log.statusCode >= 500 ? colors.red(code) : log.statusCode >= 400 ? colors.yellow(code) : colors.green(code);
        const duration = Number(log.responseTime ?? 0).toFixed(1).padStart(7);
        const requestId = log.statusCode >= 400 && log.reqId ? colors.gray(`  #${singleLine(log.reqId)}`) : '';
        return `${scope} ${singleLine(log.method).padEnd(6)} ${status} ${duration} ms  ${singleLine(log.url)}${requestId}`;
      }
      const requestId = log.reqId ? colors.gray(`  #${singleLine(log.reqId)}`) : '';
      const message = `${scope} ${singleLine(log[messageKey])}${requestId}`;
      if (!log.startup || typeof log.startup !== 'object') return message;
      const rows = Object.entries(log.startup).map(([key, value]) => `    │  ${key}  ${singleLine(value)}`);
      return `${message}\n    ┌─ 服务概况\n${rows.join('\n')}\n    └────────────────────────────────────────`;
    },
  };
}

export function createLoggerOptions(config: LoggingConfig, destination?: LogDestination): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    redact: ['req.headers.cookie', 'req.headers.authorization'],
    serializers: {
      req: (req) => ({ method: req.method, url: logPath(req.url), remoteAddress: req.ip }),
      res: (reply) => ({ statusCode: reply.statusCode }),
    },
    ...(config.LOG_FORMAT === 'pretty'
      ? { stream: pretty({ ...prettyOptions(), sync: true, ...(destination ? { destination } : {}) }) }
      : destination ? { stream: destination } : {}),
  };
}

export function registerRequestLogging(app: FastifyInstance, enabled: boolean): void {
  app.addHook('onResponse', (req, reply, done) => {
    const statusCode = reply.statusCode;
    if (!enabled && statusCode < 400) return done();
    const url = logPath(req.url);
    const polling = url === '/api/health'
      || /^\/api\/agent\/nodes\/(?:report|instance-states|vm-limits|ping-targets|ping-results|egress|egress-status)$/.test(url)
      || (req.method === 'GET' && (/\/(?:state|metrics|traffic|tasks)$/.test(url) || !url.startsWith('/api/')));
    const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : polling ? 'debug' : 'info';
    req.log[level]({ scope: 'HTTP', method: req.method, url, statusCode, responseTime: Math.round(reply.elapsedTime * 10) / 10 }, '请求完成');
    done();
  });
}

export function logStartup(log: FastifyBaseLogger, details: {
  environment: string;
  address: string | null;
  worker: boolean;
  concurrency: number;
  sqlite: boolean;
  memoryRedis: boolean;
  certificate: boolean;
  duration: number;
}): void {
  log.info({
    scope: 'SYSTEM',
    startup: {
      '运行模式': details.environment,
      '服务地址': details.address ?? 'API 已关闭（仅运行后台任务）',
      '后台任务': details.worker ? `已启用 · 并发 ${details.concurrency}` : '已关闭',
      '数据存储': `${details.sqlite ? 'SQLite' : 'PostgreSQL'} / ${details.memoryRedis ? '内存缓存与队列（单进程）' : 'Redis'}`,
      '节点证书': details.certificate ? '已加载' : '未就绪，请检查 INCUS_CERT_DIR',
      '启动耗时': `${Math.round(details.duration)} ms`,
    },
  }, 'PaleDove 后端已就绪');
}

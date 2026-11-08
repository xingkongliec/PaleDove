import { Writable } from 'node:stream';
import Fastify from 'fastify';
import pretty from 'pino-pretty';
import { afterEach, describe, expect, it } from 'vitest';
import { CompactLogController, createLoggerOptions, logPath, logStartup, prettyOptions, registerRequestLogging } from '../src/lib/logger.ts';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

function fixture({ level = 'info', format = 'json', requests = true }: { level?: string; format?: 'pretty' | 'json'; requests?: boolean } = {}) {
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  const app = Fastify({ logger: createLoggerOptions({ LOG_LEVEL: level, LOG_FORMAT: format }, stream), logController: new CompactLogController() });
  apps.push(app);
  registerRequestLogging(app, requests);
  app.get('/api/instances', async () => ({ ok: true }));
  app.get('/api/health', async () => ({ ok: true }));
  app.post('/api/agent/nodes/report', async () => ({ ok: true }));
  app.get('/api/instances/:id/state', async () => ({ ok: true }));
  app.get('/api/instances/:id/metrics', async () => ({ ok: true }));
  app.get('/api/agent/reporter/:token/install.sh', async () => 'installer');
  app.get('/api/fail', async (_req, reply) => reply.code(503).send({ error: 'unavailable' }));
  app.get('/api/throw', async () => { throw new Error('unexpected server error'); });
  app.get('/api/instances/:id/tasks', async (_req, reply) => reply.code(403).send({ error: 'forbidden' }));
  return { app, output: () => output, records: () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

describe('backend log presentation', () => {
  it('emits one compact result per request with structured status, timing and correlation ID', async () => {
    const { app, records } = fixture();
    await app.inject('/api/instances');
    expect(records()).toHaveLength(1);
    expect(records()[0]).toMatchObject({ scope: 'HTTP', method: 'GET', url: '/api/instances', statusCode: 200, level: 30 });
    expect(records()[0].responseTime).toBeGreaterThanOrEqual(0);
    expect(records()[0].reqId).toBeTruthy();
  });

  it('keeps successful polling quiet while preserving warnings and server errors', async () => {
    const { app, records } = fixture();
    await app.inject('/api/health');
    await app.inject({ method: 'POST', url: '/api/agent/nodes/report' });
    await app.inject('/api/instances/1/state');
    await app.inject('/api/instances/1/metrics');
    expect(records()).toHaveLength(0);
    await app.inject('/api/instances/1/tasks');
    await app.inject('/api/fail');
    expect(records().map(log => [log.level, log.statusCode])).toEqual([[40, 403], [50, 503]]);
  });

  it('exposes polling in debug mode and keeps errors when access logging is disabled', async () => {
    const debug = fixture({ level: 'debug' });
    await debug.app.inject('/api/health');
    expect(debug.records()[0]).toMatchObject({ level: 20, statusCode: 200 });
    const quiet = fixture({ requests: false });
    await quiet.app.inject('/api/instances');
    await quiet.app.inject('/api/fail');
    expect(quiet.records()).toHaveLength(1);
    expect(quiet.records()[0].statusCode).toBe(503);
  });

  it('retains Fastify internal error diagnostics alongside the request result', async () => {
    const { app, records, output } = fixture({ requests: false });
    await app.inject('/api/throw?token=private-query-token');
    expect(records()).toHaveLength(2);
    expect(records()[0]).toMatchObject({ level: 50, err: { message: 'unexpected server error' } });
    expect(records()[0].err.stack).toContain('unexpected server error');
    expect(records()[1]).toMatchObject({ scope: 'HTTP', statusCode: 500 });
    expect(output()).not.toContain('private-query-token');
  });

  it('removes query credentials and path tokens before JSON serialization', async () => {
    const { app, output, records } = fixture();
    await app.inject({ url: '/api/agent/reporter/private-path-token/install.sh?token=private-query-token', headers: { authorization: 'Bearer private-header-token', cookie: 'session=private-cookie' } });
    expect(output()).not.toMatch(/private-(?:path|query|header)-token|private-cookie/);
    expect(records()[0].url).toBe('/api/agent/reporter/[REDACTED]/install.sh');
    for (const kind of ['nodes', 'reporter', 'caddy']) {
      expect(logPath(`/api/agent/${kind}/secret/install.sh?key=secret`)).toBe(`/api/agent/${kind}/[REDACTED]/install.sh`);
    }
    app.log.info({ req: { method: 'GET', url: '/api/instances?token=serializer-secret', ip: '127.0.0.1' } }, 'serializer');
    expect(output()).not.toContain('serializer-secret');
  });

  it('writes formatted logs through the real Fastify stream without JSON metadata clutter', async () => {
    const { app, output } = fixture({ format: 'pretty' });
    await app.inject('/api/instances');
    expect(output()).toMatch(/INFO\s+: HTTP\s+GET\s+200\s+[\d.]+ ms\s+\/api\/instances/);
    expect(output()).not.toMatch(/"(?:level|hostname|pid|reqId)":/);
  });

  it('aligns severity labels and retains error stacks and request IDs', () => {
    const render = pretty.prettyFactory(prettyOptions(false));
    const info = render({ level: 30, time: 0, scope: 'HTTP', method: 'GET', url: '/api/instances', statusCode: 200, responseTime: 2.3 });
    const error = render({ level: 50, time: 0, scope: 'HTTP', reqId: 'req-7', msg: 'Request failed', err: { type: 'Error', message: 'database offline', stack: 'Error: database offline\n    at operation (app.ts:10:2)' } });
    expect(info.indexOf('HTTP')).toBe(error.indexOf('HTTP'));
    expect(error).toContain('#req-7');
    expect(error).toContain('database offline');
    expect(error).toContain('at operation');
    expect(error).not.toContain('\u001b[');
    const colored = pretty.prettyFactory(prettyOptions(true))({ level: 40, time: 0, msg: 'Warning' });
    expect(colored).toContain('\u001b[');
  });

  it('renders a startup overview and preserves its fields in JSON mode', () => {
    const details = { environment: 'test', address: null, worker: true, concurrency: 4, sqlite: true, memoryRedis: true, certificate: false, duration: 42.1 };
    const json = fixture();
    logStartup(json.app.log, details);
    expect(json.records()[0]).toMatchObject({ scope: 'SYSTEM', startup: { '运行模式': 'test', '启动耗时': '42 ms' } });
    const render = pretty.prettyFactory(prettyOptions(false));
    const text = render(json.records()[0]);
    expect(text).toContain('┌─ 服务概况');
    expect(text).toContain('API 已关闭（仅运行后台任务）');
    expect(text).toContain('已启用 · 并发 4');
    expect(text).toContain('SQLite / 内存缓存与队列（单进程）');
    expect(text).not.toContain('"startup":');
  });

  it('prevents terminal control characters and forged log lines in request paths', () => {
    const { app, records } = fixture();
    app.log.info({ req: { method: 'GET', url: '/api/instances\nFORGED\u001b[2J?token=secret', ip: '127.0.0.1' } }, 'safe');
    expect(records()[0].req.url).not.toMatch(/[\n\u001b]/);
    const render = pretty.prettyFactory(prettyOptions(false));
    const text = render({ level: 30, scope: 'HTTP', method: 'GET', statusCode: 200, url: '/api/instances\nFORGED\u001b[2J', responseTime: 1 });
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).not.toContain('\u001b');
  });
});

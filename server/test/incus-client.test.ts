import { X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import forge from 'node-forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeTrustToken, HttpIncusClient } from '../src/incus/client.ts';
import { IncusError } from '../src/incus/types.ts';
import { WebSocketServer } from 'ws';

/** 生成自签名证书（测试用） */
function selfSigned(cn: string) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 86400_000);
  cert.setSubject([{ name: 'commonName', value: cn }]);
  cert.setIssuer([{ name: 'commonName', value: cn }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(cert);
  return {
    cert: pem,
    key: forge.pki.privateKeyToPem(keys.privateKey),
    fingerprint: new X509Certificate(pem).fingerprint256.replace(/:/g, '').toLowerCase(),
  };
}

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  clientCertCN?: string;
}

describe('HttpIncusClient', () => {
  const server = selfSigned('incus-server');
  const client = selfSigned('paledove-panel');
  const seen: Seen[] = [];
  let instance = { name: 'c1', config: { 'limits.cpu': '1' } as Record<string, string>, devices: {} as Record<string, Record<string, string>> };
  let etag = '"v1"';
  let httpd: Server;
  let endpoint = '';
  let sockets: WebSocketServer;
  const controlMessages: object[] = [];
  const upgrades: string[] = [];

  const sync = (metadata: unknown, extra: Record<string, string> = {}) => ({
    status: 200,
    headers: extra,
    body: { type: 'sync', status: 'Success', status_code: 200, metadata },
  });
  const asyncOp = (id: string) => ({
    status: 202,
    headers: {},
    body: { type: 'async', status: 'Operation created', status_code: 100, operation: `/1.0/operations/${id}`, metadata: {} },
  });

  beforeAll(async () => {
    httpd = createServer({ cert: server.cert, key: server.key, requestCert: true, rejectUnauthorized: false }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const peer = (req.socket as import('node:tls').TLSSocket).getPeerCertificate();
        seen.push({ method: req.method!, url: req.url!, headers: req.headers, body, clientCertCN: String(peer?.subject?.CN ?? "") });
        const url = new URL(req.url!, 'https://x');
        const route = `${req.method} ${url.pathname}`;
        let r: { status: number; headers: Record<string, string>; body: unknown };
        if (route === 'GET /1.0') r = sync({ auth: 'trusted', api_extensions: ['instances_rebuild'], environment: { server_version: '6.0' } });
        else if (route === 'GET /1.0/instances/c1') r = sync(instance, { etag });
        else if (route === 'GET /1.0/instances/missing')
          r = { status: 404, headers: {}, body: { type: 'error', error: 'Instance not found', error_code: 404 } };
        else if (route === 'PUT /1.0/instances/c1') {
          if (req.headers['if-match'] !== etag) r = { status: 412, headers: {}, body: { type: 'error', error: 'ETag mismatch', error_code: 412 } };
          else {
            instance = { ...instance, ...JSON.parse(body) };
            etag = '"v2"';
            r = asyncOp('put1');
          }
        } else if (route === 'PUT /1.0/instances/c1/state') r = asyncOp(JSON.parse(body).action === 'stop' ? 'failop' : 'okop');
        else if (route === 'GET /1.0/operations/okop/wait' || route === 'GET /1.0/operations/put1/wait')
          r = sync({ id: 'okop', status: 'Success', status_code: 200, err: '', metadata: {} });
        else if (route === 'GET /1.0/operations/failop/wait')
          r = sync({ id: 'failop', status: 'Failure', status_code: 400, err: 'The instance is already stopped', metadata: {} });
        else if (route === 'POST /1.0/instances/c1/console') r = {
          status: 202, headers: {}, body: { type: 'async', operation: '/1.0/operations/consoleop', metadata: { metadata: { fds: { '0': 'data-secret', control: 'control-secret' } } } },
        };
        else if (route === 'POST /1.0/instances/c1/exec') r = asyncOp('execop');
        else if (route === 'GET /1.0/operations/execop/wait')
          r = sync({
            id: 'execop',
            status: 'Success',
            status_code: 200,
            err: '',
            metadata: { return: 0, output: { '1': '/1.0/instances/c1/logs/exec-output/out.stdout', '2': '/1.0/instances/c1/logs/exec-output/out.stderr' } },
          });
        else if (route === 'GET /1.0/instances/c1/logs/exec-output/out.stdout') {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end('hello\n');
        } else if (route === 'GET /1.0/instances/c1/logs/exec-output/out.stderr' || req.method === 'DELETE') {
          res.writeHead(200);
          return res.end('');
        } else if (route === 'POST /1.0/instances/c1/files') r = sync({});
        else r = { status: 404, headers: {}, body: { type: 'error', error: `no route ${route}`, error_code: 404 } };
        res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
        res.end(JSON.stringify(r.body));
      });
    });
    sockets = new WebSocketServer({ noServer: true });
    httpd.on('upgrade', (req, socket, head) => {
      upgrades.push(req.url!);
      sockets.handleUpgrade(req, socket, head, (ws) => {
        if (req.url!.includes('control-secret')) ws.on('message', (value) => controlMessages.push(JSON.parse(value.toString())));
        else {
          // 立即发送，覆盖握手响应与首帧同时到达的场景。
          ws.send(Buffer.from('RFB 003.008\n'));
          ws.on('message', (value) => ws.send(value, { binary: true }));
        }
      });
    });
    await new Promise<void>((resolve) => httpd.listen(0, '127.0.0.1', resolve));
    endpoint = `https://127.0.0.1:${(httpd.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    for (const ws of sockets.clients) ws.terminate();
    sockets.close();
    return new Promise<void>((resolve) => httpd.close(() => resolve()));
  });

  const make = (fingerprint: string | null = server.fingerprint) =>
    new HttpIncusClient({ endpoint, project: 'shop', cert: client.cert, key: client.key, fingerprint });

  it('authenticates with the client certificate and pins the server fingerprint', async () => {
    const c = make();
    const info = await c.getServer();
    expect(info.auth).toBe('trusted');
    expect(seen.at(-1)?.clientCertCN).toBe('paledove-panel');
    // 服务器级接口不携带 project 参数
    expect(seen.at(-1)?.url).toBe('/1.0');
    await c.close();
  });

  it('rejects a server whose certificate fingerprint does not match', async () => {
    const c = make('00'.repeat(32));
    await expect(c.getServer()).rejects.toThrow(/指纹不匹配/);
    await c.close();
  });

  it('adds the project parameter and maps 404 errors', async () => {
    const c = make();
    await c.getInstance('c1');
    expect(seen.at(-1)?.url).toBe('/1.0/instances/c1?project=shop');
    expect(await c.instanceExists('missing')).toBe(false);
    await expect(c.getInstance('missing')).rejects.toBeInstanceOf(IncusError);
    await c.close();
  });

  it('waits for async operations and surfaces failures', async () => {
    const c = make();
    await c.setState('c1', 'start');
    expect(seen.some((s) => s.url.startsWith('/1.0/operations/okop/wait?timeout=') && s.url.includes('project=shop'))).toBe(true);
    await expect(c.setState('c1', 'stop')).rejects.toThrow('The instance is already stopped');
    await c.close();
  });

  it('modifies instances with ETag protection', async () => {
    const c = make();
    await c.modifyInstance('c1', (i) => {
      i.devices['pm1-tcp'] = { type: 'proxy', listen: 'tcp:0.0.0.0:20000', connect: 'tcp:10.0.0.2:22', nat: 'true' };
    });
    const put = seen.filter((s) => s.method === 'PUT' && s.url.startsWith('/1.0/instances/c1?')).at(-1)!;
    expect(put.headers['if-match']).toBe('"v1"');
    expect(JSON.parse(put.body).devices['pm1-tcp'].nat).toBe('true');
    expect(instance.devices['pm1-tcp']).toBeDefined();
    await c.close();
  });

  it('collects exec output and pushes files with Incus headers', async () => {
    const c = make();
    const r = await c.exec('c1', ['echo', 'hello'], { env: { A: '1' } });
    expect(r).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' });
    const execReq = JSON.parse(seen.find((s) => s.url.startsWith('/1.0/instances/c1/exec'))!.body);
    expect(execReq).toMatchObject({ command: ['echo', 'hello'], environment: { A: '1' }, 'record-output': true, 'wait-for-websocket': false });
    await c.pushFile('c1', '/etc/caddy/Caddyfile', 'x {}', { mode: '0600' });
    const push = seen.find((s) => s.url.startsWith('/1.0/instances/c1/files'))!;
    expect(push.url).toBe('/1.0/instances/c1/files?path=%2Fetc%2Fcaddy%2FCaddyfile&project=shop');
    expect(push.headers['x-incus-mode']).toBe('0600');
    expect(push.headers['x-incus-write']).toBe('overwrite');
    expect(push.body).toBe('x {}');
    await c.close();
  });

  it('decodes trust tokens', () => {
    const token = Buffer.from(
      JSON.stringify({ client_name: 'paledove', fingerprint: 'AB:CD', addresses: ['203.0.113.5:8443'], secret: 's', expires_at: '2030-01-01T00:00:00Z' }),
    ).toString('base64');
    expect(decodeTrustToken(token)).toEqual({
      clientName: 'paledove',
      fingerprint: 'abcd',
      addresses: ['203.0.113.5:8443'],
      expiresAt: '2030-01-01T00:00:00Z',
    });
    expect(() => decodeTrustToken('not-base64-json')).toThrow();
  });

  it('opens an agent-independent graphical console and preserves raw RFB bytes', async () => {
    const c = make();
    const output: Buffer[] = [];
    const session = await c.openConsole('c1', 'vga', { cols: 120, rows: 32, onData: (value) => output.push(value), onExit: () => undefined });
    session.write(Buffer.from([0, 1, 2, 255]));
    for (let i = 0; i < 30 && output.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(output[0].toString()).toBe('RFB 003.008\n');
    expect([...output[1]]).toEqual([0, 1, 2, 255]);
    const request = seen.filter((r) => r.url.startsWith('/1.0/instances/c1/console')).at(-1)!;
    expect(request.url).toContain('project=shop');
    expect(JSON.parse(request.body)).toEqual({ type: 'vga', width: 120, height: 32 });
    expect(upgrades.slice(-2)).toEqual(['/1.0/operations/consoleop/websocket?secret=control-secret', '/1.0/operations/consoleop/websocket?secret=data-secret']);
    session.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(controlMessages).not.toEqual(expect.arrayContaining([expect.objectContaining({ command: 'signal' })]));
    await c.close();
  });
});

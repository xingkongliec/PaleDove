import { isIP } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { Agent, buildConnector, type Dispatcher } from 'undici';
import WebSocket from 'ws';
import {
  IncusError,
  type ExecResult,
  type IncusApi,
  type IncusImageSource,
  type IncusInstance,
  type IncusInstanceCreate,
  type IncusInstanceFull,
  type IncusInstanceState,
  type IncusNetwork,
  type IncusNetworkCreate,
  type IncusNetworkState,
  type IncusVolumeCreate,
  type IncusOperation,
  type IncusResources,
  type IncusServer,
  type IncusStoragePool,
  type IncusStoragePoolCreate,
  type IncusStoragePoolResources,
  type TerminalOptions,
  type TerminalSession,
} from './types.ts';
import { t } from '../i18n/index.ts';

export interface HttpIncusOptions {
  /** https://host:8443 或 unix:///var/lib/incus/unix.socket */
  endpoint: string;
  project: string;
  /** 面板客户端证书（PEM） */
  cert: string;
  key: string;
  /** 服务端证书 SHA-256 指纹，设置后进行证书固定；为空时不校验服务端证书 */
  fingerprint?: string | null;
  /** 单次 HTTP 请求超时（毫秒） */
  requestTimeout?: number;
}

interface IncusResponse<T = unknown> {
  type: 'sync' | 'async' | 'error';
  status: string;
  status_code: number;
  operation?: string;
  error_code?: number;
  error?: string;
  metadata: T;
}

export function normalizeFingerprint(fp: string | null | undefined): string | null {
  if (!fp) return null;
  return fp.replace(/[^0-9a-fA-F]/g, '').toLowerCase() || null;
}

/** 由连接地址与 API 端口生成 Incus 端点；mock:// 与 unix:// 地址原样使用 */
export function buildEndpoint(address: string, port: number): string {
  if (/^(mock|unix):\/\//.test(address)) return address;
  return `https://${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
}

/** 从端点中取出连接地址（IPv6 去掉方括号） */
export function endpointAddress(endpoint: string): string {
  if (!endpoint.startsWith('https://')) return endpoint;
  try {
    return new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return '';
  }
}

function createDispatcher(opts: HttpIncusOptions): { origin: string; dispatcher: Dispatcher } {
  if (opts.endpoint.startsWith('unix://')) {
    const socketPath = opts.endpoint.slice('unix://'.length);
    return { origin: 'http://incus.local', dispatcher: new Agent({ connect: { socketPath } }) };
  }
  const url = new URL(opts.endpoint);
  if (url.protocol !== 'https:') throw new Error(t('incus.httpsOnly'));
  const pinned = normalizeFingerprint(opts.fingerprint);
  const base = buildConnector({
    cert: opts.cert,
    key: opts.key,
    // 自签名证书无法通过 CA 校验，改为在握手完成后比对证书指纹
    rejectUnauthorized: false,
    maxCachedSessions: 0,
    timeout: 10_000,
  });
  const connector: buildConnector.connector = (options, callback) => {
    base(options, (err, socket) => {
      if (err || !socket) return callback(err ?? new Error(t('incus.connectFailed')), null);
      if (pinned) {
        const peer = (socket as TLSSocket).getPeerCertificate?.();
        const actual = normalizeFingerprint(peer?.fingerprint256);
        if (actual !== pinned) {
          socket.destroy();
          return callback(new Error(t('incus.fingerprintMismatch', { expected: pinned.slice(0, 16), actual: actual?.slice(0, 16) ?? '-' })), null);
        }
      }
      callback(null, socket);
    });
  };
  return { origin: url.origin, dispatcher: new Agent({ connect: connector, keepAliveTimeout: 30_000 }) };
}

export class HttpIncusClient implements IncusApi {
  readonly endpoint: string;
  private readonly origin: string;
  private readonly dispatcher: Dispatcher;
  private readonly project: string;
  private readonly requestTimeout: number;
  /** 网页终端直接建立 TLS 连接时使用 */
  private readonly tls: Pick<HttpIncusOptions, 'cert' | 'key' | 'fingerprint'>;

  constructor(opts: HttpIncusOptions) {
    this.endpoint = opts.endpoint;
    this.project = opts.project || 'default';
    this.requestTimeout = opts.requestTimeout ?? 60_000;
    this.tls = { cert: opts.cert, key: opts.key, fingerprint: opts.fingerprint };
    const { origin, dispatcher } = createDispatcher(opts);
    this.origin = origin;
    this.dispatcher = dispatcher;
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }

  private withProject(path: string): string {
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}project=${encodeURIComponent(this.project)}`;
  }

  private async raw(
    method: Dispatcher.HttpMethod,
    path: string,
    init: { body?: string | Buffer; headers?: Record<string, string>; timeout?: number } = {},
  ): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
    const res = await this.dispatcher.request({
      origin: this.origin,
      path,
      method,
      headers: init.headers,
      body: init.body,
      headersTimeout: init.timeout ?? this.requestTimeout,
      bodyTimeout: init.timeout ?? this.requestTimeout,
    });
    const body = Buffer.from(await res.body.arrayBuffer());
    return { statusCode: res.statusCode, headers: res.headers, body };
  }

  /** 发送请求；异步操作会等待其完成并返回操作对象 */
  private async call<T>(
    method: Dispatcher.HttpMethod,
    path: string,
    body?: unknown,
    opts: { headers?: Record<string, string>; waitTimeoutSec?: number; project?: boolean } = {},
  ): Promise<{ data: T; etag?: string }> {
    const fullPath = opts.project === false ? path : this.withProject(path);
    const res = await this.raw(method, fullPath, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...opts.headers },
    });
    let json: IncusResponse<T>;
    try {
      json = JSON.parse(res.body.toString('utf8')) as IncusResponse<T>;
    } catch {
      throw new IncusError(t('incus.badResponse', { status: res.statusCode }), res.statusCode);
    }
    if (json.type === 'error') {
      throw new IncusError(json.error || t('incus.requestFailed', { status: res.statusCode }), json.error_code || res.statusCode);
    }
    if (json.type === 'async' && json.operation) {
      const op = await this.waitOperation(json.operation, opts.waitTimeoutSec ?? 900);
      return { data: op as T };
    }
    const etag = res.headers.etag;
    return { data: json.metadata, etag: typeof etag === 'string' ? etag : undefined };
  }

  private async waitOperation(operation: string, timeoutSec: number): Promise<IncusOperation> {
    const deadline = Date.now() + timeoutSec * 1000;
    for (;;) {
      const remaining = Math.max(1, Math.min(60, Math.ceil((deadline - Date.now()) / 1000)));
      const res = await this.raw('GET', this.withProject(`${operation}/wait?timeout=${remaining}`), {
        timeout: (remaining + 15) * 1000,
      });
      const json = JSON.parse(res.body.toString('utf8')) as IncusResponse<IncusOperation>;
      if (json.type === 'error') throw new IncusError(json.error || t('incus.operationFailed', { status: res.statusCode }), json.error_code || res.statusCode);
      const op = json.metadata;
      if (op.status_code >= 400 || op.status === 'Failure' || op.status === 'Cancelled') {
        throw new IncusError(op.err || t('incus.operationFailed', { status: op.status }), op.status_code);
      }
      if (op.status_code === 200 || op.status === 'Success') return op;
      if (Date.now() > deadline) throw new IncusError(t('incus.operationTimeout', { description: op.description }), 504);
    }
  }

  // ───────── 服务器 ─────────

  async getServer(): Promise<IncusServer> {
    return (await this.call<IncusServer>('GET', '/1.0', undefined, { project: false })).data;
  }

  async getResources(): Promise<IncusResources> {
    return (await this.call<IncusResources>('GET', '/1.0/resources', undefined, { project: false })).data;
  }

  async getStoragePool(pool: string): Promise<IncusStoragePool> {
    return (await this.call<IncusStoragePool>('GET', `/1.0/storage-pools/${encodeURIComponent(pool)}`)).data;
  }

  async getStoragePoolResources(pool: string): Promise<IncusStoragePoolResources> {
    return (await this.call<IncusStoragePoolResources>('GET', `/1.0/storage-pools/${encodeURIComponent(pool)}/resources`))
      .data;
  }

  async listStoragePools(): Promise<IncusStoragePool[]> {
    return (await this.call<IncusStoragePool[]>('GET', '/1.0/storage-pools?recursion=1')).data ?? [];
  }

  async createStoragePool(req: IncusStoragePoolCreate): Promise<void> {
    await this.call('POST', '/1.0/storage-pools', req, { waitTimeoutSec: 600 });
  }

  async deleteStoragePool(name: string): Promise<void> {
    await this.call('DELETE', `/1.0/storage-pools/${encodeURIComponent(name)}`);
  }

  async createVolume(pool: string, req: IncusVolumeCreate): Promise<void> {
    await this.call('POST', `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, req, { waitTimeoutSec: 300 });
  }

  async deleteVolume(pool: string, name: string): Promise<void> {
    await this.call('DELETE', `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`, undefined, { waitTimeoutSec: 300 });
  }

  async getNetworkState(name: string): Promise<IncusNetworkState> {
    return (await this.call<IncusNetworkState>('GET', `/1.0/networks/${encodeURIComponent(name)}/state`, undefined, { project: false })).data;
  }

  async getNetwork(name: string): Promise<IncusNetwork> {
    return (await this.call<IncusNetwork>('GET', `/1.0/networks/${encodeURIComponent(name)}`)).data;
  }

  async createNetwork(req: IncusNetworkCreate): Promise<void> {
    await this.call('POST', '/1.0/networks', req);
  }

  async deleteNetwork(name: string): Promise<void> {
    await this.call('DELETE', `/1.0/networks/${encodeURIComponent(name)}`);
  }

  // ───────── 实例 ─────────

  async listInstances(): Promise<IncusInstanceFull[]> {
    return (await this.call<IncusInstanceFull[]>('GET', '/1.0/instances?recursion=2')).data ?? [];
  }

  async getInstance(name: string): Promise<IncusInstance> {
    return (await this.call<IncusInstance>('GET', `/1.0/instances/${encodeURIComponent(name)}`)).data;
  }

  async getInstanceState(name: string): Promise<IncusInstanceState> {
    return (await this.call<IncusInstanceState>('GET', `/1.0/instances/${encodeURIComponent(name)}/state`)).data;
  }

  async instanceExists(name: string): Promise<boolean> {
    try {
      await this.getInstance(name);
      return true;
    } catch (err) {
      if (err instanceof IncusError && err.isNotFound) return false;
      throw err;
    }
  }

  async createInstance(req: IncusInstanceCreate): Promise<void> {
    // 迁移时要等目标宿主机拉取完整个磁盘，给更长的超时
    await this.call('POST', '/1.0/instances', req, { waitTimeoutSec: req.source.type === 'migration' ? 6 * 3600 : 1800 });
  }

  async startMigration(name: string): Promise<{ operation: string; secrets: Record<string, string> }> {
    // 这里不能等待操作完成：迁移操作要等目标宿主机连上来拉取数据才会结束
    const res = await this.raw('POST', this.withProject(`/1.0/instances/${encodeURIComponent(name)}`), {
      body: JSON.stringify({ name, migration: true, live: false, instance_only: false }),
      headers: { 'content-type': 'application/json' },
    });
    const json = JSON.parse(res.body.toString('utf8')) as IncusResponse<IncusOperation>;
    if (json.type === 'error' || !json.operation) {
      throw new IncusError(json.error || t('incus.requestFailed', { status: res.statusCode }), json.error_code || res.statusCode);
    }
    const secrets = (json.metadata?.metadata ?? {}) as Record<string, string>;
    return { operation: json.operation, secrets };
  }

  async modifyInstance(name: string, mutate: (inst: IncusInstance) => void): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const { data, etag } = await this.call<IncusInstance>('GET', `/1.0/instances/${encodeURIComponent(name)}`);
      mutate(data);
      const body = {
        architecture: data.architecture,
        config: data.config,
        devices: data.devices,
        ephemeral: data.ephemeral,
        profiles: data.profiles,
        stateful: data.stateful,
        description: data.description,
      };
      try {
        await this.call('PUT', `/1.0/instances/${encodeURIComponent(name)}`, body, {
          headers: etag ? { 'If-Match': etag } : undefined,
        });
        return;
      } catch (err) {
        // ETag 不匹配说明实例被并发修改，重新读取后重试
        if (err instanceof IncusError && err.statusCode === 412 && attempt < 3) continue;
        throw err;
      }
    }
  }

  async setState(
    name: string,
    action: 'start' | 'stop' | 'restart',
    opts: { force?: boolean; timeout?: number } = {},
  ): Promise<void> {
    await this.call(
      'PUT',
      `/1.0/instances/${encodeURIComponent(name)}/state`,
      { action, force: opts.force ?? false, timeout: opts.timeout ?? 60, stateful: false },
      { waitTimeoutSec: (opts.timeout ?? 60) + 120 },
    );
  }

  async deleteInstance(name: string): Promise<void> {
    await this.call('DELETE', `/1.0/instances/${encodeURIComponent(name)}`);
  }

  async renameInstance(name: string, newName: string): Promise<void> {
    await this.call('POST', `/1.0/instances/${encodeURIComponent(name)}`, { name: newName });
  }

  async rebuildInstance(name: string, source: IncusImageSource): Promise<void> {
    await this.call('POST', `/1.0/instances/${encodeURIComponent(name)}/rebuild`, { source }, { waitTimeoutSec: 1800 });
  }

  // ───────── 快照 ─────────

  async listSnapshots(name: string): Promise<string[]> {
    const urls = (await this.call<string[]>('GET', `/1.0/instances/${encodeURIComponent(name)}/snapshots`)).data ?? [];
    return urls.map((u) => decodeURIComponent(u.split('/').pop()!.split('?')[0]));
  }

  async createSnapshot(name: string, snapshot: string): Promise<void> {
    await this.call(
      'POST',
      `/1.0/instances/${encodeURIComponent(name)}/snapshots`,
      { name: snapshot, stateful: false },
      { waitTimeoutSec: 1800 },
    );
  }

  async deleteSnapshot(name: string, snapshot: string): Promise<void> {
    await this.call(
      'DELETE',
      `/1.0/instances/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapshot)}`,
      undefined,
      { waitTimeoutSec: 600 },
    );
  }

  async restoreSnapshot(name: string, snapshot: string): Promise<void> {
    await this.call('PUT', `/1.0/instances/${encodeURIComponent(name)}`, { restore: snapshot }, { waitTimeoutSec: 1800 });
  }

  // ───────── 执行命令 / 文件 ─────────

  async exec(
    name: string,
    command: string[],
    opts: { env?: Record<string, string>; timeoutSec?: number } = {},
  ): Promise<ExecResult> {
    const op = (
      await this.call<IncusOperation>(
        'POST',
        `/1.0/instances/${encodeURIComponent(name)}/exec`,
        {
          command,
          environment: opts.env ?? {},
          'wait-for-websocket': false,
          interactive: false,
          'record-output': true,
        },
        { waitTimeoutSec: opts.timeoutSec ?? 300 },
      )
    ).data;
    const meta = (op.metadata ?? {}) as { return?: number; output?: Record<string, string> };
    const readLog = async (path?: string) => {
      if (!path) return '';
      try {
        const res = await this.raw('GET', this.withProject(path));
        // 读取后删除日志文件，避免在宿主机上堆积
        void this.raw('DELETE', this.withProject(path)).catch(() => undefined);
        return res.body.toString('utf8');
      } catch {
        return '';
      }
    };
    const [stdout, stderr] = await Promise.all([readLog(meta.output?.['1']), readLog(meta.output?.['2'])]);
    return { exitCode: meta.return ?? -1, stdout, stderr };
  }

  async pushFile(
    name: string,
    path: string,
    content: string | Buffer,
    opts: { mode?: string; uid?: number; gid?: number } = {},
  ): Promise<void> {
    const res = await this.raw(
      'POST',
      this.withProject(`/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`),
      {
        body: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
        headers: {
          'content-type': 'application/octet-stream',
          'x-incus-type': 'file',
          'x-incus-write': 'overwrite',
          'x-incus-mode': opts.mode ?? '0644',
          'x-incus-uid': String(opts.uid ?? 0),
          'x-incus-gid': String(opts.gid ?? 0),
        },
      },
    );
    if (res.statusCode >= 400) {
      let msg = t('incus.writeFileFailed', { status: res.statusCode });
      try {
        msg = (JSON.parse(res.body.toString('utf8')) as IncusResponse).error || msg;
      } catch {
        /* ignore */
      }
      throw new IncusError(msg, res.statusCode);
    }
  }

  async joinWithToken(token: string): Promise<void> {
    await this.call('POST', '/1.0/certificates', { type: 'client', trust_token: token.trim() }, { project: false });
  }

  // ───────── 网页终端 ─────────

  /** 连接操作的 WebSocket 通道；HTTPS 端点先完成 TLS 握手并校验证书指纹，再发送带密钥的升级请求 */
  private async connectOperationSocket(operation: string, secret: string): Promise<WebSocket> {
    const path = `${operation}/websocket?secret=${encodeURIComponent(secret)}`;
    let ws: WebSocket;
    if (this.endpoint.startsWith('unix://')) {
      ws = new WebSocket(`ws+unix://${this.endpoint.slice('unix://'.length)}:${path}`);
    } else {
      const url = new URL(this.endpoint);
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const port = Number(url.port) || 8443;
      const socket = await new Promise<TLSSocket>((resolve, reject) => {
        const s = tlsConnect({ host, port, cert: this.tls.cert, key: this.tls.key, rejectUnauthorized: false, servername: isIP(host) ? undefined : host, timeout: 10_000 });
        s.once('secureConnect', () => {
          const pinned = normalizeFingerprint(this.tls.fingerprint);
          const actual = normalizeFingerprint(s.getPeerCertificate()?.fingerprint256);
          if (pinned && actual !== pinned) {
            s.destroy();
            return reject(new Error(t('incus.fingerprintMismatch', { expected: pinned.slice(0, 16), actual: actual?.slice(0, 16) ?? '-' })));
          }
          s.setTimeout(0);
          resolve(s);
        });
        s.once('timeout', () => s.destroy(new Error(t('incus.connectFailed'))));
        s.once('error', reject);
      });
      ws = new WebSocket(`wss://${url.host}${path}`, { createConnection: () => socket });
    }
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new IncusError(t('incus.requestFailed', { status: res.statusCode ?? 0 }), res.statusCode ?? 502)));
    });
    return ws;
  }

  async openTerminal(name: string, opts: TerminalOptions): Promise<TerminalSession> {
    const res = await this.raw('POST', this.withProject(`/1.0/instances/${encodeURIComponent(name)}/exec`), {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        // 优先使用 bash 登录 shell，没有时退回 sh
        command: ['/bin/sh', '-c', 'cd /root 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'],
        environment: { TERM: 'xterm-256color', HOME: '/root', USER: 'root', LANG: 'C.UTF-8' },
        'wait-for-websocket': true,
        interactive: true,
        width: opts.cols,
        height: opts.rows,
      }),
    });
    let json: IncusResponse<{ metadata?: { fds?: Record<string, string> } }>;
    try {
      json = JSON.parse(res.body.toString('utf8')) as typeof json;
    } catch {
      throw new IncusError(t('incus.badResponse', { status: res.statusCode }), res.statusCode);
    }
    const fds = json.metadata?.metadata?.fds;
    if (json.type === 'error' || !json.operation || !fds?.['0'] || !fds.control) {
      throw new IncusError(json.error || t('incus.requestFailed', { status: res.statusCode }), json.error_code || res.statusCode);
    }
    // 交互模式下 0 号通道同时承载输入与输出，control 通道用于调整窗口大小和发送信号
    const control = await this.connectOperationSocket(json.operation, fds.control);
    let data: WebSocket;
    try {
      data = await this.connectOperationSocket(json.operation, fds['0']);
    } catch (e) {
      control.close();
      throw e;
    }
    let ended = false;
    const end = (reason?: string) => {
      if (ended) return;
      ended = true;
      control.close();
      data.close();
      opts.onExit(reason);
    };
    data.on('message', (msg: Buffer, isBinary: boolean) => {
      if (isBinary || msg.length) opts.onData(Buffer.from(msg));
    });
    data.on('close', () => end());
    data.on('error', (e) => end(e.message));
    control.on('error', () => undefined);
    const sendControl = (body: object) => control.readyState === WebSocket.OPEN && control.send(JSON.stringify(body));
    return {
      write: (input) => data.readyState === WebSocket.OPEN && data.send(typeof input === 'string' ? Buffer.from(input, 'utf8') : input),
      resize: (cols, rows) => sendControl({ command: 'window-resize', args: { width: String(cols), height: String(rows) } }),
      close: () => {
        // 先发送 SIGHUP 让 shell 退出，再断开通道
        sendControl({ command: 'signal', signal: 1 });
        end();
      },
    };
  }
}

/** 解析 `incus config trust add` 生成的信任令牌 */
export function decodeTrustToken(token: string): {
  clientName: string;
  fingerprint: string;
  addresses: string[];
  expiresAt?: string;
} {
  let parsed: { client_name?: string; fingerprint?: string; addresses?: string[]; expires_at?: string };
  try {
    parsed = JSON.parse(Buffer.from(token.trim(), 'base64').toString('utf8'));
  } catch {
    throw new Error(t('incus.badToken'));
  }
  if (!parsed.fingerprint || !Array.isArray(parsed.addresses)) throw new Error(t('incus.tokenMissingFields'));
  return {
    clientName: parsed.client_name ?? '',
    fingerprint: normalizeFingerprint(parsed.fingerprint)!,
    addresses: parsed.addresses,
    expiresAt: parsed.expires_at,
  };
}

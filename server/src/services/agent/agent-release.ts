import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { AgentArch, AgentManifest } from './agent-binary.ts';

export const MAX_AGENT_BYTES = 64 * 1024 * 1024;
export const RELEASE_TTL = 5 * 60_000;
const FALLBACK_TTL = 24 * 60 * 60_000;
const FAILURE_TTL = 60_000;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
export const agentReleaseVersion = z.string().max(80).regex(versionPattern);
const checksum = z.string().regex(/^[a-f0-9]{64}$/);
const assetSchema = z.object({
  id: z.number().int().positive(), name: z.string(), size: z.number().int().positive().max(MAX_AGENT_BYTES),
  digest: z.string().nullable().optional(),
});
const releaseSchema = z.object({
  tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(), assets: z.array(z.object({ name: z.string() }).passthrough()),
});
const fileSchema = z.object({ name: z.string(), sha256: checksum, size: z.number().int().positive().max(MAX_AGENT_BYTES), assetId: z.number().int().positive() });
const snapshotSchema = z.object({
  repository: z.string(), version: agentReleaseVersion, checkedAt: z.number().finite(),
  files: z.object({ amd64: fileSchema, arm64: fileSchema }),
});
type Snapshot = z.infer<typeof snapshotSchema>;
type Asset = z.infer<typeof assetSchema>;

interface ReleaseOptions {
  repository: string;
  token?: string;
  cacheDirectory?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** GitHub 只由面板访问；宿主机始终从面板同源接口获取已校验的发布文件。 */
export class AgentReleaseSource {
  private readonly directory: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private current: Snapshot | null = null;
  private initialized = false;
  private nextCheckAt = 0;
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly metadataPending = new Map<string, Promise<Snapshot | null>>();
  private readonly binaryPending = new Map<string, Promise<Buffer>>();
  private readonly binaries = new Map<string, Buffer>();
  private memoryBytes = 0;

  constructor(private readonly options: ReleaseOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository)) throw new Error('Invalid Agent release repository');
    const namespace = createHash('sha256').update(options.repository).digest('hex').slice(0, 16);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 'default';
    this.directory = resolve(options.cacheDirectory || resolve(tmpdir(), `paledove-agent-release-${uid}`), namespace);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  private publicManifest(snapshot: Snapshot): AgentManifest {
    return {
      version: snapshot.version,
      files: Object.fromEntries(Object.entries(snapshot.files).map(([arch, file]) => [arch, {
        name: file.name, sha256: file.sha256, size: file.size,
      }])),
    };
  }

  private readSnapshot(name: string): Snapshot | null {
    try {
      const path = resolve(this.directory, name);
      if (!existsSync(path) || statSync(path).size > 64 * 1024) return null;
      const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success || parsed.data.repository !== this.options.repository) return null;
      const age = this.now() - parsed.data.checkedAt;
      if (age < 0 || age > FALLBACK_TTL) return null;
      for (const arch of ['amd64', 'arm64'] as const) {
        if (parsed.data.files[arch].name !== `paledove-agent-linux-${arch}`) return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  private initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.current = this.readSnapshot('manifest.json');
    if (this.current) {
      this.remember(this.current);
      // 保留原检查时间，磁盘兜底不会把旧版本再锁定 24 小时。
      this.nextCheckAt = this.current.checkedAt + RELEASE_TTL;
    }
  }

  private usable(snapshot: Snapshot | null): snapshot is Snapshot {
    return !!snapshot && this.now() - snapshot.checkedAt <= FALLBACK_TTL;
  }

  /** 心跳绝不等待 GitHub；首次使用或过期时在后台合并刷新。 */
  cachedManifest(): AgentManifest | null {
    this.initialize();
    if (this.now() >= this.nextCheckAt) void this.latest();
    return this.usable(this.current) ? this.publicManifest(this.current) : null;
  }

  async manifest(): Promise<AgentManifest | null> {
    const snapshot = await this.latest();
    return snapshot ? this.publicManifest(snapshot) : null;
  }

  private remember(snapshot: Snapshot) {
    this.snapshots.delete(snapshot.version);
    this.snapshots.set(snapshot.version, snapshot);
    while (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  private async writeCache(name: string, data: string | Buffer) {
    const path = resolve(this.directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
    } catch {
      // 容器只读或磁盘满时仍可使用内存缓存完成安装和心跳。
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async request(path: string, binary = false): Promise<Buffer> {
    const response = await this.fetch(`https://api.github.com/repos/${this.options.repository}/${path}`, {
      headers: {
        accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'user-agent': 'paledove-panel',
        'x-github-api-version': '2022-11-28',
        ...(this.options.token ? { authorization: `Bearer ${this.options.token}` } : {}),
      },
      signal: AbortSignal.timeout(binary ? 120_000 : 15_000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`Agent release request failed (${response.status})`);
    }
    const limit = binary ? MAX_AGENT_BYTES : 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel();
      throw new Error('Agent release response exceeds size limit');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Agent release response exceeds size limit');
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return Buffer.concat(chunks, size);
  }

  private async snapshotFromRelease(raw: unknown): Promise<Snapshot> {
    const release = releaseSchema.parse(raw);
    if (release.draft || release.prerelease || !release.tag_name.startsWith('agent-v')) throw new Error('Not a stable Agent release');
    const version = agentReleaseVersion.parse(release.tag_name.slice('agent-v'.length));
    const files = {} as Snapshot['files'];
    for (const arch of ['amd64', 'arm64'] as const) {
      const name = `paledove-agent-linux-${arch}`;
      const releaseName = `paledove-agent-${arch === 'amd64' ? 'x86_64' : 'aarch64'}-v${version}`;
      const rawAsset = release.assets.find((asset) => asset.name === releaseName) ?? release.assets.find((asset) => asset.name === name);
      if (!rawAsset) throw new Error(`Agent release is missing ${arch}`);
      const asset = assetSchema.parse(rawAsset);
      let sha256 = /^sha256:([a-fA-F0-9]{64})$/.exec(asset.digest ?? '')?.[1].toLowerCase();
      if (!sha256) {
        // 旧 Release 没有 GitHub digest 时仅下载一次，计算校验值后复用相同字节。
        const data = await this.downloadAsset(asset);
        sha256 = createHash('sha256').update(data).digest('hex');
        this.rememberBinary(sha256, data);
        await this.writeCache(`${sha256}.bin`, data);
      }
      files[arch] = { name, sha256, size: asset.size, assetId: asset.id };
    }
    return { repository: this.options.repository, version, checkedAt: this.now(), files };
  }

  private async latest(): Promise<Snapshot | null> {
    this.initialize();
    if (this.now() < this.nextCheckAt) return this.usable(this.current) ? this.current : null;
    const pending = this.metadataPending.get('latest');
    if (pending) return pending;
    const task = (async () => {
      try {
        const raw: unknown = JSON.parse((await this.request('releases?per_page=100')).toString('utf8'));
        if (!Array.isArray(raw)) throw new Error('Invalid Agent release list');
        const release = raw.find((item) => {
          const parsed = releaseSchema.safeParse(item);
          return parsed.success && !parsed.data.draft && !parsed.data.prerelease &&
            parsed.data.tag_name.startsWith('agent-v') && agentReleaseVersion.safeParse(parsed.data.tag_name.slice(7)).success;
        });
        if (!release) throw new Error('No stable Agent release');
        const snapshot = await this.snapshotFromRelease(release);
        this.current = snapshot;
        this.remember(snapshot);
        this.nextCheckAt = this.now() + RELEASE_TTL;
        await Promise.all([this.writeCache('manifest.json', JSON.stringify(snapshot)), this.writeCache(`release-${snapshot.version}.json`, JSON.stringify(snapshot))]);
      } catch {
        this.nextCheckAt = this.now() + FAILURE_TTL;
        console.warn('[AgentRelease] Release refresh failed; using the last verified cache when available');
      }
      return this.usable(this.current) ? this.current : null;
    })().finally(() => this.metadataPending.delete('latest'));
    this.metadataPending.set('latest', task);
    return task;
  }

  private async versionSnapshot(version?: string): Promise<Snapshot | null> {
    if (!version) return this.latest();
    agentReleaseVersion.parse(version);
    this.initialize();
    const cached = this.snapshots.get(version) ?? this.readSnapshot(`release-${version}.json`);
    if (this.usable(cached)) return cached;
    const pending = this.metadataPending.get(version);
    if (pending) return pending;
    const task = (async () => {
      const raw: unknown = JSON.parse((await this.request(`releases/tags/agent-v${encodeURIComponent(version)}`)).toString('utf8'));
      const snapshot = await this.snapshotFromRelease(raw);
      if (snapshot.version !== version) throw new Error('Agent release version mismatch');
      this.remember(snapshot);
      await this.writeCache(`release-${version}.json`, JSON.stringify(snapshot));
      return snapshot;
    })().finally(() => this.metadataPending.delete(version));
    this.metadataPending.set(version, task);
    return task;
  }

  private rememberBinary(key: string, data: Buffer) {
    if (this.binaries.has(key)) return;
    while (this.memoryBytes + data.length > 2 * MAX_AGENT_BYTES) {
      const oldest = this.binaries.keys().next().value!;
      this.memoryBytes -= this.binaries.get(oldest)!.length;
      this.binaries.delete(oldest);
    }
    this.binaries.set(key, data);
    this.memoryBytes += data.length;
  }

  private async downloadAsset(asset: Pick<Asset, 'id' | 'size'>): Promise<Buffer> {
    const data = await this.request(`releases/assets/${asset.id}`, true);
    if (data.length !== asset.size) throw new Error('Agent release binary size mismatch');
    return data;
  }

  async binary(arch: AgentArch, version?: string, expectedSha256?: string): Promise<Buffer | null> {
    const snapshot = await this.versionSnapshot(version);
    if (!snapshot) return null;
    const file = snapshot.files[arch];
    if (expectedSha256 && file.sha256 !== expectedSha256) throw new Error('Agent manifest checksum changed');
    const cached = this.binaries.get(file.sha256);
    if (cached) {
      if (cached.length !== file.size) throw new Error('Agent release binary size mismatch');
      return cached;
    }
    const pending = this.binaryPending.get(file.sha256);
    if (pending) {
      const data = await pending;
      if (data.length !== file.size) throw new Error('Agent release binary size mismatch');
      return data;
    }
    const task = (async () => {
      let data: Buffer | null = null;
      try {
        const path = resolve(this.directory, `${file.sha256}.bin`);
        if (statSync(path).size === file.size) {
          const disk = await readFile(path);
          if (createHash('sha256').update(disk).digest('hex') === file.sha256) data = disk;
        }
      } catch { /* 缓存缺失或损坏时重新获取发布文件。 */ }
      if (!data) {
        data = await this.downloadAsset({ id: file.assetId, size: file.size });
        if (createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('Agent release binary checksum mismatch');
        await this.writeCache(`${file.sha256}.bin`, data);
      }
      this.rememberBinary(file.sha256, data);
      return data;
    })().finally(() => this.binaryPending.delete(file.sha256));
    this.binaryPending.set(file.sha256, task);
    return task;
  }
}

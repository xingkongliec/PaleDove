import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 进程内的 Redis 替代实现（REDIS_URL=memory://），仅实现本项目用到的命令，语义与 Redis 一致：
 * 字符串 / 集合 / 哈希 / 列表、过期时间、NX 写入与 MULTI。仅适用于单进程的本地开发。
 *
 * 指定 file 时定期把数据写入磁盘并在启动时恢复，开发服务器热重启后会话与模拟节点状态不会丢失；
 * 锁（lock:*）只在本进程内有意义，不做持久化。
 */
interface Containers {
  string: string;
  set: Set<string>;
  hash: Map<string, string>;
  list: string[];
}
type Kind = keyof Containers;
type Value = { [K in Kind]: { type: K; value: Containers[K] } }[Kind];

interface Entry {
  data: Value;
  /** 过期时间（毫秒时间戳），null 表示不过期 */
  expiresAt: number | null;
}

type Scalar = string | number | Buffer;
type MultiResult = [Error | null, unknown][];

const SAVE_DELAY_MS = 1000;
const NOT_PERSISTED = /^lock:/;

class WrongTypeError extends Error {
  constructor() {
    super('WRONGTYPE Operation against a key holding the wrong kind of value');
  }
}

export class MemoryRedis {
  private readonly entries = new Map<string, Entry>();
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(private readonly file?: string) {
    if (file) this.load(file);
    this.sweepTimer = setInterval(() => this.sweep(), 60_000);
    this.sweepTimer.unref();
  }

  // ───────────── 通用 ─────────────

  async exists(...keys: string[]): Promise<number> {
    return keys.filter((k) => this.entry(k)).length;
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const k of keys) if (this.entry(k) && this.entries.delete(k)) n++;
    if (n) this.changed();
    return n;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const e = this.entry(key);
    if (!e) return 0;
    e.expiresAt = Date.now() + seconds * 1000;
    this.changed();
    return 1;
  }

  // ───────────── 字符串 ─────────────

  async get(key: string): Promise<string | null> {
    const e = this.entry(key);
    if (!e) return null;
    if (e.data.type !== 'string') throw new WrongTypeError();
    return e.data.value;
  }

  /** 支持 EX / PX / NX 参数 */
  async set(key: string, value: Scalar, ...args: Scalar[]): Promise<'OK' | null> {
    let expiresAt: number | null = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      const opt = String(args[i]).toUpperCase();
      if (opt === 'EX') expiresAt = Date.now() + Number(args[++i]) * 1000;
      else if (opt === 'PX') expiresAt = Date.now() + Number(args[++i]);
      else if (opt === 'NX') nx = true;
      else throw new Error(`memory redis: unsupported SET option ${opt}`);
    }
    if (nx && this.entry(key)) return null;
    this.entries.set(key, { data: { type: 'string', value: String(value) }, expiresAt });
    this.changed();
    return 'OK';
  }

  /** 整数加一（键不存在时从 0 开始），保留原过期时间 */
  async incr(key: string): Promise<number> {
    const e = this.entry(key);
    if (e && e.data.type !== 'string') throw new WrongTypeError();
    const current = e ? Number(e.data.value) : 0;
    if (!Number.isInteger(current)) throw new Error('ERR value is not an integer or out of range');
    const next = current + 1;
    this.entries.set(key, { data: { type: 'string', value: String(next) }, expiresAt: e?.expiresAt ?? null });
    this.changed();
    return next;
  }

  /** 值等于 expected 时删除（替代 Redis 中释放锁的 Lua 脚本） */
  async compareAndDelete(key: string, expected: string): Promise<number> {
    if ((await this.get(key)) !== expected) return 0;
    return this.del(key);
  }

  // ───────────── 集合 ─────────────

  async sadd(key: string, ...members: Scalar[]): Promise<number> {
    const set = this.container(key, 'set', () => new Set<string>());
    let n = 0;
    for (const m of members.map(String)) {
      if (!set.has(m)) {
        set.add(m);
        n++;
      }
    }
    this.changed();
    return n;
  }

  async srem(key: string, ...members: Scalar[]): Promise<number> {
    const set = this.existing(key, 'set');
    if (!set) return 0;
    let n = 0;
    for (const m of members.map(String)) if (set.delete(m)) n++;
    this.dropIfEmpty(key, set.size);
    if (n) this.changed();
    return n;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.existing(key, 'set') ?? [])];
  }

  // ───────────── 哈希 ─────────────

  async hset(key: string, field: string, value: Scalar): Promise<number> {
    const hash = this.container(key, 'hash', () => new Map<string, string>());
    const isNew = !hash.has(field);
    hash.set(field, String(value));
    this.changed();
    return isNew ? 1 : 0;
  }

  async hexists(key: string, field: string): Promise<number> {
    return this.existing(key, 'hash')?.has(field) ? 1 : 0;
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = this.existing(key, 'hash');
    if (!hash) return 0;
    let n = 0;
    for (const f of fields) if (hash.delete(f)) n++;
    this.dropIfEmpty(key, hash.size);
    if (n) this.changed();
    return n;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.existing(key, 'hash') ?? []);
  }

  // ───────────── 列表 ─────────────

  async rpush(key: string, ...values: Scalar[]): Promise<number> {
    const list = this.container(key, 'list', () => [] as string[]);
    list.push(...values.map(String));
    this.changed();
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.existing(key, 'list');
    if (!list?.length) return null;
    const value = list.shift()!;
    this.dropIfEmpty(key, list.length);
    this.changed();
    return value;
  }

  async llen(key: string): Promise<number> {
    return this.existing(key, 'list')?.length ?? 0;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.existing(key, 'list') ?? [];
    const [from, to] = range(list.length, start, stop);
    return list.slice(from, to + 1);
  }

  async ltrim(key: string, start: number, stop: number): Promise<'OK'> {
    const list = this.existing(key, 'list');
    if (list) {
      const [from, to] = range(list.length, start, stop);
      const kept = list.slice(from, to + 1);
      list.splice(0, list.length, ...kept);
      this.dropIfEmpty(key, list.length);
      this.changed();
    }
    return 'OK';
  }

  // ───────────── 事务 / 连接 ─────────────

  /** 依次执行排队的命令；单线程下天然具有原子性 */
  multi() {
    const queued: (() => Promise<unknown>)[] = [];
    const chain = {
      set: (...a: Parameters<MemoryRedis['set']>) => (queued.push(() => this.set(...a)), chain),
      sadd: (...a: Parameters<MemoryRedis['sadd']>) => (queued.push(() => this.sadd(...a)), chain),
      rpush: (...a: Parameters<MemoryRedis['rpush']>) => (queued.push(() => this.rpush(...a)), chain),
      ltrim: (...a: Parameters<MemoryRedis['ltrim']>) => (queued.push(() => this.ltrim(...a)), chain),
      del: (...a: Parameters<MemoryRedis['del']>) => (queued.push(() => this.del(...a)), chain),
      expire: (...a: Parameters<MemoryRedis['expire']>) => (queued.push(() => this.expire(...a)), chain),
      exec: async (): Promise<MultiResult> => {
        const results: MultiResult = [];
        for (const run of queued) {
          try {
            results.push([null, await run()]);
          } catch (err) {
            results.push([err as Error, null]);
          }
        }
        return results;
      },
    };
    return chain;
  }

  disconnect(): void {
    clearInterval(this.sweepTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  async quit(): Promise<'OK'> {
    this.disconnect();
    return 'OK';
  }

  // ───────────── 内部 ─────────────

  /** 读取未过期的键（惰性删除过期键） */
  private entry(key: string): Entry | undefined {
    const e = this.entries.get(key);
    if (e && e.expiresAt !== null && e.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return e;
  }

  private existing<K extends Kind>(key: string, type: K): Containers[K] | undefined {
    const e = this.entry(key);
    if (!e) return undefined;
    if (e.data.type !== type) throw new WrongTypeError();
    return e.data.value as Containers[K];
  }

  private container<K extends Kind>(key: string, type: K, create: () => Containers[K]): Containers[K] {
    const found = this.existing(key, type);
    if (found) return found;
    const value = create();
    this.entries.set(key, { data: { type, value } as Value, expiresAt: null });
    return value;
  }

  /** Redis 不保留空的集合 / 哈希 / 列表 */
  private dropIfEmpty(key: string, size: number) {
    if (size === 0) this.entries.delete(key);
  }

  private sweep() {
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.expiresAt !== null && e.expiresAt <= now) this.entries.delete(k);
  }

  private changed() {
    if (!this.file) return;
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
    this.saveTimer.unref();
  }

  private save() {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    this.sweep();
    const out: Record<string, { type: Value['type']; value: unknown; expiresAt: number | null }> = {};
    for (const [k, { data, expiresAt }] of this.entries) {
      if (NOT_PERSISTED.test(k)) continue;
      const value = data.type === 'set' ? [...data.value] : data.type === 'hash' ? Object.fromEntries(data.value) : data.value;
      out[k] = { type: data.type, value, expiresAt };
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(out));
    renameSync(tmp, this.file);
  }

  private load(file: string) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return;
    }
    let parsed: Record<string, { type: Value['type']; value: never; expiresAt: number | null }>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 文件损坏时从空数据开始
    }
    const now = Date.now();
    for (const [k, { type, value, expiresAt }] of Object.entries(parsed)) {
      if (expiresAt !== null && expiresAt <= now) continue;
      const data: Value =
        type === 'set'
          ? { type, value: new Set<string>(value) }
          : type === 'hash'
            ? { type, value: new Map<string, string>(Object.entries(value)) }
            : type === 'list'
              ? { type, value: value as string[] }
              : { type: 'string', value: value as string };
      this.entries.set(k, { data, expiresAt });
    }
  }
}

/** 把 Redis 风格的 [start, stop]（闭区间，负数从末尾计）换算为数组下标 */
function range(length: number, start: number, stop: number): [number, number] {
  const from = Math.max(0, start < 0 ? length + start : start);
  const to = Math.min(length - 1, stop < 0 ? length + stop : stop);
  return [from, to];
}

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareHostAgentReleases } from '../src/shared/index.ts';
import { AgentReleaseSource, MAX_AGENT_BYTES, RELEASE_TTL } from '../src/services/agent/agent-release.ts';

const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const data = { amd64: Buffer.from('amd64 release binary'), arm64: Buffer.from('arm64 release binary') };
const release = (version = '0.7.1', baseId = 1) => ({
  tag_name: `agent-v${version}`, draft: false, prerelease: false,
  assets: (['amd64', 'arm64'] as const).map((arch, index) => ({
    id: baseId + index, name: `paledove-agent-${arch === 'amd64' ? 'x86_64' : 'aarch64'}-v${version}`,
    size: data[arch].length, digest: `sha256:${digest(data[arch])}`,
  })),
});
const directories: string[] = [];
const temporary = () => { const directory = mkdtempSync(join(tmpdir(), 'paledove-agent-release-test-')); directories.push(directory); return directory; };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function fixture(overrides: { fetch?: typeof fetch; cacheDirectory?: string; now?: () => number } = {}) {
  let current = release();
  let offline = false;
  const request = vi.fn<typeof fetch>(async (url) => {
    if (offline) throw new Error('offline');
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/releases')) return json([current]);
    if (path.includes('/releases/tags/')) return json(release(path.split('agent-v')[1]));
    const id = Number(path.split('/').pop());
    return new Response(data[id % 2 ? 'amd64' : 'arm64']);
  });
  const cacheDirectory = overrides.cacheDirectory ?? temporary();
  const source = new AgentReleaseSource({ repository: 'test/paledove', token: 'test-private-token', cacheDirectory, fetch: overrides.fetch ?? request, now: overrides.now });
  return { source, request, cacheDirectory, setRelease: (value: ReturnType<typeof release>) => { current = value; }, setOffline: (value = true) => { offline = value; } };
}

describe('GitHub Agent release source', () => {
  it('maps both architectures without downloading binaries to build the manifest', async () => {
    const { source, request } = fixture();
    const manifest = await source.manifest();
    expect(manifest).toMatchObject({ version: '0.7.1', files: {
      amd64: { name: 'paledove-agent-linux-amd64', sha256: digest(data.amd64), size: data.amd64.length },
      arm64: { name: 'paledove-agent-linux-arm64', sha256: digest(data.arm64), size: data.arm64.length },
    } });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(manifest)).not.toContain('test-private-token');
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer test-private-token' });
  });

  it('ignores unrelated, draft and prerelease releases and oversized unrelated assets', async () => {
    const good = release();
    const unrelated = { name: 'panel.zip', id: 99, size: MAX_AGENT_BYTES + 1 };
    const request = vi.fn<typeof fetch>(async () => json([
      { ...release('9.0.0'), tag_name: 'panel-v9.0.0' },
      { ...release('8.0.0'), draft: true },
      { ...release('7.0.0'), prerelease: true },
      { ...good, assets: [...good.assets, unrelated] },
    ]));
    expect((await fixture({ fetch: request }).source.manifest())?.version).toBe('0.7.1');
  });

  it('coalesces concurrent metadata and binary requests and keeps downloads on GitHub API URLs', async () => {
    const { source, request } = fixture();
    await Promise.all(Array.from({ length: 10 }, () => source.manifest()));
    const binaries = await Promise.all(Array.from({ length: 10 }, () => source.binary('amd64', '0.7.1', digest(data.amd64))));
    expect(binaries.every((binary) => binary?.equals(data.amd64))).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(String(request.mock.calls[1][0])).toBe('https://api.github.com/repos/test/paledove/releases/assets/1');
  });

  it('hashes legacy assets only once when GitHub does not provide a digest', async () => {
    const legacy = release();
    legacy.assets.forEach((asset) => { asset.digest = ''; });
    const { source, request, setRelease } = fixture();
    setRelease(legacy);
    expect((await source.manifest())?.files.amd64?.sha256).toBe(digest(data.amd64));
    expect(await source.binary('amd64')).toEqual(data.amd64);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not accept an incomplete release or retry failures on every heartbeat', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, request, setRelease } = fixture();
    const incomplete = release();
    incomplete.assets.pop();
    setRelease(incomplete);
    expect(await source.manifest()).toBeNull();
    expect(source.cachedManifest()).toBeNull();
    expect(await source.manifest()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not block heartbeats while fetching release metadata', async () => {
    let resolveResponse!: (response: Response) => void;
    const request = vi.fn<typeof fetch>(() => new Promise<Response>((done) => { resolveResponse = done; }));
    const { source } = fixture({ fetch: request });
    expect(source.cachedManifest()).toBeNull();
    expect(source.cachedManifest()).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    resolveResponse(json([release()]));
    expect((await source.manifest())?.version).toBe('0.7.1');
  });

  it('refreshes after five minutes and serves the pinned previous version during a new release', async () => {
    let clock = 10_000;
    const { source, setRelease } = fixture({ now: () => clock });
    await source.manifest();
    clock += RELEASE_TTL + 1;
    setRelease(release('0.8.0', 3));
    expect((await source.manifest())?.version).toBe('0.8.0');
    expect(await source.binary('amd64', '0.7.1', digest(data.amd64))).toEqual(data.amd64);
    await expect(source.binary('amd64', '0.7.1', 'f'.repeat(64))).rejects.toThrow('checksum changed');
  });

  it('bypasses a fresh metadata cache immediately and coalesces manual checks', async () => {
    const { source, request, setRelease } = fixture();
    await source.manifest();
    setRelease(release('0.8.0', 3));
    expect((await source.manifest())?.version).toBe('0.7.1');
    const results = await Promise.all(Array.from({ length: 5 }, () => source.refreshManifest()));
    expect(results.every(result => result.version === '0.8.0')).toBe(true);
    expect(source.cachedManifest()?.version).toBe('0.8.0');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reports a manual refresh failure instead of passing off the previous cache as a successful check', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, request, setRelease, setOffline } = fixture();
    await source.manifest();
    setOffline();
    await expect(source.refreshManifest()).rejects.toThrow('offline');
    expect((await source.manifest())?.version).toBe('0.7.1');
    expect(request).toHaveBeenCalledTimes(2);
    setOffline(false);
    setRelease(release('0.8.0', 3));
    expect((await source.refreshManifest()).version).toBe('0.8.0');
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('joins a failed background refresh but preserves strict errors for the manual caller', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clock = 10_000;
    let rejectResponse!: (reason: Error) => void;
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json([release()]))
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => { rejectResponse = reject; }));
    const { source } = fixture({ fetch: request, now: () => clock });
    await source.manifest();
    clock += RELEASE_TTL + 1;
    expect(source.cachedManifest()?.version).toBe('0.7.1');
    const manual = expect(source.refreshManifest()).rejects.toThrow('offline');
    rejectResponse(new Error('offline'));
    await manual;
    expect(request).toHaveBeenCalledTimes(2);
    expect(source.cachedManifest()?.version).toBe('0.7.1');
  });

  it('loads a pinned version by its exact release tag after a panel restart', async () => {
    const { source, request } = fixture();
    expect(await source.binary('amd64', '0.6.0')).toEqual(data.amd64);
    expect(String(request.mock.calls[0][0])).toContain('/releases/tags/agent-v0.6.0');
    await expect(source.binary('amd64', '../../evil')).rejects.toThrow();
  });

  it('uses verified disk cache while offline but does not let it mask new releases for a full day', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let clock = 10_000;
    const first = fixture({ now: () => clock });
    await first.source.manifest();
    await first.source.binary('amd64');
    clock += RELEASE_TTL + 1;
    const second = fixture({ cacheDirectory: first.cacheDirectory, now: () => clock });
    second.setOffline();
    expect((await second.source.manifest())?.version).toBe('0.7.1');
    expect(second.request).toHaveBeenCalledTimes(1);
    expect(await second.source.binary('amd64', '0.7.1')).toEqual(data.amd64);
    clock += 24 * 60 * 60_000;
    expect(await second.source.manifest()).toBeNull();
  });

  it('rejects checksum and size mismatches without caching the invalid binary', async () => {
    const { source, setRelease } = fixture();
    const corrupt = release();
    corrupt.assets[0].digest = `sha256:${'0'.repeat(64)}`;
    setRelease(corrupt);
    await source.manifest();
    await expect(source.binary('amd64')).rejects.toThrow('checksum mismatch');
    const badSize = fixture();
    const sized = release();
    sized.assets[0].size++;
    badSize.setRelease(sized);
    await badSize.source.manifest();
    await expect(badSize.source.binary('amd64')).rejects.toThrow('size mismatch');
  });

  it('discards a corrupt disk binary and fetches a clean copy', async () => {
    const first = fixture();
    await first.source.manifest();
    await first.source.binary('amd64');
    const namespace = readdirSync(first.cacheDirectory)[0];
    const path = join(first.cacheDirectory, namespace, `${digest(data.amd64)}.bin`);
    writeFileSync(path, Buffer.alloc(data.amd64.length));
    const second = fixture({ cacheDirectory: first.cacheDirectory });
    expect(await second.source.binary('amd64', '0.7.1')).toEqual(data.amd64);
    expect(second.request).toHaveBeenCalledTimes(1);
    expect(readFileSync(path)).toEqual(data.amd64);
  });

  it('checks the current metadata size even when identical bytes are already cached', async () => {
    let clock = 10_000;
    const { source, setRelease } = fixture({ now: () => clock });
    await source.manifest();
    await source.binary('amd64');
    clock += RELEASE_TTL + 1;
    const next = release('0.8.0');
    next.assets[0].size++;
    setRelease(next);
    await source.manifest();
    await expect(source.binary('amd64')).rejects.toThrow('size mismatch');
  });

  it('still downloads when the optional disk cache cannot be written', async () => {
    const directory = temporary();
    const file = join(directory, 'read-only-image');
    writeFileSync(file, 'not a directory');
    const { source } = fixture({ cacheDirectory: file });
    expect((await source.manifest())?.version).toBe('0.7.1');
    expect(await source.binary('arm64')).toEqual(data.arm64);
  });

  it('rejects oversized metadata assets and HTTP response bodies', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const huge = fixture();
    const oversized = release();
    oversized.assets[0].size = MAX_AGENT_BYTES + 1;
    huge.setRelease(oversized);
    expect(await huge.source.manifest()).toBeNull();
    const request = vi.fn<typeof fetch>(async (url) => String(url).includes('/assets/')
      ? new Response('x', { headers: { 'content-length': String(MAX_AGENT_BYTES + 1) } }) : json([release()]));
    const { source } = fixture({ fetch: request });
    await source.manifest();
    await expect(source.binary('amd64')).rejects.toThrow('size limit');
  });
});

describe('Agent release version ordering', () => {
  it.each([
    ['0.10.0', '0.9.0', 1], ['0.7.1', '0.8.0', -1], ['v0.7.1', '0.7.1', 0],
    ['0.7.1', '0.7.1-rc.2', 1], ['0.7.1-rc.10', '0.7.1-rc.2', 1], ['dev', '0.7.1', null],
  ])('compares %s and %s without offering downgrades', (a, b, expected) => {
    expect(compareHostAgentReleases(a, b)).toBe(expected);
  });
});

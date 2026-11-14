// Agent 发布文件：正式环境代理本项目 GitHub Release，本地开发可使用 pnpm build:agent。
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { compareHostAgentReleases, HOST_AGENT_RELEASE } from '../../shared/index.ts';
import { config } from '../../config.ts';
import { AppError, conflict, notFound } from '../../lib/errors.ts';
import { t } from '../../i18n/index.ts';
import { AgentReleaseSource, MAX_AGENT_BYTES } from './agent-release.ts';

export const AGENT_ARCHES = ['amd64', 'arm64'] as const;
export type AgentArch = (typeof AGENT_ARCHES)[number];

/** 二进制所在目录：AGENT_DIST，默认为 agent/dist（服务的工作目录是 server） */
export function agentDist(): string {
  return config.agentBinaryDirectory;
}

export const agentBinaryName = (arch: AgentArch) => `paledove-agent-linux-${arch}`;

export function agentBinaryPath(arch: AgentArch): string {
  return resolve(agentDist(), agentBinaryName(arch));
}

export interface AgentManifest {
  /** 下载源实际提供的发布版本 */
  version: string;
  files: Partial<Record<AgentArch, { name: string; sha256: string; size: number }>>;
}

const releases = config.AGENT_RELEASE_REPOSITORY ? new AgentReleaseSource({
  repository: config.AGENT_RELEASE_REPOSITORY,
  token: config.AGENT_RELEASE_TOKEN,
  cacheDirectory: config.agentReleaseCacheDirectory,
}) : null;
let cache: { signature: string; manifest: AgentManifest } | null = null;

/** 版本清单：读取构建时生成的 SHA256SUMS 与 VERSION（按修改时间缓存）；还没有构建时 files 为空 */
export function agentManifest(): AgentManifest {
  if (releases) return releases.cachedManifest() ?? { version: HOST_AGENT_RELEASE, files: {} };
  const sumsFile = resolve(agentDist(), 'SHA256SUMS');
  if (!existsSync(sumsFile)) return { version: HOST_AGENT_RELEASE, files: {} };
  const versionFile = resolve(agentDist(), 'VERSION');
  const signature = [sumsFile, versionFile, ...AGENT_ARCHES.map(agentBinaryPath)].map((path) => {
    if (!existsSync(path)) return 'missing';
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }).join('|');
  if (cache?.signature === signature) return cache.manifest;
  const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() || HOST_AGENT_RELEASE : HOST_AGENT_RELEASE;
  const files: AgentManifest['files'] = {};
  for (const line of readFileSync(sumsFile, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?paledove-agent-linux-(\w+)$/.exec(line.trim());
    if (!m || !(AGENT_ARCHES as readonly string[]).includes(m[2]!)) continue;
    const arch = m[2] as AgentArch;
    const path = agentBinaryPath(arch);
    if (existsSync(path)) {
      const size = statSync(path).size;
      if (size > 0 && size <= MAX_AGENT_BYTES && createHash('sha256').update(readFileSync(path)).digest('hex') === m[1]) {
        files[arch] = { name: agentBinaryName(arch), sha256: m[1]!, size };
      }
    }
  }
  cache = { signature, manifest: { version, files } };
  return cache.manifest;
}

/** 安装时等待发布源；上报与状态接口使用上面的非阻塞缓存。 */
export async function loadAgentManifest(): Promise<AgentManifest> {
  if (!releases) return agentManifest();
  const manifest = await releases.manifest();
  if (!manifest) throw new AppError(503, 'AGENT_RELEASE_UNAVAILABLE', t('agent.releaseUnavailable'));
  return manifest;
}

/** 主动重新检查发布源；本地模式只检查实际可下载的构建文件。 */
export async function refreshAgentManifest(): Promise<AgentManifest> {
  if (releases) {
    try {
      return await releases.refreshManifest();
    } catch {
      throw new AppError(503, 'AGENT_RELEASE_UNAVAILABLE', t('agent.releaseUnavailable'));
    }
  }
  const manifest = agentManifest();
  if (!Object.keys(manifest.files).length) throw new AppError(503, 'AGENT_BINARY_MISSING', t('agent.binaryMissing'));
  return manifest;
}

export async function downloadAgentBinary(arch: AgentArch, version?: string, sha256?: string): Promise<Buffer> {
  if (releases) {
    try {
      const data = await releases.binary(arch, version, sha256);
      if (data) return data;
    } catch {
      throw new AppError(502, 'AGENT_DOWNLOAD_FAILED', t('agent.downloadFailed'));
    }
    throw new AppError(503, 'AGENT_RELEASE_UNAVAILABLE', t('agent.releaseUnavailable'));
  }
  const manifest = agentManifest();
  const file = manifest.files[arch];
  if (!file) throw notFound(t('agent.binaryMissing'));
  if ((version && manifest.version !== version) || (sha256 && file.sha256 !== sha256)) throw conflict(t('agent.releaseChanged'));
  const data = readFileSync(agentBinaryPath(arch));
  if (data.length !== file.size || createHash('sha256').update(data).digest('hex') !== file.sha256) throw conflict(t('agent.releaseChanged'));
  return data;
}

export interface UpgradeInstruction {
  version: string;
  url: string;
  sha256: string;
  size: number;
}

/**
 * 自动升级指令：Agent 上报的版本与清单不同、且有对应架构的二进制时下发。
 * 下载地址为面板同源地址（Agent 只接受同源），带上版本号避免中间缓存。
 */
export function upgradeInstruction(panelUrl: string, release: string | undefined, arch: string | undefined): UpgradeInstruction | null {
  if (!release || release === 'dev' || !arch || !(AGENT_ARCHES as readonly string[]).includes(arch)) return null;
  const m = agentManifest();
  const file = m.files[arch as AgentArch];
  if (!file || compareHostAgentReleases(m.version, release) !== 1) return null;
  return { version: m.version, url: `${panelUrl}/api/agent/binary/${arch}?v=${encodeURIComponent(m.version)}&sha256=${file.sha256}`, sha256: file.sha256, size: file.size };
}

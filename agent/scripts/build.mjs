// 构建宿主机 Agent（agent，Go）：交叉编译 linux/amd64 与 linux/arm64 静态二进制到 agent/dist/，
// 版本号取自 server/src/shared/products.ts 的 HOST_AGENT_RELEASE；--release 额外生成 GitHub Release 资产。
// 面板本身独立构建；pnpm build:agent 仅用于本地开发，正式下载由面板代理 GitHub Release。
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(agentDir, '..');
const dist = resolve(agentDir, 'dist');
const required = process.argv.includes('--required');
const release = process.argv.includes('--release');

const version = /HOST_AGENT_RELEASE = '([^']+)'/.exec(readFileSync(resolve(root, 'server/src/shared/products.ts'), 'utf8'))?.[1];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid HOST_AGENT_RELEASE');

if (spawnSync('go', ['version'], { stdio: 'ignore' }).status !== 0) {
  const msg = '[agent] 未找到 Go，跳过构建宿主机 Agent（安装 Go 1.22+ 后执行 pnpm build:agent）';
  if (required) {
    console.error(msg);
    process.exit(1);
  }
  console.warn(msg);
  process.exit(0);
}

mkdirSync(dist, { recursive: true });
const sums = [];
const files = {};
const releaseSums = [];
const releaseFiles = {};
const releaseDist = resolve(dist, 'release');
if (release) mkdirSync(releaseDist, { recursive: true });
for (const arch of ['amd64', 'arm64']) {
  const out = resolve(dist, `paledove-agent-linux-${arch}`);
  const staged = `${out}.tmp-${process.pid}`;
  // 入口在 cmd/paledove-agent；版本写入 internal/buildinfo.Version
  execFileSync('go', ['build', '-trimpath', '-buildvcs=false', '-ldflags', `-s -w -X github.com/paledove/agent/internal/buildinfo.Version=${version}`, '-o', staged, './cmd/paledove-agent'], {
    cwd: agentDir,
    stdio: 'inherit',
    env: { ...process.env, GOOS: 'linux', GOARCH: arch, CGO_ENABLED: '0' },
  });
  renameSync(staged, out);
  const data = readFileSync(out);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const name = `paledove-agent-${arch === 'amd64' ? 'x86_64' : 'aarch64'}-v${version}`;
  if (release) copyFileSync(out, resolve(releaseDist, name));
  sums.push(`${sha256}  paledove-agent-linux-${arch}`);
  releaseSums.push(`${sha256}  ${name}`);
  files[`linux-${arch}`] = { name: `paledove-agent-linux-${arch}`, sha256, size: data.length, gzip: false };
  releaseFiles[`linux-${arch}`] = { name, sha256, size: data.length, gzip: false };
  console.log(`[agent] built ${out}`);
}
for (const [directory, manifestFiles, checksums] of [[dist, files, sums], ...(release ? [[releaseDist, releaseFiles, releaseSums]] : [])]) {
  for (const [name, content] of Object.entries({ VERSION: `${version}\n`, 'manifest.json': `${JSON.stringify({ version, generatedAt: new Date().toISOString(), files: manifestFiles }, null, 2)}\n`, SHA256SUMS: `${checksums.join('\n')}\n` })) {
    const temporary = resolve(directory, `${name}.tmp-${process.pid}`);
    writeFileSync(temporary, content);
    renameSync(temporary, resolve(directory, name));
  }
}
console.log(`[agent] v${version} done`);

# Agent 发布与下载

Agent 通过 GitHub Release 分发，面板代理下载并缓存，宿主机只访问面板同源接口。面板服务器无需 Go，也无需保存 `agent/dist/`。为确保与面板的协议兼容，须发布本项目编译的文件。

## 部署配置

在 `server/.env` 设置：

```dotenv
AGENT_RELEASE_REPOSITORY=你的GitHub用户名/本项目仓库名
# 私有仓库或需要提高 GitHub API 配额时填写，令牌需有读取仓库 Release 的权限
AGENT_RELEASE_TOKEN=
# 可选；相对路径以 server 为基准，建议容器部署时使用可写挂载目录
# AGENT_RELEASE_CACHE_DIR=data/agent-release-cache
```

仓库需要至少有一个已发布、非草稿、非预发布的 `agent-v<版本>` Release，并同时包含 Linux amd64 和 arm64 的资产。修改下载源配置后重启后端。发布地址和私有仓库令牌只由面板使用，宿主机不会收到 GitHub 令牌。

## 发布新版本

1. 修改 `server/src/shared/products.ts` 中的 `HOST_AGENT_RELEASE`。
2. 推送到仓库默认分支，GitHub Actions 的 `Agent Build and Release` 自动运行测试并交叉编译。也可推送 `agent-v<版本>` 标签或在默认分支手动触发 workflow。
3. 构建成功后创建同名 Release，附带以下文件；已有同名 Release 时跳过，更新须使用新版本号。

```text
tag: agent-v0.8.2
assets:
  paledove-agent-x86_64-v0.8.2
  paledove-agent-aarch64-v0.8.2
  SHA256SUMS
  manifest.json
```

手工打包可在有 Go 1.22+ 的机器上运行 `pnpm build:agent:release`，然后把 `agent/dist/release/` 中的二进制、`SHA256SUMS` 和 `manifest.json` 上传到对应 Release。本地开发文件独立保留在 `agent/dist/`。`pnpm build` 只构建面板前后端。

## 下载与缓存

- `/api/agent/manifest.json` 返回下载源的版本、各架构文件名、SHA-256 与大小。优先使用 GitHub 提供的 SHA-256 digest；老资产缺少 digest 时下载一次计算，并复用已验证字节。
- `/api/agent/binary/amd64` 和 `/api/agent/binary/arm64` 由面板返回二进制，不将宿主机重定向到 GitHub。安装与升级使用 `?v=<版本>&sha256=<校验值>` 固定文件，避免更新发布时清单与文件不一致。
- 元数据缓存 5 分钟，相同请求并发时只向上游发出一次查询或下载。二进制内存缓存最多 128 MiB，单文件最大 64 MiB；超时、文件大小与 SHA-256 校验均在面板执行，宿主机再校验一次。
- 管理员可点击宿主机详情中的 Agent 版本标签，立即查询当前下载源。GitHub 模式跳过 5 分钟缓存及失败等待期；并发查询合并，失败明确报错，不把旧缓存当作最新查询成功。本地模式只检查本地可下载版本，不声称已查询 GitHub。查询成功后刷新版本标签，后续升级仍沿用现有流程。
- 磁盘缓存按仓库隔离、按校验值保存二进制，写入采用临时文件和原子改名。缓存目录不可写时仍可使用内存缓存完成下载；损坏的二进制会被重新下载。
- GitHub 暂时不可用时，允许使用检查时间在 24 小时内的已确认发布信息；失败查询短暂缓存 1 分钟。没有可用缓存时返回明确错误，并保留安装令牌供重试。
- 磁盘中旧的元数据不会延后下一次在线检查。心跳不等待 GitHub，后台合并刷新后由后续心跳下发升级；新版本必须比当前版本更新，避免误降级。
- 旧安装脚本所用的三列文本清单仍保留；新脚本请求第四列版本号，并在下载、校验成功后才兑换一次性安装令牌。

## 本地开发

未设置 `AGENT_RELEASE_REPOSITORY` 时，面板读取 `pnpm build:agent` 生成的 `agent/dist/`，也可用 `AGENT_DIST` 指定目录，相对路径以 `server` 为基准。

已配置 Release 仓库时不会因 GitHub 故障自动切换到本地包。这样可确保所有宿主机使用同一个已发布的版本。

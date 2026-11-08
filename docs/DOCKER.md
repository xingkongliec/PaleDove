# Docker 部署

Docker 镜像包含前端页面、HTTP API、后台 Worker、数据库迁移文件及 Incus / Caddy / Agent 安装模板。`docker-compose.yml` **只启动面板**，PostgreSQL 和 Redis 使用已有的外部服务，不会创建数据库或 Redis 容器。

环境要求：Docker Engine 20.10+、Docker Compose 2.30+、可从面板容器访问的 PostgreSQL 14+ 与 Redis 6+。项目根目录 `.env` 同时供 Compose 读取端口设置和向面板传入环境变量。Compose 2.30 的 `env_file.format: raw` 保留传入应用的变量值中的 `$` 等字符；值直接填写，不添加单引号或双引号。

Compose 使用本地源码构建 `paledove:local`，通过 `pull_policy: build` 指定构建行为。构建上下文需要包含根目录的 Docker 文件、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，以及完整的 `server/` 和 `web/`。共用代码已合并到 `server/src/shared/`，由 `web/src/shared/` 引用，构建不再需要根目录 `shared/`；升级时需同步更新前后端源码、依赖清单和锁文件。

## 首次部署

在项目根目录执行：

```bash
cp .env.example .env
# 编辑 .env，配置外部 DATABASE_URL / REDIS_URL、APP_SECRET、PANEL_URL 与管理员信息
# APP_SECRET 可通过 openssl rand -hex 32 生成，升级必须保留原值

# 开发者自行创建并上传 client.crt / client.key，见 server/certs/incus/README.md
mkdir -p server/certs/incus

# 构建并启动；自动迁移数据库，仅在没有管理员时初始化管理员
docker compose up -d --build panel
docker compose ps
docker compose logs --tail=100 -f panel
```

`DATABASE_URL` 示例：`postgresql://paledove:密码@数据库地址:5432/paledove`，数据库应提前创建。`REDIS_URL` 示例：`redis://:密码@Redis地址:6379/0`；使用 TLS 时写 `rediss://`。URL 密码中的 `@`、`:`、`/`、`#` 等字符须按 URL 规则编码。

数据库在 Docker 宿主机上时，可使用 `host.docker.internal`，Compose 已配置 `host-gateway`。外部服务须监听容器可访问的地址并允许容器网段连接；容器里的 `127.0.0.1` 指向面板容器自身。远程数据库直接填写远程地址。

容器启动时先执行数据库迁移，再检查数据库中是否存在任意管理员。没有管理员时，使用 `ADMIN_USERNAME`（默认 `admin`）、`ADMIN_EMAIL` 和 `ADMIN_PASSWORD` 创建账号；生产密码须为 12 至 128 个字符，不能使用示例占位符或默认密码。已有管理员时直接跳过初始化，不比较环境变量中的用户名、邮箱或密码，也不修改账号、登录状态或安全设置。API 与 Worker 分开部署时，首次管理员初始化使用 PostgreSQL 事务锁避免重复创建。

`init` 仍可手动执行数据库迁移、管理员初始化和常用镜像预置，`seed` 可在迁移完成后初始化这些基础数据。已有管理员始终保持原样；普通启动仅补齐缺少的管理员，不创建演示节点或演示用户。

## 管理员初始化

首次初始化成功后，日志显示 `已创建管理员`；以后启动显示 `数据库中已有管理员，跳过初始化`。修改 `.env` 中的 `ADMIN_PASSWORD` 不会改变已有管理员的密码，用户名或邮箱与环境变量不同也会跳过。

Compose 使用 `env_file.format: raw`，环境文件中密码首尾添加的引号也会成为密码的一部分，应直接填写值；`$`、`#` 等字符按原值传入。`run --rm` 每次从环境文件读取最新值，使用 `exec` 则沿用运行中容器的旧环境。

如果登录后又回到登录页，检查访问协议。通过普通 HTTP（如 `http://服务器IP:3000`）访问时，需设置 `COOKIE_SECURE=false`、`TRUST_PROXY=false`、`PANEL_URL=http://实际地址`，再执行 `docker compose up -d panel` 重新创建容器；HTTPS 反向代理部署保持 `COOKIE_SECURE=true` 和 `TRUST_PROXY=true`。

## 对外访问

默认只把 `127.0.0.1:3000` 映射到面板容器的 3000 端口。在宿主机用 Caddy / Nginx 提供 HTTPS，并代理至 `127.0.0.1:3000`：

```caddyfile
panel.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

`.env` 中设置 `PANEL_URL=https://panel.example.com`、`TRUST_PROXY=true`、`COOKIE_SECURE=true`。宿主机安装回连、支付回调和邮件链接均使用 `PANEL_URL`。

需要修改宿主机监听地址或端口时，给 Compose 提供 `PANEL_BIND`、`PANEL_PORT`，例如：

```bash
PANEL_BIND=0.0.0.0 PANEL_PORT=8080 docker compose up -d panel
```

这两个变量可直接填写在根目录 `.env`，执行命令时传入的环境变量优先。直接通过 HTTP 临时验证时须将 `COOKIE_SECURE=false`、`TRUST_PROXY=false`，并把 `PANEL_URL` 改为实际可达的 HTTP 地址；正式使用配置 HTTPS。

## 数据、证书与 Agent

| 内容 | 容器路径 | 保存方式 |
| --- | --- | --- |
| 工单附件、站点图标、Agent Release 缓存 | `/app/server/data` | `panel-data` 命名卷，重新创建容器后保留 |
| Incus 客户端证书 | `/app/server/certs/incus` | 项目 `server/certs/incus` 只读挂载 |
| 环境变量与密钥 | 不复制进镜像 | 项目根目录 `.env`，通过 Compose 注入 |
| 数据库与 Redis 数据 | 外部服务 | 在对应服务独立备份 |

镜像使用 UID/GID `1000:1000` 的 `node` 账号运行。Linux 宿主机上的证书目录和文件须允许该账号读取，例如由部署人员将证书的所属组改为 `1000`，目录权限设为 `750`、证书和私钥设为 `640`。保持目录只读挂载，替换证书后后续连接会自动重新读取。缺少证书时可进入后台，真实节点连接会提示配置错误；镜像不会自动创建证书。

Agent 默认通过 `AGENT_RELEASE_REPOSITORY=owner/repo` 从本项目的 GitHub Release 代理下载，镜像不要求 Go。未配置 Release 仓库时，可在其他机器执行 `pnpm build:agent`，将输出目录只读挂载到 `/app/agent/dist`；文件须包含 `SHA256SUMS`、`VERSION` 及两种架构二进制，具体见 [Agent 发布与下载](AGENT_RELEASE.md)。

升级与迁移须同时保留外部数据库、Redis、`.env`、证书目录和 `panel-data`。`APP_SECRET` 不可更换。`docker compose down` 保留命名卷，`docker compose down -v` 会删除附件等持久数据。

## 迁移与升级

默认每次启动先执行 `prisma migrate deploy`，迁移失败时不启动面板。已执行过的迁移不会重复应用，不使用开发环境的 `db push`。多进程部署时，可统一迁移一次，然后把各应用进程的 `DB_MIGRATE=false`。

```bash
git pull
docker compose build --pull panel
# 先停止旧版本，再迁移，避免旧进程在迁移期间继续处理任务
docker compose stop panel
docker compose run --rm panel migrate
docker compose up -d panel
docker compose logs --tail=100 panel
```

单独执行命令：

```bash
docker compose run --rm panel migrate  # 仅应用迁移
docker compose run --rm panel seed     # 初始化缺少的管理员与常用镜像，已有管理员直接跳过
docker compose exec panel node scripts/docker/healthcheck.mjs
```

默认同一容器运行 API 和 Worker，后台 Worker 建议保持一个。额外 API 容器设置 `RUN_WORKER=false`；独立 Worker 设置 `RUN_API=false`、`RUN_WORKER=true`。所有进程连接同一外部 PostgreSQL / Redis，共享附件存储并读取同一对证书，且仅由一个进程执行迁移。镜像健康检查在 API 模式访问 `/api/health`，Worker 模式不请求 HTTP。

## 不使用 Compose

也可使用同一镜像直接运行，镜像中的 `WEB_DIST`、附件和证书路径已设置：

```bash
docker build -t paledove:local .
docker volume create paledove-data
docker run --rm --init --env-file .env \
  --add-host host.docker.internal:host-gateway \
  --mount type=volume,src=paledove-data,dst=/app/server/data \
  --mount type=bind,src="$(pwd)/server/certs/incus",dst=/app/server/certs/incus,readonly \
  paledove:local init
docker run -d --name paledove --init --restart unless-stopped --stop-timeout 60 \
  --env-file .env -p 127.0.0.1:3000:3000 \
  --add-host host.docker.internal:host-gateway \
  --mount type=volume,src=paledove-data,dst=/app/server/data \
  --mount type=bind,src="$(pwd)/server/certs/incus",dst=/app/server/certs/incus,readonly \
  paledove:local
```

## 本地开发

本地开发读取 `server/.env`，复制 `server/.env.example` 即可使用 SQLite 和内存缓存；Docker 读取的根目录 `.env` 不会覆盖本地配置。执行 `pnpm db:migrate`、`pnpm db:seed` 后，可用 `pnpm dev` 启动前端 :5180 和后端 :3000，或用 `pnpm start` 自动准备缺失的构建并直接访问后端页面。正式部署使用外部 PostgreSQL / Redis，根目录 `.env.example` 提供生产配置。

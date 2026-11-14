<p align="center">
  <img src="web/public/logo.png" width="88" alt="PaleDove Logo" />
</p>

<h1 align="center">PaleDove</h1>

<p align="center"><strong>基于 Incus 的 IDC 云服务器售卖与管理面板</strong></p>

<p align="center">实例交付 · 账单与支付 · 宿主机运维 · 用户服务</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%E2%89%A522.12-339933?logo=nodedotjs&logoColor=white" alt="Node.js >= 22.12" /></a>
  <a href="https://pnpm.io/"><img src="https://img.shields.io/badge/pnpm-10-F69220?logo=pnpm&logoColor=white" alt="pnpm 10" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" alt="React 19" /></a>
  <a href="https://linuxcontainers.org/incus/"><img src="https://img.shields.io/badge/Incus-REST_API-73BA25" alt="Incus REST API" /></a>
</p>

<p align="center">
  <a href="#界面预览">界面预览</a> ·
  <a href="#功能特性">功能特性</a> ·
  <a href="#本地开发">本地开发</a> ·
  <a href="#docker-部署">Docker 部署</a> ·
  <a href="#文档导航">文档</a> ·
  <a href="https://github.com/xingkongliec/PaleDove/issues">反馈问题</a>
</p>

## 项目简介

PaleDove 面向 IDC 与云服务运营者，通过 Incus REST API 管理容器和虚拟机，覆盖从产品上架、生成账单、支付开通，到续费、监控、到期暂停与回收的实例生命周期。

项目包含用户控制台、管理后台和独立宿主机 Agent。支持简体中文、繁体中文与 English，提供浅色 / 深色主题，并适配桌面和手机。

| 实例类型 | 网络方式 | 适用场景 |
| --- | --- | --- |
| **LXC NAT** | 共享公网 IPv4，通过端口映射提供服务 | 轻量应用、建站、开发测试 |
| **KVM NAT** | 完整虚拟机，通过 NAT 与端口映射提供服务 | 需要独立内核的应用 |
| **KVM 独立 IPv4** | 独立公网 IPv4，支持 routed / bridged | 需要独立地址的业务 |

订购实例、手动续费和付费重置流量均采用 **先生成账单、再确认支付、最后执行操作** 的流程。账单中心管理待支付与历史账单，费用中心管理余额、充值与资金明细。

> 本地体验可使用 SQLite、内存队列与模拟节点，无需 PostgreSQL、Redis 或真实 Incus 宿主机。生产部署使用外部 PostgreSQL 与 Redis；仓库提供的 Docker Compose 只启动面板。

## 界面预览

| 用户控制台 | 管理后台 |
| --- | --- |
| ![用户概览](docs/screenshots/user-dashboard.png) | ![管理总览](docs/screenshots/admin-dashboard.png) |
| ![实例详情](docs/screenshots/instance-detail.png) | ![宿主机接入](docs/screenshots/admin-add-host.png) |

<details>
<summary>查看更多界面：网页控制台、监控、多语言与手机端</summary>

| 实例与服务 | 主题与语言 |
| --- | --- |
| ![实例列表](docs/screenshots/user-instances.png) | ![深色实例详情](docs/screenshots/instance-detail-dark.png) |
| ![网页控制台](docs/screenshots/instance-console.png) | ![深色资源监控](docs/screenshots/instance-monitor-dark.png) |
| ![订购实例](docs/screenshots/user-deploy.png) | ![繁体中文宿主机管理](docs/screenshots/admin-host-zh-tw.png) |
| ![英文充值界面](docs/screenshots/user-recharge-en.png) | ![登录页](docs/screenshots/login.png) |

<p align="center">
  <img src="docs/screenshots/mobile-instances.png" width="260" alt="手机端实例列表" />
  <img src="docs/screenshots/mobile-detail-dark.png" width="260" alt="手机端深色实例详情" />
</p>

截图用于展示界面，具体布局与功能以当前版本为准。

</details>

## 功能特性

### 实例交付与网络

- **产品与套餐**：按类型、地区和周期售卖，配置 CPU、内存、磁盘、带宽、流量、快照、端口与建站配额；支持指定宿主机和存储池，以及快捷增加 / 减少库存、设置库存上限或不限量。
- **实例生命周期**：开关机、重启、强制关机、重装系统、重置密码、修改主机名、续费、流量重置与删除；后台支持规格调整、暂停恢复、创建重试和迁移管理。
- **网页控制台**：提供网页 Shell、串口与 KVM VNC 图形控制台；串口和 VNC 不依赖虚拟机内的 incus-agent，适合查看启动画面与进行系统恢复。
- **IPv4 / IPv6**：NAT 端口转发、独立 IPv4 地址池，以及独立 IPv6 地址 / 路由网段分配；支持按实例分配独占 IPv6 前缀。
- **网站与内网**：通过 Caddy 绑定域名、反向代理与自动 HTTPS；支持快照、VPC 私有网络和实例转移。
- **资源与流量**：实时资源数据、历史监控曲线与每日流量；支持入站、出站、双向合计、双向取大四种流量计费方式，以及超额限速 / 停机和周期恢复。
- **镜像筛选**：按宿主机架构和节点镜像设置筛选可用系统，持久保存已识别架构；节点离线时保留已知配置，离线状态与库存状态分别展示。

### 计费与运营

- **账单中心**：订购、续费与流量重置生成独立账单；详情页展示配置、金额和状态，确认余额支付后执行对应业务。订购后直接进入账单详情，购机账单支付成功后进入实例列表。
- **费用中心**：集中展示余额、消费 / 充值概况、资金明细、充值与兑换码，与账单中心分工清晰。自动续费任务按设置提前生成续费账单，仍需完成支付。
- **在线充值**：支持 Stripe、Heleket 和易支付；支付渠道在管理后台「计费管理」中配置，密钥加密保存。
- **交易市场**：公开或定向挂牌、余额购买、手续费配置与成交价走势。上架由宿主机 Agent 以实际对外 IPv4 执行真实 ICMP，支持 NAT 与独立 IPv4；大陆目标全超时时追加境外对照和第二轮检测。ICMP 仅反映可达性，不能单独判墙；全部超时显示无法判定。成交后按原镜像重新安装再交付买家。
- **夜市**：每位用户每期独立生成 6 张固定优惠卡，同组最多 2 张。后台可开关品质保底、设置保底数量与最低品质，并配置各品质概率；默认至少 2 张卓越及以上。支持配置时间、分组、入池期数及每个奖品的优惠区间和单次 / 循环优惠；每个奖品每人每期限购一次。用户管理可查看完整卡片、折扣、账单与购买状态，并重置该用户本期未购买的卡片；保留已购买奖品及订单，取消被替换卡片的未支付账单。
- **推广与优惠**：邀请返利、佣金比例、优惠码、兑换码与注册赠送余额。
- **公告与文档**：常规公告、文字 / 图片弹窗公告、套餐关联和展示偏好；后台独立「文档设置」管理多个文档、分类、服务条款与隐私政策，用户从控制台侧边栏进入文档中心。

### 宿主机与运维

- **交互式安装**：终端数字菜单选择 Incus 存储池类型、Agent、RFW 防火墙与规则；支持接入已有 Incus，安装后通过 `paledove` 命令进入本地维护菜单。
- **节点管理**：查看宿主机状态、资源分配、存储池、IP 池、实例与面板记录差异；管理 Caddy 网关、站点反代和智能分流出口。
- **实例审查**：采集进程、连接与启动项，内置挖矿、扫描、发包、DDoS 工具及代理核心识别规则；支持自定义规则库、匹配方式和风险等级，代理核心默认低风险。采集需要实例运行且命令通道可用，结果供管理员结合证据复核。
- **拨测设置**：自定义目标、启停与拨测对象；支持国内三网及香港、澳门、台湾等地区，港澳台目标无需选择运营商。使用 ICMP，条件不满足时回退 TCP，并标注探测方式。
- **独立 Agent**：Go 标准库实现，支持 Linux amd64 / arm64、签名心跳、资源和流量上报、VM CPU 限制、节点测试、出口配置及自动升级。
- **日志与维护**：简洁终端日志或 JSON 日志、任务队列与操作审计；支持维护模式、定时维护和白名单，任务与日志页面默认展示操作日志。

### 账号与用户服务

- 管理员与普通用户共用登录入口，按角色进入 `/admin` 或 `/console`；后台提供独立用户详情页、余额调整、禁用与代登录。
- 账号资料、头像、邮箱验证、双因素认证、通行密钥、API 令牌与业务邮件通知。
- 工单支持分类、优先级、关联实例、附件和双向回复；图片缩略图在上、文字气泡在下，支持原图预览和下载。
- 全局搜索、侧边栏分组、路由预加载、页面过渡、数据加载和按钮反馈，兼容手机端布局。

### IP 被墙判定与换 IP 说明

IP 被墙仅指**同一 IP 在中国大陆的 ICMP、全 TCP、全 UDP 全部阻断，且海外访问正常**。单端口失败、Google / YouTube / GPT / 流媒体访问异常、IP 地理库异常均不按 IP 被墙处理，不提供免费或自动换 IP。

当前 Agent 的上架拨测和机房切换前检测只提供 ICMP 证据，即使大陆多地多轮全超时、境外对照可达，也不满足上述定义。面板显示「ICMP 可达」「部分超时」或「无法判定」，不会据此标记「IP 异常」、增加免费换 IP 次数或自动更换 IP。

## 本地开发

需要 **Node.js ≥ 22.12**、**pnpm 10** 与 Git。仅构建宿主机 Agent 时需要 **Go ≥ 1.22**。

### 1. 获取源码与安装依赖

```bash
git clone https://github.com/xingkongliec/PaleDove.git
cd PaleDove
pnpm install --frozen-lockfile
```

### 2. 配置与初始化

```bash
cp server/.env.example server/.env
# 检查 APP_SECRET、ADMIN_USERNAME、ADMIN_EMAIL 和 ADMIN_PASSWORD
pnpm db:migrate
pnpm db:seed
```

Windows PowerShell 可用 `Copy-Item server/.env.example server/.env` 复制配置。

开发示例默认使用 `file:./data/dev.db`、`memory://` 和 `SEED_DEMO=true`，初始化后可使用模拟节点与演示套餐。

### 3. 启动

```bash
pnpm dev
```

| 服务 | 默认地址 |
| --- | --- |
| 前端与登录页 | <http://127.0.0.1:5180/login> |
| 后端 API | <http://127.0.0.1:3000/api/health> |

前端将 `/api` 和 WebSocket 代理到后端。可分别运行 `pnpm dev:server` 和 `pnpm dev:web`；后端更换端口时，为前端进程设置 `API_URL=http://127.0.0.1:<新端口>` 并重新启动。

| 本地体验账号 | 用户名 | 密码 |
| --- | --- | --- |
| 管理员 | `ADMIN_USERNAME`，示例为 `admin` | 首次初始化时的 `ADMIN_PASSWORD`，开发示例为 `Admin@123456` |
| 演示用户 | `demo` | `demo123456`，仅在 `SEED_DEMO=true` 时创建 |

以上为本地开发示例。**生产环境需要自行设置管理员密码，已有管理员不会被初始化脚本覆盖。**

初始化后也可运行 `pnpm start`，由后端在 `:3000` 同时提供页面与 API；缺少构建产物时自动构建，源码更新后用 `pnpm build` 刷新已有产物。模拟节点使用 `mock://名称`，其指标为模拟数据。

## Docker 部署

### 环境要求

| 组件 | 要求 |
| --- | --- |
| Docker | Engine 20.10+，Compose 2.30+ |
| 数据库 | 已创建、可从容器访问的 PostgreSQL 14+ |
| 缓存与队列 | 可从容器访问的 Redis 6+ |
| 对外访问 | 域名与 HTTPS 反向代理，宿主机和支付网关可访问面板 |

Compose 从源码构建 `paledove:local`，只部署面板容器，连接你已有的 PostgreSQL 与 Redis。

### 首次启动

在仓库根目录执行：

```bash
cp .env.example .env
# 编辑 .env，填写外部数据库、Redis、APP_SECRET、PANEL_URL 和管理员信息
docker compose up -d --build panel
docker compose ps
docker compose logs --tail=100 -f panel
```

必须检查以下配置：

```dotenv
DATABASE_URL=postgresql://paledove:your-db-password@db.example.com:5432/paledove
REDIS_URL=redis://:your-redis-password@redis.example.com:6379/0
APP_SECRET=replace-with-output-of-openssl-rand-hex-32
PANEL_URL=https://panel.example.com
ADMIN_USERNAME=admin
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=replace-with-your-own-strong-password
TRUST_PROXY=true
COOKIE_SECURE=true
SEED_DEMO=false
```

使用 `openssl rand -hex 32` 生成 `APP_SECRET`。生产管理员密码长度为 12～128 个字符，不使用示例占位符。根目录 `.env` 采用 Compose 的 raw 格式，值不加引号；连接串内的特殊字符仍须按 URL 规则编码。

默认绑定 `127.0.0.1:3000`，可由宿主机上的 Caddy 提供 HTTPS：

```caddyfile
panel.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

容器启动自动应用迁移，且仅在数据库没有任何管理员时创建初始账号。镜像预置可执行 `docker compose run --rm panel init`。Docker 中的 `127.0.0.1` 指向容器自身，连接宿主机上的数据库可使用已配置的 `host.docker.internal`。

### 持久化与证书

| 内容 | 存储位置 |
| --- | --- |
| 工单附件、站点图标、Agent 下载缓存 | `panel-data` 命名卷，挂载到 `/app/server/data` |
| Incus 客户端证书 | `server/certs/incus/`，只读挂载到容器 |
| 环境变量与应用密钥 | 根目录 `.env`，不会复制进镜像 |
| PostgreSQL / Redis 数据 | 外部服务，各自备份 |

接入真实宿主机前，由开发者自行创建并放置 `client.crt` 和 `client.key`，面板不会自动生成或存入数据库。容器以 UID/GID `1000:1000` 运行，须有权读取证书；具体命令与权限见 [证书目录说明](server/certs/incus/README.md)。

**升级和迁移必须保留原 `APP_SECRET`、数据库、数据卷与证书。** 完整安装、升级、分离 API / Worker 和 HTTP 调试说明见 [Docker 部署文档](docs/DOCKER.md)。

## 直接运行 Node.js

不使用 Docker 时，在安装依赖后复制生产配置到 `server/.env`，填写外部 PostgreSQL / Redis 等信息：

```bash
cp .env.example server/.env
# 编辑 server/.env，设置生产连接串、应用密钥与管理员信息
pnpm build
pnpm db:deploy
pnpm db:seed
pnpm start
```

后端同时提供 API 与 `web/dist` 中的页面，前方配置 HTTPS 反向代理。使用 systemd 等进程管理器时，工作目录设为 `server/`，启动命令为 `node dist/index.js`，并确保运行账号可写入数据目录、读取证书。

默认同一进程运行 API 和 Worker。扩展 API 实例时设置 `RUN_WORKER=false`；独立 Worker 设置 `RUN_API=false`，并共享数据库、Redis、附件和证书。后台 Worker 建议保持一个。

## 接入宿主机

宿主机安装脚本支持 **Debian 12 / 13、Ubuntu 22.04 / 24.04**；售卖 KVM 实例需要硬件虚拟化与可用的 `/dev/kvm`。

1. 准备 [Incus 客户端证书](server/certs/incus/README.md)，在「系统设置 → 面板证书」确认加载状态，并设置宿主机可访问的 `PANEL_URL`。
2. 在「宿主机」中创建节点并生成安装命令，以 root 在目标宿主机执行。
3. 在终端菜单中选择 ZFS / Btrfs / LVM thin / dir、存储来源、Agent、RFW 和防火墙规则。安装后自动配置 Incus、存储、网络、证书信任与注册回调。
4. 按需放行实例公网端口，Incus 与 Caddy 管理端口仅对面板开放；独立 IPv4 在节点 IP 池中配置。
5. 需要网站绑定时，在节点的「Caddy」页生成并执行安装命令；已有 Incus 可用信任令牌接入，再单独安装 Agent。

安装完成后，通过以下命令打开宿主机本地维护菜单：

```bash
paledove
# 非 root 用户：sudo paledove
```

菜单提供状态查看、Agent / RFW 卸载与节点卸载。**整机卸载会删除本机全部 Incus 项目的实例及存储资源**，执行前备份并停用节点；删除确认无法用无人值守参数跳过。

安装模板每次下载重新读取，更新模板后需重新下载脚本；令牌过期或已使用时，在面板重新生成命令。存储设备确认、规则选择、无人值守参数及脚本刷新逻辑见 [安装脚本说明](server/templates/README.md)。

### Agent 下载与 GitHub 发布

宿主机从面板下载 Agent，面板从配置的 GitHub Release 获取并校验文件，宿主机无需直接访问 GitHub，私有仓库令牌也不会下发。

```text
GitHub Release → 面板代理与校验缓存 → 宿主机安装 / 自动升级
```

在对应部署环境文件中设置下载源，例如本仓库：

```dotenv
AGENT_RELEASE_REPOSITORY=xingkongliec/PaleDove
# 私有仓库或需要提高 GitHub API 配额时填写
AGENT_RELEASE_TOKEN=
```

使用自己的 Fork 时，改为自己的 `owner/repo`，并先发布 Agent：

1. 修改 `server/src/shared/products.ts` 中的 `HOST_AGENT_RELEASE`。
2. 推送到默认分支，由 [Agent Build and Release](.github/workflows/agent-release.yml) 执行测试、双架构构建并发布 `agent-v<版本>`；也支持对应标签或默认分支手动触发。
3. 确认 Release 包含两种架构二进制、`SHA256SUMS` 与 `manifest.json`，再重新生成 Agent 安装命令。同名 Release 不会覆盖，更新时递增版本号。

未配置 Release 仓库时，可用 `pnpm build:agent` 提供本地 `agent/dist/`。面板的 `pnpm build` 不要求 Go。详细发布、缓存与故障处理见 [Agent 发布与下载](docs/AGENT_RELEASE.md)。

## 关键配置

**本地与直接运行 Node.js 读取 `server/.env`，Docker 读取根目录 `.env`，两处互不覆盖。** 完整选项以 [开发示例](server/.env.example) 和 [生产示例](.env.example) 为准。

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | 本地 `file:./data/dev.db`；生产使用 PostgreSQL 连接串 |
| `REDIS_URL` | 本地 `memory://`；生产使用 Redis 连接串 |
| `APP_SECRET` | 加密实例密码、支付密钥等数据，部署后保持不变 |
| `PANEL_URL` | 面板公开地址，用于安装回连、支付回调与邮件链接 |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 仅在数据库没有管理员时初始化账号 |
| `TRUST_PROXY` / `COOKIE_SECURE` | HTTPS 反向代理部署均设为 `true` |
| `INCUS_CERT_DIR` | 客户端证书目录，默认 `certs/incus`，相对于 `server/` |
| `UPLOAD_DIR` | 工单附件目录，默认 `data/uploads`，相对于 `server/` |
| `AGENT_RELEASE_REPOSITORY` / `AGENT_RELEASE_TOKEN` | Agent Release 下载源与可选访问令牌 |
| `AGENT_RELEASE_CACHE_DIR` / `AGENT_DIST` | Release 磁盘缓存 / 本地二进制目录 |
| `RUN_API` / `RUN_WORKER` | 是否启用 HTTP API / 后台 Worker |
| `LOG_FORMAT` / `LOG_LEVEL` / `LOG_REQUESTS` | `pretty` 或 `json`、日志级别、请求日志开关 |
| `SEED_DEMO` | 初始化模拟节点、套餐和用户，生产设为 `false` |
| `PANEL_BIND` / `PANEL_PORT` | Compose 宿主机绑定地址与端口，默认 `127.0.0.1:3000` |

## 技术栈与项目结构

| 模块 | 技术 |
| --- | --- |
| 前端 | React 19 · TypeScript · Rsbuild · Tailwind CSS 4 · Base UI · TanStack Query · React Router 7 |
| 图表与控制台 | Recharts · xterm.js · noVNC |
| 后端 | Fastify 5 · Prisma 7 · Zod · BullMQ |
| 数据与队列 | PostgreSQL / SQLite（本地）· Redis / 内存队列（本地） |
| 宿主机 Agent | Go 1.22+，标准库，Linux amd64 / arm64 |
| 实例管理 | Incus REST API，TLS 客户端证书与服务端指纹固定 |

```text
PaleDove/
├── server/
│   ├── src/               API、业务服务、队列与后台任务
│   │   └── shared/        前后端共用类型、枚举与纯函数
│   ├── prisma/            数据模型、增量迁移与初始化
│   ├── templates/         Incus / Caddy / Agent 安装模板
│   ├── scripts/           构建、数据库、翻译与容器工具
│   ├── test/              服务端测试
│   ├── certs/incus/       开发者部署的证书与私钥
│   └── data/              运行数据、附件与本地数据库
├── web/
│   ├── src/               页面、组件、布局、样式与多语言
│   └── public/            Logo 等公开静态资源
├── agent/                 Go 宿主机 Agent 与构建脚本
├── docs/                  部署说明、使用文档与截图
├── .github/workflows/      Agent 构建发布流程
├── Dockerfile
├── docker-compose.yml
└── .env.example           生产 / Docker 配置示例
```

前端通过 `web/src/shared/index.ts` 引用 `server/src/shared/`，共用代码无需独立包，也不需要根目录 `shared/`。详细目录职责与生成文件说明见 [项目结构](docs/PROJECT_STRUCTURE.md)。

## 开发与贡献

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 同时启动后端与前端热更新 |
| `pnpm typecheck` | 前后端 TypeScript 检查 |
| `pnpm test` | 服务端测试 |
| `pnpm build` / `pnpm start` | 构建 / 启动面板 |
| `pnpm db:migrate` | 开发迁移；SQLite 模式同步派生模型 |
| `pnpm db:deploy` | 应用生产 PostgreSQL 增量迁移 |
| `pnpm db:seed` | 初始化缺少的管理员与默认镜像，按开关创建演示数据 |
| `pnpm i18n:tw` | 从简体中文生成前后端繁体中文字典 |
| `pnpm build:agent` / `pnpm build:agent:release` | 构建 Agent / Release 资产 |
| `pnpm test:agent` / `pnpm test:docker` / `pnpm test:startup` | Agent、容器与启动检查 |

欢迎通过 [Issue](https://github.com/xingkongliec/PaleDove/issues) 报告问题，或提交聚焦单一改动的 Pull Request。请说明复现步骤、部署方式、相关版本与验证结果，日志中的令牌和密钥应先脱敏。

- 提交前运行相关类型检查与测试；修改 Agent 或容器配置时执行对应检查。
- 修改 `server/prisma/schema.prisma` 后补充 PostgreSQL 增量迁移；SQLite 开发同步不会自动生成生产迁移文件。
- 新增文案同时维护简体中文与英文，再执行 `pnpm i18n:tw`；不手工修改生成的繁体字典、SQLite schema 与 Prisma 客户端。
- 复用 UI 放在 `web/src/components/`，共用契约放在 `server/src/shared/`，颜色沿用语义令牌。
- 不提交 `.env`、运行数据库、上传附件、真实证书、私钥或 `.workbuddy/`；功能验证使用模拟节点或隔离测试数据。

## 常见问题

<details>
<summary><strong>修改环境变量后，管理员为什么还是旧账号或旧密码？</strong></summary>

初始化仅在数据库没有任何管理员时创建账号。已有管理员时，不比较或覆盖环境变量中的用户名、邮箱和密码。请使用首次创建时的账号；配置中的密码不是密码重置入口。

</details>

<details>
<summary><strong>Docker 登录后又回到登录页？</strong></summary>

检查访问协议与 `COOKIE_SECURE`。正式部署使用 HTTPS，保持 `COOKIE_SECURE=true`、`TRUST_PROXY=true`。仅在直接通过 HTTP 调试时设为 `false`，同时调整 `PANEL_URL`，并重新创建容器以应用环境变量。

</details>

<details>
<summary><strong>没有虚拟机内的 incus-agent，还能操作实例吗？</strong></summary>

串口和 VNC 不依赖 incus-agent。宿主机 Agent 0.8.0+ 提供独立流量采样，并可在 Incus exec 明确不可用时通过 SSH 备用通道执行命令；该通道需要实例 SSH 可达、允许 root 密码登录且面板保存的密码有效。详细前提见 [实例访问与网络](docs/INSTANCE_ACCESS.md)。

</details>

<details>
<summary><strong>拨测延迟代表什么？</strong></summary>

节点拨测由宿主机 Agent 向所配置的目标发起，页面展示探测方式、时间、延迟与丢包。它不是访问面板的浏览器到机房的延迟；ICMP 不可用时可能展示 TCP 连接耗时。模拟节点的数据用于体验。

</details>

<details>
<summary><strong>Caddy 管理接口提示证书过期？</strong></summary>

先校准面板与宿主机的系统时间，再更新版本、重新生成并执行节点的 Caddy 安装命令。脚本刷新独立管理 CA 与证书链，同时保留已有站点和存储配置。面板自身的客户端证书过期时，需由开发者更新证书文件与节点信任。

</details>

<details>
<summary><strong>夜市如何配置，优惠会不会被刷新？</strong></summary>

在「夜市设置」配置开放时间、刷新周期、抽取规则和奖品库。品质保底可以关闭，也可设置保证 1～6 张达到指定品质及以上；四种品质概率填写整数百分比，合计须为 100%。概率为 0 的品质不参与抽取和保底，没有可用奖品的品质会被跳过，其余概率按比例分配。系统先按品质概率抽取，再在该品质中等概率选择奖品，保底、同组最多 2 张和奖品不重复的限制会影响最终品质占比。

有效奖品及分组容量须能抽满 6 张，并满足配置的保底要求。期数从 1 开始自动推进，每期奖池、抽取规则、卡片与优惠固定；规则修改从下一期生效，同一期晚进入的用户也沿用该期规则。单次优惠仅用于首期，循环优惠绑定实例续费价。每个奖品每人每期限购一次，购买其他卡片不受影响。

每个奖品支持 1%～99% 的整数优惠区间，两端相同时为固定优惠。每期开启时冻结奖品目录、原价与优惠配置，奖品与周期配置修改从下一期生效，开关即时生效，关闭再开启不会重刷本期。已拥有的套餐仍可能出现。

选择奖品后先生成账单，成功支付才消耗该奖品的购买次数；余额不足、库存不足或取消账单不消耗次数。账单需在本期结束前支付，循环优惠续费不叠加优惠码。

</details>

<details>
<summary><strong>如何升级和备份？</strong></summary>

升级前备份 PostgreSQL、Redis、附件 / 数据卷、证书和环境文件，保留原 `APP_SECRET`。Node.js 部署更新依赖、构建、应用迁移后重启；Docker 按 [升级步骤](docs/DOCKER.md#迁移与升级) 重建并迁移。不要删除生产数据卷；SQLite 与 `memory://` 仅用于单进程本地开发，生产镜像不包含 SQLite 适配器。

</details>

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [Docker 部署](docs/DOCKER.md) | 首次部署、环境变量、迁移、备份与进程拆分 |
| [Agent 发布与下载](docs/AGENT_RELEASE.md) | GitHub Actions、Release、代理下载、校验与缓存 |
| [宿主机 Agent](agent/README.md) | 安装、签名认证、心跳、功能与自动升级 |
| [宿主机安装脚本](server/templates/README.md) | 存储池、防火墙、卸载、快捷命令与刷新逻辑 |
| [Incus 证书](server/certs/incus/README.md) | 证书创建、目录、读取权限与轮换 |
| [实例访问与网络](docs/INSTANCE_ACCESS.md) | 串口 / VNC、IPv6、宿主机流量与 SSH 备用执行 |
| [项目结构](docs/PROJECT_STRUCTURE.md) | 目录职责、共享代码、生成文件与运行数据 |

用户 API 文档位于部署后的 `/console/docs/api`，从「账号设置 → API 令牌」进入。

## 许可证

基于 [MIT License](LICENSE) 开源，允许使用、修改、分发及商业使用，请保留版权与许可声明。

Copyright © 2026 PaleDove contributors.

# PaleDove · 基于 Incus 的 IDC 云服务器售卖面板

PaleDove 是一套面向 IDC / 云服务商的实例售卖与管理面板，后端通过 [Incus](https://linuxcontainers.org/incus/) REST API 管理宿主机，支持售卖 **LXC NAT**、**KVM NAT** 与 **KVM 独立 IPv4** 三类实例。管理后台与用户后台共用同一个登录入口，登录后按角色自动进入对应后台。

管理员账号仅能访问管理后台，购买实例、充值和个人实例等控制台功能仅对普通用户开放；管理员仍可在管理后台管理全部实例、处理工单和维护自身账号安全设置。「以用户身份登录」使用被代登录用户的权限，退出代登录后返回管理后台。

| 用户后台 | 管理后台 |
| --- | --- |
| ![概览](docs/screenshots/user-dashboard.png) | ![管理总览](docs/screenshots/admin-dashboard.png) |
| ![实例详情](docs/screenshots/instance-detail.png) | ![实例详情（深色）](docs/screenshots/instance-detail-dark.png) |
| ![购买实例](docs/screenshots/user-deploy.png) | ![充值（English）](docs/screenshots/user-recharge-en.png) |
| ![添加宿主机（一键安装脚本）](docs/screenshots/admin-add-host.png) | ![存储池（繁體中文）](docs/screenshots/admin-host-zh-tw.png) |
| ![资源监控（深色）](docs/screenshots/instance-monitor-dark.png) | ![登录页](docs/screenshots/login.png) |

<p align="center">
  <img src="docs/screenshots/mobile-instances.png" width="260" alt="手机端实例列表" />
  <img src="docs/screenshots/mobile-detail-dark.png" width="260" alt="手机端实例详情（深色）" />
</p>

## 功能

**界面**

- 白底黑色强调的简约控制台：顶栏（侧边栏收起、控制台 / 费用中心 / 管理后台、全局搜索 `Ctrl / ⌘ + K`、明暗切换、语言、公告通知、余额、账户菜单）+ 分组侧边栏（可收起为图标栏）
- 全局搜索可跳转到任意页面、快捷操作与实例（按名称 / 主机名 / IP 匹配）；公告在顶栏铃铛中查看，有新公告时显示红点
- 简体中文、繁體中文、English 三种语言，浅色 / 深色（可在账号设置中选择跟随系统）；语言偏好同步到账户，服务端错误信息与通知同样按语言返回
- 手机端适配：侧边栏变为抽屉，表格自动切换为卡片列表，对话框变为底部弹出层，标签栏可横向滑动

**用户后台**

- 概览：余额、本月消费、运行中实例、我的实例列表与常用入口
- 购买实例：分步选择实例类型、套餐、地区与付款周期（月、季、半年、年）、系统镜像与登录凭据，右侧实时显示配置摘要与应付金额，余额支付后自动开通
- 实例操作：开机、关机、重启、强制关机、重装系统（可设置密码与 SSH 公钥）、重置 root 密码、修改主机名、删除
- 资源占用：CPU、内存、硬盘、进程数实时数据；CPU / 内存 / 网络速率历史曲线（1 / 6 / 24 小时）与 30 天每日流量
- 流量周期：按购买日为锚点按月重置，支持单向出站 / 单向入站 / 双向合计 / 双向取大四种计费方式，超额后限速或停机，周期重置后自动恢复
- 端口映射（NAT 实例）：自助添加 TCP / UDP / TCP+UDP 转发，公网端口可指定或自动分配，SSH 端口自动映射；侧边栏「端口映射」集中管理所有实例的规则
- 网站绑定（NAT 实例）：域名经宿主机上的 Caddy 反向代理到实例端口，自动申请 HTTPS 证书，可选校验域名解析；可在实例详情或「网站绑定」页统一管理
- 快照：创建、恢复、删除，按套餐限制数量；「快照」页汇总全部实例的快照
- 操作日志：全部实例的开机、关机、重装、快照等任务记录
- 在线充值：Stripe（银行卡等）、Heleket（加密货币）、易支付（支付宝 / 微信 / QQ 钱包），支付完成后自动返回并显示到账结果
- 费用中心：余额、本月消费 / 充值、累计充值，充值对话框（金额档位 + 支付方式）、兑换码充值，余额明细、订单与充值记录；续费（支持多周期）与自动续费
- 交易市场：把自己的实例挂牌出售（公开或定向给指定用户，成交后一律用原镜像全新安装再交给买家），买家用余额购买后实例立即转入其账户；卡片显示配置、流量、续费价格与到期时间，并提供同套餐近 30 天的成交价走势；游客可在首页直接浏览，登录后购买
- API 令牌：在「账号设置 → API 令牌」创建（只读或完整权限，可设有效期），用 `Authorization: Bearer pd_…` 调用控制台接口，接口文档在 `/docs/api`；只读令牌只能查询，且不能打开终端或查看实例密码；任何令牌都不能访问登录、令牌管理与实名认证等账号安全接口；找回密码后全部令牌自动吊销

**管理后台**

- 管理总览：用户、运行中实例、本月收入、在线宿主机指标条；各宿主机 CPU / 内存 / 硬盘的分配情况；「待处理」汇总离线宿主机、异常实例、失败任务与未生效的网站绑定；30 天收入图与最近订单
- 宿主机：**后台填写名称、地区与存储池参数后生成一键安装脚本**，在宿主机上执行即可自动安装 Incus、创建存储池与 NAT 网桥、信任面板证书并回连注册，无需在面板中填写 SSH 信息；也支持接入已有 Incus（信任令牌）
- 存储池：通过 Incus API 查看、创建（zfs / btrfs / lvm / dir，块设备或镜像文件）、删除、设为默认；套餐可指定存储池
- Caddy 网关：为宿主机生成 Caddy 安装脚本，面板通过仅允许面板证书访问的远程管理 API（mTLS）下发配置
- 站点反代：在后台把任意域名反向代理到内网或外部服务（HTTP / HTTPS 上游，自动证书），并统一查看、删除用户的网站绑定
- 在线充值：配置各支付网关（密钥加密保存、显示掩码、汇率与结算货币、回调地址），查看充值记录并可手动确认到账
- IP 地址池：按宿主机批量添加独立 IPv4（单个 / CIDR / 区间），支持 routed 与 bridged 两种网卡模式
- 套餐：规格、带宽、流量与计费方式、超额策略、端口 / 建站 / 快照配额、存储池、各周期价格、库存、可售宿主机
- 系统镜像：任意 simplestreams / incus / oci 镜像源，可为单个镜像自定义 cloud-init 模板；宿主机架构由 Agent / Incus 检测后持久保存，离线时订购页仍按已知架构和节点镜像设置筛选，节点保留展示并标记缺货
- 实例管理：检索筛选全部实例，调整规格（自动下发到宿主机）、到期时间、价格，暂停 / 解除暂停、重置流量、重试创建、删除（可退款）
- 用户：创建、编辑、禁用、充值 / 调整余额、**以该用户身份登录**排查问题
- 交易市场：查看全部挂牌、按状态筛选与搜索，下架违规商品（卖家收到通知）；在「系统设置 → 交易市场」开启并设置成交手续费与最短剩余天数
- 订单与财务、兑换码批量生成、公告、任务队列与操作审计日志、系统设置

## 架构

```
                 ┌──────────────────────────────┐
  浏览器 ──HTTPS──▶ Fastify API + 前端静态文件      │── PostgreSQL（Prisma）
                 │  · Redis 会话 / 限流 / 监控数据  │── Redis
                 │  · BullMQ 任务队列与定时任务     │
                 └──────────────┬───────────────┘
                                │ Incus REST API（TLS 客户端证书 + 服务端指纹固定）
              ┌─────────────────┼─────────────────┐
         ┌────▼────┐       ┌────▼────┐       ┌────▼────┐
         │ 节点 A   │       │ 节点 B   │       │ 节点 …   │
         │ incusbr0 │       │         │       │         │
         │ ├ 实例    │       │         │       │         │
         │ └ Caddy（80/443 → 实例 / 反代站点，mTLS 远程管理）
         └─────────┘       └─────────┘       └─────────┘
              ▲ 安装脚本执行完成后回连面板注册（一次性令牌）
```

- **前端**：React 19 · TypeScript · Rsbuild · Base UI · Tailwind CSS v4 · TanStack Query · Recharts · 内置轻量 i18n（简体 / 繁體 / English）
- **后端**：Fastify 5 · Prisma 7（PostgreSQL）· Redis（ioredis）· BullMQ · Zod
- **monorepo**：`server`（API + Worker）、`web`（前端）；共用类型、枚举和纯函数位于 `server/src/shared`，前端通过 `web/src/shared` 引用同一份源码

### 关键实现

| 能力 | 实现方式 |
| --- | --- |
| 实例创建 | `POST /1.0/instances`，规格写入 `limits.cpu` / `limits.memory` / 根磁盘 `size`，网卡 `limits.ingress/egress` 限速；容器开启 `security.nesting` 以支持 Docker |
| 初始化系统 | cloud-init `user-data` 设置主机名、root 密码、SSH 公钥并安装启用 sshd；独立 IP 实例通过 `network-config` 写入静态地址 |
| NAT 网络 | 实例接入托管网桥并分配固定内网 IP（`ipv4.address`），面板从网段高位开始分配 |
| 端口映射 | 为每条规则添加 `proxy` 设备（`nat=true`，内核 DNAT 转发，无用户态代理进程） |
| 独立 IPv4 | `routed` 网卡（宿主机代理 ARP，网关 169.254.0.1）或 `bridged` 网卡（桥接到上联网桥） |
| 宿主机安装 | 面板生成带一次性令牌（24 小时有效，仅存 SHA-256）的 bash 脚本：安装 Incus（Zabbly 源，失败回退发行版源）与存储工具、`incus admin init --preseed`（API 端口、NAT 网桥、存储池、默认 profile）、信任面板证书、检测公网 IP，最后携带服务端证书指纹回调 `/api/agent/nodes/register`，面板据此固定指纹并完成连接 |
| 存储池 | Incus `storage-pools` API；创建时可指定块设备（整盘）或镜像文件大小 |
| 网站绑定 / 站点反代 | 宿主机直接运行 Caddy（`caddy-api.service`，`--resume`）。面板生成完整 JSON 配置并通过远程管理接口 `POST /load` 整体下发；远程接口只接受面板客户端证书（`admin.remote.access_control`），面板用 Caddy 本地 CA 校验服务端证书 |
| 在线充值 | Stripe Checkout（Webhook HMAC-SHA256 签名 + 时间戳容差）、Heleket（`md5(base64(json) + key)`，兼容 PHP 转义斜杠的回调格式）、易支付 V1（参数排序 MD5）；回调验签并核对金额与币种，入账幂等（状态条件更新 + 余额流水同一事务），返回页主动查询网关确认结果，超过 24 小时未支付自动过期 |
| 多语言 | 前端字典以简体中文为源，`pnpm i18n:tw` 通过 OpenCC（台湾用语）与术语表生成繁体；服务端按 `x-locale` 请求头 > 账户偏好 > `Accept-Language` 选择语言，后台任务按实例所属用户的语言记录信息 |
| 重装系统 | 删除快照 → 更新 cloud-init → `POST /1.0/instances/<name>/rebuild` → 开机 |
| 快照 | Incus 快照 API；恢复时先关机、恢复后按原状态开机 |
| 资源与流量 | 每分钟一次 `GET /1.0/instances?recursion=2` 批量读取状态；根据网卡计数器差值累计流量（处理重启后的计数器归零），写入每日流量表；CPU 使用率由 CPU 时间差计算 |
| 任务执行 | 实例操作写入任务表并投递到 BullMQ；同一实例的任务通过 Redis 锁串行执行；服务重启后自动处理中断任务 |
| 生命周期 | 定时任务处理自动续费、到期暂停、宽限期后删除、流量周期重置与超额处理 |

## 快速开始（开发 / 体验）

环境要求：Node.js ≥ 22.12、pnpm 10。默认使用 SQLite、内存缓存与模拟节点，无需安装 PostgreSQL / Redis 或准备 Incus 宿主机。

```bash
# 1. 安装依赖
pnpm install

# 2. 本地配置：后端读取 server/.env
cp server/.env.example server/.env
#   默认 NODE_ENV=development、SQLite、memory://、SEED_DEMO=true
#   可修改 APP_SECRET 和 ADMIN_PASSWORD；已有部署必须沿用原密钥
#   连接真实宿主机前，由开发者创建证书并上传到 server/certs/incus/（见下文）

# 3. 初始化本地数据库
pnpm db:migrate
pnpm db:seed

# 4. 启动（后端 :3000，前端 :5180，/api 含 WebSocket 代理到后端）
pnpm dev
```

也可像参考项目一样分别运行 `pnpm dev:server`、`pnpm dev:web`。只想体验时，在初始化后执行 `pnpm start`：缺少构建产物时自动构建前后端，由后端直接提供页面，访问 <http://127.0.0.1:3000/login>。构建产物已存在时直接复用；修改源码后可执行 `pnpm build` 更新。只用前端热更新时可在 `server/.env` 设置 `SKIP_WEB_BUILD=1`，跳过页面构建检查。

本地配置默认如下；使用真实服务时在 `server/.env` 替换对应连接串：

```bash
DATABASE_URL=file:./data/dev.db   # SQLite，表结构由 pnpm db:deploy 通过 db push 同步（不使用 prisma/migrations）
REDIS_URL=memory://               # 进程内存储 + 进程内任务队列，替代 Redis 与 BullMQ
```

SQLite schema 由 `server/scripts/sqlite-schema.mjs` 从 PostgreSQL 模型自动派生，无需单独维护；内存模式的数据（会话、模拟节点状态等）会写入 `server/data/memory-redis.json`，开发服务器热重启后不会丢失。这两种模式仅适用于单进程本地开发。后端端口被占用时可修改 `PORT`，并在 `web/.env.local` 中设置 `API_URL=http://127.0.0.1:<端口>`；`PANEL_URL` 填写浏览器实际访问的地址。

工单支持分类、优先级、关联实例、附件及邮件通知。用户提交或补充后为待处理，管理员回复后为已回复，解决后可关闭或重新打开。附件默认存放于 `server/data/uploads`，可通过 `UPLOAD_DIR` 指定目录；备份和迁移时须同时保留数据库与附件目录，多 API 进程须共享附件目录。每次最多 5 个文件、单文件最多 10 MB，每个账号 24 小时最多上传 200 MiB，普通用户最多有 20 个未关闭工单。

开发模式打开 <http://127.0.0.1:5180/login>：

- 管理员：`admin` / `ADMIN_PASSWORD`（本地示例默认 `Admin@123456`）
- 演示用户（仅 `SEED_DEMO=true`）：`demo` / `demo123456`

> **模拟节点**：在「接入已有 Incus」中把 API 地址填写为 `mock://任意名称` 即为模拟节点，实例状态保存在 Redis 中，资源占用与流量为随机数据。用于在没有 Incus 宿主机时体验完整流程，切勿用于生产。

## Incus 客户端证书（开发者部署）

面板访问 Incus 与宿主机 Caddy 的客户端证书统一从本地文件读取。由开发者自行创建证书，然后上传至面板项目目录：

```text
server/certs/incus/
  client.crt     # PEM 格式的 X.509 客户端证书
  client.key     # 与证书匹配的未加密 PEM 私钥
```

开发者可在自己的安全环境中使用 OpenSSL 创建证书，再将文件上传到上述目录；具体命令及权限说明见 [证书目录说明](server/certs/incus/README.md)。证书须在有效期内、与私钥匹配；声明扩展密钥用途时须包含 `clientAuth`。私钥建议权限为 `600`，且服务运行账号必须有读取权限。

- 系统不会自动生成证书，也不会从数据库读取、恢复或保存证书与私钥。缺失或无效时仍可进入后台，其余真实节点操作会报告证书配置错误；`mock://` 节点无需证书。
- 「系统设置 → 面板证书」显示实际文件路径、加载状态、指纹与有效期，支持重新读取及下载公钥证书。证书部署与私钥备份均在服务器侧完成。
- `INCUS_CERT_DIR` 可指定其他目录，相对路径始终以 `server` 为基准，也可以使用绝对路径。API 与 Worker 拆分部署时须读取同一对证书，容器部署可只读挂载。
- 替换文件后，各进程后续的 Incus / Caddy 连接会自动使用新证书。轮换前须让宿主机信任新证书；替换期间先暂停相关节点操作，两个文件替换完成后再恢复。
- 证书目录已忽略实际证书与私钥文件，不要放到前端静态目录或提交到版本库。备份与迁移须单独保留证书目录。

从旧版本升级时，如需保留宿主机现有信任，请在升级前自行导出旧证书与私钥并拆分为 `client.crt`、`client.key` 后上传。新版本不使用旧数据库的 `incus.clientCertificate` 记录；确认备份和连通性后，可由数据库维护人员清理该历史记录。

## Docker 部署

项目提供多阶段 `Dockerfile`，镜像包含前端、API、后台 Worker 和数据库迁移工具。`docker-compose.yml` **只部署面板**，不包含 PostgreSQL 或 Redis 容器；通过环境变量连接已有的外部 PostgreSQL / Redis。要求 Docker Compose 2.30+。

```bash
cp .env.example .env
# 编辑 DATABASE_URL、REDIS_URL、APP_SECRET、PANEL_URL 与 ADMIN_PASSWORD
# 开发者准备并上传 server/certs/incus/client.crt 与 client.key
docker compose up -d --build panel   # 自动迁移数据库，仅在没有管理员时创建账号
```

默认映射 `127.0.0.1:3000`，由宿主机 Caddy / Nginx 提供 HTTPS。附件和 Agent Release 缓存保存在 `panel-data` 命名卷，证书只读挂载，启动时自动应用 PostgreSQL 增量迁移。完整环境配置、证书权限、升级、Agent 与独立 Worker 说明见 [Docker 部署文档](docs/DOCKER.md)。

容器启动时，仅在数据库中没有管理员时按环境变量创建账号；已有任意管理员就跳过，即使 `.env` 中的用户名、邮箱或密码不同，也会保留原账号。常用镜像可通过 `docker compose run --rm panel init` 预置，详见 [管理员初始化](docs/DOCKER.md#管理员初始化)。

## 生产部署（直接运行 Node.js）

```bash
git clone <repo> /opt/paledove && cd /opt/paledove
pnpm install --frozen-lockfile
cp .env.example server/.env   # 使用生产示例，填写外部 DATABASE_URL / REDIS_URL / APP_SECRET 等
# 由开发者准备并上传 server/certs/incus/client.crt 与 client.key
pnpm build                                      # 构建前端与后端（server/dist/index.js），面板服务器无需 Go
pnpm db:deploy && pnpm db:seed
```

- 用 systemd 运行 `node dist/index.js`，后端会直接托管 `web/dist` 中的前端页面（`WEB_DIST`）。服务文件示例（`/etc/systemd/system/paledove.service`）：

  ```ini
  [Unit]
  Description=PaleDove IDC panel
  After=network-online.target postgresql.service redis-server.service
  Wants=network-online.target

  [Service]
  Type=simple
  User=paledove
  WorkingDirectory=/opt/paledove/server
  EnvironmentFile=/opt/paledove/server/.env
  ExecStart=/usr/bin/node dist/index.js
  Restart=on-failure
  RestartSec=5
  # 优雅退出：等待正在执行的任务结束
  TimeoutStopSec=60
  NoNewPrivileges=true
  ProtectSystem=full
  PrivateTmp=true

  [Install]
  WantedBy=multi-user.target
  ```
- 在 `.env` 中设置 `PANEL_URL`（面板对外访问地址），宿主机安装脚本、支付回调与邮件链接都依赖它。生产环境未配置时，找回密码与验证邮箱的邮件不会发送（不使用可伪造的请求 Host 生成链接）。
- 建议在前面放置 Caddy / Nginx 提供 HTTPS，并设置 `TRUST_PROXY=true`。Caddy 示例（TLS 自动申请）：

  ```
  panel.example.com {
  	encode gzip
  	reverse_proxy 127.0.0.1:3000
  }
  ```
- **`APP_SECRET` 部署后不可更改**：它用于加密实例 root 密码、支付密钥等数据，更换后这些数据将无法解密。Incus 客户端证书私钥独立保存在本地文件目录。
- 默认一个进程同时运行 API 与 Worker。需要水平扩展 API 时，可额外启动 `RUN_WORKER=false` 的 API 进程；Worker（`RUN_WORKER=true`）建议只运行一个。
- 升级：`git pull && pnpm install && pnpm build && pnpm db:deploy`，然后重启服务。
- 宿主机 Agent（`agent`，Go 编写）与面板独立发布。正式部署设置 `AGENT_RELEASE_REPOSITORY=owner/repo`，面板从本项目的 GitHub `agent-v*` Release 查询版本并代理下载，宿主机只访问面板。内存与可选磁盘缓存减少重复下载，GitHub 暂时不可用时可使用 24 小时内的已校验缓存；心跳不等待外部网络。发布步骤、私有仓库与缓存配置见 [Agent 发布与下载](docs/AGENT_RELEASE.md)。
- 未设置 Release 仓库时使用本地开发模式：执行 `pnpm build:agent` 生成 `agent/dist/`（linux/amd64 与 linux/arm64），也可通过 `AGENT_DIST` 指定目录。已配置 Release 仓库时不会自动切回本地旧版本。

## 添加宿主机

宿主机需为 **Debian 12 / 13** 或 **Ubuntu 22.04 / 24.04**（建议全新系统），售卖 KVM 实例需要支持硬件虚拟化（存在 `/dev/kvm`）。

1. 由开发者将客户端证书与私钥部署到 `server/certs/incus/`，在「系统设置 → 面板证书」确认已加载。在 `server/.env` 中设置 **`PANEL_URL`**（面板对外访问地址，宿主机与支付网关需要能访问到它，如 `https://panel.example.com`），修改环境变量后重启面板。
2. 进入「宿主机 → 添加宿主机」，选择 **一键安装脚本**，填写名称、地区，并选择存储驱动：
   - 块设备留空时创建指定大小的镜像文件；填写 `/dev/sdb` 等块设备时使用整块磁盘（会清空该磁盘）；`dir` 驱动需要填写目录。
   - 按需调整 NAT 网段、公网端口范围、Incus API 端口与 Caddy 管理端口。
3. 以 root 登录宿主机执行面板给出的命令：

   ```bash
   curl -fsSL 'https://panel.example.com/api/agent/nodes/<令牌>/install.sh?lang=zh-CN' | bash
   ```

   脚本会安装 Incus 并完成初始化、信任面板证书、开放 API 端口（若启用 UFW 会自动放行），然后回连面板注册。面板页面会实时显示注册结果。可通过 `INCUS_SOURCE=distro` 环境变量改用发行版自带的 Incus。
4. 在防火墙放行公网端口范围（TCP / UDP），以及 Incus API 端口（仅需对面板开放）。
5. 需要网站绑定或站点反代时，在宿主机详情的「Caddy」中生成 Caddy 安装命令并执行（需 80 / 443 端口空闲）。Caddy 的远程管理端口只接受面板证书，请对面板开放。
6. 售卖独立 IPv4：在宿主机的「IP 地址池」添加地址。
   - **routed**（默认，适合机房路由到宿主机的附加 IP）：上联网卡填写宿主机出口网卡（如 `eth0`），Incus 会自动配置代理 ARP，实例网关为 `169.254.0.1`。安装脚本已开启 `net.ipv4.ip_forward`。
   - **bridged**（适合同一二层网络的 IP）：上联网卡填写宿主机网桥（如 `br0`），添加 IP 时同时填写前缀长度与网关。

> 已有 Incus 的服务器可选择「接入已有 Incus」：在宿主机执行 `incus config trust add paledove` 生成信任令牌并粘贴到面板，面板会自动填写 API 地址并固定服务端证书指纹。

Incus、Caddy 和 Agent 安装脚本与 Incudal 一样，在每次下载时读取 `server/templates/` 中的文件并注入当前参数。仅修改模板内容无需构建或重启；生产部署须包含该目录。重新生成命令会使旧安装令牌失效，已经保存到宿主机的脚本需要重新下载。模板文件、共用 Agent 安装函数与刷新规则见 [安装脚本说明](server/templates/README.md)。

## 站点与注册

在「系统设置 → 站点与注册」可更换站点图标、开关用户注册和邮箱验证、控制新工单提交，以及设置注册赠送余额（0–10000 元，最多两位小数）。图标由服务器下载并保存，支持 PNG / JPG / SVG 等格式，限 512 KB；首页、登录页、控制台和浏览器图标会一起更新。

需要注册邮箱验证时，先在「系统设置 → 邮件」配置并启用 SMTP，可用测试邮件检查当前表单配置。注册后验证链接有效期为 24 小时，只能使用一次；未验证账号不会建立登录会话。无法收信时可重新发送，管理员也可以在用户菜单中验证邮箱。原有账号在升级时保留为已验证，可信邮箱的第三方注册使用同一赠送流程。

邮件配置支持 465 端口的 SSL/TLS 与 587 端口的 STARTTLS。测试邮件会先检查 SMTP 连接，再用当前未保存的表单配置发送；收件邮箱留空时发给当前管理员，测试不会修改已保存的配置。SMTP 密码加密保存，留空沿用原密码。测试邮件和注册验证邮件使用与站点一致的品牌模板，同时提供 HTML 和纯文本内容，并按接收者语言发送。

「系统设置 → 维护模式」支持仅提示、只读和大范围不可用，管理员及邮箱白名单不受限制。可手动开始或结束，也可设置计划开始、结束与提前预告；只读期间允许提交工单。维护状态由前后端共同校验，API 令牌和代登录按实际用户权限执行。维护进展保存后展示给用户，可同步发布公告和邮件通知，公告在预计结束一天后过期。

「系统设置 → 服务条款与隐私」支持 Markdown 编辑和实时预览、站点名称与网址占位符、恢复内置模板。公开阅读页为 `/terms` 和 `/privacy`；开启注册勾选确认后，服务端也检查同意状态，并在注册日志记录同意的版本。内容更新时可选择发布公告及邮件通知。

启用 SMTP 后，登录页提供找回密码入口。重置链接有效期为 30 分钟，只保存令牌哈希且只能使用一次；重置成功会注销已有登录设备。工单提交和用户回复通知管理员，管理员回复通知工单用户。业务邮件适配套餐计费：到期前七天提醒、自动续费余额不足（每个账号每天最多一次）、续费成功、到期暂停、超期释放和流量超额停机。后台检查及任务成功后触发通知，已验证用户可在账号设置中分别关闭公告、余额及业务邮件；SMTP 关闭或发送失败时不会记为已送达。

「工单」提供用户提交、双方回复、关闭和重新打开功能。关闭工单提交只影响新工单，已有工单仍可查看和回复。注册赠送只在创建账号时记入余额和调整流水，不会因验证或重新登录重复赠送。

生产升级执行 `pnpm db:deploy` 应用新增的账号验证和工单表结构，再重启服务；本地 SQLite 同样通过此命令升级。

## 在线充值

在「在线充值 → 支付配置」中启用网关，页面会给出各网关的回调地址：

| 网关 | 需要填写 | 回调 |
| --- | --- | --- |
| Stripe | Secret key、Webhook signing secret | 在 Stripe 后台创建 Webhook，地址为 `/api/pay/stripe/webhook`，订阅 `checkout.session.completed` 与 `checkout.session.async_payment_succeeded` |
| Heleket | Merchant ID、Payment API key | 下单时自动携带 `/api/pay/heleket/webhook` |
| 易支付 | 接口地址、商户 ID、商户密钥、启用的渠道 | 下单时自动携带 `/api/pay/epay/notify`（异步通知）与 `/api/pay/epay/return`（同步跳转） |

- 余额按站点货币记账；每个网关可设置结算货币与汇率（站点货币 1 元 = 多少结算货币），支付金额 = 充值金额 × 汇率。
- 密钥使用 `APP_SECRET` 派生的密钥加密保存，读取时只返回掩码；保存时保留掩码表示不修改。
- 支付结果以网关回调为准，用户返回面板时也会主动向网关查询；回调重复或乱序不会重复入账。管理员可在充值记录中手动确认到账。

## 多语言与外观

- 顶栏可切换语言与明暗（账号设置中还可选择跟随系统），选择保存在浏览器中；登录用户的语言同时保存到账户，用于服务端消息与后台任务记录。
- 颜色全部通过 `web/src/styles.css` 中的语义变量引用，亮 / 暗主题在一处定义；状态色（绿 / 琥珀 / 红）只用于表达状态。
- 前端文案位于 `web/src/i18n/{zh,en}/`，服务端文案位于 `server/src/i18n/`。修改简体中文后执行 `pnpm i18n:tw` 重新生成繁体中文；英文字典由 TypeScript 保证键与简体中文一致。

### 系统镜像

默认镜像来自 `images.linuxcontainers.org` 的 `cloud` 变体（自带 cloud-init，容器与虚拟机均可使用）。内置的 cloud-init 模板会设置 root 密码、写入 SSH 公钥、安装并启用 sshd、允许 root 密码登录。如需自定义，在「系统镜像」中为镜像填写模板，可用占位符：

| 占位符 | 内容 |
| --- | --- |
| `{{hostname}}` | 主机名（已校验，仅包含字母数字与连字符） |
| `{{password}}` | root 密码，以 JSON 字符串形式替换（同时是合法的 YAML） |
| `{{ssh_authorized_keys}}` | SSH 公钥数组（JSON） |
| `{{ssh_package}}` | 发行版对应的 sshd 软件包名 |

## 安全设计

- 会话：随机令牌保存在 HttpOnly + SameSite=Lax Cookie 中，Redis 只保存令牌的 SHA-256；修改密码或禁用账户时注销该用户全部会话
- CSRF：所有写操作要求自定义请求头 `X-Requested-With`，且未开放 CORS
- 密码：用户密码使用 Argon2 哈希；实例 root 密码使用 AES-256-GCM 加密存储，任务完成后清除载荷中的密码；面板客户端证书与私钥由开发者部署到本地文件目录，私钥不通过网页上传或导出
- Incus 连接：TLS 客户端证书认证 + 服务端证书 SHA-256 指纹固定
- 登录、注册、兑换、充值、安装回调接口限流；所有输入经 Zod 校验；cloud-init、安装脚本与 Caddy 配置中的用户输入均经过转义或严格校验
- 安装令牌一次性使用、24 小时过期，数据库仅保存哈希；Caddy 远程管理接口只接受面板客户端证书
- 支付回调逐一验签，并核对订单金额与币种
- 用户只能访问自己的实例；管理员“以用户身份登录”时禁止修改该用户密码，并可随时切回

## 目录结构

```text
server/                  API、Worker 与服务端运行文件
  certs/incus/           开发者部署的客户端证书与私钥
  data/                  本地数据库、附件、缓存与历史备份
  prisma/                数据模型、迁移与初始化数据
  scripts/               服务端构建、数据库工具
    docker/              容器环境校验与健康检查
  src/
    routes/              用户、管理员与 Agent API
    services/            计费、实例操作、安装脚本等业务逻辑
    incus/               Incus HTTP / 模拟客户端与证书读取
    jobs/                队列、Worker 与定时任务
    lib/                 服务端基础设施与工具
    plugins/             Fastify 插件
    i18n/                服务端多语言消息
    shared/              前后端共用类型、枚举与纯函数
  scripts/               构建、数据库、翻译生成与 Docker 工具
  templates/             Incus、Caddy 与 Agent 安装模板
  test/                  服务端与 Docker 脚本测试
web/                     前端应用
  public/                公开静态资源与 logo
  src/
    components/          公共 UI、图表与业务组件
    layouts/             控制台布局、通知与任务入口
    i18n/                前端多语言字典
    lib/                 API、路由加载与工具
    hooks/               共用 hooks
    shared/              共用代码入口，引用 server/src/shared
    pages/
      Home.tsx           首页
      Legal.tsx          公开文档阅读页
      auth/              登录、找回密码与邮箱验证
      console/           用户控制台（account/、billing/ 等）
      admin/             按功能归组的管理后台
      documents/         文档中心
      instance/          共用实例详情
      market/            交易市场
      tickets/           工单
agent/                   Go 宿主机 Agent（cmd/、internal/）
  scripts/build.mjs      双架构构建与 Release 打包工具
docs/                    项目结构、部署文档与截图
Dockerfile               面板镜像构建
docker-compose.yml       仅面板服务，连接外部数据库与 Redis
docker-entrypoint.sh     Docker 启动、迁移与初始化入口
```

目录职责、脚本用途与运行数据说明见 [项目目录说明](docs/PROJECT_STRUCTURE.md)。

## 常用命令

```bash
pnpm dev            # 同时启动前后端开发服务器
pnpm build          # 构建前端与后端，无需 Go
pnpm build:agent    # 单独构建宿主机 Agent，需要 Go 1.22+
pnpm build:agent:release # 构建 GitHub Release 资产与校验清单
pnpm typecheck      # 全部包类型检查
pnpm test           # 运行测试
pnpm test:docker    # 检查容器环境校验与健康检查脚本
pnpm test:startup   # 检查首次启动构建与 SQLite 构建兼容
pnpm db:generate    # 生成 PostgreSQL / SQLite 客户端
pnpm db:migrate     # 开发环境：根据 schema 生成迁移
pnpm db:deploy      # 生产环境：执行迁移
pnpm db:seed        # 初始化管理员与默认镜像
pnpm i18n:tw        # 由简体中文生成繁体中文文案
```

## 拨测设置

管理员侧边栏「拨测设置」可管理拨测目标和宿主机对象。目标支持自定义 IPv4 / 域名、TCP 回退端口、省份、运营商及名称，可新增、编辑、删除和单独启停；默认保留 93 个国内三网目标。拨测对象从现有宿主机中添加，可单独启停、查看结果和立即测试，移除对象不会删除宿主机。

定时拨测总开关控制宿主机 Agent 的节点测试，可设置 10～1440 分钟的间隔及每个目标 1～10 次探测。设置通过下一次心跳下发，无需重新安装 Agent。交易市场上架拨测使用同一目标列表；切换机房前的即时 IPv4 检测保持独立，二者仍按业务触发。历史结果保存当时的目标信息，不受后续删除或修改影响。

## 交易市场

默认关闭，管理员在「系统设置 → 交易市场」开启后，首页导航与用户控制台出现「交易市场」。

- **挂牌**：实例须处于运行中或已关机，且距到期不少于「最短剩余天数」（默认 3 天）；挂牌价由卖家决定。挂牌期间卖家不能转移、删除、重装或重置密码，撤销或成交后恢复；管理员下架、实例被删除时挂牌自动结束。
- **成交**：买家余额支付，卖家收到挂牌价减去成交手续费（默认 5%，买家不另付）；实例经「实例转移」转入买家账户并关闭自动续费，转移费不再收取。成交后一律用实例原来的系统镜像**全新安装**，系统内数据全部清空，没有记录镜像的实例不能挂牌。过户失败时自动退款并回滚。
- **定向出售**：填写用户名或邮箱后，只有该用户和卖家能看到并购买。
- **成交价走势**：按同一套餐统计近 30 天的成交价，可分别查看公开交易与定向成交；公开页不显示买卖双方，卖家用户名做部分隐藏。
- **上架前拨测快照**：上架时由实例所在宿主机的 Agent（0.7.0 起，能力 `listing-ping`）从实例对外的 IPv4 向「拨测设置」中启用的目标测试（默认 93 个国内三网目标、各 Ping 4 次），结果存档在商品上，商品卡片显示 IP 状态、拨测时间与三网最快，点击查看中国地图、三网概览与节点列表；卖家（我的上架）、买家（我的购买）与管理员都能查看。
  - 测的就是买家拿到的 IP：LXC / KVM NAT 绑定宿主机公网 IPv4 发送（地址不在网卡上时走默认出口）；独立 IPv4 以实例地址为源构造 ICMP 请求并在宿主机网卡上抓回复（AF_PACKET），bridged 网卡还以实例 MAC 从网桥的物理网卡发出，实例内无需任何软件。
  - 独立 IPv4 需要实例运行才能测（上游只把地址路由到运行中的实例）：已关机的先开机，测完与挂牌一样关机。
  - 判定：全部可达为「IP 正常」；超过 5 个省份（任一运营商）无法 Ping 通为「IP 异常」；其余为「部分超时」。Agent 不在线 / 版本过旧、超时（约 4 分钟）或没有 IPv4 时记为「未拨测」。
  - **拨测完成才上架**：提交后商品先不公开（市场里看不到、不能购买，卖家看到「拨测中」）；拨测完成（无论结论）后自动公开。拨测未完成的商品保持不公开，卖家可在「我的上架」重新拨测或撤销。
- 本期没有合作伙伴与 AI 网关板块。

## 当前限制

- 暂未提供网页 VNC / 控制台
- NAT 实例的 IPv6 由网桥自动分配并在面板中展示，暂不支持按实例分配独立 IPv6 段
- 流量统计依赖 Incus 上报的网卡计数器；KVM 实例在 incus-agent 未运行时，重置密码等需要在虚拟机内执行命令的操作不可用

<p align="center">
  <img src="web/public/logo.png" width="88" alt="PaleDove" />
</p>

<h1 align="center">PaleDove</h1>

<p align="center">基于 Incus 的 IDC 云服务器售卖面板</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-10-orange.svg" alt="pnpm" />
  <img src="https://img.shields.io/badge/Go-1.22-00ADD8.svg" alt="Go" />
  <img src="https://img.shields.io/badge/Incus-REST%20API-73ba25.svg" alt="Incus" />
</p>

---

## 目录

- [项目简介](#项目简介)
- [功能特性](#功能特性)
- [界面预览](#界面预览)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [安装与使用](#安装与使用)
- [配置说明](#配置说明)
- [部署](#部署)
- [项目结构](#项目结构)
- [开发指南](#开发指南)
- [常见问题](#常见问题)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

## 项目简介

PaleDove 是一套面向 **IDC / 云服务商**的实例售卖与管理面板。后端通过 [Incus](https://linuxcontainers.org/incus/) REST API 管理宿主机，把一台台物理服务器变成可售卖的云主机，并打通「上架 → 下单 → 开通 → 计费 → 续费 → 到期回收」的完整链路。

支持售卖三类实例：

| 类型 | 说明 | 适用场景 |
| --- | --- | --- |
| **LXC NAT** | 容器实例，共享宿主机公网 IPv4，通过端口映射对外提供服务 | 轻量应用、建站、开发测试 |
| **KVM NAT** | 虚拟机实例，同样走 NAT + 端口映射，资源隔离更彻底 | 需要独立内核或完整虚拟化 |
| **KVM 独立 IPv4** | 虚拟机绑定独立公网 IPv4（`routed` 代理 ARP 或 `bridged` 桥接） | 需要独占 IP 的业务 |

管理后台与用户后台**共用同一个登录入口**，登录后按角色自动进入对应后台。管理员只能访问管理后台，购买实例、充值和个人实例等控制台功能仅对普通用户开放；管理员仍可在后台管理全部实例、处理工单，并通过「以用户身份登录」排查问题（代登录期间禁止修改该用户密码，可随时切回）。

## 功能特性

### 界面与交互

- 白底黑色强调的简约控制台：顶栏（侧边栏收起、控制台 / 费用中心 / 管理后台、全局搜索 `Ctrl / ⌘ + K`、明暗切换、语言、公告通知、余额、账户菜单）+ 分组侧边栏（可收起为图标栏）
- 全局搜索可跳转到任意页面、快捷操作与实例（按名称 / 主机名 / IP 匹配）；公告在顶栏铃铛中查看，有新公告时显示红点
- 简体中文、繁體中文、English 三种语言，浅色 / 深色（可在账号设置中选择跟随系统）；语言偏好同步到账户，服务端错误信息与通知同样按语言返回
- 手机端适配：侧边栏变为抽屉，表格自动切换为卡片列表，对话框变为底部弹出层，标签栏可横向滑动

### 用户后台

- **概览**：余额、本月消费、运行中实例、我的实例列表与常用入口
- **购买实例**：分步选择实例类型、套餐、地区与付款周期（月、季、半年、年）、系统镜像与登录凭据，右侧实时显示配置摘要与应付金额，余额支付后自动开通
- **实例操作**：开机、关机、重启、强制关机、重装系统（可设置密码与 SSH 公钥）、重置 root 密码、修改主机名、删除
- **网页控制台**：实例详情内提供串口控制台与 KVM VNC 图形控制台，可查看启动画面并操作系统恢复环境；不依赖虚拟机内的 incus-agent，现有网页 Shell 在 Agent 不可用时自动切换至串口登录
- **IPv6**：支持独立地址及按实例分配独占路由网段（例如 `/64`），实例详情展示主地址与网段；迁移、切换机房及回滚同步处理分配
- **资源占用**：CPU、内存、硬盘、进程数实时数据；CPU / 内存 / 网络速率历史曲线（1 / 6 / 24 小时）与 30 天每日流量
- **流量周期**：按购买日为锚点按月重置，支持单向出站 / 单向入站 / 双向合计 / 双向取大四种计费方式，超额后限速或停机，周期重置后自动恢复
- **端口映射**（NAT 实例）：自助添加 TCP / UDP / TCP+UDP 转发，公网端口可指定或自动分配，SSH 端口自动映射；侧边栏「端口映射」集中管理所有实例的规则
- **网站绑定**（NAT 实例）：域名经宿主机上的 Caddy 反向代理到实例端口，自动申请 HTTPS 证书，可选校验域名解析；可在实例详情或「网站绑定」页统一管理
- **快照**：创建、恢复、删除，按套餐限制数量；「快照」页汇总全部实例的快照
- **操作日志**：全部实例的开机、关机、重装、快照等任务记录
- **在线充值**：Stripe（银行卡等）、Heleket（加密货币）、易支付（支付宝 / 微信 / QQ 钱包），支付完成后自动返回并显示到账结果
- **费用中心**：余额、本月消费 / 充值、累计充值，充值对话框（金额档位 + 支付方式）、兑换码充值，余额明细、订单与充值记录；续费（支持多周期）与自动续费
- **交易市场**：把自己的实例挂牌出售（公开或定向给指定用户，成交后一律用原镜像全新安装再交给买家），买家用余额购买后实例立即转入其账户；卡片显示配置、流量、续费价格与到期时间，并提供同套餐近 30 天的成交价走势；游客可在首页直接浏览，登录后购买
- **API 令牌**：在「账号设置 → API 令牌」创建（只读或完整权限，可设有效期），用 `Authorization: Bearer pd_…` 调用控制台接口，接口文档在 `/console/docs/api`；只读令牌只能查询，且不能打开终端或查看实例密码；任何令牌都不能访问登录、令牌管理与实名认证等账号安全接口；找回密码后全部令牌自动吊销

### 管理后台

- **管理总览**：用户、运行中实例、本月收入、在线宿主机指标条；各宿主机 CPU / 内存 / 硬盘的分配情况；「待处理」汇总离线宿主机、异常实例、失败任务与未生效的网站绑定；30 天收入图与最近订单
- **宿主机**：后台填写名称、地区与存储池参数后生成一键安装脚本，在宿主机上执行即可自动安装 Incus、创建存储池与 NAT 网桥、信任面板证书并回连注册，无需在面板中填写 SSH 信息；也支持接入已有 Incus（信任令牌）
- **存储池**：通过 Incus API 查看、创建（zfs / btrfs / lvm / dir，块设备或镜像文件）、删除、设为默认；套餐可指定存储池
- **Caddy 网关**：为宿主机生成 Caddy 安装脚本，面板通过仅允许面板证书访问的远程管理 API（mTLS）下发配置
- **站点反代**：在后台把任意域名反向代理到内网或外部服务（HTTP / HTTPS 上游，自动证书），并统一查看、删除用户的网站绑定
- **在线充值**：配置各支付网关（密钥加密保存、显示掩码、汇率与结算货币、回调地址），查看充值记录并可手动确认到账
- **IP 地址池**：按宿主机批量添加独立 IPv4（单个 / CIDR / 区间），支持 routed 与 bridged 两种网卡模式
- **套餐**：规格、带宽、流量与计费方式、超额策略、端口 / 建站 / 快照配额、存储池、各周期价格、库存、可售宿主机
- **系统镜像**：任意 simplestreams / incus / oci 镜像源，可为单个镜像自定义 cloud-init 模板；宿主机架构由 Agent / Incus 检测后持久保存，离线时订购页仍按已知架构和节点镜像设置筛选，节点保留展示并标记缺货
- **实例管理**：检索筛选全部实例，调整规格（自动下发到宿主机）、到期时间、价格，暂停 / 解除暂停、重置流量、重试创建、删除（可退款）
- **用户**：创建、编辑、禁用、充值 / 调整余额、以该用户身份登录排查问题
- **交易市场**：查看全部挂牌、按状态筛选与搜索，下架违规商品（卖家收到通知）；在「系统设置 → 交易市场」开启并设置成交手续费与最短剩余天数
- **运营**：订单与财务、兑换码批量生成、公告、任务队列与操作审计日志、系统设置

### 平台与运维能力

- **宿主机 Agent**（Go 编写，独立发布）：上报宿主机状态、下发 VM CPU 限制、自动升级、执行节点拨测、上报实例资源、应用智能路由出口；面板按 Agent 上报的能力决定可用功能
- **拨测设置**：管理拨测目标（IPv4 / 域名、TCP 回退端口、省份、运营商）与宿主机对象，默认保留 93 个国内三网目标；定时拨测总开关、间隔（10～1440 分钟）与每目标探测次数通过心跳下发，无需重装 Agent
- **站点与注册**：站点图标、注册开关、邮箱验证、注册赠送余额；SMTP 支持 465 SSL/TLS 与 587 STARTTLS，测试邮件不会修改已保存配置
- **维护模式**：仅提示 / 只读 / 大范围不可用三档，管理员与邮箱白名单不受限制，可定时开始结束并提前预告；状态由前后端共同校验
- **服务条款与隐私**：Markdown 编辑与实时预览、站点名称与网址占位符、恢复内置模板，内容更新可同步发布公告与邮件通知
- **工单**：分类、优先级、关联实例、附件与邮件通知；用户与管理员双向回复，关闭后可重新打开
- **多语言**：前端字典以简体中文为源，`pnpm i18n:tw` 通过 OpenCC 与术语表生成繁体；服务端按请求头 > 账户偏好 > `Accept-Language` 选择语言

## 界面预览

| 用户后台 | 管理后台 |
| --- | --- |
| ![概览](docs/screenshots/user-dashboard.png) | ![管理总览](docs/screenshots/admin-dashboard.png) |
| ![实例列表](docs/screenshots/user-instances.png) | ![添加宿主机（一键安装脚本）](docs/screenshots/admin-add-host.png) |
| ![实例详情](docs/screenshots/instance-detail.png) | ![实例详情（深色）](docs/screenshots/instance-detail-dark.png) |
| ![网页控制台](docs/screenshots/instance-console.png) | ![资源监控（深色）](docs/screenshots/instance-monitor-dark.png) |
| ![购买实例](docs/screenshots/user-deploy.png) | ![存储池（繁體中文）](docs/screenshots/admin-host-zh-tw.png) |
| ![充值（English）](docs/screenshots/user-recharge-en.png) | ![登录页](docs/screenshots/login.png) |

<p align="center">
  <img src="docs/screenshots/mobile-instances.png" width="260" alt="手机端实例列表" />
  <img src="docs/screenshots/mobile-detail-dark.png" width="260" alt="手机端实例详情（深色）" />
</p>

## 技术栈

| 层次 | 技术选型 |
| --- | --- |
| 前端 | React 19 · TypeScript · Rsbuild · Base UI · Tailwind CSS v4 · TanStack Query · React Router 7 · Recharts · xterm.js · noVNC |
| 后端 | Fastify 5 · Prisma 7 · PostgreSQL / SQLite · Redis（ioredis）· BullMQ · Zod |
| 宿主机 Agent | Go 1.22（仅标准库，交叉编译 linux/amd64 与 linux/arm64） |
| 虚拟化 | Incus REST API（TLS 客户端证书 + 服务端 SHA-256 指纹固定） |
| 运行时 | Node.js ≥ 22.12 · pnpm 10 |
| 部署 | Docker（多阶段构建）· Docker Compose · systemd |

架构：

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

## 快速开始

环境要求：**Node.js ≥ 22.12**、**pnpm 10**。默认使用 SQLite、内存缓存与模拟节点，**无需安装 PostgreSQL / Redis，也不需要有 Incus 宿主机**。

```bash
# 1. 安装依赖
pnpm install

# 2. 本地配置：后端读取 server/.env
cp server/.env.example server/.env
#   默认 NODE_ENV=development、SQLite、memory://、SEED_DEMO=true
#   建议修改 APP_SECRET 和 ADMIN_PASSWORD

# 3. 初始化本地数据库
pnpm db:migrate
pnpm db:seed

# 4. 启动（后端 :3000，前端 :5180，/api 含 WebSocket 代理到后端）
pnpm dev
```

打开 <http://127.0.0.1:5180/login>：

| 角色 | 账号 | 密码 |
| --- | --- | --- |
| 管理员 | `admin` | `ADMIN_PASSWORD`（本地示例默认 `Admin@123456`） |
| 演示用户（仅 `SEED_DEMO=true`） | `demo` | `demo123456` |

也可以像参考项目一样分别运行 `pnpm dev:server`、`pnpm dev:web`。只想体验时，在初始化后执行 `pnpm start`：缺少构建产物时自动构建前后端，由后端直接提供页面，访问 <http://127.0.0.1:3000/login>。构建产物已存在时直接复用，修改源码后执行 `pnpm build` 更新。只用前端热更新时可在 `server/.env` 设置 `SKIP_WEB_BUILD=1`，跳过页面构建检查。

> **模拟节点**：在「接入已有 Incus」中把 API 地址填写为 `mock://任意名称` 即为模拟节点。实例状态保存在 Redis 中，资源占用与流量为随机数据，可在没有 Incus 宿主机的情况下体验完整流程。**切勿用于生产。**

## 安装与使用

### 添加宿主机

宿主机需为 **Debian 12 / 13** 或 **Ubuntu 22.04 / 24.04**（建议全新系统），售卖 KVM 实例需要支持硬件虚拟化（存在 `/dev/kvm`）。

1. 由开发者将客户端证书与私钥部署到 `server/certs/incus/`，在「系统设置 → 面板证书」确认已加载。在 `server/.env` 中设置 **`PANEL_URL`**（宿主机与支付网关需要能访问到它），修改环境变量后重启面板。
2. 进入「宿主机 → 添加宿主机」，选择**一键安装脚本**，填写名称、地区，并选择存储驱动：
   - 块设备留空时创建指定大小的镜像文件；填写 `/dev/sdb` 等块设备时使用整块磁盘（**会清空该磁盘**）；`dir` 驱动需要填写目录。
   - 按需调整 NAT 网段、公网端口范围、Incus API 端口与 Caddy 管理端口。
3. 以 root 登录宿主机执行面板给出的命令：

   ```bash
   curl -fsSL 'https://panel.example.com/api/agent/nodes/<令牌>/install.sh?lang=zh-CN' | bash
   ```

   脚本显示终端交互菜单，可选择 **ZFS / Btrfs / LVM thin / 目录**、存储来源与容量，以及是否安装 Agent、RFW 和启用规则。RFW 可逐项选择邮件、HTTP、SOCKS5、全加密流量、WireGuard、QUIC 或所有入站过滤，并配置 GeoIP 黑白名单、端口日志和网卡，下载源与规则参数沿用 Incudal。面板中的选项作为菜单默认值；已有同名存储池会复用，使用新块设备时会检查占用并要求输入清空确认。

   确认后安装 Incus、初始化存储与网络、信任证书，然后回连面板同步实际配置。启用防火墙规则时会为已开启的 UFW 配置 Incus 网络放行。默认使用 `whiptail` 菜单，不可用时回退文本菜单；命令末尾改为 `| bash -s -- --text` 可强制文本模式，改为 `| bash -s -- --yes` 可使用预设无人值守安装（无终端时必须显式指定）。无人值守创建块设备池还须通过 `env PALEDOVE_ERASE_DEVICE=/dev/sdb bash -s -- --yes` 指定可清空的设备。可通过 `INCUS_SOURCE=distro` 改用发行版自带的 Incus。
4. 在防火墙放行公网端口范围（TCP / UDP），以及 Incus API 端口（仅需对面板开放）。
5. 需要网站绑定或站点反代时，在宿主机详情的「Caddy」中生成 Caddy 安装命令并执行（需 80 / 443 端口空闲）。Caddy 的远程管理端口只接受面板证书，请对面板开放。
   - 脚本会保留当前站点配置、强制刷新远程管理配置，并等待证书链校验通过后注册；注册失败会显示原因并保留有效令牌供重试。出现 `certificate has expired` 时，先校准面板与宿主机的系统时间，再重新生成并执行安装命令；若仍失败，按脚本输出检查证书有效期及 Caddy 服务日志。
6. 售卖独立 IPv4：在宿主机的「IP 地址池」添加地址。
   - **routed**（默认，适合机房路由到宿主机的附加 IP）：上联网卡填写宿主机出口网卡（如 `eth0`），Incus 会自动配置代理 ARP，实例网关为 `169.254.0.1`。安装脚本已开启 `net.ipv4.ip_forward`。
   - **bridged**（适合同一二层网络的 IP）：上联网卡填写宿主机网桥（如 `br0`），添加 IP 时同时填写前缀长度与网关。

> 已有 Incus 的服务器可选择「接入已有 Incus」：在宿主机执行 `incus config trust add paledove` 生成信任令牌并粘贴到面板，面板会自动填写 API 地址并固定服务端证书指纹。

安装脚本在每次下载时读取 `server/templates/` 中的文件并注入当前参数。仅修改模板内容无需构建或重启；生产部署须包含该目录。重新生成命令会使旧安装令牌失效，已保存到宿主机的脚本需要重新下载。

脚本主菜单还支持**卸载 RFW、卸载 Agent、彻底卸载 Incus 节点**，也可分别通过 `--uninstall-rfw`、`--uninstall-agent`、`--uninstall` 进入确认界面。整机卸载会删除本机所有 Incus 项目的实例、镜像、快照、卷、网络与存储池，并清理 Incus / Agent / RFW 和安装配置，需要二次确认及输入大写 `YES`；`--yes` 不能跳过删除确认。请先在后台停用节点并备份数据，脚本不会删除面板数据库记录。集群节点或资源、挂载未清理干净时停止卸载；Caddy、UFW 既有规则和通用存储工具保留。

安装后可在宿主机执行 `sudo paledove-node` 打开本地卸载菜单。该命令不含面板令牌和证书，安装令牌失效或面板离线时也能使用。已有宿主机若没有该命令，先从面板下载新版安装脚本即可选择卸载。

### 售卖流程

1. 「套餐」中创建规格、流量与计费方式、各周期价格，并选择可售宿主机与存储池。
2. 「系统镜像」中确认镜像源（默认来自 `images.linuxcontainers.org` 的 `cloud` 变体，自带 cloud-init）。
3. 用户在「购买实例」中选择类型 → 套餐 → 地区 → 周期 → 镜像与凭据，余额支付后自动开通。
4. 用户自助完成端口映射、域名绑定、快照、重装、续费；到期由定时任务暂停、宽限期后删除，流量超额按套餐策略限速或停机。

### 调用 API

在「账号设置 → API 令牌」创建令牌后：

```bash
curl -H "Authorization: Bearer pd_xxxxxxxx" \
     -H "x-requested-with: XMLHttpRequest" \
     https://panel.example.com/api/instances
```

完整接口文档位于面板的 `/console/docs/api`。用户控制台页面统一使用 `/console/` 前缀，例如 `/console/dashboard`、`/console/instances`、`/console/billing`、`/console/invoices` 与 `/console/marketplace`。旧控制台页面地址会自动跳转并保留查询参数与锚点。

## 配置说明

本地开发读取 `server/.env`（示例见 `server/.env.example`）；Docker 与 Compose 读取项目根目录 `.env`（示例见根目录 `.env.example`）。两处互不覆盖。

### 关键变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/dev.db` | 数据库连接串。`file:` 开头切换为 SQLite，`postgresql://` 使用 PostgreSQL |
| `REDIS_URL` | `memory://` | `memory://` 为进程内存储与任务队列（单进程）；生产填写 `redis://…` |
| `APP_SECRET` | — | **必填**，用 `openssl rand -hex 32` 生成。**部署后不可更改** |
| `PANEL_URL` | `http://127.0.0.1:5180` | 面板对外地址，安装脚本回连与支付回调依赖它 |
| `HOST` / `PORT` | `0.0.0.0` / `3000` | 后端监听地址与端口 |
| `NODE_ENV` | `development` | 设为 `production` 启用生产行为（含 Cookie 默认 Secure） |
| `LOG_LEVEL` | `info` | 日志级别 |
| `LOG_FORMAT` | `pretty` | 简洁排版与终端颜色；设为 `json` 输出结构化日志，供日志采集系统使用 |
| `LOG_REQUESTS` | `true` | 每次请求只记录一条结果；设为 `false` 仅保留失败请求。健康检查、Agent 心跳、指标轮询等成功请求使用 `debug` 级别 |
| `TRUST_PROXY` | `false` | 位于 Nginx / Caddy 之后时设为 `true`，以获取真实客户端 IP |
| `COOKIE_SECURE` | production 默认 `true` | Cookie 仅通过 HTTPS 发送 |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（小时） |
| `WEB_DIST` | `../web/dist` | 前端构建产物目录，由后端直接托管 |
| `UPLOAD_DIR` | `data/uploads` | 工单附件目录；多 API 进程须共享 |
| `INCUS_CERT_DIR` | `certs/incus` | Incus 客户端证书目录，相对路径以 `server` 为基准 |
| `RUN_API` / `RUN_WORKER` | `true` / `true` | 本进程是否提供 API / 是否运行任务 Worker |
| `WORKER_CONCURRENCY` | `4` | Worker 并发数 |
| `METRICS_INTERVAL_SEC` | `60` | 资源与流量采集间隔（秒） |
| `AGENT_RELEASE_REPOSITORY` | 空 | Agent 下载源，格式 `owner/repo`；留空使用本地 `agent/dist/` |
| `AGENT_RELEASE_TOKEN` | 空 | 私有仓库或提高 GitHub API 配额时填写，不下发宿主机 |
| `AGENT_RELEASE_CACHE_DIR` | 系统临时目录 | Agent 下载缓存目录，建议容器部署时使用可写挂载 |
| `AGENT_DIST` | `../agent/dist` | 未配置 Release 仓库时的本地 Agent 目录 |
| `DB_MIGRATE` | `true`（容器） | 容器启动时是否自动执行增量迁移 |
| `ADMIN_USERNAME` / `ADMIN_EMAIL` / `ADMIN_PASSWORD` | `admin` / `admin@example.com` / `Admin@123456` | 仅在数据库没有任何管理员时用于创建账号 |
| `SEED_DEMO` | 开发 `true`，生产 `false` | 是否创建模拟节点、示例套餐与演示用户 |
| `SKIP_WEB_BUILD` | 未设置 | 设为 `1` 时跳过缺失 `web/dist` 的自动构建 |

> **`APP_SECRET` 部署后不可更改**：实例 root 密码、支付网关密钥等数据由它派生的密钥加密（AES-256-GCM）。更换后这些数据将无法解密。备份与迁移必须沿用原值。

### Incus 客户端证书

面板访问 Incus 与宿主机 Caddy 的客户端证书统一从本地文件读取，**系统不会自动生成，也不会存入数据库**：

```text
server/certs/incus/
  client.crt     # PEM 格式的 X.509 客户端证书
  client.key     # 与证书匹配的未加密 PEM 私钥（建议权限 600）
```

- 证书须在有效期内、与私钥匹配；声明扩展密钥用途时须包含 `clientAuth`。
- 缺失或无效时仍可进入后台，真实节点操作会报告证书配置错误；`mock://` 节点无需证书。
- 替换文件后各进程会自动使用新证书，但需先让宿主机信任新证书；替换期间建议暂停节点操作。
- 「系统设置 → 面板证书」显示实际路径、加载状态、指纹与有效期，支持重新读取与下载公钥证书。

### 数据库

- **开发**：默认 SQLite，表结构由 `server/scripts/sqlite-schema.mjs` 从 PostgreSQL 模型自动派生，**不要手工编辑派生文件**。
- **生产**：PostgreSQL，`pnpm db:deploy` 应用 `server/prisma/migrations/` 中的增量迁移。
- 代码需同时兼容两种数据库：使用 `lib/prisma.ts` 提供的 `containsInsensitive()` / `skipDuplicates`，而不是 `mode: 'insensitive'` 或 Prisma 原生选项。

### 数据备份

以下内容需要单独备份并随服务整体迁移，清理构建产物时务必保留：

| 路径 | 内容 |
| --- | --- |
| 数据库 | PostgreSQL 全库，或 `server/data/dev.db` |
| `server/data/uploads/` | 工单附件（可由 `UPLOAD_DIR` 指定） |
| `server/data/backups/` | 历史数据库快照，与运行数据分开存放，不会自动恢复 |
| `server/certs/incus/` | 客户端证书与私钥 |
| `server/.env` / 根目录 `.env` | 配置与密钥，`APP_SECRET` 必须沿用原值 |

## 部署

### Docker Compose（推荐）

`docker-compose.yml` **只部署面板**，不包含 PostgreSQL 或 Redis 容器，通过环境变量连接已有的外部服务。要求 Docker Compose 2.30+。

```bash
cp .env.example .env
# 编辑 DATABASE_URL、REDIS_URL、APP_SECRET、PANEL_URL 与 ADMIN_PASSWORD
# 开发者准备并上传 server/certs/incus/client.crt 与 client.key
docker compose up -d --build panel
```

- 默认映射 `127.0.0.1:3000`，由宿主机 Caddy / Nginx 提供 HTTPS。
- 附件与 Agent Release 缓存保存在 `panel-data` 命名卷，证书只读挂载。
- 启动时自动应用增量迁移，**仅在数据库没有管理员时**按环境变量创建账号；已有任管理员则跳过，即使 `.env` 中的用户名、邮箱或密码不同也保留原账号。
- 常用镜像可用 `docker compose run --rm panel init` 预置。

完整说明见 [Docker 部署文档](docs/DOCKER.md)。

### 直接运行 Node.js

```bash
git clone <repo> /opt/paledove && cd /opt/paledove
pnpm install --frozen-lockfile
cp .env.example server/.env   # 使用生产示例，填写外部 DATABASE_URL / REDIS_URL / APP_SECRET 等
pnpm build                    # 构建前端与后端（server/dist/index.js），无需 Go
pnpm db:deploy && pnpm db:seed
```

用 systemd 运行 `node dist/index.js`，后端会直接托管 `web/dist` 中的页面：

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
TimeoutStopSec=60
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

在前方放置 Caddy / Nginx 提供 HTTPS，并设置 `TRUST_PROXY=true`：

```
panel.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
```

默认一个进程同时运行 API 与 Worker；需要水平扩展 API 时，可额外启动 `RUN_WORKER=false` 的 API 进程，Worker（`RUN_WORKER=true`）建议只运行一个。

### 升级

```bash
git pull && pnpm install && pnpm build && pnpm db:deploy
# 然后重启服务
```

Docker 部署执行 `docker compose up -d --build panel`，容器启动时自动迁移。**升级必须沿用原 `APP_SECRET`。**

### 宿主机 Agent 发布

宿主机 Agent 与面板独立发布。正式部署设置 `AGENT_RELEASE_REPOSITORY=owner/repo`，面板从本项目的 GitHub `agent-v*` Release 查询版本并代理下载，宿主机只访问面板；内存与可选磁盘缓存减少重复下载，GitHub 暂时不可用时可使用 24 小时内的已校验缓存，心跳不等待外部网络。

未设置 Release 仓库时使用本地开发模式：`pnpm build:agent` 生成 `agent/dist/`（linux/amd64 与 linux/arm64），也可通过 `AGENT_DIST` 指定目录。已配置 Release 仓库时不会自动切回本地旧版本。发布步骤、私有仓库与缓存配置见 [Agent 发布与下载](docs/AGENT_RELEASE.md)。

## 项目结构

```text
idcpanel/
├── server/                 API、Worker 与服务端运行文件
│   ├── certs/incus/        开发者部署的客户端证书与私钥
│   ├── data/               本地数据库、附件、缓存与历史备份
│   ├── prisma/             数据模型、迁移与初始化数据
│   ├── scripts/            构建、数据库与翻译工具（docker/ 为容器校验）
│   ├── src/
│   │   ├── routes/         用户、管理员与 Agent API
│   │   ├── services/       计费、实例操作、支付、安装脚本等业务逻辑
│   │   ├── incus/          Incus HTTP / 模拟客户端与证书读取
│   │   ├── jobs/           队列、Worker 与定时任务
│   │   ├── lib/            服务端基础设施与工具
│   │   ├── plugins/        Fastify 插件
│   │   ├── i18n/           服务端多语言消息
│   │   └── shared/         前后端共用类型、枚举与纯函数
│   ├── templates/          Incus、Caddy、Agent 安装模板（每次下载重新读取）
│   └── test/               服务端与 Docker 脚本测试
├── web/                    React 前端
│   ├── public/             公开静态资源与 logo
│   └── src/
│       ├── components/     公共 UI、图表与业务组件
│       ├── layouts/        控制台布局、通知与任务入口
│       ├── i18n/           前端多语言字典
│       ├── lib/            API、路由加载与工具
│       ├── hooks/          共用 hooks
│       ├── shared/         共用代码入口，引用 server/src/shared
│       └── pages/
│           ├── Home.tsx    首页
│           ├── Legal.tsx   公开文档阅读页
│           ├── auth/       登录、找回密码与邮箱验证
│           ├── console/    用户控制台（account/、billing/）
│           ├── admin/      管理后台（nodes/、instances/、catalog/、billing/、settings/）
│           ├── documents/  文档中心
│           ├── instance/   用户与管理员共用的实例详情
│           ├── market/     交易市场
│           └── tickets/    工单
├── agent/                  Go 宿主机 Agent
│   ├── cmd/paledove-agent/ 程序入口
│   ├── internal/           按功能拆分的实现（traffic/、guestexec/ 等）
│   └── scripts/            双架构构建与 Release 打包
├── docs/                   部署文档、结构说明与截图
├── .github/workflows/      Agent 发布流程
├── Dockerfile              面板镜像构建
├── docker-compose.yml      仅面板服务，连接外部数据库与 Redis
├── docker-entrypoint.sh    Docker 启动、迁移与初始化入口
└── .env.example            根目录生产 / Docker 配置示例
```

`server/src/shared` 是前后端**唯一共享源**（DTO、枚举、枚举标签与浏览器兼容的纯函数），前端通过 `web/src/shared/index.ts` 引用同一份源码，不做独立 workspace 包。该目录不能引入数据库、配置、密钥或 Node.js 专用模块。

目录职责、脚本用途与运行数据的详细说明见 [项目目录说明](docs/PROJECT_STRUCTURE.md)。

## 开发指南

### 常用命令

```bash
pnpm dev                 # server（tsx watch）+ web（rsbuild :5180）
pnpm typecheck           # 全部包 tsc --noEmit，主要正确性门禁
pnpm test                # server 下的 vitest（web 暂无测试）
pnpm build               # 先 web 后 server（esbuild → server/dist/index.js）
pnpm start               # 构建缺失产物后由后端统一托管页面与 API
pnpm db:migrate          # 开发：PG → prisma migrate dev；SQLite → 重新生成 schema 后 db push
pnpm db:deploy           # 生产：prisma migrate deploy
pnpm db:seed             # 初始化管理员与默认镜像（SEED_DEMO=true 追加模拟数据）
pnpm i18n:tw             # 由简体中文生成前后端繁体字典
pnpm build:agent         # 构建宿主机 Agent（需要 Go 1.22+）
pnpm build:agent:release # 构建 GitHub Release 资产与校验清单
pnpm test:agent          # Go Agent 测试
pnpm test:docker         # 容器环境校验与健康检查脚本
pnpm test:startup        # Node.js 启动构建检查
```

单个测试文件或按名称筛选：

```bash
cd server && npx vitest run test/payments.test.ts
cd server && npx vitest run -t "fee"
```

### 修改数据模型

1. 编辑 `server/prisma/schema.prisma`（PostgreSQL 为唯一源）。
2. 手写 PostgreSQL 迁移到 `prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql`。在 SQLite 下开发时 `db:migrate` 只执行 `db push`，**不会**替你生成该文件。
3. 运行 `pnpm db:migrate`，它会为两套客户端生成代码（`src/generated/prisma` 与 `src/generated/prisma-sqlite`）。

新增字段可直接推送；**任何会删除或修改数据的上线操作必须先取得明确确认**。

### 代码约定

- 注释与界面文案使用中文；沿用现有注释密度与命名风格。
- 页面按 `pages/` 下的公开页、用户后台、管理后台、共享业务分组；新增页面要同时修改 `App.tsx` 与 `lib/routes.ts` 的 `loaders`（侧边栏也依赖它预加载）。
- 多页面复用的 UI 放在 `components/` 对应功能目录，不要从其他路由页面导入。
- 表单选项优先使用带 `description` 的下拉 `Select`，而不是一排单选卡片。
- 颜色只引用 `web/src/styles.css` 中的语义令牌（如 `text-fg`、`bg-surface-2`、`border-line`），状态色仅用于表达状态。
- 新增或调整站点设置时，同步更新 `DEFAULT_SETTINGS`、共享类型、`routes/admin/system.ts` 与 `routes/auth.ts`。
- 修改简体中文文案后执行 `pnpm i18n:tw`；`zh-TW.ts` 与 `prisma/sqlite/schema.prisma` 都是生成文件，不要手工编辑。
- 部分文件使用 CRLF 换行；精确匹配的编辑失败时先检查行尾。

### 测试

- 服务端测试位于 `server/test/*.test.ts`，集成测试用 `buildApp()` 对临时 SQLite 数据库与 `memory://` Redis 构建应用，再通过 `app.inject` 发请求。
- 所有写请求必须带 `x-requested-with: XMLHttpRequest`，这是 CSRF 防护的一部分。

## 常见问题

<details>
<summary><b>没有 PostgreSQL、Redis 或 Incus 宿主机，能跑起来吗？</b></summary>

可以。`server/.env.example` 默认使用 SQLite（`file:./data/dev.db`）+ 进程内 Redis（`memory://`）+ 模拟节点（`mock://`），一条 `pnpm dev` 即可体验完整流程。这两种简化模式仅适用于**单进程本地开发**。
</details>

<details>
<summary><b>前端 :5180 打开后接口全部 404 / 请求打到了错误端口？</b></summary>

后端端口被占用时，修改 `server/.env` 的 `PORT`，并在 `web/.env.local` 中设置 `API_URL=http://127.0.0.1:<端口>`。开发服务器默认把 `/api`（含 WebSocket）代理到 `API_URL` 或 `127.0.0.1:3000`。
</details>

<details>
<summary><b>为什么操作真实宿主机时提示证书配置错误？</b></summary>

面板不生成证书，也不会从数据库读取。需由开发者创建并上传 `server/certs/incus/client.crt` 与 `client.key`，然后在「系统设置 → 面板证书」确认加载状态。`mock://` 节点不需要证书。
</details>

<details>
<summary><b>改了 <code>APP_SECRET</code> 会怎样？</b></summary>

实例 root 密码、支付网关密钥等由它派生密钥加密（AES-256-GCM）。更换后这些数据**无法解密**，实例密码与支付配置全部失效。部署、升级、迁移都必须沿用原值。
</details>

<details>
<summary><b>忘记管理员密码怎么办？</b></summary>

项目没有内置重置命令，且初始化只会在数据库**没有任何管理员**时按环境变量创建账号，修改 `.env` 不会覆盖已有密码。需要通过数据库维护手段处理，操作前请先备份。日常运维建议保留至少两个管理员账号。
</details>

<details>
<summary><b>Docker 镜像里能不能用 SQLite 或 <code>memory://</code>？</b></summary>

不建议。生产镜像不安装 SQLite 适配器，Compose 示例连接外部 PostgreSQL 与 Redis。SQLite 与内存队列只在本地开发使用。
</details>

<details>
<summary><b>改了简体中文文案，繁体没跟着变？</b></summary>

执行 `pnpm i18n:tw`。`web/src/i18n/zh-TW.ts`、`server/src/i18n/zh-TW.ts` 由 OpenCC + 术语表生成，不要手改；英文字典由 TypeScript 类型保证键与简体中文一致。
</details>

<details>
<summary><b>面板和 Worker 可以分开部署吗？</b></summary>

可以。API 进程设 `RUN_WORKER=false`，Worker 进程设 `RUN_API=false`。两者须共享同一数据库、Redis、附件目录与证书目录；Worker 建议只运行一个。
</details>

<details>
<summary><b>宿主机 Agent 显示离线或版本过旧？</b></summary>

先确认面板到宿主机 Incus API 端口的连通性与证书信任。Agent 版本由面板按能力判断：网页控制台、宿主机侧流量统计、无 incus-agent 时的 SSH 备用通道分别需要对应版本的 Agent。设置 `AGENT_RELEASE_REPOSITORY` 后 Agent 可自动升级；未设置时需用 `pnpm build:agent` 提供本地二进制。
</details>

<details>
<summary><b>实例内没有 incus-agent，还能重装 / 改密码 / 看控制台吗？</b></summary>

可以。网页控制台（串口 / VNC）不依赖 incus-agent；重置密码、改主机名等 Incus exec 操作在 Agent 明确报告不可用时会自动尝试宿主机 Agent 的 SSH 通道（要求 Agent 0.8.0+、宿主机可连实例 22 端口、面板保存的 root 密码有效）。详见 [实例访问与网络](docs/INSTANCE_ACCESS.md)。
</details>

<details>
<summary><b>交易市场的成交规则是什么？</b></summary>

默认关闭，需在「系统设置 → 交易市场」开启。实例须运行中或已关机，且剩余天数不少于设定值（默认 3 天）。成交后实例经「实例转移」归买家、关闭自动续费，并一律用原镜像**全新安装**（系统内数据清空），无法记录镜像的实例不能挂牌。手续费默认 5%，由卖家承担。
</details>

<details>
<summary><b>工单附件有什么限制？</b></summary>

每次最多 5 个文件、单文件最多 10 MB、每账号 24 小时最多上传 200 MiB，普通用户最多 20 个未关闭工单。附件默认存 `server/data/uploads`，备份和迁移须与数据库一起保留，多 API 进程须共享该目录。
</details>

<details>
<summary><b>升级后需要注意什么？</b></summary>

按顺序执行 `pnpm install && pnpm build && pnpm db:deploy`，然后重启服务；Docker 部署重新构建镜像即可（容器启动自动迁移）。不要修改 `APP_SECRET`，并备份数据库、附件目录与证书目录。宿主机侧按新功能需要升级 Agent。
</details>

## 贡献指南

欢迎提交 Issue 与 Pull Request。参与开发前请先阅读本 README 与 [项目目录说明](docs/PROJECT_STRUCTURE.md)，并遵循以下约定。

### 提交流程

1. Fork 本仓库并从 `main` 创建分支：`feat/xxx`、`fix/xxx`、`docs/xxx`。
2. 保持改动聚焦，一个 PR 只做一件事，避免混入格式化整个文件的改动。
3. 提交前确保通过：

   ```bash
   pnpm typecheck
   pnpm test
   ```

   改动涉及 Agent 时额外执行 `pnpm test:agent`，涉及容器配置时执行 `pnpm test:docker`。

4. PR 描述中说明动机、改动点、验证方式，以及是否涉及数据库迁移或配置变更。

### 硬性约定

- **不要手工编辑生成文件**：`server/prisma/sqlite/schema.prisma`、`web/src/i18n/zh-TW.ts`、`server/src/i18n/zh-TW.ts`、`server/src/generated/`。
- **数据库迁移必须手写** PostgreSQL 迁移文件，且不得包含未经确认的破坏性变更。
- **新增文案**同时补齐简体中文与英文，随后运行 `pnpm i18n:tw`。
- **共享代码**放在 `server/src/shared`，保持浏览器兼容，不引入数据库、密钥或 Node.js 专用模块。
- **不要提交** `.env`、`server/data/`、`server/certs/incus/` 中的真实证书私钥或任何密钥。
- 请勿在开发环境中对真实宿主机执行写操作、签发令牌或保存测试配置，改用 `mock://` 节点。

### 报告问题

提交 Issue 时请附上：版本 / 提交哈希、部署方式（Docker 或 Node.js）、数据库类型、复现步骤、相关日志。日志请先脱敏，移除 IP、域名、令牌与密钥。

## 许可证

本项目基于 [MIT License](LICENSE) 发布，Copyright © 2026 PaleDove contributors。

你可以自由使用、修改、分发本项目代码，包括商业用途，但须保留原始版权声明与许可声明。软件按「原样」提供，不附带任何明示或暗示的担保。

---

**相关文档**：[Docker 部署](docs/DOCKER.md) · [Agent 发布与下载](docs/AGENT_RELEASE.md) · [实例访问与网络](docs/INSTANCE_ACCESS.md) · [项目目录说明](docs/PROJECT_STRUCTURE.md)

# 项目目录说明

PaleDove 参照 Kubernetes 项目的组织方式，将 `server/` 和 `web/` 直接放在根目录；`agent/` 存放宿主机 Agent。Node.js workspace 只包含前后端两个应用，共用契约与纯函数放在 `server/src/shared/`，前端通过 `web/src/shared/` 统一引用同一份源码，维护脚本按职责放在各模块的 `scripts/` 下。

```text
idcpanel/
  server/                 API、Worker、数据库模型、安装模板与运行数据
    src/shared/           前后端共用类型、枚举与纯函数
    scripts/              构建、数据库、翻译生成与 Docker 工具
  web/                    React 前端
    src/shared/           前端的共用代码入口，引用服务端的纯 TypeScript 源码
  agent/                  Go 宿主机 Agent
    scripts/              双架构构建与 Release 打包工具
  docs/                   项目说明、部署文档与截图
  .github/workflows/      Agent 发布流程
  Dockerfile              面板镜像构建
  docker-compose.yml      仅面板容器，连接外部 PostgreSQL / Redis
  docker-entrypoint.sh    容器启动、迁移与初始化入口
  .env.example            根目录 .env 的生产 / Docker 配置示例
```

## 应用与共享代码

| 目录 | 职责 |
| --- | --- |
| `agent/cmd/paledove-agent/` | Go 宿主机 Agent 的程序入口 |
| `agent/internal/` | 按功能拆分的 Agent 实现，组织约定见该应用的 README |
| `agent/scripts/` | Agent 的双架构构建、校验清单与 Release 打包 |
| `server/src/routes/` | Fastify API，管理员接口放在 `admin/` 下 |
| `server/src/services/` | 开通、计费、支付、审查、宿主机安装、邮件等业务逻辑 |
| `server/src/incus/` | Incus 客户端、模拟客户端与本地证书读取 |
| `server/src/jobs/` | 任务队列、Worker 与定时任务 |
| `server/src/lib/`、`plugins/` | 服务端基础设施与 Fastify 插件 |
| `server/prisma/` | PostgreSQL 数据模型、迁移历史和初始化数据 |
| `server/test/` | 服务端测试，集成测试使用临时数据库 |
| `server/templates/` | Incus、Caddy、Agent 的运行时安装模板，每次下载重新读取，生产部署必须包含 |
| `web/src/pages/` | 按公开页面、用户后台、管理后台和共享业务划分的页面 |
| `web/src/components/` | 公共 UI、图表和跨页面复用的业务组件 |
| `web/src/layouts/` | 控制台布局、侧边栏、通知、任务与快捷搜索入口 |
| `web/src/lib/`、`hooks/` | API、路由加载、格式化工具与 hooks |
| `web/src/assets/`、`public/` | 打包资源与直接公开的静态资源 |
| `server/src/shared/` | 前后端共用的类型、枚举、标签和纯函数，无需单独构建；不能引入数据库、密钥或 Node.js 专用模块 |
| `web/src/shared/` | 前端共用代码的统一入口，引用 `server/src/shared/`，两端使用同一份定义 |
| `server/scripts/docker/` | 容器环境配置校验与健康检查 |
| `server/test/docker.test.mjs` | 使用 Node.js 内置测试运行器验证容器配置和健康检查，由 `pnpm test:docker` 执行 |

前端页面按以下方式归组；移动文件时须同步更新 `web/src/lib/routes.ts` 中的懒加载入口及相关 import：

```text
web/src/pages/
  Home.tsx                首页
  Legal.tsx               公开法律条款与文档阅读页
  auth/                   登录、密码重置与邮箱验证
  documents/              共用文档列表与控制台文档阅读页
  console/                用户概览、实例列表、购买、操作日志等
    account/              账号资料与安全设置
    billing/              费用中心、账单列表与独立账单详情页
  admin/                  管理员后台
    Documents.tsx         文档设置、分类管理与注册确认
    nodes/                宿主机与节点管理
    instances/            实例管理
    catalog/              产品、套餐与镜像
    billing/              财务与优惠活动
    settings/             系统设置
  instance/               用户与管理员共用的实例详情
  market/                 交易市场
  tickets/                工单
  Notifications.tsx       用户与管理员共用的通知页
```

跨页面组件放在 `components/` 对应功能目录中。例如金额展示组件位于 `components/billing/AmountText.tsx`，由用户费用中心与管理员财务页共同使用。

文档在后台 `/admin/documents` 管理，文档中心入口位于用户控制台侧边栏 `/console/documents`，阅读页为 `/console/documents/:slug`，阅读时保留控制台导航，返回列表保留搜索和分类条件。首页顶栏不再显示文档中心；公开列表 `/help`、自定义文档 `/help/:slug` 和服务条款、隐私政策 `/terms`、`/privacy` 继续支持直接访问。旧的系统设置 `?tab=legal` 会跳转至文档设置。文档、分类和注册确认沿用 `Setting` 的 `legal` 配置，兼容已有正文和同意版本，无需数据库结构迁移；系统文档保留固定链接并保持发布，自定义草稿不通过公开 API 返回。

## 脚本

这些脚本均有命令入口，属于项目维护工具：

| 文件 | 用途 | 命令 |
| --- | --- | --- |
| `agent/scripts/build.mjs` | 交叉编译 Linux amd64 / arm64 Agent，生成版本、SHA-256 清单和发布资产；与面板构建独立 | `pnpm build:agent`、`pnpm build:agent:release` |
| `server/scripts/gen-zh-tw.mts` | 从简体中文及术语表生成前后端繁体中文消息，按脚本位置解析项目路径 | `pnpm i18n:tw` |
| `docker-entrypoint.sh` | 容器启动、迁移与初始化，配合 `server/scripts/docker/` 中的校验脚本 | 容器默认执行 `start`，也可指定 `migrate`、`seed`、`init` |
| `server/scripts/build.mjs` | 用 esbuild 打包服务端 | `pnpm --filter @paledove/server build` |
| `server/scripts/init-admin.ts` | 容器启动时初始化缺少的管理员，构建为 `dist/init-admin.js`；已有管理员时直接跳过 | 容器入口在迁移后自动执行 |
| `server/scripts/ensure-web.mjs` | 启动时检查页面构建；`pnpm start` 同时准备服务端构建和 SQLite 独立模块 | `pnpm dev:server`、`pnpm start` |
| `server/scripts/db.mjs` | 根据数据库类型选择迁移或 SQLite schema 同步命令 | `pnpm db:migrate`、`pnpm db:deploy` |
| `server/scripts/sqlite-schema.mjs` | 从 PostgreSQL schema 派生 SQLite schema | `pnpm --filter @paledove/server db:generate`，迁移和部署命令也会调用 |

## 生成文件与运行数据

| 路径 | 用途与维护方式 |
| --- | --- |
| `agent/dist/` | Agent 本地构建与 Release 打包产物。本地模式提供这些文件；正式配置 GitHub Release 下载源后无需随面板部署，见 [发布与下载说明](AGENT_RELEASE.md) |
| `web/dist/` | 前端生产构建，由 `pnpm --filter @paledove/web build` 生成，生产 API 默认托管此目录 |
| `server/dist/` | 后端构建：`index.js` 为服务入口，`seed.js` 为基础数据初始化入口，`init-admin.js` 仅初始化缺少的管理员，`prisma-sqlite.js` 仅在本地 SQLite 模式按需加载 |
| `Dockerfile`、`docker-compose.yml`、`.env.example` | 面板多阶段镜像、仅面板 Compose 与外部服务配置示例，使用方法见 [Docker 部署](DOCKER.md) |
| 根目录 `.env` | Docker 配置和 Compose 端口设置，不提交或打包进镜像；升级保持 `APP_SECRET` 不变 |
| `server/.env` | 本地运行配置，开发示例为 `server/.env.example`，默认 SQLite / 内存缓存；直接部署 Node.js 时可复制根目录生产示例 |
| `server/src/generated/` | Prisma 客户端，由 `pnpm --filter @paledove/server db:generate` 生成；开发与类型检查需要 |
| `server/prisma/sqlite/` | 派生的 SQLite schema；修改 PostgreSQL 源模型后通过命令重新生成 |
| `web/src/i18n/zh-TW.ts`、`server/src/i18n/zh-TW.ts` | 由 `pnpm i18n:tw` 生成，不手工编辑 |
| `server/data/dev.db` | 默认本地 SQLite 数据库，实际位置由 `DATABASE_URL` 决定 |
| `server/data/memory-redis.json` | 本地内存 Redis 的持久化数据 |
| `server/data/uploads/` | 默认工单附件目录，可通过 `UPLOAD_DIR` 配置 |
| `server/data/backups/` | 历史数据库快照，与当前运行数据分开存放；不会自动恢复 |
| `server/certs/incus/` | 开发者自行部署的 Incus 客户端证书与私钥，目录约定见其中的 README |

数据库、上传附件、历史备份、证书与 `.env` 配置均需单独备份，清理构建文件时应保留。`prisma/migrations/` 是生产升级所需的源文件。`web/public/logo.png` 是站点、浏览器标签与邮件共用的默认图标，也需保留。

`node_modules/` 为已安装的依赖。其下的 `.cache/`、`.vitest-cache/`、`.vite/`、`.vite-temp/` 是可再生成的工具缓存；在相关工具退出后可按具体路径清理。依赖和生成代码属于不同用途，不应把整个目录作为无用文件删除。

`docs/screenshots/` 保留 README 展示功能所用的图片；新增截图时应同时在文档中添加引用，避免积累临时预览文件。

## 目录迁移对应关系

| 原路径 | 当前路径 |
| --- | --- |
| `apps/server/` | `server/` |
| `apps/web/` | `web/` |
| `apps/agent/` | `agent/` |
| `packages/shared/src/`、原根目录 `shared/src/` | `server/src/shared/`，前端入口为 `web/src/shared/` |
| 原根目录 `shared/scripts/` | `server/scripts/` |
| `web/src/pages/user/` | `web/src/pages/console/` |
| `web/src/pages/public/` | 首页与法律条款移至 `pages/`，认证页面移至 `pages/auth/` |
| `web/src/components/layout/` | `web/src/layouts/` |
| `deploy/docker/entrypoint.sh` | 根目录 `docker-entrypoint.sh` |
| `deploy/docker/` 中的 Node.js 脚本 | `server/scripts/docker/` |
| `deploy/test/docker.test.mjs` | `server/test/docker.test.mjs` |

本地数据库、附件、备份、证书和 `.env` 随服务目录整体迁移，前端 URL、接口路径和 pnpm 命令保持原有用法。已有生产部署升级时，应同步调整工作目录、环境文件和证书挂载路径；Docker 数据卷仍使用 `panel-data`。

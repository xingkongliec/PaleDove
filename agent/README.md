# PaleDove 宿主机 Agent

常驻在宿主机上的 Agent（Go，只用标准库）：

- 每 10 秒（间隔由面板回复下发）上报宿主机实时状态：CPU 使用率与核心数、内存、SWAP、根分区、负载、进程数、运行时长、系统与内核版本，以及 Incus 检测（本地 unix socket 是否可用、版本）。
- 每 30 秒从面板拉取虚拟机的 CPU 限制，把 QEMU 进程放入 systemd scope（`paledove-vm-<实例名>.scope`）并设置 CPUQuota / CPUWeight；面板取消限制后自动解除。
- 按面板下发的升级指令自动升级。
- 节点测试（宿主机设置中启用后）：每小时向内置的国内 31 个省份 × 三网共 93 个目标发送 ICMP Ping（每个目标 4 次，取平均延迟与丢包率；没有原始套接字权限时退回 TCP 连接测速），结果展示在购买页「节点测试」。
- 实例资源上报（0.5.0 起，能力 `instance-stats`）：实例管理页面打开期间，每 3 秒通过本机 Incus 读取该实例的实时状态并上报，页面显示「Agent 上报」。
- 宿主机侧实例流量（0.8.0 起，能力 `host-traffic`）：每次心跳读取受管实例 eth0 / eth1 对应 veth / tap 的网卡计数，无需打开实例页面，也不依赖虚拟机内的 incus-agent。
- SSH 备用执行（0.8.0 起，能力 `guest-exec`）：Incus 无法联系虚拟机内 Agent 时，面板下发有期限的签名任务，由宿主机通过 SSH 执行；需要 OpenSSH 客户端、实例允许 root 密码登录且保存的密码有效。
- 智能分流依赖修复（0.8.1 起）：安装脚本补齐 `ip`、`iptables`、`wg`；已有宿主机首次启用出口时，Agent 检查并通过系统包管理器补装缺少的依赖。WireGuard 只安装 `wireguard-tools`，不替换内核或使用 `wg-quick` 修改宿主机默认路由。失败配置每分钟重试，包安装失败后 5 分钟内不重复安装；手动补装依赖会在下一轮重试中识别。

## 生成策略：一次性安装令牌

面板「宿主机 → 概览 → 宿主机状态 → 安装/重装 Agent」每次都签发新的一次性安装令牌（30 分钟内有效、只能使用一次）：

```bash
curl -fsSL 'https://panel.example.com/api/agent/install.sh' | env PALEDOVE_INSTALL_TOKEN='pdi_xxx' bash
```

- `install.sh` 是通用脚本，不含任何密钥，可以公开下载。
- 脚本先读取版本清单 `/api/agent/manifest.json`，按架构、版本及 SHA-256 固定二进制下载，并校验 sha256 与大小；**校验通过后**才把令牌放在请求头里向 `/api/agent/install-config` 换取配置（下载失败不会浪费令牌，令牌也不会出现在访问日志的 URL 里）。下载支持超时与有限重试。
- 换取配置时面板为宿主机生成新的 Agent 密钥，之前安装的 Agent 随即失效。
- 宿主机首次接入时，节点安装脚本每次下载都会嵌入一个新签发的一次性令牌，一并安装 Agent。

配置文件 `/etc/paledove/agent.env`：

```
PANEL_URL=https://panel.example.com
NODE_ID=1
AGENT_SECRET=xxxxxxxx
```

## 认证：请求签名

密钥不在网络上传输。每个请求带 `x-paledove-node / -timestamp / -nonce / -signature`，签名为：

```
HMAC-SHA256(AGENT_SECRET, "方法\n路径(含查询参数)\n毫秒时间戳\n随机数\n请求体 sha256")
```

面板拒绝时间戳偏差超过 5 分钟、随机数重复（防重放）或签名不符的请求。面板对回复同样签名：`HMAC(AGENT_SECRET, "RESPONSE\n随机数\n回复体 sha256")`，Agent 只执行签名有效的升级指令与虚拟机限制。

旧版 bash 上报程序（`AGENT_TOKEN`，Bearer 令牌）仍可上报，但不会收到升级指令，面板提示重新安装。

## 刷新策略

- 上报间隔由面板回复下发（默认 10 秒）。
- 超过 `max(3 × 上报间隔, 60 秒)` 没有上报视为离线；最后一次上报保留 7 天，离线时面板仍显示最后的状态与心跳时间。

## 自动升级

面板在上报回复中下发 `upgrade: { version, url, sha256, size }`（Agent 版本与清单不同、且有对应架构的二进制时）。Agent：

1. 只接受签名有效、与 `PANEL_URL` 同源的 `/api/agent/binary/` 地址，重定向也必须保持同源；面板只下发比当前版本新的升级；
2. 随机延迟 0~30 秒（避免所有宿主机同时下载），下载并校验大小与 sha256；
3. 写到同目录临时文件，备份旧版本为 `.bak` 后原子替换，退出进程，由 systemd（`Restart=always`）以新版本启动；
4. 升级失败的版本一小时内不再重试。

## 节点测试

面板在上报回复中下发 `ping: { enabled, interval: 3600, hash, runNow }`。Agent 到期（或管理员点了「立即测试」）时在后台：

1. 目标摘要变化时从 `/api/agent/nodes/ping-targets` 拉取目标（内置于面板 `server/src/shared/ping.ts`，签名回复）；
2. 并发 16 个目标测量，ICMP Echo 每个目标 4 次（间隔 200ms，超时 1.5s）；
3. 把结果签名回传 `/api/agent/nodes/ping-results`。面板保留 3 天，购买页按产品与地区展示中国地图、三网概览与节点列表。

## 实例资源上报

只在有人查看实例时工作，平时不读取、不上报：

1. 实例管理页面查询实时状态时，面板确认宿主机 Agent 在线且上报的能力里有 `instance-stats`，把这个实例记为「正在查看」（20 秒有效，页面每 5 秒刷新一次即续期）；
2. 下一次心跳回复里带上 `instances: { names, interval: 3 }`（只接受签名有效的回复，名称只允许 Incus 合法字符，最多 20 个）；
3. Agent 每 3 秒读取 `/1.0/instances/<名称>/state`（使用独立的 Incus 连接），原样签名上报到 `/api/agent/nodes/instance-states`；回复里是续期后的列表，列表为空或 30 秒未续期时停止；
4. 面板优先使用 12 秒内的 Agent 上报计算实时状态（CPU 与网络速率由相邻两次上报计算），否则仍由面板直接查询 Incus。

## 目录结构

Go 标准布局，只用标准库；`internal/` 下每个功能一个包，功能包之间互不依赖，只通过 `panel.Client` 与面板通信：

```
agent/
├── cmd/paledove-agent/   入口：命令行参数（-config / -once / -version）与信号处理
└── internal/
    ├── agent/            主循环：心跳上报宿主机状态，按回复驱动下面各模块
    ├── buildinfo/        版本（构建时写入）、上报协议版本、支持的功能
    ├── config/           读取 /etc/paledove/agent.env
    ├── panel/            与面板通信：请求签名、回复签名校验
    ├── logx/             日志小工具（相同提示只记一次）
    ├── hostinfo/         宿主机状态：/proc 中的 CPU、内存、负载、进程，根分区用量
    ├── incus/            本机 Incus API（unix socket）
    ├── vmlimits/         虚拟机 CPU 限制（systemd scope）
    ├── upgrade/          自动升级
    ├── nodetest/         节点测试（ICMP / TCP Ping）
    ├── instances/        实例资源上报
    ├── traffic/          宿主机 veth / tap 流量采样
    ├── guestexec/        虚拟机 SSH 备用执行与结果重传
    └── egress/           智能分流（WireGuard 隧道、策略路由、SOCKS5 / HTTP 网关）
```

新增功能时在 `internal/` 下建新包，在 `buildinfo.Capabilities` 中声明能力，并在 `agent` 的心跳回复处理里接入。

## 交易市场上架 IP 检测

0.8.2 新增 `listing-ping-v2`：每次上架或重试生成独立任务编号，随签名心跳下发本次固定的目标、发包次数和 IPv4/MAC 信息。Agent 只执行真实 ICMP，不用 TCP 测速代替；回传实际目标 IPv4、延迟和丢包率，DNS、权限、发包与抓包错误按检测故障处理。

国内目标全不通时，从同一源地址测试 3 个境外对照，再复测国内与境外目标。仅当两轮完整结果都覆盖至少 3 个大陆省份、三网各至少 2 个不同 IPv4 目标且全部超时，同时至少 2 个相同的境外对照在两轮均可达，才显示 IP 异常（疑似跨境屏蔽）。部分超时显示部分超时，证据不足或历史快照缺少复核证据显示无法判定。ICMP 结果不能单独证明屏蔽原因。

独立 IPv4 使用实例地址；桥接模式还使用实例 MAC 和网关，关机实例会在拨测前启动、结束后恢复挂牌关机。正式部署需同步发布新 Agent 并等待宿主机升级；旧 Agent 无法执行此检测。此功能独立于定时节点拨测开关。

## 切换机房 IPv4 检测

支持 `ipv4-check` 的 Agent 从签名心跳回复的 `ipv4Checks` 接收即时任务，以实例对外的 IPv4 向国内三网的 6 个目标各发送 2 次 ICMP Echo Request，通过 `/api/agent/nodes/ipv4-check` 签名回传。此功能独立于定时节点测试，实例内无需安装 ping 或依赖 incus-agent。

NAT 绑定宿主机公网地址（云厂商 1:1 NAT 使用默认出口），独立 IPv4 共用上架拨测的 routed / bridged 发包与抓包逻辑，桥接时携带实例 MAC。只允许 ICMP，不回退到 TCP。套接字、DNS 和发送错误按检测故障上报；独立 IPv4 关机时的全超时结果不判定为被墙，也不会为检测自动开关机。

面板缓存完成结果 10 分钟，90 秒未回传则超时；重新检测会生成新任务编号。宿主机、IP 或独立 IPv4 的开关机状态变化后旧结果失效。发布面板时需同步构建或发布 0.7.2 及以上 Agent，旧版 Agent 会显示升级提示。

## 构建

0.8.0 的新能力、网络接入条件和排障说明见 [实例访问与网络](../docs/INSTANCE_ACCESS.md)。Agent 自升级只替换二进制；0.8.1 起启用智能分流时会按需补装出口依赖（支持 apt-get / dnf / yum / apk，需要 Linux root 权限，单次最多等待 2 分钟）。现有宿主机若没有 `ssh`，仍需补装 OpenSSH 客户端或重跑 Agent 安装脚本。

```bash
pnpm build:agent        # 在仓库根目录执行，输出 agent/dist/paledove-agent-linux-{amd64,arm64}、SHA256SUMS、VERSION
pnpm build:agent:release # 额外输出 dist/release/ 下的版本化二进制与独立校验清单，供发布到 GitHub
pnpm test:agent         # go test ./...
```

构建入口为 `./cmd/paledove-agent`，版本通过 `-ldflags "-X github.com/paledove/agent/internal/buildinfo.Version=x.y.z"` 写入（见 [构建脚本](scripts/build.mjs)）。

正式发布：递增 `server/src/shared/products.ts` 的 `HOST_AGENT_RELEASE`，推送到仓库默认分支后，`.github/workflows/agent-release.yml` 自动测试、构建并发布 `agent-v<版本>` Release；已有同名 Release 时不会覆盖。也支持推送匹配版本的标签或手动触发 workflow。配置 `AGENT_RELEASE_REPOSITORY=owner/repo` 后，面板约每 5 分钟检查发布信息，并代理下载已校验二进制，宿主机无需访问 GitHub，面板服务器无需安装 Go 或携带 Agent 构建产物。详见 [发布与下载说明](../docs/AGENT_RELEASE.md)。

本地开发未设置 Release 仓库时，执行 `pnpm build:agent` 即可提供本地文件；此模式的 `AGENT_DIST` 相对路径始终以 `server` 为基准。面板构建命令 `pnpm build` 不再构建 Agent。上报协议版本为 `HOST_AGENT_VERSION`（Go 版为 3）。

## 排查

```bash
systemctl status paledove-agent
journalctl -u paledove-agent -n 50
paledove-agent -once      # 采集一次并打印上报内容（不上报）
paledove-agent -version
```

若旧 Agent 提示 `exec: "wg": executable file not found in $PATH`，可在 Debian / Ubuntu 宿主机执行 `apt-get update && apt-get install -y iproute2 iptables wireguard-tools`，再执行 `systemctl restart paledove-agent` 重新应用出口配置。新版 Agent 会自动补装并重试；若提示创建 WireGuard 接口失败，还需确认宿主机内核支持 WireGuard，并允许 Agent 创建网络接口。

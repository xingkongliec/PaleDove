#!/usr/bin/env bash
# PaleDove 节点安装脚本 / PaleDove node installer
# 节点：@@PALEDOVE_NODE_NAME@@
# 本脚本会安装并初始化 Incus（存储池、NAT 网桥、API 端口），信任面板证书，然后回调面板完成注册。
# 回调失败时可在面板点击「验证并连接」。
set -Eeuo pipefail

PANEL_URL=@@PALEDOVE_PANEL_URL@@
TOKEN=@@PALEDOVE_TOKEN@@
LOCALE=@@PALEDOVE_LOCALE@@
API_PORT=@@PALEDOVE_API_PORT@@
POOL_NAME=@@PALEDOVE_POOL_NAME@@
STORAGE_DRIVER=@@PALEDOVE_STORAGE_DRIVER@@
STORAGE_SOURCE=@@PALEDOVE_STORAGE_SOURCE@@
STORAGE_SIZE=@@PALEDOVE_STORAGE_SIZE@@
NAT_NETWORK=@@PALEDOVE_NAT_NETWORK@@
NAT_CIDR=@@PALEDOVE_NAT_CIDR@@
DHCP_RANGE=@@PALEDOVE_DHCP_RANGE@@
PORT_RANGE=@@PALEDOVE_PORT_RANGE@@
PUBLIC_IP=@@PALEDOVE_PUBLIC_IP@@
IPV6_ENABLED=@@PALEDOVE_IPV6_ENABLED@@
IPV6_PARENT=@@PALEDOVE_IPV6_PARENT@@
INSTALL_AGENT=@@PALEDOVE_INSTALL_AGENT@@
INSTALL_FIREWALL=@@PALEDOVE_INSTALL_FIREWALL@@
ENABLE_FIREWALL_RULES=@@PALEDOVE_ENABLE_FIREWALL_RULES@@
DEFAULT_FIREWALL_RULES=$ENABLE_FIREWALL_RULES
AGENT_AVAILABLE=@@PALEDOVE_AGENT_AVAILABLE@@
INCUS_SOURCE="${INCUS_SOURCE:-zabbly}"   # zabbly | distro

PANEL_CERT=$(cat <<'PALEDOVE_CERT'
@@PALEDOVE_PANEL_CERT@@
PALEDOVE_CERT
)

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "安装失败（第 $LINENO 行）/ install failed at line $LINENO"' ERR

@@PALEDOVE_INSTALL_UI@@
@@PALEDOVE_NODE_UNINSTALL@@
prepare_install_ui "$@"

[ "$(id -u)" -eq 0 ] || die "请使用 root 运行 / run as root"
[ -r /etc/os-release ] || die "无法识别系统 / unknown OS"
. /etc/os-release
case "${ID:-}" in
  debian|ubuntu) ;;
  *) die "仅支持 Debian 12+/Ubuntu 22.04+（当前 ${ID:-unknown}）/ only Debian and Ubuntu are supported" ;;
esac
select_node_action
dispatch_node_action
export DEBIAN_FRONTEND=noninteractive
ARCH=$(dpkg --print-architecture)

info "安装基础依赖 / installing base packages"
apt-get update -y -qq
apt-get install -y -qq curl ca-certificates gnupg jq openssl iproute2 util-linux >/dev/null
if [ "$NONINTERACTIVE" != 1 ] && [ "$UI_TEXT_ONLY" != 1 ] && ! command -v whiptail >/dev/null 2>&1; then
  apt-get install -y -qq whiptail >/dev/null 2>&1 || warn '菜单组件不可用，使用文本菜单'
fi
configure_installation

# Persist a token-free maintenance entry even when this installer was piped to bash.
MANAGER_FILE=$(mktemp /usr/local/sbin/.paledove-node.XXXXXX)
cat > "$MANAGER_FILE" <<'PALEDOVE_NODE_MANAGEMENT'
@@PALEDOVE_NODE_MANAGEMENT@@
PALEDOVE_NODE_MANAGEMENT
chmod 755 "$MANAGER_FILE"
mv -f "$MANAGER_FILE" /usr/local/sbin/paledove-node

install_incus_zabbly() {
  mkdir -p /etc/apt/keyrings
  curl -fsSL --max-time 30 https://pkgs.zabbly.com/key.asc -o /etc/apt/keyrings/zabbly.asc || return 1
  cat > /etc/apt/sources.list.d/zabbly-incus-stable.sources <<EOF
Enabled: yes
Types: deb
URIs: https://pkgs.zabbly.com/incus/stable
Suites: ${VERSION_CODENAME}
Components: main
Architectures: ${ARCH}
Signed-By: /etc/apt/keyrings/zabbly.asc
EOF
  apt-get update -y -qq && apt-get install -y -qq incus >/dev/null
}

install_incus_distro() {
  apt-get install -y -qq incus >/dev/null || return 1
  # 发行版软件包的虚拟机支持需要单独安装 QEMU / UEFI 固件
  if [ -e /dev/kvm ]; then
    case "$ARCH" in
      amd64) apt-get install -y -qq qemu-system-x86 ovmf >/dev/null || warn "QEMU 安装失败，KVM 实例将不可用" ;;
      arm64) apt-get install -y -qq qemu-system-arm qemu-efi-aarch64 >/dev/null || warn "QEMU 安装失败，KVM 实例将不可用" ;;
    esac
    apt-get install -y -qq incus-agent >/dev/null 2>&1 || true
  fi
}

if command -v incus >/dev/null 2>&1; then
  info "检测到已安装 Incus / Incus already installed"
else
  info "安装 Incus（来源：$INCUS_SOURCE）/ installing Incus"
  if [ "$INCUS_SOURCE" = "zabbly" ]; then
    install_incus_zabbly || { warn "Zabbly 源不可用，改用系统软件源 / falling back to distro packages"; rm -f /etc/apt/sources.list.d/zabbly-incus-stable.sources; apt-get update -y -qq; install_incus_distro || die "Incus 安装失败"; }
  else
    install_incus_distro || die "Incus 安装失败（系统源中没有 incus，可设置 INCUS_SOURCE=zabbly）"
  fi
fi
systemctl enable --now incus.socket incus.service >/dev/null 2>&1 || true
[ -e /dev/kvm ] || warn "未检测到 /dev/kvm，该节点无法运行 KVM 实例 / no /dev/kvm: KVM instances unavailable"

info "安装存储工具（$STORAGE_DRIVER）/ installing storage tools"
case "$STORAGE_DRIVER" in
  btrfs) apt-get install -y -qq btrfs-progs >/dev/null ;;
  lvm) apt-get install -y -qq lvm2 thin-provisioning-tools >/dev/null ;;
esac
if [ "$STORAGE_DRIVER" = "zfs" ] && ! command -v zfs >/dev/null 2>&1; then
  if [ "$ID" = "debian" ]; then
    # Debian 的 ZFS 位于 contrib 仓库，需要 DKMS 编译内核模块
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then
      sed -i -E '/^Components:/{/contrib/!s/$/ contrib/}' /etc/apt/sources.list.d/debian.sources
    fi
    if [ -f /etc/apt/sources.list ]; then
      sed -i -E '/^deb /{/contrib/!s/ main/ main contrib/}' /etc/apt/sources.list
    fi
    apt-get update -y -qq
    apt-get install -y -qq "linux-headers-$(uname -r)" zfs-dkms zfsutils-linux >/dev/null || die "ZFS 安装失败，建议改用 btrfs 存储池"
    modprobe zfs || die "ZFS 内核模块加载失败"
  else
    apt-get install -y -qq zfsutils-linux >/dev/null || die "ZFS 安装失败，建议改用 btrfs 存储池"
  fi
fi

# 检测公网 IPv6（开启转发之前，避免路由通告被忽略后丢失默认路由）
# 未开启 IPv6 的系统上 ip -6 会失败，不影响安装
V6_IF=$(ip -6 route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") {print $(i + 1); exit}}' || true)
if [ -n "$IPV6_PARENT" ]; then V6_IF="$IPV6_PARENT"; fi
V6_ADDR=""
if [ -n "$V6_IF" ]; then
  V6_ADDR=$(ip -6 -o addr show dev "$V6_IF" scope global 2>/dev/null | awk '!/temporary|deprecated/ {print $4; exit}' || true)
fi

info "配置内核参数 / tuning sysctl"
cat > /etc/sysctl.d/90-paledove.conf <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
fs.inotify.max_user_instances = 1048576
fs.inotify.max_user_watches = 1048576
vm.max_map_count = 262144
kernel.keys.maxkeys = 2000
EOF
if [ -n "$V6_IF" ]; then
  V6_KEY=${V6_IF//./\/}
  # 开启转发后仍接受路由通告；IPv6 模式下为实例的 routed 网卡代答 NDP
  printf 'net.ipv6.conf.%s.accept_ra = 2\n' "$V6_KEY" >> /etc/sysctl.d/90-paledove.conf
  if [ "$IPV6_ENABLED" = "1" ]; then
    printf 'net.ipv6.conf.%s.proxy_ndp = 1\n' "$V6_KEY" >> /etc/sysctl.d/90-paledove.conf
  fi
fi
# Incus 的 routed 网卡（实例公网 IPv6）启动前会检查全局的 proxy_ndp
if [ "$IPV6_ENABLED" = "1" ]; then
  printf 'net.ipv6.conf.all.proxy_ndp = 1\n' >> /etc/sysctl.d/90-paledove.conf
fi
sysctl --system >/dev/null 2>&1 || true

if [ "$IPV6_ENABLED" = "1" ]; then
  if [ -n "$V6_ADDR" ]; then
    info "检测到 IPv6：$V6_ADDR（网卡 $V6_IF）/ detected IPv6 $V6_ADDR on $V6_IF"
  else
    warn "未检测到公网 IPv6，请在面板编辑宿主机填写 IPv6 子网 / no public IPv6 detected, set the IPv6 subnet in the panel"
  fi
fi

pool_config() {
  case "$STORAGE_DRIVER" in
    dir)
      if [ -n "$STORAGE_SOURCE" ]; then mkdir -p "$STORAGE_SOURCE"; printf '    source: %s\n' "$(jq -Rn --arg value "$STORAGE_SOURCE" '$value')"; else printf '    {}\n'; fi ;;
    *)
      if [ -n "$STORAGE_SOURCE" ]; then printf '    source: %s\n' "$(jq -Rn --arg value "$STORAGE_SOURCE" '$value')"; else printf '    size: %s\n' "$(jq -Rn --arg value "$STORAGE_SIZE" '$value')"; fi ;;
  esac
}

if [ -z "$(incus storage list -f csv 2>/dev/null)" ]; then
  info "初始化 Incus（存储池 $POOL_NAME / 网络 $NAT_NETWORK $NAT_CIDR）/ initializing Incus"
  {
    cat <<EOF
config:
  core.https_address: "[::]:${API_PORT}"
networks:
- name: "${NAT_NETWORK}"
  type: bridge
  config:
    ipv4.address: "${NAT_CIDR}"
    ipv4.nat: "true"
    ipv4.dhcp.ranges: "${DHCP_RANGE}"
    ipv6.address: none
storage_pools:
- name: "${POOL_NAME}"
  driver: "${STORAGE_DRIVER}"
  config:
EOF
    pool_config
    cat <<EOF
profiles:
- name: default
  devices:
    root:
      path: /
      pool: "${POOL_NAME}"
      type: disk
    eth0:
      name: eth0
      network: "${NAT_NETWORK}"
      type: nic
EOF
  } | incus admin init --preseed
else
  info "Incus 已初始化，跳过存储池创建 / Incus already initialized"
  incus config set core.https_address "[::]:${API_PORT}"
  if ! incus network show "$NAT_NETWORK" >/dev/null 2>&1; then
    incus network create "$NAT_NETWORK" ipv4.address="$NAT_CIDR" ipv4.nat=true ipv4.dhcp.ranges="$DHCP_RANGE" ipv6.address=none
  fi
  if ! incus storage show "$POOL_NAME" >/dev/null 2>&1; then
    if [ -n "$STORAGE_SOURCE" ]; then
      incus storage create "$POOL_NAME" "$STORAGE_DRIVER" source="$STORAGE_SOURCE"
    elif [ "$STORAGE_DRIVER" = "dir" ]; then
      incus storage create "$POOL_NAME" dir
    else
      incus storage create "$POOL_NAME" "$STORAGE_DRIVER" size="$STORAGE_SIZE"
    fi
  fi
fi

info "信任面板证书 / trusting the panel certificate"
CERT_FILE=$(mktemp)
printf '%s\n' "$PANEL_CERT" > "$CERT_FILE"
PANEL_FP=$(openssl x509 -in "$CERT_FILE" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')
if incus config trust list -f csv 2>/dev/null | tr 'A-F' 'a-f' | grep -q "${PANEL_FP:0:12}"; then
  info "面板证书已在信任列表中 / already trusted"
else
  incus config trust add-certificate "$CERT_FILE" --name paledove-panel
fi
rm -f "$CERT_FILE"

SERVER_CERT=/var/lib/incus/server.crt
[ -f "$SERVER_CERT" ] || SERVER_CERT=$(find /var/lib/incus -maxdepth 1 -name 'cluster.crt' | head -n1)
SERVER_FP=$(openssl x509 -in "$SERVER_CERT" -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f')

if [ -z "$PUBLIC_IP" ]; then
  PUBLIC_IP=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || true)
  [ -n "$PUBLIC_IP" ] || PUBLIC_IP=$(ip -4 route get 1.1.1.1 | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n1)
fi
[ -n "$PUBLIC_IP" ] || die "无法探测公网 IPv4 / cannot detect public IPv4"

install_rfw() {
  [ "$INSTALL_FIREWALL" = "1" ] || return 0
  local suffix url iface args='' download
  case "$(uname -m)" in
    x86_64|amd64) suffix=x86_64 ;;
    aarch64|arm64) suffix=aarch64 ;;
    *) warn "RFW 不支持当前架构 $(uname -m)，跳过防火墙安装 / unsupported RFW architecture"; return 0 ;;
  esac
  mkdir -p /root/rfw
  url="https://github.com/0xdabiaoge/incudal-rfw/releases/latest/download/rfw-$suffix-unknown-linux-musl"
  if [ ! -x /root/rfw/rfw ]; then
    info "安装 RFW 防火墙 / installing RFW firewall"
    download=$(mktemp /root/rfw/.rfw.XXXXXX)
    if ! curl -fsSL --connect-timeout 15 --max-time 120 --retry 2 "$url" -o "$download"; then
      rm -f "$download"
      warn "RFW 下载失败，继续完成 Incus 安装 / RFW download failed"
      return 0
    fi
    chmod 755 "$download"
    mv -f "$download" /root/rfw/rfw
  else
    info "检测到已安装 RFW / RFW already installed"
  fi

  [ "$ENABLE_FIREWALL_RULES" = "1" ] || { info "RFW 已安装，保留现有规则与运行状态 / RFW installed, existing configuration preserved"; return 0; }
  iface=$RFW_INTERFACE
  [ -n "$iface" ] || iface=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") {print $(i + 1); exit}}' || true)
  [[ "$iface" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || { warn "无法检测 RFW 网卡，跳过规则启用 / cannot detect RFW interface"; return 0; }
  # Only allowlisted protocol flags, ISO country codes and a validated interface enter the service file.
  if [ "${#RFW_FLAGS[@]}" -gt 0 ]; then printf -v args ' %s' "${RFW_FLAGS[@]}"; fi
  cat > /etc/systemd/system/rfw.service <<EOF
[Unit]
Description=RFW Firewall Service (PaleDove)
After=network.target

[Service]
Type=simple
User=root
Environment=RUST_LOG=info
ExecStart=/root/rfw/rfw --iface $iface$args
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable rfw >/dev/null 2>&1 || true
  systemctl restart rfw >/dev/null 2>&1 || warn "RFW 服务启动失败，请检查 journalctl -u rfw / failed to start RFW"
  if systemctl is-active --quiet rfw 2>/dev/null; then
    info "RFW 规则已启用：$RFW_SUMMARY_RULES；$RFW_SUMMARY_GEO；端口日志=$RFW_LOG_PORT_ACCESS；网卡=$iface"
  else
    warn "RFW 未能运行，Incus 网络规则仍会继续配置 / RFW is not active"
  fi
}

if [ "$ENABLE_FIREWALL_RULES" = "1" ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "配置 UFW Incus 网络规则 / configuring UFW Incus rules"
  SSH_PORT=${SSH_CONNECTION:-}
  SSH_PORT=${SSH_PORT##* }
  [[ "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || SSH_PORT=22
  ufw allow "${SSH_PORT}/tcp" >/dev/null 2>&1 || true
  ufw allow "${API_PORT}/tcp" >/dev/null
  ufw allow "${PORT_RANGE}/tcp" >/dev/null
  ufw allow "${PORT_RANGE}/udp" >/dev/null
  ufw allow in on "$NAT_NETWORK" >/dev/null
  ufw route allow in on "$NAT_NETWORK" >/dev/null
  ufw route allow out on "$NAT_NETWORK" >/dev/null
fi
install_rfw
if command -v docker >/dev/null 2>&1; then
  warn "检测到 Docker：Docker 会将 FORWARD 链默认策略设为 DROP，可能导致实例无法联网 / Docker may break Incus networking"
fi

@@PALEDOVE_AGENT_INSTALL@@INCUS_VERSION=$(incus version 2>/dev/null | awk -F': ' '/Server version/ {print $2}')
# Read back the installed configuration, including a pool reused from an earlier installation.
POOL_STATE=$(incus storage list -f json | jq -ce --arg name "$POOL_NAME" '.[] | select(.name == $name)')
read_pool_settings "$POOL_STATE"
AGENT_INSTALLED=false
FIREWALL_INSTALLED=false
FIREWALL_ACTIVE=false
if [ -x /usr/local/bin/paledove-agent ] && [ -f /etc/paledove/agent.env ]; then AGENT_INSTALLED=true; fi
if [ -x /root/rfw/rfw ]; then FIREWALL_INSTALLED=true; fi
if [ "$FIREWALL_INSTALLED" = true ] && systemctl is-active --quiet rfw; then FIREWALL_ACTIVE=true; fi
info "回调面板完成注册 / registering with the panel"
PAYLOAD=$(jq -n \
  --arg token "$TOKEN" \
  --arg fingerprint "$SERVER_FP" \
  --arg publicIp "$PUBLIC_IP" \
  --arg hostname "$(hostname)" \
  --arg version "$INCUS_VERSION" \
  --arg ipv6Address "$V6_ADDR" \
  --arg ipv6Interface "$V6_IF" \
  --arg storagePool "$POOL_NAME" \
  --arg storageDriver "$STORAGE_DRIVER" \
  --arg storageSource "$STORAGE_SOURCE" \
  --arg storageSize "$STORAGE_SIZE" \
  --argjson installAgent "$AGENT_INSTALLED" \
  --argjson installFirewall "$FIREWALL_INSTALLED" \
  --argjson enableFirewallRules "$FIREWALL_ACTIVE" \
  --argjson port "$API_PORT" \
  '{token: $token, fingerprint: $fingerprint, publicIp: $publicIp, port: $port, hostname: $hostname, version: $version, ipv6Address: $ipv6Address, ipv6Interface: $ipv6Interface,
    storagePool: $storagePool, storageDriver: $storageDriver, storageSource: $storageSource, storageSize: $storageSize,
    installAgent: $installAgent, installFirewall: $installFirewall, enableFirewallRules: $enableFirewallRules}')
info "Incus 服务端证书指纹 / server fingerprint: $SERVER_FP"
# 回调失败不影响安装结果：可在面板点击「验证并连接」完成接入
if RESPONSE=$(curl -fsS --max-time 60 -X POST "$PANEL_URL/api/agent/nodes/register" -H 'content-type: application/json' -H "x-locale: $LOCALE" --data "$PAYLOAD"); then
  echo "$RESPONSE" | jq -r '.message // .'
else
  warn "无法回调面板（$PANEL_URL），请回到面板点击「验证并连接」/ could not reach the panel, click \"Verify & connect\" in the panel"
fi
info "安装完成，请确认面板可以访问本机 TCP $API_PORT 端口 / done, make sure the panel can reach TCP $API_PORT"
info '本地卸载菜单：sudo paledove-node（不需要面板令牌）'

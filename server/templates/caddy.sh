#!/usr/bin/env bash
# PaleDove Caddy 安装脚本 / PaleDove Caddy installer
# 节点：@@PALEDOVE_NODE_NAME@@
# 安装 Caddy 并开启仅允许面板证书访问的远程管理 API（mTLS），面板随后通过该 API 下发网站反代配置。
set -Eeuo pipefail

PANEL_URL=@@PALEDOVE_PANEL_URL@@
TOKEN=@@PALEDOVE_TOKEN@@
LOCALE=@@PALEDOVE_LOCALE@@
ADMIN_PORT=@@PALEDOVE_ADMIN_PORT@@

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "安装失败（第 $LINENO 行）/ install failed at line $LINENO"' ERR

[ "$(id -u)" -eq 0 ] || die "请使用 root 运行 / run as root"
. /etc/os-release
case "${ID:-}" in debian|ubuntu) ;; *) die "仅支持 Debian / Ubuntu / only Debian and Ubuntu are supported" ;; esac
export DEBIAN_FRONTEND=noninteractive

for port in 80 443; do
  if ss -ltnH "sport = :$port" 2>/dev/null | grep -q . && ! ss -ltnpH "sport = :$port" 2>/dev/null | grep -q caddy; then
    die "端口 $port 已被其他程序占用，请先停止（如 nginx / apache）/ port $port is in use"
  fi
done

info "安装 Caddy / installing Caddy"
apt-get update -y -qq
apt-get install -y -qq curl ca-certificates gnupg jq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -qq && apt-get install -y -qq caddy >/dev/null
fi

# 使用 API 模式运行（--resume 自动恢复面板下发的配置），停用基于 Caddyfile 的默认服务
UNIT=caddy-api
if [ ! -f /lib/systemd/system/caddy-api.service ] && [ ! -f /usr/lib/systemd/system/caddy-api.service ]; then
  UNIT=paledove-caddy
  cat > /etc/systemd/system/paledove-caddy.service <<'EOF'
[Unit]
Description=Caddy (managed by PaleDove)
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --resume
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF
fi
systemctl daemon-reload
systemctl disable --now caddy.service >/dev/null 2>&1 || true
systemctl enable --now "$UNIT.service"

info "等待 Caddy 管理接口 / waiting for the Caddy admin API"
for _ in $(seq 1 30); do curl -fsS http://localhost:2019/config/ >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://localhost:2019/config/ >/dev/null || die "Caddy 未能启动，请执行 journalctl -u $UNIT 查看日志"

info "启用远程管理（仅面板证书可访问）/ enabling mTLS remote admin"
CONFIG_FILE=$(mktemp)
cat > "$CONFIG_FILE" <<'PALEDOVE_CONFIG'
@@PALEDOVE_INITIAL_CONFIG@@
PALEDOVE_CONFIG
curl -fsS -X POST http://localhost:2019/load -H 'content-type: application/json' --data-binary "@$CONFIG_FILE" >/dev/null
rm -f "$CONFIG_FILE"
sleep 2
ROOT_CERT=$(curl -fsS http://localhost:2019/pki/ca/local | jq -r '.root_certificate')
[ -n "$ROOT_CERT" ] && [ "$ROOT_CERT" != "null" ] || die "无法读取 Caddy 本地 CA 证书 / cannot read the Caddy local CA"

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw allow 443/udp >/dev/null
  ufw allow "${ADMIN_PORT}/tcp" >/dev/null
fi

VERSION=$(caddy version 2>/dev/null | awk '{print $1}')
info "回调面板完成注册 / registering with the panel"
PAYLOAD=$(jq -n --arg token "$TOKEN" --arg rootCert "$ROOT_CERT" --arg version "$VERSION" --argjson port "$ADMIN_PORT" \
  '{token: $token, rootCert: $rootCert, version: $version, port: $port}')
RESPONSE=$(curl -fsS --max-time 60 -X POST "$PANEL_URL/api/agent/caddy/register" -H 'content-type: application/json' -H "x-locale: $LOCALE" --data "$PAYLOAD") \
  || die "注册失败，请确认面板可以访问本机 TCP $ADMIN_PORT 端口 / registration failed"
echo "$RESPONSE" | jq -r '.message // .'
info "完成！/ done"

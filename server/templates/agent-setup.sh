install_paledove_agent() {
  local token="$1" panel=@@PALEDOVE_PANEL_URL@@ arch sha size version manifest tmp conf bin=/usr/local/bin/paledove-agent
  if [ -z "$token" ]; then
    printf '[x] 缺少一次性安装令牌，请在面板中重新生成安装命令 / missing install token\n' >&2
    return 1
  fi
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) printf '[x] 不支持的架构 / unsupported architecture: %s\n' "$(uname -m)" >&2; return 1 ;;
  esac
  if ! manifest=$(curl -fsS --connect-timeout 10 --max-time 180 --retry 2 --retry-delay 2 "$panel/api/agent/manifest.json?format=text&version=1"); then
    printf '[x] 无法获取 Agent 发布清单，请检查面板的 Release 配置与网络 / failed to fetch agent manifest\n' >&2
    return 1
  fi
  read -r sha size version < <(printf '%s\n' "$manifest" | awk -v a="$arch" '$1 == a { print $2, $3, $4; exit }') || true
  if [[ ! "${sha:-}" =~ ^[a-f0-9]{64}$ || ! "${size:-}" =~ ^[0-9]{1,8}$ || ! "${version:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || [ "$size" -le 0 ] || [ "$size" -gt 67108864 ]; then
    printf '[x] Agent 清单无效或缺少 %s 架构，请检查面板发布源 / invalid agent manifest for %s\n' "$arch" "$arch" >&2
    return 1
  fi
  tmp=$(mktemp)
  if ! curl -fsS --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 --max-filesize "$size" -o "$tmp" "$panel/api/agent/binary/$arch?v=$version&sha256=$sha"; then
    rm -f "$tmp"
    printf '[x] 下载 Agent 失败 / failed to download the agent\n' >&2
    return 1
  fi
  if ! echo "$sha  $tmp" | sha256sum -c --status || [ "$(stat -c %s "$tmp")" != "$size" ]; then
    rm -f "$tmp"
    printf '[x] Agent 校验失败 / agent checksum mismatch\n' >&2
    return 1
  fi
  # 用一次性安装令牌换取 Agent 密钥（每次安装都会生成新密钥，旧 Agent 随即失效）
  if ! conf=$(curl -fsS --max-time 30 -H "x-paledove-install-token: $token" "$panel/api/agent/install-config"); then
    rm -f "$tmp"
    printf '[x] 安装令牌无效或已过期（30 分钟内有效、只能使用一次），请在面板中重新生成安装命令 / install token invalid or expired\n' >&2
    return 1
  fi
  mkdir -p /etc/paledove
  ( umask 077; printf '%s\n' "$conf" > /etc/paledove/agent.env )
  # 原子替换：先写到同目录的临时文件再改名
  install -m 755 "$tmp" "$bin.new"
  mv -f "$bin.new" "$bin"
  rm -f "$tmp"
  cat > /etc/systemd/system/paledove-agent.service <<'PALEDOVE_UNIT'
[Unit]
Description=PaleDove host agent
After=network-online.target incus.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/paledove-agent
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
PALEDOVE_UNIT
  systemctl daemon-reload
  systemctl enable paledove-agent.service >/dev/null 2>&1
  systemctl restart paledove-agent.service
  sleep 2
  if ! systemctl is-active --quiet paledove-agent.service; then
    journalctl -u paledove-agent.service -n 20 --no-pager >&2 || true
    return 1
  fi
  "$bin" -version
}
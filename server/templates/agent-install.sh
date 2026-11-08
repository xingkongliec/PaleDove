#!/usr/bin/env bash
# PaleDove 宿主机 Agent 安装脚本 / PaleDove host agent installer
# 用法 / usage: curl -fsSL @@PALEDOVE_PANEL_URL_COMMENT@@/api/agent/install.sh | env PALEDOVE_INSTALL_TOKEN=<一次性令牌> bash
set -Eeuo pipefail

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "安装失败（第 $LINENO 行）/ install failed at line $LINENO"' ERR

[ "$(id -u)" -eq 0 ] || die "请使用 root 运行 / run as root"
command -v systemctl >/dev/null 2>&1 || die "需要 systemd / systemd is required"
command -v curl >/dev/null 2>&1 || die "需要 curl / curl is required"
command -v sha256sum >/dev/null 2>&1 || die "需要 sha256sum / sha256sum is required"
@@PALEDOVE_LEGACY_INSTALL_TOKEN@@[ -n "${PALEDOVE_INSTALL_TOKEN:-}" ] || die "缺少 PALEDOVE_INSTALL_TOKEN，请复制面板生成的完整安装命令 / PALEDOVE_INSTALL_TOKEN is required"

@@PALEDOVE_AGENT_SETUP@@

info "安装宿主机 Agent / installing the host agent"
install_paledove_agent "$PALEDOVE_INSTALL_TOKEN" || die "Agent 安装失败 / agent install failed"
info "完成：约 10 秒后面板将显示宿主机状态，之后 Agent 会自动升级 / done, host status appears in the panel in about 10 seconds"

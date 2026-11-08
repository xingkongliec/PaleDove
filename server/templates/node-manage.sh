#!/usr/bin/env bash
# PaleDove local maintenance command; contains no panel tokens or certificates.
set -Eeuo pipefail
info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "操作失败（第 $LINENO 行）"' ERR

@@PALEDOVE_INSTALL_UI@@
@@PALEDOVE_NODE_UNINSTALL@@
NODE_MAINTENANCE_ONLY=1
prepare_install_ui "$@"
[ "$(id -u)" -eq 0 ] || die '请使用 root 运行'
select_node_action
dispatch_node_action

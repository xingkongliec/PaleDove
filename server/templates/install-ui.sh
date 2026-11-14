# Shared by the rendered installer; functions read the controlling terminal, never the script pipe.
UI_VALUE=''
UI_BOLD=''
UI_DIM=''
UI_ACCENT=''
UI_DANGER=''
UI_RESET=''
RFW_FLAGS=()
RFW_RULE_SELECTION='1 2 3 4 5'
RFW_GEO=blacklist
RFW_COUNTRIES=CN
RFW_LOG_PORT_ACCESS=0
RFW_INTERFACE=''
RFW_SUMMARY_RULES='Email / HTTP / SOCKS5 / FET-Strict / WireGuard'
RFW_SUMMARY_GEO='黑名单 CN'
NONINTERACTIVE="${PALEDOVE_NONINTERACTIVE:-0}"
NODE_ACTION=menu

ui_init() {
  UI_BOLD=''; UI_DIM=''; UI_ACCENT=''; UI_DANGER=''; UI_RESET=''
  if [ "${TERM:-dumb}" != dumb ] && [ "${UI_TEXT_ONLY:-0}" != 1 ] && [ "${NO_COLOR+x}" != x ]; then
    UI_BOLD=$'\033[1m'; UI_DIM=$'\033[2m'; UI_ACCENT=$'\033[1;36m'; UI_DANGER=$'\033[1;31m'; UI_RESET=$'\033[0m'
  fi
}

ui_divider() {
  printf '  %s────────────────────────────────────────────────────%s\n' "$UI_DIM" "$UI_RESET" >&9
}

ui_section() {
  printf '\n' >&9
  ui_divider
  printf '  %s%s%s\n' "$UI_BOLD" "$1" "$UI_RESET" >&9
  ui_divider
}

ui_service_status() {
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$1" 2>/dev/null; then
    printf '运行中'
  elif command -v "$2" >/dev/null 2>&1; then
    printf '已安装（未运行）'
  else
    printf '未安装'
  fi
}

ui_banner() {
  local os='未知系统' arch host
  if [ -r /etc/os-release ]; then os=$(. /etc/os-release; printf '%s' "${PRETTY_NAME:-未知系统}"); fi
  arch=$(uname -m 2>/dev/null || printf '未知')
  host=$(hostname 2>/dev/null || printf '未知')
  printf '\n  %sPaleDove 节点安装管理%s\n' "$UI_ACCENT" "$UI_RESET" >&9
  printf '  %sIncus · LXC / KVM Host Setup%s\n' "$UI_DIM" "$UI_RESET" >&9
  ui_section '系统信息'
  printf '  操作系统  :  %s\n  系统架构  :  %s\n  主机名称  :  %s\n' "$os" "$arch" "$host" >&9
  printf '  Incus     :  %s\n' "$(ui_service_status incus.service incus)" >&9
  printf '  Agent     :  %s\n' "$(ui_service_status paledove-agent.service /usr/local/bin/paledove-agent)" >&9
  printf '  RFW       :  %s\n' "$(ui_service_status rfw.service /root/rfw/rfw)" >&9
  ui_divider
}

ui_menu() {
  local prompt=$1 default=$2 title=${1%%$'\n'*} tag label number color hint index default_number=$2
  shift 2
  ui_section "$title"
  if [ "$title" != "$prompt" ]; then printf '%s\n\n' "${prompt#*$'\n'}" >&9; fi
  if [ "$#" = 4 ] && [ "$1" = yes ] && [ "$3" = no ]; then
    hint='y/N'
    [ "$default" != yes ] || hint='Y/n'
    printf '    %sy)%s %s    %sn)%s %s\n' "$UI_ACCENT" "$UI_RESET" "$2" "$UI_ACCENT" "$UI_RESET" "$4" >&9
    while true; do
      printf '  请选择 [%s]（q 退出）: ' "$hint" >&9
      IFS= read -r UI_VALUE <&9 || die '终端输入已关闭，取消操作'
      case "${UI_VALUE:-$default}" in
        y|Y|yes|YES|Yes|1) UI_VALUE=yes; return 0 ;;
        n|N|no|NO|No|2) UI_VALUE=no; return 0 ;;
        q|Q) die '已取消操作' ;;
        *) warn '请输入 y 或 n' ;;
      esac
    done
  fi
  local values=() numbers=()
  index=0
  while [ "$#" -gt 0 ]; do
    tag=$1; label=$2; shift 2
    if [ "$tag" = cancel ]; then number=0; else index=$((index + 1)); number=$index; fi
    color=$UI_ACCENT
    case "$tag" in uninstall*) color=$UI_DANGER ;; esac
    hint=''
    if [ "$tag" = "$default" ]; then hint=' [默认]'; default_number=$number; fi
    printf '    %s%s)%s  %s%s%s%s\n' "$color" "$number" "$UI_RESET" "$label" "$UI_DIM" "$hint" "$UI_RESET" >&9
    values+=("$tag"); numbers+=("$number")
  done
  while true; do
    printf '  请输入选项 [默认 %s]（q 退出）: ' "$default_number" >&9
    IFS= read -r UI_VALUE <&9 || die '终端输入已关闭，取消操作'
    case "$UI_VALUE" in q|Q) die '已取消操作' ;; esac
    UI_VALUE=${UI_VALUE:-$default_number}
    for index in "${!values[@]}"; do
      if [ "$UI_VALUE" = "${numbers[$index]}" ] || [ "$UI_VALUE" = "${values[$index]}" ]; then
        UI_VALUE=${values[$index]}
        return 0
      fi
    done
    warn '无效选项，请重新选择'
  done
}

ui_input() {
  local prompt=$1 default=$2
  printf '\n  %s [%s]（q 退出）: ' "$prompt" "${default:-留空}" >&9
  IFS= read -r UI_VALUE <&9 || die '终端输入已关闭，取消操作'
  case "$UI_VALUE" in q|Q) die '已取消操作' ;; esac
  UI_VALUE=${UI_VALUE:-$default}
}

ui_toggle() {
  local default=no
  [ "$2" != 1 ] || default=yes
  ui_menu "$1" "$default" yes '是' no '否'
  [ "$UI_VALUE" != yes ] || { UI_VALUE=1; return 0; }
  UI_VALUE=0
}

rfw_arguments() {
  local selection=${1^^} geo=$2 countries=${3^^} logging=$4 rule block_all=0
  local selected=() names=() rules=()
  RFW_FLAGS=()
  case "$selection" in A) selection='1 2 3 4 5 6' ;; D|'') selection='1 2 3 4 5' ;; C) selection='' ;; esac
  selection=${selection//$'\n'/ }
  read -r -a rules <<<"$selection"
  for rule in "${rules[@]}"; do
    case "$rule" in
      1) selected+=(--block-email); names+=(Email) ;;
      2) selected+=(--block-http); names+=(HTTP) ;;
      3) selected+=(--block-socks5); names+=(SOCKS5) ;;
      4) selected+=(--block-fet-strict); names+=(FET-Strict) ;;
      5) selected+=(--block-wireguard); names+=(WireGuard) ;;
      6) selected+=(--block-quic); names+=(QUIC) ;;
      7) block_all=1 ;;
      *) warn "无效的 RFW 规则编号：$rule"; return 1 ;;
    esac
  done
  RFW_SUMMARY_RULES='无协议屏蔽'
  if [ "$block_all" = 1 ]; then
    RFW_FLAGS+=(--block-all)
    RFW_SUMMARY_RULES='所有入站'
  elif [ "${#selected[@]}" -gt 0 ]; then
    RFW_FLAGS=("${selected[@]}")
    RFW_SUMMARY_RULES=$(IFS=/; printf '%s' "${names[*]}")
  fi
  countries=${countries// /}
  case "$geo" in
    blacklist|whitelist)
      [[ "$countries" =~ ^[A-Z]{2}(,[A-Z]{2})*$ ]] || { warn '国家代码须为两位字母，以逗号分隔，例如 CN,RU'; return 1; }
      if [ "$geo" = blacklist ]; then
        if [ "$block_all" = 1 ]; then RFW_FLAGS=(--block-all-from "$countries"); else RFW_FLAGS+=(--countries "$countries"); fi
        RFW_SUMMARY_GEO="黑名单 $countries"
      else
        RFW_FLAGS+=(--allow-only-countries "$countries")
        RFW_SUMMARY_GEO="白名单 $countries"
      fi ;;
    none) RFW_SUMMARY_GEO='不使用 GeoIP' ;;
    *) warn '无效的 GeoIP 模式'; return 1 ;;
  esac
  case "$logging" in 1) RFW_FLAGS+=(--log-port-access) ;; 0) ;; *) return 1 ;; esac
}

read_pool_settings() {
  local existing=$1 size
  STORAGE_DRIVER=$(jq -r '.driver' <<<"$existing")
  STORAGE_SOURCE=$(jq -r '.config.source // ""' <<<"$existing")
  size=$(jq -r '.config.size // ""' <<<"$existing")
  # Incus can report a byte count; the panel's size field uses units.
  if [[ "$size" =~ ^[0-9]+$ ]] && [ "$size" != 0 ]; then
    STORAGE_SIZE=$(jq -nr --arg size "$size" '($size | tonumber / 1048576 | tostring) + "MiB"')
  elif [[ "$size" =~ ^[0-9]+(\.[0-9]+)?(MiB|GiB|TiB|MB|GB|TB)$ ]]; then
    STORAGE_SIZE=$size
  fi
}

configure_storage() {
  local existing='' pools previous_driver=$STORAGE_DRIVER
  if command -v incus >/dev/null 2>&1; then
    pools=$(incus storage list -f json) || die '无法读取已有 Incus 存储池，请先检查 Incus 服务'
    existing=$(jq -c --arg name "$POOL_NAME" '.[] | select(.name == $name)' <<<"$pools")
  fi
  if [ -n "$existing" ]; then
    read_pool_settings "$existing"
    info "保留已有存储池 $POOL_NAME（$STORAGE_DRIVER），不格式化、不重建"
    return 0
  fi
  ui_menu '1 / 4 · 选择存储池类型（新建池使用面板中配置的名称）' "$STORAGE_DRIVER" \
    btrfs 'Btrfs · 快照与克隆，推荐通用使用' zfs 'ZFS · 快照与压缩，需要可用的 ZFS 内核模块' \
    lvm 'LVM thin · 逻辑卷与精简配置' dir '目录 · 简单兼容，部分虚拟机和快照功能受限'
  STORAGE_DRIVER=$UI_VALUE
  if [ "$STORAGE_DRIVER" != "$previous_driver" ]; then STORAGE_SOURCE=''; fi
  if [ "$STORAGE_DRIVER" = dir ]; then
    ui_input '存储目录（留空使用 Incus 默认目录，输入 - 清空预设）' "$STORAGE_SOURCE"
    STORAGE_SOURCE=$UI_VALUE
    [ "$STORAGE_SOURCE" != - ] || STORAGE_SOURCE=''
    [[ -z "$STORAGE_SOURCE" || "$STORAGE_SOURCE" = /* ]] || die '存储目录必须使用绝对路径'
    return 0
  fi
  local source_type=loop
  [ -z "$STORAGE_SOURCE" ] || source_type=device
  ui_menu '选择存储来源' "$source_type" loop '创建镜像文件 · 使用现有文件系统的可用空间' device '专用块设备 · 设备上的数据将被清除'
  if [ "$UI_VALUE" = device ]; then
    ui_input '输入专用空闲块设备路径，例如 /dev/sdb；安装前须确认设备可清空' "$STORAGE_SOURCE"
    STORAGE_SOURCE=$UI_VALUE
    [[ "$STORAGE_SOURCE" = /dev/* && -b "$STORAGE_SOURCE" ]] || die '存储来源必须是有效的 /dev/ 块设备'
  else
    STORAGE_SOURCE=''
    while true; do
      ui_input '存储镜像容量，例如 100GiB（请小于宿主机剩余空间）' "$STORAGE_SIZE"
      if [[ "$UI_VALUE" =~ ^[0-9]+(\.[0-9]+)?(MiB|GiB|TiB|MB|GB|TB)$ ]] && [[ ! "$UI_VALUE" =~ ^0+(\.0+)?[A-Za-z]+$ ]]; then STORAGE_SIZE=$UI_VALUE; break; fi
      warn '请输入有效容量，例如 100GiB'
    done
  fi
}

configure_rfw() {
  local iface default_iface='' options=()
  ui_section '3 / 4 · RFW 协议规则（输入编号，空格分隔，可多选）'
  printf '    1) 屏蔽邮件发送    · SMTP 25/587/465/2525\n    2) 屏蔽 HTTP 入站   · 明文 HTTP 协议\n    3) 屏蔽 SOCKS5 入站 · 代理协议\n    4) 屏蔽全加密流量  · 严格模式\n    5) 屏蔽 WireGuard   · VPN 协议\n    6) 屏蔽 QUIC/HTTP3  · QUIC 协议\n    7) 屏蔽所有入站    · 覆盖其他协议选项\n\n    A) 全选 1–6    D) 默认 1–5    C) 清空\n' >&9
  printf '  %s注意：HTTP、代理和所有入站规则可能影响业务访问。%s\n' "$UI_DANGER" "$UI_RESET" >&9
  while true; do
    ui_input '选择协议规则' D
    RFW_RULE_SELECTION=$UI_VALUE
    if rfw_arguments "$RFW_RULE_SELECTION" none '' 0; then break; fi
  done
  ui_menu 'GeoIP 过滤模式' blacklist blacklist '黑名单 · 屏蔽指定国家' whitelist '白名单 · 仅允许指定国家' none '不使用 GeoIP · 全局协议过滤'
  RFW_GEO=$UI_VALUE
  if [ "$RFW_GEO" != none ]; then
    while true; do
      ui_input '国家代码（逗号分隔，例如 CN,RU）' CN
      RFW_COUNTRIES=${UI_VALUE^^}; RFW_COUNTRIES=${RFW_COUNTRIES// /}
      [[ "$RFW_COUNTRIES" =~ ^[A-Z]{2}(,[A-Z]{2})*$ ]] && break
      warn '国家代码格式无效，请重新输入'
    done
  fi
  ui_toggle '启用 RFW 端口访问日志？' 0
  RFW_LOG_PORT_ACCESS=$UI_VALUE
  rfw_arguments "$RFW_RULE_SELECTION" "$RFW_GEO" "$RFW_COUNTRIES" "$RFW_LOG_PORT_ACCESS" || die '防火墙规则无效，取消安装'
  default_iface=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<NF; i++) if ($i=="dev") {print $(i+1); exit}}' || true)
  while IFS= read -r iface; do
    iface=${iface%%@*}
    [[ "$iface" != lo && "$iface" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || continue
    if [ "$iface" = "$default_iface" ]; then options+=("$iface" "$iface · 默认出口网卡"); else options+=("$iface" "$iface"); fi
  done < <(ip -o link show 2>/dev/null | awk -F': ' '{print $2}')
  [ "${#options[@]}" -gt 0 ] || die '没有可用于 RFW 的网络接口'
  [[ "$default_iface" =~ ^[A-Za-z0-9_.:-]{1,15}$ ]] || default_iface=${options[0]}
  ui_menu '选择 RFW 绑定网卡（通常为公网出口网卡）' "${default_iface:-${options[0]}}" "${options[@]}"
  RFW_INTERFACE=$UI_VALUE
}

validate_storage() {
  case "$STORAGE_DRIVER" in zfs|btrfs|lvm|dir) ;; *) die '不支持的存储驱动' ;; esac
  [[ ! "$STORAGE_SOURCE" =~ [[:cntrl:]] ]] || die '存储路径包含无效字符'
  if [ "$STORAGE_DRIVER" = dir ]; then
    [[ -z "$STORAGE_SOURCE" || ( "$STORAGE_SOURCE" = /* && "$STORAGE_SOURCE" != /dev/* ) ]] || die '目录存储须使用绝对目录路径，不能使用块设备'
    return 0
  fi
  if [ -z "$STORAGE_SOURCE" ]; then
    [[ "$STORAGE_SIZE" =~ ^[0-9]+(\.[0-9]+)?(MiB|GiB|TiB|MB|GB|TB)$ && ! "$STORAGE_SIZE" =~ ^0+(\.0+)?[A-Za-z]+$ ]] || die '存储容量无效，例如 100GiB'
  fi
  if [ -n "$STORAGE_SOURCE" ] && [[ "$STORAGE_SOURCE" = /dev/* ]]; then
    local partitions target device_type
    [ -b "$STORAGE_SOURCE" ] || die '选择的块设备不存在'
    partitions=$(lsblk -nrpo NAME "$STORAGE_SOURCE") || die '无法检查块设备'
    while IFS= read -r target; do
      if findmnt -rn -S "$target" >/dev/null 2>&1; then die "设备 $target 已挂载，拒绝创建存储池"; fi
      if swapon --noheadings --show=NAME 2>/dev/null | grep -Fxq "$target"; then die "设备 $target 正用于交换空间，拒绝创建存储池"; fi
    done <<<"$partitions"
    while IFS= read -r device_type; do
      case "$device_type" in disk|part) ;; *) die '设备存在活动的 LVM、加密卷、RAID 或其他映射，拒绝清空' ;; esac
    done < <(lsblk -nrpo TYPE "$STORAGE_SOURCE")
    if [ "$NONINTERACTIVE" != 1 ]; then
      ui_input "此操作会清除 $STORAGE_SOURCE 上的数据。请输入 ERASE $STORAGE_SOURCE 确认" ''
      [ "$UI_VALUE" = "ERASE $STORAGE_SOURCE" ] || die '未确认清空设备，已取消安装'
    else
      [ "${PALEDOVE_ERASE_DEVICE:-}" = "$STORAGE_SOURCE" ] || die '无人值守创建块设备池须设置 PALEDOVE_ERASE_DEVICE 为对应设备路径'
    fi
  fi
}

prepare_install_ui() {
  local argument requested_action=''
  UI_TEXT_ONLY=0
  for argument in "$@"; do
    case "$argument" in
      --yes|--non-interactive) NONINTERACTIVE=1 ;;
      --text) UI_TEXT_ONLY=1 ;;
      --install|--uninstall|--uninstall-agent|--uninstall-rfw)
        [ -z "$requested_action" ] || die '一次只能指定一种安装或卸载操作'
        requested_action=${argument#--}
        NODE_ACTION=$requested_action ;;
      --help)
        if [ "${NODE_MAINTENANCE_ONLY:-0}" = 1 ]; then
          printf '用法：paledove [--text] [--uninstall | --uninstall-agent | --uninstall-rfw]\n默认显示本地维护菜单，不需要面板令牌；paledove-node 仍可使用。\n'
        else
          printf '用法：bash install.sh [--text] [--install | --uninstall | --uninstall-agent | --uninstall-rfw]\n默认显示彩色数字菜单；--text 关闭菜单颜色，--yes / --non-interactive 仅供安装时采用面板预设。\n安装后可运行 paledove 打开本地维护菜单，无需面板令牌。\n'
        fi
        printf '卸载需要交互确认；整机卸载还须输入 YES，会删除所有实例和存储池数据。\n'
        exit 0 ;;
      *) die "未知参数：$argument" ;;
    esac
  done
  if [ "${NODE_MAINTENANCE_ONLY:-0}" = 1 ] && [ "$NODE_ACTION" = install ]; then die '本地维护命令仅支持卸载；安装请在面板生成新命令'; fi
  if [ "$NONINTERACTIVE" = 1 ]; then
    if [ "${NODE_MAINTENANCE_ONLY:-0}" = 1 ] || [[ "$NODE_ACTION" = uninstall* ]]; then die '卸载必须在交互终端确认，--yes 不适用于删除操作'; fi
    NODE_ACTION=install
  fi
  if [ "$NONINTERACTIVE" != 1 ]; then
    { exec 9<>/dev/tty; } 2>/dev/null || die '没有可交互终端；无人值守请传入 --yes，或设置 PALEDOVE_NONINTERACTIVE=1'
    ui_init
    ui_banner
  fi
}

select_node_action() {
  [ "$NODE_ACTION" = menu ] || return 0
  if [ "${NODE_MAINTENANCE_ONLY:-0}" = 1 ]; then
    ui_menu 'PaleDove · 本地节点维护' cancel uninstall-rfw '单独卸载 RFW 防火墙' uninstall-agent '单独卸载宿主机 Agent' uninstall '彻底卸载 Incus 节点及所有实例数据' cancel '退出'
  else
    ui_menu 'PaleDove · 选择宿主机操作' install install '安装 / 配置 Incus、存储、Agent 与防火墙' uninstall-rfw '单独卸载 RFW 防火墙' uninstall-agent '单独卸载宿主机 Agent' uninstall '彻底卸载 Incus 节点及所有实例数据' cancel '退出'
  fi
  NODE_ACTION=$UI_VALUE
}

configure_installation() {
  local existing_pool=0
  if [ "$NONINTERACTIVE" = 1 ]; then
    info '无人值守模式：采用面板预设安装选项'
  else
    configure_storage
    ui_toggle '2 / 4 · 是否安装宿主机 Agent（推荐，负责心跳、流量和审查）？' "$INSTALL_AGENT"
    INSTALL_AGENT=$UI_VALUE
    ui_toggle '是否安装 RFW 入站协议防火墙？' "$INSTALL_FIREWALL"
    INSTALL_FIREWALL=$UI_VALUE
    ENABLE_FIREWALL_RULES=0
    if [ "$INSTALL_FIREWALL" = 1 ]; then
      ui_toggle '立即启用 RFW 规则并配置已启用的 UFW 网络放行？' "${DEFAULT_FIREWALL_RULES:-0}"
      ENABLE_FIREWALL_RULES=$UI_VALUE
      [ "$ENABLE_FIREWALL_RULES" != 1 ] || configure_rfw
    fi
  fi
  [ "$INSTALL_FIREWALL" = 1 ] || ENABLE_FIREWALL_RULES=0
  if [ "$INSTALL_AGENT" = 1 ] && [ "$AGENT_AVAILABLE" != 1 ]; then die '此脚本没有 Agent 安装令牌，请重新从面板下载安装脚本'; fi
  # Existing pools are always reused, including in unattended mode.
  if command -v incus >/dev/null 2>&1; then
    local pools existing
    pools=$(incus storage list -f json) || die '无法读取已有 Incus 存储池，请先检查 Incus 服务'
    existing=$(jq -c --arg name "$POOL_NAME" '.[] | select(.name == $name)' <<<"$pools")
    if [ -n "$existing" ]; then
      existing_pool=1
      read_pool_settings "$existing"
    fi
  fi
  [ "$existing_pool" = 1 ] || validate_storage
  if [ "$ENABLE_FIREWALL_RULES" = 1 ]; then rfw_arguments "$RFW_RULE_SELECTION" "$RFW_GEO" "$RFW_COUNTRIES" "$RFW_LOG_PORT_ACCESS" || die '防火墙配置无效'; fi
  local summary source_label=${STORAGE_SOURCE:-镜像文件 $STORAGE_SIZE}
  if [ "$STORAGE_DRIVER" = dir ] && [ -z "$STORAGE_SOURCE" ]; then source_label='Incus 默认目录'; fi
  summary=$(printf '  存储池    :  %s / %s\n  存储来源  :  %s\n  Agent     :  %s\n  RFW 安装  :  %s\n  启用规则  :  %s\n  协议规则  :  %s\n  GeoIP     :  %s\n  端口日志  :  %s\n  RFW 网卡  :  %s' \
    "$POOL_NAME" "$STORAGE_DRIVER" "$source_label" \
    "$([ "$INSTALL_AGENT" = 1 ] && printf '安装' || printf '跳过，保留现状')" \
    "$([ "$INSTALL_FIREWALL" = 1 ] && printf '安装' || printf '跳过，保留现状')" \
    "$([ "$ENABLE_FIREWALL_RULES" = 1 ] && printf '是' || printf '否，保留现状')" \
    "$([ "$ENABLE_FIREWALL_RULES" = 1 ] && printf '%s' "$RFW_SUMMARY_RULES" || printf '未启用')" \
    "$([ "$ENABLE_FIREWALL_RULES" = 1 ] && printf '%s' "$RFW_SUMMARY_GEO" || printf '未启用')" \
    "$([ "$RFW_LOG_PORT_ACCESS" = 1 ] && printf '开启' || printf '关闭')" "${RFW_INTERFACE:-自动检测}")
  if [ "$NONINTERACTIVE" != 1 ]; then
    ui_menu "4 / 4 · 确认安装配置"$'\n\n'"$summary" yes yes '确认并开始安装' no '取消，退出脚本'
    [ "$UI_VALUE" = yes ] || die '已取消安装'
  else
    printf '\n%s\n\n' "$summary"
  fi
}

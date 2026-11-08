# Uninstall helpers are also embedded in the local, token-free maintenance command.
confirm_node_removal() {
  local title=$1 details=$2 phrase=${3:-}
  [ "$NONINTERACTIVE" != 1 ] || die '卸载必须在交互终端确认，--yes 不适用于删除操作'
  ui_menu "$title"$'\n\n'"$details" no yes '确认卸载' no '取消并退出'
  if [ "$UI_VALUE" != yes ]; then info '已取消卸载'; exit 0; fi
  if [ -n "$phrase" ]; then
    ui_input "数据将永久删除。请输入大写 $phrase 再次确认" ''
    if [ "$UI_VALUE" != "$phrase" ]; then info '确认文字不匹配，已取消卸载'; exit 0; fi
  fi
}

stop_node_services() {
  systemctl stop "$@" >/dev/null 2>&1 || true
  systemctl disable "$@" >/dev/null 2>&1 || true
  if systemctl is-active --quiet "$@"; then die "服务仍在运行，停止清理：$*"; fi
}

remove_host_agent() {
  info '停止并卸载宿主机 Agent'
  stop_node_services paledove-agent.service
  rm -f -- /etc/systemd/system/paledove-agent.service /usr/local/bin/paledove-agent /usr/local/bin/paledove-agent.new /etc/paledove/agent.env
  rm -rf --one-file-system -- /var/lib/paledove/guest-known-hosts
  rmdir /etc/paledove /var/lib/paledove 2>/dev/null || true
  systemctl daemon-reload
  info 'Agent 已卸载，Incus 实例继续保留'
}

remove_rfw() {
  info '停止并卸载 RFW 防火墙'
  stop_node_services rfw.service
  rm -f -- /etc/systemd/system/rfw.service /usr/lib/systemd/system/rfw.service /lib/systemd/system/rfw.service
  rm -rf --one-file-system -- /root/rfw
  systemctl daemon-reload
  info 'RFW 已卸载，保留 UFW 的现有配置'
}

local_incus() (
  # Never follow the CLI's selected remote when deleting resources on this host.
  unset INCUS_SOCKET INCUS_DIR INCUS_CONF
  incus --force-local "$@"
)

check_incus_removal() {
  command -v incus >/dev/null 2>&1 || return 0
  command -v jq >/dev/null 2>&1 || die '卸载 Incus 需要 jq，请先安装 jq 后重试'
  local server
  server=$(local_incus query /1.0) || die '无法连接本机 Incus，请先恢复服务；尚未开始删除'
  jq -e '.environment | type == "object"' <<<"$server" >/dev/null || die '无法确认本机 Incus 状态，取消删除'
  if jq -e '.environment.server_clustered == true' <<<"$server" >/dev/null; then
    die '当前宿主机属于 Incus 集群，请先迁移实例并从集群移除此成员；脚本不执行集群删除'
  fi
}

remove_incus_resources() {
  command -v incus >/dev/null 2>&1 || return 0
  local projects pools project pool items name
  projects=$(local_incus project list -f json | jq -r '.[].name') || die '无法读取 Incus 项目列表'
  pools=$(local_incus storage list -f json | jq -r '.[].name') || die '无法读取存储池列表'
  while IFS= read -r project; do
    [ -n "$project" ] || continue
    info "删除项目 $project 的实例、镜像、卷和网络"
    items=$(local_incus --project "$project" list -f json | jq -r '.[].name') || die '无法读取实例列表'
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      local_incus --project "$project" delete "$name" --force || die "实例 $name 删除失败，停止卸载"
    done <<<"$items"
    items=$(local_incus --project "$project" image list -f json | jq -r '.[].fingerprint') || die '无法读取镜像列表'
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      local_incus --project "$project" image delete "$name" || die "镜像 $name 删除失败"
    done <<<"$items"
  done <<<"$projects"
  # Projects may share profiles, volumes and networks: remove references across all projects first.
  while IFS= read -r project; do
    [ -n "$project" ] || continue
    items=$(local_incus --project "$project" profile list -f json | jq -r '.[].name') || die '无法读取配置档列表'
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      if [ "$name" = default ]; then
        local_incus --project "$project" profile edit default <<<'{"config":{},"devices":{}}' || die '无法解除默认配置档的存储和网络引用'
      else
        local_incus --project "$project" profile delete "$name" || die "配置档 $name 删除失败"
      fi
    done <<<"$items"
  done <<<"$projects"
  while IFS= read -r project; do
    [ -n "$project" ] || continue
    while IFS= read -r pool; do
      [ -n "$pool" ] || continue
      items=$(local_incus --project "$project" storage volume list "$pool" -f json | jq -r '.[] | select(.type == "custom") | .name') || die "无法读取存储池 $pool 的卷"
      while IFS= read -r name; do
        [ -n "$name" ] || continue
        local_incus --project "$project" storage volume delete "$pool" "custom/$name" || die "卷 $pool/$name 删除失败"
      done <<<"$items"
    done <<<"$pools"
    items=$(local_incus --project "$project" network list -f json | jq -r '.[] | select(.managed == true) | .name') || die '无法读取托管网络列表'
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      local_incus --project "$project" network delete "$name" || die "网络 $name 删除失败，请先移除相关引用"
    done <<<"$items"
  done <<<"$projects"
  while IFS= read -r project; do
    [ -n "$project" ] || continue
    if [ "$project" != default ]; then local_incus project delete "$project" || die "项目 $project 尚有资源未清理，停止卸载"; fi
  done <<<"$projects"
  while IFS= read -r pool; do
    [ -n "$pool" ] || continue
    local_incus --project default storage delete "$pool" || die "存储池 $pool 删除失败，请检查剩余卷、快照或存储桶"
  done <<<"$pools"
}

check_incus_mounts() {
  local mounts target
  mounts=$(findmnt -rn -o TARGET) || die '无法检查残留挂载，取消数据目录清理'
  while IFS= read -r target; do
    case "$target" in
      /var/lib/incus|/var/lib/incus/*|/var/log/incus|/var/log/incus/*|/run/incus|/run/incus/*|/opt/incus|/opt/incus/*)
        die "仍存在挂载 $target，请先卸载该挂载后重试；不会递归清理此目录" ;;
    esac
  done <<<"$mounts"
}

remove_incus_packages() {
  local installed package state packages=()
  installed=$(dpkg-query -W -f='${binary:Package} ${db:Status-Status}\n' 'incus*' 2>/dev/null || true)
  while read -r package state; do
    if [[ "$package" =~ ^incus([-:][a-zA-Z0-9.+:-]+)?$ && "$state" = installed ]]; then packages+=("$package"); fi
  done <<<"$installed"
  if [ "${#packages[@]}" -gt 0 ]; then
    DEBIAN_FRONTEND=noninteractive apt-get purge -y -- "${packages[@]}" || die 'Incus 软件包卸载失败，未清理剩余数据目录'
  fi
}

remove_incus_node() {
  check_incus_removal
  info '1 / 5 · 停止 Agent，删除本机所有 Incus 项目的实例与存储资源'
  remove_host_agent
  remove_incus_resources
  info '2 / 5 · 停止 Incus 服务，检查残留挂载'
  stop_node_services incus.service incus.socket incus-startup.service incus-lxcfs.service incus-user.service incus-user.socket
  if command -v pgrep >/dev/null 2>&1 && pgrep -x incusd >/dev/null; then die 'Incus 守护进程仍在运行，取消清理'; fi
  check_incus_mounts
  info '3 / 5 · 卸载 Incus 软件包'
  remove_incus_packages
  info '4 / 5 · 清理 RFW 与安装配置'
  remove_rfw
  rm -f -- /etc/apt/sources.list.d/zabbly-incus-stable.sources /etc/sysctl.d/90-paledove.conf
  if ! grep -rFq '/etc/apt/keyrings/zabbly.asc' /etc/apt/sources.list /etc/apt/sources.list.d 2>/dev/null; then rm -f -- /etc/apt/keyrings/zabbly.asc; fi
  info '5 / 5 · 清理固定的 Incus 数据与日志目录'
  check_incus_mounts
  rm -rf --one-file-system -- /var/lib/incus /var/log/incus /run/incus /opt/incus
  systemctl daemon-reload
  info 'Incus 节点已卸载。保留 Caddy、UFW 现有规则及 ZFS/Btrfs/LVM 等通用工具。'
  info '已移除本脚本的内核参数配置，运行值由系统配置决定。面板节点记录与账单请在后台管理。'
}

dispatch_node_action() {
  case "$NODE_ACTION" in
    install) return 0 ;;
    uninstall-rfw)
      confirm_node_removal '卸载 RFW 防火墙' '删除 RFW 服务、程序及其目录；Incus 实例和 Agent 保留。'
      remove_rfw ;;
    uninstall-agent)
      confirm_node_removal '卸载宿主机 Agent' '删除 Agent 服务、程序、密钥配置及 SSH 主机指纹缓存；Incus 实例保留。'
      remove_host_agent ;;
    uninstall)
      confirm_node_removal '彻底卸载此 Incus 节点' $'永久删除本机所有项目的 LXC 容器、虚拟机、镜像、快照、自定义卷、存储池和托管网络。\n同时卸载 Incus、Agent、RFW 及安装配置。\n请先在面板停用该节点并完成数据备份。' YES
      remove_incus_node ;;
    cancel) info '已退出，未执行安装或卸载' ;;
    *) die '无效的宿主机操作' ;;
  esac
  exit 0
}

// Package buildinfo 保存 Agent 的版本、上报协议版本与支持的功能。
package buildinfo

// Version 为发布版本，构建时通过
// -ldflags "-X github.com/paledove/agent/internal/buildinfo.Version=x.y.z" 写入
var Version = "dev"

// Protocol 为上报协议版本：面板按它判断 Agent 支持的功能（3 起为 Go 版，上报完整的宿主机状态）
const Protocol = 3

// Capabilities 为本版本支持的功能，面板展示在宿主机状态里，并据此下发对应的配置
var Capabilities = []string{"heartbeat", "host-metrics", "incus-detect", "vm-cpu-limits", "signed-requests", "auto-upgrade", "node-test", "instance-stats", "egress", "listing-ping", "listing-ping-v2", "ipv4-check", "host-traffic", "guest-exec"}

// UserAgent 为请求面板时的 User-Agent
func UserAgent() string { return "paledove-agent/" + Version }

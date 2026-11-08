// Package agent 是宿主机 Agent 的主循环：定时向面板上报宿主机状态（心跳），并按回复驱动各功能模块——
// 虚拟机 CPU 限制（vmlimits）、自动升级（upgrade）、节点测试与上架拨测（nodetest）、实例资源上报（instances）、智能分流（egress）。
// 模块只执行签名有效的回复（签名配置下）。
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/paledove/agent/internal/buildinfo"
	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/egress"
	"github.com/paledove/agent/internal/guestexec"
	"github.com/paledove/agent/internal/hostinfo"
	"github.com/paledove/agent/internal/incus"
	"github.com/paledove/agent/internal/instances"
	"github.com/paledove/agent/internal/logx"
	"github.com/paledove/agent/internal/nodetest"
	"github.com/paledove/agent/internal/panel"
	"github.com/paledove/agent/internal/traffic"
	"github.com/paledove/agent/internal/upgrade"
	"github.com/paledove/agent/internal/vmlimits"
)

const (
	defaultInterval = 10 * time.Second
	minInterval     = 5 * time.Second
	maxInterval     = 5 * time.Minute
	// 虚拟机 CPU 限制每 30 秒同步一次
	vmLimitsEvery = 30 * time.Second
)

// Report 为上报给面板的宿主机状态（字段与面板 /api/agent/nodes/report 的校验一致）
type Report struct {
	Version      int                 `json:"version"`
	Release      string              `json:"release"`
	CPU          float64             `json:"cpu"`
	Cores        int                 `json:"cores"`
	Load         [3]float64          `json:"load"`
	Uptime       float64             `json:"uptime"`
	Memory       *hostinfo.Usage     `json:"memory,omitempty"`
	Swap         *hostinfo.Usage     `json:"swap,omitempty"`
	Disk         *hostinfo.DiskUsage `json:"disk,omitempty"`
	Processes    int                 `json:"processes"`
	Hostname     string              `json:"hostname,omitempty"`
	OS           string              `json:"os,omitempty"`
	Kernel       string              `json:"kernel,omitempty"`
	Arch         string              `json:"arch"`
	Incus        incus.Info          `json:"incus"`
	Capabilities []string            `json:"capabilities"`
	Traffic      []traffic.Sample    `json:"traffic,omitempty"`
}

// reportResponse 为面板对上报的回复：上报间隔、最新版本，以及各模块的指令
type reportResponse struct {
	OK       bool                 `json:"ok"`
	Interval int                  `json:"interval"`
	Latest   string               `json:"latest"`
	Upgrade  *upgrade.Instruction `json:"upgrade"`
	// 节点测试配置（面板启用时才有）
	Ping *nodetest.Config `json:"ping"`
	// 正在查看的实例（实例管理页面打开期间），需要上报这些实例的实时资源占用
	Instances *instances.Watch `json:"instances"`
	// 智能分流配置版本（变化时拉取完整配置）
	Egress *egress.Hint `json:"egress"`
	// 上架拨测任务（用户把实例上架到交易市场时）
	ListingPings []nodetest.ListingJob `json:"listingPings"`
	IPv4Checks   []nodetest.IPv4Job    `json:"ipv4Checks"`
	Traffic      *traffic.Targets      `json:"traffic"`
	GuestJobs    []guestexec.Job       `json:"guestJobs"`
}

type Agent struct {
	panel    *panel.Client
	cpu      *hostinfo.CPUSampler
	incus    *incus.Client
	vm       *vmlimits.Limiter
	upgrader *upgrade.Upgrader
	ping     *nodetest.Pinger
	listing  *nodetest.ListingRunner
	ipv4     *nodetest.IPv4Runner
	inst     *instances.Reporter
	egress   *egress.Manager
	traffic  *traffic.Targets
	guest    *guestexec.Runner
}

func New(cfg config.Config) *Agent {
	client := panel.New(cfg)
	inc := incus.New()
	return &Agent{
		panel:    client,
		cpu:      hostinfo.NewCPUSampler(),
		incus:    inc,
		vm:       vmlimits.New(inc),
		upgrader: upgrade.New(cfg.PanelURL, client.HTTP()),
		ping:     nodetest.New(),
		listing:  nodetest.NewListingRunner(),
		ipv4:     nodetest.NewIPv4Runner(),
		inst:     instances.New(),
		egress:   egress.New(),
		guest:    guestexec.New(),
	}
}

// Collect 采集一次宿主机状态（CPU 使用率为距上次采集的平均值）
func (a *Agent) Collect() Report {
	r := Report{
		Version:      buildinfo.Protocol,
		Release:      buildinfo.Version,
		CPU:          a.cpu.Percent(),
		Cores:        hostinfo.Cores(),
		Load:         hostinfo.Load(),
		Uptime:       hostinfo.Uptime(),
		Processes:    hostinfo.Processes(),
		Hostname:     hostinfo.Hostname(),
		OS:           hostinfo.OSName(),
		Kernel:       hostinfo.Kernel(),
		Arch:         runtime.GOARCH,
		Incus:        a.incus.Detect(),
		Capabilities: buildinfo.Capabilities,
	}
	if mem, swap, ok := hostinfo.Memory(); ok {
		r.Memory, r.Swap = &mem, &swap
	}
	if total, used, err := hostinfo.DiskStat("/"); err == nil {
		r.Disk = &hostinfo.DiskUsage{Path: "/", Total: total, Used: used}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r.Traffic = traffic.Collect(ctx, a.incus, a.traffic)
	return r
}

// report 采集并上报一次，返回面板建议的上报间隔；按回复驱动升级、节点测试、实例上报与智能分流
func (a *Agent) report(ctx context.Context) (time.Duration, error) {
	body, err := json.Marshal(a.Collect())
	if err != nil {
		return 0, err
	}
	res, err := a.panel.Request(ctx, http.MethodPost, "/api/agent/nodes/report", body)
	if err != nil {
		return 0, err
	}
	if res.Status != http.StatusOK {
		return 0, fmt.Errorf("面板返回 %d：%s", res.Status, strings.TrimSpace(string(res.Body)))
	}
	var r reportResponse
	_ = json.Unmarshal(res.Body, &r)
	switch {
	case r.Upgrade != nil && res.Verified:
		// 只执行签名有效的升级指令
		if err := a.upgrader.Apply(ctx, *r.Upgrade); err != nil {
			log.Printf("自动升级到 %s 失败：%v（一小时后重试）", r.Upgrade.Version, err)
		}
	case r.Upgrade != nil:
		logx.Once("unsigned-upgrade", "忽略未通过签名校验的升级指令")
	case !a.panel.Signed() && r.Latest != "" && r.Latest != buildinfo.Version && buildinfo.Version != "dev":
		logx.Once("latest:"+r.Latest, "面板提供了新版本 %s（当前 %s），旧配置不支持自动升级，请在面板中点击「安装/重装 Agent」", r.Latest, buildinfo.Version)
	}
	// 以下模块只接受签名有效的回复
	if res.Verified {
		a.traffic = r.Traffic
		a.guest.MaybeRun(ctx, a.panel, r.GuestJobs)
		// 节点测试：到期或要求立即测试时在后台进行
		a.ping.MaybeRun(ctx, a.panel, r.Ping)
		// 上架拨测：有任务时在后台进行
		a.listing.MaybeRun(ctx, a.panel, r.ListingPings)
		a.ipv4.MaybeRun(ctx, a.panel, r.IPv4Checks)
		// 实例资源上报：有实例正在被查看时开始
		if r.Instances != nil {
			a.inst.MaybeStart(ctx, a.panel, r.Instances)
		}
		// 智能分流：配置版本变化时拉取并应用，否则定期回报状态
		a.egress.MaybeSync(ctx, a.panel, r.Egress)
	}
	return time.Duration(r.Interval) * time.Second, nil
}

// Run 常驻运行：先同步虚拟机限制（启动时立即执行一次，之后每 30 秒），再上报；按面板回复调整上报间隔
func (a *Agent) Run(ctx context.Context) {
	interval := defaultInterval
	lastVM := time.Time{}
	failures := 0
	for {
		if time.Since(lastVM) >= vmLimitsEvery {
			lastVM = time.Now()
			if err := a.vm.Sync(ctx, a.panel); err != nil {
				logx.Once("vm:"+err.Error(), "同步虚拟机 CPU 限制失败：%v", err)
			}
		}
		next, err := a.report(ctx)
		if err != nil {
			failures++
			// 连续失败时只在第 1 次和之后每 30 次记录日志
			if failures == 1 || failures%30 == 0 {
				log.Printf("上报失败（连续 %d 次）：%v", failures, err)
			}
		} else {
			if failures > 0 {
				log.Printf("上报已恢复")
			}
			failures = 0
			if next >= minInterval && next <= maxInterval {
				interval = next
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

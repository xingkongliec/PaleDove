package nodetest

// 切换机房前即时拨测，与上架拨测共用源地址选择和独立 IPv4 抓包逻辑，仅允许真实 ICMP。
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/paledove/agent/internal/panel"
)

type IPv4Job struct {
	ListingJob
	RequestID string       `json:"requestId"`
	Targets   []pingTarget `json:"targets"`
}

type IPv4Runner struct {
	mu      sync.Mutex
	running map[string]bool
	done    map[string]time.Time
	plan    func(ListingJob) (listingPlan, func(), error)
	measure func(context.Context, pingTarget, int, listingPlan) pingResult
}

func NewIPv4Runner() *IPv4Runner {
	return &IPv4Runner{
		running: map[string]bool{}, done: map[string]time.Time{},
		plan: NewListingRunner().plan, measure: measureIPv4,
	}
}

func (r *IPv4Runner) MaybeRun(ctx context.Context, c *panel.Client, jobs []IPv4Job) {
	for _, job := range jobs {
		r.mu.Lock()
		for id, at := range r.done {
			if time.Since(at) > 10*time.Minute {
				delete(r.done, id)
			}
		}
		_, done := r.done[job.RequestID]
		skip := job.ID <= 0 || job.RequestID == "" || r.running[job.RequestID] || done || len(r.running) >= 2
		if !skip {
			r.running[job.RequestID] = true
		}
		r.mu.Unlock()
		if skip {
			continue
		}
		go func(job IPv4Job) {
			err := r.run(ctx, c, job)
			r.mu.Lock()
			delete(r.running, job.RequestID)
			if err == nil {
				r.done[job.RequestID] = time.Now()
			}
			r.mu.Unlock()
			if err != nil {
				log.Printf("IPv4 检测 #%d 回传失败：%v", job.ID, err)
			}
		}(job)
	}
}

func (r *IPv4Runner) run(ctx context.Context, c *panel.Client, job IPv4Job) error {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	payload := map[string]any{"id": job.ID, "requestId": job.RequestID}
	plan, cleanup, err := r.plan(job.ListingJob)
	if err == nil {
		defer cleanup()
		switch {
		case !plan.icmp:
			err = errors.New("没有原始套接字权限，无法进行 ICMP 检测")
		case len(job.Targets) == 0 || len(job.Targets) > 6:
			err = errors.New("无效的 ICMP 检测目标")
		default:
			results := make([]pingResult, len(job.Targets))
			var wg sync.WaitGroup
			for i, target := range job.Targets {
				wg.Add(1)
				go func(i int, target pingTarget) {
					defer wg.Done()
					results[i] = r.measure(ctx, target, 2, plan)
				}(i, target)
			}
			wg.Wait()
			payload["method"], payload["via"], payload["results"] = "icmp", plan.via, results
		}
	}
	if err != nil {
		payload["error"] = err.Error()
	}
	body, _ := json.Marshal(payload)
	res, err := c.Request(ctx, http.MethodPost, "/api/agent/nodes/ipv4-check", body)
	if err != nil {
		return err
	}
	if res.Status != http.StatusOK || !c.Trusted(res) {
		return fmt.Errorf("面板返回无效的检测回复（%d）", res.Status)
	}
	return nil
}

func measureIPv4(ctx context.Context, target pingTarget, count int, plan listingPlan) pingResult {
	out := pingResult{ID: target.ID, Loss: 100}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	ips, err := net.DefaultResolver.LookupIP(rctx, "ip4", target.Host)
	cancel()
	if err != nil || len(ips) == 0 {
		out.Error = "无法解析检测目标"
		return out
	}
	out.TargetIP = ips[0].String()
	var rtts []time.Duration
	if plan.spoof != nil {
		rtts, err = plan.spoof.PingResult(ips[0], count)
	} else {
		bind := "0.0.0.0"
		if plan.src != nil {
			bind = plan.src.String()
		}
		rtts, err = icmpPingFromResult(bind, ips[0], count)
	}
	if err != nil {
		out.Error = err.Error()
		return out
	}
	result := summarize(target.ID, rtts, count)
	result.TargetIP = out.TargetIP
	return result
}

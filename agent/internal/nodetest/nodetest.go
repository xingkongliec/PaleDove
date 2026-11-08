// Package nodetest 为节点测试：向面板下发的国内三网目标 Ping（ICMP，无权限时 TCP），结果回传面板。
package nodetest

// 节点测试：面板启用后，每小时向内置的国内三网目标发送 ICMP Ping（每个目标 4 次，取平均延迟与丢包率），
// 没有原始套接字权限时退回 TCP 连接测速。目标列表由面板下发（摘要变化时重新拉取），结果签名回传给面板。
// 测试在后台进行，不影响每 10 秒的状态上报；管理员点「立即测试」时面板在上报回复里下发 runNow。

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/paledove/agent/internal/panel"
)

const (
	pingConcurrency = 16
	pingTimeout     = 1500 * time.Millisecond
	pingGap         = 200 * time.Millisecond
)

// Config 为上报回复中的节点测试配置
type Config struct {
	Enabled  bool   `json:"enabled"`
	Interval int    `json:"interval"`
	Hash     string `json:"hash"`
	RunNow   bool   `json:"runNow"`
}

type pingTarget struct {
	ID   string `json:"id"`
	Host string `json:"host"`
	Port int    `json:"port"`
}

type pingTargetList struct {
	Hash    string       `json:"hash"`
	Count   int          `json:"count"`
	Targets []pingTarget `json:"targets"`
}

type pingResult struct {
	ID      string   `json:"id"`
	Latency *float64 `json:"latency"`
	Loss    float64  `json:"loss"`
	Error   string   `json:"error,omitempty"`
}

type Pinger struct {
	running atomic.Bool
	mu      sync.Mutex
	last    time.Time
	targets *pingTargetList
	// 测量函数（测试时替换）
	measure func(ctx context.Context, t pingTarget, count int, icmp bool) pingResult
	// ICMP 是否可用（能否打开原始套接字）
	icmpOK func() bool
}

func New() *Pinger {
	return &Pinger{measure: measureTarget, icmpOK: icmpAvailable}
}

// MaybeRun 根据上报回复决定是否开始一次测试（到期或要求立即测试，且没有正在进行的测试）
func (p *Pinger) MaybeRun(ctx context.Context, c *panel.Client, cfg *Config) {
	if cfg == nil || !cfg.Enabled {
		return
	}
	interval := time.Duration(cfg.Interval) * time.Second
	if interval < 10*time.Minute {
		interval = time.Hour
	}
	p.mu.Lock()
	due := cfg.RunNow || p.last.IsZero() || time.Since(p.last) >= interval
	p.mu.Unlock()
	if !due || !p.running.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer p.running.Store(false)
		if err := p.run(ctx, c, cfg.Hash); err != nil {
			log.Printf("节点测试失败：%v", err)
		}
	}()
}

func (p *Pinger) run(ctx context.Context, c *panel.Client, hash string) error {
	p.mu.Lock()
	p.last = time.Now()
	targets := p.targets
	p.mu.Unlock()
	// 目标列表变化（或第一次）时从面板拉取
	if targets == nil || targets.Hash != hash {
		res, err := c.Request(ctx, http.MethodGet, "/api/agent/nodes/ping-targets", nil)
		if err != nil {
			return err
		}
		if res.Status != http.StatusOK || !c.Trusted(res) {
			return fmt.Errorf("拉取测试目标失败（%d）", res.Status)
		}
		var list pingTargetList
		if err := json.Unmarshal(res.Body, &list); err != nil {
			return err
		}
		targets = &list
		p.mu.Lock()
		p.targets = targets
		p.mu.Unlock()
	}
	count := targets.Count
	if count <= 0 || count > 10 {
		count = 4
	}
	icmp := p.icmpOK()
	method := "icmp"
	if !icmp {
		method = "tcp"
	}
	started := time.Now()
	results := make([]pingResult, len(targets.Targets))
	sem := make(chan struct{}, pingConcurrency)
	var wg sync.WaitGroup
	for i, t := range targets.Targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, t pingTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = p.measure(ctx, t, count, icmp)
		}(i, t)
	}
	wg.Wait()
	body, _ := json.Marshal(map[string]any{"method": method, "results": results})
	res, err := c.Request(ctx, http.MethodPost, "/api/agent/nodes/ping-results", body)
	if err != nil {
		return err
	}
	if res.Status != http.StatusOK {
		return fmt.Errorf("回传测试结果失败（%d）", res.Status)
	}
	log.Printf("节点测试完成：%d 个目标，方式 %s，耗时 %s", len(results), method, time.Since(started).Round(time.Second))
	return nil
}

// measureTarget 解析域名并测量：ICMP 可用时 Ping，否则按 TCP 连接耗时
func measureTarget(ctx context.Context, t pingTarget, count int, icmp bool) pingResult {
	out := pingResult{ID: t.ID, Loss: 100}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	ips, err := net.DefaultResolver.LookupIP(rctx, "ip4", t.Host)
	cancel()
	if err != nil || len(ips) == 0 {
		return out
	}
	var rtts []time.Duration
	if icmp {
		rtts = icmpPing(ips[0], count)
	} else {
		rtts = tcpPing(ctx, net.JoinHostPort(ips[0].String(), fmt.Sprint(t.Port)), count)
	}
	return summarize(t.ID, rtts, count)
}

// summarize 计算平均延迟（毫秒，保留一位小数）与丢包率
func summarize(id string, rtts []time.Duration, sent int) pingResult {
	out := pingResult{ID: id, Loss: 100}
	if sent <= 0 {
		return out
	}
	out.Loss = float64(sent-len(rtts)) / float64(sent) * 100
	if len(rtts) == 0 {
		return out
	}
	var sum time.Duration
	for _, r := range rtts {
		sum += r
	}
	avg := float64(sum.Microseconds()) / float64(len(rtts)) / 1000
	avg = float64(int64(avg*10+0.5)) / 10
	out.Latency = &avg
	return out
}

// ───────── ICMP ─────────

// icmpAvailable 检查能否打开 ICMP 原始套接字（需要 root 或 CAP_NET_RAW）
func icmpAvailable() bool {
	c, err := net.ListenPacket("ip4:icmp", "0.0.0.0")
	if err != nil {
		return false
	}
	c.Close()
	return true
}

func icmpChecksum(b []byte) uint16 {
	var sum uint32
	for i := 0; i+1 < len(b); i += 2 {
		sum += uint32(b[i])<<8 | uint32(b[i+1])
	}
	if len(b)%2 == 1 {
		sum += uint32(b[len(b)-1]) << 8
	}
	for sum>>16 != 0 {
		sum = sum&0xffff + sum>>16
	}
	return ^uint16(sum)
}

// echoRequest 构造 ICMP Echo Request（类型 8）
func echoRequest(id, seq uint16) []byte {
	b := make([]byte, 8+32)
	b[0] = 8
	binary.BigEndian.PutUint16(b[4:], id)
	binary.BigEndian.PutUint16(b[6:], seq)
	copy(b[8:], "paledove-agent-node-test-payload")
	binary.BigEndian.PutUint16(b[2:], icmpChecksum(b))
	return b
}

// parseEchoReply 解析 ICMP Echo Reply（类型 0），返回标识与序号
func parseEchoReply(b []byte) (id, seq uint16, ok bool) {
	if len(b) < 8 || b[0] != 0 || b[1] != 0 {
		return 0, 0, false
	}
	return binary.BigEndian.Uint16(b[4:]), binary.BigEndian.Uint16(b[6:]), true
}

func randomID() uint16 {
	var b [2]byte
	_, _ = rand.Read(b[:])
	return binary.BigEndian.Uint16(b[:])
}

// icmpPing 发送 count 次 Echo Request，返回收到回复的往返时间
func icmpPing(ip net.IP, count int) []time.Duration {
	return icmpPingFrom("0.0.0.0", ip, count)
}

// icmpPingFrom 同 icmpPing，原始套接字绑定到本机地址 bind（决定请求的源地址）
func icmpPingFrom(bind string, ip net.IP, count int) []time.Duration {
	rtts, _ := icmpPingFromResult(bind, ip, count)
	return rtts
}

// 区分目标超时与本机套接字、路由或发送错误，避免将检测故障误判为 IP 被墙。
func icmpPingFromResult(bind string, ip net.IP, count int) ([]time.Duration, error) {
	conn, err := net.ListenPacket("ip4:icmp", bind)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	id := randomID()
	dst := &net.IPAddr{IP: ip}
	buf := make([]byte, 1500)
	var rtts []time.Duration
	for seq := uint16(1); seq <= uint16(count); seq++ {
		start := time.Now()
		if _, err := conn.WriteTo(echoRequest(id, seq), dst); err != nil {
			return rtts, err
		}
		_ = conn.SetReadDeadline(start.Add(pingTimeout))
		for {
			n, from, err := conn.ReadFrom(buf)
			if err != nil {
				if e, ok := err.(net.Error); !ok || !e.Timeout() {
					return rtts, err
				}
				break // 超时
			}
			// 原始套接字会收到所有 ICMP 报文：按来源、标识与序号匹配
			rid, rseq, ok := parseEchoReply(buf[:n])
			if !ok || rid != id || rseq != seq {
				continue
			}
			if addr, ok := from.(*net.IPAddr); !ok || !addr.IP.Equal(ip) {
				continue
			}
			rtts = append(rtts, time.Since(start))
			break
		}
		time.Sleep(pingGap)
	}
	return rtts, nil
}

// ───────── TCP（ICMP 不可用时）─────────

func tcpPing(ctx context.Context, addr string, count int) []time.Duration {
	return tcpPingFrom(ctx, nil, addr, count)
}

// tcpPingFrom 同 tcpPing，local 不为空时从该本机地址发起连接
func tcpPingFrom(ctx context.Context, local net.IP, addr string, count int) []time.Duration {
	var rtts []time.Duration
	d := net.Dialer{Timeout: pingTimeout}
	if local != nil {
		d.LocalAddr = &net.TCPAddr{IP: local}
	}
	for i := 0; i < count; i++ {
		start := time.Now()
		c, err := d.DialContext(ctx, "tcp", addr)
		if err == nil {
			rtts = append(rtts, time.Since(start))
			c.Close()
		} else if errors.Is(err, context.Canceled) {
			break
		}
		time.Sleep(pingGap)
	}
	return rtts
}

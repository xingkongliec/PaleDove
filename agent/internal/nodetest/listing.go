package nodetest

// 上架拨测：用户把实例上架到交易市场时，面板在上报回复里下发拨测任务（listingPings），
// Agent 向与节点测试相同的国内三网目标 Ping，测的是「实例对外的 IPv4」到国内的连通性，结果回传面板存档。
//
// 源地址按实例的网络类型选择，保证测的就是买家拿到的那个 IP：
//   - NAT（LXC / KVM NAT）：实例经宿主机公网 IPv4 出入。地址在本机网卡上时绑定该地址发送；
//     不在本机（云厂商 1:1 NAT，公网地址不在网卡上）时用默认源地址，出口仍会转换成该公网地址。
//   - 独立 IPv4：地址在实例里（routed / bridged 网卡），不在宿主机上。Agent 用原始 IP 套接字
//     以实例 IP 为源地址构造 Echo Request，回复按路由送往实例，Agent 在宿主机所有网卡上抓包（AF_PACKET）
//     匹配回复计时。实例不需要应答，也不需要安装任何软件；只要求实例在运行（上游据此把地址路由过来）。
//     地址恰好也在本机网卡上时，与 NAT 一样直接绑定发送。

import (
	"context"
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

// ListingJob 为面板下发的一个上架拨测任务
type ListingJob struct {
	// 交易市场商品 ID
	ID int `json:"id"`
	// 要测试的 IPv4：NAT 为宿主机公网 IPv4（可能为空），独立 IPv4 为实例地址
	IP string `json:"ip"`
	// nat | dedicated
	Kind string `json:"kind"`
	// 独立 IPv4 使用桥接网卡（bridged）时：实例 MAC、网关与桥接网卡名。
	// 这类线路上游通常按 MAC 绑定地址，请求必须带实例的 MAC，才与实例自己发出的报文一致
	MAC     string `json:"mac,omitempty"`
	Gateway string `json:"gateway,omitempty"`
	Bridge  string `json:"bridge,omitempty"`
}

// 发送方式（回传面板存档）：local 绑定本机地址；default 默认源地址；
// spoof 以实例地址为源（IP 层）并抓包；spoof-l2 以实例地址与实例 MAC 从桥接的物理网卡发出并抓包
const (
	viaLocal   = "local"
	viaDefault = "default"
	viaSpoof   = "spoof"
	viaSpoofL2 = "spoof-l2"
)

// ListingRunner 执行上架拨测任务：同一任务只执行一次，最多同时执行 2 个
type ListingRunner struct {
	mu      sync.Mutex
	running map[int]bool
	done    map[int]time.Time
	active  atomic.Int32
	// 以下在测试中替换
	icmpOK  func() bool
	isLocal func(ip net.IP) bool
	measure func(ctx context.Context, t pingTarget, count int, plan listingPlan) pingResult
}

func NewListingRunner() *ListingRunner {
	return &ListingRunner{running: map[int]bool{}, done: map[int]time.Time{}, icmpOK: icmpAvailable, isLocal: localAddress, measure: measureListing}
}

// MaybeRun 开始回复中尚未执行的任务（在后台进行，不阻塞上报）
func (r *ListingRunner) MaybeRun(ctx context.Context, c *panel.Client, jobs []ListingJob) {
	for _, job := range jobs {
		r.mu.Lock()
		for id, at := range r.done {
			if time.Since(at) > 30*time.Minute {
				delete(r.done, id)
			}
		}
		_, finished := r.done[job.ID]
		skip := job.ID <= 0 || r.running[job.ID] || finished || r.active.Load() >= 2
		if !skip {
			r.running[job.ID] = true
			r.active.Add(1)
		}
		r.mu.Unlock()
		if skip {
			continue
		}
		go func(job ListingJob) {
			defer func() {
				r.mu.Lock()
				delete(r.running, job.ID)
				r.done[job.ID] = time.Now()
				r.mu.Unlock()
				r.active.Add(-1)
			}()
			if err := r.run(ctx, c, job); err != nil {
				log.Printf("上架拨测 #%d 失败：%v", job.ID, err)
			}
		}(job)
	}
}

// listingPlan 为一次拨测的发送方式
type listingPlan struct {
	via   string
	icmp  bool
	src   net.IP
	spoof *spoofer
}

func (r *ListingRunner) run(ctx context.Context, c *panel.Client, job ListingJob) error {
	started := time.Now()
	method, via, results, testErr := r.test(ctx, c, job)
	payload := map[string]any{"id": job.ID}
	if testErr != nil {
		payload["error"] = testErr.Error()
	} else {
		payload["method"], payload["via"], payload["results"] = method, via, results
	}
	body, _ := json.Marshal(payload)
	res, err := c.Request(ctx, http.MethodPost, "/api/agent/nodes/listing-ping", body)
	if err != nil {
		return err
	}
	if res.Status != http.StatusOK {
		return fmt.Errorf("回传拨测结果失败（%d）", res.Status)
	}
	if testErr != nil {
		return testErr
	}
	log.Printf("上架拨测 #%d 完成：%s，方式 %s/%s，耗时 %s", job.ID, job.IP, method, via, time.Since(started).Round(time.Second))
	return nil
}

// test 拉取目标并逐个测量，返回测量方式（icmp / tcp）、发送方式与结果
func (r *ListingRunner) test(ctx context.Context, c *panel.Client, job ListingJob) (string, string, []pingResult, error) {
	targets, err := fetchTargets(ctx, c)
	if err != nil {
		return "", "", nil, err
	}
	plan, cleanup, err := r.plan(job)
	if err != nil {
		return "", "", nil, err
	}
	defer cleanup()
	count := targets.Count
	if count <= 0 || count > 10 {
		count = 4
	}
	results := make([]pingResult, len(targets.Targets))
	sem := make(chan struct{}, pingConcurrency)
	var wg sync.WaitGroup
	for i, t := range targets.Targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, t pingTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			results[i] = r.measure(ctx, t, count, plan)
		}(i, t)
	}
	wg.Wait()
	method := "icmp"
	if !plan.icmp {
		method = "tcp"
	}
	return method, plan.via, results, nil
}

// plan 按任务选择发送方式
func (r *ListingRunner) plan(job ListingJob) (listingPlan, func(), error) {
	noop := func() {}
	ip := net.ParseIP(job.IP).To4()
	icmp := r.icmpOK()
	switch {
	case ip != nil && r.isLocal(ip):
		return listingPlan{via: viaLocal, icmp: icmp, src: ip}, noop, nil
	case job.Kind != "dedicated":
		// NAT：公网地址不在本机网卡上（或面板未记录），出口由默认路由决定
		return listingPlan{via: viaDefault, icmp: icmp}, noop, nil
	case ip == nil:
		return listingPlan{}, noop, errors.New("实例没有有效的 IPv4 地址")
	case !icmp:
		return listingPlan{}, noop, errors.New("没有原始套接字权限（需要 root 或 CAP_NET_RAW），无法以实例 IP 拨测")
	}
	sp, err := newSpoofer(ip, job)
	if err != nil {
		return listingPlan{}, noop, fmt.Errorf("无法以实例 IP %s 发送：%w", ip, err)
	}
	via := viaSpoof
	if sp.L2() {
		via = viaSpoofL2
	}
	return listingPlan{via: via, icmp: true, src: ip, spoof: sp}, sp.Close, nil
}

// measureListing 解析目标域名并按计划测量
func measureListing(ctx context.Context, t pingTarget, count int, plan listingPlan) pingResult {
	out := pingResult{ID: t.ID, Loss: 100}
	rctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	ips, err := net.DefaultResolver.LookupIP(rctx, "ip4", t.Host)
	cancel()
	if err != nil || len(ips) == 0 {
		return out
	}
	dst := ips[0].To4()
	var rtts []time.Duration
	switch {
	case plan.spoof != nil:
		rtts = plan.spoof.Ping(dst, count)
	case plan.icmp:
		bind := "0.0.0.0"
		if plan.src != nil {
			bind = plan.src.String()
		}
		rtts = icmpPingFrom(bind, dst, count)
	default:
		rtts = tcpPingFrom(ctx, plan.src, net.JoinHostPort(dst.String(), fmt.Sprint(t.Port)), count)
	}
	return summarize(t.ID, rtts, count)
}

// fetchTargets 从面板拉取测试目标（与节点测试相同）
func fetchTargets(ctx context.Context, c *panel.Client) (*pingTargetList, error) {
	res, err := c.Request(ctx, http.MethodGet, "/api/agent/nodes/ping-targets", nil)
	if err != nil {
		return nil, err
	}
	if res.Status != http.StatusOK || !c.Trusted(res) {
		return nil, fmt.Errorf("拉取测试目标失败（%d）", res.Status)
	}
	var list pingTargetList
	if err := json.Unmarshal(res.Body, &list); err != nil {
		return nil, err
	}
	if len(list.Targets) == 0 {
		return nil, errors.New("面板没有下发测试目标")
	}
	return &list, nil
}

// localAddress 判断地址是否配置在本机网卡上
func localAddress(ip net.IP) bool {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// ───────── 以实例地址为源的 ICMP（spoofer）公共部分 ─────────

type echoKey struct {
	from [4]byte
	id   uint16
	seq  uint16
}

// waiters 登记等待中的 Echo Request，抓到匹配的回复时通知
type waiters struct {
	mu sync.Mutex
	m  map[echoKey]chan time.Time
}

func (w *waiters) add(k echoKey) chan time.Time {
	ch := make(chan time.Time, 1)
	w.mu.Lock()
	w.m[k] = ch
	w.mu.Unlock()
	return ch
}

func (w *waiters) remove(k echoKey) {
	w.mu.Lock()
	delete(w.m, k)
	w.mu.Unlock()
}

// deliver 处理抓到的一个 IPv4 报文：发往 src 的 Echo Reply 且匹配登记时通知等待方
func (w *waiters) deliver(pkt []byte, src net.IP, at time.Time) {
	from, dst, payload, ok := parseIPv4ICMP(pkt)
	if !ok || !dst.Equal(src) {
		return
	}
	id, seq, ok := parseEchoReply(payload)
	if !ok {
		return
	}
	var k echoKey
	copy(k.from[:], from.To4())
	k.id, k.seq = id, seq
	w.mu.Lock()
	ch := w.m[k]
	delete(w.m, k)
	w.mu.Unlock()
	if ch != nil {
		ch <- at
	}
}

// parseIPv4ICMP 解析 IPv4 报文头，返回源、目的地址与 ICMP 部分（不是 ICMP 或分片时 ok 为 false）
func parseIPv4ICMP(b []byte) (src, dst net.IP, payload []byte, ok bool) {
	if len(b) < 20 || b[0]>>4 != 4 {
		return nil, nil, nil, false
	}
	ihl := int(b[0]&0x0f) * 4
	total := int(b[2])<<8 | int(b[3])
	if ihl < 20 || len(b) < ihl || b[9] != 1 {
		return nil, nil, nil, false
	}
	// 分片报文（MF 置位或偏移非 0）不处理
	if b[6]&0x20 != 0 || (int(b[6]&0x1f)<<8|int(b[7])) != 0 {
		return nil, nil, nil, false
	}
	end := len(b)
	if total >= ihl && total < end {
		end = total
	}
	return net.IP(b[12:16]), net.IP(b[16:20]), b[ihl:end], true
}

// ipv4EchoPacket 构造完整的 IPv4 + ICMP Echo Request 报文（源地址为 src）
func ipv4EchoPacket(src, dst net.IP, id, seq uint16) []byte {
	icmp := echoRequest(id, seq)
	b := make([]byte, 20+len(icmp))
	b[0] = 0x45
	total := len(b)
	b[2], b[3] = byte(total>>8), byte(total)
	b[4], b[5] = byte(seq>>8), byte(seq)
	b[8] = 64 // TTL
	b[9] = 1  // ICMP
	copy(b[12:16], src.To4())
	copy(b[16:20], dst.To4())
	sum := icmpChecksum(b[:20])
	b[10], b[11] = byte(sum>>8), byte(sum)
	copy(b[20:], icmp)
	return b
}

// pingWith 用 send 发送 count 次 Echo Request（逐个等待回复），返回往返时间
func pingWith(w *waiters, send func(pkt []byte, dst net.IP) error, src, dst net.IP, count int) []time.Duration {
	rtts, _ := pingWithResult(w, send, src, dst, count)
	return rtts
}

func pingWithResult(w *waiters, send func(pkt []byte, dst net.IP) error, src, dst net.IP, count int) ([]time.Duration, error) {
	id := randomID()
	var rtts []time.Duration
	for seq := uint16(1); seq <= uint16(count); seq++ {
		var k echoKey
		copy(k.from[:], dst.To4())
		k.id, k.seq = id, seq
		ch := w.add(k)
		start := time.Now()
		if err := send(ipv4EchoPacket(src, dst, id, seq), dst); err != nil {
			w.remove(k)
			return rtts, err
		}
		timer := time.NewTimer(pingTimeout)
		select {
		case at := <-ch:
			rtts = append(rtts, at.Sub(start))
		case <-timer.C:
			w.remove(k)
		}
		timer.Stop()
		time.Sleep(pingGap)
	}
	return rtts, nil
}

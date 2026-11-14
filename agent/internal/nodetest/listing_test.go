package nodetest

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/panel"
)

// 构造的 IPv4 Echo Request 报文能被解析回来（源地址为实例 IP），校验和正确
func TestIPv4EchoPacket(t *testing.T) {
	src, dst := net.ParseIP("203.0.113.7"), net.ParseIP("198.51.100.9")
	pkt := ipv4EchoPacket(src, dst, 0x1234, 3)
	from, to, payload, ok := parseIPv4ICMP(pkt)
	if !ok || !from.Equal(src) || !to.Equal(dst) {
		t.Fatalf("parse %v %v %v", from, to, ok)
	}
	if icmpChecksum(pkt[:20]) != 0 || icmpChecksum(payload) != 0 {
		t.Fatal("bad checksum")
	}
	if payload[0] != 8 {
		t.Fatalf("type %d", payload[0])
	}
}

// 抓到的回复：只接受发往实例 IP、来源与标识 / 序号都匹配的 Echo Reply
func TestWaitersDeliver(t *testing.T) {
	inst, target := net.ParseIP("203.0.113.7").To4(), net.ParseIP("198.51.100.9").To4()
	reply := func(from, to net.IP, id, seq uint16) []byte {
		pkt := ipv4EchoPacket(from, to, id, seq)
		pkt[20] = 0 // Echo Reply
		return pkt
	}
	w := &waiters{m: map[echoKey]chan time.Time{}}
	var k echoKey
	copy(k.from[:], target)
	k.id, k.seq = 7, 1
	ch := w.add(k)
	now := time.Now()
	w.deliver(reply(target, net.ParseIP("203.0.113.8"), 7, 1), inst, now) // 目的地址不是实例
	w.deliver(reply(target, inst, 7, 2), inst, now)                       // 序号不匹配
	w.deliver(ipv4EchoPacket(target, inst, 7, 1), inst, now)              // 是请求不是回复
	select {
	case <-ch:
		t.Fatal("unexpected match")
	default:
	}
	w.deliver(reply(target, inst, 7, 1), inst, now)
	select {
	case at := <-ch:
		if !at.Equal(now) {
			t.Fatal("wrong time")
		}
	default:
		t.Fatal("reply not delivered")
	}
	// 重复的回复（同一报文在多块网卡上被抓到）不会重复计入
	w.deliver(reply(target, inst, 7, 1), inst, now)
}

// pingWith：收到回复的计入往返时间，未回复的按超时计丢包
func TestPingWith(t *testing.T) {
	inst, target := net.ParseIP("203.0.113.7").To4(), net.ParseIP("198.51.100.9").To4()
	w := &waiters{m: map[echoKey]chan time.Time{}}
	send := func(pkt []byte, dst net.IP) error {
		// 只回复第 1、3 次
		if seq := uint16(pkt[26])<<8 | uint16(pkt[27]); seq%2 == 1 {
			reply := append([]byte(nil), pkt...)
			copy(reply[12:16], dst)
			copy(reply[16:20], inst)
			reply[20] = 0
			go w.deliver(reply, inst, time.Now().Add(5*time.Millisecond))
		}
		return nil
	}
	rtts := pingWith(w, send, inst, target, 3)
	if len(rtts) != 2 {
		t.Fatalf("rtts %v", rtts)
	}
}

// 发送方式：本机地址直接绑定；NAT 不在本机时用默认源地址；独立 IPv4 无权限时报错
func TestListingPlan(t *testing.T) {
	r := NewListingRunner()
	r.isLocal = func(ip net.IP) bool { return ip.Equal(net.ParseIP("203.0.113.1")) }
	r.icmpOK = func() bool { return true }
	p, _, err := r.plan(ListingJob{ID: 1, IP: "203.0.113.1", Kind: "nat"})
	if err != nil || p.via != viaLocal || !p.src.Equal(net.ParseIP("203.0.113.1")) {
		t.Fatalf("local %+v %v", p, err)
	}
	p, _, err = r.plan(ListingJob{ID: 1, IP: "198.51.100.1", Kind: "nat"})
	if err != nil || p.via != viaDefault || p.src != nil {
		t.Fatalf("default %+v %v", p, err)
	}
	p, _, err = r.plan(ListingJob{ID: 1, IP: "203.0.113.1", Kind: "dedicated"})
	if err != nil || p.via != viaLocal {
		t.Fatalf("dedicated local %+v %v", p, err)
	}
	r.icmpOK = func() bool { return false }
	if _, _, err := r.plan(ListingJob{ID: 1, IP: "198.51.100.1", Kind: "dedicated"}); err == nil {
		t.Fatal("expected error without raw sockets")
	}
	if _, _, err := r.plan(ListingJob{ID: 1, IP: "", Kind: "dedicated"}); err == nil {
		t.Fatal("expected error without ip")
	}
}

// 完整流程：测量任务中固定的目标并回传，同一任务只执行一次
func TestListingRun(t *testing.T) {
	var mu sync.Mutex
	var posted []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/nodes/ping-targets":
			t.Error("listing must use the pinned targets without fetching a different list")
			w.WriteHeader(http.StatusInternalServerError)
		case "/api/agent/nodes/listing-ping":
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			posted = append(posted, body)
			mu.Unlock()
			w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer srv.Close()
	c := panel.New(config.Config{PanelURL: srv.URL, Token: "tok"})
	r := NewListingRunner()
	r.isLocal = func(net.IP) bool { return true }
	r.icmpOK = func() bool { return true }
	r.measure = func(_ context.Context, tg pingTarget, count int, plan listingPlan) pingResult {
		if plan.via != viaLocal || count != 2 {
			t.Errorf("plan %+v count %d", plan, count)
		}
		return summarize(tg.ID, []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}, count)
	}
	job := ListingJob{ID: 42, IP: "203.0.113.1", Kind: "nat", RequestID: "first", Count: 2,
		Targets:  []pingTarget{{ID: "bj-ct", Host: "a", Port: 80, Mainland: true}, {ID: "sh-cm", Host: "b", Port: 80, Mainland: true}},
		Controls: []pingTarget{{ID: "c1"}, {ID: "c2"}, {ID: "c3"}}}
	r.MaybeRun(context.Background(), c, []ListingJob{job})
	deadline := time.Now().Add(3 * time.Second)
	for {
		mu.Lock()
		n := len(posted)
		mu.Unlock()
		if n > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// 已完成的任务不会再执行
	time.Sleep(50 * time.Millisecond)
	r.MaybeRun(context.Background(), c, []ListingJob{job})
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 1 {
		t.Fatalf("posted %d times", len(posted))
	}
	body := posted[0]
	results, _ := body["results"].([]any)
	if body["id"].(float64) != 42 || body["requestId"] != "first" || body["ip"] != job.IP || body["method"] != "icmp" || body["via"] != viaLocal || len(results) != 2 {
		t.Fatalf("body %+v", body)
	}
	first := results[0].(map[string]any)
	if first["latency"].(float64) != 15 || first["loss"].(float64) != 0 {
		t.Fatalf("result %+v", first)
	}
}

func listingTestJob() ListingJob {
	return ListingJob{ID: 42, IP: "203.0.113.1", Kind: "nat", RequestID: "test", Count: 2,
		Targets:  []pingTarget{{ID: "bj-ct", Host: "a", Mainland: true}, {ID: "sh-cm", Host: "b", Mainland: true}},
		Controls: []pingTarget{{ID: "control1"}, {ID: "control2"}, {ID: "control3"}}}
}

func TestListingVerifiesMainlandFailuresTwiceUsingSameSource(t *testing.T) {
	r := NewListingRunner()
	r.isLocal = func(net.IP) bool { return true }
	r.icmpOK = func() bool { return true }
	var mu sync.Mutex
	calls := map[string]int{}
	r.measure = func(_ context.Context, target pingTarget, count int, plan listingPlan) pingResult {
		if count != 2 || !plan.icmp || !plan.src.Equal(net.ParseIP("203.0.113.1")) {
			t.Errorf("wrong source or method: %+v", plan)
		}
		mu.Lock()
		calls[target.ID]++
		mu.Unlock()
		if target.Mainland {
			return summarize(target.ID, nil, count)
		}
		return summarize(target.ID, []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}, count)
	}
	method, via, results, verification, err := r.test(context.Background(), nil, listingTestJob())
	if err != nil || method != "icmp" || via != viaLocal || len(results) != 2 || verification == nil || len(verification.Results) != 2 || len(verification.Controls) != 3 || len(verification.ConfirmationControls) != 3 {
		t.Fatalf("method=%s via=%s verification=%+v err=%v", method, via, verification, err)
	}
	for id, count := range calls {
		if count != 2 {
			t.Errorf("target %s tested %d times", id, count)
		}
	}
}

func TestListingDoesNotSubstituteTCPOrTreatLocalErrorsAsTimeouts(t *testing.T) {
	r := NewListingRunner()
	r.isLocal = func(net.IP) bool { return true }
	r.icmpOK = func() bool { return false }
	r.measure = func(context.Context, pingTarget, int, listingPlan) pingResult {
		t.Error("must not measure TCP")
		return pingResult{}
	}
	if _, _, _, _, err := r.test(context.Background(), nil, listingTestJob()); err == nil {
		t.Fatal("missing ICMP privileges should fail")
	}
	r.icmpOK = func() bool { return true }
	r.measure = func(_ context.Context, target pingTarget, _ int, _ listingPlan) pingResult {
		return pingResult{ID: target.ID, Error: "DNS or send failure", Loss: 100}
	}
	if _, _, _, _, err := r.test(context.Background(), nil, listingTestJob()); err == nil {
		t.Fatal("local errors must not become target timeouts")
	}
}

func TestListingRetestUsesNewAttemptAndRetriesFailedUploads(t *testing.T) {
	var mu sync.Mutex
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		mu.Lock()
		posts++
		current := posts
		mu.Unlock()
		if current == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	r := NewListingRunner()
	r.isLocal = func(net.IP) bool { return true }
	r.icmpOK = func() bool { return true }
	r.measure = func(_ context.Context, target pingTarget, count int, _ listingPlan) pingResult {
		return summarize(target.ID, []time.Duration{time.Millisecond}, count)
	}
	c := panel.New(config.Config{PanelURL: srv.URL, Token: "tok"})
	job := listingTestJob()
	waitIdle := func() {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			r.mu.Lock()
			running := len(r.running)
			r.mu.Unlock()
			if running == 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("listing runner did not finish")
	}
	r.MaybeRun(context.Background(), c, []ListingJob{job})
	waitIdle()
	r.mu.Lock()
	_, done := r.done[job.RequestID]
	r.mu.Unlock()
	if done {
		t.Fatal("failed upload must remain retryable")
	}
	r.MaybeRun(context.Background(), c, []ListingJob{job})
	waitIdle()
	r.MaybeRun(context.Background(), c, []ListingJob{job})
	waitIdle()
	job.RequestID = "new-attempt"
	r.MaybeRun(context.Background(), c, []ListingJob{job})
	waitIdle()
	mu.Lock()
	defer mu.Unlock()
	if posts != 3 {
		t.Fatalf("expected 3 uploads, got %d", posts)
	}
}

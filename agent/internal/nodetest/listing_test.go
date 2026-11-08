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

// 完整流程：拉取目标、测量、回传结果；同一任务只执行一次
func TestListingRun(t *testing.T) {
	var mu sync.Mutex
	var posted []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/nodes/ping-targets":
			w.Write([]byte(`{"hash":"h","count":2,"targets":[{"id":"bj-ct","host":"a","port":80},{"id":"sh-cm","host":"b","port":80}]}`))
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
	job := ListingJob{ID: 42, IP: "203.0.113.1", Kind: "nat"}
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
	if body["id"].(float64) != 42 || body["method"] != "icmp" || body["via"] != viaLocal || len(results) != 2 {
		t.Fatalf("body %+v", body)
	}
	first := results[0].(map[string]any)
	if first["latency"].(float64) != 15 || first["loss"].(float64) != 0 {
		t.Fatalf("result %+v", first)
	}
}

package nodetest

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/panel"
)

func TestICMPPacket(t *testing.T) {
	req := echoRequest(0x1234, 3)
	if req[0] != 8 || icmpChecksum(req) != 0 {
		t.Fatalf("bad echo request checksum")
	}
	reply := append([]byte(nil), req...)
	reply[0] = 0
	if id, seq, ok := parseEchoReply(reply); !ok || id != 0x1234 || seq != 3 {
		t.Fatalf("parse reply %v %v %v", id, seq, ok)
	}
	if _, _, ok := parseEchoReply(req); ok {
		t.Fatal("request must not parse as reply")
	}
}

func TestSummarize(t *testing.T) {
	r := summarize("gd-ct", []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond}, 4)
	if r.Latency == nil || *r.Latency != 20 || r.Loss != 25 {
		t.Fatalf("got %+v", r)
	}
	if r := summarize("x", nil, 4); r.Latency != nil || r.Loss != 100 {
		t.Fatalf("timeout %+v", r)
	}
}

func TestTCPPing(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skip(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			c.Close()
		}
	}()
	if rtts := tcpPing(context.Background(), ln.Addr().String(), 2); len(rtts) != 2 {
		t.Fatalf("rtts %v", rtts)
	}
}

// 节点测试：到期时拉取目标、测量并签名回传；未到期、正在测试时不重复
func TestRun(t *testing.T) {
	var posted map[string]any
	done := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		resp := `{"ok":true}`
		switch r.URL.Path {
		case "/api/agent/nodes/ping-targets":
			resp = `{"hash":"h1","count":4,"targets":[{"id":"gd-ct","host":"a.example","port":80},{"id":"bj-cu","host":"b.example","port":80}]}`
		case "/api/agent/nodes/ping-results":
			json.Unmarshal(body, &posted)
			defer func() { done <- struct{}{} }()
		}
		w.Header().Set("x-paledove-signature", panel.ResponseSignature("s3cret", r.Header.Get("x-paledove-nonce"), []byte(resp)))
		w.Write([]byte(resp))
	}))
	defer srv.Close()
	c := panel.New(config.Config{PanelURL: srv.URL, NodeID: "7", Secret: "s3cret"})
	p := New()
	p.icmpOK = func() bool { return false }
	p.measure = func(_ context.Context, tg pingTarget, count int, icmp bool) pingResult {
		if icmp || count != 4 {
			t.Errorf("icmp=%v count=%d", icmp, count)
		}
		if tg.ID == "gd-ct" {
			return summarize(tg.ID, []time.Duration{13 * time.Millisecond}, 1)
		}
		return summarize(tg.ID, nil, 4)
	}
	p.MaybeRun(context.Background(), c, &Config{Enabled: true, Interval: 3600, Hash: "h1"})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("ping results not posted")
	}
	results := posted["results"].([]any)
	if posted["method"] != "tcp" || len(results) != 2 || results[0].(map[string]any)["latency"].(float64) != 13 || results[1].(map[string]any)["latency"] != nil {
		t.Fatalf("posted %+v", posted)
	}
	// 刚测过：不到一小时不再测试；立即测试除外
	for p.running.Load() {
		time.Sleep(10 * time.Millisecond)
	}
	p.MaybeRun(context.Background(), c, &Config{Enabled: true, Interval: 3600, Hash: "h1"})
	if p.running.Load() {
		t.Fatal("should not rerun within the interval")
	}
	p.MaybeRun(context.Background(), c, &Config{Enabled: true, Interval: 3600, Hash: "h1", RunNow: true})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("runNow should start a test")
	}
}

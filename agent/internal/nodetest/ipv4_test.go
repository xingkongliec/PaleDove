package nodetest

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/panel"
)

func TestIPv4CheckRun(t *testing.T) {
	var mu sync.Mutex
	var posted []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/agent/nodes/ipv4-check" {
			t.Errorf("unexpected request: %s", req.URL.Path)
		}
		var body map[string]any
		json.NewDecoder(req.Body).Decode(&body)
		mu.Lock()
		posted = append(posted, body)
		mu.Unlock()
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	c := panel.New(config.Config{PanelURL: srv.URL, Token: "test"})
	r := NewIPv4Runner()
	r.plan = func(job ListingJob) (listingPlan, func(), error) {
		if job.IP != "198.51.100.20" || job.MAC != "00:16:3e:00:01:02" || job.Bridge != "br0" {
			t.Errorf("lost dedicated source: %+v", job)
		}
		return listingPlan{via: viaSpoofL2, icmp: true, src: net.ParseIP(job.IP)}, func() {}, nil
	}
	r.measure = func(_ context.Context, target pingTarget, count int, plan listingPlan) pingResult {
		if count != 2 || !plan.icmp || plan.via != viaSpoofL2 {
			t.Errorf("unexpected plan: %+v, count=%d", plan, count)
		}
		return summarize(target.ID, []time.Duration{10 * time.Millisecond, 20 * time.Millisecond}, count)
	}
	job := IPv4Job{ListingJob: ListingJob{ID: 42, IP: "198.51.100.20", Kind: "dedicated", MAC: "00:16:3e:00:01:02", Bridge: "br0"}, RequestID: "first", Targets: []pingTarget{{ID: "bj-ct", Host: "203.0.113.1"}, {ID: "sh-cm", Host: "203.0.113.2"}}}
	waitDone := func(id string) {
		t.Helper()
		end := time.Now().Add(3 * time.Second)
		for time.Now().Before(end) {
			r.mu.Lock()
			_, done := r.done[id]
			r.mu.Unlock()
			if done {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("check did not finish")
	}
	r.MaybeRun(context.Background(), c, []IPv4Job{job, job})
	waitDone("first")
	r.MaybeRun(context.Background(), c, []IPv4Job{job})
	job.RequestID = "second"
	r.MaybeRun(context.Background(), c, []IPv4Job{job})
	waitDone("second")
	mu.Lock()
	defer mu.Unlock()
	if len(posted) != 2 {
		t.Fatalf("posted %d times", len(posted))
	}
	for _, body := range posted {
		if body["id"] != float64(42) || body["method"] != "icmp" || body["via"] != viaSpoofL2 || len(body["results"].([]any)) != 2 {
			t.Fatalf("wrong result: %+v", body)
		}
	}
}

func TestIPv4CheckDoesNotFallbackToTCP(t *testing.T) {
	var result map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		json.NewDecoder(req.Body).Decode(&result)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	r := NewIPv4Runner()
	r.plan = func(ListingJob) (listingPlan, func(), error) {
		return listingPlan{via: viaDefault, icmp: false}, func() {}, nil
	}
	r.measure = func(context.Context, pingTarget, int, listingPlan) pingResult {
		t.Error("should not measure TCP")
		return pingResult{}
	}
	err := r.run(context.Background(), panel.New(config.Config{PanelURL: srv.URL, Token: "test"}), IPv4Job{ListingJob: ListingJob{ID: 1, Kind: "nat"}, RequestID: "test", Targets: []pingTarget{{ID: "bj-ct"}}})
	if err != nil || result["error"] == nil || result["method"] != nil {
		t.Fatalf("result=%+v, err=%v", result, err)
	}
}

func TestIPv4CheckReportsLocalErrors(t *testing.T) {
	w := &waiters{m: map[echoKey]chan time.Time{}}
	failure := errors.New("send failed")
	rtts, err := pingWithResult(w, func([]byte, net.IP) error { return failure }, net.ParseIP("198.51.100.20"), net.ParseIP("203.0.113.1"), 2)
	if !errors.Is(err, failure) || len(rtts) != 0 || len(w.m) != 0 {
		t.Fatalf("rtts=%v err=%v waiters=%d", rtts, err, len(w.m))
	}
	result := measureIPv4(context.Background(), pingTarget{ID: "invalid", Host: ""}, 2, listingPlan{icmp: true})
	if result.Error == "" {
		t.Fatal("DNS error should not be reported as packet loss")
	}
}

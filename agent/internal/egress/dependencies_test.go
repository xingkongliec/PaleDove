package egress

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/panel"
)

func TestEgressDependencyInstallBeforeNetworkChanges(t *testing.T) {
	f := &fakeRunner{fail: []string{"ip rule del", "ip link show"}}
	m := testManager(t, f)
	defer m.stopGateways(nil)
	installed := false
	m.run = func(name string, args ...string) (string, error) {
		if name == "wg" && !installed {
			return "", fmt.Errorf("wg: %w", exec.ErrNotFound)
		}
		return f.run(name, args...)
	}
	m.installTools = func(tools []string) error {
		if !reflect.DeepEqual(tools, []string{"wg"}) {
			t.Fatalf("unexpected dependencies %v", tools)
		}
		for _, cmd := range f.cmds {
			if cmd != "ip -Version" && cmd != "iptables --version" {
				t.Fatalf("modified network before dependencies were ready: %s", cmd)
			}
		}
		installed = true
		return nil
	}
	if err := m.apply(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	if !installed || m.applied != 3 {
		t.Fatal("did not install and apply")
	}
	f.has(t, "ip link add dev pdwg1 type wireguard")
}

func TestEgressDependencyFailureRetriesSameVersionAfterManualInstall(t *testing.T) {
	f := &fakeRunner{fail: []string{"ip rule del", "ip link show"}}
	m := testManager(t, f)
	defer m.stopGateways(nil)
	missing := true
	installs := 0
	m.run = func(name string, args ...string) (string, error) {
		if name == "wg" && missing {
			return "", fmt.Errorf("wg: %w", exec.ErrNotFound)
		}
		return f.run(name, args...)
	}
	m.installTools = func([]string) error { installs++; return errors.New("package mirror unavailable") }
	err := m.apply(sampleConfig())
	if err == nil || !strings.Contains(err.Error(), "wireguard-tools") || !strings.Contains(err.Error(), "自动重试") {
		t.Fatalf("missing actionable error: %v", err)
	}
	if m.applied != -1 || m.needsApply(3) || !m.needsApply(4) {
		t.Fatal("failure was marked applied or retry delay was not respected")
	}
	if entries, _ := os.ReadDir(m.dir); len(entries) != 0 {
		t.Fatal("private key was written before dependencies were ready")
	}
	for _, cmd := range f.cmds {
		if cmd != "ip -Version" && cmd != "iptables --version" {
			t.Fatalf("network changed after dependency failure: %s", cmd)
		}
	}
	m.lastAttempt = time.Now().Add(-egressRetryEvery)
	if !m.needsApply(3) {
		t.Fatal("same failed version will never retry")
	}
	if err := m.apply(sampleConfig()); err == nil || installs != 1 {
		t.Fatal("repeated failed package installation was not throttled")
	}
	missing = false // Manual installation is detected even during package-install cooldown.
	if err := m.apply(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	if m.applied != 3 || m.applyError != nil || m.needsApply(3) {
		t.Fatal("same version did not recover after tools became available")
	}
}

func TestEgressDoesNotInstallWireguardForProxyOrDisabledConfig(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		f := &fakeRunner{fail: []string{"ip rule del"}}
		m := testManager(t, f)
		m.run = func(name string, args ...string) (string, error) {
			if name == "wg" {
				t.Fatal("WireGuard was probed for a proxy-only or disabled configuration")
			}
			return f.run(name, args...)
		}
		m.installTools = func([]string) error { t.Fatal("unneeded packages installed"); return nil }
		cfg := sampleConfig()
		cfg.Enabled = enabled
		cfg.Egresses = cfg.Egresses[1:]
		cfg.Instances = cfg.Instances[1:]
		if err := m.apply(cfg); err != nil {
			t.Fatal(err)
		}
		m.stopGateways(nil)
	}
}

func TestEgressRetriesFailedTunnelConfiguration(t *testing.T) {
	f := &fakeRunner{fail: []string{"ip rule del", "ip link show", "wg set"}}
	m := testManager(t, f)
	defer m.stopGateways(nil)
	if err := m.apply(sampleConfig()); err == nil || m.applied != -1 || m.applyError == nil {
		t.Fatal("failed tunnel configuration was marked applied")
	}
	f.fail = []string{"ip rule del", "ip link show"}
	if err := m.apply(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	if m.applied != 3 || m.applyError != nil {
		t.Fatal("retry did not clear failed apply state")
	}
	f.has(t, "ip rule add from 10.88.0.5/32 lookup 52001 priority 21000")
}

func TestEgressKeepsApplyErrorUntilSuccessfulRetry(t *testing.T) {
	reports := make(chan map[string]any, 3)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/agent/nodes/egress":
			json.NewEncoder(w).Encode(sampleConfig())
		case "/api/agent/nodes/egress-status":
			var report map[string]any
			if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			reports <- report
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	f := &fakeRunner{fail: []string{"ip rule del", "ip link show"}}
	m := testManager(t, f)
	defer m.stopGateways(nil)
	missing := true
	m.run = func(name string, args ...string) (string, error) {
		if name == "wg" && missing {
			return "", exec.ErrNotFound
		}
		return f.run(name, args...)
	}
	m.installTools = func([]string) error { return errors.New("package mirror unavailable") }
	c := panel.New(config.Config{PanelURL: srv.URL, Token: "test"})
	for _, fetch := range []bool{true, false} {
		if err := m.sync(context.Background(), c, fetch); err != nil {
			t.Fatal(err)
		}
		report := <-reports
		if report["version"] != float64(3) || !strings.Contains(fmt.Sprint(report["error"]), "wireguard-tools") {
			t.Fatalf("apply failure was lost in report: %v", report)
		}
	}
	missing = false
	if err := m.sync(context.Background(), c, true); err != nil {
		t.Fatal(err)
	}
	if report := <-reports; report["error"] != nil {
		t.Fatalf("successful retry still reports apply failure: %v", report)
	}
}

func TestEgressSyncDoesNotBlockHeartbeatWhileInstalling(t *testing.T) {
	m := New()
	m.running.Store(true)
	m.mu.Lock() // A dependency installation holds the configuration lock.
	defer m.mu.Unlock()
	done := make(chan struct{})
	go func() {
		m.MaybeSync(context.Background(), nil, &Hint{Version: 3})
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("heartbeat waited for an ongoing egress sync")
	}
}

func TestEgressPackagePlans(t *testing.T) {
	for _, tc := range []struct{ manager, packages string }{
		{"apt-get", "iproute2 iptables wireguard-tools"},
		{"dnf", "iproute iptables wireguard-tools"},
		{"yum", "iproute iptables wireguard-tools"},
		{"apk", "iproute2 iptables wireguard-tools"},
	} {
		t.Run(tc.manager, func(t *testing.T) {
			lookup := func(name string) (string, error) {
				if name == tc.manager {
					return name, nil
				}
				return "", exec.ErrNotFound
			}
			plan, err := egressInstallPlan([]string{"ip", "iptables", "wg"}, lookup)
			if err != nil {
				t.Fatal(err)
			}
			if got := strings.Join(plan[len(plan)-1], " "); !strings.HasSuffix(got, tc.packages) || !strings.HasPrefix(got, tc.manager+" ") {
				t.Fatalf("wrong package plan %v", plan)
			}
			if tc.manager == "apt-get" && (len(plan) != 2 || !strings.Contains(strings.Join(plan[0], " "), "update")) {
				t.Fatal("apt metadata was not refreshed")
			}
		})
	}
	if _, err := egressInstallPlan([]string{"wg"}, func(string) (string, error) { return "", exec.ErrNotFound }); err == nil {
		t.Fatal("unsupported host accepted")
	}
}

func TestEgressCommandPreservesMissingExecutableError(t *testing.T) {
	_, err := runHostCommand("paledove-nonexistent-egress-tool")
	if !errors.Is(err, exec.ErrNotFound) {
		t.Fatalf("lost executable-not-found error: %v", err)
	}
}

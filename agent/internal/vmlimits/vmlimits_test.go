package vmlimits

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/paledove/agent/internal/hostinfo"
)

func TestParseVMLimits(t *testing.T) {
	got := parseVMLimits(strings.NewReader("default vm1 500000 -\ndefault vm2 - 50\nbad line\ndefault vm3 abc 1\n"))
	if len(got) != 2 || got[0].Quota != "500000" || got[0].Weight != unsetLimit || got[1].Quota != unsetLimit || got[1].Weight != "50" {
		t.Fatalf("got %+v", got)
	}
}

func useProcRoot(t *testing.T) string {
	dir := t.TempDir()
	old := hostinfo.ProcRoot
	hostinfo.ProcRoot = dir
	t.Cleanup(func() { hostinfo.ProcRoot = old })
	return dir
}

func TestInScope(t *testing.T) {
	dir := useProcRoot(t)
	os.Mkdir(filepath.Join(dir, "42"), 0o755)
	os.WriteFile(filepath.Join(dir, "42", "cgroup"), []byte("0::/system.slice/paledove-vm-vm1.scope\n"), 0o644)
	if !inScope(42, "paledove-vm-vm1.scope") || inScope(42, "paledove-vm-vm2.scope") {
		t.Fatal("inScope")
	}
}

// 不在 scope 中时创建 scope，已在 scope 中且限制不变时不重复调用；面板不再要求的 scope 被解除
func TestLimiterApplyAndRelease(t *testing.T) {
	dir := useProcRoot(t)
	os.Mkdir(filepath.Join(dir, "42"), 0o755)
	os.WriteFile(filepath.Join(dir, "42", "cgroup"), []byte("0::/lxc.payload\n"), 0o644)

	var calls []string
	v := New(nil)
	v.run = func(name string, args ...string) (string, error) {
		calls = append(calls, name+" "+strings.Join(args, " "))
		if name == "systemctl" && len(args) > 0 && args[0] == "list-units" {
			return "paledove-vm-vm1.scope loaded active running\npaledove-vm-old.scope loaded active running\n", nil
		}
		return "", nil
	}
	l := vmLimit{Project: "default", Name: "vm1", Quota: "500000", Weight: unsetLimit}
	v.apply(l, 42)
	if !strings.Contains(strings.Join(calls, "\n"), "StartTransientUnit ssa(sv)a(sa(sv)) paledove-vm-vm1.scope fail 4 PIDs au 1 42 Before as 2") {
		t.Fatalf("expected StartTransientUnit, got %v", calls)
	}
	// 进程已进入 scope，限制不变：不再调用
	os.WriteFile(filepath.Join(dir, "42", "cgroup"), []byte("0::/system.slice/paledove-vm-vm1.scope\n"), 0o644)
	calls = nil
	v.apply(l, 42)
	if len(calls) != 0 {
		t.Fatalf("expected no calls, got %v", calls)
	}
	// 限制变化：只更新属性
	l.Quota = "250000"
	v.apply(l, 42)
	if len(calls) != 1 || !strings.Contains(calls[0], "SetUnitProperties sba(sv) paledove-vm-vm1.scope true 2 CPUQuotaPerSecUSec t 250000") {
		t.Fatalf("expected SetUnitProperties, got %v", calls)
	}
	calls = nil
	v.release(map[string]bool{"paledove-vm-vm1.scope": true})
	joined := strings.Join(calls, "\n")
	if !strings.Contains(joined, "SetUnitProperties sba(sv) paledove-vm-old.scope true 2 CPUQuotaPerSecUSec t "+unsetLimit) || strings.Contains(joined, "paledove-vm-vm1.scope true") {
		t.Fatalf("release calls %v", calls)
	}
	// 已解除的不再重复解除
	calls = nil
	v.release(map[string]bool{"paledove-vm-vm1.scope": true})
	if strings.Contains(strings.Join(calls, "\n"), "SetUnitProperties") {
		t.Fatalf("released twice: %v", calls)
	}
}

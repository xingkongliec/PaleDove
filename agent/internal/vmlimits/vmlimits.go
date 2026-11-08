// Package vmlimits 限制虚拟机的 CPU（把 QEMU 进程放入 systemd scope，设置 CPUQuota / CPUWeight）。
package vmlimits

// 虚拟机 CPU 限制（与之前的 bash 版上报程序行为一致）：
// 面板通过 /api/agent/nodes/vm-limits 下发「项目 实例名 CPU 配额(微秒/秒) CPU 权重」（未设置的项为 -），
// Agent 把虚拟机的 QEMU 进程放入 systemd scope（paledove-vm-<实例名>.scope），用 CPUQuota 与 CPUWeight 限制。
// scope 排在 incus 之前（Before=），宿主机关机时等 Incus 正常关闭虚拟机后才结束。
// 面板取消了限制（或实例已删除）的虚拟机：解除此前设置的限制。

// systemd 中表示「不限制」的值（uint64 最大值）
import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"github.com/paledove/agent/internal/hostinfo"
	"github.com/paledove/agent/internal/incus"
	"github.com/paledove/agent/internal/panel"
)

const unsetLimit = "18446744073709551615"

var systemdBus = []string{"org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager"}

// vmLimit 为面板下发的一行
type vmLimit struct {
	Project string
	Name    string
	Quota   string // 微秒/秒，或 unsetLimit
	Weight  string // 1~10000，或 unsetLimit
}

type Limiter struct {
	incus *incus.Client
	// 每个 scope 最近一次应用的「PID 配额 权重」，相同时不重复调用；none 表示已解除
	applied map[string]string
	// run 执行外部命令（测试时替换）
	run func(name string, args ...string) (string, error)
}

func New(inc *incus.Client) *Limiter {
	return &Limiter{incus: inc, applied: map[string]string{}, run: runCommand}
}

func runCommand(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).CombinedOutput()
	return string(out), err
}

// parseVMLimits 解析面板下发的文本
func parseVMLimits(r io.Reader) []vmLimit {
	var out []vmLimit
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 4 || f[1] == "" {
			continue
		}
		l := vmLimit{Project: f[0], Name: f[1], Quota: f[2], Weight: f[3]}
		if l.Quota == "-" {
			l.Quota = unsetLimit
		} else if _, err := strconv.ParseUint(l.Quota, 10, 64); err != nil {
			continue
		}
		if l.Weight == "-" {
			l.Weight = unsetLimit
		} else if _, err := strconv.ParseUint(l.Weight, 10, 64); err != nil {
			continue
		}
		out = append(out, l)
	}
	return out
}

func scopeName(instance string) string { return "paledove-vm-" + instance + ".scope" }

// Sync 拉取限制并应用；宿主机上没有 busctl（非 systemd）时跳过
func (v *Limiter) Sync(ctx context.Context, c *panel.Client) error {
	if _, err := exec.LookPath("busctl"); err != nil {
		return nil
	}
	res, err := c.Request(ctx, http.MethodGet, "/api/agent/nodes/vm-limits", nil)
	if err != nil {
		return err
	}
	if res.Status != http.StatusOK {
		return fmt.Errorf("面板返回 %d", res.Status)
	}
	// 签名配置下只应用签名有效的限制
	if !c.Trusted(res) {
		return fmt.Errorf("虚拟机限制的回复未通过签名校验")
	}
	limits := parseVMLimits(strings.NewReader(string(res.Body)))
	want := map[string]bool{}
	for _, l := range limits {
		want[scopeName(l.Name)] = true
		pid, err := v.incus.InstancePID(ctx, l.Project, l.Name)
		if err != nil || pid <= 0 {
			continue
		}
		v.apply(l, pid)
	}
	v.release(want)
	return nil
}

// apply 把虚拟机进程放入 scope 并设置限制；已在 scope 中时只更新限制
func (v *Limiter) apply(l vmLimit, pid int) {
	unit := scopeName(l.Name)
	key := fmt.Sprintf("%d %s %s", pid, l.Quota, l.Weight)
	if inScope(pid, unit) {
		if v.applied[unit] == key {
			return
		}
		if _, err := v.busctl("SetUnitProperties", "sba(sv)", unit, "true", "2", "CPUQuotaPerSecUSec", "t", l.Quota, "CPUWeight", "t", l.Weight); err != nil {
			return
		}
	} else {
		// 虚拟机重启后 PID 变化：旧 scope 已结束，重新创建
		_, _ = v.run("systemctl", "reset-failed", unit)
		pidStr := strconv.Itoa(pid)
		if _, err := v.busctl("StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "4", "PIDs", "au", "1", pidStr,
			"Before", "as", "2", "incus.service", "incus-startup.service",
			"CPUQuotaPerSecUSec", "t", l.Quota, "CPUWeight", "t", l.Weight, "0"); err != nil {
			// 旧版 systemd 不支持在 scope 上设置 Before
			if _, err := v.busctl("StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "3", "PIDs", "au", "1", pidStr,
				"CPUQuotaPerSecUSec", "t", l.Quota, "CPUWeight", "t", l.Weight, "0"); err != nil {
				return
			}
		}
	}
	v.applied[unit] = key
}

// release 解除面板已不再要求限制的 scope
func (v *Limiter) release(want map[string]bool) {
	out, err := v.run("systemctl", "list-units", "--type=scope", "--all", "--plain", "--no-legend", "paledove-vm-*")
	if err != nil {
		return
	}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || !strings.HasPrefix(f[0], "paledove-vm-") {
			continue
		}
		unit := f[0]
		if want[unit] || v.applied[unit] == "none" {
			continue
		}
		if _, err := v.busctl("SetUnitProperties", "sba(sv)", unit, "true", "2", "CPUQuotaPerSecUSec", "t", unsetLimit, "CPUWeight", "t", unsetLimit); err == nil {
			v.applied[unit] = "none"
		}
	}
}

func (v *Limiter) busctl(method string, args ...string) (string, error) {
	return v.run("busctl", append(append([]string{"call"}, systemdBus...), append([]string{method}, args...)...)...)
}

// inScope 判断进程是否已在指定的 systemd scope 中（/proc/<pid>/cgroup 以 /<unit> 结尾）
func inScope(pid int, unit string) bool {
	data, err := os.ReadFile(fmt.Sprintf("%s/%d/cgroup", hostinfo.ProcRoot, pid))
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasSuffix(strings.TrimSpace(line), "/"+unit) {
			return true
		}
	}
	return false
}

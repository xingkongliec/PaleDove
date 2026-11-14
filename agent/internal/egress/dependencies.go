package egress

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// systemd services may have a narrower PATH than an interactive root shell.
func hostCommandPath(name string) (string, error) {
	path, err := exec.LookPath(name)
	if err == nil || runtime.GOOS != "linux" {
		return path, err
	}
	for _, dir := range []string{"/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
		candidate := filepath.Join(dir, name)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() && info.Mode()&0o111 != 0 {
			return candidate, nil
		}
	}
	return "", err
}

func runHostCommand(name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return runHostCommandContext(ctx, name, args...)
}

func runHostCommandContext(ctx context.Context, name string, args ...string) (string, error) {
	path, err := hostCommandPath(name)
	if err != nil {
		return "", fmt.Errorf("%s: %w", name, err)
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	if runtime.GOOS == "linux" {
		cmd.Env = append(cmd.Env, "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:"+os.Getenv("PATH"))
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return string(out), fmt.Errorf("%s %s: %w %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

func (m *Manager) ensureTools(cfg *egressConfig) error {
	if !cfg.Enabled || len(cfg.Egresses) == 0 {
		return nil
	}
	tools := []string{"ip", "iptables"}
	for _, e := range cfg.Egresses {
		if e.Type == "WIREGUARD" {
			tools = append(tools, "wg")
			break
		}
	}
	var missing []string
	for _, tool := range tools {
		if err := m.probeTool(tool); errors.Is(err, exec.ErrNotFound) {
			missing = append(missing, tool)
		}
	}
	if len(missing) == 0 {
		m.toolsError = nil
		return nil
	}
	if m.toolsError != nil && time.Since(m.toolsAttempt) < 5*time.Minute {
		return m.toolsError
	}
	log.Printf("智能分流缺少宿主机依赖 %s，正在安装", strings.Join(missing, ", "))
	err := m.installTools(missing)
	if err == nil {
		for _, tool := range missing {
			if probeErr := m.probeTool(tool); errors.Is(probeErr, exec.ErrNotFound) {
				err = fmt.Errorf("安装后仍找不到 %s", tool)
				break
			}
		}
	}
	m.toolsAttempt = time.Now()
	if err != nil {
		m.toolsError = fmt.Errorf("宿主机缺少出口依赖 %s，自动安装失败：%w；Debian/Ubuntu 可执行 apt-get update && apt-get install -y iproute2 iptables wireguard-tools，完成后 Agent 会自动重试", strings.Join(missing, ", "), err)
		return m.toolsError
	}
	m.toolsError = nil
	return nil
}

func (m *Manager) probeTool(tool string) error {
	flag := "--version"
	if tool == "ip" {
		flag = "-Version"
	}
	_, err := m.run(tool, flag)
	return err
}

func egressInstallPlan(tools []string, lookup func(string) (string, error)) ([][]string, error) {
	for _, manager := range []string{"apt-get", "dnf", "yum", "apk"} {
		if _, err := lookup(manager); err != nil {
			continue
		}
		var packages []string
		for _, tool := range tools {
			switch tool {
			case "ip":
				if manager == "dnf" || manager == "yum" {
					packages = append(packages, "iproute")
				} else {
					packages = append(packages, "iproute2")
				}
			case "iptables":
				packages = append(packages, "iptables")
			case "wg":
				packages = append(packages, "wireguard-tools")
			default:
				return nil, fmt.Errorf("未知的出口依赖 %q", tool)
			}
		}
		switch manager {
		case "apt-get":
			return [][]string{{manager, "-o", "DPkg::Lock::Timeout=30", "update", "-qq"}, append([]string{manager, "-o", "DPkg::Lock::Timeout=30", "install", "-y", "--no-install-recommends"}, packages...)}, nil
		case "apk":
			return [][]string{append([]string{manager, "add", "--no-cache"}, packages...)}, nil
		default:
			return [][]string{append([]string{manager, "install", "-y"}, packages...)}, nil
		}
	}
	return nil, fmt.Errorf("未找到 apt-get、dnf、yum 或 apk，请手动安装出口依赖")
}

func installEgressTools(tools []string) error {
	if runtime.GOOS != "linux" || os.Geteuid() != 0 {
		return fmt.Errorf("自动安装出口依赖需要 Linux root 权限")
	}
	plan, err := egressInstallPlan(tools, hostCommandPath)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for _, command := range plan {
		if _, err := runHostCommandContext(ctx, command[0], command[1:]...); err != nil {
			return err
		}
	}
	return nil
}

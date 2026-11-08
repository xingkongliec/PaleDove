// Package traffic 从宿主机 veth / tap 统计实例流量，不依赖虚拟机内的代理。
package traffic

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/paledove/agent/internal/incus"
)

type Targets struct {
	Project string   `json:"project"`
	Names   []string `json:"names"`
}
type Counter struct {
	Generation string `json:"generation"`
	Rx         uint64 `json:"rx"`
	Tx         uint64 `json:"tx"`
}
type Sample struct {
	Name       string             `json:"name"`
	Interfaces map[string]Counter `json:"interfaces"`
}

var safeInterface = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`)

// ReadCounter 宿主机 TX 为实例入站，RX 为实例出站；ifindex 和 boot-id 区分网卡重建。
func ReadCounter(root, boot, host, uuid string) (Counter, error) {
	if !safeInterface.MatchString(host) {
		return Counter{}, fmt.Errorf("invalid interface")
	}
	read := func(name string) (uint64, error) {
		b, err := os.ReadFile(filepath.Join(root, host, name))
		if err != nil {
			return 0, err
		}
		return strconv.ParseUint(strings.TrimSpace(string(b)), 10, 64)
	}
	idx, err := read("ifindex")
	if err != nil {
		return Counter{}, err
	}
	rx, err := read("statistics/tx_bytes")
	if err != nil {
		return Counter{}, err
	}
	tx, err := read("statistics/rx_bytes")
	if err != nil {
		return Counter{}, err
	}
	return Counter{Generation: fmt.Sprintf("%s:%s:%d", boot, uuid, idx), Rx: rx, Tx: tx}, nil
}

func Collect(ctx context.Context, client *incus.Client, targets *Targets) []Sample {
	if targets == nil || len(targets.Names) == 0 {
		return nil
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return nil
	}
	var rows []struct {
		Name    string                       `json:"name"`
		Config  map[string]string            `json:"expanded_config"`
		Devices map[string]map[string]string `json:"expanded_devices"`
	}
	if client.Get(ctx, "/1.0/instances?recursion=1&project="+url.QueryEscape(targets.Project), &rows) != nil {
		return nil
	}
	wanted := map[string]bool{}
	for _, n := range targets.Names {
		wanted[n] = true
	}
	out := []Sample{}
	for _, r := range rows {
		if !wanted[r.Name] {
			continue
		}
		sample := Sample{Name: r.Name, Interfaces: map[string]Counter{}}
		for _, nic := range []string{"eth0", "eth1"} {
			if r.Devices[nic]["type"] != "nic" {
				continue
			}
			host := r.Config["volatile."+nic+".host_name"]
			if c, err := ReadCounter("/sys/class/net", strings.TrimSpace(string(boot)), host, r.Config["volatile.uuid"]); err == nil {
				sample.Interfaces[nic] = c
			}
		}
		if len(sample.Interfaces) > 0 {
			out = append(out, sample)
		}
	}
	return out
}

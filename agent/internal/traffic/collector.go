// Package traffic 在宿主机网卡上只累计公网通信，不依赖虚拟机内的代理。
package traffic

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/paledove/agent/internal/incus"
)

const Scope = "public-v1"

type Status struct {
	Scope string `json:"scope"`
	Ready bool   `json:"ready"`
	Error string `json:"error,omitempty"`
}

type Targets struct {
	Project      string   `json:"project"`
	Names        []string `json:"names"`
	Scope        string   `json:"scope"`
	ExcludeCIDRs []string `json:"excludeCidrs"`
}
type Counter struct {
	Generation string `json:"generation"`
	Rx         uint64 `json:"rx"`
	Tx         uint64 `json:"tx"`
}
type Sample struct {
	Name       string             `json:"name"`
	Scope      string             `json:"scope"`
	Interfaces map[string]Counter `json:"interfaces"`
}

type device struct{ name, nic, host, id string }
type instance struct {
	Name    string                       `json:"name"`
	Status  string                       `json:"status"`
	Config  map[string]string            `json:"expanded_config"`
	Devices map[string]map[string]string `json:"expanded_devices"`
}

var safeInterface = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,15}$`)

// 排除私网、共享地址、回环、链路本地、组播及保留地址；IPv6 的 ULA / NDP 同样不计费。
var privateCIDRs = []string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
	"198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "::ffff:0:0/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
}

func exclusionPrefixes(values []string) ([]string, []string, error) {
	var prefixes []netip.Prefix
	for _, value := range append(append([]string{}, privateCIDRs...), values...) {
		for _, part := range strings.FieldsFunc(value, func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
			p, err := netip.ParsePrefix(part)
			if err != nil {
				a, e := netip.ParseAddr(part)
				if e != nil {
					return nil, nil, fmt.Errorf("无效的内网排除地址 %q", part)
				}
				p = netip.PrefixFrom(a, a.BitLen())
			}
			if p.Bits() == 0 {
				return nil, nil, fmt.Errorf("内网排除网段不能是默认路由")
			}
			prefixes = append(prefixes, p.Masked())
		}
	}
	sort.Slice(prefixes, func(i, j int) bool {
		if prefixes[i].Bits() != prefixes[j].Bits() {
			return prefixes[i].Bits() < prefixes[j].Bits()
		}
		return prefixes[i].Addr().Less(prefixes[j].Addr())
	})
	var merged []netip.Prefix
	var v4, v6 []string
	for _, p := range prefixes {
		covered := false
		for _, old := range merged {
			if old.Addr().BitLen() == p.Addr().BitLen() && old.Contains(p.Addr()) {
				covered = true
				break
			}
		}
		if covered {
			continue
		}
		merged = append(merged, p)
		if p.Addr().Is4() {
			v4 = append(v4, p.String())
		} else {
			v6 = append(v6, p.String())
		}
	}
	return v4, v6, nil
}

func localAddresses() ([]string, error) {
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}
	var values []string
	for _, address := range addresses {
		p, err := netip.ParsePrefix(address.String())
		if err != nil {
			return nil, err
		}
		values = append(values, p.Addr().String())
	}
	return values, nil
}

type Collector struct {
	run       func(context.Context, string, ...string) ([]byte, error)
	addresses func() ([]string, error)
	root      string
	bootFile  string
}

func New() *Collector {
	return &Collector{run: runNFT, addresses: localAddresses, root: "/sys/class/net", bootFile: "/proc/sys/kernel/random/boot_id"}
}

func (c *Collector) Collect(ctx context.Context, client *incus.Client, targets *Targets) ([]Sample, error) {
	if targets == nil {
		return nil, nil
	}
	if targets.Scope != Scope {
		return nil, fmt.Errorf("面板未启用公网流量计费协议")
	}
	boot, err := os.ReadFile(c.bootFile)
	if err != nil {
		return nil, err
	}
	var rows []instance
	if err := client.Get(ctx, "/1.0/instances?recursion=1&project="+url.QueryEscape(targets.Project), &rows); err != nil {
		return nil, err
	}
	excluded, err := c.addresses()
	if err != nil {
		return nil, err
	}
	excluded = append(excluded, targets.ExcludeCIDRs...)
	wanted := map[string]bool{}
	for _, n := range targets.Names {
		wanted[n] = true
	}
	var devices []device
	for _, row := range rows {
		for _, d := range row.Devices {
			if d["type"] != "nic" {
				continue
			}
			for _, key := range []string{"ipv4.address", "ipv6.address", "ipv4.routes", "ipv6.routes"} {
				if value := d[key]; value != "" && value != "none" && value != "auto" {
					excluded = append(excluded, value)
				}
			}
		}
		if !wanted[row.Name] || row.Status != "Running" {
			continue
		}
		for _, nic := range []string{"eth0", "eth1"} {
			if row.Devices[nic]["type"] != "nic" {
				continue
			}
			host := row.Config["volatile."+nic+".host_name"]
			if !safeInterface.MatchString(host) {
				return nil, fmt.Errorf("实例 %s 缺少有效的宿主机网卡", row.Name)
			}
			idx, err := os.ReadFile(filepath.Join(c.root, host, "ifindex"))
			if err != nil {
				return nil, err
			}
			if _, err := strconv.ParseUint(strings.TrimSpace(string(idx)), 10, 64); err != nil {
				return nil, err
			}
			hash := sha256.Sum256([]byte(string(boot) + ":" + row.Config["volatile.uuid"] + ":" + row.Name + ":" + nic + ":" + host + ":" + string(idx)))
			devices = append(devices, device{row.Name, nic, host, "p" + hex.EncodeToString(hash[:12])})
		}
	}
	return c.collectDevices(ctx, devices, excluded)
}

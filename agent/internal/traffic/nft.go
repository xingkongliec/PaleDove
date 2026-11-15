package traffic

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

const table = "paledove_traffic"

type nftCounter struct {
	Name    string `json:"name"`
	Bytes   uint64 `json:"bytes"`
	Comment string `json:"comment"`
}
type nftObject struct {
	Table *struct {
		Comment string `json:"comment"`
	} `json:"table"`
	Counter *nftCounter `json:"counter"`
	Chain   *struct {
		Name string `json:"name"`
	} `json:"chain"`
	Set *struct {
		Name string `json:"name"`
	} `json:"set"`
}
type nftState struct {
	Nftables []nftObject `json:"nftables"`
}

func runNFT(ctx context.Context, input string, args ...string) ([]byte, error) {
	path, err := exec.LookPath("nft")
	if err != nil {
		// systemd 的 PATH 可能不含 /usr/sbin。
		for _, dir := range []string{"/usr/sbin", "/usr/bin", "/sbin", "/bin"} {
			if p, e := exec.LookPath(filepath.Join(dir, "nft")); e == nil {
				path, err = p, nil
				break
			}
		}
	}
	if err != nil {
		return nil, fmt.Errorf("缺少 nftables，请安装 nftables 后重启 Agent：%w", err)
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stdin = strings.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("nft 公网计数失败（需要 Linux 5.16+、nftables 1.0.1+）：%w %s", err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}

func (c *Collector) read(ctx context.Context) (nftState, bool, error) {
	var state nftState
	// 不能把权限不足或其他读取错误当成不存在而重置计数器。
	out, err := c.run(ctx, "", "-j", "list", "tables", "netdev")
	if err != nil {
		return state, false, err
	}
	var tables struct {
		Nftables []struct {
			Table *struct {
				Name string `json:"name"`
			} `json:"table"`
		} `json:"nftables"`
	}
	if err := json.Unmarshal(out, &tables); err != nil {
		return state, false, err
	}
	found := false
	for _, row := range tables.Nftables {
		if row.Table != nil && row.Table.Name == table {
			found = true
		}
	}
	if !found {
		return state, false, nil
	}
	out, err = c.run(ctx, "", "-j", "list", "table", "netdev", table)
	if err != nil {
		return state, true, err
	}
	if err := json.Unmarshal(out, &state); err != nil {
		return state, true, err
	}
	for _, row := range state.Nftables {
		if row.Table != nil && row.Table.Comment == Scope {
			return state, true, nil
		}
	}
	return state, true, fmt.Errorf("nft 表 %s 不属于公网流量采集器", table)
}

func (c *Collector) collectDevices(ctx context.Context, devices []device, excluded []string) ([]Sample, error) {
	v4, v6, err := exclusionPrefixes(excluded)
	if err != nil {
		return nil, err
	}
	state, exists, err := c.read(ctx)
	if err != nil {
		return nil, err
	}
	counters, chains, sets := map[string]nftCounter{}, map[string]bool{}, map[string]bool{}
	for _, row := range state.Nftables {
		if row.Counter != nil {
			counters[row.Counter.Name] = *row.Counter
		}
		if row.Chain != nil {
			chains[row.Chain.Name] = true
		}
		if row.Set != nil {
			sets[row.Set.Name] = true
		}
	}
	var script strings.Builder
	if !exists {
		fmt.Fprintf(&script, "add table netdev %s { comment \"%s\"; }\n", table, Scope)
	}
	for _, set := range []struct {
		name, kind string
		values     []string
	}{{"internal4", "ipv4_addr", v4}, {"internal6", "ipv6_addr", v6}} {
		if !sets[set.name] {
			fmt.Fprintf(&script, "add set netdev %s %s { type %s; flags interval; auto-merge; }\n", table, set.name, set.kind)
		}
		fmt.Fprintf(&script, "flush set netdev %s %s\nadd element netdev %s %s { %s }\n", table, set.name, table, set.name, strings.Join(set.values, ", "))
	}
	wanted := map[string]bool{}
	for _, d := range devices {
		if !safeInterface.MatchString(d.host) {
			return nil, fmt.Errorf("无效的宿主机网卡")
		}
		_, rxExists := counters[d.id+"_rx"]
		_, txExists := counters[d.id+"_tx"]
		if rxExists != txExists {
			// 上报共用一个代次，单侧计数器丢失时两侧一同重建，避免另一侧的历史累计重复入账。
			for _, suffix := range []string{"rx", "tx"} {
				name := d.id + "_" + suffix
				if chains[name] {
					fmt.Fprintf(&script, "flush chain netdev %s %s\ndelete chain netdev %s %s\n", table, name, table, name)
					delete(chains, name)
				}
				if _, ok := counters[name]; ok {
					fmt.Fprintf(&script, "delete counter netdev %s %s\n", table, name)
					delete(counters, name)
				}
			}
		}
		for _, direction := range []struct{ suffix, hook, address string }{{"rx", "egress", "saddr"}, {"tx", "ingress", "daddr"}} {
			name := d.id + "_" + direction.suffix
			wanted[name] = true
			counter, hasCounter := counters[name]
			if !hasCounter {
				var generation [16]byte
				if _, err := rand.Read(generation[:]); err != nil {
					return nil, err
				}
				fmt.Fprintf(&script, "add counter netdev %s %s { comment \"%s\"; }\n", table, name, hex.EncodeToString(generation[:]))
			} else if counter.Comment == "" {
				return nil, fmt.Errorf("公网计数器缺少代次")
			}
			if !chains[name] || !hasCounter {
				if chains[name] {
					fmt.Fprintf(&script, "flush chain netdev %s %s\ndelete chain netdev %s %s\n", table, name, table, name)
				}
				fmt.Fprintf(&script, "add chain netdev %s %s { type filter hook %s device \"%s\" priority -500; policy accept; }\n", table, name, direction.hook, d.host)
				fmt.Fprintf(&script, "add rule netdev %s %s meta pkttype { broadcast, multicast } return\n", table, name)
				fmt.Fprintf(&script, "add rule netdev %s %s ip daddr { 224.0.0.0/4, 255.255.255.255 } return\n", table, name)
				fmt.Fprintf(&script, "add rule netdev %s %s ip6 daddr ff00::/8 return\n", table, name)
				// 仅计数，没有 accept/drop verdict，不改变宿主机防火墙或转发策略。
				fmt.Fprintf(&script, "add rule netdev %s %s ip %s != @internal4 counter name %s\n", table, name, direction.address, name)
				fmt.Fprintf(&script, "add rule netdev %s %s ip6 %s != @internal6 counter name %s\n", table, name, direction.address, name)
			}
		}
	}
	for name := range chains {
		if !wanted[name] {
			fmt.Fprintf(&script, "flush chain netdev %s %s\ndelete chain netdev %s %s\n", table, name, table, name)
		}
	}
	for name := range counters {
		if !wanted[name] {
			fmt.Fprintf(&script, "delete counter netdev %s %s\n", table, name)
		}
	}
	if script.Len() > 0 {
		// nft -f 的批次原子生效；更新排除地址不会重建现有计数器。
		if _, err := c.run(ctx, script.String(), "-f", "-"); err != nil {
			return nil, err
		}
		state, _, err = c.read(ctx)
		if err != nil {
			return nil, err
		}
		counters = map[string]nftCounter{}
		for _, row := range state.Nftables {
			if row.Counter != nil {
				counters[row.Counter.Name] = *row.Counter
			}
		}
	}
	byName := map[string]*Sample{}
	for _, d := range devices {
		rx, rxOK := counters[d.id+"_rx"]
		tx, txOK := counters[d.id+"_tx"]
		if !rxOK || !txOK || rx.Comment == "" || tx.Comment == "" {
			return nil, fmt.Errorf("公网计数器未就绪")
		}
		if byName[d.name] == nil {
			byName[d.name] = &Sample{Name: d.name, Scope: Scope, Interfaces: map[string]Counter{}}
		}
		byName[d.name].Interfaces[d.nic] = Counter{Generation: rx.Comment + ":" + tx.Comment, Rx: rx.Bytes, Tx: tx.Bytes}
	}
	var out []Sample
	for _, sample := range byName {
		out = append(out, *sample)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

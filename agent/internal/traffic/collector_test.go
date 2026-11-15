package traffic

import (
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"testing"
)

func TestInternalAndLocalAddressesAreExcluded(t *testing.T) {
	v4, v6, err := exclusionPrefixes([]string{"10.88.0.1/16", "10.88.0.2", "8.8.4.4", "2606:4700:1234::/48", "2606:4700:1234::1/64"})
	if err != nil {
		t.Fatal(err)
	}
	excluded := func(value string) bool {
		a := netip.MustParseAddr(value)
		for _, cidr := range append(append([]string{}, v4...), v6...) {
			if netip.MustParsePrefix(cidr).Contains(a) {
				return true
			}
		}
		return false
	}
	for _, ip := range []string{"10.88.1.1", "172.16.1.1", "192.168.8.8", "100.64.0.2", "127.0.0.1", "169.254.1.1", "224.0.0.1", "255.255.255.255", "::1", "fd42::2", "fe80::1", "ff02::1", "8.8.4.4", "2606:4700:1234:ffff::2"} {
		if !excluded(ip) {
			t.Errorf("内网或本地地址未排除：%s", ip)
		}
	}
	for _, ip := range []string{"8.8.8.8", "1.1.1.1", "172.32.1.1", "100.128.0.1", "2606:4700:4700::1111"} {
		if excluded(ip) {
			t.Errorf("公网地址被误排除：%s", ip)
		}
	}
	if strings.Contains(strings.Join(v4, ","), "10.88.") {
		t.Fatal("嵌套网段应合并，避免 nft interval 冲突")
	}
	for _, invalid := range []string{"0.0.0.0/0", "::/0", "1.2.3.4; flush ruleset", "invalid"} {
		if _, _, err := exclusionPrefixes([]string{invalid}); err == nil {
			t.Errorf("未拒绝非法网段：%s", invalid)
		}
	}
}

func fixtureState() []byte {
	objects := []any{map[string]any{"table": map[string]any{"name": table, "comment": Scope}}}
	for _, name := range []string{"internal4", "internal6"} {
		objects = append(objects, map[string]any{"set": map[string]any{"name": name}})
	}
	for _, value := range []struct {
		name, generation string
		count            uint64
	}{{"ptest_rx", "generation-rx", 350}, {"ptest_tx", "generation-tx", 100}} {
		objects = append(objects, map[string]any{"chain": map[string]any{"name": value.name}}, map[string]any{"counter": map[string]any{"name": value.name, "comment": value.generation, "bytes": value.count}})
	}
	b, _ := json.Marshal(map[string]any{"nftables": objects})
	return b
}

func TestCounterDirectionsAndAtomicRules(t *testing.T) {
	var script string
	exists := false
	c := New()
	c.run = func(_ context.Context, input string, args ...string) ([]byte, error) {
		if input != "" {
			script = input
			exists = true
			return nil, nil
		}
		if strings.Join(args, " ") == "-j list tables netdev" {
			if exists {
				return []byte(`{"nftables":[{"table":{"name":"paledove_traffic"}}]}`), nil
			}
			return []byte(`{"nftables":[]}`), nil
		}
		return fixtureState(), nil
	}
	samples, err := c.collectDevices(context.Background(), []device{{"vm1", "eth0", "tap0", "ptest"}}, []string{"8.8.4.4"})
	if err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 || samples[0].Scope != Scope || samples[0].Interfaces["eth0"].Rx != 350 || samples[0].Interfaces["eth0"].Tx != 100 {
		t.Fatalf("%+v", samples)
	}
	for _, rule := range []string{
		`hook egress device "tap0"`, `hook ingress device "tap0"`,
		"ptest_rx ip saddr != @internal4 counter name ptest_rx", "ptest_tx ip daddr != @internal4 counter name ptest_tx",
		"ptest_rx ip6 saddr != @internal6 counter name ptest_rx", "ptest_tx ip6 daddr != @internal6 counter name ptest_tx",
		"meta pkttype { broadcast, multicast } return", "ip6 daddr ff00::/8 return",
		"10.0.0.0/8", "fc00::/7", "8.8.4.4/32",
	} {
		if !strings.Contains(script, rule) {
			t.Errorf("缺少规则：%s\n%s", rule, script)
		}
	}
	if strings.Contains(script, "drop") || strings.Contains(script, "flush ruleset") || strings.Contains(script, "eth2") {
		t.Fatalf("计费不应改变转发策略或包含 VPC：%s", script)
	}
	first := samples[0].Interfaces["eth0"].Generation
	samples, err = c.collectDevices(context.Background(), []device{{"vm1", "eth0", "tap0", "ptest"}}, []string{"1.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(script, "add counter") || strings.Contains(script, "delete counter") || strings.Contains(script, "add chain") {
		t.Fatal("更新排除网段不能重置已有计数")
	}
	if !strings.Contains(script, "1.0.0.1/32") || samples[0].Interfaces["eth0"].Generation != first {
		t.Fatal("排除集合未刷新或代次变化")
	}
	// Agent 重启仍从内核命名计数器读取，不回退 sysfs，也不重建计数器。
	restarted := New()
	restarted.run = c.run
	samples, err = restarted.collectDevices(context.Background(), []device{{"vm1", "eth0", "tap0", "ptest"}}, nil)
	if err != nil || samples[0].Interfaces["eth0"].Generation != first || strings.Contains(script, "add counter") {
		t.Fatalf("重启后基线丢失：%v", err)
	}
}

func TestFailuresNeverProduceBillableSamples(t *testing.T) {
	for _, stage := range []string{"read", "apply", "decode", "ownership"} {
		t.Run(stage, func(t *testing.T) {
			c := New()
			c.run = func(_ context.Context, input string, args ...string) ([]byte, error) {
				if stage == "read" || (stage == "apply" && input != "") {
					return nil, errors.New("nft unavailable")
				}
				if stage == "decode" {
					return []byte("invalid-json"), nil
				}
				if strings.Join(args, " ") == "-j list tables netdev" {
					if stage == "ownership" {
						return []byte(`{"nftables":[{"table":{"name":"paledove_traffic"}}]}`), nil
					}
					return []byte(`{"nftables":[]}`), nil
				}
				return []byte(`{"nftables":[{"table":{"comment":"other-owner"}}]}`), nil
			}
			if samples, err := c.collectDevices(context.Background(), []device{{"vm1", "eth0", "tap0", "ptest"}}, nil); err == nil || len(samples) != 0 {
				t.Fatalf("采集失败不应回退网卡总量：%+v %v", samples, err)
			}
		})
	}
	c := New()
	if _, err := c.Collect(context.Background(), nil, &Targets{Scope: "raw"}); err == nil {
		t.Fatal("不能执行旧版未过滤计费协议")
	}
}

func TestPartialCounterLossResetsBothDirections(t *testing.T) {
	c := New()
	var script string
	applied := false
	c.run = func(_ context.Context, input string, args ...string) ([]byte, error) {
		if input != "" {
			applied = true
			script = input
			return nil, nil
		}
		if strings.Join(args, " ") == "-j list tables netdev" {
			return []byte(`{"nftables":[{"table":{"name":"paledove_traffic"}}]}`), nil
		}
		if applied {
			return fixtureState(), nil
		}
		var state nftState
		_ = json.Unmarshal(fixtureState(), &state)
		var partial []nftObject
		for _, object := range state.Nftables {
			if object.Counter == nil || object.Counter.Name != "ptest_rx" {
				partial = append(partial, object)
			}
		}
		out, _ := json.Marshal(nftState{Nftables: partial})
		return out, nil
	}
	if _, err := c.collectDevices(context.Background(), []device{{"vm1", "eth0", "tap0", "ptest"}}, nil); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{"delete counter netdev paledove_traffic ptest_tx", "add counter netdev paledove_traffic ptest_rx", "add counter netdev paledove_traffic ptest_tx"} {
		if !strings.Contains(script, command) {
			t.Errorf("单侧计数器丢失时必须同步重建两个方向：%s", command)
		}
	}
}

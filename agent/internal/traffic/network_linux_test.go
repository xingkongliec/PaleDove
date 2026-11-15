package traffic

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 显式启用后，在独立网络命名空间内用真实 veth、IPv4 / IPv6 数据包验证内核计数。
func TestPublicTrafficNetworkNamespace(t *testing.T) {
	if os.Getenv("PALEDOVE_TRAFFIC_NETNS_TEST") != "1" {
		t.Skip("set PALEDOVE_TRAFFIC_NETNS_TEST=1 to run the isolated Linux packet test")
	}
	if os.Getenv("PALEDOVE_TRAFFIC_NETNS_CHILD") != "1" {
		exe, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		current, err := os.Readlink("/proc/self/ns/net")
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.CommandContext(ctx, "unshare", "--net", exe, "-test.run=^TestPublicTrafficNetworkNamespace$", "-test.v")
		cmd.Env = append(os.Environ(), "PALEDOVE_TRAFFIC_NETNS_CHILD=1", "PALEDOVE_TRAFFIC_OUTER_NETNS="+current)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("隔离内核测试失败：%v\n%s", err, out)
		}
		return
	}
	current, err := os.Readlink("/proc/self/ns/net")
	if err != nil || current == os.Getenv("PALEDOVE_TRAFFIC_OUTER_NETNS") {
		t.Fatal("必须在独立网络命名空间中执行")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	run := func(name string, args ...string) string {
		t.Helper()
		out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v\n%s", name, args, err, out)
		}
		return string(out)
	}
	peer := exec.CommandContext(ctx, "unshare", "--net", "sh", "-c", "echo ready; exec sleep 30")
	stdout, err := peer.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Process.Kill(); _ = peer.Wait() }()
	if line, err := bufio.NewReader(stdout).ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("无法创建对端网络命名空间：%q %v", line, err)
	}
	pid := strconv.Itoa(peer.Process.Pid)
	guest := func(args ...string) string { return run("nsenter", append([]string{"-t", pid, "-n"}, args...)...) }
	run("ip", "link", "set", "lo", "up")
	run("ip", "link", "add", "pdhost", "type", "veth", "peer", "name", "pdguest")
	run("ip", "link", "set", "pdguest", "netns", pid)
	run("ip", "link", "set", "pdhost", "up")
	guest("ip", "link", "set", "lo", "up")
	guest("ip", "link", "set", "pdguest", "up")
	// 这些公网地址仅存在于隔离命名空间，不连接真实互联网。
	for _, pair := range [][2]string{{"10.9.0.1/24", "10.9.0.2/24"}, {"8.8.8.1/24", "8.8.8.2/24"}, {"fd42::1/64", "fd42::2/64"}, {"2606:4700:ffff::1/64", "2606:4700:ffff::2/64"}} {
		args := []string{"addr", "add", pair[0], "dev", "pdhost"}
		other := []string{"ip", "addr", "add", pair[1], "dev", "pdguest"}
		if strings.Contains(pair[0], ":") {
			args = append(args, "nodad")
			other = append(other, "nodad")
		}
		run("ip", args...)
		guest(other...)
	}
	c := New()
	devices := []device{{"test-vm", "eth0", "pdhost", "ptest"}}
	collect := func() Counter {
		t.Helper()
		samples, err := c.collectDevices(ctx, devices, nil)
		if err != nil || len(samples) != 1 {
			t.Fatalf("%+v %v", samples, err)
		}
		return samples[0].Interfaces["eth0"]
	}
	raw := func() uint64 {
		var links []struct {
			Stats struct {
				Rx struct {
					Bytes uint64 `json:"bytes"`
				} `json:"rx"`
			} `json:"stats64"`
		}
		if err := json.Unmarshal([]byte(run("ip", "-j", "-s", "link", "show", "dev", "pdhost")), &links); err != nil || len(links) != 1 {
			t.Fatalf("%+v %v", links, err)
		}
		return links[0].Stats.Rx.Bytes
	}
	ping := func(ip string) { guest("ping", "-n", "-c", "2", "-W", "2", ip) }
	before, rawBefore := collect(), raw()
	ping("10.9.0.1")
	ping("fd42::1")
	afterPrivate := collect()
	if afterPrivate != before || raw() == rawBefore {
		t.Fatalf("内网通信必须经过网卡但不进入计数器：%+v -> %+v", before, afterPrivate)
	}
	for _, ip := range []string{"8.8.8.1", "2606:4700:ffff::1"} {
		before := collect()
		ping(ip)
		after := collect()
		if after.Rx <= before.Rx || after.Tx <= before.Tx {
			t.Fatalf("公网 %s 双向计数未增加：%+v -> %+v", ip, before, after)
		}
	}
	// 将模拟公网远端列为同宿主机地址后，也不再消耗额度，已有计数不清零。
	samples, err := c.collectDevices(ctx, devices, []string{"8.8.8.1", "2606:4700:ffff::/64"})
	if err != nil {
		t.Fatal(err)
	}
	baseline := samples[0].Interfaces["eth0"]
	ping("8.8.8.1")
	ping("2606:4700:ffff::1")
	samples, err = c.collectDevices(ctx, devices, []string{"8.8.8.1", "2606:4700:ffff::/64"})
	if err != nil || samples[0].Interfaces["eth0"] != baseline {
		t.Fatalf("同宿主机地址不应计费：%+v %v", samples, err)
	}
}

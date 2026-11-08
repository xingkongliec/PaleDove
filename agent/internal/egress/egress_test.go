package egress

import (
	"bufio"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	testPriv = "kNCnIzbQ3nRbNDNnYEsr5hDJ1z9RXQgRIzO7W1OSv2Q="
	testPub  = "xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg="
)

// fakeRunner 记录执行的命令；fail 中的命令前缀返回错误，outputs 为指定命令的输出
type fakeRunner struct {
	cmds    []string
	fail    []string
	outputs map[string]string
}

func (f *fakeRunner) run(name string, args ...string) (string, error) {
	cmd := strings.TrimSpace(name + " " + strings.Join(args, " "))
	f.cmds = append(f.cmds, cmd)
	for _, p := range f.fail {
		if strings.HasPrefix(cmd, p) {
			return "", errors.New("fail")
		}
	}
	return f.outputs[cmd], nil
}

func (f *fakeRunner) has(t *testing.T, cmd string) {
	t.Helper()
	for _, c := range f.cmds {
		if c == cmd {
			return
		}
	}
	t.Fatalf("missing command %q\n%s", cmd, strings.Join(f.cmds, "\n"))
}

func testManager(t *testing.T, f *fakeRunner) *Manager {
	m := New()
	m.dir = t.TempDir()
	m.run = f.run
	m.startGateway = func(port int, def egressDef) (*proxyGateway, error) {
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			return nil, err
		}
		g := newProxyGateway(ln, def)
		go g.serve()
		return g, nil
	}
	m.probe = func(string, int) (time.Duration, error) { return 12 * time.Millisecond, nil }
	return m
}

func sampleConfig() *egressConfig {
	return &egressConfig{
		Version: 3,
		Enabled: true,
		Bypass:  []string{"10.88.0.0/16"},
		Egresses: []egressDef{
			{ID: 1, Name: "HK WG", Type: "WIREGUARD", Wireguard: &wgConfig{PrivateKey: testPriv, Address: "10.7.0.2/32, fd00::2/128", PeerPublicKey: testPub, Endpoint: "203.0.113.9:51820", MTU: 1420, Keepalive: 25}},
			{ID: 7, Name: "US socks", Type: "SOCKS5", Proxy: &proxyConfig{Host: "198.51.100.4", Port: 1080}},
		},
		Instances: []egressInstance{
			{Name: "pd-1-a", IP: "10.88.0.5", EgressID: 1},
			{Name: "pd-1-b", IP: "10.88.0.6", EgressID: 7},
		},
	}
}

// 应用配置：WireGuard 隧道、策略路由与 MASQUERADE；代理网关的 REDIRECT；私钥只写入宿主机文件
func TestEgressApplyPlan(t *testing.T) {
	// 全新的宿主机：接口不存在、没有旧规则、iptables 链还没有挂上
	f := &fakeRunner{fail: []string{"ip link show dev pdwg1", "ip rule del", "iptables -t nat -C"}}
	m := testManager(t, f)
	defer m.stopGateways(nil)
	if err := m.apply(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	f.has(t, "ip link add dev pdwg1 type wireguard")
	keyFile := filepath.Join(m.dir, "pdwg1.key")
	f.has(t, "wg set pdwg1 private-key "+keyFile+" peer "+testPub+" endpoint 203.0.113.9:51820 allowed-ips 0.0.0.0/0,::/0 persistent-keepalive 25")
	if b, _ := os.ReadFile(keyFile); strings.TrimSpace(string(b)) != testPriv {
		t.Fatalf("key file %q", b)
	}
	if st, _ := os.Stat(keyFile); st != nil && st.Mode().Perm()&0o077 != 0 && os.PathSeparator == '/' {
		t.Fatalf("key file mode %v", st.Mode())
	}
	f.has(t, "ip address add 10.7.0.2/32 dev pdwg1")
	f.has(t, "ip address add fd00::2/128 dev pdwg1")
	f.has(t, "ip link set dev pdwg1 mtu 1420 up")
	f.has(t, "ip route replace default dev pdwg1 table 52001")
	f.has(t, "ip -6 route replace default dev pdwg1 table 52001")
	f.has(t, "iptables -t nat -A PDEGRESS-POST -o pdwg1 -j MASQUERADE")
	f.has(t, "ip rule add from 10.88.0.5/32 to 10.88.0.0/16 lookup main priority 20900")
	f.has(t, "ip rule add from 10.88.0.5/32 lookup 52001 priority 21000")
	f.has(t, "iptables -t nat -I PREROUTING 1 -j PDEGRESS-PRE")
	f.has(t, "iptables -t nat -A PDEGRESS-PRE -s 10.88.0.6/32 -d 10.88.0.0/16 -j RETURN")
	f.has(t, "iptables -t nat -A PDEGRESS-PRE -s 10.88.0.6/32 -p tcp -j REDIRECT --to-ports 42007")
	if m.gateways[7] == nil || !m.gateways[7].allowed["10.88.0.6"] || m.gateways[7].allowed["10.88.0.5"] {
		t.Fatalf("gateway allowed %+v", m.gateways[7])
	}
	if m.applied != 3 {
		t.Fatalf("applied %d", m.applied)
	}

	// 再次应用相同配置：接口已存在且配置没变，不重建
	f.cmds = nil
	f.fail = []string{"ip rule del"}
	if err := m.apply(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.cmds {
		if strings.HasPrefix(c, "ip link add") || strings.HasPrefix(c, "ip link del") {
			t.Fatalf("unexpected %q", c)
		}
	}
}

// 关闭智能分流：删除 pdwg 接口、分流规则与 iptables 链，停止网关；其他接口不动
func TestEgressDisableTearsDown(t *testing.T) {
	f := &fakeRunner{fail: []string{"ip link show dev pdwg1", "ip rule del"}}
	m := testManager(t, f)
	if err := m.apply(sampleConfig()); err != nil {
		t.Fatal(err)
	}
	f.cmds = nil
	f.outputs = map[string]string{"ip -o link show": "1: lo: <LOOPBACK>\n2: eth0: <UP>\n9: pdwg1: <POINTOPOINT>\n10: incusbr0: <UP>\n"}
	if err := m.apply(&egressConfig{Version: 4, Enabled: false}); err != nil {
		t.Fatal(err)
	}
	f.has(t, "ip link del dev pdwg1")
	f.has(t, "iptables -t nat -X PDEGRESS-PRE")
	f.has(t, "iptables -t nat -X PDEGRESS-POST")
	for _, c := range f.cmds {
		if strings.Contains(c, "del dev eth0") || strings.Contains(c, "del dev incusbr0") {
			t.Fatalf("touched foreign interface: %q", c)
		}
	}
	if len(m.gateways) != 0 {
		t.Fatal("gateways still running")
	}
	if _, err := os.Stat(filepath.Join(m.dir, "pdwg1.key")); !os.IsNotExist(err) {
		t.Fatal("key file not removed")
	}
}

func TestEgressValidate(t *testing.T) {
	bad := []*egressConfig{
		{Enabled: true, Bypass: []string{"10.0.0.0/33"}},
		{Enabled: true, Egresses: []egressDef{{ID: 0, Type: "SOCKS5", Proxy: &proxyConfig{Host: "a", Port: 1}}}},
		{Enabled: true, Egresses: []egressDef{{ID: 1, Type: "WIREGUARD", Wireguard: &wgConfig{PrivateKey: testPriv, PeerPublicKey: testPub, Endpoint: "1.2.3.4:1", Address: "nope"}}}},
		{Enabled: true, Egresses: []egressDef{{ID: 1, Type: "SOCKS5", Proxy: &proxyConfig{Host: "a", Port: 1}}}, Instances: []egressInstance{{Name: "x", IP: "1.2.3.4; rm -rf /", EgressID: 1}}},
		{Enabled: true, Egresses: []egressDef{{ID: 1, Type: "SOCKS5", Proxy: &proxyConfig{Host: "a", Port: 1}}}, Instances: []egressInstance{{Name: "x", IP: "10.0.0.2", EgressID: 9}}},
	}
	for i, c := range bad {
		if err := c.validate(); err == nil {
			t.Fatalf("case %d should fail", i)
		}
	}
	if err := sampleConfig().validate(); err != nil {
		t.Fatal(err)
	}
}

// 状态：解析 wg show 的握手时间与收发字节；代理检测连通性
func TestEgressStatus(t *testing.T) {
	now := time.Now().Unix()
	f := &fakeRunner{fail: []string{"ip link show dev pdwg1", "ip rule del"}, outputs: map[string]string{
		"wg show pdwg1 latest-handshakes": testPub + "\t" + itoa(now-30) + "\n",
		"wg show pdwg1 transfer":          testPub + "\t1000\t2000\n",
	}}
	m := testManager(t, f)
	defer m.stopGateways(nil)
	cfg := sampleConfig()
	if err := m.apply(cfg); err != nil {
		t.Fatal(err)
	}
	st := m.status(cfg)
	if len(st) != 2 || !st[0].OK || st[0].HandshakeAt != now-30 || st[0].RX != 1000 || st[0].TX != 2000 {
		t.Fatalf("wg status %+v", st[0])
	}
	if !st[1].OK || st[1].Latency == nil || *st[1].Latency != 12 {
		t.Fatalf("proxy status %+v", st[1])
	}
	// 握手太久以前：视为断开
	f.outputs["wg show pdwg1 latest-handshakes"] = testPub + "\t" + itoa(now-3600) + "\n"
	if st := m.status(cfg); st[0].OK {
		t.Fatal("stale handshake should not be ok")
	}
}

func itoa(v int64) string {
	b := []byte{}
	if v == 0 {
		return "0"
	}
	for v > 0 {
		b = append([]byte{byte('0' + v%10)}, b...)
		v /= 10
	}
	return string(b)
}

// 目的地址：回显服务
func echoServer(t *testing.T) *net.TCPAddr {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(c, c); c.Close() }()
		}
	}()
	return ln.Addr().(*net.TCPAddr)
}

// 简易 SOCKS5 代理（用户名密码认证）
func socksServer(t *testing.T, user, pass string) *net.TCPAddr {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				h := make([]byte, 2)
				io.ReadFull(c, h)
				io.ReadFull(c, make([]byte, h[1]))
				c.Write([]byte{5, 2})
				v := make([]byte, 2)
				io.ReadFull(c, v)
				u := make([]byte, v[1])
				io.ReadFull(c, u)
				pl := make([]byte, 1)
				io.ReadFull(c, pl)
				p := make([]byte, pl[0])
				io.ReadFull(c, p)
				if string(u) != user || string(p) != pass {
					c.Write([]byte{1, 1})
					return
				}
				c.Write([]byte{1, 0})
				req := make([]byte, 10)
				io.ReadFull(c, req)
				dst := &net.TCPAddr{IP: net.IP(req[4:8]), Port: int(binary.BigEndian.Uint16(req[8:10]))}
				up, err := net.Dial("tcp", dst.String())
				if err != nil {
					c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
					return
				}
				defer up.Close()
				c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
				pipe(c, up)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr)
}

// 简易 HTTP CONNECT 代理
func httpProxyServer(t *testing.T, auth string) *net.TCPAddr {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				r := bufio.NewReader(c)
				req, err := http.ReadRequest(r)
				if err != nil || req.Method != http.MethodConnect {
					return
				}
				if auth != "" && req.Header.Get("Proxy-Authorization") != auth {
					io.WriteString(c, "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")
					return
				}
				up, err := net.Dial("tcp", req.Host)
				if err != nil {
					io.WriteString(c, "HTTP/1.1 502 Bad Gateway\r\n\r\n")
					return
				}
				defer up.Close()
				io.WriteString(c, "HTTP/1.1 200 Connection established\r\n\r\n")
				pipe(&bufferedConn{Conn: c, r: r}, up)
			}(c)
		}
	}()
	return ln.Addr().(*net.TCPAddr)
}

// 网关：只接受分配到该出口的实例地址，经上游代理把连接转发到原目的地址
func TestProxyGatewayForwards(t *testing.T) {
	target := echoServer(t)
	cases := []struct {
		name string
		def  egressDef
	}{
		{"socks5", egressDef{ID: 2, Type: "SOCKS5", Proxy: &proxyConfig{Host: "127.0.0.1", Port: socksServer(t, "u", "p").Port, Username: "u", Password: "p"}}},
		{"http", egressDef{ID: 3, Type: "HTTP", Proxy: &proxyConfig{Host: "127.0.0.1", Port: httpProxyServer(t, "Basic dTpw").Port, Username: "u", Password: "p"}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ln, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			g := newProxyGateway(ln, tc.def)
			g.originalDst = func(net.Conn) (*net.TCPAddr, error) { return target, nil }
			go g.serve()
			defer g.close()

			// 未分配的地址：直接关闭
			c, err := net.Dial("tcp", ln.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			c.SetReadDeadline(time.Now().Add(2 * time.Second))
			if n, _ := c.Read(make([]byte, 1)); n != 0 {
				t.Fatal("unexpected data")
			}
			c.Close()

			g.update(tc.def, []string{"127.0.0.1"})
			c, err = net.Dial("tcp", ln.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(5 * time.Second))
			if _, err := io.WriteString(c, "hello egress"); err != nil {
				t.Fatal(err)
			}
			buf := make([]byte, len("hello egress"))
			if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "hello egress" {
				t.Fatalf("echo %q err %v", buf, err)
			}
		})
	}
}

// 上游认证失败时连接失败
func TestProxyAuthFailure(t *testing.T) {
	target := echoServer(t)
	if _, err := dialViaProxy(egressDef{Type: "SOCKS5", Proxy: &proxyConfig{Host: "127.0.0.1", Port: socksServer(t, "u", "p").Port, Username: "u", Password: "wrong"}}, target); err == nil {
		t.Fatal("socks5 auth should fail")
	}
	if _, err := dialViaProxy(egressDef{Type: "HTTP", Proxy: &proxyConfig{Host: "127.0.0.1", Port: httpProxyServer(t, "Basic dTpw").Port}}, target); err == nil {
		t.Fatal("http auth should fail")
	}
}

package egress

// 智能分流：按面板下发的配置为 NAT 实例切换出口。
//
//   - WireGuard：宿主机建立隧道接口 pdwg<出口 ID>，选择该出口的实例按源地址策略路由（ip rule from <实例内网地址>
//     lookup <出口路由表>）进隧道，经隧道地址 MASQUERADE 出去；整机全协议，同一宿主机的实例共享隧道。
//     私钥只写入宿主机（权限 0600 的文件），不会下发到实例。
//   - SOCKS5 / HTTP：Agent 网关（见 egress_gateway.go）监听本机端口，iptables 把实例的 TCP 连接 REDIRECT 到网关，
//     网关取得原目的地址后经上游代理转发；UDP 不经过代理。
//   - 去往宿主机 NAT 网段等目的地址（bypass）的流量不走出口。
//
// 只管理自己创建的对象：pdwg* 接口、优先级 20900 / 21000 的 ip rule、iptables nat 表的 PDEGRESS-PRE / PDEGRESS-POST 链；
// 关闭智能分流时全部撤销。每次配置版本变化时整体重建，应用后回报各出口的状态。

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/paledove/agent/internal/logx"
	"github.com/paledove/agent/internal/panel"
)

const (
	egressIfacePrefix = "pdwg"
	// 分流规则的优先级：先匹配 bypass（走主路由表），再匹配实例的出口
	egressBypassPriority = 20900
	egressRulePriority   = 21000
	egressTableBase      = 52000
	egressPreChain       = "PDEGRESS-PRE"
	egressPostChain      = "PDEGRESS-POST"
	// 代理网关端口：42000 + 出口 ID
	egressGatewayPortBase = 42000
	// 没有配置变化时，定期刷新状态的间隔
	egressStatusEvery = time.Minute
	// WireGuard 握手超过这个时间视为断开
	egressHandshakeStale = 3 * time.Minute
)

// Hint 为心跳回复里的配置版本
type Hint struct {
	Version int `json:"version"`
}

type wgConfig struct {
	PrivateKey    string `json:"privateKey"`
	Address       string `json:"address"`
	PeerPublicKey string `json:"peerPublicKey"`
	PresharedKey  string `json:"presharedKey"`
	Endpoint      string `json:"endpoint"`
	MTU           int    `json:"mtu"`
	Keepalive     int    `json:"keepalive"`
}

type proxyConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

type egressDef struct {
	ID        int          `json:"id"`
	Name      string       `json:"name"`
	Type      string       `json:"type"`
	Wireguard *wgConfig    `json:"wireguard"`
	Proxy     *proxyConfig `json:"proxy"`
}

type egressInstance struct {
	Name     string `json:"name"`
	IP       string `json:"ip"`
	EgressID int    `json:"egressId"`
}

type egressConfig struct {
	Version   int              `json:"version"`
	Enabled   bool             `json:"enabled"`
	Bypass    []string         `json:"bypass"`
	Egresses  []egressDef      `json:"egresses"`
	Instances []egressInstance `json:"instances"`
}

// egressItemStatus 为回报给面板的单个出口状态
type egressItemStatus struct {
	ID          int     `json:"id"`
	OK          bool    `json:"ok"`
	Error       string  `json:"error,omitempty"`
	HandshakeAt int64   `json:"handshakeAt,omitempty"`
	RX          float64 `json:"rx,omitempty"`
	TX          float64 `json:"tx,omitempty"`
	Latency     *int64  `json:"latency,omitempty"`
}

type Manager struct {
	mu      sync.Mutex
	applied int
	current *egressConfig
	// 各 WireGuard 接口当前配置的摘要：变化时重建接口
	wgHash map[string]string
	// 运行中的代理网关（按出口 ID）
	gateways map[int]*proxyGateway
	// 保存密钥文件的目录（权限 0700）
	dir     string
	run     func(name string, args ...string) (string, error)
	running atomic.Bool
	last    time.Time
	// 代理连通性检测与网关启动（测试中替换）
	probe        func(host string, port int) (time.Duration, error)
	startGateway func(port int, def egressDef) (*proxyGateway, error)
}

func New() *Manager {
	return &Manager{
		applied:  -1,
		wgHash:   map[string]string{},
		gateways: map[int]*proxyGateway{},
		dir:      "/run/paledove/egress",
		run: func(name string, args ...string) (string, error) {
			out, err := exec.Command(name, args...).CombinedOutput()
			if err != nil {
				return string(out), fmt.Errorf("%s %s：%v %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
			}
			return string(out), nil
		},
		startGateway: startProxyGateway,
		probe: func(host string, port int) (time.Duration, error) {
			start := time.Now()
			c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 5*time.Second)
			if err != nil {
				return 0, err
			}
			c.Close()
			return time.Since(start), nil
		},
	}
}

// MaybeSync 收到心跳回复后调用：版本变化时拉取并应用配置，否则定期刷新状态（在后台进行）
func (m *Manager) MaybeSync(ctx context.Context, c *panel.Client, hint *Hint) {
	if hint == nil {
		return
	}
	m.mu.Lock()
	changed := hint.Version != m.applied
	due := time.Since(m.last) >= egressStatusEvery && m.current != nil && m.current.Enabled
	m.mu.Unlock()
	if (!changed && !due) || !m.running.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer m.running.Store(false)
		if err := m.sync(ctx, c, changed); err != nil {
			logx.Once("egress:"+err.Error(), "智能分流同步失败：%v", err)
		}
	}()
}

func (m *Manager) sync(ctx context.Context, c *panel.Client, fetch bool) error {
	if fetch {
		res, err := c.Request(ctx, http.MethodGet, "/api/agent/nodes/egress", nil)
		if err != nil {
			return err
		}
		if res.Status != http.StatusOK || !c.Trusted(res) {
			return fmt.Errorf("拉取智能分流配置失败（%d）", res.Status)
		}
		var cfg egressConfig
		if err := json.Unmarshal(res.Body, &cfg); err != nil {
			return err
		}
		applyErr := m.apply(&cfg)
		if applyErr != nil {
			log.Printf("应用智能分流配置（版本 %d）出错：%v", cfg.Version, applyErr)
		}
		return m.report(ctx, c, &cfg, applyErr)
	}
	m.mu.Lock()
	cfg := m.current
	m.mu.Unlock()
	if cfg == nil {
		return nil
	}
	return m.report(ctx, c, cfg, nil)
}

func (m *Manager) report(ctx context.Context, c *panel.Client, cfg *egressConfig, applyErr error) error {
	body := map[string]any{"version": cfg.Version, "items": m.status(cfg)}
	if applyErr != nil {
		body["error"] = logx.Truncate(applyErr.Error(), 1000)
	}
	data, _ := json.Marshal(body)
	res, err := c.Request(ctx, http.MethodPost, "/api/agent/nodes/egress-status", data)
	if err != nil {
		return err
	}
	if res.Status != http.StatusOK {
		return fmt.Errorf("回报智能分流状态失败（%d）", res.Status)
	}
	m.mu.Lock()
	m.last = time.Now()
	m.mu.Unlock()
	return nil
}

// ───────── 应用配置 ─────────

func wgIface(id int) string  { return fmt.Sprintf("%s%d", egressIfacePrefix, id) }
func wgTable(id int) int     { return egressTableBase + id }
func gatewayPort(id int) int { return egressGatewayPortBase + id }

// validate 检查配置里的地址与参数，避免拼进命令后出现意外
func (cfg *egressConfig) validate() error {
	for _, b := range cfg.Bypass {
		if _, _, err := net.ParseCIDR(b); err != nil {
			return fmt.Errorf("bypass 网段 %q 无效", b)
		}
	}
	ids := map[int]bool{}
	for _, e := range cfg.Egresses {
		if e.ID <= 0 || e.ID > 20000 {
			return fmt.Errorf("出口 ID %d 超出范围", e.ID)
		}
		ids[e.ID] = true
		switch e.Type {
		case "WIREGUARD":
			w := e.Wireguard
			if w == nil || w.PrivateKey == "" || w.PeerPublicKey == "" || w.Endpoint == "" {
				return fmt.Errorf("出口 %d 的 WireGuard 配置不完整", e.ID)
			}
			for _, addr := range splitList(w.Address) {
				if _, _, err := net.ParseCIDR(addr); err != nil {
					return fmt.Errorf("出口 %d 的隧道地址 %q 无效", e.ID, addr)
				}
			}
			if _, _, err := net.SplitHostPort(w.Endpoint); err != nil {
				return fmt.Errorf("出口 %d 的 Endpoint 无效", e.ID)
			}
			for _, k := range []string{w.PrivateKey, w.PeerPublicKey, w.PresharedKey} {
				if strings.ContainsAny(k, " \t\n") {
					return fmt.Errorf("出口 %d 的密钥格式无效", e.ID)
				}
			}
		case "SOCKS5", "HTTP":
			if e.Proxy == nil || e.Proxy.Host == "" || e.Proxy.Port <= 0 || e.Proxy.Port > 65535 {
				return fmt.Errorf("出口 %d 的代理配置不完整", e.ID)
			}
		default:
			return fmt.Errorf("出口 %d 的类型 %q 不支持", e.ID, e.Type)
		}
	}
	for _, in := range cfg.Instances {
		ip := net.ParseIP(in.IP)
		if ip == nil || ip.To4() == nil {
			return fmt.Errorf("实例 %s 的内网地址 %q 无效", in.Name, in.IP)
		}
		if !ids[in.EgressID] {
			return fmt.Errorf("实例 %s 的出口 %d 不存在", in.Name, in.EgressID)
		}
	}
	return nil
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// apply 按配置整体重建；返回的错误为整体错误，单个出口的问题记在状态里
func (m *Manager) apply(cfg *egressConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := cfg.validate(); err != nil {
		return err
	}
	// 先撤销旧的分流规则与转发，再按新配置建立
	m.clearRules()
	if !cfg.Enabled {
		m.removeWireguard(nil)
		m.stopGateways(nil)
		m.clearChains(true)
		m.current = cfg
		m.applied = cfg.Version
		return nil
	}

	var errs []string
	wanted := map[string]bool{}
	gateways := map[int]bool{}
	byEgress := map[int][]string{}
	for _, in := range cfg.Instances {
		byEgress[in.EgressID] = append(byEgress[in.EgressID], in.IP)
	}
	if err := m.ensureChains(); err != nil {
		errs = append(errs, err.Error())
	}
	for _, e := range cfg.Egresses {
		switch e.Type {
		case "WIREGUARD":
			iface := wgIface(e.ID)
			wanted[iface] = true
			if err := m.applyWireguard(e); err != nil {
				errs = append(errs, err.Error())
				continue
			}
			m.addRules(e.ID, byEgress[e.ID], cfg.Bypass)
		case "SOCKS5", "HTTP":
			gateways[e.ID] = true
			if err := m.applyGateway(e, byEgress[e.ID], cfg.Bypass); err != nil {
				errs = append(errs, err.Error())
			}
		}
	}
	m.removeWireguard(wanted)
	m.stopGateways(gateways)
	m.current = cfg
	m.applied = cfg.Version
	if len(errs) > 0 {
		return fmt.Errorf("%s", strings.Join(errs, "；"))
	}
	return nil
}

func (m *Manager) applyWireguard(e egressDef) error {
	w := e.Wireguard
	iface := wgIface(e.ID)
	sum := sha256.Sum256([]byte(fmt.Sprintf("%+v", *w)))
	hash := hex.EncodeToString(sum[:])
	_, existsErr := m.run("ip", "link", "show", "dev", iface)
	if existsErr == nil && m.wgHash[iface] != hash {
		// 配置变化（或 Agent 重启后不知道原配置）：重建接口
		m.run("ip", "link", "del", "dev", iface)
		existsErr = fmt.Errorf("recreate")
	}
	if existsErr != nil {
		if _, err := m.run("ip", "link", "add", "dev", iface, "type", "wireguard"); err != nil {
			return fmt.Errorf("创建 WireGuard 接口 %s 失败（宿主机需要支持 WireGuard 并安装 wireguard-tools）：%v", iface, err)
		}
	}
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return err
	}
	keyFile := filepath.Join(m.dir, iface+".key")
	if err := os.WriteFile(keyFile, []byte(w.PrivateKey+"\n"), 0o600); err != nil {
		return err
	}
	args := []string{"set", iface, "private-key", keyFile, "peer", w.PeerPublicKey, "endpoint", w.Endpoint, "allowed-ips", "0.0.0.0/0,::/0"}
	if w.Keepalive > 0 {
		args = append(args, "persistent-keepalive", strconv.Itoa(w.Keepalive))
	}
	if w.PresharedKey != "" {
		pskFile := filepath.Join(m.dir, iface+".psk")
		if err := os.WriteFile(pskFile, []byte(w.PresharedKey+"\n"), 0o600); err != nil {
			return err
		}
		args = append(args, "preshared-key", pskFile)
	}
	if _, err := m.run("wg", args...); err != nil {
		return fmt.Errorf("配置 WireGuard 接口 %s 失败：%v", iface, err)
	}
	m.run("ip", "address", "flush", "dev", iface)
	hasV6 := false
	for _, addr := range splitList(w.Address) {
		if strings.Contains(addr, ":") {
			hasV6 = true
		}
		if _, err := m.run("ip", "address", "add", addr, "dev", iface); err != nil {
			return err
		}
	}
	mtu := w.MTU
	if mtu < 1280 || mtu > 1500 {
		mtu = 1420
	}
	if _, err := m.run("ip", "link", "set", "dev", iface, "mtu", strconv.Itoa(mtu), "up"); err != nil {
		return err
	}
	table := strconv.Itoa(wgTable(e.ID))
	if _, err := m.run("ip", "route", "replace", "default", "dev", iface, "table", table); err != nil {
		return err
	}
	if hasV6 {
		m.run("ip", "-6", "route", "replace", "default", "dev", iface, "table", table)
	}
	// 回程从隧道进来，源地址是公网地址：放宽反向路径检查
	m.run("sysctl", "-qw", "net.ipv4.conf."+iface+".rp_filter=2")
	if _, err := m.run("iptables", "-t", "nat", "-A", egressPostChain, "-o", iface, "-j", "MASQUERADE"); err != nil {
		return err
	}
	m.wgHash[iface] = hash
	return nil
}

// addRules 为使用该出口的实例添加策略路由：bypass 网段走主路由表，其余进出口路由表
func (m *Manager) addRules(id int, ips []string, bypass []string) {
	table := strconv.Itoa(wgTable(id))
	for _, ip := range ips {
		for _, b := range bypass {
			m.run("ip", "rule", "add", "from", ip+"/32", "to", b, "lookup", "main", "priority", strconv.Itoa(egressBypassPriority))
		}
		m.run("ip", "rule", "add", "from", ip+"/32", "lookup", table, "priority", strconv.Itoa(egressRulePriority))
	}
}

// clearRules 删除本程序添加的策略路由（按优先级逐条删除）
func (m *Manager) clearRules() {
	for _, prio := range []int{egressBypassPriority, egressRulePriority} {
		for i := 0; i < 4096; i++ {
			if _, err := m.run("ip", "rule", "del", "priority", strconv.Itoa(prio)); err != nil {
				break
			}
		}
	}
}

// ensureChains 建立并清空本程序的 nat 链，挂到 PREROUTING / POSTROUTING 最前面
func (m *Manager) ensureChains() error {
	for _, c := range [][2]string{{egressPreChain, "PREROUTING"}, {egressPostChain, "POSTROUTING"}} {
		m.run("iptables", "-t", "nat", "-N", c[0])
		if _, err := m.run("iptables", "-t", "nat", "-F", c[0]); err != nil {
			return fmt.Errorf("准备 iptables 链失败（宿主机需要 iptables）：%v", err)
		}
		if _, err := m.run("iptables", "-t", "nat", "-C", c[1], "-j", c[0]); err != nil {
			if _, err := m.run("iptables", "-t", "nat", "-I", c[1], "1", "-j", c[0]); err != nil {
				return err
			}
		}
	}
	return nil
}

// clearChains 清空（remove 时删除）本程序的 nat 链
func (m *Manager) clearChains(remove bool) {
	for _, c := range [][2]string{{egressPreChain, "PREROUTING"}, {egressPostChain, "POSTROUTING"}} {
		m.run("iptables", "-t", "nat", "-F", c[0])
		if remove {
			for i := 0; i < 8; i++ {
				if _, err := m.run("iptables", "-t", "nat", "-D", c[1], "-j", c[0]); err != nil {
					break
				}
			}
			m.run("iptables", "-t", "nat", "-X", c[0])
		}
	}
}

// removeWireguard 删除不再需要的 pdwg 接口（keep 为 nil 时全部删除）
func (m *Manager) removeWireguard(keep map[string]bool) {
	out, err := m.run("ip", "-o", "link", "show")
	if err != nil {
		return
	}
	for _, line := range strings.Split(out, "\n") {
		// 形如 "12: pdwg3: <POINTOPOINT,...> ..."
		parts := strings.SplitN(line, ":", 3)
		if len(parts) < 2 {
			continue
		}
		name := strings.TrimSpace(strings.SplitN(parts[1], "@", 2)[0])
		if !strings.HasPrefix(name, egressIfacePrefix) || keep[name] {
			continue
		}
		m.run("ip", "link", "del", "dev", name)
		delete(m.wgHash, name)
		os.Remove(filepath.Join(m.dir, name+".key"))
		os.Remove(filepath.Join(m.dir, name+".psk"))
	}
}

// applyGateway 启动（或更新）代理网关，把实例的 TCP 连接重定向到网关
func (m *Manager) applyGateway(e egressDef, ips []string, bypass []string) error {
	port := gatewayPort(e.ID)
	gw := m.gateways[e.ID]
	if gw == nil {
		var err error
		if gw, err = m.startGateway(port, e); err != nil {
			return fmt.Errorf("启动出口 %d 的网关失败：%v", e.ID, err)
		}
		m.gateways[e.ID] = gw
	}
	gw.update(e, ips)
	for _, ip := range ips {
		for _, b := range bypass {
			m.run("iptables", "-t", "nat", "-A", egressPreChain, "-s", ip+"/32", "-d", b, "-j", "RETURN")
		}
		if _, err := m.run("iptables", "-t", "nat", "-A", egressPreChain, "-s", ip+"/32", "-p", "tcp", "-j", "REDIRECT", "--to-ports", strconv.Itoa(port)); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) stopGateways(keep map[int]bool) {
	for id, gw := range m.gateways {
		if !keep[id] {
			gw.close()
			delete(m.gateways, id)
		}
	}
}

// ───────── 状态 ─────────

func (m *Manager) status(cfg *egressConfig) []egressItemStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !cfg.Enabled {
		return []egressItemStatus{}
	}
	out := make([]egressItemStatus, 0, len(cfg.Egresses))
	for _, e := range cfg.Egresses {
		st := egressItemStatus{ID: e.ID}
		switch e.Type {
		case "WIREGUARD":
			iface := wgIface(e.ID)
			hs, err := m.run("wg", "show", iface, "latest-handshakes")
			if err != nil {
				st.Error = "隧道未建立"
				break
			}
			for _, line := range strings.Split(strings.TrimSpace(hs), "\n") {
				if f := strings.Fields(line); len(f) == 2 {
					st.HandshakeAt, _ = strconv.ParseInt(f[1], 10, 64)
				}
			}
			if tr, err := m.run("wg", "show", iface, "transfer"); err == nil {
				for _, line := range strings.Split(strings.TrimSpace(tr), "\n") {
					if f := strings.Fields(line); len(f) == 3 {
						st.RX, _ = strconv.ParseFloat(f[1], 64)
						st.TX, _ = strconv.ParseFloat(f[2], 64)
					}
				}
			}
			st.OK = st.HandshakeAt > 0 && time.Since(time.Unix(st.HandshakeAt, 0)) < egressHandshakeStale
			if !st.OK {
				st.Error = "没有与对端握手"
			}
		default:
			if m.gateways[e.ID] == nil {
				st.Error = "网关未运行"
				break
			}
			d, err := m.probe(e.Proxy.Host, e.Proxy.Port)
			if err != nil {
				st.Error = "无法连接代理：" + logx.Truncate(err.Error(), 200)
				break
			}
			ms := d.Milliseconds()
			st.Latency = &ms
			st.OK = true
		}
		out = append(out, st)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

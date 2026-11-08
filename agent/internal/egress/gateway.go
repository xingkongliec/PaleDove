package egress

// Agent 网关：SOCKS5 / HTTP 出口的透明转发。iptables 把实例的 TCP 连接 REDIRECT 到网关端口，
// 网关取得连接的原目的地址（SO_ORIGINAL_DST），经上游代理（SOCKS5 CONNECT 或 HTTP CONNECT）连接目的地址后双向转发。
// 只接受分配到该出口的实例地址发起的连接，其他来源直接关闭。

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

const gatewayDialTimeout = 10 * time.Second

type proxyGateway struct {
	ln      net.Listener
	mu      sync.RWMutex
	def     egressDef
	allowed map[string]bool
	// 取连接原目的地址（Linux 为 SO_ORIGINAL_DST；测试中替换）
	originalDst func(net.Conn) (*net.TCPAddr, error)
	closed      chan struct{}
}

func startProxyGateway(port int, def egressDef) (*proxyGateway, error) {
	ln, err := net.Listen("tcp4", fmt.Sprintf("0.0.0.0:%d", port))
	if err != nil {
		return nil, err
	}
	g := newProxyGateway(ln, def)
	go g.serve()
	return g, nil
}

func newProxyGateway(ln net.Listener, def egressDef) *proxyGateway {
	return &proxyGateway{ln: ln, def: def, allowed: map[string]bool{}, originalDst: originalDst, closed: make(chan struct{})}
}

// update 更新上游配置与允许的实例地址
func (g *proxyGateway) update(def egressDef, ips []string) {
	allowed := make(map[string]bool, len(ips))
	for _, ip := range ips {
		allowed[ip] = true
	}
	g.mu.Lock()
	g.def = def
	g.allowed = allowed
	g.mu.Unlock()
}

func (g *proxyGateway) close() {
	select {
	case <-g.closed:
	default:
		close(g.closed)
		g.ln.Close()
	}
}

func (g *proxyGateway) serve() {
	for {
		c, err := g.ln.Accept()
		if err != nil {
			select {
			case <-g.closed:
				return
			default:
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}
		go g.handle(c)
	}
}

func (g *proxyGateway) handle(c net.Conn) {
	defer c.Close()
	remote, _ := c.RemoteAddr().(*net.TCPAddr)
	g.mu.RLock()
	def := g.def
	ok := remote != nil && g.allowed[remote.IP.String()]
	g.mu.RUnlock()
	if !ok {
		return
	}
	dst, err := g.originalDst(c)
	if err != nil || dst == nil {
		return
	}
	up, err := dialViaProxy(def, dst)
	if err != nil {
		return
	}
	defer up.Close()
	pipe(c, up)
}

// pipe 双向转发，一侧结束时关闭另一侧的写方向
func pipe(a, b net.Conn) {
	done := make(chan struct{}, 2)
	cp := func(dst, src net.Conn) {
		io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			cw.CloseWrite()
		} else {
			dst.Close()
		}
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	<-done
}

// dialViaProxy 经上游代理连接目的地址
func dialViaProxy(def egressDef, dst *net.TCPAddr) (net.Conn, error) {
	p := def.Proxy
	if p == nil {
		return nil, errors.New("缺少代理配置")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(p.Host, strconv.Itoa(p.Port)), gatewayDialTimeout)
	if err != nil {
		return nil, err
	}
	conn.SetDeadline(time.Now().Add(gatewayDialTimeout))
	var out net.Conn
	switch def.Type {
	case "SOCKS5":
		err = socks5Connect(conn, p, dst)
		out = conn
	case "HTTP":
		out, err = httpConnect(conn, p, dst)
	default:
		err = fmt.Errorf("类型 %s 不支持", def.Type)
	}
	if err != nil {
		conn.Close()
		return nil, err
	}
	conn.SetDeadline(time.Time{})
	return out, nil
}

// socks5Connect 完成 SOCKS5 握手（可选用户名密码认证，RFC 1928 / 1929）并发出 CONNECT
func socks5Connect(c net.Conn, p *proxyConfig, dst *net.TCPAddr) error {
	methods := []byte{0x00}
	if p.Username != "" {
		methods = []byte{0x00, 0x02}
	}
	if _, err := c.Write(append([]byte{0x05, byte(len(methods))}, methods...)); err != nil {
		return err
	}
	reply := make([]byte, 2)
	if _, err := io.ReadFull(c, reply); err != nil {
		return err
	}
	if reply[0] != 0x05 {
		return errors.New("不是 SOCKS5 代理")
	}
	switch reply[1] {
	case 0x00:
	case 0x02:
		if p.Username == "" || len(p.Username) > 255 || len(p.Password) > 255 {
			return errors.New("代理要求用户名密码认证")
		}
		req := []byte{0x01, byte(len(p.Username))}
		req = append(req, p.Username...)
		req = append(req, byte(len(p.Password)))
		req = append(req, p.Password...)
		if _, err := c.Write(req); err != nil {
			return err
		}
		if _, err := io.ReadFull(c, reply); err != nil {
			return err
		}
		if reply[1] != 0x00 {
			return errors.New("代理认证失败")
		}
	default:
		return errors.New("代理不接受认证方式")
	}
	req := []byte{0x05, 0x01, 0x00}
	if ip4 := dst.IP.To4(); ip4 != nil {
		req = append(append(req, 0x01), ip4...)
	} else {
		req = append(append(req, 0x04), dst.IP.To16()...)
	}
	req = binary.BigEndian.AppendUint16(req, uint16(dst.Port))
	if _, err := c.Write(req); err != nil {
		return err
	}
	head := make([]byte, 4)
	if _, err := io.ReadFull(c, head); err != nil {
		return err
	}
	if head[1] != 0x00 {
		return fmt.Errorf("代理拒绝连接（%d）", head[1])
	}
	var skip int
	switch head[3] {
	case 0x01:
		skip = 4
	case 0x04:
		skip = 16
	case 0x03:
		l := make([]byte, 1)
		if _, err := io.ReadFull(c, l); err != nil {
			return err
		}
		skip = int(l[0])
	default:
		return errors.New("代理回复格式不正确")
	}
	_, err := io.ReadFull(c, make([]byte, skip+2))
	return err
}

// bufferedConn 让 HTTP CONNECT 回复之后已读入缓冲的数据不丢失
type bufferedConn struct {
	net.Conn
	r *bufio.Reader
}

func (b *bufferedConn) Read(p []byte) (int, error) { return b.r.Read(p) }
func (b *bufferedConn) CloseWrite() error {
	if cw, ok := b.Conn.(interface{ CloseWrite() error }); ok {
		return cw.CloseWrite()
	}
	return b.Conn.Close()
}

// httpConnect 发出 HTTP CONNECT（可选 Basic 认证），成功（2xx）后返回隧道连接
func httpConnect(c net.Conn, p *proxyConfig, dst *net.TCPAddr) (net.Conn, error) {
	target := dst.String()
	req := "CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n"
	if p.Username != "" {
		req += "Proxy-Authorization: Basic " + base64.StdEncoding.EncodeToString([]byte(p.Username+":"+p.Password)) + "\r\n"
	}
	req += "\r\n"
	if _, err := io.WriteString(c, req); err != nil {
		return nil, err
	}
	r := bufio.NewReader(c)
	res, err := http.ReadResponse(r, &http.Request{Method: http.MethodConnect})
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("代理拒绝连接（%s）", res.Status)
	}
	return &bufferedConn{Conn: c, r: r}, nil
}

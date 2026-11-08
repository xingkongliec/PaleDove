//go:build linux

package egress

// SO_ORIGINAL_DST：被 iptables REDIRECT 的连接的原目的地址（IPv4）
import (
	"errors"
	"net"
	"syscall"
)

const soOriginalDst = 80

// originalDst 取被 REDIRECT 到网关的连接原本要去的地址
func originalDst(c net.Conn) (*net.TCPAddr, error) {
	tc, ok := c.(*net.TCPConn)
	if !ok {
		return nil, errors.New("不是 TCP 连接")
	}
	raw, err := tc.SyscallConn()
	if err != nil {
		return nil, err
	}
	var addr *net.TCPAddr
	var opErr error
	err = raw.Control(func(fd uintptr) {
		// 返回的是 sockaddr_in：[2:4] 端口（大端），[4:8] IPv4 地址
		m, e := syscall.GetsockoptIPv6Mreq(int(fd), syscall.IPPROTO_IP, soOriginalDst)
		if e != nil {
			opErr = e
			return
		}
		b := m.Multiaddr
		addr = &net.TCPAddr{IP: net.IPv4(b[4], b[5], b[6], b[7]), Port: int(b[2])<<8 | int(b[3])}
	})
	if err != nil {
		return nil, err
	}
	return addr, opErr
}

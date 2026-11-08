//go:build linux

package nodetest

import (
	"bufio"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

// spoofer 以实例的独立 IPv4 为源地址发送 Echo Request，并在宿主机网卡上抓取回复。
//
//   - routed 网卡：上游把实例地址路由到宿主机，用 IPPROTO_RAW 原始套接字发送（自带 IP 头，内核不改源地址），
//     报文从宿主机上联网卡以宿主机 MAC 发出，与实例自己的出站报文一致。
//   - bridged 网卡：实例直接挂在网桥上，上游按「地址 ↔ 实例 MAC」转发（不少机房还会校验 MAC）。
//     此时以实例 MAC 为源、网关 MAC 为目的构造以太网帧，直接从网桥里的物理网卡发出（绕过网桥，不会让网桥误学 MAC）。
//
// 回复的目的地址是实例，不会交给宿主机协议栈，用 AF_PACKET 套接字在所有网卡上抓 IPv4 报文匹配。
type spoofer struct {
	src    net.IP
	send   int
	recv   int
	l2     *l2Target
	w      waiters
	closed atomic.Bool
	wg     sync.WaitGroup
}

// l2Target 为 bridged 网卡的二层发送参数
type l2Target struct {
	ifindex int
	srcMAC  net.HardwareAddr
	dstMAC  net.HardwareAddr
}

func htons(v uint16) uint16 { return v<<8 | v>>8 }

func newSpoofer(src net.IP, job ListingJob) (*spoofer, error) {
	s := &spoofer{src: src.To4(), send: -1, recv: -1, w: waiters{m: map[echoKey]chan time.Time{}}}
	var err error
	if job.Bridge != "" {
		if s.l2, err = resolveL2(job); err != nil {
			return nil, fmt.Errorf("桥接网卡 %s：%w", job.Bridge, err)
		}
		s.send, err = syscall.Socket(syscall.AF_PACKET, syscall.SOCK_RAW, 0)
	} else {
		s.send, err = syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, syscall.IPPROTO_RAW)
	}
	if err != nil {
		return nil, err
	}
	s.recv, err = syscall.Socket(syscall.AF_PACKET, syscall.SOCK_DGRAM, int(htons(syscall.ETH_P_IP)))
	if err != nil {
		syscall.Close(s.send)
		return nil, err
	}
	// 读超时：便于关闭时退出读循环
	tv := syscall.NsecToTimeval((200 * time.Millisecond).Nanoseconds())
	if err := syscall.SetsockoptTimeval(s.recv, syscall.SOL_SOCKET, syscall.SO_RCVTIMEO, &tv); err != nil {
		syscall.Close(s.send)
		syscall.Close(s.recv)
		return nil, err
	}
	// 加大接收缓冲：抓包会收到宿主机上的全部 IPv4 流量
	_ = syscall.SetsockoptInt(s.recv, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4<<20)
	s.wg.Add(1)
	go s.readLoop()
	return s, nil
}

// L2 是否以二层帧（实例 MAC）发送
func (s *spoofer) L2() bool { return s.l2 != nil }

func (s *spoofer) readLoop() {
	defer s.wg.Done()
	buf := make([]byte, 65536)
	for !s.closed.Load() {
		n, _, err := syscall.Recvfrom(s.recv, buf, 0)
		if err != nil {
			if errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.EINTR) {
				continue
			}
			if s.closed.Load() {
				return
			}
			time.Sleep(10 * time.Millisecond)
			continue
		}
		s.w.deliver(buf[:n], s.src, time.Now())
	}
}

// Ping 向 dst 发送 count 次源地址为实例 IP 的 Echo Request
func (s *spoofer) Ping(dst net.IP, count int) []time.Duration {
	rtts, _ := s.PingResult(dst, count)
	return rtts
}

func (s *spoofer) PingResult(dst net.IP, count int) ([]time.Duration, error) {
	send := func(pkt []byte, dst net.IP) error {
		if s.l2 != nil {
			frame := make([]byte, 14+len(pkt))
			copy(frame[0:6], s.l2.dstMAC)
			copy(frame[6:12], s.l2.srcMAC)
			frame[12], frame[13] = 0x08, 0x00
			copy(frame[14:], pkt)
			addr := syscall.SockaddrLinklayer{Protocol: htons(syscall.ETH_P_IP), Ifindex: s.l2.ifindex, Halen: 6}
			copy(addr.Addr[:], s.l2.dstMAC)
			return syscall.Sendto(s.send, frame, 0, &addr)
		}
		var addr syscall.SockaddrInet4
		copy(addr.Addr[:], dst.To4())
		return syscall.Sendto(s.send, pkt, 0, &addr)
	}
	return pingWithResult(&s.w, send, s.src, dst, count)
}

func (s *spoofer) Close() {
	if s.closed.Swap(true) {
		return
	}
	s.wg.Wait()
	syscall.Close(s.send)
	syscall.Close(s.recv)
}

// ───────── bridged：物理网卡、实例 MAC 与网关 MAC ─────────

func resolveL2(job ListingJob) (*l2Target, error) {
	src, err := net.ParseMAC(job.MAC)
	if err != nil {
		return nil, errors.New("缺少实例 MAC")
	}
	port, err := bridgeUplink(job.Bridge)
	if err != nil {
		return nil, err
	}
	iface, err := net.InterfaceByName(port)
	if err != nil {
		return nil, err
	}
	// 网关：实例地址的网关，其次是网桥上的默认网关
	gateways := []string{}
	if job.Gateway != "" {
		gateways = append(gateways, job.Gateway)
	}
	if gw := defaultGateway(job.Bridge); gw != "" {
		gateways = append(gateways, gw)
	}
	for _, gw := range gateways {
		if mac := neighborMAC(gw, job.Bridge); mac != nil {
			return &l2Target{ifindex: iface.Index, srcMAC: src, dstMAC: mac}, nil
		}
	}
	// 邻居表里没有：触发一次解析（宿主机与网关同网段时有效）后再查
	for _, gw := range gateways {
		if c, err := net.DialTimeout("udp4", net.JoinHostPort(gw, "9"), time.Second); err == nil {
			_, _ = c.Write([]byte{0})
			c.Close()
		}
	}
	time.Sleep(time.Second)
	for _, gw := range gateways {
		if mac := neighborMAC(gw, job.Bridge); mac != nil {
			return &l2Target{ifindex: iface.Index, srcMAC: src, dstMAC: mac}, nil
		}
	}
	return nil, errors.New("无法解析网关 MAC")
}

// bridgeUplink 返回网桥里的上联网卡：优先物理网卡，其次不是实例网卡（veth / tap）的成员
func bridgeUplink(bridge string) (string, error) {
	entries, err := os.ReadDir(filepath.Join("/sys/class/net", bridge, "brif"))
	if err != nil {
		return "", errors.New("不是网桥")
	}
	var fallback string
	for _, e := range entries {
		name := e.Name()
		if _, err := os.Stat(filepath.Join("/sys/class/net", name, "device")); err == nil {
			return name, nil
		}
		if fallback == "" && !strings.HasPrefix(name, "veth") && !strings.HasPrefix(name, "tap") && !strings.HasPrefix(name, "vnet") {
			// 绑定（bond）、VLAN 等虚拟上联网卡
			fallback = name
		}
	}
	if fallback == "" {
		return "", errors.New("网桥里没有上联网卡")
	}
	return fallback, nil
}

// defaultGateway 读取经 dev 的默认路由网关（/proc/net/route，小端十六进制）
func defaultGateway(dev string) string {
	f, err := os.Open("/proc/net/route")
	if err != nil {
		return ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 3 || fields[0] != dev || fields[1] != "00000000" {
			continue
		}
		var v uint32
		if _, err := fmt.Sscanf(fields[2], "%x", &v); err != nil || v == 0 {
			continue
		}
		return net.IPv4(byte(v), byte(v>>8), byte(v>>16), byte(v>>24)).String()
	}
	return ""
}

// neighborMAC 从 /proc/net/arp 查找已解析的邻居 MAC
func neighborMAC(ip, dev string) net.HardwareAddr {
	f, err := os.Open("/proc/net/arp")
	if err != nil {
		return nil
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		// IP address  HW type  Flags  HW address  Mask  Device
		fields := strings.Fields(sc.Text())
		if len(fields) < 6 || fields[0] != ip || fields[2] == "0x0" {
			continue
		}
		if dev != "" && fields[5] != dev {
			continue
		}
		if mac, err := net.ParseMAC(fields[3]); err == nil && mac.String() != "00:00:00:00:00:00" {
			return mac
		}
	}
	return nil
}

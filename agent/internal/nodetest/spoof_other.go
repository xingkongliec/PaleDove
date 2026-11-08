//go:build !linux

package nodetest

import (
	"errors"
	"net"
	"time"
)

// spoofer 只在 Linux 上可用（需要 AF_PACKET 抓包）
type spoofer struct{}

func newSpoofer(net.IP, ListingJob) (*spoofer, error) { return nil, errors.New("仅支持 Linux") }

func (s *spoofer) L2() bool { return false }

func (s *spoofer) Ping(net.IP, int) []time.Duration { return nil }

func (s *spoofer) PingResult(net.IP, int) ([]time.Duration, error) {
	return nil, errors.New("仅支持 Linux")
}

func (s *spoofer) Close() {}

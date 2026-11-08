//go:build !linux

package egress

// originalDst 透明转发只在 Linux 上可用
import (
	"errors"
	"net"
)

func originalDst(net.Conn) (*net.TCPAddr, error) {
	return nil, errors.New("透明转发只支持 Linux")
}

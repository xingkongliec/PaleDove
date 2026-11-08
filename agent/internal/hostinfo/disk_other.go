//go:build !linux

package hostinfo

import "errors"

// Agent 只在 Linux 宿主机上运行；其他系统上编译（如开发机上跑测试）时不采集磁盘
func DiskStat(string) (uint64, uint64, error) {
	return 0, 0, errors.New("unsupported")
}

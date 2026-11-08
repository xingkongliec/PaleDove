//go:build linux

package hostinfo

import "syscall"

// DiskStat 返回挂载点的总容量与已用容量（字节），与 df 的口径一致（不含保留给 root 的空间）
func DiskStat(path string) (total, used uint64, err error) {
	var st syscall.Statfs_t
	if err = syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	free := st.Bfree * bs
	avail := st.Bavail * bs
	used = st.Blocks*bs - free
	// df 的总量 = 已用 + 普通用户可用
	return used + avail, used, nil
}

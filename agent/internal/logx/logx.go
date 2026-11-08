// Package logx 提供日志小工具：相同的提示只记录一次，避免刷屏。
package logx

import (
	"log"
	"sync"
)

var (
	mu     sync.Mutex
	logged = map[string]bool{}
)

// Once 相同 key 的提示只记录一次
func Once(key, format string, args ...any) {
	mu.Lock()
	seen := logged[key]
	logged[key] = true
	mu.Unlock()
	if !seen {
		log.Printf(format, args...)
	}
}

// Truncate 截断过长的文本（按字节）
func Truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

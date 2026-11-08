// Package hostinfo 读取宿主机的实时状态：CPU 使用率与核心数、内存与 SWAP、负载、运行时长、进程数、系统信息（/proc）
// 与根分区用量（disk_*.go）。
package hostinfo

import (
	"bufio"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"

	"github.com/paledove/agent/internal/config"
)

// ProcRoot 方便测试时指向样例数据
var ProcRoot = "/proc"

// Usage 为某项资源的总量与已用量（字节）
type Usage struct {
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

type DiskUsage struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Used  uint64 `json:"used"`
}

// ───────── CPU ─────────

// CPUSampler 以两次读取 /proc/stat 的差值计算整机 CPU 使用率
type CPUSampler struct {
	mu          sync.Mutex
	total, idle uint64
}

func NewCPUSampler() *CPUSampler {
	s := &CPUSampler{}
	s.total, s.idle, _ = readCPUStat()
	return s
}

// Percent 返回自上次调用以来的 CPU 使用率（%）
func (s *CPUSampler) Percent() float64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	total, idle, ok := readCPUStat()
	if !ok {
		return 0
	}
	prevTotal, prevIdle := s.total, s.idle
	s.total, s.idle = total, idle
	// 计数器回绕或两次读取之间没有变化时无法计算
	if total <= prevTotal || idle < prevIdle {
		return 0
	}
	dt, di := total-prevTotal, idle-prevIdle
	if di > dt {
		return 0
	}
	return round2((1 - float64(di)/float64(dt)) * 100)
}

// readCPUStat 读取 /proc/stat 第一行：所有时间之和与空闲时间（idle + iowait）
func readCPUStat() (total, idle uint64, ok bool) {
	f, err := os.Open(ProcRoot + "/stat")
	if err != nil {
		return 0, 0, false
	}
	defer f.Close()
	return parseCPUStat(f)
}

func parseCPUStat(r io.Reader) (total, idle uint64, ok bool) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 5 || fields[0] != "cpu" {
			continue
		}
		for i, f := range fields[1:] {
			v, err := strconv.ParseUint(f, 10, 64)
			if err != nil {
				return 0, 0, false
			}
			total += v
			// 第 4、5 列为 idle 与 iowait
			if i == 3 || i == 4 {
				idle += v
			}
		}
		return total, idle, true
	}
	return 0, 0, false
}

// Cores 为 CPU 核心数（/proc/stat 中 cpuN 的行数）
func Cores() int {
	f, err := os.Open(ProcRoot + "/stat")
	if err != nil {
		return runtime.NumCPU()
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "cpu") && len(line) > 3 && line[3] >= '0' && line[3] <= '9' {
			n++
		}
	}
	if n == 0 {
		return runtime.NumCPU()
	}
	return n
}

// ───────── 内存 ─────────

// Memory 读取 /proc/meminfo：内存已用 = 总量 − 可用（MemAvailable）
func Memory() (mem, swap Usage, ok bool) {
	f, err := os.Open(ProcRoot + "/meminfo")
	if err != nil {
		return mem, swap, false
	}
	defer f.Close()
	return parseMeminfo(f)
}

func parseMeminfo(r io.Reader) (mem, swap Usage, ok bool) {
	kv := map[string]uint64{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		k, v, found := strings.Cut(sc.Text(), ":")
		if !found {
			continue
		}
		fields := strings.Fields(v)
		if len(fields) == 0 {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err != nil {
			continue
		}
		kv[k] = n * 1024 // 单位为 kB
	}
	total, hasTotal := kv["MemTotal"]
	if !hasTotal {
		return mem, swap, false
	}
	avail, hasAvail := kv["MemAvailable"]
	if !hasAvail {
		// 旧内核没有 MemAvailable
		avail = kv["MemFree"] + kv["Buffers"] + kv["Cached"]
	}
	mem = Usage{Total: total, Used: sub(total, avail)}
	swap = Usage{Total: kv["SwapTotal"], Used: sub(kv["SwapTotal"], kv["SwapFree"])}
	return mem, swap, true
}

// ───────── 负载、运行时长、进程 ─────────

// Load 为 1、5、15 分钟平均负载
func Load() [3]float64 {
	var out [3]float64
	fields := strings.Fields(ReadTrim(ProcRoot + "/loadavg"))
	for i := 0; i < 3 && i < len(fields); i++ {
		out[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return out
}

// Uptime 为运行时长（秒）
func Uptime() float64 {
	fields := strings.Fields(ReadTrim(ProcRoot + "/uptime"))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

// Processes 统计 /proc 下的进程目录数
func Processes() int {
	entries, err := os.ReadDir(ProcRoot)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		if _, err := strconv.Atoi(e.Name()); err == nil {
			n++
		}
	}
	return n
}

// ───────── 系统信息 ─────────

func Hostname() string {
	h, _ := os.Hostname()
	return h
}

// OSName 读取 /etc/os-release 的 PRETTY_NAME
func OSName() string {
	f, err := os.Open("/etc/os-release")
	if err != nil {
		return ""
	}
	defer f.Close()
	return config.ParseEnv(f)["PRETTY_NAME"]
}

// Kernel 为内核版本
func Kernel() string { return ReadTrim(ProcRoot + "/sys/kernel/osrelease") }

// ReadTrim 读取文件并去掉首尾空白（读取失败时为空）
func ReadTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func sub(a, b uint64) uint64 {
	if b > a {
		return 0
	}
	return a - b
}

func round2(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}

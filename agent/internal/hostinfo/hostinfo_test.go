package hostinfo

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseCPUStat(t *testing.T) {
	total, idle, ok := parseCPUStat(strings.NewReader("cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 2 3 4 5\n"))
	if !ok || total != 1000 || idle != 850 {
		t.Fatalf("got %d %d %v", total, idle, ok)
	}
}

func TestParseMeminfo(t *testing.T) {
	mem, swap, ok := parseMeminfo(strings.NewReader("MemTotal: 2000 kB\nMemFree: 500 kB\nMemAvailable: 1200 kB\nSwapTotal: 1000 kB\nSwapFree: 900 kB\n"))
	if !ok || mem.Total != 2000*1024 || mem.Used != 800*1024 || swap.Total != 1000*1024 || swap.Used != 100*1024 {
		t.Fatalf("got %+v %+v", mem, swap)
	}
}

func TestProcFiles(t *testing.T) {
	dir := t.TempDir()
	old := ProcRoot
	ProcRoot = dir
	defer func() { ProcRoot = old }()
	os.WriteFile(filepath.Join(dir, "loadavg"), []byte("0.50 0.25 0.10 1/215 1234\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "uptime"), []byte("6400000.12 100.00\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "stat"), []byte("cpu 1 2 3 4\ncpu0 1 2 3 4\ncpu1 1 2 3 4\n"), 0o644)
	for _, p := range []string{"1", "42", "self", "sys"} {
		os.Mkdir(filepath.Join(dir, p), 0o755)
	}
	if l := Load(); l != [3]float64{0.5, 0.25, 0.1} {
		t.Fatalf("load %v", l)
	}
	if u := Uptime(); u != 6400000.12 {
		t.Fatalf("uptime %v", u)
	}
	if n := Processes(); n != 2 {
		t.Fatalf("processes %d", n)
	}
	if c := Cores(); c != 2 {
		t.Fatalf("cores %d", c)
	}
}

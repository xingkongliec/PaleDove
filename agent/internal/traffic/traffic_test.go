package traffic

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHostCounterDirectionAndGeneration(t *testing.T) {
	root := t.TempDir()
	write := func(name, value string) {
		p := filepath.Join(root, "tap0", name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("ifindex", "42\n")
	write("statistics/rx_bytes", "100\n")
	write("statistics/tx_bytes", "350\n")
	c, err := ReadCounter(root, "boot1", "tap0", "vm1")
	if err != nil || c.Rx != 350 || c.Tx != 100 || c.Generation != "boot1:vm1:42" {
		t.Fatalf("%+v %v", c, err)
	}
	write("ifindex", "43")
	next, _ := ReadCounter(root, "boot1", "tap0", "vm1")
	if c.Generation == next.Generation {
		t.Fatal("网卡重建必须有独立计数代次")
	}
	if _, err := ReadCounter(root, "boot1", "../tap0", "vm1"); err == nil {
		t.Fatal("允许了目录穿越")
	}
	if _, err := ReadCounter(root, "boot1", "missing", "vm1"); err == nil {
		t.Fatal("读取失败不能当成零计数上报")
	}
}

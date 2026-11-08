package upgrade

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/paledove/agent/internal/buildinfo"
	"github.com/paledove/agent/internal/panel"
)

func TestRejectsUnsafeInstructions(t *testing.T) {
	oldVersion := buildinfo.Version
	buildinfo.Version = "0.3.0"
	defer func() { buildinfo.Version = oldVersion }()
	bin := filepath.Join(t.TempDir(), "paledove-agent")
	os.WriteFile(bin, []byte("old"), 0o755)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("tampered")) }))
	defer srv.Close()
	u := New(srv.URL, http.DefaultClient)
	u.Binary, u.Jitter, u.Restart = bin, 0, func() { t.Fatal("must not restart") }
	// 非同源地址
	if err := u.Apply(context.Background(), Instruction{Version: "9.9.9", URL: "https://evil.example.com/api/agent/binary/amd64", SHA256: strings.Repeat("a", 64), Size: 8}); err == nil {
		t.Fatal("expected cross-origin rejection")
	}
	// sha256 不符
	if err := u.Apply(context.Background(), Instruction{Version: "9.9.8", URL: srv.URL + "/api/agent/binary/amd64", SHA256: strings.Repeat("a", 64), Size: 8}); err == nil {
		t.Fatal("expected checksum rejection")
	}
	// 失败的版本一小时内不再重试
	if err := u.Apply(context.Background(), Instruction{Version: "9.9.8", URL: srv.URL + "/api/agent/binary/amd64", SHA256: strings.Repeat("a", 64), Size: 8}); err != nil {
		t.Fatalf("retry should be skipped, got %v", err)
	}
	if got, _ := os.ReadFile(bin); string(got) != "old" {
		t.Fatalf("binary replaced: %q", got)
	}
}

// 校验通过：备份旧版本、原子替换并重新启动
func TestAppliesValidUpgrade(t *testing.T) {
	oldVersion := buildinfo.Version
	buildinfo.Version = "0.3.0"
	defer func() { buildinfo.Version = oldVersion }()
	newBinary := []byte("#!/bin/sh\necho new\n")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write(newBinary) }))
	defer srv.Close()
	bin := filepath.Join(t.TempDir(), "paledove-agent")
	os.WriteFile(bin, []byte("old"), 0o755)
	restarted := false
	u := New(srv.URL, http.DefaultClient)
	u.Binary, u.Jitter, u.Restart = bin, 0, func() { restarted = true }
	in := Instruction{Version: "9.9.9", URL: srv.URL + "/api/agent/binary/amd64?v=9.9.9", SHA256: panel.SHA256Hex(newBinary), Size: int64(len(newBinary))}
	if err := u.Apply(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(bin)
	backup, _ := os.ReadFile(bin + ".bak")
	if !restarted || string(got) != string(newBinary) || string(backup) != "old" {
		t.Fatalf("restarted=%v bin=%q bak=%q", restarted, got, backup)
	}
}

func TestRejectsCrossOriginRedirect(t *testing.T) {
	oldVersion := buildinfo.Version
	buildinfo.Version = "0.7.0"
	defer func() { buildinfo.Version = oldVersion }()
	contacted := false
	external := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		contacted = true
		w.Write([]byte("new"))
	}))
	defer external.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, external.URL+"/api/agent/binary/amd64", http.StatusFound)
	}))
	defer srv.Close()
	bin := filepath.Join(t.TempDir(), "paledove-agent")
	if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	u := New(srv.URL, http.DefaultClient)
	u.Binary, u.Jitter, u.Restart = bin, 0, func() { t.Fatal("must not restart") }
	err := u.Apply(context.Background(), Instruction{Version: "0.7.1", URL: srv.URL + "/api/agent/binary/amd64", SHA256: panel.SHA256Hex([]byte("new")), Size: 3})
	if err == nil || contacted {
		t.Fatalf("redirect rejection=%v external contacted=%v", err, contacted)
	}
	if got, _ := os.ReadFile(bin); string(got) != "old" {
		t.Fatal("old binary was replaced")
	}
}

func TestRejectsWrongSizeAndMalformedChecksum(t *testing.T) {
	oldVersion := buildinfo.Version
	buildinfo.Version = "0.7.0"
	defer func() { buildinfo.Version = oldVersion }()
	for _, test := range []struct {
		name string
		body string
		size int64
		sha  string
	}{
		{"truncated", "ne", 3, panel.SHA256Hex([]byte("new"))},
		{"too large", "new with trailing data", 3, panel.SHA256Hex([]byte("new"))},
		{"invalid checksum", "new", 3, strings.Repeat("z", 64)},
	} {
		t.Run(test.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(test.body)) }))
			defer srv.Close()
			bin := filepath.Join(t.TempDir(), "paledove-agent")
			if err := os.WriteFile(bin, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			u := New(srv.URL, http.DefaultClient)
			u.Binary, u.Jitter, u.Restart = bin, 0, func() { t.Fatal("must not restart") }
			if err := u.Apply(context.Background(), Instruction{Version: "0.7.1", URL: srv.URL + "/api/agent/binary/amd64", SHA256: test.sha, Size: test.size}); err == nil {
				t.Fatal("expected download rejection")
			}
			if got, _ := os.ReadFile(bin); string(got) != "old" {
				t.Fatal("old binary was replaced")
			}
		})
	}
}

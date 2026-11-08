package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/paledove/agent/internal/buildinfo"
	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/panel"
)

// 上报：携带令牌、上报协议版本，并采用面板返回的上报间隔
func TestReport(t *testing.T) {
	var got Report
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/nodes/report" || r.Header.Get("authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		json.NewDecoder(r.Body).Decode(&got)
		w.Write([]byte(`{"ok":true,"interval":15,"latest":"9.9.9"}`))
	}))
	defer srv.Close()
	a := New(config.Config{PanelURL: srv.URL, Token: "tok"})
	interval, err := a.report(context.Background())
	if err != nil || interval.Seconds() != 15 {
		t.Fatalf("interval %v err %v", interval, err)
	}
	if got.Version != buildinfo.Protocol || len(got.Capabilities) == 0 || got.Arch == "" {
		t.Fatalf("report %+v", got)
	}
	a.panel.SetToken("bad")
	if _, err := a.report(context.Background()); err == nil {
		t.Fatal("expected error for bad token")
	}
}

// 签名上报：面板按同一算法校验请求，回复签名有效时才执行升级指令
func TestSignedReportAndUpgrade(t *testing.T) {
	newBinary := []byte("#!/bin/sh\necho new\n")
	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agent/binary/amd64" {
			w.Write(newBinary)
			return
		}
		body, _ := io.ReadAll(r.Body)
		want := panel.HMACHex("s3cret", panel.SigningPayload(r.Method, r.URL.RequestURI(), r.Header.Get("x-paledove-timestamp"), r.Header.Get("x-paledove-nonce"), panel.SHA256Hex(body)))
		if r.Header.Get("x-paledove-node") != "7" || r.Header.Get("x-paledove-signature") != want {
			w.WriteHeader(401)
			return
		}
		resp := fmt.Sprintf(`{"ok":true,"interval":20,"upgrade":{"version":"9.9.9","url":"%s/api/agent/binary/amd64?v=9.9.9","sha256":"%s","size":%d}}`, srvURL, panel.SHA256Hex(newBinary), len(newBinary))
		w.Header().Set("x-paledove-signature", panel.ResponseSignature("s3cret", r.Header.Get("x-paledove-nonce"), []byte(resp)))
		w.Write([]byte(resp))
	}))
	defer srv.Close()
	srvURL = srv.URL

	oldVersion := buildinfo.Version
	buildinfo.Version = "0.3.0"
	defer func() { buildinfo.Version = oldVersion }()
	bin := filepath.Join(t.TempDir(), "paledove-agent")
	os.WriteFile(bin, []byte("old"), 0o755)

	a := New(config.Config{PanelURL: srv.URL, NodeID: "7", Secret: "s3cret"})
	restarted := false
	a.upgrader.Binary, a.upgrader.Jitter, a.upgrader.Restart = bin, 0, func() { restarted = true }
	interval, err := a.report(context.Background())
	if err != nil || interval.Seconds() != 20 {
		t.Fatalf("interval %v err %v", interval, err)
	}
	got, _ := os.ReadFile(bin)
	backup, _ := os.ReadFile(bin + ".bak")
	if !restarted || string(got) != string(newBinary) || string(backup) != "old" {
		t.Fatalf("restarted=%v bin=%q bak=%q", restarted, got, backup)
	}

	// 密钥错误：面板拒绝
	a.panel.SetSecret("wrong")
	if _, err := a.report(context.Background()); err == nil {
		t.Fatal("expected 401")
	}
}

// 回复签名无效（被篡改）时不执行升级
func TestIgnoresUnsignedUpgrade(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("x-paledove-signature", "deadbeef")
		w.Write([]byte(`{"ok":true,"interval":20,"upgrade":{"version":"9.9.9","url":"http://x/api/agent/binary/amd64","sha256":"` + panel.SHA256Hex([]byte("x")) + `","size":1}}`))
	}))
	defer srv.Close()
	oldVersion := buildinfo.Version
	buildinfo.Version = "0.3.0"
	defer func() { buildinfo.Version = oldVersion }()
	a := New(config.Config{PanelURL: srv.URL, NodeID: "7", Secret: "s3cret"})
	a.upgrader.Restart = func() { t.Fatal("must not upgrade on an unsigned reply") }
	if _, err := a.report(context.Background()); err != nil {
		t.Fatal(err)
	}
}

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseEnv(t *testing.T) {
	got := ParseEnv(strings.NewReader("# 注释\nPANEL_URL='https://p.example.com/'\nAGENT_TOKEN=\"abc\"\n\nBAD\n"))
	if got["PANEL_URL"] != "https://p.example.com/" || got["AGENT_TOKEN"] != "abc" || len(got) != 2 {
		t.Fatalf("unexpected %v", got)
	}
}

func TestLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.env")
	os.WriteFile(path, []byte("PANEL_URL=https://p.example.com/\nAGENT_TOKEN=tok\n"), 0o600)
	cfg, err := Load(path)
	if err != nil || cfg.PanelURL != "https://p.example.com" || cfg.Token != "tok" {
		t.Fatalf("got %+v %v", cfg, err)
	}
	if _, err := Load(filepath.Join(t.TempDir(), "missing.env")); err == nil {
		t.Fatal("expected error for missing config")
	}
}

func TestLoadSigned(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.env")
	os.WriteFile(path, []byte("PANEL_URL=https://p.example.com\nNODE_ID=7\nAGENT_SECRET=s3cret\n"), 0o600)
	cfg, err := Load(path)
	if err != nil || !cfg.Signed() || cfg.NodeID != "7" || cfg.Secret != "s3cret" {
		t.Fatalf("got %+v %v", cfg, err)
	}
}

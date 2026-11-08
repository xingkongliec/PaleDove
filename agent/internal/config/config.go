// Package config 读取 Agent 的配置文件（默认 /etc/paledove/agent.env，由安装脚本用一次性安装令牌向面板换取后写入）：
//
//	PANEL_URL=https://panel.example.com
//	NODE_ID=1
//	AGENT_SECRET=xxxxxxxx
//
// 旧配置（只有 AGENT_TOKEN）仍可使用 Bearer 令牌上报，但不会自动升级。
package config

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// DefaultPath 为默认的配置文件路径
const DefaultPath = "/etc/paledove/agent.env"

type Config struct {
	PanelURL string
	NodeID   string
	Secret   string
	// 旧配置的 Bearer 令牌
	Token string
}

// Signed 表示使用签名请求（新配置）
func (c Config) Signed() bool { return c.NodeID != "" && c.Secret != "" }

// Load 读取 KEY=VALUE 格式的配置文件，环境变量 PANEL_URL / NODE_ID / AGENT_SECRET / AGENT_TOKEN 优先
func Load(path string) (Config, error) {
	cfg := Config{}
	if f, err := os.Open(path); err == nil {
		defer f.Close()
		values := ParseEnv(f)
		cfg.PanelURL = values["PANEL_URL"]
		cfg.NodeID = values["NODE_ID"]
		cfg.Secret = values["AGENT_SECRET"]
		cfg.Token = values["AGENT_TOKEN"]
	} else if !errors.Is(err, os.ErrNotExist) {
		return cfg, err
	}
	for _, kv := range []struct {
		env string
		dst *string
	}{{"PANEL_URL", &cfg.PanelURL}, {"NODE_ID", &cfg.NodeID}, {"AGENT_SECRET", &cfg.Secret}, {"AGENT_TOKEN", &cfg.Token}} {
		if v := os.Getenv(kv.env); v != "" {
			*kv.dst = v
		}
	}
	cfg.PanelURL = strings.TrimRight(cfg.PanelURL, "/")
	if cfg.PanelURL == "" || (!cfg.Signed() && cfg.Token == "") {
		return cfg, fmt.Errorf("配置不完整：%s 中需要 PANEL_URL、NODE_ID 与 AGENT_SECRET，请在面板中重新生成安装命令", path)
	}
	return cfg, nil
}

// ParseEnv 解析 KEY=VALUE（忽略空行与 # 注释，去掉值两边的引号）
func ParseEnv(r io.Reader) map[string]string {
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '\'' && v[len(v)-1] == '\'' || v[0] == '"' && v[len(v)-1] == '"') {
			v = v[1 : len(v)-1]
		}
		out[strings.TrimSpace(k)] = v
	}
	return out
}

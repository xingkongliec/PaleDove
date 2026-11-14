// Package upgrade 按面板下发的升级指令自动升级 Agent。
package upgrade

// 自动升级：面板在上报回复里下发升级指令（版本、下载地址、sha256、大小），回复带签名。
// Agent 只接受签名有效、与 PANEL_URL 同源的 /api/agent/binary/ 地址；随机延迟后下载，校验大小与 sha256，
// 写到同目录临时文件，备份旧版本（.bak）后原子替换，然后退出进程，由 systemd（Restart=always）以新版本重新启动。
// 升级失败的版本一小时内不再重试。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/paledove/agent/internal/buildinfo"
	"github.com/paledove/agent/internal/panel"
)

const (
	maxUpgradeBytes = 64 << 20
	upgradeJitter   = 30 * time.Second
	upgradeRetry    = time.Hour
)

type Instruction struct {
	Version string `json:"version"`
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Size    int64  `json:"size"`
}

type Upgrader struct {
	panelURL string
	client   *http.Client
	// Binary 为二进制路径（默认为当前可执行文件）
	Binary string
	// Restart 为升级完成后的动作（默认退出进程，由 systemd 重新启动；测试时替换）
	Restart func()
	failed  map[string]time.Time
	// Jitter 为下载前等待的随机延迟上限（测试时为 0）
	Jitter time.Duration
}

// New 创建升级器；client 为与面板通信的 HTTP 客户端（复用其传输层）
func New(panelURL string, client *http.Client) *Upgrader {
	exe, err := os.Executable()
	if err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
	}
	u := &Upgrader{
		panelURL: panelURL,
		client:   &http.Client{Timeout: 5 * time.Minute, Transport: client.Transport},
		Binary:   exe,
		Restart:  func() { os.Exit(0) },
		failed:   map[string]time.Time{},
		Jitter:   upgradeJitter,
	}
	u.client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 || !u.sameOrigin(req.URL.String()) {
			return errors.New("拒绝非面板同源的升级重定向")
		}
		return nil
	}
	return u
}

// sameOrigin 判断下载地址与面板地址同源，且是 Agent 二进制下载接口
func (u *Upgrader) sameOrigin(raw string) bool {
	target, err1 := url.Parse(raw)
	base, err2 := url.Parse(u.panelURL)
	if err1 != nil || err2 != nil {
		return false
	}
	prefix := strings.TrimRight(base.Path, "/") + "/api/agent/binary/"
	return target.User == nil && target.Fragment == "" && target.Scheme == base.Scheme && target.Host == base.Host &&
		(target.Path == prefix+"amd64" || target.Path == prefix+"arm64")
}

// Apply 执行升级；不需要升级或校验不通过时返回错误且不替换任何文件
func (u *Upgrader) Apply(ctx context.Context, in Instruction) error {
	if in.Version == "" || in.Version == buildinfo.Version || buildinfo.Version == "dev" {
		return nil
	}
	if t, ok := u.failed[in.Version]; ok && time.Since(t) < upgradeRetry {
		return nil
	}
	if err := u.run(ctx, in); err != nil {
		u.failed[in.Version] = time.Now()
		return err
	}
	log.Printf("已升级到 %s，重新启动", in.Version)
	u.Restart()
	return nil
}

func (u *Upgrader) run(ctx context.Context, in Instruction) error {
	if !u.sameOrigin(in.URL) {
		return fmt.Errorf("拒绝非面板同源的升级地址：%s", in.URL)
	}
	digest, digestErr := hex.DecodeString(in.SHA256)
	if digestErr != nil || len(digest) != 32 || in.Size <= 0 || in.Size > maxUpgradeBytes {
		return errors.New("升级指令不完整")
	}
	if u.Binary == "" {
		return errors.New("无法确定当前程序路径")
	}
	// 随机延迟，避免所有宿主机同时下载
	if u.Jitter > 0 {
		n, _ := rand.Int(rand.Reader, big.NewInt(int64(u.Jitter)))
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Duration(n.Int64())):
		}
	}
	log.Printf("开始升级：%s → %s", buildinfo.Version, in.Version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, in.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("user-agent", buildinfo.UserAgent())
	res, err := u.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("下载升级包失败：%d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, in.Size+1))
	if err != nil {
		return err
	}
	if int64(len(data)) != in.Size {
		return fmt.Errorf("升级包大小不符：期望 %d，实际 %d", in.Size, len(data))
	}
	if !strings.EqualFold(panel.SHA256Hex(data), in.SHA256) {
		return errors.New("升级包 sha256 校验失败")
	}
	// 写到同目录的临时文件，再备份旧版本并原子替换
	next := u.Binary + ".new"
	if err := os.WriteFile(next, data, 0o755); err != nil {
		return err
	}
	_ = os.Remove(u.Binary + ".bak")
	if err := os.Link(u.Binary, u.Binary+".bak"); err != nil {
		// 不支持硬链接时复制一份
		if old, readErr := os.ReadFile(u.Binary); readErr == nil {
			_ = os.WriteFile(u.Binary+".bak", old, 0o755)
		}
	}
	if err := os.Rename(next, u.Binary); err != nil {
		_ = os.Remove(next)
		return err
	}
	return nil
}

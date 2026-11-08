// Package incus 通过 unix socket 访问本机 Incus API（检测是否可用、读取实例状态与虚拟机进程）。
package incus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"time"
)

// Incus 本地 API 的 unix socket 位置（deb 安装 / snap 安装）；设置了 INCUS_DIR 时优先使用其中的 socket
var defaultSockets = []string{
	"/var/lib/incus/unix.socket",
	"/var/snap/incus/common/incus/unix.socket",
	"/run/incus/unix.socket",
}

// Info 为 Incus 检测结果（上报给面板）
type Info struct {
	Available bool   `json:"available"`
	Socket    string `json:"socket,omitempty"`
	Version   string `json:"version,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Client 通过 unix socket 访问本机 Incus API；不在多个 goroutine 间共用（各模块各建一个）
type Client struct {
	socket     string
	candidates []string
	client     *http.Client
}

// New 自动查找 socket（INCUS_DIR 优先，其次 deb / snap 的默认位置）
func New() *Client {
	candidates := append([]string(nil), defaultSockets...)
	if dir := os.Getenv("INCUS_DIR"); dir != "" {
		candidates = append([]string{dir + "/unix.socket"}, candidates...)
	}
	return newClient("", candidates)
}

// NewAt 使用指定的 socket（测试用）
func NewAt(socket string) *Client {
	return newClient(socket, []string{socket})
}

func newClient(socket string, candidates []string) *Client {
	c := &Client{socket: socket, candidates: candidates}
	c.client = &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", c.socket)
			},
		},
	}
	return c
}

// findSocket 返回第一个存在的 socket
func (c *Client) findSocket() string {
	for _, p := range c.candidates {
		if st, err := os.Stat(p); err == nil && st.Mode()&os.ModeSocket != 0 {
			return p
		}
	}
	return ""
}

// Get 请求本地 API，返回 metadata 部分
func (c *Client) Get(ctx context.Context, path string, out any) error {
	if c.socket == "" {
		if c.socket = c.findSocket(); c.socket == "" {
			return fmt.Errorf("找不到 Incus socket")
		}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://incus"+path, nil)
	if err != nil {
		return err
	}
	res, err := c.client.Do(req)
	if err != nil {
		// socket 位置可能变化（如重装 Incus），下次重新查找
		c.socket = ""
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return err
	}
	var env struct {
		Type     string          `json:"type"`
		Error    string          `json:"error"`
		Metadata json.RawMessage `json:"metadata"`
	}
	if err := json.Unmarshal(data, &env); err != nil {
		return fmt.Errorf("Incus 返回格式不正确：%w", err)
	}
	if env.Type == "error" || res.StatusCode >= 400 {
		return fmt.Errorf("Incus：%s", env.Error)
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(env.Metadata, out)
}

// Detect 检测 Incus 是否可用及其版本
func (c *Client) Detect() Info {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	var server struct {
		Environment struct {
			ServerVersion string `json:"server_version"`
		} `json:"environment"`
	}
	if err := c.Get(ctx, "/1.0", &server); err != nil {
		return Info{Available: false, Socket: c.findSocket(), Error: err.Error()}
	}
	return Info{Available: true, Socket: c.socket, Version: server.Environment.ServerVersion}
}

// InstancePID 返回运行中实例的主进程 PID（虚拟机为 QEMU 进程），未运行时为 0
func (c *Client) InstancePID(ctx context.Context, project, name string) (int, error) {
	var state struct {
		Pid int `json:"pid"`
	}
	path := fmt.Sprintf("/1.0/instances/%s/state?project=%s", url.PathEscape(name), url.QueryEscape(project))
	if err := c.Get(ctx, path, &state); err != nil {
		return 0, err
	}
	return state.Pid, nil
}

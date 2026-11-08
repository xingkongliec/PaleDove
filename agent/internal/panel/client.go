// Package panel 是 Agent 与面板通信的客户端：新配置的请求带 HMAC 签名（见 sign.go），
// 旧配置使用 Bearer 令牌；读取回复并校验回复签名，各功能模块只执行签名有效的回复。
package panel

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"time"

	"github.com/paledove/agent/internal/buildinfo"
	"github.com/paledove/agent/internal/config"
)

// Timeout 为请求面板的超时时间
const Timeout = 8 * time.Second

// Response 为面板的回复：Verified 表示回复签名有效（旧配置的 Bearer 请求没有签名）
type Response struct {
	Status   int
	Body     []byte
	Verified bool
}

// Client 向面板发送请求；可在多个 goroutine 中共用
type Client struct {
	cfg  config.Config
	http *http.Client
}

func New(cfg config.Config) *Client {
	return &Client{cfg: cfg, http: &http.Client{Timeout: Timeout}}
}

// Config 为当前配置
func (c *Client) Config() config.Config { return c.cfg }

// SetSecret 替换密钥（测试用）
func (c *Client) SetSecret(secret string) { c.cfg.Secret = secret }

// SetToken 替换旧配置的令牌（测试用）
func (c *Client) SetToken(token string) { c.cfg.Token = token }

// HTTP 为底层的 HTTP 客户端（下载升级包时复用其传输层）
func (c *Client) HTTP() *http.Client { return c.http }

// Signed 表示使用签名请求（新配置）；这时只应执行签名有效的回复
func (c *Client) Signed() bool { return c.cfg.Signed() }

// Trusted 表示可以采用这个回复：签名配置下要求回复签名有效
func (c *Client) Trusted(res *Response) bool { return !c.Signed() || res.Verified }

// Request 发送请求：新配置签名，旧配置使用 Bearer 令牌；读取回复（最多 1 MiB）并校验回复签名
func (c *Client) Request(ctx context.Context, method, path string, body []byte) (*Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.cfg.PanelURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("user-agent", buildinfo.UserAgent())
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	nonce := ""
	if c.cfg.Signed() {
		nonce = newNonce()
		ts := nowMillis()
		req.Header.Set("x-paledove-node", c.cfg.NodeID)
		req.Header.Set("x-paledove-timestamp", ts)
		req.Header.Set("x-paledove-nonce", nonce)
		req.Header.Set("x-paledove-signature", HMACHex(c.cfg.Secret, SigningPayload(method, path, ts, nonce, SHA256Hex(body))))
	} else {
		req.Header.Set("authorization", "Bearer "+c.cfg.Token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	out := &Response{Status: res.StatusCode, Body: data}
	if c.cfg.Signed() {
		out.Verified = VerifyResponse(c.cfg.Secret, nonce, data, res.Header.Get("x-paledove-signature"))
	}
	return out, nil
}

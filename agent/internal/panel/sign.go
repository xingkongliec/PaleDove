package panel

// 请求签名（参考 incudal）：每个请求用 Agent 密钥对「方法、路径、毫秒时间戳、随机数、请求体 sha256」做 HMAC-SHA256，
// 密钥本身不在网络上传输；随机数只能使用一次，面板据此防重放。面板对回复同样签名，Agent 校验后才执行回复中的指令。

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strconv"
	"strings"
	"time"
)

// SHA256Hex 为数据的 sha256（十六进制）
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// HMACHex 为 HMAC-SHA256（十六进制）
func HMACHex(secret, payload string) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(payload))
	return hex.EncodeToString(m.Sum(nil))
}

// SigningPayload 与面板 services/agent/agent.ts 的 signingPayload 一致
func SigningPayload(method, path, timestamp, nonce, bodyHash string) string {
	return strings.Join([]string{strings.ToUpper(method), path, timestamp, nonce, strings.ToLower(bodyHash)}, "\n")
}

// ResponseSignature 为面板回复的签名：HMAC(密钥, "RESPONSE\n随机数\n回复体 sha256")
func ResponseSignature(secret, nonce string, body []byte) string {
	return HMACHex(secret, strings.Join([]string{"RESPONSE", nonce, SHA256Hex(body)}, "\n"))
}

func newNonce() string {
	var b [18]byte
	_, _ = rand.Read(b[:])
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func nowMillis() string { return strconv.FormatInt(time.Now().UnixMilli(), 10) }

// VerifyResponse 校验面板回复的签名
func VerifyResponse(secret, nonce string, body []byte, signature string) bool {
	if secret == "" || signature == "" {
		return false
	}
	want, err1 := hex.DecodeString(ResponseSignature(secret, nonce, body))
	got, err2 := hex.DecodeString(strings.TrimSpace(signature))
	return err1 == nil && err2 == nil && hmac.Equal(want, got)
}

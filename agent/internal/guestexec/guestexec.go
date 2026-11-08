// Package guestexec 在 incus-agent 离线时通过 SSH 执行已签名的面板任务。
package guestexec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/paledove/agent/internal/incus"
	"github.com/paledove/agent/internal/panel"
)

type Job struct {
	RequestID  string            `json:"requestId"`
	ID         int               `json:"id"`
	Name       string            `json:"name"`
	Project    string            `json:"project"`
	Host       string            `json:"host"`
	Password   string            `json:"password"`
	TrustEpoch string            `json:"trustEpoch"`
	Command    []string          `json:"command"`
	Env        map[string]string `json:"env"`
	Timeout    int               `json:"timeout"`
	Deadline   int64             `json:"deadline"`
}
type Result struct {
	RequestID string `json:"requestId"`
	ExitCode  int    `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Error     bool   `json:"error,omitempty"`
}
type cached struct {
	result Result
	at     time.Time
}
type Runner struct {
	mu      sync.Mutex
	running bool
	results map[string]cached
}

func New() *Runner { return &Runner{results: map[string]cached{}} }

var envName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
var instanceName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$`)

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }

// Script 不把环境变量、命令内容或密码放进宿主机的进程参数。
func Script(job Job) (string, error) {
	if len(job.Command) == 0 || len(job.Command) > 256 {
		return "", fmt.Errorf("invalid command")
	}
	var b strings.Builder
	for name, value := range job.Env {
		if !envName.MatchString(name) || strings.ContainsRune(value, 0) {
			return "", fmt.Errorf("invalid environment")
		}
		fmt.Fprintf(&b, "export %s=%s\n", name, quote(value))
	}
	b.WriteString("exec")
	for _, arg := range job.Command {
		if strings.ContainsRune(arg, 0) {
			return "", fmt.Errorf("invalid argument")
		}
		b.WriteByte(' ')
		b.WriteString(quote(arg))
	}
	b.WriteByte('\n')
	return b.String(), nil
}

type limitedBuffer struct{ bytes.Buffer }

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	left := 16384 - b.Len()
	if left > 0 {
		if len(p) > left {
			p = p[:left]
		}
		b.Buffer.Write(p)
	}
	return n, nil
}

func execute(ctx context.Context, job Job) Result {
	result := Result{RequestID: job.RequestID, ExitCode: -1, Error: true}
	if net.ParseIP(job.Host) == nil || !instanceName.MatchString(job.Name) || job.ID <= 0 || job.Password == "" || job.Timeout < 1 || job.Timeout > 60 || job.Deadline <= time.Now().UnixMilli() {
		return result
	}
	script, err := Script(job)
	if err != nil {
		return result
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(job.Timeout)*time.Second)
	defer cancel()
	ctx, deadlineCancel := context.WithDeadline(ctx, time.UnixMilli(job.Deadline))
	defer deadlineCancel()
	var inst struct {
		Type   string            `json:"type"`
		Status string            `json:"status"`
		Config map[string]string `json:"expanded_config"`
	}
	c := incus.New()
	if c.Get(ctx, "/1.0/instances/"+url.PathEscape(job.Name)+"?project="+url.QueryEscape(job.Project), &inst) != nil || inst.Type != "virtual-machine" || inst.Status != "Running" || inst.Config["user.paledove.id"] != fmt.Sprint(job.ID) || inst.Config["volatile.uuid"] == "" {
		return result
	}
	dir, err := os.MkdirTemp("", "paledove-ssh-")
	if err != nil {
		return result
	}
	defer os.RemoveAll(dir)
	passwordPath := filepath.Join(dir, "password")
	askpass := filepath.Join(dir, "askpass")
	if os.WriteFile(passwordPath, []byte(job.Password), 0600) != nil || os.WriteFile(askpass, []byte("#!/bin/sh\nexec cat -- \"$PD_PASSWORD_FILE\"\n"), 0700) != nil {
		return result
	}
	knownDir := "/var/lib/paledove/guest-known-hosts"
	if os.MkdirAll(knownDir, 0700) != nil {
		return result
	}
	alias := fmt.Sprintf("paledove-%x", sha256.Sum256([]byte(job.Project+":"+inst.Config["volatile.uuid"]+":"+job.TrustEpoch)))
	cmd := exec.CommandContext(ctx, "ssh", "-F", "/dev/null", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "NumberOfPasswordPrompts=1", "-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "StrictHostKeyChecking=accept-new", "-o", "UserKnownHostsFile="+filepath.Join(knownDir, alias), "-o", "HostKeyAlias="+alias, "-o", "LogLevel=ERROR", "root@"+job.Host, "sh -s")
	cmd.Env = append(os.Environ(), "SSH_ASKPASS="+askpass, "SSH_ASKPASS_REQUIRE=force", "DISPLAY=paledove:0", "PD_PASSWORD_FILE="+passwordPath)
	cmd.Stdin = strings.NewReader(script)
	var stdout, stderr limitedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err = cmd.Run()
	if ctx.Err() != nil {
		return result
	}
	result.ExitCode = 0
	if err != nil {
		if e, ok := err.(*exec.ExitError); ok && e.ExitCode() >= 0 && e.ExitCode() < 255 {
			result.ExitCode = e.ExitCode()
		} else {
			return result
		}
	}
	result.Error = false
	result.Stdout = stdout.String()
	result.Stderr = stderr.String()
	return result
}

// 已执行结果保留十分钟；回传失败时重传结果，避免密码等命令重复执行。
func (r *Runner) MaybeRun(ctx context.Context, c *panel.Client, jobs []Job) {
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	r.running = true
	r.mu.Unlock()
	go func() {
		defer func() { r.mu.Lock(); r.running = false; r.mu.Unlock() }()
		for _, job := range jobs {
			if job.Deadline <= time.Now().UnixMilli() {
				continue
			}
			for id, old := range r.results {
				if time.Since(old.at) > 10*time.Minute {
					delete(r.results, id)
				}
			}
			old, ok := r.results[job.RequestID]
			if !ok {
				old = cached{execute(ctx, job), time.Now()}
				r.results[job.RequestID] = old
			}
			body, _ := json.Marshal(old.result)
			// 连接失败时下次心跳继续回传缓存结果，不重跑命令。
			_, _ = c.Request(ctx, http.MethodPost, "/api/agent/nodes/guest-result", body)
		}
	}()
}

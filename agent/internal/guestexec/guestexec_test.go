package guestexec

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func TestScriptPreservesArgumentsAndEnvironment(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("需要 POSIX shell")
	}
	value := "pw'\"$HOME`id`\\\nsecond line"
	script, err := Script(Job{Command: []string{"sh", "-c", "printf '%s' \"$PW\"; printf '%s' \"$1\"", "sh", "; echo INJECTED"}, Env: map[string]string{"PW": value}})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(sh)
	cmd.Stdin = strings.NewReader(script)
	out, err := cmd.Output()
	if err != nil || string(out) != value+"; echo INJECTED" {
		t.Fatalf("参数未安全保留 %q %v", out, err)
	}
	for _, job := range []Job{{Command: []string{"id"}, Env: map[string]string{"X;id": "bad"}}, {Command: []string{"id\x00oops"}}, {}} {
		if _, err := Script(job); err == nil {
			t.Fatal("接受了非法命令或环境变量")
		}
	}
}

func TestRejectsInvalidOrExpiredJobs(t *testing.T) {
	for _, j := range []Job{{Host: "-oProxyCommand=id"}, {Name: "../host"}, {Deadline: 1}} {
		r := execute(context.Background(), j)
		if !r.Error || r.ExitCode != -1 {
			t.Fatalf("invalid job executed: %+v", r)
		}
	}
}

package instances

// 实例资源上报：过滤查看列表、读取本机 Incus 的实例状态、签名上报，并采用面板续期的列表
import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/paledove/agent/internal/config"
	"github.com/paledove/agent/internal/incus"
	"github.com/paledove/agent/internal/panel"
)

func TestInstanceReporterPush(t *testing.T) {
	// 模拟的 Incus（unix socket）：只有 pd-1-a 存在
	dir, err := os.MkdirTemp("", "pdi")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	sock := filepath.Join(dir, "incus.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Skipf("unix socket 不可用：%v", err)
	}
	incusSrv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/1.0/instances/pd-1-a/state" {
			w.Write([]byte(`{"type":"sync","metadata":{"status":"Running","cpu":{"usage":123},"memory":{"usage":456}}}`))
			return
		}
		w.WriteHeader(404)
		w.Write([]byte(`{"type":"error","error":"Instance not found"}`))
	})}
	go incusSrv.Serve(ln)
	defer incusSrv.Close()

	// 模拟的面板：校验签名，记录上报内容，回复续期的列表
	var got struct {
		States []instanceStateReport `json:"states"`
	}
	watch := `{"names":["pd-1-a"],"interval":5}`
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		want := panel.HMACHex("s3cret", panel.SigningPayload(r.Method, r.URL.RequestURI(), r.Header.Get("x-paledove-timestamp"), r.Header.Get("x-paledove-nonce"), panel.SHA256Hex(body)))
		if r.URL.Path != "/api/agent/nodes/instance-states" || r.Header.Get("x-paledove-signature") != want {
			w.WriteHeader(401)
			return
		}
		json.Unmarshal(body, &got)
		resp := `{"ok":true,"watch":` + watch + `}`
		w.Header().Set("x-paledove-signature", panel.HMACHex("s3cret", strings.Join([]string{"RESPONSE", r.Header.Get("x-paledove-nonce"), panel.SHA256Hex([]byte(resp))}, "\n")))
		w.Write([]byte(resp))
	}))
	defer srv.Close()

	c := panel.New(config.Config{PanelURL: srv.URL, NodeID: "7", Secret: "s3cret"})
	r := New()
	r.incus = incus.NewAt(sock)

	// 非法名称与重复名称被过滤；间隔超出范围时用默认值
	if !r.setWatch(&Watch{Names: []string{"pd-1-a", "../etc", "pd-1-a", "pd-1-missing"}, Interval: 999}) {
		t.Fatal("expected watched instances")
	}
	if strings.Join(r.names, ",") != "pd-1-a,pd-1-missing" || r.interval != defaultInstanceInterval {
		t.Fatalf("names %v interval %v", r.names, r.interval)
	}

	next, err := r.push(context.Background(), c, r.names)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.States) != 2 || got.States[0].Name != "pd-1-a" || !strings.Contains(string(got.States[0].State), `"usage":123`) {
		t.Fatalf("states %+v", got.States)
	}
	if got.States[1].Name != "pd-1-missing" || got.States[1].Error == "" || got.States[1].State != nil {
		t.Fatalf("missing instance %+v", got.States[1])
	}
	if next == nil || len(next.Names) != 1 || next.Interval != 5 {
		t.Fatalf("next %+v", next)
	}

	// 面板不再需要（watch 为 null）：列表清空，循环随后停止
	watch = "null"
	next, err = r.push(context.Background(), c, []string{"pd-1-a"})
	if err != nil || next == nil || len(next.Names) != 0 || r.setWatch(next) {
		t.Fatalf("expected empty watch, got %+v err %v", next, err)
	}

	// 密钥错误：面板拒绝
	c.SetSecret("wrong")
	if _, err := r.push(context.Background(), c, []string{"pd-1-a"}); err == nil {
		t.Fatal("expected 401")
	}
}

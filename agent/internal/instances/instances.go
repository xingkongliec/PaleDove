package instances

// 实例资源上报：面板在回复里告知正在查看的实例（实例管理页面打开期间），Agent 每隔几秒通过本机
// Incus API 读取这些实例的实时状态（CPU 计数、内存、磁盘、网卡计数器等）并上报；面板据此显示
// 「Agent 上报」的实时数据，不再从面板直接连接 Incus 查询。没有实例被查看时不读取、不上报。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/paledove/agent/internal/incus"
	"github.com/paledove/agent/internal/logx"
	"github.com/paledove/agent/internal/panel"
)

const (
	// 面板没有续期时，查看列表在这段时间后失效（页面关闭后自动停止上报）
	instanceWatchTTL = 30 * time.Second
	// 单次最多上报的实例数
	maxWatchedInstances     = 20
	minInstanceInterval     = 2 * time.Second
	maxInstanceInterval     = 30 * time.Second
	defaultInstanceInterval = 3 * time.Second
)

// 实例名称只允许 Incus 合法字符，避免拼接到 API 路径时出现意外
var instanceNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,62}$`)

// Watch 为面板下发的查看列表：实例名称与上报间隔（秒）
type Watch struct {
	Names    []string `json:"names"`
	Interval int      `json:"interval"`
}

// instanceStateReport 为一个实例的上报：Incus 的 /1.0/instances/<name>/state 原样转发
type instanceStateReport struct {
	Name  string          `json:"name"`
	State json.RawMessage `json:"state,omitempty"`
	Error string          `json:"error,omitempty"`
}

type Reporter struct {
	// 单独的 Incus 客户端：上报在独立的 goroutine 中进行，不与主循环共用连接状态
	incus    *incus.Client
	mu       sync.Mutex
	names    []string
	interval time.Duration
	until    time.Time
	running  bool
}

func New() *Reporter {
	return &Reporter{incus: incus.New(), interval: defaultInstanceInterval}
}

// setWatch 更新查看列表（过滤非法名称、限制数量与间隔），返回是否有需要上报的实例
func (r *Reporter) setWatch(w *Watch) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	if w == nil {
		return len(r.names) > 0 && time.Now().Before(r.until)
	}
	names := make([]string, 0, len(w.Names))
	seen := map[string]bool{}
	for _, n := range w.Names {
		if instanceNameRe.MatchString(n) && !seen[n] && len(names) < maxWatchedInstances {
			seen[n] = true
			names = append(names, n)
		}
	}
	r.names = names
	interval := time.Duration(w.Interval) * time.Second
	if interval < minInstanceInterval || interval > maxInstanceInterval {
		interval = defaultInstanceInterval
	}
	r.interval = interval
	r.until = time.Now().Add(instanceWatchTTL)
	return len(names) > 0
}

// MaybeStart 收到面板的查看列表后调用：有需要上报的实例且上报循环未运行时启动
func (r *Reporter) MaybeStart(ctx context.Context, c *panel.Client, w *Watch) {
	if !r.setWatch(w) {
		return
	}
	r.mu.Lock()
	if r.running {
		r.mu.Unlock()
		return
	}
	r.running = true
	r.mu.Unlock()
	go r.loop(ctx, c)
}

func (r *Reporter) loop(ctx context.Context, c *panel.Client) {
	failures := 0
	for {
		r.mu.Lock()
		names := append([]string(nil), r.names...)
		interval := r.interval
		expired := len(names) == 0 || time.Now().After(r.until)
		if expired {
			r.running = false
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()

		next, err := r.push(ctx, c, names)
		if err != nil {
			failures++
			if failures == 1 || failures%30 == 0 {
				logx.Once("instances:"+err.Error(), "实例资源上报失败：%v", err)
			}
		} else {
			failures = 0
			// 面板在回复里续期查看列表（列表为空时随后停止）
			r.setWatch(next)
		}
		select {
		case <-ctx.Done():
			r.mu.Lock()
			r.running = false
			r.mu.Unlock()
			return
		case <-time.After(interval):
		}
	}
}

// collect 读取各实例的实时状态
func (r *Reporter) collect(ctx context.Context, names []string) []instanceStateReport {
	out := make([]instanceStateReport, 0, len(names))
	for _, name := range names {
		c, cancel := context.WithTimeout(ctx, 5*time.Second)
		var state json.RawMessage
		err := r.incus.Get(c, "/1.0/instances/"+url.PathEscape(name)+"/state", &state)
		cancel()
		if err != nil {
			out = append(out, instanceStateReport{Name: name, Error: logx.Truncate(err.Error(), 300)})
			continue
		}
		out = append(out, instanceStateReport{Name: name, State: state})
	}
	return out
}

// push 上报一次，返回面板续期后的查看列表（回复签名无效时不采用）
func (r *Reporter) push(ctx context.Context, c *panel.Client, names []string) (*Watch, error) {
	body, err := json.Marshal(map[string]any{"states": r.collect(ctx, names)})
	if err != nil {
		return nil, err
	}
	res, err := c.Request(ctx, http.MethodPost, "/api/agent/nodes/instance-states", body)
	if err != nil {
		return nil, err
	}
	if res.Status != http.StatusOK {
		return nil, fmt.Errorf("面板返回 %d：%s", res.Status, strings.TrimSpace(string(res.Body)))
	}
	if !c.Trusted(res) {
		return nil, fmt.Errorf("回复签名无效")
	}
	var reply struct {
		Watch *Watch `json:"watch"`
	}
	if err := json.Unmarshal(res.Body, &reply); err != nil {
		return nil, err
	}
	if reply.Watch == nil {
		// 面板不再需要：清空列表，循环随后停止
		return &Watch{}, nil
	}
	return reply.Watch, nil
}

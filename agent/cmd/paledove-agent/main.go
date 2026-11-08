// PaleDove 宿主机 Agent：常驻在宿主机上，定时向面板上报宿主机的实时资源与运行状态，
// 并按面板的回复限制虚拟机 CPU、自动升级、进行节点测试、上报实例资源与执行智能分流（见 internal/agent）。
//
// 配置文件默认为 /etc/paledove/agent.env（见 internal/config），每个请求都用 AGENT_SECRET 做 HMAC 签名（见 internal/panel）。
//
// 用法：
//
//	paledove-agent                 常驻运行（由 systemd 管理）
//	paledove-agent -once           采集一次并打印上报内容（排查问题用，不上报）
//	paledove-agent -version        打印版本
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/paledove/agent/internal/agent"
	"github.com/paledove/agent/internal/buildinfo"
	"github.com/paledove/agent/internal/config"
)

func main() {
	configPath := flag.String("config", config.DefaultPath, "配置文件路径")
	once := flag.Bool("once", false, "采集一次并打印上报内容（不上报）")
	showVersion := flag.Bool("version", false, "打印版本")
	flag.Parse()
	log.SetFlags(0)

	if *showVersion {
		fmt.Printf("paledove-agent %s (protocol %d)\n", buildinfo.Version, buildinfo.Protocol)
		return
	}
	if *once {
		a := agent.New(config.Config{})
		// CPU 使用率需要两次采样
		time.Sleep(time.Second)
		out, _ := json.MarshalIndent(a.Collect(), "", "  ")
		fmt.Println(string(out))
		return
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatal(err)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("paledove-agent %s 已启动，面板 %s", buildinfo.Version, cfg.PanelURL)
	agent.New(cfg).Run(ctx)
	log.Printf("已停止")
}

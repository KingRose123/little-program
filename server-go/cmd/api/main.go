// Command api 是收息佬的 App 专用后端。
//
// 启动顺序刻意保持简单：
//   读配置 → 建数据库对象（不连网）→ 起 HTTP → 等退出信号。
//
// 数据库**不在启动时强连**：真连不上时进程照样能起来并对外提供
// /api/health（它会说 mysql: false），这样排查「为什么部署完打不开」
// 时至少有东西可看，而不是一个反复重启的容器和几行栈信息。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"xiji/api/internal/api"
	"xiji/api/internal/config"
	"xiji/api/internal/db"
	"xiji/api/internal/payment"
	"xiji/api/internal/quote"
	"xiji/api/internal/shadow"
	"xiji/api/internal/store"
	"xiji/api/internal/wxpay"
)

func main() {
	// 带微秒的时间戳：排查「回调比落库先到」这类时序问题时，
	// 秒级精度不够用。
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("[xiji-api] 配置错误: %v", err)
	}

	// 把进程时区设成业务时区。
	//
	// Go 的 time.Now() 默认走 time.Local，而日志时间戳、批次号这些地方都在用它。
	// 容器默认是 UTC，不设的话排查问题时看到的日志时间会比用户的认知差 8 小时 ——
	// 「用户说 9 点出的问题，日志里却是 1 点」这种错位很影响判断。
	time.Local = cfg.Location

	database := db.Open(cfg)
	defer func() { _ = database.Close() }()

	st := store.New(database, cfg.Location, cfg.TokenTTLDays)
	sh := shadow.New(database)

	// 支付渠道：按注册顺序装配，第一个已就绪的即「默认渠道」
	// （客户端不传 channel 时用它）。
	//
	// 配不齐**不拦启动**：那只是「在线支付暂时不能用」，不该让登录、同步、
	// 会员查询跟着起不来。缺什么由 /api/health 的 pay 段报出来。
	//
	// 加一个新渠道就在下面 append 一段，handler / 路由 / 订单流程
	// 一行都不用动 —— 它们只认识 payment.Channel 接口。
	var channels []payment.Channel

	wxCfg := wxpay.Load()
	if wxCfg.Ready() {
		client, err := wxpay.NewClient(wxCfg)
		switch {
		case err != nil:
			// 私钥解析失败之类：配了但配错了。当成未开通处理，
			// 并把缺失清单带上，运维一看 health 就知道要修哪个变量。
			log.Printf("[xiji-api] 微信支付配置有误，按未开通处理: %v", err)
			channels = append(channels, payment.Unconfigured{
				ChannelName: "wxpay",
				Lack:        wxpay.MissingLack(),
			})
		default:
			channels = append(channels, client)
			log.Printf("[xiji-api] 微信支付已启用（商户号 %s）", wxCfg.MchID)
		}
	} else {
		channels = append(channels, payment.Unconfigured{
			ChannelName: "wxpay",
			Lack:        wxCfg.Missing(),
		})
		log.Printf("[xiji-api] 微信支付未配置，付费走兑换码通道（缺 %v）", wxCfg.Missing())
	}

	// 下一个渠道加在这里。以支付宝为例：
	//
	//	aliCfg := alipay.Load()
	//	if aliCfg.Ready() {
	//		if client, err := alipay.NewClient(aliCfg); err == nil {
	//			channels = append(channels, client)
	//		} else {
	//			channels = append(channels, payment.Unconfigured{
	//				ChannelName: "alipay", Lack: alipay.MissingLack(),
	//			})
	//		}
	//	} else {
	//		channels = append(channels, payment.Unconfigured{
	//			ChannelName: "alipay", Lack: aliCfg.Missing(),
	//		})
	//	}
	//
	// 注册顺序就是默认渠道的优先级，所以把最想让人用的那个放前面。

	srv := api.NewServer(api.Deps{
		Config: cfg,
		DB:     database,
		Store:  st,
		Shadow: sh,
		Pay:    payment.New(channels...),
		Quote:  quote.New(),
	})

	httpSrv := &http.Server{
		Addr:    ":" + strconv.Itoa(cfg.Port),
		Handler: srv.Routes(),

		// 这几个超时一个都不能省：没有 ReadHeaderTimeout 的话，
		// 一个只连不发数据的连接就能占住一个 goroutine 直到天荒地老。
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second, // 5MB 快照上传要留够时间
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	go func() {
		log.Printf("[xiji-api] build=%s listening on :%d db=%s tz=%s",
			cfg.Build, cfg.Port, cfg.DBName, cfg.Location)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[xiji-api] 监听失败: %v", err)
		}
	}()

	// 等退出信号。容器里 docker stop 发的是 SIGTERM，
	// 直接被杀掉会让正在写快照的请求半途中断 ——
	// 客户端那边就表现为「保存失败」，而它本可以正常完成。
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Printf("[xiji-api] 收到退出信号，正在等待在途请求完成…")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := httpSrv.Shutdown(ctx); err != nil {
		log.Printf("[xiji-api] 关闭超时，仍有请求在跑: %v", err)
	}
	log.Printf("[xiji-api] 已退出")
}

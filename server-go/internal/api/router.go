package api

import "net/http"

// Routes 注册全部路由。
//
// 用的是 Go 1.22 起标准库 ServeMux 的「方法 + 路径」模式
// （`GET /api/state` 这种写法），所以整个项目**零 Web 框架依赖**。
// 对一个接口数量在二十上下的服务来说，引入框架带来的抽象成本
// 大于它省下的那点样板代码。
//
// 路径全部沿用旧版，包括那个名字已经过时的 /api/membership/vpay/order：
// App 端写死了它，改名就得跟着发版。
func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	// 运维
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/stats", s.handleStats)

	// 账号
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("GET /api/auth/me", s.handleMe)
	mux.HandleFunc("POST /api/auth/logout", s.handleLogout)
	mux.HandleFunc("DELETE /api/auth/account", s.handleDestroyAccount)

	// 数据快照
	mux.HandleFunc("GET /api/state", s.handleGetState)
	mux.HandleFunc("PUT /api/state", s.handlePutState)
	mux.HandleFunc("DELETE /api/state", s.handleDeleteState)

	// 会员与支付
	mux.HandleFunc("GET /api/membership", s.handleMembership)
	mux.HandleFunc("POST /api/membership/redeem", s.handleRedeem)

	// 支付：新路径按渠道分发，旧路径锁定微信。
	//
	// 旧的两条（appay/prepay、appay/notify）**必须留着** —— 现网 App 把
	// 路径写死了，删掉等于让所有已装机的用户点支付就 404。等 App 发版
	// 切过来之后再删，与下面 /vpay/order 那个别名是同一回事。
	mux.HandleFunc("POST /api/membership/pay/prepay", s.handlePayPrepay)
	mux.HandleFunc("POST /api/membership/pay/notify/{channel}", s.handlePayNotify)
	mux.HandleFunc("GET /api/membership/pay/channels", s.handlePayChannels)
	mux.HandleFunc("POST /api/membership/appay/prepay", s.handleAppayPrepay)
	mux.HandleFunc("POST /api/membership/appay/notify", s.handleAppayNotify)

	// 订单查询注册两份：/order 是语义正确的名字，
	// /vpay/order 是 App 现行版本在用的老路径。等 App 下次发版切成新路径后，
	// 旧的那行才能删 —— 在那之前删掉它等于让所有已装机的用户查不到订单。
	mux.HandleFunc("GET /api/membership/order", s.handleOrderStatus)
	mux.HandleFunc("GET /api/membership/vpay/order", s.handleOrderStatus)

	// 后台（令牌与定时任务共用 CRON_TOKEN）
	mux.HandleFunc("POST /api/admin/codes", s.handleGenCodes)
	// 生成之后要看「发出去了哪些、还剩哪些没用」—— 这是卖码时唯一能防重复发的依据
	mux.HandleFunc("GET /api/admin/codes", s.handleListCodes)
	mux.HandleFunc("GET /api/admin/codes/export", s.handleExportCodes)
	mux.HandleFunc("POST /api/admin/codes/void", s.handleVoidCodes)
	mux.HandleFunc("POST /api/admin/reset-password", s.handleResetPassword)
	mux.HandleFunc("POST /api/admin/backfill", s.handleBackfill)
	mux.HandleFunc("GET /api/admin/overview", s.handleOverview)

	// 行情（公开市场数据，不校验登录）
	//
	// 整组套按 IP 的限流：这是全站唯一「不校验登录 + 背后是免费上游」的组合，
	// 也就是唯一能被别人随手打到不可用的地方。详见 withPublicLimit 的注释。
	mux.HandleFunc("GET /api/quote/search", s.withPublicLimit(s.handleQuoteSearch))
	mux.HandleFunc("GET /api/quote", s.withPublicLimit(s.handleQuote))
	mux.HandleFunc("GET /api/fund", s.withPublicLimit(s.handleFund))
	mux.HandleFunc("GET /api/dividend", s.withPublicLimit(s.handleDividend))
	mux.HandleFunc("GET /api/detail", s.withPublicLimit(s.handleDetail))
	mux.HandleFunc("POST /api/quotes", s.withPublicLimit(s.handleQuotes))
	mux.HandleFunc("POST /api/details", s.withPublicLimit(s.handleDetails))

	// 定时任务（服务器上的 cron 用 curl 触发）
	mux.HandleFunc("POST /api/cron/warm", s.handleCronWarm)
	mux.HandleFunc("POST /api/cron/clean", s.handleCronClean)

	// 兜底：未匹配的路径统一回 JSON 404。
	// 客户端拿到 404 会降级为直连东方财富（app/src/utils/quote.js 里的兜底通道），
	// 所以将来新增接口前，老客户端打过来也是可用的行为。
	mux.HandleFunc("/", s.handleNotFound)

	return withCommon(mux)
}

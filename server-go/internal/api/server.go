// Package api 是 HTTP 层：解析请求、调用 store、组装响应。
//
// 分层约定：
//   - 这一层**不写 SQL**，所有取数都通过 store / shadow；
//   - 这一层负责把错误翻译成状态码（见 respond.go 的 FailBiz），
//     store 只管抛出 apperr.Biz；
//   - 响应形状就是对外契约，字段名不许随手改（App 是按字面名解析的）。
package api

import (
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"xiji/api/internal/apperr"
	"xiji/api/internal/config"
	"xiji/api/internal/db"
	"xiji/api/internal/payment"
	"xiji/api/internal/quote"
	"xiji/api/internal/ratelimit"
	"xiji/api/internal/shadow"
	"xiji/api/internal/store"
)

// Server 持有所有依赖。
//
// 依赖是显式注入的（而不是包级单例）：这样才能在测试里换掉数据库、
// 换掉支付渠道 —— 支付尤其需要，塞一个假渠道就能把下单、回调、
// 幂等发货整条链路测完，不必真的去请求微信。
type Server struct {
	cfg    *config.Config
	db     *db.DB
	store  *store.Store
	shadow *shadow.Service
	// pay 是支付渠道注册表。handler 只跟 payment.Channel 接口打交道，
	// 不认识微信 / 支付宝的具体类型 —— 这也是再加一个渠道不用动 api 层的原因。
	pay   *payment.Service
	quote *quote.Service

	// pubLimit 是公开接口（行情）按客户端 IP 的限流。nil 表示配置里关闭了。
	pubLimit *ratelimit.Limiter

	started time.Time
}

type Deps struct {
	Config *config.Config
	DB     *db.DB
	Store  *store.Store
	Shadow *shadow.Service
	Pay    *payment.Service
	Quote  *quote.Service
}

func NewServer(d Deps) *Server {
	q := d.Quote
	if q == nil {
		q = quote.New()
	}
	pay := d.Pay
	if pay == nil {
		// 没给渠道也要能跑：此时 Get 恒返回 nil，下单接口会回 notReady，
		// 用户走兑换码 —— 与「渠道没配好」的表现一致，不会 panic。
		pay = payment.New()
	}

	// 公开接口的限流。额度含义见 config.DefaultPublicRateLimit 的注释，
	// 要点是别把「一栋楼共用一个出口 IP」误伤成攻击。
	var pubLimit *ratelimit.Limiter
	if d.Config != nil && d.Config.PublicRateLimit > 0 {
		n := d.Config.PublicRateLimit
		// 突发额度取每分钟的 1/4（下限 20）：App 打开持仓页会连着发几个请求，
		// 桶太小会把这种正常突发判成攻击 —— 而误伤是最容易被投诉的问题，
		// 因为用户看到的只是「行情时好时坏」，根本不知道是限流。
		burst := n / 4
		if burst < 20 {
			burst = 20
		}
		pubLimit = ratelimit.New(n, burst)
	}

	return &Server{
		cfg:      d.Config,
		db:       d.DB,
		store:    d.Store,
		shadow:   d.Shadow,
		pay:      pay,
		quote:    q,
		pubLimit: pubLimit,
		started:  time.Now(),
	}
}

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	// 回 JSON 而不是 Go 默认的纯文本 404：客户端会尝试 JSON.parse，
	// 拿到非 JSON 时只能报「服务异常（404）」这种没信息量的错。
	Fail(w, http.StatusNotFound, "Not Found: "+r.Method+" "+r.URL.Path)
}

/* ---------------- 工具 ---------------- */

func trimSpace(s string) string { return strings.TrimSpace(s) }

// normalizeCode 规范化兑换码：转大写并去掉所有非字母数字字符。
//
// 用户从微信、短信里复制兑换码时经常会带上空格、换行、甚至连字符，
// 服务端统一清洗一遍，比让用户自己发现「多了一个空格」友好得多。
func normalizeCode(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(raw)) {
		switch {
		case r >= '0' && r <= '9', r >= 'A' && r <= 'Z':
			b.WriteRune(r)
		}
	}
	return b.String()
}

// userMsgOf 取一句能给用户看的错误文案。
func userMsgOf(err error, fallback string) string {
	return apperr.Message(err, fallback)
}

// readAllLimited 读请求体并限制大小。
//
// 支付回调必须用**原始字节**：微信的验签是对报文原文做的，
// 先用 JSON 解析器读一遍，换行和空白可能就变了，签出来对不上。
func readAllLimited(r *http.Request, limit int64) ([]byte, error) {
	defer r.Body.Close()
	return io.ReadAll(io.LimitReader(r.Body, limit))
}

// clientIP 取调用方的真实 IP，用于登录限流与公开接口限流。
//
// 服务跑在 Caddy / Nginx 后面，此时 RemoteAddr 永远是反代的内网地址，
// 直接用它会发现「所有请求都来自同一个 IP」，限流与排查都没意义。
//
// 【为什么取最后一段，而不是 RFC 语义上的第一段】
// XFF 的标准格式是 "客户端, 代理1, 代理2" —— 照字面说第一段才是客户端。
// 但 XFF 只是一个**请求头**，调用方可以抢先塞一个：他发
// "X-Forwarded-For: 1.2.3.4"，反代在末尾追加真实 IP，列表就成了
// "1.2.3.4, 真实IP"。按第一段取，拿到的是他编的值，每次换一个就绕过限流。
//
// 最后一段是紧邻我们的那层反代写进去的，调用方控制不了。
// 前提是**这台机器只有一层反代**（当前部署正是如此：Caddy 直接对外）。
// 将来如果在 Caddy 前面又加了 CDN / LB，这里要改成「从右往左跳过已知代理」，
// 不能继续简单地取最后一段。
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		if last := strings.TrimSpace(parts[len(parts)-1]); last != "" {
			return last
		}
	}
	// 有些反代只设 X-Real-IP
	if real := strings.TrimSpace(r.Header.Get("X-Real-IP")); real != "" {
		return real
	}

	// 没经过代理时走这里：容器内的健康检查、运维在本机 curl
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return strings.TrimSpace(r.RemoteAddr)
}

// itoa 是 strconv.Itoa 的短名字 —— 它在拼用户可见文案的地方用得很多，
// 那些地方行本身就很长。
func itoa(n int) string { return strconv.Itoa(n) }

// atoiDefault 解析查询串里的整数，解析不出来就用默认值。
// 查询串里的参数都是可选的，用户不会因为少传一个 size 而看到报错。
func atoiDefault(s string, def int) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil || n <= 0 {
		return def
	}
	return n
}

// timeKey 生成可读的时间戳串，用作批次号之类的标识。
// 用可读格式而不是随机数：在后台看到 "20260919-203000" 就知道是哪一批。
func timeKey() string {
	return time.Now().In(time.Local).Format("20060102-150405")
}

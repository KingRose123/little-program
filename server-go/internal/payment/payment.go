// Package payment 是支付渠道的注册表与统一契约。
//
// 为什么要有这一层：会员是**虚拟商品**，各渠道的约束完全不同 ——
// Android 上可以走微信 / 支付宝 / 银联，而 iOS 上苹果硬性要求走 Apple 内购
// （Guideline 3.1.1：虚拟商品不得用第三方支付）。也就是说"接一个新渠道"
// 不是可选项，而是迟早要面对的事。
//
// 但渠道之间的差异其实只集中在两件事上：
//  1. 怎么下单 —— 调谁的接口、传什么、拿回什么交给客户端 SDK；
//  2. 怎么验回调 + 怎么应答 —— 签名方式与应答格式各家都不一样。
//
// 其余部分（订单落库、幂等发货、按渠道对账）对所有渠道完全相同。
// 所以把差异收进 Channel 接口，api 层只跟接口打交道：
// 以后接一个新渠道 = 写一个实现文件 + 注册进 Service + 填几个环境变量，
// handler、路由、订单流程一行都不用动。
package payment

import (
	"context"
	"errors"
	"net/http"

	"xiji/api/internal/store"
)

// Channel 是一个支付渠道。
type Channel interface {
	// Name 是渠道标识：写进订单的 channel 列，也是回调路径的一段。
	// 用稳定的小写标识（wxpay / alipay / unionpay / applepay），别用中文 ——
	// 它会被拼进 URL，也会出现在对账的 group by 里。
	Name() string

	// Ready 表示配置齐全、可以下单。
	Ready() bool

	// Missing 列出还缺哪些环境变量。Ready 为 false 时客户端会退回兑换码，
	// 而运维需要知道具体去配什么。只回变量名，不回内容。
	Missing() []string

	// Prepay 向渠道下单，返回「调起支付参数」（交给客户端 SDK 的那一份）。
	Prepay(ctx context.Context, order *store.Order) (*PrepayResult, error)

	// ParseNotify 校验并解析支付回调，返回**统一之后**的事件。
	ParseNotify(header http.Header, rawBody []byte) (*NotifyEvent, error)

	// NotifyReply 按该渠道要求的格式应答回调。
	//
	// 这件事必须归渠道自己管：微信要求 200 + {"code":"SUCCESS"}、失败 5xx，
	// 支付宝要求回纯文本 "success"、失败回 "failure"。应答格式不对，
	// 对方会一直重推同一条通知 —— 幂等发货虽然挡住了重复加时长，
	// 但让同一条回调重推几十次本身就不该发生。
	NotifyReply(w http.ResponseWriter, ok bool, message string)
}

// PrepayResult 是下单成功的结果。
type PrepayResult struct {
	// PrepayID 是渠道侧的预支付单号，记进订单便于查单对账。
	PrepayID string

	// ClientParams 是交给客户端 SDK 的调起参数。
	// 字段名由各渠道 SDK 约定（微信是 appid / partnerid / prepayid / …），
	// 一个字母都不能改，否则 SDK 调不起来。
	ClientParams map[string]string
}

// NotifyEvent 是各渠道回调**统一之后**的结果。
//
// 刻意不暴露渠道的原始状态词（微信是 trade_state=SUCCESS，支付宝是
// trade_status=TRADE_SUCCESS）—— 那是各家的词汇，api 层不该被迫认识它们，
// 否则每接一家都要往 handler 里加一个 if。渠道自己判断好，
// 只告诉上层「这笔付成了没有」。
type NotifyEvent struct {
	OutTradeNo    string
	Paid          bool   // 是否支付成功
	State         string // 渠道原始状态，仅用于日志与排查
	TransactionID string // 渠道侧订单号，对账凭据
	Attach        string
}

// Service 是渠道注册表。
type Service struct {
	names    []string // 保持注册顺序：第一个已就绪的渠道即「默认渠道」
	channels map[string]Channel
}

// New 按注册顺序装配渠道。
//
// 重名或空名的会被忽略，而不是 panic —— 支付配错不该让整个服务起不来
// （登录、同步、会员查询都跟它无关），/api/health 里能看到缺项就够了。
func New(channels ...Channel) *Service {
	s := &Service{channels: make(map[string]Channel, len(channels))}
	for _, c := range channels {
		if c == nil {
			continue
		}
		name := c.Name()
		if name == "" {
			continue
		}
		if _, dup := s.channels[name]; dup {
			continue
		}
		s.channels[name] = c
		s.names = append(s.names, name)
	}
	return s
}

// Get 按名字取渠道；name 为空时返回第一个**已就绪**的渠道。
//
// 空名字走默认是刻意的：只接了一家（或还没决定接哪家）时，
// 客户端不传 channel 也能下单，不必为了"以后可能多渠道"先改 App。
func (s *Service) Get(name string) Channel {
	if s == nil {
		return nil
	}
	if name != "" {
		return s.channels[name]
	}
	for _, n := range s.names {
		if c := s.channels[n]; c != nil && c.Ready() {
			return c
		}
	}
	return nil
}

// Names 全部已注册渠道（含未就绪的）。
func (s *Service) Names() []string {
	if s == nil {
		return nil
	}
	return append([]string(nil), s.names...)
}

// ReadyNames 已就绪的渠道。客户端据此决定展示哪些支付方式 ——
// 让「能用的」由服务端说了算，而不是 App 里写死一个列表：
// 某个渠道临时出问题（密钥过期、被风控）时，下架它不需要发版。
func (s *Service) ReadyNames() []string {
	if s == nil {
		return nil
	}
	var out []string
	for _, n := range s.names {
		if c := s.channels[n]; c != nil && c.Ready() {
			out = append(out, n)
		}
	}
	return out
}

// Status 给 /api/health 用：每个渠道就绪没有、缺什么。
// 只回布尔与变量名，不含任何密钥内容，所以放公开路径上也安全。
func (s *Service) Status() map[string]interface{} {
	out := map[string]interface{}{}
	if s == nil {
		return out
	}
	for _, n := range s.names {
		c := s.channels[n]
		out[n] = map[string]interface{}{
			"ready": c.Ready(),
			"lack":  c.Missing(),
		}
	}
	return out
}

/* ---------------- 未配置时的通用兜底 ---------------- */

// ErrNotConfigured 是「这个渠道还没配好」。
var ErrNotConfigured = errors.New("支付渠道尚未配置")

// Unconfigured 是渠道未开通时的占位实现。
//
// 为什么要有个正经实现，而不是让渠道为 nil、在调用处到处判空：
// 支付配置缺失是**常态** —— 办商户号、域名备案、应用过审都要时间，
// 而在此之前兑换码那条路是可以先开张的。做成实现之后，漏判空最多是
// 「回了 notReady」，而不是 panic 把整个服务（登录、同步、会员）带崩。
//
// 各渠道用它时只需给个名字和缺失清单：
//
//	payment.Unconfigured{ChannelName: "alipay", Lack: cfg.Missing()}
type Unconfigured struct {
	// ChannelName 是它占位的渠道标识。必须给对 ——
	// 未配置的渠道也要能被 Service.Get 找到，否则客户端问
	// 「支持哪些渠道」时会以为这个渠道不存在，而不是「存在但还没开通」。
	ChannelName string

	// Lack 是还缺哪些环境变量。直接传渠道自己的 Config.Missing() 即可，
	// 只列变量名不含内容，所以能安全地出现在 /api/health 里。
	Lack []string
}

func (u Unconfigured) Name() string { return u.ChannelName }

func (Unconfigured) Ready() bool { return false }

func (u Unconfigured) Missing() []string {
	if len(u.Lack) > 0 {
		return u.Lack
	}
	return []string{"该支付渠道尚未配置"}
}

func (Unconfigured) Prepay(context.Context, *store.Order) (*PrepayResult, error) {
	return nil, ErrNotConfigured
}

func (Unconfigured) ParseNotify(http.Header, []byte) (*NotifyEvent, error) {
	return nil, ErrNotConfigured
}

// NotifyReply 未配置时只能应答失败。
//
// 接口要求实现它，是因为渠道可能在**配好之前**就收到回调 ——
// 比如密钥被人从环境变量里删掉、或者容器滚动到一半。那种时候唯一正确的
// 做法是如实回失败，让对方按自己的节奏重推。绝不能假装成功：
// 一旦回了成功，对方就再也不推了，那笔钱永远发不了货。
func (Unconfigured) NotifyReply(w http.ResponseWriter, _ bool, message string) {
	if message == "" {
		message = ErrNotConfigured.Error()
	}
	http.Error(w, message, http.StatusInternalServerError)
}

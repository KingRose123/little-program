package api

import (
	"log"
	"net/http"
)

/*
会员与支付接口。

路径说明（这一条关系到 App 能不能不改就跑）：
  App 端 cloud.js 里查询订单打的是 GET /api/membership/vpay/order ——
  「vpay」是旧的小程序虚拟支付留下的名字，而 App 支付复用了同一个查询接口。
  现在虚拟支付已经整体废弃，但**这个路径必须保留**，否则要改 App。
  所以这里两个路径都注册：新的 /api/membership/order 是我们想用的语义，
  旧的 /api/membership/vpay/order 是兼容 App 现行版本的别名。
*/

func (s *Server) handleMembership(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	st, err := s.store.MembershipStatus(r.Context(), uid)
	if err != nil {
		FailBiz(w, err, "读取会员状态失败")
		return
	}
	OK(w, st)
}

func (s *Server) handleRedeem(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	body, err := decodeJSON[struct {
		Code string `json:"code"`
	}](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	code := normalizeCode(body.Code)
	if code == "" {
		Fail(w, http.StatusBadRequest, "请输入兑换码")
		return
	}

	res, err := s.store.Redeem(r.Context(), code, uid)
	if err != nil {
		FailBiz(w, err, "兑换失败，请稍后重试")
		return
	}

	log.Printf("[membership] 兑换成功 uid=%s tier=%s months=%d", uid, res.Membership.Tier, res.Months)
	OK(w, res)
}

/* ---------------- 支付下单 ---------------- */

// prepay 是下单流程。forced 非空时锁定到指定渠道（旧路径的兼容用法）；
// 为空则取请求体里的 channel，没传就用第一个已就绪的渠道。
//
// 允许"不传渠道"是刻意的：只接了一家（或还没决定接哪家）时，
// 客户端不该为了「将来可能多渠道」先改一遍 App。
//
// 尚未配置支付时返回 { ok:false, notReady:true }，客户端据此引导用户改走
// 兑换码 —— 这条降级路径是刻意留的：支付要办商户号、备案域名、还要过审，
// 而兑换码今天就能开始收钱。
func (s *Server) prepay(w http.ResponseWriter, r *http.Request, forced string) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	body, err := decodeJSON[struct {
		Plan    string `json:"plan"`
		Channel string `json:"channel"`
	}](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	plan := trimSpace(body.Plan)
	if plan == "" {
		Fail(w, http.StatusBadRequest, "请选择开通方案")
		return
	}

	want := forced
	if want == "" {
		want = trimSpace(body.Channel)
	}

	ch := s.pay.Get(want)

	// 两种失败分开报，因为处理方式完全不同：
	//   指定了一个不存在的渠道 → 客户端传错了（或被下架），要它换一个；
	//   渠道存在但没配好       → 是运维的事，客户端该引导用户走兑换码。
	if want != "" && ch == nil {
		Fail(w, http.StatusBadRequest, "不支持的支付方式："+want)
		return
	}
	if ch == nil || !ch.Ready() {
		lack := []string{}
		if ch != nil {
			lack = ch.Missing()
		}
		// 明确告诉运维缺了什么（变量名），但不暴露任何密钥内容
		log.Printf("[pay] 支付渠道尚未就绪 channel=%q 缺=%v", want, lack)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok":       false,
			"notReady": true,
			"msg":      "在线支付尚未开通，可以先用兑换码开通",
			"lack":     lack,
			"channels": s.pay.ReadyNames(),
		})
		return
	}

	channel := ch.Name()
	order, err := s.store.CreateOrder(r.Context(), plan, uid, channel)
	if err != nil {
		FailBiz(w, err, "下单失败，请稍后重试")
		return
	}

	params, err := ch.Prepay(r.Context(), order)
	if err != nil {
		log.Printf("[pay] 下单失败 channel=%s order=%s: %v", channel, order.OrderID, err)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"ok":  false,
			"msg": userMsgOf(err, "下单失败，请稍后重试"),
		})
		return
	}

	if err := s.store.SetPrepayID(r.Context(), order.OrderID, channel, params.PrepayID); err != nil {
		// 只是少记一个排查用的字段，不影响用户支付
		log.Printf("[pay] 记录 prepay_id 失败 order=%s: %v", order.OrderID, err)
	}

	// 字段名是各渠道 SDK 约定的那一套（微信是 appid / partnerid / prepayid / …），
	// 一个字母都不能改，否则 SDK 调不起来。所以把 ClientParams 平铺进 data，
	// 只额外补一个 channel 供客户端与日志对照 ——
	// App 读它不认识的字段是安全的（JSON 多一个键而已）。
	out := make(map[string]interface{}, len(params.ClientParams)+1)
	for k, v := range params.ClientParams {
		out[k] = v
	}
	out["channel"] = channel
	OK(w, out)
}

// handlePayPrepay 渠道由请求体决定：POST /api/membership/pay/prepay {plan, channel}
func (s *Server) handlePayPrepay(w http.ResponseWriter, r *http.Request) {
	s.prepay(w, r, "")
}

// handleAppayPrepay 是旧路径，锁定微信渠道。
//
// 保留它是因为**现网 App 把这个路径写死了**，删掉等于让所有已装机的用户
// 点支付就报 404。等 App 发版切到 /pay/prepay 之后才能删 ——
// 这与 /vpay/order 那个别名是同一个道理。
func (s *Server) handleAppayPrepay(w http.ResponseWriter, r *http.Request) {
	s.prepay(w, r, "wxpay")
}

/* ---------------- 支付回调 ---------------- */

// notify 是支付回调的统一处理。forced 非空时锁定渠道（旧路径用）。
//
// 这个接口**不带用户身份**（是渠道服务器打过来的），所以安全性完全靠验签：
// 渠道实现必须先验证签名，验不过就直接返回错误，绝不能往下走。
func (s *Server) notify(w http.ResponseWriter, r *http.Request, forced string) {
	name := forced
	if name == "" {
		name = trimSpace(r.PathValue("channel"))
	}

	ch := s.pay.Get(name)
	if ch == nil {
		// 路径里的渠道名写错了，或渠道已被下架。
		log.Printf("[pay] 回调的渠道不存在: %q", name)
		http.Error(w, "unknown channel", http.StatusNotFound)
		return
	}

	// 必须读**未解析的原始报文**：验签算的是原始字节，
	// JSON 解析再序列化会改变键顺序与空白，签名立刻对不上。
	raw, err := readAllLimited(r, 1024*1024)
	if err != nil {
		ch.NotifyReply(w, false, "read body failed")
		return
	}

	event, err := ch.ParseNotify(r.Header, raw)
	if err != nil {
		log.Printf("[pay] 回调校验失败 channel=%s: %v", name, err)
		ch.NotifyReply(w, false, err.Error())
		return
	}

	// 只有支付成功才发货；其余状态（未支付 / 已关闭 / 退款）先只留痕。
	// 这些状态同样是有效信息 —— 用户付款失败时会来问，日志里得能查到。
	if !event.Paid {
		log.Printf("[pay] 回调状态 %s 单号 %s channel=%s", event.State, event.OutTradeNo, name)
		ch.NotifyReply(w, true, "OK")
		return
	}

	res, err := s.store.MarkPaidAndGrant(r.Context(), event.OutTradeNo, name, event.TransactionID)
	if err != nil {
		// 发不了货就回失败，让渠道按自己的节奏重推 ——
		// 例如「回调比落库先到」这种时序问题，重推一次就好了。
		log.Printf("[pay] 发货失败 channel=%s 单号=%s: %v", name, event.OutTradeNo, err)
		ch.NotifyReply(w, false, "grant failed")
		return
	}

	if res.Repeated {
		log.Printf("[pay] 重复回调，已忽略 channel=%s 单号=%s", name, event.OutTradeNo)
	} else {
		log.Printf("[pay] 发货成功 channel=%s 单号=%s", name, event.OutTradeNo)
	}
	ch.NotifyReply(w, true, "OK")
}

// handlePayNotify 按路径里的渠道分发：POST /api/membership/pay/notify/{channel}
func (s *Server) handlePayNotify(w http.ResponseWriter, r *http.Request) {
	s.notify(w, r, "")
}

// handleAppayNotify 是旧路径，锁定微信渠道（现网 App 写死了它）。
func (s *Server) handleAppayNotify(w http.ResponseWriter, r *http.Request) {
	s.notify(w, r, "wxpay")
}

/* ---------------- 可选渠道 ---------------- */

// handlePayChannels 告诉客户端现在能用哪些支付方式。
//
// 由服务端说了算，而不是 App 里写死一份列表：某个渠道临时出问题
// （密钥过期、通道维护、被风控）时，下架它不需要发版。
func (s *Server) handlePayChannels(w http.ResponseWriter, r *http.Request) {
	OK(w, map[string]interface{}{
		"channels": s.pay.ReadyNames(),
		// 一个可用的都没有时，客户端直接引导兑换码，不必先试一次下单
		"fallback": "redeem",
		// 兑换码那条路要告诉用户「去哪买」。文案由服务端下发：
		// 卖码渠道会变，写死在 App 里意味着每改一句都要发版等审核。
		"guide": s.cfg.RedeemGuide,
	})
}

// handleOrderStatus 查订单（支付后轮询发货结果）。
func (s *Server) handleOrderStatus(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	orderID := trimSpace(r.URL.Query().Get("outTradeNo"))
	if orderID == "" {
		Fail(w, http.StatusBadRequest, "缺少订单号")
		return
	}

	res, err := s.store.OrderStatus(r.Context(), orderID, uid)
	if err != nil {
		FailBiz(w, err, "查询订单失败，请稍后重试")
		return
	}
	OK(w, res)
}

// 说明：回调的应答格式（曾经在这里的 replyNotify）已经移进各渠道的
// NotifyReply —— 微信要 JSON 的 code/message，支付宝要纯文本 "success"，
// 这属于渠道差异，不该由 api 层认识。

package payment

import (
	"context"
	"net/http"
	"testing"

	"xiji/api/internal/store"
)

// fake 是一个可控的渠道：名字与就绪状态都由测试指定。
type fake struct {
	name  string
	ready bool
	lack  []string
}

func (f *fake) Name() string      { return f.name }
func (f *fake) Ready() bool       { return f.ready }
func (f *fake) Missing() []string { return f.lack }

func (f *fake) Prepay(context.Context, *store.Order) (*PrepayResult, error) {
	return &PrepayResult{PrepayID: "P1", ClientParams: map[string]string{"channel": f.name}}, nil
}

func (f *fake) ParseNotify(http.Header, []byte) (*NotifyEvent, error) {
	return &NotifyEvent{OutTradeNo: "M1", Paid: true}, nil
}

func (f *fake) NotifyReply(http.ResponseWriter, bool, string) {}

// nil、空名、重名都要被安静地吃掉，而不是 panic 或产生两张同名表项 ——
// 支付配错不该让服务起不来，health 里能看到缺项就够了。
func TestNewSkipsNilEmptyAndDuplicate(t *testing.T) {
	s := New(
		nil,
		&fake{name: ""},
		&fake{name: "wxpay", ready: true},
		&fake{name: "wxpay", ready: false}, // 重名：保留先注册的那个
		&fake{name: "alipay"},
	)

	names := s.Names()
	if len(names) != 2 || names[0] != "wxpay" || names[1] != "alipay" {
		t.Fatalf("应只保留 wxpay 与 alipay，实际 %v", names)
	}
	// 保留下来的必须是**先注册**那个（ready=true），不是后覆盖的
	if c := s.Get("wxpay"); c == nil || !c.Ready() {
		t.Fatal("重名时应保留先注册的渠道")
	}
}

// 不传渠道 → 落到第一个**已就绪**的，而不是第一个注册的。
//
// 这条是「默认渠道」的核心行为：注册在前的那家没配好时，
// 用户不选渠道也该落到能用的一家上，而不是直接回 notReady。
func TestGetEmptyNamePicksFirstReady(t *testing.T) {
	s := New(
		&fake{name: "wxpay", ready: false},
		&fake{name: "alipay", ready: true},
		&fake{name: "unionpay", ready: true},
	)
	if c := s.Get(""); c == nil || c.Name() != "alipay" {
		t.Fatalf("应落到第一个已就绪的 alipay，实际 %v", c)
	}
}

// 一家都没就绪时返回 nil —— api 层据此回 notReady，
// 而不是拿着一个不可用的渠道去下单。
func TestGetEmptyNameWhenNoneReady(t *testing.T) {
	s := New(&fake{name: "wxpay", ready: false})
	if c := s.Get(""); c != nil {
		t.Fatalf("没有可用渠道时应返回 nil，实际 %v", c)
	}
}

// 显式指定未注册的渠道要返回 nil（api 层回 400），不能悄悄回落到默认渠道 ——
// 那会让「客户端传错了渠道」表现成「用另一个渠道扣了钱」。
func TestGetUnknownReturnsNil(t *testing.T) {
	s := New(&fake{name: "wxpay", ready: true})
	if c := s.Get("nope"); c != nil {
		t.Fatalf("未注册的渠道应返回 nil，实际 %v", c)
	}
}

func TestReadyNames(t *testing.T) {
	s := New(
		&fake{name: "wxpay", ready: true},
		&fake{name: "alipay", ready: false},
	)
	got := s.ReadyNames()
	if len(got) != 1 || got[0] != "wxpay" {
		t.Fatalf("只该列出已就绪的，实际 %v", got)
	}
}

func TestStatusShape(t *testing.T) {
	s := New(&fake{name: "alipay", ready: false, lack: []string{"ALIPAY_APPID"}})
	st := s.Status()
	row, ok := st["alipay"].(map[string]interface{})
	if !ok {
		t.Fatalf("Status 应含 alipay 一项，实际 %v", st)
	}
	if row["ready"] != false {
		t.Fatalf("ready 应为 false，实际 %v", row["ready"])
	}
}

// 占位实现：名字必须保留（否则客户端会以为这个渠道**不存在**，
// 而不是「存在但还没开通」），但 Ready 恒为 false。
func TestUnconfigured(t *testing.T) {
	var c Channel = Unconfigured{ChannelName: "alipay", Lack: []string{"ALIPAY_APPID"}}

	if c.Name() != "alipay" {
		t.Fatalf("名字应保留，实际 %q", c.Name())
	}
	if c.Ready() {
		t.Fatal("未配置的渠道不该 ready")
	}
	if lack := c.Missing(); len(lack) != 1 || lack[0] != "ALIPAY_APPID" {
		t.Fatalf("应报出缺失的变量名，实际 %v", lack)
	}

	// 没给 Lack 时要有兜底文案：返回空列表会让 health 里看起来
	// 「什么都不缺」，比不显示更迷惑
	if lack := (Unconfigured{ChannelName: "x"}).Missing(); len(lack) == 0 {
		t.Fatal("未给 Lack 时应有兜底提示")
	}

	if _, err := c.Prepay(context.Background(), &store.Order{}); err != ErrNotConfigured {
		t.Fatalf("未配置就下单应返回 ErrNotConfigured，实际 %v", err)
	}
}

// Deps 忘了给 Pay 时 NewServer 会传 nil 进来，所以 nil Service
// 必须处处安全：Get 返回 nil、状态为空，而不是 panic。
func TestNilServiceIsSafe(t *testing.T) {
	var s *Service
	if s.Get("") != nil || s.Names() != nil || s.ReadyNames() != nil {
		t.Fatal("nil Service 应返回零值而不是 panic")
	}
	if len(s.Status()) != 0 {
		t.Fatal("nil Service 的 Status 应为空 map")
	}
}

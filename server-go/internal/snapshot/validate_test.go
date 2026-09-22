package snapshot

import (
	"strings"
	"testing"
)

func long(n int) string {
	return strings.Repeat("a", n)
}

// 一份 App 真实会推上来的快照：数值都是字符串（表单原样上传），
// 含负成本、未知字段。这类请求必须放行 —— 误伤正常客户端比漏放更糟。
func TestValidateAcceptsRealSnapshot(t *testing.T) {
	raw := []byte(`{
	  "settings": {
	    "accounts": [{"id": "a1", "name": "A股主账户", "broker": "某券商"}],
	    "lifeExpenses": [{"id": "e1", "name": "健身房", "amount": "500"}],
	    "displayCurrency": "CNY"
	  },
	  "profile": {"nickName": "收息佬用户", "avatar": "👤", "phone": ""},
	  "holdings": [
	    {"id": "h1", "code": "600398", "market": "A", "name": "海澜之家",
	     "shares": "1500", "cost": "6.0100", "dps": "0.41", "price": "5.79",
	     "taxRate": 0, "buyDate": "2024-01-01", "received": "0", "fee": "5",
	     "costNative": "6.01", "accountId": "a1", "brandNewField": {"deep": [1, 2, 3]}},
	    {"id": "h2", "code": "00177", "market": "HK", "name": "江苏宁沪高速公路",
	     "shares": 4000, "cost": -3.5, "dps": "0.464", "price": 8.9}
	  ],
	  "records": {
	    "h1": {
	      "trade": [{"id": "tr1", "date": "2024-01-01", "type": "买入", "shares": "1500", "price": "6.07", "fee": "5"}],
	      "dividend": []
	    },
	    "h2": {
	      "dividend": [{"id": "dv1", "date": "2025-07-10", "shares": "4000", "dps": "0.53", "amount": "2120", "tax": "0"}]
	    }
	  },
	  "futureTopLevelField": "客户端将来加的字段"
	}`)

	if err := Validate(raw, DefaultLimits); err != nil {
		t.Fatalf("正常快照被判为非法: %v", err)
	}
}

// 缺失的顶层字段（新用户一条持仓都没有）也要放行，
// 否则「注册完第一次同步」会直接失败。
func TestValidateAcceptsEmptySnapshot(t *testing.T) {
	for _, raw := range []string{`{}`, `{"holdings":[],"records":{}}`, `{"holdings":null}`} {
		if err := Validate([]byte(raw), DefaultLimits); err != nil {
			t.Errorf("%s 应当通过: %v", raw, err)
		}
	}
}

func TestValidateRejectsMalformed(t *testing.T) {
	cases := []struct{ name, raw string }{
		{"空字节", ``},
		{"不是 JSON", `{`},
		{"顶层是数组", `[]`},

		{"holdings 不是数组", `{"holdings": {}}`},
		{"holdings 元素不是对象", `{"holdings": [1]}`},
		{"holdings 缺 id", `{"holdings": [{"code": "600519"}]}`},
		{"holdings id 为空白", `{"holdings": [{"id": "   "}]}`},
		{"holdings id 超长", `{"holdings": [{"id": "` + long(65) + `"}]}`},
		{"code 超长", `{"holdings": [{"id": "h1", "code": "` + long(25) + `"}]}`},
		{"name 超长", `{"holdings": [{"id": "h1", "name": "` + long(65) + `"}]}`},
		{"文本字段写成数组", `{"holdings": [{"id": "h1", "name": []}]}`},

		{"shares 不是数字", `{"holdings": [{"id": "h1", "shares": "abc"}]}`},
		{"shares 为负", `{"holdings": [{"id": "h1", "shares": -1}]}`},
		{"shares 超上限", `{"holdings": [{"id": "h1", "shares": 1e13}]}`},
		{"taxRate 超 100", `{"holdings": [{"id": "h1", "taxRate": 101}]}`},
		{"taxRate 为负", `{"holdings": [{"id": "h1", "taxRate": -1}]}`},
		{"fee 为负", `{"holdings": [{"id": "h1", "fee": "-1"}]}`},
		{"shares 是 NaN", `{"holdings": [{"id": "h1", "shares": "NaN"}]}`},
		{"dps 是 Infinity", `{"holdings": [{"id": "h1", "dps": "Inf"}]}`},
		{"数值写成对象", `{"holdings": [{"id": "h1", "shares": {}}]}`},

		{"records 不是对象", `{"records": []}`},
		{"records 桶不是对象", `{"records": {"h1": 1}}`},
		{"trade 不是数组", `{"records": {"h1": {"trade": {}}}}`},
		{"dividend 不是数组", `{"records": {"h1": {"dividend": "x"}}}`},
		{"记录不是对象", `{"records": {"h1": {"trade": [1]}}}`},
		{"记录缺 id", `{"records": {"h1": {"trade": [{"shares": 1}]}}}`},
		{"记录 note 超长", `{"records": {"h1": {"trade": [{"id": "t1", "note": "` + long(5001) + `"}]}}}`},

		{"settings 不是对象", `{"settings": []}`},
		{"accounts 不是数组", `{"settings": {"accounts": {}}}`},
		{"lifeExpenses 不是数组", `{"settings": {"lifeExpenses": "x"}}`},

		{"profile 不是对象", `{"profile": []}`},
		{"profile.nickName 超长", `{"profile": {"nickName": "` + long(65) + `"}}`},
		{"profile.phone 超长", `{"profile": {"phone": "` + long(33) + `"}}`},
	}

	for _, c := range cases {
		err := Validate([]byte(c.raw), DefaultLimits)
		if err == nil {
			t.Errorf("%s：应当被拒绝，却通过了", c.name)
			continue
		}
		// 错误必须是 *Problem，且带有定位信息 —— 用户报障时要能说清是哪个字段
		p, ok := err.(*Problem)
		if !ok {
			t.Errorf("%s：错误类型应为 *Problem，实际 %T", c.name, err)
			continue
		}
		if p.Path == "" || p.Msg == "" {
			t.Errorf("%s：Problem 应带 Path 与 Msg，实际 %+v", c.name, p)
		}
	}
}

// 负成本是真实存在的持仓状态（分红收回本金），必须放行。
func TestValidateAllowsNegativeCost(t *testing.T) {
	raw := []byte(`{"holdings": [{"id": "h1", "cost": "-3.5", "costNative": "-3.2"}]}`)
	if err := Validate(raw, DefaultLimits); err != nil {
		t.Fatalf("负成本应当通过: %v", err)
	}
}

// 留空的数值（空串 / null）等于「未填」，按 0 处理即可，不该判为非法。
func TestValidateAllowsBlankNumbers(t *testing.T) {
	for _, raw := range []string{
		`{"holdings": [{"id": "h1", "shares": ""}]}`,
		`{"holdings": [{"id": "h1", "shares": null}]}`,
		`{"holdings": [{"id": "h1", "shares": "  "}]}`,
	} {
		if err := Validate([]byte(raw), DefaultLimits); err != nil {
			t.Errorf("%s 应当通过: %v", raw, err)
		}
	}
}

func TestValidateLimits(t *testing.T) {
	lim := Limits{Holdings: 2, RecordsTotal: 3, RecordsPer: 2, Accounts: 1, Expenses: 1}

	pass := []string{
		`{"holdings": [{"id": "a"}, {"id": "b"}]}`,
		`{"settings": {"accounts": [{"id": "a1"}]}}`,
		`{"records": {"h1": {"trade": [{"id": "t1"}, {"id": "t2"}]}}}`,
	}
	for _, raw := range pass {
		if err := Validate([]byte(raw), lim); err != nil {
			t.Errorf("等于上限应当通过 %s: %v", raw, err)
		}
	}

	fail := []string{
		`{"holdings": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}`,
		`{"settings": {"accounts": [{"id": "a1"}, {"id": "a2"}]}}`,
		`{"settings": {"lifeExpenses": [{"id": "e1"}, {"id": "e2"}]}}`,
		`{"records": {"h1": {"trade": [{"id": "t1"}, {"id": "t2"}, {"id": "t3"}]}}}`,
		`{"records": {"h1": {"trade": [{"id": "t1"}, {"id": "t2"}]}, "h2": {"trade": [{"id": "t3"}, {"id": "t4"}]}}}`,
	}
	for _, raw := range fail {
		if err := Validate([]byte(raw), lim); err == nil {
			t.Errorf("超出上限应当被拒绝: %s", raw)
		}
	}
}

// 错误文案会直接回给客户端，所以要能看懂，而不是暴露内部字段名。
func TestProblemMessageIsReadable(t *testing.T) {
	err := Validate([]byte(`{"holdings": [{"id": "h1", "shares": -5}]}`), DefaultLimits)
	if err == nil {
		t.Fatal("应当被拒绝")
	}
	msg := err.Error()
	if !strings.Contains(msg, "holdings[0].shares") {
		t.Errorf("文案应包含字段定位，实际: %s", msg)
	}
	if !strings.Contains(msg, "不能为负数") {
		t.Errorf("文案应说明原因，实际: %s", msg)
	}
}

// 长度按**字符**计，不是字节。
//
// 这条曾经是错的：checkText 用 len()（字节）判断，而中文一个字 3 字节 ——
// 客户端按码点放行，服务端却按字节卡，一超就**整份快照被拒**（400），
// 用户表现为「数据一直同步不上去」，而客户端只在控制台留了一行 warn。
func TestTextLimitCountsRunesNotBytes(t *testing.T) {
	// 1668 个中文字 = 5004 字节。按字节算会误判超长（5004 > 5000），
	// 按字符算才正确（1668 < 5000）—— 这正是当初那个 bug 的形态。
	note := strings.Repeat("好", 1668)
	raw := []byte(`{"records":{"h1":{"trade":[{"id":"t1","note":"` + note + `"}]}}}`)
	if err := Validate(raw, DefaultLimits); err != nil {
		t.Fatalf("1668 个中文字的备注被误判超长: %v", err)
	}

	// 真的超过字符上限才拦下
	tooLong := strings.Repeat("好", 5001)
	raw = []byte(`{"records":{"h1":{"trade":[{"id":"t1","note":"` + tooLong + `"}]}}}`)
	if err := Validate(raw, DefaultLimits); err == nil {
		t.Fatal("5001 个中文字的备注应当被判超长")
	}
}

// 清仓心得（archiveReason）也要校验。
//
// 它以前不在 holdingTexts 里 —— 不认识的新字段会被放过（那是为了客户端
// 能自由加字段），但「已知字段不管」等于留了一条绕过客户端、往库里
// 塞任意长度文本的路。
func TestArchiveReasonIsValidated(t *testing.T) {
	// 正好等于客户端 api.js 的 MEMO_MAX：心得是要能写长文的，必须放行
	ok := strings.Repeat("好", 5000)
	raw := []byte(`{"holdings":[{"id":"h1","archiveReason":"` + ok + `"}]}`)
	if err := Validate(raw, DefaultLimits); err != nil {
		t.Fatalf("5000 字的心得被误判超长: %v", err)
	}

	tooLong := strings.Repeat("好", 5001)
	raw = []byte(`{"holdings":[{"id":"h1","archiveReason":"` + tooLong + `"}]}`)
	if err := Validate(raw, DefaultLimits); err == nil {
		t.Fatal("超长的心得应当被拦下")
	}
}

// 中文名字不能因为「按字节算」而被误判超长。
func TestChineseNameFitsLimit(t *testing.T) {
	// 20 个中文字 = 60 字节，远小于 maxName(64 字符)
	name := strings.Repeat("沪", 20)
	raw := []byte(`{"holdings":[{"id":"h1","name":"` + name + `"}]}`)
	if err := Validate(raw, DefaultLimits); err != nil {
		t.Fatalf("20 个中文字的标的名称被误判超长: %v", err)
	}
}

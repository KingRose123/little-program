package quote

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

/*
搜索与实时行情。

两处业务规则值得单独说明：

 1. **游标过滤（搜索）**：搜索结果里会混进指数（上证指数）和板块（白酒板块），
    这些不能当持仓录入 —— 它们没有"每股成本"也没有分红。
    旧版按 securityTypeName 里是否含「指数」「板块」来丢，这里保持一致。

 2. **场内基金的归并**：东财把场内基金（ETF/LOF）归在 A 股里
    （market 号是 0 或 1），但它们的交易方式与 A 股不同，
    客户端要用不同的报价口径。所以搜索时按 typeName 是否含「基金」
    把它们单独标成 ETF。
*/

// rawQuote 是上游返回的字段集合。
// 用 map 而不是结构体：上游对停牌/退市的标的会返回 "-" 这种字符串
// （而不是数字或 null），用结构体接会直接解析失败。
type rawQuote = map[string]interface{}

/* ---------------- 搜索 ---------------- */

type searchResp struct {
	Result []searchItem `json:"result"`
}

type searchItem struct {
	Code             string      `json:"code"`
	ShortName        string      `json:"shortName"`
	Market           interface{} `json:"market"` // 数字，但用 interface{} 接更稳
	SecurityTypeName string      `json:"securityTypeName"`
}

func (s *Service) directSearch(ctx context.Context, kw string) ([]Stock, error) {
	u := hostSearch + "/codetable/search/web?client=web&clientType=webSuggest&clientVersion=lastest" +
		"&pageIndex=1&pageSize=20&keyword=" + url.QueryEscape(kw)

	var res searchResp
	if err := s.getJSON(ctx, u, &res); err != nil {
		return nil, err
	}

	out := make([]Stock, 0, len(res.Result))
	for _, item := range res.Result {
		st := toStock(item)
		if st == nil {
			continue
		}
		out = append(out, *st)
	}
	return out, nil
}

// toStock 把一条搜索结果转成标的。不可交易的（指数、板块）返回 nil。
func toStock(item searchItem) *Stock {
	marketNo := fmt.Sprintf("%v", item.Market)
	market, ok := marketByNo[marketNo]
	if !ok {
		return nil
	}

	typeName := strings.TrimSpace(item.SecurityTypeName)
	// 指数与板块没有持仓的概念，不能录进来
	if strings.Contains(typeName, "指数") || strings.Contains(typeName, "板块") {
		return nil
	}

	code := strings.TrimSpace(item.Code)
	if code == "" {
		return nil
	}

	// 场内基金归到 ETF：东财把它们放在 A 股市场号下
	isFund := strings.Contains(typeName, "基金")
	key := market
	if market == "A" && isFund {
		key = "ETF"
	}

	secid := ""
	if market != "FUND" {
		// 直接用上游给的市场号拼，不自己猜沪深前缀 —— 它比我们准
		secid = marketNo + "." + code
	}

	return &Stock{
		Code:     code,
		Name:     strings.TrimSpace(item.ShortName),
		Market:   key,
		SecID:    secid,
		TypeName: typeName,
	}
}

/* ---------------- 实时行情 ---------------- */

type quoteResp struct {
	Data rawQuote `json:"data"`
}

func (s *Service) quoteBySecid(ctx context.Context, secid string) (*Quote, error) {
	u := hostQuote + "/api/qt/stock/get?secid=" + url.QueryEscape(secid) +
		"&fields=" + quoteFields + "&fltt=2&invt=2"

	var res quoteResp
	if err := s.getJSON(ctx, u, &res); err != nil {
		return nil, err
	}
	return toQuote(res.Data), nil
}

// toQuote 做字段映射。
//
// 返回 nil 的条件是「没有价格」：停牌、退市、代码拼错的标的
// 上游只回一堆 "-"，这种结果对用户没有任何意义，
// 与其给一张全是 0 的卡片，不如让客户端按「取不到」处理。
func toQuote(m rawQuote) *Quote {
	if len(m) == 0 {
		return nil
	}

	price, ok := priceField(m, "f43")
	if !ok {
		return nil
	}

	digits := int(numField(m, "f59"))
	if digits == 0 {
		digits = 2
	}

	return &Quote{
		Code:         strField(m, "f57"),
		Name:         strField(m, "f58"),
		Price:        price,
		PrevClose:    numField(m, "f60"),
		Change:       numField(m, "f169"),
		ChangeRate:   numField(m, "f170"),
		Open:         numField(m, "f46"),
		High:         numField(m, "f44"),
		Low:          numField(m, "f45"),
		Amplitude:    numField(m, "f171"),
		TurnoverRate: numField(m, "f168"),
		Volume:       numField(m, "f47"),
		Amount:       numField(m, "f48"),
		PE:           numField(m, "f162"),
		PB:           numField(m, "f167"),
		MarketCap:    numField(m, "f116"),
		FloatCap:     numField(m, "f117"),
		Digits:       digits,
	}
}

/* ---------------- 取值容错 ---------------- */

// priceField 单独处理价格：它是「这个标的有没有数据」的判据。
// 缺失、null、"-"、空串都算没有数据。
func priceField(m rawQuote, key string) (float64, bool) {
	v, ok := m[key]
	if !ok || v == nil {
		return 0, false
	}

	switch t := v.(type) {
	case float64:
		return t, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" || s == "-" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return 0, false
		}
		return f, true
	default:
		return 0, false
	}
}

// numField 取数值字段，取不到就是 0。
// 上游对「没有这个指标」的标的（比如港股很多没有 PE）
// 会给 "-"，这时 0 比报错更合适 —— 界面显示「--」而不是整页失败。
func numField(m rawQuote, key string) float64 {
	f, ok := priceField(m, key)
	if !ok {
		return 0
	}
	return f
}

func strField(m rawQuote, key string) string {
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func trimSpace(s string) string { return strings.TrimSpace(s) }

func joinPipe(items []string) string { return strings.Join(items, "|") }

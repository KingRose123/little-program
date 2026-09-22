package quote

import (
	"context"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

/*
分红档案与场外基金。

**分红档案是最容易出错的一块**，几个关键点：

 1. **美股返回 null**。东财没有美股的分红档案接口（美股按季度分红、
    数据源也不一样），旧版就是直接返回 null。客户端据此把分红一行隐藏。
    「有档案但没有记录」的情况则返回 {source, list: []} ——
    空数组和 null 在客户端是两种不同的处理，不能混。

 2. **排序字段按市场不同**：A 股按 REPORT_DATE（报告期）倒序，
    港股按 NOTICE_DATE（公告日）倒序。**不能按除息日排** ——
    已公告但未实施的方案除息日是空的，按它排序会把最新的方案排到最后，
    再被 pageSize 一截就整个看不见了。

 3. **港股的每股派息要从公告原文里抠**。公告写法五花八门，有的写
    「派港币 0.5 元」，有的写「相当于港币 0.5 元」，还有的只给一个数字。
    所以按「相当于/折合/相等于 → 派港元 → 裸数字」三段优先级匹配。

 4. **A 股的 planText 是本地拼的**（「每 10 股派 X 元（含税）」），
    港股则直接用公告原文 PLAN_EXPLAIN。
*/

// 单只标的的档案条数上限。默认 10 已经覆盖大部分场景
// （一年最多四次分红，10 条够看两年半）。
const defaultDividendSize = 10

type dataResp struct {
	Result struct {
		Data []map[string]interface{} `json:"data"`
	} `json:"result"`
}

// FetchDividend 取分红档案。size <= 0 时用默认值。
func (s *Service) FetchDividend(ctx context.Context, stock Stock, size int) (*Dividend, error) {
	code := strings.ToUpper(trimSpace(stock.Code))
	if code == "" {
		return nil, nil
	}
	if size <= 0 {
		size = defaultDividendSize
	}

	market := trimSpace(stock.Market)
	// 只有 A 股 / 场内基金 / 港股有档案，其余（美股）返回 null。
	// 这里是「null」而不是空对象，客户端据此整块不渲染。
	if market != "A" && market != "ETF" && market != "HK" {
		return nil, nil
	}

	key := "div:" + market + ":" + code + ":" + strconv.Itoa(size)

	v, err := s.cache.do(key, ttlDividend, func() (interface{}, error) {
		var rows []DividendRow
		var source string

		if market == "HK" {
			var e error
			rows, e = s.dividendHK(ctx, code, size)
			if e != nil {
				return nil, e
			}
			source = "东方财富 · 港股分红"
		} else {
			var e error
			rows, e = s.dividendA(ctx, code, size)
			if e != nil {
				return nil, e
			}
			source = "东方财富 · 分红送配"
		}

		// 有档案但没记录时返回空列表（而不是 nil）：
		// nil 会被缓存层当成「没取到」而跳过写入，用户就会一直重复请求。
		if rows == nil {
			rows = []DividendRow{}
		}
		return &Dividend{Source: source, List: rows}, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.(*Dividend), nil
}

/* ---------------- A 股 / 场内基金 ---------------- */

func (s *Service) dividendA(ctx context.Context, code string, size int) ([]DividendRow, error) {
	filter := `(SECURITY_CODE="` + code + `")`
	u := hostData + "/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL" +
		"&filter=" + url.QueryEscape(filter) +
		"&pageNumber=1&pageSize=" + strconv.Itoa(size) +
		"&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB"

	var res dataResp
	if err := s.getJSON(ctx, u, &res); err != nil {
		return nil, err
	}

	out := make([]DividendRow, 0, len(res.Result.Data))
	for _, r := range res.Result.Data {
		// 每 10 股税前派现（元）。没有这个字段或为 0 的，
		// 是送股/转增这类「不派现金」的方案，对收息没有意义，跳过。
		per10 := numField(r, "PRETAX_BONUS_RMB")
		if per10 <= 0 {
			continue
		}

		out = append(out, DividendRow{
			Period:     periodOf(strField(r, "REPORT_DATE")),
			PlanText:   "每 10 股派 " + trimNum(per10) + " 元（含税）",
			Dps:        round6(per10 / 10),
			Unit:       "股",
			ExDate:     dateOf(strField(r, "EX_DIVIDEND_DATE")),
			RecordDate: dateOf(strField(r, "EQUITY_RECORD_DATE")),
			// 派息日是除息日之后若干天，东财这张表里没有这个字段
			PayDate:  "",
			Progress: strField(r, "ASSIGN_PROGRESS"),
		})
	}
	return out, nil
}

/* ---------------- 港股 ---------------- */

// 港股每股派息的三段正则，优先级从高到低。
// 先看有没有「相当于/折合」这种换算口径（那是人民币宣派、港币派发的写法），
// 再看直接的「派港币 X」，最后才退化成「取公告里的第一个数字」。
var (
	reHkEquivalent = regexp.MustCompile(`(?:相当于|折合|相等于)\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)`)
	reHkDeclared   = regexp.MustCompile(`派\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)`)
	reHkFallback   = regexp.MustCompile(`([\d]+(?:\.\d+)?)`)
)

func (s *Service) dividendHK(ctx context.Context, code string, size int) ([]DividendRow, error) {
	filter := `(SECUCODE="` + code + `.HK")`
	u := hostData + "/api/data/v1/get?reportName=RPT_HKF10_INFO_DIVIDEND&columns=ALL" +
		"&filter=" + url.QueryEscape(filter) +
		"&pageNumber=1&pageSize=" + strconv.Itoa(size) +
		"&sortColumns=NOTICE_DATE&sortTypes=-1&source=WEB&client=WEB"

	var res dataResp
	if err := s.getJSON(ctx, u, &res); err != nil {
		return nil, err
	}

	out := make([]DividendRow, 0, len(res.Result.Data))
	for _, r := range res.Result.Data {
		plan := strField(r, "PLAN_EXPLAIN")
		dps := dpsFromHKPlan(plan)
		if dps <= 0 {
			continue
		}

		out = append(out, DividendRow{
			Period:     strField(r, "ASSIGN_PERIOD"),
			PlanText:   plan,
			Dps:        dps,
			Unit:       "股",
			ExDate:     dateOf(strField(r, "EX_DIVIDEND_DATE")),
			RecordDate: dateOf(strField(r, "RECORD_DATE")),
			PayDate:    dateOf(strField(r, "DIVIDEND_DATE")),
			Progress:   strField(r, "ASSIGN_PROGRESS"),
		})
	}
	return out, nil
}

// dpsFromHKPlan 从公告原文里抠出每股派息。
// 抠不出来返回 0，调用方会跳过这条 —— 宁可少一条，
// 也不要给一条 dps=0 的记录让客户端算出「息率 0%」这种错结论。
//
// 三段正则的可信度不一样，所以处理方式也不同：
// 前两段带「派港币 X」「相当于港币 X」这种上下文，抠出来的数字就是派息；
// 第三段只是「原文里第一个数字」，那个数字可能是年份、股数、方案编号，
// 所以给它加上界 —— 每股派 50 港币以上除了特别股息几乎不存在，
// 超过就认定是抠错了，当作没匹配到。
func dpsFromHKPlan(text string) float64 {
	if strings.TrimSpace(text) == "" {
		return 0
	}

	for _, re := range []*regexp.Regexp{reHkEquivalent, reHkDeclared} {
		if f := matchAmount(re, text); f > 0 {
			return f
		}
	}

	if f := matchAmount(reHkFallback, text); f > 0 && f <= 50 {
		return f
	}
	return 0
}

// matchAmount 取正则第一个捕获组并转成数字，取不到或非正数返回 0。
func matchAmount(re *regexp.Regexp, text string) float64 {
	m := re.FindStringSubmatch(text)
	if len(m) < 2 {
		return 0
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil || f <= 0 {
		return 0
	}
	return round6(f)
}

/* ---------------- 场外基金 ---------------- */

var (
	reFundName  = regexp.MustCompile(`var\s+fS_name\s*=\s*"([^"]*)"`)
	reFundTrend = regexp.MustCompile(`(?s)Data_netWorthTrend\s*=\s*(\[.*?\]);`)
	reFundMoney = regexp.MustCompile(`([\d]+(?:\.\d+)?)\s*元`)
)

type fundTrendPoint struct {
	X            float64 `json:"x"` // 毫秒时间戳
	Y            float64 `json:"y"` // 单位净值
	EquityReturn float64 `json:"equityReturn"`
	UnitMoney    string  `json:"unitMoney"`
}

// FetchFund 取场外基金的净值与分红。
//
// 数据来自天天基金的 /pingzhongdata/<code>.js —— 它是个 JS 脚本，
// 变量的值直接写在源码里，所以只能用正则抠出来，没有 JSON 接口可用。
func (s *Service) FetchFund(ctx context.Context, code string) (*Quote, *Dividend, error) {
	c := trimSpace(code)
	if c == "" {
		return nil, nil, nil
	}

	key := "fund:" + c

	v, err := s.cache.do(key, ttlFund, func() (interface{}, error) {
		return s.directFund(ctx, c)
	})
	if err != nil {
		return nil, nil, err
	}
	if v == nil {
		return nil, nil, nil
	}

	detail := v.(*Detail)
	return detail.Quote, detail.Dividend, nil
}

func (s *Service) directFund(ctx context.Context, code string) (*Detail, error) {
	src, err := s.getText(ctx, hostFund+"/pingzhongdata/"+code+".js")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(src) == "" {
		return nil, nil
	}

	// 净值走势：最后一项是最近一个交易日的净值
	trend := parseFundTrend(src)
	if len(trend) == 0 {
		return nil, nil
	}

	last := trend[len(trend)-1]
	prev := last
	if len(trend) > 1 {
		prev = trend[len(trend)-2]
	}

	name := ""
	if m := reFundName.FindStringSubmatch(src); len(m) >= 2 {
		name = strings.TrimSpace(m[1])
	}

	price := last.Y
	prevClose := prev.Y
	change := round4(price - prevClose)

	quote := &Quote{
		Code:       code,
		Name:       name,
		Price:      price,
		PrevClose:  prevClose,
		Change:     change,
		ChangeRate: last.EquityReturn,
		PriceDate:  dateOfTs(last.X),
		// 场外基金净值固定四位小数：公募基金净值就是按 4 位披露的，
		// 用两位会把「1.2345」显示成「1.23」，用户对不上账。
		Digits: 4,
	}

	return &Detail{
		Quote:    quote,
		Dividend: fundDividendOf(trend),
	}, nil
}

func parseFundTrend(src string) []fundTrendPoint {
	m := reFundTrend.FindStringSubmatch(src)
	if len(m) < 2 {
		return nil
	}
	var points []fundTrendPoint
	if err := json.Unmarshal([]byte(m[1]), &points); err != nil {
		return nil
	}
	return points
}

// fundDividendOf 从净值走势里挑出分红。
//
// 天天基金把分红记录塞在净值序列里：那些 unitMoney 里写着「每份派现金 X 元」
// 的点就是分红日。所以判断依据是字符串里含「派现金」，不是数值。
func fundDividendOf(trend []fundTrendPoint) *Dividend {
	rows := make([]DividendRow, 0)
	for _, p := range trend {
		money := strings.TrimSpace(p.UnitMoney)
		if !strings.Contains(money, "派现金") {
			continue
		}

		dps := 0.0
		if m := reFundMoney.FindStringSubmatch(money); len(m) >= 2 {
			if f, err := strconv.ParseFloat(m[1], 64); err == nil {
				dps = round6(f)
			}
		}
		if dps <= 0 {
			continue
		}

		day := dateOfTs(p.X)
		rows = append(rows, DividendRow{
			Period:   day,
			PlanText: money,
			Dps:      dps,
			Unit:     "份", // 基金按「每份」派现，不是每股
			ExDate:   day,
		})
	}
	return &Dividend{Source: "天天基金 · 基金分红", List: rows}
}

/* ---------------- 日期与数值 ---------------- */

// dateOf 把上游的日期时间裁成 yyyy-MM-dd。
// 上游格式可能是 "2024-06-30" 或 "2024-06-30 00:00:00"，两种都认。
// 形状不对（含 "1900-01-01" 这类占位值）就返回空串 ——
// 客户端把空串当「没有这个日期」，比显示一个假日期强。
func dateOf(v string) string {
	s := strings.TrimSpace(v)
	if len(s) < 10 || s[4] != '-' || s[7] != '-' {
		return ""
	}
	day := s[:10]
	if strings.HasPrefix(day, "1900-") || strings.HasPrefix(day, "0000-") {
		return ""
	}
	return day
}

// dateOfTs 把毫秒时间戳转成 yyyy-MM-dd。
// 用本地时区（进程时区已设成 Asia/Shanghai）：基金净值日期是自然日，
// 用 UTC 会让晚上更新的净值显示成前一天。
func dateOfTs(ms float64) string {
	if ms <= 0 {
		return ""
	}
	return time.UnixMilli(int64(ms)).In(time.Local).Format("2006-01-02")
}

// periodOf 把报告期裁成 yyyy-MM，作为分红记录的「所属期」。
func periodOf(v string) string {
	day := dateOf(v)
	if len(day) < 7 {
		return ""
	}
	return day[:7]
}

// trimNum 把浮点数转成尽量短的十进制字符串（0.50 → 0.5，1.00 → 1）。
func trimNum(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

func round4(f float64) float64 {
	return math.Round(f*10000) / 10000
}

func round6(f float64) float64 {
	return math.Round(f*1000000) / 1000000
}

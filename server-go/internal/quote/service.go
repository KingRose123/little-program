// Package quote 是行情代理：向上游（东方财富）取数，向下游提供
// 与旧 Node 版**逐字段一致**的归一化结果。
//
// 为什么要有这一层（而不是让 App 直接连东财）：
//  1. 客户端那边虽然有一条直连兜底通道，但每台设备各拉一次，
//     一个用户打开持仓页就是十几个请求，几十个用户就能把出口 IP 打到被限流；
//  2. 分红档案是 12 小时级的数据，代理一层能让绝大部分请求落在缓存里；
//  3. 汇率的解析、板块过滤、境外市场代码前缀这些脏活集中在一处，
//     以后换数据源只改这个包。
//
// 与 App 的契约：响应结构、字段名、批量键格式都必须与旧版一致 ——
// app/src/utils/quote.js 归一化时按这些字段名取值，改名就等于是改接口。
package quote

import (
	"context"
	"net/http"
	"time"
)

// 各类数据的缓存时长。
//
// 差别很大是有原因的：
//   - 行情 15 秒：用户会连着刷新几次看涨跌，但过期太久又会被说「数据不准」；
//   - 搜索 60 秒：搜索结果几乎不变，但改名/新上市需要能及时反映；
//   - 基金 30 秒：场外净值一天只更新一次，30 秒纯粹是为了防抖动；
//   - 分红 12 小时：这是公告类数据，一天最多变一两次，
//     而单只标的的分红档案有几十上百条记录，重复拉取代价很高。
const (
	ttlQuote    = 15 * time.Second
	ttlSearch   = 60 * time.Second
	ttlFund     = 30 * time.Second
	ttlDividend = 12 * time.Hour
)

// MaxBatch 单次批量请求的标的数上限。
// 与旧版一致（60）。客户端超量会被路由层拒绝并回 400，
// 而不是静默截断 —— 截断会让用户以为「漏了几只」，很难排查。
const MaxBatch = 60

// batchConcurrency 批量内部并发数。
// 6 是个折中：再高容易触发上游限流，再低则持仓页刷新会明显变慢。
const batchConcurrency = 6

// Service 持有 HTTP 客户端与缓存。
type Service struct {
	http  *http.Client
	cache *cache
}

func New() *Service {
	return &Service{
		http:  &http.Client{Timeout: upstreamTimeout},
		cache: newCache(),
	}
}

// CacheStats 供 /api/stats 输出缓存状况。
func (s *Service) CacheStats() interface{} {
	return s.cache.stats()
}

// CleanCache 回收过期条目，供每日的 cron 调用。
// 返回 {dropped, size}，与旧版字段名一致。
func (s *Service) CleanCache() map[string]int {
	dropped, size := s.cache.clean()
	return map[string]int{"dropped": dropped, "size": size}
}

/* ---------------- 数据结构（对外契约） ---------------- */

// Stock 是一个标的的标识信息。
type Stock struct {
	Code     string `json:"code"`
	Name     string `json:"name"`
	Market   string `json:"market"`
	SecID    string `json:"secid"`
	TypeName string `json:"typeName"`
}

// Quote 是归一化后的行情。
//
// 字段名必须与旧 Node 版一字不差 —— App 直接按这些名字取值。
// 数值缺省一律为 0（而不是 null）：客户端那套计算（市值、盈亏、息率）
// 是按数字算的，null 会让它算出 NaN，而 0 至少是「不知道」的合理近似。
type Quote struct {
	Code         string  `json:"code"`
	Name         string  `json:"name"`
	Price        float64 `json:"price"`
	PrevClose    float64 `json:"prevClose"`
	Change       float64 `json:"change"`
	ChangeRate   float64 `json:"changeRate"`
	Open         float64 `json:"open"`
	High         float64 `json:"high"`
	Low          float64 `json:"low"`
	Amplitude    float64 `json:"amplitude"`
	TurnoverRate float64 `json:"turnoverRate"`
	Volume       float64 `json:"volume"`
	Amount       float64 `json:"amount"`
	PE           float64 `json:"pe"`
	PB           float64 `json:"pb"`
	MarketCap    float64 `json:"marketCap"`
	FloatCap     float64 `json:"floatCap"`
	Digits       int     `json:"digits"`

	// PriceDate 只有场外基金才有（净值日期）。
	// 普通行情不带这个字段，省略掉以免客户端误以为它有意义。
	PriceDate string `json:"priceDate,omitempty"`
}

// DividendRow 是一条分红记录。
type DividendRow struct {
	Period     string  `json:"period"`
	PlanText   string  `json:"planText"`
	Dps        float64 `json:"dps"`
	Unit       string  `json:"unit"`
	ExDate     string  `json:"exDate"`
	RecordDate string  `json:"recordDate"`
	PayDate    string  `json:"payDate"`
	Progress   string  `json:"progress"`
}

// Dividend 是一份分红档案。
type Dividend struct {
	Source string        `json:"source"`
	List   []DividendRow `json:"list"`
}

// Detail 是「行情 + 分红」的组合，持仓详情页与添加持仓页都要它。
//
// 批量结果里的失败项就是 Detail{}（两个字段都是 null）而不是**省略这一项**：
// 客户端按 key 取结果，缺项会让它以为漏传了，拿到两个 null 才知道是「这只没取到」。
type Detail struct {
	Quote    *Quote    `json:"quote"`
	Dividend *Dividend `json:"dividend"`
}

/* ---------------- 对外方法 ---------------- */

// Search 按关键字（代码 / 名称 / 拼音首字母）搜索标的。
// 关键字为空返回空切片（不是 error）—— 空输入不是错误。
func (s *Service) Search(ctx context.Context, keyword string) ([]Stock, error) {
	kw := trimSpace(keyword)
	if kw == "" {
		return []Stock{}, nil
	}

	v, err := s.cache.do("search:"+kw, ttlSearch, func() (interface{}, error) {
		return s.directSearch(ctx, kw)
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return []Stock{}, nil
	}
	return v.([]Stock), nil
}

// FetchQuote 取单只标的的实时行情。取不到返回 (nil, nil)。
func (s *Service) FetchQuote(ctx context.Context, stock Stock) (*Quote, error) {
	secids := []string{}
	if trimSpace(stock.SecID) != "" {
		secids = []string{trimSpace(stock.SecID)}
	} else {
		secids = secidCandidates(stock.Market, stock.Code)
	}
	if len(secids) == 0 {
		return nil, nil
	}

	// 缓存键用候选 secid 列表：同一只美股可能有三个候选，
	// 用列表做键才能让「试出 106 命中」的结果和直接传 106 的请求共享缓存。
	key := "quote:" + joinPipe(secids)

	v, err := s.cache.do(key, ttlQuote, func() (interface{}, error) {
		for _, secid := range secids {
			q, err := s.quoteBySecid(ctx, secid)
			if err != nil {
				return nil, err
			}
			if q != nil {
				return q, nil
			}
		}
		// 所有候选都没数据：返回 nil，缓存层会跳过写入（空结果不缓存）
		return nil, nil
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.(*Quote), nil
}

// FetchDetail 取「行情 + 分红」。
//
// 两个来源彼此独立：任何一个失败都不该让另一个也拿不到 ——
// 用户看持仓时最要紧的是价格，分红档案慢一步无所谓。
func (s *Service) FetchDetail(ctx context.Context, stock Stock) (*Detail, error) {
	if trimSpace(stock.Code) == "" {
		return nil, upstreamErr("缺少标的代码")
	}

	// 场外基金走自己的接口：净值 + 分红都在那个 JS 脚本里
	if stock.Market == "FUND" {
		q, d, err := s.FetchFund(ctx, stock.Code)
		if err != nil {
			return nil, err
		}
		return &Detail{Quote: q, Dividend: d}, nil
	}

	var (
		q   *Quote
		d   *Dividend
		qe  error
		de  error
		done = make(chan struct{}, 2)
	)

	// 两个分支各自加 recover：这里的 goroutine 是裸起的，
	// 没有 recover 的话内部一 panic 就会带走整个进程。
	// 数据竞争方面是安全的 —— 两次 <-done 建立了 happens-before，
	// 主 goroutine 读到的一定是写完的值。
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				q, qe = nil, upstreamErr("获取行情失败")
			}
			done <- struct{}{}
		}()
		q, qe = s.FetchQuote(ctx, stock)
	}()
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				d, de = nil, upstreamErr("获取分红档案失败")
			}
			done <- struct{}{}
		}()
		d, de = s.FetchDividend(ctx, stock, 10)
	}()
	<-done
	<-done

	// 行情拿不到才算失败（分红拿不到是正常的：美股本来就没有档案）
	if qe != nil && q == nil {
		return nil, qe
	}
	if de != nil {
		d = nil
	}

	return &Detail{Quote: q, Dividend: d}, nil
}

// FetchQuotes 批量取行情。返回 { '市场:代码': Quote|null }。
func (s *Service) FetchQuotes(ctx context.Context, items []Stock) (map[string]*Quote, error) {
	list := normalizeItems(items)
	out := make(map[string]*Quote, len(list))
	if len(list) == 0 {
		return out, nil
	}

	results := mapLimit(ctx, list, func(it Stock) (*Quote, error) {
		q, err := s.FetchQuote(ctx, it)
		// 单只失败不影响整批：批量刷新的场景下，
		// 一只票停牌或被临时限流不该让整个持仓页空掉。
		if err != nil {
			return nil, nil
		}
		return q, nil
	})

	for i, it := range list {
		out[BatchKey(it.Market, it.Code)] = results[i]
	}
	return out, nil
}

// FetchDetails 批量取「行情 + 分红」。
func (s *Service) FetchDetails(ctx context.Context, items []Stock) (map[string]Detail, error) {
	list := normalizeItems(items)
	out := make(map[string]Detail, len(list))
	if len(list) == 0 {
		return out, nil
	}

	type pair struct {
		q *Quote
		d *Dividend
	}
	results := mapLimit(ctx, list, func(it Stock) (pair, error) {
		det, err := s.FetchDetail(ctx, it)
		if err != nil || det == nil {
			return pair{}, nil
		}
		return pair{q: det.Quote, d: det.Dividend}, nil
	})

	for i, it := range list {
		out[BatchKey(it.Market, it.Code)] = Detail{Quote: results[i].q, Dividend: results[i].d}
	}
	return out, nil
}

/* ---------------- 内部 ---------------- */

// normalizeItems 去重 + 限流到 MaxBatch。
//
// 去重按「市场:代码」而非 secid：同一个代码可能被传了不同的 secid
// （美股三个候选），但用户眼里它就是一只票，重复拉没有意义。
func normalizeItems(items []Stock) []Stock {
	seen := make(map[string]bool, len(items))
	out := make([]Stock, 0, len(items))

	for _, it := range items {
		code := trimSpace(it.Code)
		if code == "" {
			continue
		}
		it.Code = code
		it.Market = trimSpace(it.Market)

		key := BatchKey(it.Market, code)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, it)

		if len(out) >= MaxBatch {
			break
		}
	}
	return out
}

// mapLimit 是带并发上限的 map。
//
// 为什么不用无上限的 goroutine：批量最多 60 只，无上限就是 60 个并发请求
// 同时打到上游，这是触发限流最快的方式。6 个并发是我们实测能稳住的数量。
// 顺序与输入一一对应，调用方按下标取值即可。
func mapLimit[T any, R any](ctx context.Context, items []T, fn func(T) (R, error)) []R {
	out := make([]R, len(items))

	sem := make(chan struct{}, batchConcurrency)
	done := make(chan int, len(items))

	for i, it := range items {
		go func(idx int, item T) {
			sem <- struct{}{}
			defer func() { <-sem }()
			// 单个任务内部已经做了容错（返回零值），这里再兜一层：
			// 任何一个 goroutine panic 都不该带走整个进程。
			defer func() {
				if rec := recover(); rec != nil {
					done <- idx
				}
			}()
			out[idx], _ = fn(item)
			done <- idx
		}(i, it)
	}

	for range items {
		<-done
	}
	return out
}

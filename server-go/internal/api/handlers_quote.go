package api

import (
	"errors"
	"net/http"

	"xiji/api/internal/quote"
)

/*
行情接口。

与其它接口的两点不同：

 1. **不校验登录**。行情是公开市场数据，加鉴权只是在给排查添麻烦
    （curl 一下就能验证上游通不通，不用先搞一个 token）。
    对上游的保护放在 quote 包里的缓存与并发合并，那才是真正管用的手段。

 2. **错误回 502 而不是 500**。「上游没给数据」和「我们自己的代码/数据库出问题」
    是两件事，运维看到 502 就知道要去查上游，不用从头翻日志。
    客户端两种都按失败处理并回退直连，所以对用户无差别。
*/

// stockFromQuery 从查询串取标的标识。
// secid 是可选的：给了就用它（最准），没给就由 quote 包按代码猜市场前缀。
func stockFromQuery(r *http.Request) quote.Stock {
	q := r.URL.Query()
	return quote.Stock{
		Code:   trimSpace(q.Get("code")),
		Market: trimSpace(q.Get("market")),
		SecID:  trimSpace(q.Get("secid")),
	}
}

// respondQuote 统一把 quote 包的返回值写成响应。
func (s *Server) respondQuote(w http.ResponseWriter, fn func() (interface{}, error)) {
	data, err := fn()
	if err != nil {
		var up *quote.UpstreamError
		if errors.As(err, &up) {
			Fail(w, http.StatusBadGateway, up.Msg)
			return
		}
		FailBiz(w, err, "请求失败")
		return
	}
	OK(w, data)
}

// GET /api/quote/search?kw=xxx
func (s *Server) handleQuoteSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	kw := q.Get("kw")
	if kw == "" {
		kw = q.Get("keyword")
	}
	s.respondQuote(w, func() (interface{}, error) {
		return s.quote.Search(r.Context(), kw)
	})
}

// GET /api/quote?code=&market=&secid=
func (s *Server) handleQuote(w http.ResponseWriter, r *http.Request) {
	stock := stockFromQuery(r)
	if stock.Code == "" {
		Fail(w, http.StatusBadRequest, "缺少 code")
		return
	}
	s.respondQuote(w, func() (interface{}, error) {
		return s.quote.FetchQuote(r.Context(), stock)
	})
}

// GET /api/fund?code=xxx
func (s *Server) handleFund(w http.ResponseWriter, r *http.Request) {
	code := trimSpace(r.URL.Query().Get("code"))
	if code == "" {
		Fail(w, http.StatusBadRequest, "缺少 code")
		return
	}
	s.respondQuote(w, func() (interface{}, error) {
		q, d, err := s.quote.FetchFund(r.Context(), code)
		if err != nil {
			return nil, err
		}
		return map[string]interface{}{"quote": q, "dividend": d}, nil
	})
}

// GET /api/dividend?code=&market=&size=
func (s *Server) handleDividend(w http.ResponseWriter, r *http.Request) {
	stock := stockFromQuery(r)
	if stock.Code == "" {
		Fail(w, http.StatusBadRequest, "缺少 code")
		return
	}
	size := atoiDefault(r.URL.Query().Get("size"), 10)
	s.respondQuote(w, func() (interface{}, error) {
		return s.quote.FetchDividend(r.Context(), stock, size)
	})
}

// GET /api/detail?code=&market=&secid=
func (s *Server) handleDetail(w http.ResponseWriter, r *http.Request) {
	stock := stockFromQuery(r)
	if stock.Code == "" {
		Fail(w, http.StatusBadRequest, "缺少 code")
		return
	}
	s.respondQuote(w, func() (interface{}, error) {
		return s.quote.FetchDetail(r.Context(), stock)
	})
}

// batchBody 是批量接口的请求体。
type batchBody struct {
	Items []quote.Stock `json:"items"`
}

// batchItems 解析并校验批量入参。
//
// 超量**显式拒绝**而不是静默截断：截断会让客户端拿到一份缺项的 map，
// 表现是「有几只持仓没有价格」，而它根本不知道自己少传了。
func (s *Server) batchItems(w http.ResponseWriter, r *http.Request) ([]quote.Stock, bool) {
	body, err := decodeJSON[batchBody](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return nil, false
	}
	if len(body.Items) == 0 {
		Fail(w, http.StatusBadRequest, "缺少 items")
		return nil, false
	}
	if len(body.Items) > quote.MaxBatch {
		Fail(w, http.StatusBadRequest, "单次最多 "+itoa(quote.MaxBatch)+" 只标的")
		return nil, false
	}
	return body.Items, true
}

// POST /api/quotes   { items: [{code, market, secid}] }
func (s *Server) handleQuotes(w http.ResponseWriter, r *http.Request) {
	items, ok := s.batchItems(w, r)
	if !ok {
		return
	}
	s.respondQuote(w, func() (interface{}, error) {
		return s.quote.FetchQuotes(r.Context(), items)
	})
}

// POST /api/details  { items: [{code, market, secid}] }
func (s *Server) handleDetails(w http.ResponseWriter, r *http.Request) {
	items, ok := s.batchItems(w, r)
	if !ok {
		return
	}
	s.respondQuote(w, func() (interface{}, error) {
		return s.quote.FetchDetails(r.Context(), items)
	})
}

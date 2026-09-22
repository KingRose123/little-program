package quote

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

/*
上游（东方财富）访问层。

这一层的取舍与旧 Node 版保持一致，几个看似奇怪的地方都是踩过坑的：

 1. **没有 Referer 头**。行情接口不带 Referer 也能正常返回，
    带上反而在多一层代理时容易被替换成内网地址。

 2. **没有 ut 参数**。很多网上的例子里有 `ut=fa5fd1943c7b386f172d6893dbfba10b`，
    那是别人抓包抄来的常量，我们的实现从来没用过，去掉照常工作。

 3. **超时 8 秒**。上游正常响应在 100-300ms，8 秒是为了忍偶发的网络抖动，
    又不能长到让用户以为页面卡死 —— 客户端那边（quote.js）自己的超时更短，
    它会先超时并降级为直连，所以服务端这里宁可长一点也不要提前放弃。

 4. 任何一个上游失败都抛 UpstreamError，让 handler 回 502 而不是 500。
    区分这两者是为了排障：502 表示「数据没取到」（上游的事），
    500 表示「我们自己出问题了」。客户端两种都按失败处理并回退直连。
*/

const (
	hostQuote  = "https://push2.eastmoney.com"
	hostSearch = "https://search-codetable.eastmoney.com"
	hostData   = "https://datacenter-web.eastmoney.com"
	hostFund   = "https://fund.eastmoney.com"

	upstreamTimeout = 8 * time.Second

	// 行情字段。f43 开盘价…这套编码是东财的约定，少一个字段就少一个数值，
	// 顺序无所谓但一个都不能拼错。
	quoteFields = "f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f116,f117,f162,f167,f168,f169,f170,f171"
)

// UpstreamError 表示「上游没给我们数据」。
// handler 据此回 502（而不是 500），日志里也能一眼分开故障来源。
type UpstreamError struct {
	Msg string
}

func (e *UpstreamError) Error() string { return e.Msg }

func upstreamErr(format string, args ...interface{}) error {
	return &UpstreamError{Msg: fmt.Sprintf(format, args...)}
}

func (s *Service) getJSON(ctx context.Context, url string, out interface{}) error {
	body, err := s.getText(ctx, url)
	if err != nil {
		return err
	}
	if err := json.Unmarshal([]byte(body), out); err != nil {
		return upstreamErr("上游返回的不是合法 JSON")
	}
	return nil
}

func (s *Service) getText(ctx context.Context, url string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, upstreamTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", upstreamErr("构造请求失败")
	}
	req.Header.Set("content-type", "application/json")
	// 带一个能表明身份的 UA：万一上游要封，至少封的是一个可联系的对象，
	// 而不是一个匿名的默认 Go 客户端。
	req.Header.Set("user-agent", "Mozilla/5.0 (compatible; xiji-server/1.0)")

	resp, err := s.http.Do(req)
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return "", upstreamErr("行情接口超时，请稍后重试")
		}
		return "", upstreamErr("行情接口请求失败")
	}
	defer resp.Body.Close()

	// 限流很常见（尤其是批量刷新时），单独给一句更具体的提示，
	// 免得运维去查「为什么偶发 502」却看不出是限流。
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == 403 {
		return "", upstreamErr("行情接口返回 %d（可能被限流）", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", upstreamErr("行情接口返回 %d", resp.StatusCode)
	}

	// 响应体不大（行情几百字节，基金净值脚本约 200KB）。
	// 限制到 8MB 是为了不让一个异常的上游响应把内存吃掉。
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return "", upstreamErr("读取行情数据失败")
	}
	return string(body), nil
}

/* ---------------- 市场与 secid ---------------- */

// 东财的数字市场号 → 我们的市场标识。
// 没列出的（比如 90 开头的板块指数）一律丢弃，客户端不认识它们。
var marketByNo = map[string]string{
	"0":   "A", // 深市
	"1":   "A", // 沪市
	"105": "US",
	"106": "US",
	"107": "US",
	"116": "HK",
	"150": "FUND", // 场外基金
}

// secidCandidates 猜该标的可能的市场前缀。
//
// 为什么是「猜」：调用方有时只给了代码（比如从旧数据里读出来的持仓），
// 没带 secid。A 股靠代码首位区分沪深（6/5/9 开头为沪市，其余归深市，
// 北交所也在深市那一支），美股则可能是 105/106/107 三个之一 ——
// 所以美股要按顺序试，命中即停。
func secidCandidates(market, code string) []string {
	c := strings.ToUpper(strings.TrimSpace(code))
	if c == "" {
		return nil
	}

	switch market {
	case "US":
		return []string{"105." + c, "106." + c, "107." + c}
	case "HK":
		return []string{"116." + c}
	case "FUND":
		// 场外基金不走行情接口，它有自己的净值地址
		return nil
	default:
		if c[0] == '6' || c[0] == '5' || c[0] == '9' {
			return []string{"1." + c}
		}
		return []string{"0." + c}
	}
}

// BatchKey 是批量接口的键：市场 + 冒号 + 大写代码。
//
// 客户端（app/src/utils/quote.js）按同样的规则回填结果，
// 所以这个格式是接口契约的一部分，不能改。
func BatchKey(market, code string) string {
	return market + ":" + strings.ToUpper(code)
}

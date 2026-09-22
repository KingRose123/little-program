package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"xiji/api/internal/quote"
)

/*
定时任务接口，由服务器上的 cron 用 curl 触发（见 README 的 crontab 示例）。

为什么不做成进程内的定时器：
服务可能有多个实例（滚动发布时至少有两个），进程内定时器会让每个实例
各跑一遍；而且预热的意义是「把数据放进正在服务请求的那个进程的内存缓存」，
由 HTTP 打进来才正好落在那份缓存上。

令牌必须配（fail closed）：没配就整个拒绝。否则接口挂在公网上，
任何人都能反复触发预热，用我们的出口 IP 去打上游的免费行情接口 ——
被封的是我们，而对方什么都没做。
*/

// cronAllowed 校验定时任务令牌。
func (s *Server) cronAllowed(w http.ResponseWriter, r *http.Request) bool {
	if s.cfg.CronToken == "" {
		Fail(w, http.StatusServiceUnavailable, "未配置 CRON_TOKEN，定时任务已拒绝执行")
		return false
	}

	// 令牌放请求头（推荐），也接受查询串 ——
	// 定时任务用 curl 触发，两种写法都能塞进一行 crontab。
	got := r.Header.Get("X-Cron-Token")
	if got == "" {
		got = r.URL.Query().Get("token")
	}

	if got != s.cfg.CronToken {
		Fail(w, http.StatusUnauthorized, "定时任务令牌不正确")
		return false
	}
	return true
}

// handleCronWarm 预热行情缓存。
func (s *Server) handleCronWarm(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	res, err := s.warmQuotes(r.Context())
	if err != nil {
		FailBiz(w, err, "预热失败")
		return
	}
	OK(w, res)
}

// handleCronClean 回收过期缓存条目。
//
// 内存缓存的过期条目平时只是「取不到」，不会主动消失；
// 每天清一次可以避免它一直占着内存（尤其是分红那种 12 小时 TTL 的大对象）。
func (s *Server) handleCronClean(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}
	OK(w, s.quote.CleanCache())
}

// warmQuotes 把所有用户持仓涉及的标的刷进缓存。
//
// 目的：用户白天打开持仓页时基本都命中缓存，不用等上游。
// 工作日开盘前与收盘后各跑一次（见 README 的 crontab）。
//
// 几个刻意的取舍：
//   - 单个用户快照解析失败只计数不中断：一个坏快照不该让整批预热停住；
//   - 单批拉取失败只记录不中断：上游抖一下，后面的批次照样预热；
//   - 去重按「市场:代码」：同一只票被几十个用户持有，只刷一次。
func (s *Server) warmQuotes(ctx context.Context) (map[string]interface{}, error) {
	started := time.Now()

	const (
		maxUsers = 5000 // 单次最多扫多少用户，防止用户量大时跑太久

		// pageSize 故意取小：ListSnapshots 会把整页的 payload 读进内存，
		// 而单份快照上限是 5MB —— 一页 500 行在极端情况下是 2.5GB，
		// 足够把容器打爆。50 行的峰值约 250MB，是个安全得多的上界，
		// 代价只是多几次查询（预热本来就跑在没人用的时段）。
		pageSize = 50
	)

	seen := make(map[string]bool)
	items := make([]quote.Stock, 0, 256)

	scanned := 0
	broken := 0
	offset := 0

	for scanned < maxUsers {
		page, err := s.store.ListSnapshots(ctx, pageSize, offset)
		if err != nil {
			return nil, err
		}
		if len(page) == 0 {
			break
		}
		offset += len(page)

		for _, row := range page {
			scanned++

			// 只关心 holdings 里的三个字段，用小结构体而不是 map：
			// 快照可能有 5MB，让 encoding/json 跳过不认识的字段比逐个取值快得多。
			var root struct {
				Holdings []struct {
					Code   string `json:"code"`
					Market string `json:"market"`
					SecID  string `json:"secid"`
				} `json:"holdings"`
			}
			if err := json.Unmarshal(row.Payload, &root); err != nil {
				broken++
				continue
			}

			for _, h := range root.Holdings {
				code := strings.ToUpper(strings.TrimSpace(h.Code))
				if code == "" {
					continue
				}
				market := strings.TrimSpace(h.Market)

				key := quote.BatchKey(market, code)
				if seen[key] {
					continue
				}
				seen[key] = true

				items = append(items, quote.Stock{
					Code:   code,
					Market: market,
					SecID:  strings.TrimSpace(h.SecID),
				})
			}
		}

		if len(page) < pageSize {
			break
		}
	}

	warmed := 0
	failedCount := 0
	failed := make([]string, 0, 20)

	for i := 0; i < len(items); i += quote.MaxBatch {
		end := i + quote.MaxBatch
		if end > len(items) {
			end = len(items)
		}
		chunk := items[i:end]

		res, err := s.quote.FetchDetails(ctx, chunk)
		if err != nil {
			log.Printf("[cron] 预热批次失败（%d 只）: %v", len(chunk), err)
			failedCount += len(chunk)
			for _, it := range chunk {
				if len(failed) < 20 {
					failed = append(failed, quote.BatchKey(it.Market, it.Code))
				}
			}
			continue
		}

		for _, it := range chunk {
			key := quote.BatchKey(it.Market, it.Code)
			if d, ok := res[key]; ok && d.Quote != nil {
				warmed++
				continue
			}
			// 拿不到行情的：停牌、退市、代码拼错，或上游临时限流。
			// 只记前 20 个，避免日志被刷屏 —— 具体有哪些看 /api/admin 那边的数据更准。
			failedCount++
			if len(failed) < 20 {
				failed = append(failed, key)
			}
		}
	}

	return map[string]interface{}{
		"users":       scanned,
		"brokenUsers": broken,
		"codes":       len(items),
		"warmed":      warmed,
		"failedCount": failedCount,
		"failed":      failed,
		"elapsedMs":   time.Since(started).Milliseconds(),
		"cache":       s.quote.CacheStats(),
	}, nil
}

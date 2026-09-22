package api

import (
	"log"
	"net/http"
	"time"
)

/*
健康检查与运维接口。

/health 的设计目标：部署完 curl 一下就知道「服务活没活、数据库通不通、
支付配好了没」，不用再翻一遍环境变量逐个对。

它**不回任何密钥内容**，只回布尔和变量名，所以放在公开路径上是安全的。
*/

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	// 数据库连通性：真的取一次连接，而不是看连接池对象的字段。
	// 池子还在、底下连接已经被服务端断掉（wait_timeout）是常见故障，
	// 只有真的拿一次连接才能发现。
	dbOK := true
	poolStats := map[string]interface{}{}
	if pool, err := s.db.Pool(r.Context()); err != nil {
		dbOK = false
		log.Printf("[health] 数据库不可用: %v", err)
	} else {
		st := pool.Stats()
		// 连接池是**最容易被忽视的瓶颈**：池被占满时外部表现只是「变慢」，
		// 日志里什么都没有，看不出原因。所以把它摆在这里。
		//
		// 重点看 waitCount：它 > 0 就说明真的有人在排队等连接，
		// 那是「池该调大」的直接证据，而不是猜测。
		poolStats = map[string]interface{}{
			"max":       st.MaxOpenConnections,
			"open":      st.OpenConnections,
			"inUse":     st.InUse,
			"idle":      st.Idle,
			"waitCount": st.WaitCount,
			"waitMs":    st.WaitDuration.Milliseconds(),
		}
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":      true,
		"service": "xiji-api",
		"build":   s.cfg.Build,
		"time":    time.Now().In(s.cfg.Location).Format(time.RFC3339),
		"uptime":  int(time.Since(s.started).Seconds()),
		"config": map[string]interface{}{
			"mysql":    dbOK,
			"cron":     s.cfg.CronToken != "",
			"timezone": s.cfg.Location.String(),
			"db":       s.cfg.DBName,
			// 还缺哪些可选配置（只回变量名，不回内容）
			"lack": s.cfg.Missing(),
		},
		// 支付渠道逐个报状态：配好没有、还缺哪些变量名（不含内容）。
		// 多渠道之后这块尤其重要 —— 只说「有个渠道不可用」等于没说，
		// 得能一眼看出是哪一家、缺什么。
		"pay": s.pay.Status(),
		// 连接池：waitCount 长期大于 0 就说明池该调大了
		"pool": poolStats,
	})
}

// handleStats 输出运行状况。
//
// 缓存这一块是排查「为什么行情一直是旧数据」的第一站：
//   - size 一直贴着 max：说明容量被撑满，在频繁淘汰，
//     表现是命中率上不去、上游请求变多，但不影响正确性；
//   - inflight 长期不为 0：说明有上游请求卡住了（大概率是超时前的那 8 秒），
//     同一 key 的其它请求都在等它。
func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	OK(w, map[string]interface{}{
		"uptimeSec": int(time.Since(s.started).Seconds()),
		"build":     s.cfg.Build,
		"cache":     s.quote.CacheStats(),
	})
}

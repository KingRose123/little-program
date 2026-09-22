package api

import (
	"encoding/csv"
	"log"
	"net/http"
	"strconv"
	"strings"

	"xiji/api/internal/store"
)

/*
后台接口。

访问控制统一走 cronAllowed（令牌取自 CRON_TOKEN，与定时任务共用）：
这些接口能看全站数据、能重置别人的密码、能凭空生成会员，
绝对不能只要登录就能调 —— 所以它们独立于用户 token 体系之外，
用一个只存在于服务器上的令牌。

用法（令牌放请求头，也可以放查询串）：
	curl -X POST https://api.你的域名.com/api/admin/codes \
	     -H 'X-Cron-Token: <CRON_TOKEN>' \
	     -H 'Content-Type: application/json' \
	     -d '{"tier":"pro","months":12,"count":10,"note":"闲鱼首批"}'
*/

// handleOverview 运营总览。
//
// 它回答的是「现在有多少人、多少活跃、多少付费、大家在买什么、
// 谁的快照快撑爆了」—— 这些恰好是每天要看一眼的东西，
// 而它们全都来自影子表（原始快照是 5MB 的 JSON，查不动）。
func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	res, err := s.shadow.Overview(r.Context())
	if err != nil {
		FailBiz(w, err, "读取总览失败")
		return
	}
	OK(w, res)
}

// handleBackfill 把已有快照补进影子表。
//
// 什么时候需要它：
//  1) 影子表这个功能第一次上线时，老用户的数据要补一份，
//     否则后台只能看到「上线之后新注册的人」；
//  2) 某次双写故障之后兜底。
//
// 配合 limit/offset 分页，避免一次拉太多把内存撑起来。
func (s *Server) handleBackfill(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	body, err := decodeJSON[struct {
		Limit  int `json:"limit"`
		Offset int `json:"offset"`
	}](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	res, err := s.shadow.Backfill(r.Context(), body.Limit, body.Offset)
	if err != nil {
		FailBiz(w, err, "回填失败")
		return
	}
	OK(w, res)
}

/* ---------------- 兑换码：查询与导出 ----------------
 *
 * 生成接口（POST /api/admin/codes）只回答「刚造的这批是什么」，
 * 而卖码时真正要问的是「手上还有哪些没发出去」——
 * 没有下面这两个接口，就只能靠本地记一张表格对账，
 * 一不小心就会把同一个码发给两个人。
 */

// handleListCodes 查兑换码：可按批次与使用状态筛选，同时给出统计。
//
// 用法：
//
//	# 全部批次最近 200 条
//	curl -H 'X-Cron-Token: <令牌>' 'https://api.你的域名.com/api/admin/codes'
//	# 只看某一批里还没发出去的（发码前先看这个，避免重复发）
//	curl -H 'X-Cron-Token: <令牌>' 'https://api.你的域名.com/api/admin/codes?batch=20260922&status=unused'
func (s *Server) handleListCodes(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	q := r.URL.Query()
	f := store.CodeFilter{
		Batch:  trimSpace(q.Get("batch")),
		Status: trimSpace(q.Get("status")),
		Limit:  atoiOr(q.Get("limit"), 200),
		Offset: atoiOr(q.Get("offset"), 0),
	}

	list, stats, err := s.store.ListCodes(r.Context(), f)
	if err != nil {
		FailBiz(w, err, "查询兑换码失败")
		return
	}

	batches, err := s.store.ListBatches(r.Context())
	if err != nil {
		// 批次概览只是个便利视图，拿不到不该让整个查询失败
		log.Printf("[admin] 读取批次概览失败: %v", err)
	}

	OK(w, map[string]interface{}{
		"stats":   stats,
		"list":    list,
		"batches": batches,
		"filter": map[string]interface{}{
			"batch":  f.Batch,
			"status": f.Status,
			"limit":  f.Limit,
			"offset": f.Offset,
		},
	})
}

// handleExportCodes 把兑换码导成 CSV。
//
// 主要用途是倒进发货系统（淘宝虚拟商品的自动发货就是导入一个码库），
// 所以按发货的习惯排：一列就是一批码，可以直接整列复制粘贴。
//
// 两个刻意的处理：
//  1. 开头写 UTF-8 BOM —— 不写的话 Excel 会按 GBK 解，中文列全是乱码，
//     而这张表恰恰是给人看的；
//  2. 状态列写中文（未使用 / 已使用），而不是 true/false。
//
// 令牌可以放查询串，所以在浏览器里直接打开这个地址就能下载，不必装 curl：
//
//	https://api.你的域名.com/api/admin/codes/export?token=<令牌>&batch=20260922&status=unused
func (s *Server) handleExportCodes(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	q := r.URL.Query()
	f := store.CodeFilter{
		Batch:  trimSpace(q.Get("batch")),
		Status: trimSpace(q.Get("status")),
		// 导出不分页，但一次封顶 1000 条：再多就该按批次分批导，
		// 免得一次拉一大串把内存和响应都撑大
		Limit: 1000,
	}

	list, _, err := s.store.ListCodes(r.Context(), f)
	if err != nil {
		FailBiz(w, err, "导出失败，请稍后重试")
		return
	}

	name := "codes"
	if f.Batch != "" {
		name = "codes-" + f.Batch
	}
	if f.Status != "" {
		name += "-" + f.Status
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`.csv"`)
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF}) // BOM，见上面的注释

	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"兑换码", "档位", "月数", "状态", "使用者", "使用时间", "批次", "备注", "生成时间"})
	for _, c := range list {
		status := "未使用"
		if c.Used {
			status = "已使用"
		} else if c.Voided {
			status = "已作废"
		}
		_ = cw.Write([]string{
			c.Code, c.Tier, strconv.Itoa(c.Months), status,
			c.UsedBy, c.UsedAt, c.Batch, c.Note, c.CreatedAt,
		})
	}
	cw.Flush()
	if err := cw.Error(); err != nil {
		// 响应头已经发出去了，只能记日志 —— 用户那边会拿到一个截断的 CSV，
		// 所以这里要留痕，免得以后怀疑「导出来的怎么少了几行」
		log.Printf("[admin] 导出 CSV 写入中断: %v", err)
	}
}

// handleVoidCodes 作废兑换码。
//
// 两种用法二选一：
//
//	# 作废指定的几个码（发错了人、买家退款）
//	curl -X POST "$API/api/admin/codes/void" -H "X-Cron-Token: $T" \
//	  -H 'Content-Type: application/json' -d '{"codes":["SXLXXXXXXXXXX"]}'
//
//	# 整批作废（某批码泄漏了）
//	curl -X POST "$API/api/admin/codes/void" -H "X-Cron-Token: $T" \
//	  -H 'Content-Type: application/json' -d '{"batch":"20260922-153000"}'
//
// 只能作废**未使用**的码。想收回某个已开通用户的会员，那是退款，不是作废。
func (s *Server) handleVoidCodes(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	body, err := decodeJSON[struct {
		Codes []string `json:"codes"`
		Batch string   `json:"batch"`
	}](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	batch := trimSpace(body.Batch)
	if len(body.Codes) == 0 && batch == "" {
		Fail(w, http.StatusBadRequest, "请给出 codes 或 batch")
		return
	}
	// 拦一个上限：真实场景一次顶多几十个，几百个更像是把参数传错了
	if len(body.Codes) > 500 {
		Fail(w, http.StatusBadRequest, "一次最多作废 500 个码")
		return
	}

	n, err := s.store.VoidCodes(r.Context(), body.Codes, batch)
	if err != nil {
		FailBiz(w, err, "作废失败，请稍后重试")
		return
	}

	// 一条都没改必须明说，不能回「成功」—— 那会让人以为作废生效了，
	// 接着把已经作废的码发出去。
	if n == 0 {
		log.Printf("[admin] 作废未命中 batch=%q codes=%d", batch, len(body.Codes))
		Fail(w, http.StatusBadRequest, "没有可作废的码（可能都已使用或已作废）")
		return
	}

	log.Printf("[admin] 已作废 %d 个兑换码 batch=%q codes=%d", n, batch, len(body.Codes))
	OK(w, map[string]interface{}{"voided": n})
}

// atoiOr 解析查询串里的整数，坏值或缺失时用默认值。
//
// 不报错是刻意的：这些参数只影响分页效果，为它中断整个查询不值得 ——
// 传错 limit 的用户想看的是数据，不是一句「limit 不合法」。
func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return def
}

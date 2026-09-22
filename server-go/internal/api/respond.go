package api

import (
	"encoding/json"
	"log"
	"net/http"

	"xiji/api/internal/apperr"
)

/*
统一响应形状 —— 这一层是**对外契约**，App 就是按它解析的，一个字都不能改：

  成功：{ "ok": true, "data": {...} }         或某些接口是平铺的字段
  失败：{ "ok": false, "msg": "给用户看的一句话" }

客户端（app/src/utils/cloud.js）的判定是：
  HTTP 2xx 且 body.ok !== false  → 成功
  否则取 body.msg 作为错误文案；401 还会额外清本地登录态、跳登录页

所以有两个约束必须守住：
  1) 业务失败的 HTTP 状态码要**有意义**（401 未登录 / 400 参数或业务错 / 403 无权），
     不能一律 500 —— 401 是客户端唯一会主动退出登录的信号；
  2) 任何情况下都必须回 JSON。客户端解析失败时会拿到一句含糊的
     「服务异常（状态码）」，那是最难排查的一类线上故障。
*/

// writeJSON 输出 JSON。序列化失败会走到 http.Error —— 那种情况下
// 响应体已部分写出，能做的只有记日志。
func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)

	if err := json.NewEncoder(w).Encode(body); err != nil {
		log.Printf("[http] 响应序列化失败: %v", err)
	}
}

// OK 返回一个成功响应，data 为内容。
func OK(w http.ResponseWriter, data interface{}) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":   true,
		"data": data,
	})
}

// OKFields 返回成功响应，字段平铺在顶层（不套 data）。
// 登录、state 这几个接口在 App 里就是按平铺字段读的，沿用旧形状。
func OKFields(w http.ResponseWriter, fields map[string]interface{}) {
	fields["ok"] = true
	writeJSON(w, http.StatusOK, fields)
}

// Fail 返回失败响应。
func Fail(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]interface{}{
		"ok":  false,
		"msg": msg,
	})
}

// FailBiz 把错误映射成响应。
//
// 这里是全项目唯一一处做「错误 → 状态码」判断的地方。
// apperr.Biz 是业务错误（用户能自己纠正）→ 400，带着原文；
// 其余一律 500 + 一句兜底 —— 把数据库错误原文抛给用户既看不懂又泄露实现。
func FailBiz(w http.ResponseWriter, err error, fallback string) {
	if apperr.IsBiz(err) {
		Fail(w, http.StatusBadRequest, apperr.Message(err, fallback))
		return
	}
	log.Printf("[api] %s: %v", fallback, err)
	Fail(w, http.StatusInternalServerError, fallback)
}

// Unauthorized 是客户端唯一会主动退出登录的信号，
// 文案与旧版一致（用户看到这句就知道该重新登录了）。
func Unauthorized(w http.ResponseWriter) {
	Fail(w, http.StatusUnauthorized, msgNoAuth)
}

const msgNoAuth = "未登录或登录已过期，请重新登录"

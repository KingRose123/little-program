package api

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"

	"xiji/api/internal/auth"
)

/*
认证接口。

响应形状完全沿用旧版，因为 App 端（app/src/utils/cloud.js 与 utils/api.js）
就是按这些字段名解析的：
  register / login → data: { token, expiresInDays, uid, username, isNew }
  me               → data: { uid, via, username, phone }
  logout           → 只有 { ok: true }
  account(DELETE)  → data: { deleted: true }
*/

type authResult struct {
	Token         string `json:"token"`
	ExpiresInDays int    `json:"expiresInDays"`
	UID           string `json:"uid"`
	Username      string `json:"username"`
	IsNew         bool   `json:"isNew"`
}

type authBody struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	body, err := decodeJSON[authBody](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return // decodeJSON 已经回过错了
	}

	username := auth.NormalizeUsername(body.Username)
	password := body.Password

	// 先做与数据库无关的入参校验：参数错了就该立刻 400，
	// 不该因为数据库抖一下变成 500 让人以为服务挂了。
	if msg := auth.CheckUsername(username); msg != "" {
		Fail(w, http.StatusBadRequest, msg)
		return
	}
	if msg := auth.CheckPassword(password); msg != "" {
		Fail(w, http.StatusBadRequest, msg)
		return
	}

	acc, err := s.store.Register(r.Context(), username, password)
	if err != nil {
		FailBiz(w, err, "注册失败，请稍后重试")
		return
	}

	t, err := s.store.IssueToken(r.Context(), acc.UID, deviceOf(r))
	if err != nil {
		log.Printf("[auth] 签发凭证失败 uid=%s: %v", acc.UID, err)
		Fail(w, http.StatusInternalServerError, "注册失败，请稍后重试")
		return
	}

	OK(w, authResult{
		Token:         t.Token,
		ExpiresInDays: t.ExpiresInDays,
		UID:           acc.UID,
		Username:      acc.Username,
		IsNew:         true,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	body, err := decodeJSON[authBody](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	username := auth.NormalizeUsername(body.Username)
	password := body.Password

	if username == "" || password == "" {
		Fail(w, http.StatusBadRequest, "请输入用户名和密码")
		return
	}

	// 先看是否处于锁定期，免得被拿来暴力猜密码
	state, err := s.store.AttemptState(r.Context(), username)
	if err != nil {
		log.Printf("[auth] 读取登录限流状态失败: %v", err)
		Fail(w, http.StatusInternalServerError, "登录失败，请稍后重试")
		return
	}
	if state.Blocked {
		Fail(w, http.StatusTooManyRequests,
			"密码错误次数过多，请 "+itoa(state.LeftMin)+" 分钟后再试")
		return
	}

	acc, err := s.store.LoginByPassword(r.Context(), username, password)
	if err != nil {
		log.Printf("[auth] 登录查询失败: %v", err)
		Fail(w, http.StatusInternalServerError, "登录失败，请稍后重试")
		return
	}
	if acc == nil {
		// 记一次失败但**不影响**返回给用户的内容：
		// 「用户名不存在」和「密码不对」必须是同一句话，否则这个接口
		// 就成了枚举用户名的工具。
		if err := s.store.NoteFail(r.Context(), username, clientIP(r)); err != nil {
			log.Printf("[auth] 记录登录失败次数出错: %v", err)
		}
		Fail(w, http.StatusBadRequest, "用户名或密码不正确")
		return
	}

	if err := s.store.ClearFails(r.Context(), username); err != nil {
		log.Printf("[auth] 清除登录失败次数出错: %v", err)
	}

	t, err := s.store.IssueToken(r.Context(), acc.UID, deviceOf(r))
	if err != nil {
		log.Printf("[auth] 签发凭证失败 uid=%s: %v", acc.UID, err)
		Fail(w, http.StatusInternalServerError, "登录失败，请稍后重试")
		return
	}

	OK(w, authResult{
		Token:         t.Token,
		ExpiresInDays: t.ExpiresInDays,
		UID:           acc.UID,
		Username:      acc.Username,
		IsNew:         false,
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	p, err := s.store.Profile(r.Context(), uid)
	if err != nil {
		FailBiz(w, err, "读取账号失败")
		return
	}
	if p == nil {
		// token 有效但账号行没了（后台删过账号）。
		// 当作未登录处理，让客户端清掉本地登录态。
		Unauthorized(w)
		return
	}

	OK(w, map[string]interface{}{
		"uid":      p.UID,
		"via":      "token",
		"username": p.Username,
		"phone":    p.Phone,
	})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	// 这里刻意不要求 token 有效：客户端可能带着一个已过期的 token 来登出，
	// 那时候它要的只是「把我的本地登录态清掉」，不该收到 401。
	token := bearerToken(r.Header.Get("Authorization"))
	if token != "" {
		if err := s.store.Logout(r.Context(), token); err != nil {
			log.Printf("[auth] 登出失败: %v", err)
			Fail(w, http.StatusInternalServerError, "退出失败")
			return
		}
	}

	OKFields(w, map[string]interface{}{})
}

// handleDestroyAccount 注销账号：删除服务器上这个人的**全部**数据。
//
// 这是隐私政策里「删除服务器与本地的全部数据」那句话的兑现处，
// 所以清理动作全部集中在这一个函数里，逐项列出 —— 漏一张表就是违约。
// 影子表（users / holdings / holding_records）虽然可以由快照重建，
// 但它们同样是这个人的信息，必须一起清。
func (s *Server) handleDestroyAccount(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	ctx := r.Context()

	if err := s.store.DeleteState(ctx, uid); err != nil {
		FailBiz(w, err, "注销失败，请稍后重试")
		return
	}
	if err := s.shadow.RemoveUser(ctx, uid); err != nil {
		log.Printf("[auth] 清理影子表失败 uid=%s: %v", uid, err)
		// 不中断：影子表是派生数据，账号本身删掉才是关键
	}

	username, err := s.store.DeleteAccount(ctx, uid)
	if err != nil {
		FailBiz(w, err, "注销失败，请稍后重试")
		return
	}

	log.Printf("[auth] 已注销账号 username=%s uid=%s", username, uid)
	OK(w, map[string]interface{}{"deleted": true})
}

/* ---------------- 后台 ---------------- */

// handleResetPassword 重置某个账号的密码。
//
// 为什么需要它：现在只有账号密码一种登录方式，短信通道没接，
// 用户忘了密码就没有自助通道。
func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	body, err := decodeJSON[authBody](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	username := auth.NormalizeUsername(body.Username)
	if username == "" {
		Fail(w, http.StatusBadRequest, "缺少 username")
		return
	}
	if msg := auth.CheckPassword(body.Password); msg != "" {
		Fail(w, http.StatusBadRequest, msg)
		return
	}

	uid, err := s.store.ResetPassword(r.Context(), username, body.Password)
	if err != nil {
		FailBiz(w, err, "重置失败，请稍后重试")
		return
	}
	if uid == "" {
		Fail(w, http.StatusNotFound, "没有这个用户名")
		return
	}

	// 密码都换了，旧登录态不该继续有效
	if err := s.store.DropTokens(r.Context(), uid); err != nil {
		log.Printf("[admin] 清理旧凭证失败 uid=%s: %v", uid, err)
	}

	log.Printf("[admin] 已重置密码 username=%s", username)
	OK(w, map[string]interface{}{"uid": uid, "username": username})
}

// handleGenCodes 生成兑换码（线下收款后发码用）。
func (s *Server) handleGenCodes(w http.ResponseWriter, r *http.Request) {
	if !s.cronAllowed(w, r) {
		return
	}

	body, err := decodeJSON[struct {
		Tier   string `json:"tier"`
		Months int    `json:"months"`
		Count  int    `json:"count"`
		Note   string `json:"note"`
	}](w, r, s.cfg.MaxPayloadBytes)
	if err != nil {
		return
	}

	tier := body.Tier
	if tier == "" {
		tier = "pro"
	}
	if tier != "lite" && tier != "pro" {
		Fail(w, http.StatusBadRequest, "tier 只能是 lite 或 pro")
		return
	}

	months := body.Months
	if months <= 0 {
		months = 12
	}

	batchNo := timeKey()
	codes, err := s.store.GenCodes(r.Context(), tier, months, body.Count, batchNo, body.Note)
	if err != nil {
		FailBiz(w, err, "生成失败，请稍后重试")
		return
	}

	log.Printf("[admin] 生成兑换码 %d 个 tier=%s months=%d batch=%s", len(codes), tier, months, batchNo)
	OK(w, map[string]interface{}{
		"tier":   tier,
		"months": months,
		"count":  len(codes),
		"codes":  codes,
		"batch":  batchNo,
	})
}

/* ---------------- 工具 ---------------- */

// decodeJSON 解析请求体，出错时直接写响应并返回 error。
// 泛型在这里很值：每个 handler 都能拿到具体的 body 类型，
// 不用写一堆 map[string]interface{} 再手工取值。
func decodeJSON[T any](w http.ResponseWriter, r *http.Request, maxBytes int) (T, error) {
	var out T

	// 上限比业务上限多一点富余，让「刚好超限」的请求能走到业务层的
	// 精确判断（返回 413 而不是连接被掐断）。
	r.Body = http.MaxBytesReader(w, r.Body, int64(maxBytes)+1024*1024)

	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&out); err != nil {
		if isBodyTooLarge(err) {
			Fail(w, http.StatusRequestEntityTooLarge, "数据过大")
			return out, err
		}
		// 空 body 是允许的：登出、查询这类接口本来就不需要参数，
		// 客户端发的就是空对象甚至空字符串。
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		Fail(w, http.StatusBadRequest, "请求格式不正确")
		return out, err
	}

	return out, nil
}

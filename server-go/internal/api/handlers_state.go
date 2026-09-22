package api

import (
	"encoding/json"
	"log"
	"net/http"

	"xiji/api/internal/snapshot"
)

/*
用户数据快照接口。

三个动作，对应 App 端 store.js 的三条路径：
  GET    /api/state  拉取（启动 / 前台切回）
  PUT    /api/state  整份覆盖上传（任何数据变更后防抖推送）
  DELETE /api/state  清空（注销账号时）

响应字段名与旧版一字不差：uid / rev / updatedAt / payload / bytes。
App 端的 store.js 会读 rev 回写到本地，rev 缺失会让它以为没同步成功。
*/

// handleGetState 读快照。
//
// 新用户（云端还没有数据）返回 payload: null —— 这是 App 端约定的信号：
// 它看到 null 就把本地那份推上来当初始数据。返回空对象 {} 会让它
// 以为云端有一份空数据，从而把本地的持仓全清掉。
func (s *Server) handleGetState(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	// 记一次活跃（内部按 10 分钟节流，不会每次读都写库）。
	// 失败只记日志：它是运营看板用的派生数据，不该影响用户读自己的数据。
	if err := s.shadow.Touch(r.Context(), uid); err != nil {
		log.Printf("[shadow] 记录活跃失败 uid=%s: %v", uid, err)
	}

	snap, err := s.store.GetState(r.Context(), uid)
	if err != nil {
		FailBiz(w, err, "读取失败，请稍后重试")
		return
	}

	if snap == nil {
		OKFields(w, map[string]interface{}{
			"uid":       uid,
			"rev":       0,
			"updatedAt": nil,
			"payload":   nil,
		})
		return
	}

	// payload 用 json.RawMessage 原样内联：不解析、不重排、不改精度。
	// 客户端推上来什么样，读回去就什么样。
	OKFields(w, map[string]interface{}{
		"uid":       uid,
		"rev":       snap.Rev,
		"updatedAt": snap.UpdatedAt,
		"payload":   json.RawMessage(snap.Payload),
	})
}

// handlePutState 整份覆盖写入。
func (s *Server) handlePutState(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	// 这里不用 decodeJSON：payload 必须保持原始字节，
	// 解析成 map 再序列化回去会丢掉字段顺序，也会把大整数变成浮点。
	body := struct {
		Payload json.RawMessage `json:"payload"`
	}{}

	r.Body = http.MaxBytesReader(w, r.Body, int64(s.cfg.MaxPayloadBytes)+1024*1024)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		if isBodyTooLarge(err) {
			Fail(w, http.StatusRequestEntityTooLarge, "数据过大")
			return
		}
		Fail(w, http.StatusBadRequest, "请求格式不正确")
		return
	}

	payload := body.Payload
	// payload 必须是**对象**，不能是数组、字符串或 null：
	// 客户端与影子表都按对象结构取值，存进去一个数组会让下游一堆地方炸。
	if len(payload) == 0 || !isJSONObject(payload) {
		Fail(w, http.StatusBadRequest, "payload 必须是对象")
		return
	}

	if len(payload) > s.cfg.MaxPayloadBytes {
		Fail(w, http.StatusRequestEntityTooLarge, "数据过大")
		return
	}

	// 结构校验。App 端（utils/validate.js）已经净过输入，但那层是体验 ——
	// 改包、抓包重放、curl 直打都能绕过，而这是**唯一的数据写入通道**：
	// 存进来什么，库里就一直是什么，影子表和后台看板也都按它取值。
	//
	// 只挡明显非法的形状与数量，不认识的新字段一律放过，
	// 这样客户端加字段不需要服务端跟着发版（详见 snapshot 包注释）。
	if err := snapshot.Validate(payload, snapshot.DefaultLimits); err != nil {
		Fail(w, http.StatusBadRequest, err.Error())
		return
	}

	snap, err := s.store.PutState(r.Context(), uid, payload)
	if err != nil {
		FailBiz(w, err, "保存失败，请稍后重试")
		return
	}

	// 影子双写：把快照解析后另存关系表，供后台按用户/标的/日期查询。
	// 它不阻塞本次保存 —— 派生数据失败不该让用户的保存失败，
	// 补一遍 backfill 就能追回来。
	s.shadow.QueueSync(uid, payload, snap.Rev, len(payload))

	OKFields(w, map[string]interface{}{
		"uid":       uid,
		"rev":       snap.Rev,
		"updatedAt": snap.UpdatedAt,
		"bytes":     len(payload),
	})
}

// handleDeleteState 清空快照（保留账号）。
func (s *Server) handleDeleteState(w http.ResponseWriter, r *http.Request) {
	uid, _, ok := s.currentUser(w, r)
	if !ok {
		return
	}

	if err := s.store.DeleteState(r.Context(), uid); err != nil {
		FailBiz(w, err, "删除失败，请稍后重试")
		return
	}
	if err := s.shadow.RemoveUser(r.Context(), uid); err != nil {
		log.Printf("[shadow] 清理派生数据失败 uid=%s: %v", uid, err)
	}

	OKFields(w, map[string]interface{}{"uid": uid})
}

// isJSONObject 判断一段 JSON 是不是对象（首字符为 '{'）。
//
// 不解析整段内容，只做形状判断：payload 可能有 5MB，
// 为了校验形状而完整解析一遍是纯粹的浪费。
func isJSONObject(raw []byte) bool {
	for _, b := range raw {
		switch b {
		case ' ', '\t', '\r', '\n':
			continue
		case '{':
			return true
		default:
			return false
		}
	}
	return false
}

package api

import (
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
)

// withPublicLimit 给公开接口套上按 IP 的限流。
//
// 只用在行情那几条上。它们是全站唯一「别人能随手把我们打到不可用」的地方：
// 不校验登录，背后又是按**出口 IP** 限流的免费上游（东财）。
// 一旦被刷到上游限流，所有用户一起拿不到行情 —— 挡的不是资源，是可用性。
//
// 认证过的接口不放这一层：那些有 token 兜着，出格的人是可追溯的，
// 而且多一层限流就多一次可能的误伤。
func (s *Server) withPublicLimit(next http.HandlerFunc) http.HandlerFunc {
	if s.pubLimit == nil {
		return next // 配置里关掉了（PUBLIC_RATE_LIMIT=0）
	}
	return func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		if !s.pubLimit.Allow(ip) {
			// 被限流是**必须能看见**的事件：命中频繁说明要么额度定小了在误伤
			// 正常用户，要么真有人在刷（那就该再收紧）。两种情况都得先知道。
			log.Printf("[limit] 公开接口限流命中 ip=%s %s %s", ip, r.Method, r.URL.Path)
			Fail(w, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
			return
		}
		next(w, r)
	}
}

// currentUser 从 Authorization: Bearer <token> 解析出当前账号。
//
// 与旧版的差别：**只认 token**。
// 旧版还认云托管注入的 X-WX-OPENID（小程序身份），
// 现在没有小程序了，那条分支删掉 —— 少一条身份来源，就少一处能绕过鉴权的入口。
//
// ok=false 表示已经写过响应了（401 或 500），调用方直接 return 即可。
// 这种「helper 负责写响应」的写法在 Go 里不算最地道，但它把每个 handler
// 开头那五行样板收敛成了一次调用，而且不会出现「忘了 return」的漏网。
func (s *Server) currentUser(w http.ResponseWriter, r *http.Request) (uid string, token string, ok bool) {
	token = bearerToken(r.Header.Get("Authorization"))
	if token == "" {
		Unauthorized(w)
		return "", "", false
	}

	uid, found, err := s.store.VerifyToken(r.Context(), token)
	if err != nil {
		log.Printf("[auth] 校验凭证失败: %v", err)
		Fail(w, http.StatusInternalServerError, "服务暂时不可用，请稍后重试")
		return "", "", false
	}
	if !found {
		Unauthorized(w)
		return "", "", false
	}

	return uid, token, true
}

// bearerToken 拆出 Bearer 后面那串。
// 大小写不敏感 —— 各家 HTTP 客户端对 "Bearer" 的大小写处理并不统一。
func bearerToken(header string) string {
	header = strings.TrimSpace(header)
	if header == "" {
		return ""
	}

	const prefix = "bearer "
	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}

// deviceOf 取一个短设备标识入库，用于「哪台设备登录了这个账号」。
// 只截前 64 字符：User-Agent 可以很长，而这一列只是为了排查，不需要完整内容。
func deviceOf(r *http.Request) string {
	ua := strings.TrimSpace(r.Header.Get("User-Agent"))
	if len(ua) > 64 {
		ua = ua[:64]
	}
	return ua
}

// withCommon 套上所有路由都需要的三件事：panic 兜底、访问日志、CORS。
func withCommon(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()

		// panic 兜底必须放在最外层：Go 的 http server 在 handler panic 时
		// 只会断开连接（客户端看到「网络异常」），日志里则是一大段 goroutine 栈。
		// 包一层之后用户拿到的是标准 JSON，我们拿到的是可读的一行日志。
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[panic] %s %s: %v", r.Method, r.URL.Path, rec)
				// 响应可能已经写了一部分，这时再写头会报 superfluous WriteHeader，
				// 但 Net/http 会自己忽略，用户至少能拿到完整的那半截。
				Fail(w, http.StatusInternalServerError, "服务内部错误")
			}
		}()

		// CORS：为将来的 Web 端留的。
		// 允许任意来源是安全的 —— 这套接口只用 Authorization 头鉴权，
		// 不依赖 Cookie，所以不存在「恶意站点借用户浏览器里的凭证打接口」的问题。
		// 千万不要顺手加上 Allow-Credentials: true，那会让这条推理失效。
		origin := r.Header.Get("Origin")
		if origin != "" {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", "*")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			h.Set("Access-Control-Max-Age", "86400")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)

		// 只记慢请求与失败请求：正常请求每个都记会把日志淹掉，
		// 而这套接口的成功路径本身没有排查价值。
		if d := time.Since(start); d > 2*time.Second {
			log.Printf("[slow] %s %s %v", r.Method, r.URL.Path, d)
		}
	})
}

// isBodyTooLarge 判断错误是不是「请求体超过上限」。
// 这需要单独识别，是为了回一个明确的 413 而不是含糊的 500 ——
// 客户端那边超限的表现只是「一直保存失败一直重试」，最难查。
func isBodyTooLarge(err error) bool {
	var maxErr *http.MaxBytesError
	return errors.As(err, &maxErr)
}

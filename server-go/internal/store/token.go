package store

import (
	"context"
	"database/sql"
	"errors"

	"xiji/api/internal/auth"
)

/*
登录凭证与登录失败限流。

两处都刻意把「时间」交给数据库（NOW() / TIMESTAMPDIFF / DATE_SUB）而不是 Go：
容器时钟与数据库时钟不一致时，用应用时间算出来的窗口是错的，
而这种错非常隐蔽 —— 表现只是「限流偶尔不生效」或「明明刚失败却说可以重试」。
*/

// DefaultTokenTTLDays 是凭证有效期的默认值，与旧版一致：30 天。
// 实际生效的值由配置 TOKEN_TTL_DAYS 注入到 Store.tokenTTLDays。
const DefaultTokenTTLDays = 30

// 登录失败限流：15 分钟窗口内允许 10 次失败。
const (
	MaxFails      = 10
	FailWindowMin = 15
)

// IssuedToken 是签发结果。
type IssuedToken struct {
	Token         string // 原始 token，只在这一刻返回给客户端
	ExpiresInDays int
}

// IssueToken 签发登录凭证。
//
// 入库的是 sha256 哈希（见 auth.HashToken），所以这里返回的明文 token
// 一旦响应发出去，服务端就再也拿不回来了 —— 这是有意的。
func (s *Store) IssueToken(ctx context.Context, uid, device string) (*IssuedToken, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	token, err := auth.NewToken()
	if err != nil {
		return nil, err
	}

	// 顺手清掉这个账号已过期的凭证。不清也能跑（校验时会判过期），
	// 但登录是个天然的时间点，在这里清理不会额外增加请求。
	if _, err := pool.ExecContext(ctx,
		`DELETE FROM login_token WHERE uid = ? AND expires_at < NOW()`, uid,
	); err != nil {
		return nil, err
	}

	if len(device) > 64 {
		device = device[:64]
	}

	_, err = pool.ExecContext(ctx,
		`INSERT INTO login_token (token_hash, uid, device, created_at, expires_at, last_used_at)
		 VALUES (?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY), NOW())`,
		auth.HashToken(token), uid, device, s.tokenTTLDays,
	)
	if err != nil {
		return nil, err
	}

	return &IssuedToken{Token: token, ExpiresInDays: s.tokenTTLDays}, nil
}

// VerifyToken 校验凭证，返回 uid。
//
// 第二个返回值区分「凭证不存在/已过期」（false）与「查询出错」——
// 两者对用户都是 401，但对日志的意义完全不同。
func (s *Store) VerifyToken(ctx context.Context, token string) (string, bool, error) {
	if !auth.LooksLikeToken(token) {
		return "", false, nil
	}

	pool, err := s.db.Pool(ctx)
	if err != nil {
		return "", false, err
	}

	var (
		uid    string
		leftHi sql.NullInt64
	)
	err = pool.QueryRowContext(ctx,
		`SELECT uid, TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS left_sec
		   FROM login_token WHERE token_hash = ? LIMIT 1`,
		auth.HashToken(token),
	).Scan(&uid, &leftHi)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}

	if !leftHi.Valid || leftHi.Int64 <= 0 {
		// 过期即删：留着只会让这张表随用户数一直长
		_, _ = pool.ExecContext(ctx, `DELETE FROM login_token WHERE token_hash = ?`, auth.HashToken(token))
		return "", false, nil
	}

	// last_used_at 按小时粒度更新：每个请求都写一次会让这个只用于排查的字段
	// 变成整库最大的写热点。
	_, _ = pool.ExecContext(ctx,
		`UPDATE login_token SET last_used_at = NOW()
		  WHERE token_hash = ? AND (last_used_at IS NULL OR last_used_at < DATE_SUB(NOW(), INTERVAL 1 HOUR))`,
		auth.HashToken(token),
	)

	return uid, true, nil
}

// Logout 撤销单个凭证。
func (s *Store) Logout(ctx context.Context, token string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}
	_, err = pool.ExecContext(ctx, `DELETE FROM login_token WHERE token_hash = ?`, auth.HashToken(token))
	return err
}

// DropTokens 踢掉某账号的全部登录态（改密码、封禁时用）。
func (s *Store) DropTokens(ctx context.Context, uid string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}
	_, err = pool.ExecContext(ctx, `DELETE FROM login_token WHERE uid = ?`, uid)
	return err
}

/* ---------------- 登录失败限流 ---------------- */

// AttemptState 告诉调用方现在能不能试密码。
// LeftMin 是「还要等多少分钟」，仅在被锁时才有意义。
type AttemptState struct {
	Blocked bool
	LeftMin int
}

func (s *Store) AttemptState(ctx context.Context, username string) (*AttemptState, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	var (
		failCount int
		ageSec    sql.NullInt64
	)
	err = pool.QueryRowContext(ctx,
		`SELECT fail_count, TIMESTAMPDIFF(SECOND, window_start, NOW()) AS age_sec
		   FROM login_attempt WHERE username = ? LIMIT 1`,
		username,
	).Scan(&failCount, &ageSec)
	if errors.Is(err, sql.ErrNoRows) {
		return &AttemptState{}, nil
	}
	if err != nil {
		return nil, err
	}

	windowSec := int64(FailWindowMin * 60)
	age := ageSec.Int64

	// 窗口已过，或失败次数还没到上限 → 放行
	if age > windowSec || failCount < MaxFails {
		return &AttemptState{}, nil
	}

	left := (windowSec - age + 59) / 60 // 向上取整到分钟
	if left < 1 {
		left = 1
	}
	return &AttemptState{Blocked: true, LeftMin: int(left)}, nil
}

// NoteFail 记一次失败。
//
// 窗口是否过期完全由 SQL 判断（DATE_SUB(NOW(), INTERVAL ? MINUTE)），
// 这样「重置窗口」和「累加次数」在一个原子语句里完成，
// 不会出现两个并发请求各自看到「窗口已过」从而都把计数清零的情况。
func (s *Store) NoteFail(ctx context.Context, username, ip string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	if len(ip) > 64 {
		ip = ip[:64]
	}

	_, err = pool.ExecContext(ctx,
		`INSERT INTO login_attempt (username, fail_count, window_start, last_ip)
		 VALUES (?, 1, NOW(), ?)
		 ON DUPLICATE KEY UPDATE
		   fail_count = IF(window_start < DATE_SUB(NOW(), INTERVAL ? MINUTE), 1, fail_count + 1),
		   window_start = IF(window_start < DATE_SUB(NOW(), INTERVAL ? MINUTE), NOW(), window_start),
		   last_ip = VALUES(last_ip)`,
		username, ip, FailWindowMin, FailWindowMin,
	)
	return err
}

// ClearFails 登录成功后清空计数。
func (s *Store) ClearFails(ctx context.Context, username string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}
	_, err = pool.ExecContext(ctx, `DELETE FROM login_attempt WHERE username = ?`, username)
	return err
}

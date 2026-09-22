// Package store 是唯一碰数据库的地方。
//
// 分层约定：这一层只认 SQL 与领域对象，不认 HTTP（不出现 http.Request/ResponseWriter），
// 也不做面向用户的措辞包装（那是 api 层的事，通过 apperr.Biz 传递）。
// 这样这一层的函数可以直接在测试里调用。
package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"xiji/api/internal/apperr"
	"xiji/api/internal/auth"
	"xiji/api/internal/db"
)

// Store 持有连接池，是所有仓储方法的接收者。
//
// 时区是显式持有的，不是用 time.Local：会员到期判定依赖「本地自然日」，
// 把它做成显式依赖，测试里才能把时间换到固定时区去验证月底收敛这类边界。
type Store struct {
	db  *db.DB
	loc *time.Location

	// tokenTTLDays 凭证有效期，由配置（TOKEN_TTL_DAYS）注入。
	// 不做成包级常量，是因为它会随运营策略调整 ——
	// 写死的话改环境变量不会生效，而「改了没反应」这类问题最费时间。
	tokenTTLDays int
}

func New(d *db.DB, loc *time.Location, tokenTTLDays int) *Store {
	if tokenTTLDays <= 0 {
		tokenTTLDays = DefaultTokenTTLDays
	}
	return &Store{db: d, loc: loc, tokenTTLDays: tokenTTLDays}
}

// Account 是账号在业务层的表示（不含密码哈希）。
type Account struct {
	UID         string
	Username    string
	Phone       string
	Email       string
	NickName    string
	CreatedAt   string
	LastLoginAt string
}

/* ---------------- 注册 ---------------- */

// Register 创建账号。
//
// 用户名唯一冲突会返回业务错误（用户能自己换个名字），
// 其余错误原样上抛，由 api 层按服务端故障处理。
func (s *Store) Register(ctx context.Context, username, password string) (*Account, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	uid, err := auth.NewUID()
	if err != nil {
		return nil, err
	}
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, err
	}

	_, err = pool.ExecContext(ctx,
		`INSERT INTO account (uid, username, password_hash, nick_name, status, created_at, updated_at)
		 VALUES (?, ?, ?, '', 1, NOW(), NOW())`,
		uid, username, hash,
	)
	if err != nil {
		if db.IsDuplicate(err) {
			// 唯一键冲突按用户名重复处理即可：uid 是 96 位随机数，
			// 重复的概率远小于「用户想用的名字已经被人占了」。
			return nil, apperr.New("这个用户名已经被注册了，换一个试试")
		}
		return nil, err
	}

	return &Account{UID: uid, Username: username}, nil
}

// LoginByPassword 校验用户名密码。
//
// 返回 (nil, nil) 表示「账号不存在或密码不对」—— 两者不区分，
// 否则这个接口就成了枚举用户名的工具。
func (s *Store) LoginByPassword(ctx context.Context, username, password string) (*Account, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	var (
		uid, uname string
		hash       sql.NullString
		status     int
	)
	err = pool.QueryRowContext(ctx,
		`SELECT uid, username, password_hash, status FROM account WHERE username = ? LIMIT 1`,
		username,
	).Scan(&uid, &uname, &hash, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	// status=0 是被后台停用的账号：连密码都不用比，直接按「登录失败」处理。
	// 单独报「账号已停用」会暴露这个账号存在。
	if status != 1 || !hash.Valid || !auth.VerifyPassword(password, hash.String) {
		return nil, nil
	}

	if _, err := pool.ExecContext(ctx,
		`UPDATE account SET last_login_at = NOW() WHERE uid = ?`, uid,
	); err != nil {
		// 登录本身成功了，只是活跃时间没记上；不影响用户，记日志即可
		return &Account{UID: uid, Username: uname}, nil
	}

	return &Account{UID: uid, Username: uname}, nil
}

/* ---------------- 资料 ---------------- */

// Profile 读账号资料。查不到返回 nil。
func (s *Store) Profile(ctx context.Context, uid string) (*Account, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	var (
		acc                Account
		phone, email, nick sql.NullString
		created            string
		lastLogin          sql.NullString
	)
	err = pool.QueryRowContext(ctx,
		`SELECT uid, username, phone, email, nick_name, created_at, last_login_at
		   FROM account WHERE uid = ? LIMIT 1`,
		uid,
	).Scan(&acc.UID, &acc.Username, &phone, &email, &nick, &created, &lastLogin)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	acc.Phone = phone.String
	acc.Email = email.String
	acc.NickName = nick.String
	acc.CreatedAt = created
	acc.LastLoginAt = lastLogin.String
	return &acc, nil
}

// ResetPassword 后台重置密码。返回 false 表示没有这个用户名。
func (s *Store) ResetPassword(ctx context.Context, username, password string) (string, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return "", err
	}

	var uid string
	err = pool.QueryRowContext(ctx,
		`SELECT uid FROM account WHERE username = ? LIMIT 1`, username,
	).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}

	hash, err := auth.HashPassword(password)
	if err != nil {
		return "", err
	}

	if _, err := pool.ExecContext(ctx,
		`UPDATE account SET password_hash = ?, updated_at = NOW() WHERE uid = ?`,
		hash, uid,
	); err != nil {
		return "", err
	}

	return uid, nil
}

// DeleteAccount 删除账号行。
//
// 注意它只删 account 这一张表：业务数据（快照、影子表）由调用方一并清理 ——
// 注销是「删除我的全部数据」，漏掉任何一张表都是隐私政策上的违约，
// 所以清理动作集中写在 api 层那一个函数里，便于一眼核对有没有漏。
//
// 返回被删掉的 username（用于清 login_attempt）。
func (s *Store) DeleteAccount(ctx context.Context, uid string) (string, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return "", err
	}

	var username sql.NullString
	_ = pool.QueryRowContext(ctx, `SELECT username FROM account WHERE uid = ? LIMIT 1`, uid).Scan(&username)

	if _, err := pool.ExecContext(ctx, `DELETE FROM login_token WHERE uid = ?`, uid); err != nil {
		return "", err
	}
	if username.Valid && username.String != "" {
		if _, err := pool.ExecContext(ctx, `DELETE FROM login_attempt WHERE username = ?`, username.String); err != nil {
			return "", err
		}
	}
	if _, err := pool.ExecContext(ctx, `DELETE FROM account WHERE uid = ?`, uid); err != nil {
		return "", err
	}

	return username.String, nil
}

// BindPhone 把手机号绑到账号上。
//
// 手机号是唯一键，所以存在「这个号已经属于另一个账号」的情况。
// 旧版的处理是认手机号那条账号，并把当前账号的微信身份挂过去 ——
// 那是为「微信登录 + App 登录用同一手机号」设计的。App 专用后端里
// 已经没有第二套身份了，所以这里直接返回冲突，让用户先解绑或换个号，
// 比悄悄把两个账号合并掉更容易解释。
func (s *Store) BindPhone(ctx context.Context, uid, phone string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	var owner string
	err = pool.QueryRowContext(ctx,
		`SELECT uid FROM account WHERE phone = ? LIMIT 1`, phone,
	).Scan(&owner)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if owner != "" && owner != uid {
		return apperr.New("这个手机号已经绑定到其他账号了")
	}

	_, err = pool.ExecContext(ctx,
		`UPDATE account SET phone = ?, updated_at = NOW() WHERE uid = ?`,
		phone, uid,
	)
	return err
}

// CountAccounts 给后台总览用。
func (s *Store) CountAccounts(ctx context.Context) (int, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return 0, err
	}
	var n int
	err = pool.QueryRowContext(ctx, `SELECT COUNT(*) FROM account`).Scan(&n)
	return n, err
}

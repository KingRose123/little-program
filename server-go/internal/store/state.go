package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

/*
用户数据快照。

这一层的核心取向：**payload 原样进、原样出**。

服务端不理解快照内容（settings / profile / holdings / records 都是客户端的领域），
所以这里既不解析也不重新序列化，直接以 []byte 透传，API 层再用 json.RawMessage
把它原封不动嵌进响应。

这么做的两个好处：
  1) 保真 —— 客户端的字段顺序、数字精度、未知的新字段都不会被服务端「顺手规整」掉，
     于是「App 出新版本加了字段」不需要后端跟着发版；
  2) 省开销 —— 5MB 的 JSON 解析+再序列化是可观的 CPU 与内存，
     而这一层本来一个字都不需要改。
*/

// Snapshot 是一份用户数据。
type Snapshot struct {
	UID       string
	Rev       int
	Payload   []byte // nil 表示云端还没有这份数据（新用户）
	UpdatedAt string
}

// GetState 读快照。查不到返回 (nil, nil)，由调用方决定怎么表达「新用户」。
func (s *Store) GetState(ctx context.Context, uid string) (*Snapshot, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	var (
		payload   string
		rev       int
		updatedAt string
	)
	err = pool.QueryRowContext(ctx,
		`SELECT payload, rev, updated_at FROM user_state WHERE uid = ? LIMIT 1`,
		uid,
	).Scan(&payload, &rev, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	return &Snapshot{
		UID:       uid,
		Rev:       rev,
		Payload:   []byte(payload),
		UpdatedAt: updatedAt,
	}, nil
}

// PutState 整份覆盖写入，并返回新的版本号。
//
// 语义是「最后一次写入为准」：没有乐观锁、不比对 rev。
// 这是刻意的 —— 客户端那边已经把冲突处理成「本地有未推送的改动就以本地为准」，
// 服务端再加一层 CAS 只会让「离线改了一堆东西、回来同步」这个主场景变复杂，
// 而那种场景下用户要的就是「我本地的这份算数」。
func (s *Store) PutState(ctx context.Context, uid string, payload []byte) (*Snapshot, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	size := len(payload)

	if _, err := pool.ExecContext(ctx,
		`INSERT INTO user_state (uid, payload, rev, payload_size, updated_at)
		 VALUES (?, ?, 1, ?, NOW())
		 ON DUPLICATE KEY UPDATE
		   payload = VALUES(payload),
		   rev = rev + 1,
		   payload_size = VALUES(payload_size),
		   updated_at = NOW()`,
		uid, string(payload), size,
	); err != nil {
		return nil, err
	}

	var (
		rev       int
		updatedAt string
	)
	if err := pool.QueryRowContext(ctx,
		`SELECT rev, updated_at FROM user_state WHERE uid = ? LIMIT 1`, uid,
	).Scan(&rev, &updatedAt); err != nil {
		return nil, err
	}

	return &Snapshot{UID: uid, Rev: rev, Payload: payload, UpdatedAt: updatedAt}, nil
}

// DeleteState 删掉快照。账号注销时调用。
func (s *Store) DeleteState(ctx context.Context, uid string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}
	_, err = pool.ExecContext(ctx, `DELETE FROM user_state WHERE uid = ?`, uid)
	return err
}

// SnapshotPage 是 backfill 用的一页数据。
type SnapshotPage struct {
	UID     string
	Payload []byte
	Rev     int
}

// ListSnapshots 分页读快照，供影子表回填使用。
//
// limit/offset 由调用方校验成整数后传进来（这里再兜一次底），
// 因为 MySQL 的 LIMIT 不接受占位符 —— 老版本驱动会直接报错，
// 所以这两个值只能拼进 SQL，必须确保它们不是用户输入。
func (s *Store) ListSnapshots(ctx context.Context, limit, offset int) ([]SnapshotPage, error) {
	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}

	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	// LIMIT / OFFSET 用拼接而不是占位符：部分 MySQL 版本配某些驱动时
	// 不接受预处理占位符出现在这里，会直接报语法错。
	// 拼接是安全的 —— 上面两个值已经被夹进合法区间，不是用户输入。
	rows, err := pool.QueryContext(ctx, fmt.Sprintf(
		`SELECT uid, payload, rev FROM user_state ORDER BY updated_at DESC LIMIT %d OFFSET %d`,
		limit, offset,
	))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []SnapshotPage
	for rows.Next() {
		var p SnapshotPage
		var payload string
		if err := rows.Scan(&p.UID, &payload, &p.Rev); err != nil {
			return nil, err
		}
		p.Payload = []byte(payload)
		out = append(out, p)
	}
	return out, rows.Err()
}

// Package shadow 维护「影子表」：把 5MB 的 JSON 快照拆成关系行，
// 让后台能用人话查数据。
//
// 为什么需要它：用户数据的主存是一整份 JSON（user_state.payload），
// 这个设计对同步非常合适 —— 客户端推上来一份、我们原样存一份，没有冲突合并。
// 但它没法回答「谁持有 600398」「最近 7 天活跃多少人」「谁快把上限撑爆了」，
// 而这些恰好是运营每天要看的东西。
//
// 三条纪律（沿用旧版，它们是被坑出来的）：
//  1. **不阻塞、不抛错**：影子表是派生数据，双写失败只记日志。
//     让用户的保存因为「后台统计没记上」而失败，是完全不可接受的取舍。
//  2. **不只要增改，还要删**：用户删掉一只持仓后，影子表里的行也得消失。
//     做法是每轮带一个自增的 batch_id，收尾时删掉「落后于本轮」的行。
//     用批次号而不是时间戳，是因为容器时钟与数据库时钟可能不一致 ——
//     用时间戳会出现「刚写的行被当成旧的删掉」。
//  3. **同一个用户串行**：两个批次并发跑，会互相把对方写的行当成「已删除」清掉。
package shadow

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"xiji/api/internal/db"
)

// Service 是影子表的维护者。
type Service struct {
	db *db.DB

	// batchSeq 是进程内严格递增的批次号。
	// 起点取当前毫秒时间戳，这样重启后也不会与旧批次撞号。
	batchSeq int64

	// locks 保证「同一个 uid 的多轮同步」串行执行。
	// 用带引用计数的 map 而不是一把全局大锁：不同用户之间可以并行，
	// 而这个 map 的条目在没人用时会被删掉，不会随用户数一直长。
	mu    sync.Mutex
	locks map[string]*uidLock

	// syncSem 限制同时在跑的同步任务数。
	// 写入是每个用户每次改数据都会触发的，不限制的话
	// 一次批量导入就能起出成百上千个 goroutine。
	syncSem chan struct{}
}

type uidLock struct {
	mu   sync.Mutex
	refs int
}

func New(d *db.DB) *Service {
	return &Service{
		db:      d,
		batchSeq: nowMillis(),
		locks:   make(map[string]*uidLock),
		syncSem: make(chan struct{}, 8),
	}
}

// 单条 SQL 最多拼多少行。太大容易撞 max_allowed_packet，
// 太小则一条持仓多的快照要发很多次。
const rowsPerStmt = 200

// 快照超过这个体积就在日志里点名 —— 上限是 5MB，
// 到 800KB 就该关注是谁了（通常是记录攒了太多）。
const sizeWarn = 800 * 1024

func (s *Service) nextBatch() int64 {
	return atomic.AddInt64(&s.batchSeq, 1)
}

/* ---------------- 活跃记录 ---------------- */

// Touch 记一次活跃。
//
// 节流放在 SQL 里：只有距上次更新超过 10 分钟才真正写。
// 读快照是高频动作，每次读都写库会让这一列变成整库最大的写热点。
func (s *Service) Touch(ctx context.Context, uid string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	_, err = pool.ExecContext(ctx,
		`INSERT INTO users (uid, created_at, last_seen_at)
		 VALUES (?, NOW(), NOW())
		 ON DUPLICATE KEY UPDATE
		   last_seen_at = IF(last_seen_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE), NOW(), last_seen_at)`,
		uid,
	)
	return err
}

// SavePhone 写入手机号。
//
// 与 Sync 里那条规则不同：这里是**无条件覆盖** ——
// 手机号是经过验证的权威值（来自用户主动绑定），
// 而 Sync 里那份来自快照的 profile.phone 可能只是用户随手填的，
// 所以那边是「空值不覆盖」。
func (s *Service) SavePhone(ctx context.Context, uid, phone string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	_, err = pool.ExecContext(ctx,
		`INSERT INTO users (uid, phone, created_at, last_seen_at)
		 VALUES (?, ?, NOW(), NOW())
		 ON DUPLICATE KEY UPDATE phone = VALUES(phone)`,
		uid, text(phone, 32),
	)
	return err
}

/* ---------------- 异步双写 ---------------- */

// QueueSync 把一次同步排进后台，立刻返回。
//
// 不返回任何结果：调用方（PUT /api/state）不该等它，也不该因为它的失败
// 而影响用户。出问题只体现在后台看不到数据 —— 那时候跑一次 backfill 就补回来了。
func (s *Service) QueueSync(uid string, snapshot []byte, rev int, byteSize int) {
	go func() {
		s.syncSem <- struct{}{}
		defer func() { <-s.syncSem }()

		unlock := s.lockUID(uid)
		defer unlock()

		if err := s.Sync(context.Background(), uid, snapshot, rev, byteSize); err != nil {
			log.Printf("[shadow] 同步失败 uid=%s: %v", uid, err)
		}
	}()
}

// lockUID 取得某个 uid 的独占权，返回释放函数。
func (s *Service) lockUID(uid string) func() {
	s.mu.Lock()
	l := s.locks[uid]
	if l == nil {
		l = &uidLock{}
		s.locks[uid] = l
	}
	l.refs++
	s.mu.Unlock()

	l.mu.Lock()

	return func() {
		l.mu.Unlock()

		s.mu.Lock()
		l.refs--
		if l.refs == 0 {
			delete(s.locks, uid)
		}
		s.mu.Unlock()
	}
}

/* ---------------- 同步主体 ---------------- */

// Sync 把一份快照同步进影子表。它自己不做串行控制，调用方负责。
func (s *Service) Sync(ctx context.Context, uid string, snapshot []byte, rev int, byteSize int) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	p, err := parse(snapshot)
	if err != nil {
		// 快照解不开（比如客户端推了非法结构）：记日志但**不报错** ——
		// 用户的保存已经成功了，这里报错解决不了任何问题。
		log.Printf("[shadow] 快照解析失败 uid=%s: %v", uid, err)
		return nil
	}

	batchID := s.nextBatch()

	// 会员档位的权威值在 membership 表，不在快照里。
	// 客户端那份只是缓存，用它统计会得出「用户自己说自己是 Pro」这种笑话。
	tier := "free"
	var tierExpire interface{}
	var (
		mtier    sql.NullString
		mexpires sql.NullString
	)
	if err := pool.QueryRowContext(ctx,
		`SELECT tier, expires_at FROM membership WHERE uid = ? LIMIT 1`, uid,
	).Scan(&mtier, &mexpires); err == nil && mtier.String != "" {
		tier = mtier.String
		if mexpires.String != "" {
			tierExpire = mexpires.String
		}
	}

	if _, err := pool.ExecContext(ctx,
		`INSERT INTO users
		   (uid, nick_name, avatar, phone, tier, tier_expire,
		    holdings_count, accounts_count, records_count, expenses_count,
		    payload_size, rev, created_at, last_seen_at, last_sync_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), NOW())
		 ON DUPLICATE KEY UPDATE
		   nick_name = VALUES(nick_name),
		   avatar = VALUES(avatar),
		   phone = IF(VALUES(phone) <> '', VALUES(phone), phone),
		   tier = VALUES(tier),
		   tier_expire = VALUES(tier_expire),
		   holdings_count = VALUES(holdings_count),
		   accounts_count = VALUES(accounts_count),
		   records_count = VALUES(records_count),
		   expenses_count = VALUES(expenses_count),
		   payload_size = VALUES(payload_size),
		   rev = VALUES(rev),
		   last_seen_at = NOW(),
		   last_sync_at = NOW()`,
		uid, p.Profile.NickName, p.Profile.Avatar, p.Profile.Phone,
		tier, tierExpire,
		p.Profile.Holdings, p.Profile.Accounts, p.Profile.Records, p.Profile.Expenses,
		byteSize, rev,
	); err != nil {
		return err
	}

	if err := s.upsertHoldings(ctx, uid, p.Holdings, batchID); err != nil {
		return err
	}
	if err := s.upsertRecords(ctx, uid, p.Records, batchID); err != nil {
		return err
	}

	// 收尾：本轮没写到的行，就是用户已经删掉的持仓 / 记录
	if _, err := pool.ExecContext(ctx,
		`DELETE FROM holdings WHERE uid = ? AND batch_id < ?`, uid, batchID,
	); err != nil {
		return err
	}
	if _, err := pool.ExecContext(ctx,
		`DELETE FROM holding_records WHERE uid = ? AND batch_id < ?`, uid, batchID,
	); err != nil {
		return err
	}

	if byteSize > sizeWarn {
		log.Printf("[shadow] 快照偏大 %dKB uid=%s（持仓 %d 只 / 记录 %d 条）",
			byteSize/1024, uid, p.Profile.Holdings, p.Profile.Records)
	}

	return nil
}

func (s *Service) upsertHoldings(ctx context.Context, uid string, rows []holdingRow, batchID int64) error {
	if len(rows) == 0 {
		return nil
	}
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	for start := 0; start < len(rows); start += rowsPerStmt {
		end := start + rowsPerStmt
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]

		var (
			sb   strings.Builder
			args = make([]interface{}, 0, len(chunk)*13)
		)
		sb.WriteString(`INSERT INTO holdings
			(uid, holding_id, code, market, name, shares, cost, dps, price, tax_rate, buy_date, received, batch_id, updated_at)
			VALUES `)
		for i, r := range chunk {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())")
			args = append(args,
				uid, r.ID, r.Code, r.Market, r.Name,
				r.Shares, r.Cost, r.Dps, r.Price, r.TaxRate, r.BuyDate, r.Received, batchID,
			)
		}
		sb.WriteString(` ON DUPLICATE KEY UPDATE
			code = VALUES(code), market = VALUES(market), name = VALUES(name),
			shares = VALUES(shares), cost = VALUES(cost), dps = VALUES(dps), price = VALUES(price),
			tax_rate = VALUES(tax_rate), buy_date = VALUES(buy_date), received = VALUES(received),
			batch_id = VALUES(batch_id), updated_at = NOW()`)

		if _, err := pool.ExecContext(ctx, sb.String(), args...); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) upsertRecords(ctx context.Context, uid string, rows []recordRow, batchID int64) error {
	if len(rows) == 0 {
		return nil
	}
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	for start := 0; start < len(rows); start += rowsPerStmt {
		end := start + rowsPerStmt
		if end > len(rows) {
			end = len(rows)
		}
		chunk := rows[start:end]

		var (
			sb   strings.Builder
			args = make([]interface{}, 0, len(chunk)*12)
		)
		sb.WriteString(`INSERT INTO holding_records
			(uid, record_id, holding_id, kind, date, type, shares, price, fee, amount, note, batch_id, updated_at)
			VALUES `)
		for i, r := range chunk {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,NOW())")
			args = append(args,
				uid, r.ID, r.HoldingID, r.Kind, r.Date, r.Type,
				r.Shares, r.Price, r.Fee, r.Amount, r.Note, batchID,
			)
		}
		sb.WriteString(` ON DUPLICATE KEY UPDATE
			holding_id = VALUES(holding_id), kind = VALUES(kind), date = VALUES(date),
			type = VALUES(type), shares = VALUES(shares), price = VALUES(price),
			fee = VALUES(fee), amount = VALUES(amount), note = VALUES(note),
			batch_id = VALUES(batch_id), updated_at = NOW()`)

		if _, err := pool.ExecContext(ctx, sb.String(), args...); err != nil {
			return err
		}
	}
	return nil
}

/* ---------------- 删除 ---------------- */

// RemoveUser 清掉某个用户的全部派生数据。
// 账号注销时调用 —— 影子表虽然是派生数据，但同样是这个人的信息，不能留。
func (s *Service) RemoveUser(ctx context.Context, uid string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}

	for _, stmt := range []string{
		`DELETE FROM holdings WHERE uid = ?`,
		`DELETE FROM holding_records WHERE uid = ?`,
		`DELETE FROM users WHERE uid = ?`,
	} {
		if _, err := pool.ExecContext(ctx, stmt, uid); err != nil {
			return err
		}
	}
	return nil
}

/* ---------------- 回填 ---------------- */

// BackfillResult 是回填结果。
type BackfillResult struct {
	Scanned int `json:"scanned"`
	Synced  int `json:"synced"`
	Failed  int `json:"failed"`
	Limit   int `json:"limit"`
	Offset  int `json:"offset"`
}

// Backfill 把历史快照补进影子表。
//
// 用途：把影子表这个功能部署上去时，已有的用户数据需要在库里补一份，
// 否则后台只能看到「新注册的人」。也可以在任何一次双写故障之后拿来兜底。
func (s *Service) Backfill(ctx context.Context, limit, offset int) (*BackfillResult, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	if limit <= 0 || limit > 1000 {
		limit = 200
	}
	if offset < 0 {
		offset = 0
	}

	// 同上：LIMIT / OFFSET 用拼接，两个值都已夹进合法区间
	rows, err := pool.QueryContext(ctx, fmt.Sprintf(
		`SELECT uid, payload, rev FROM user_state ORDER BY updated_at DESC LIMIT %d OFFSET %d`,
		limit, offset,
	))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	res := &BackfillResult{Limit: limit, Offset: offset}

	for rows.Next() {
		var (
			uid     string
			payload string
			rev     int
		)
		if err := rows.Scan(&uid, &payload, &rev); err != nil {
			return nil, err
		}
		res.Scanned++

		if err := s.Sync(ctx, uid, []byte(payload), rev, len(payload)); err != nil {
			// 单个用户失败不中断整批：一个坏快照不该让回填整个停住
			res.Failed++
			log.Printf("[shadow] 回填失败 uid=%s: %v", uid, err)
			continue
		}
		res.Synced++
	}

	return res, rows.Err()
}

/* ---------------- 后台总览 ---------------- */

// Overview 汇总运营要看的那几个数字。
func (s *Service) Overview(ctx context.Context) (map[string]interface{}, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	out := map[string]interface{}{}

	// 每个 SUM 都套一层 CAST(... AS SIGNED)。
	//
	// 原因：MySQL 的 SUM() 返回 DECIMAL，驱动把它当字符串给回来，
	// 当值形如 "5.000000" 时 Scan 进 int64 会直接报错，
	// 于是整个 /admin/overview 会 500 —— 而它本该只是「少看一个数字」。
	// COUNT() 返回 BIGINT，本来就是整数，不用管。
	row := pool.QueryRowContext(ctx,
		`SELECT COUNT(*),
		        CAST(COALESCE(SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)), 0) AS SIGNED),
		        CAST(COALESCE(SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)), 0) AS SIGNED),
		        CAST(COALESCE(SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)), 0) AS SIGNED),
		        CAST(COALESCE(SUM(tier <> 'free'), 0) AS SIGNED),
		        CAST(COALESCE(SUM(tier = 'pro'), 0) AS SIGNED),
		        CAST(COALESCE(SUM(holdings_count), 0) AS SIGNED),
		        CAST(COALESCE(SUM(records_count), 0) AS SIGNED),
		        COALESCE(ROUND(AVG(holdings_count), 2), 0),
		        CAST(COALESCE(MAX(payload_size), 0) AS SIGNED)
		   FROM users`)
	var total, a1, a7, a30, paid, pro, holdings, records, maxPayload int64
	var avgHoldings float64
	if err := row.Scan(&total, &a1, &a7, &a30, &paid, &pro, &holdings, &records, &avgHoldings, &maxPayload); err != nil {
		return nil, err
	}
	out["users"] = map[string]interface{}{
		"total": total, "active1": a1, "active7": a7, "active30": a30,
		"paid": paid, "pro": pro, "holdings": holdings, "records": records,
		"avgHoldings": avgHoldings, "maxPayloadSize": maxPayload,
	}

	// 快照维度：总条数与总体积（估算存储增长）
	var states, bytes int64
	if err := pool.QueryRowContext(ctx,
		`SELECT COUNT(*), CAST(COALESCE(SUM(LENGTH(payload)), 0) AS SIGNED) FROM user_state`,
	).Scan(&states, &bytes); err == nil {
		out["snapshots"] = map[string]interface{}{"states": states, "bytes": bytes}
	}

	// 最热门的标的：回答「大家到底在买什么」
	out["topHoldings"] = queryRows(ctx, pool,
		`SELECT market, code, COUNT(*) AS holders, ROUND(SUM(shares), 0) AS shares
		   FROM holdings GROUP BY market, code
		  ORDER BY holders DESC, shares DESC LIMIT 15`)

	// 最近活跃：出问题时定位到人
	out["recentUsers"] = queryRows(ctx, pool,
		`SELECT uid, nick_name, tier, holdings_count, records_count,
		        ROUND(payload_size/1024) AS kb, last_seen_at
		   FROM users ORDER BY last_seen_at DESC LIMIT 20`)

	// 快照最大的几个：上限是 5MB，快撑爆的人要先知道
	out["biggestSnapshots"] = queryRows(ctx, pool,
		`SELECT uid, nick_name, holdings_count, records_count, ROUND(payload_size/1024) AS kb
		   FROM users ORDER BY payload_size DESC LIMIT 10`)

	// 兑换码与订单
	var codeTotal, codeUsed int64
	if err := pool.QueryRowContext(ctx,
		`SELECT COUNT(*), CAST(COALESCE(SUM(used_by IS NOT NULL), 0) AS SIGNED) FROM redeem_code`,
	).Scan(&codeTotal, &codeUsed); err == nil {
		out["redeemCodes"] = map[string]interface{}{"total": codeTotal, "used": codeUsed}
	}

	var orderTotal, orderPaid int64
	var orderAmount float64
	if err := pool.QueryRowContext(ctx,
		`SELECT COUNT(*),
		        CAST(COALESCE(SUM(status = 'paid'), 0) AS SIGNED),
		        COALESCE(SUM(amount), 0)
		   FROM membership_order`,
	).Scan(&orderTotal, &orderPaid, &orderAmount); err == nil {
		out["membershipOrders"] = map[string]interface{}{
			"total": orderTotal, "paid": orderPaid, "amount": orderAmount,
		}
	}

	return out, nil
}

// queryRows 跑一条查询并把结果转成 []map，供总览直接序列化输出。
//
// 这几条都是聚合查询、行数很小（最多 20 行），动态取值比为此定义
// 五六个只用一次的结构体划算得多。
func queryRows(ctx context.Context, pool *sql.DB, query string) []map[string]interface{} {
	rows, err := pool.QueryContext(ctx, query)
	if err != nil {
		// 总览少一块比整个接口报错好：这几块本来就是给人看着方便的
		log.Printf("[shadow] 总览查询失败: %v", err)
		return []map[string]interface{}{}
	}
	defer rows.Close()

	cols, err := rows.Columns()
	if err != nil {
		return []map[string]interface{}{}
	}

	out := make([]map[string]interface{}, 0, 20)
	for rows.Next() {
		vals := make([]interface{}, len(cols))
		ptrs := make([]interface{}, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			continue
		}

		m := make(map[string]interface{}, len(cols))
		for i, c := range cols {
			// []byte 直接放进 map 会被序列化成 base64 —— 排查时完全没法读，
			// 所以凡是字节一律转成字符串。
			if b, ok := vals[i].([]byte); ok {
				m[c] = string(b)
				continue
			}
			m[c] = vals[i]
		}
		out = append(out, m)
	}

	return out
}

/* ---------------- 字段解析 ---------------- */

type profileInfo struct {
	NickName string
	Avatar   string
	Phone    string
	Holdings int
	Accounts int
	Records  int
	Expenses int
}

type holdingRow struct {
	ID      string
	Code    string
	Market  string
	Name    string
	Shares  float64
	Cost    float64
	Dps     float64
	Price   float64
	TaxRate float64
	BuyDate interface{}
	Received float64
}

type recordRow struct {
	ID        string
	HoldingID string
	Kind      string
	Date      interface{}
	Type      string
	Shares    float64
	Price     float64
	Fee       float64
	Amount    float64
	Note      string
}

type parsed struct {
	Profile  profileInfo
	Holdings []holdingRow
	Records  []recordRow
}

// parse 把快照 JSON 拆成关系行。
//
// 用宽松的动态解析而不是定义结构体：快照的字段是**客户端**定义的，
// App 每个版本都可能加字段、改结构。用结构体解析意味着每次客户端改动
// 都要跟着改后端、重新部署，而这份数据本来就不需要后端理解。
func parse(snapshot []byte) (*parsed, error) {
	var root map[string]interface{}
	if err := json.Unmarshal(snapshot, &root); err != nil {
		return nil, err
	}

	p := &parsed{}
	profile := objOf(root["profile"])
	settings := objOf(root["settings"])

	p.Profile.NickName = text(profile["nickName"], 64)
	p.Profile.Avatar = text(profile["avatar"], 16)
	p.Profile.Phone = text(profile["phone"], 32)

	accounts := arrOf(settings["accounts"])
	expenses := arrOf(settings["lifeExpenses"])

	// 持仓
	for _, item := range arrOf(root["holdings"]) {
		h := objOf(item)
		id := text(h["id"], 64)
		if id == "" {
			continue // 没有 id 的行无法参与「按 id 去重」与批次清理
		}
		p.Holdings = append(p.Holdings, holdingRow{
			ID:       id,
			Code:     strings.ToUpper(text(h["code"], 24)),
			Market:   text(h["market"], 16),
			Name:     text(h["name"], 64),
			Shares:   num(h["shares"]),
			Cost:     num(h["cost"]),
			Dps:      num(h["dps"]),
			Price:    num(h["price"]),
			TaxRate:  num(h["taxRate"]),
			BuyDate:  dateOrNull(h["buyDate"]),
			Received: num(h["received"]),
		})
	}

	// 记录：结构是 { 持仓id: { trade: [...], dividend: [...] } }
	records := objOf(root["records"])
	for holdingID, bucket := range records {
		holder := objOf(bucket)
		for _, kind := range []string{"trade", "dividend"} {
			for _, item := range arrOf(holder[kind]) {
				r := objOf(item)
				id := text(r["id"], 64)
				if id == "" {
					continue
				}
				// 分红记录在客户端里没有 type 字段（它本身就叫分红），
				// 补一个默认值，后台按 type 过滤时才不会漏掉它们。
				typ := text(r["type"], 16)
				if typ == "" && kind == "dividend" {
					typ = "分红"
				}
				note := text(r["note"], 255)
				if note == "" {
					note = text(r["plan"], 255)
				}
				p.Records = append(p.Records, recordRow{
					ID:        id,
					HoldingID: text(holdingID, 64),
					Kind:      kind,
					Date:      dateOrNull(r["date"]),
					Type:      typ,
					Shares:    num(r["shares"]),
					Price:     num(r["price"]),
					Fee:       num(r["fee"]),
					Amount:    num(r["amount"]),
					Note:      note,
				})
			}
		}
	}

	p.Profile.Holdings = len(p.Holdings)
	p.Profile.Records = len(p.Records)
	p.Profile.Accounts = len(accounts)
	p.Profile.Expenses = len(expenses)

	return p, nil
}

/* ---------------- 取值容错 ---------------- */

func objOf(v interface{}) map[string]interface{} {
	if m, ok := v.(map[string]interface{}); ok {
		return m
	}
	return map[string]interface{}{}
}

func arrOf(v interface{}) []interface{} {
	if a, ok := v.([]interface{}); ok {
		return a
	}
	return nil
}

// num 把 JSON 里的数字转成 float64。
// JSON 的数字统一解成 float64，但客户端偶尔会把数字写成字符串（表单输入），
// 所以两种都认，其余一律当 0。
func num(v interface{}) float64 {
	switch n := v.(type) {
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return 0
		}
		return n
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		if err != nil {
			return 0
		}
		return f
	default:
		return 0
	}
}

func text(v interface{}, max int) string {
	s := ""
	switch t := v.(type) {
	case string:
		s = strings.TrimSpace(t)
	case nil:
		return ""
	default:
		s = strings.TrimSpace(toString(t))
	}
	// 按**字符**截断，不能按字节：max 对应 MySQL 的 VARCHAR(n)（数的是字符），
	// 而 s[:max] 数的是字节 —— 切在多字节字符中间会留下无效 UTF-8，
	// 写库时要么报错要么存成乱码。中文一个字 3 字节，差得尤其明显。
	if max > 0 {
		if r := []rune(s); len(r) > max {
			s = string(r[:max])
		}
	}
	return s
}

func toString(v interface{}) string {
	switch t := v.(type) {
	case float64:
		// 整数值不要显示成 1.0
		if t == math.Trunc(t) && math.Abs(t) < 1e15 {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return ""
	}
}

// dateOrNull 只接受 yyyy-MM-dd。
// DATE 列不接受空串（会变成 0000-00-00 或被严格模式拒绝），
// 所以「没有日期」必须写 NULL。
func dateOrNull(v interface{}) interface{} {
	s := text(v, 10)
	if len(s) < 10 {
		return nil
	}
	// 粗校验形状即可：2026-09-19
	if s[4] != '-' || s[7] != '-' {
		return nil
	}
	return s
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

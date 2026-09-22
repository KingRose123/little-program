package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"errors"
	"strconv"
	"strings"
	"time"

	"xiji/api/internal/apperr"
)

/*
会员：档位、兑换码、订单。

业务规则全部沿用旧版，一个都不能改，因为 App 端的行为依赖它们：

  - 到期判定按**本地自然日**的字符串比较（'yyyy-MM-dd'），当天不算过期；
  - 续费是「从原到期日接着加」，已过期则从今天重新起算（不是从支付时间算）；
  - 档位只升不降：Pro 用户再兑换一个月 Lite 不该被降级；
  - 过期不影响存储 —— 数据库里那份 tier/expires_at 原样留着，
    「过期就显示 free」是查询时算出来的（statusOf）。
    这样用户续费时还能看到自己原来买过什么。
*/

// Plan 是一个开通方案。
//
// key 必须与 App 端 mock.membershipPlans 里的 key 一字不差：
// 客户端只传 key 过来，服务端据此算出金额与时长 ——
// 金额不从客户端传是刻意的，否则改个请求体就能一分钱买 Pro。
type Plan struct {
	Key    string
	Name   string
	Tier   string
	Months int
	Price  float64 // 单位：元
}

// Plans 与 App 端的方案列表一一对应。
var Plans = map[string]Plan{
	"lite-1m": {Key: "lite-1m", Name: "Lite 月卡", Tier: "lite", Months: 1, Price: 5.5},
	"pro-1y":  {Key: "pro-1y", Name: "Pro · 1年", Tier: "pro", Months: 12, Price: 98},
	"pro-2y":  {Key: "pro-2y", Name: "Pro · 2年", Tier: "pro", Months: 24, Price: 168},
	"pro-3y":  {Key: "pro-3y", Name: "Pro · 3年", Tier: "pro", Months: 36, Price: 198},
	"pro-5y":  {Key: "pro-5y", Name: "Pro · 5年", Tier: "pro", Months: 60, Price: 298},
}

// tierRank 用于「档位只升不降」的比较
func tierRank(tier string) int {
	switch tier {
	case "lite":
		return 1
	case "pro":
		return 2
	default:
		return 0
	}
}

// Status 是会员状态，字段名与 App 端读取的完全一致。
type Status struct {
	Tier      string `json:"tier"`      // 当前**生效**档位（过期即 free）
	PaidTier  string `json:"paidTier"`  // 实际买过的档位，不因过期而抹掉
	ExpiresAt string `json:"expiresAt"` // 到期日 yyyy-MM-dd
	Source    string `json:"source"`
	Expired   bool   `json:"expired"`
}

// MembershipStatus 查当前档位。
func (s *Store) MembershipStatus(ctx context.Context, uid string) (*Status, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	var (
		tier      sql.NullString
		expiresAt sql.NullString
		source    sql.NullString
	)
	err = pool.QueryRowContext(ctx,
		`SELECT tier, expires_at, source FROM membership WHERE uid = ? LIMIT 1`,
		uid,
	).Scan(&tier, &expiresAt, &source)
	if errors.Is(err, sql.ErrNoRows) {
		return &Status{Tier: "free", PaidTier: "free"}, nil
	}
	if err != nil {
		return nil, err
	}

	expiresKey := dateKey(expiresAt.String)
	today := s.today()

	return &Status{
		Tier:      effectiveTier(tier.String, expiresKey, today),
		PaidTier:  tier.String,
		ExpiresAt: expiresKey,
		Source:    source.String,
		Expired:   expiresKey != "" && expiresKey < today,
	}, nil
}

// effectiveTier 过期即降级为 free，但只在**返回时**降级。
func effectiveTier(tier, expiresKey, today string) string {
	if expiresKey != "" && expiresKey < today {
		return "free"
	}
	if tier == "" {
		return "free"
	}
	return tier
}

/* ---------------- 兑换码 ---------------- */

// RedeemResult 是兑换成功的返回。
type RedeemResult struct {
	Months     int     `json:"months"`
	Membership *Status `json:"membership"`
}

// Redeem 用兑换码开通。
//
// 一码一用靠「事务 + SELECT ... FOR UPDATE」保证：
// 两个请求同时提交同一个码时，后到的那个会阻塞在行锁上，
// 等前一个提交后它读到的 used_by 已经非空，于是走到「已被使用」分支。
// 用唯一约束去兜也行，但那样错误信息就没法区分「码不存在」和「码被用了」。
func (s *Store) Redeem(ctx context.Context, code, uid string) (*RedeemResult, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	// Commit 之后再 Rollback 是空操作，所以这里无脑 defer 是安全的
	defer func() { _ = tx.Rollback() }()

	var (
		tier     string
		months   int
		usedBy   sql.NullString
		voidedAt sql.NullString
	)
	err = tx.QueryRowContext(ctx,
		`SELECT tier, months, used_by, voided_at FROM redeem_code WHERE code = ? FOR UPDATE`, code,
	).Scan(&tier, &months, &usedBy, &voidedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.New("兑换码不存在")
	}
	if err != nil {
		return nil, err
	}
	// 已核销排在前面判：作废时不该把已使用的码标成作废（那样用户明明
	// 开通着，码却显示"已作废"），所以正常情况下这两个状态不会同时出现。
	if usedBy.Valid && usedBy.String != "" {
		return nil, apperr.New("该兑换码已被使用")
	}
	if voidedAt.Valid {
		return nil, apperr.New("该兑换码已作废")
	}

	st, err := s.applyGrant(ctx, tx, uid, tier, months, "兑换码")
	if err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE redeem_code SET used_by = ?, used_at = NOW() WHERE code = ?`,
		uid, code,
	); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return &RedeemResult{Months: months, Membership: st}, nil
}

// 兑换码字符集：去掉了 0/O/1/I/L 这几个手写时最容易看错的字符。
// 这是纯人工抄写的场景，可读性比熵更重要（31^10 依然远超需要）。
const codeChars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

// GenCodes 批量生成兑换码。
// 前缀 SXL + 10 位随机，与旧版一致 —— 已发出去的码格式不能变。
func (s *Store) GenCodes(ctx context.Context, tier string, months, count int, batchNo, note string) ([]string, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}
	if count < 1 {
		count = 1
	}
	if count > 200 {
		count = 200
	}

	out := make([]string, 0, count)
	for i := 0; i < count; i++ {
		code, err := randomCode()
		if err != nil {
			return nil, err
		}
		if _, err := pool.ExecContext(ctx,
			`INSERT INTO redeem_code (code, tier, months, batch_no, note, created_at)
			 VALUES (?, ?, ?, ?, ?, NOW())`,
			code, tier, months, batchNo, note,
		); err != nil {
			return nil, err
		}
		out = append(out, code)
	}
	return out, nil
}

func randomCode() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	b := make([]byte, 0, 13)
	b = append(b, 'S', 'X', 'L')
	for _, v := range buf {
		b = append(b, codeChars[int(v)%len(codeChars)])
	}
	return string(b), nil
}

/* ---------------- 兑换码：查询与统计 ----------------
 * 生成（GenCodes）和核销（Redeem）本来就有，缺的是「发出去的码后来怎么样了」：
 * 手上哪几个还没用（避免重复发）、这批卖了多少、导出给发货系统。
 * 这些全部只读现有字段，不需要改表结构。
 */

// CodeFilter 是兑换码查询条件。零值表示「全部批次、不限状态、前 200 条」。
type CodeFilter struct {
	Batch  string // 批次号；空为全部批次
	Status string // "" 全部 / "used" 已使用 / "unused" 未使用
	Limit  int    // 0 用默认 200，上限 1000
	Offset int
}

// CodeRow 是列表里的一行。
//
// 时间用字符串而不是 time.Time：DSN 里 parseTime=false（快照那边用不到
// 时间类型），走 time.Time 会直接扫不出来。DATETIME 原样读回来已经是
// 'yyyy-MM-dd HH:mm:ss'，给人看正合适。
type CodeRow struct {
	Code      string `json:"code"`
	Tier      string `json:"tier"`
	Months    int    `json:"months"`
	Batch     string `json:"batch"`
	Note      string `json:"note"`
	UsedBy    string `json:"usedBy"`
	Used      bool   `json:"used"`
	UsedAt    string `json:"usedAt"`
	Voided    bool   `json:"voided"`
	VoidedAt  string `json:"voidedAt"`
	CreatedAt string `json:"createdAt"`
}

// CodeStats 是筛选范围内的统计，不受分页影响。
type CodeStats struct {
	Total  int `json:"total"`
	Used   int `json:"used"`
	// Voided 是作废数。**Unused 不含它** —— 两者是互斥的三种终态：
	// 未使用（可发）/ 已使用 / 已作废，加一起等于 Total。
	Voided int `json:"voided"`
	Unused int `json:"unused"`
}

// BatchStat 是按批次聚合的概览，回答「哪一批卖得怎么样」。
type BatchStat struct {
	Batch     string `json:"batch"`
	Tier      string `json:"tier"`
	Months    int    `json:"months"`
	Note      string `json:"note"`
	Total     int    `json:"total"`
	Used      int    `json:"used"`
	Unused    int    `json:"unused"`
	CreatedAt string `json:"createdAt"`
}

// ListCodes 按条件查兑换码，同时给出该条件下的统计。
//
// 统计和列表放同一次调用里返回，是因为实际要看的是「这批 100 个、用了 37 个」
// —— 分两次请求既慢，又容易两边筛选条件不一致，得出错的结论。
func (s *Store) ListCodes(ctx context.Context, f CodeFilter) ([]CodeRow, CodeStats, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, CodeStats{}, err
	}

	where, args := codeWhere(f)

	var st CodeStats
	if err := pool.QueryRowContext(ctx,
		`SELECT COUNT(*),
		        COALESCE(SUM(used_by IS NOT NULL), 0),
		        COALESCE(SUM(voided_at IS NOT NULL), 0)
		   FROM redeem_code`+where,
		args...,
	).Scan(&st.Total, &st.Used, &st.Voided); err != nil {
		return nil, CodeStats{}, err
	}
	st.Unused = st.Total - st.Used - st.Voided

	limit := f.Limit
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	// 先复制一份再 append：直接往 args 上追加会复用它底层的数组，
	// 而上面统计那次已经用过它了。共用一个数组时，第二次 append
	// 可能改写掉统计用过的元素 —— 这种别名 bug 只在参数个数刚好
	// 触发扩容时才现形，极难查。
	pageArgs := append([]interface{}{}, args...)
	pageArgs = append(pageArgs, limit, offset)

	rows, err := pool.QueryContext(ctx,
		`SELECT code, tier, months, batch_no, note, used_by, used_at, voided_at, created_at
		   FROM redeem_code`+where+`
		  ORDER BY created_at DESC, code
		  LIMIT ? OFFSET ?`,
		pageArgs...,
	)
	if err != nil {
		return nil, CodeStats{}, err
	}
	defer rows.Close()

	var out []CodeRow
	for rows.Next() {
		var (
			r        CodeRow
			usedBy   sql.NullString
			usedAt   sql.NullString
			voidedAt sql.NullString
		)
		if err := rows.Scan(&r.Code, &r.Tier, &r.Months, &r.Batch, &r.Note,
			&usedBy, &usedAt, &voidedAt, &r.CreatedAt); err != nil {
			return nil, CodeStats{}, err
		}
		r.UsedBy = usedBy.String
		r.Used = usedBy.Valid && usedBy.String != ""
		r.UsedAt = usedAt.String
		r.Voided = voidedAt.Valid
		r.VoidedAt = voidedAt.String
		out = append(out, r)
	}
	return out, st, rows.Err()
}

// VoidCodes 作废兑换码。
//
// 两种用法二选一：
//
//	codes 非空 → 作废指定的这几个码（发错了人、买家退款）
//	batch 非空 → 作废该批次**全部未使用**的码（某批泄漏时用这个）
//
// 只作废未使用的：已经核销的码意味着用户已经开通了会员，把它标成作废
// 等于把人家买到的权益收回去 —— 那是退款，得单独处理，不该混在这里。
//
// 返回**真正被改动**的条数：没匹配到、以及已使用/已作废的都不计入。
// 调用方据此判断「是不是什么都没改」，而不是一律回成功 ——
// 后者会让人以为作废生效了，继续把作废的码发出去。
func (s *Store) VoidCodes(ctx context.Context, codes []string, batch string) (int, error) {
	if len(codes) == 0 && batch == "" {
		return 0, apperr.New("请给出要作废的码或批次")
	}

	pool, err := s.db.Pool(ctx)
	if err != nil {
		return 0, err
	}

	// 按数量动态拼占位符：拼的是**结构**（有几个条件、几个 ?），
	// 值仍然全部走参数 —— 码和批次号都来自请求体，是外部输入。
	var (
		conds []string
		args  []interface{}
	)
	if len(codes) > 0 {
		ph := make([]string, len(codes))
		for i, c := range codes {
			ph[i] = "?"
			args = append(args, strings.TrimSpace(c))
		}
		conds = append(conds, "code IN ("+strings.Join(ph, ",")+")")
	}
	if batch != "" {
		conds = append(conds, "batch_no = ?")
		args = append(args, batch)
	}

	res, err := pool.ExecContext(ctx,
		`UPDATE redeem_code
		    SET voided_at = NOW()
		  WHERE `+strings.Join(conds, " AND ")+`
		    AND used_by IS NULL
		    AND voided_at IS NULL`,
		args...,
	)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}

// ListBatches 按批次聚合。不分页 —— 批次是人手工建的，
// 一次生成就是一个批次，数量天然很少，为它引分页是多余的复杂度。
func (s *Store) ListBatches(ctx context.Context) ([]BatchStat, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	rows, err := pool.QueryContext(ctx,
		`SELECT batch_no, tier, months, note,
		        COUNT(*),
		        COALESCE(SUM(used_by IS NOT NULL), 0),
		        MIN(created_at)
		   FROM redeem_code
		  GROUP BY batch_no, tier, months, note
		  ORDER BY MIN(created_at) DESC, batch_no DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []BatchStat
	for rows.Next() {
		var b BatchStat
		if err := rows.Scan(&b.Batch, &b.Tier, &b.Months, &b.Note,
			&b.Total, &b.Used, &b.CreatedAt); err != nil {
			return nil, err
		}
		b.Unused = b.Total - b.Used
		out = append(out, b)
	}
	return out, rows.Err()
}

// codeWhere 拼 WHERE 子句。
//
// 只拼「结构」（哪些列参与筛选），条件值一律走占位符：
// 批次号来自查询串，是外部输入 —— 把它拼进 SQL 就是注入。
func codeWhere(f CodeFilter) (string, []interface{}) {
	var conds []string
	var args []interface{}

	if f.Batch != "" {
		conds = append(conds, "batch_no = ?")
		args = append(args, f.Batch)
	}
	switch f.Status {
	case "used":
		conds = append(conds, "used_by IS NOT NULL")
	case "unused":
		// 未使用 = 既没核销、也没作废。作废的码不能再发出去，
		// 所以它绝不能出现在「这批还剩哪些没发」的结果里 ——
		// 而这个查询正是发码前唯一的依据。
		conds = append(conds, "used_by IS NULL AND voided_at IS NULL")
	case "voided":
		conds = append(conds, "voided_at IS NOT NULL")
	}

	if len(conds) == 0 {
		return "", nil
	}
	return " WHERE " + strings.Join(conds, " AND "), args
}

/* ---------------- 订单 ---------------- */

// Order 是一笔会员订单。
type Order struct {
	OrderID  string  `json:"orderId"`
	Plan     string  `json:"plan"`
	PlanName string  `json:"planName"`
	Amount   float64 `json:"amount"`
	Months   int     `json:"months"`
	Tier     string  `json:"tier"`
	// Channel 是下单时选定的支付渠道（wxpay / alipay / …）。
	// 它在下单时就定下来，而不是等回调才补 —— 回调万一没带渠道信息
	// （或带了别的），这笔订单该算在哪个渠道名下仍然是明确的。
	Channel string `json:"channel"`
}

// CreateOrder 落一笔待支付订单。
//
// 先落库再向渠道下单：支付回调只带 out_trade_no，服务端必须能凭它找回
// 「谁、买的是什么」。反过来先下单后落库，一旦落库失败就会收到一笔
// 「认不出是谁付的」的钱。
func (s *Store) CreateOrder(ctx context.Context, planKey, uid, channel string) (*Order, error) {
	plan, ok := Plans[planKey]
	if !ok {
		return nil, apperr.New("方案不存在")
	}

	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	orderID, err := newOrderID()
	if err != nil {
		return nil, err
	}

	if _, err := pool.ExecContext(ctx,
		`INSERT INTO membership_order
		   (order_id, uid, plan, tier, months, amount, status, channel, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NOW(), NOW())`,
		orderID, uid, plan.Key, plan.Tier, plan.Months, plan.Price, channel,
	); err != nil {
		return nil, err
	}

	return &Order{
		OrderID:  orderID,
		Plan:     plan.Key,
		PlanName: plan.Name,
		Amount:   plan.Price,
		Months:   plan.Months,
		Tier:     plan.Tier,
		Channel:  channel,
	}, nil
}

// newOrderID 生成订单号：M + 毫秒时间戳 + 3 位随机数，共 17 字符。
// 与旧版格式一致（已写进历史数据），也满足微信对 out_trade_no 的字符与唯一性要求。
func newOrderID() (string, error) {
	var b [2]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	n := 100 + int(binary.BigEndian.Uint16(b[:])%900)
	return "M" + strconv.FormatInt(time.Now().UnixMilli(), 10) + strconv.Itoa(n), nil
}

// SetPrepayID 记下渠道侧的预支付单号，便于查单时对得上。
//
// 渠道一并发过来：这张表早先只有微信一条通道，所以这里曾经把 'wxpay' 写死过，
// 结果就是换个渠道下单时订单会被记到微信名下，按渠道对账直接算错。
func (s *Store) SetPrepayID(ctx context.Context, orderID, channel, prepayID string) error {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return err
	}
	_, err = pool.ExecContext(ctx,
		`UPDATE membership_order SET prepay_id = ?, channel = ?, updated_at = NOW() WHERE order_id = ?`,
		prepayID, channel, orderID,
	)
	return err
}

// GrantResult 是发货结果。Repeated=true 表示这是重复回调，本次没有再加时长。
type GrantResult struct {
	Repeated bool
}

// MarkPaidAndGrant 支付成功后发货。
//
// 幂等是硬要求：微信收不到成功应答会一直重推，重复发货会让用户白得几个月。
// 这里用「事务 + 行锁 + status 判断」三件套保证 ——
// 并发的两个回调会被行锁串行化，第二个读到的 status 已是 paid，直接返回。
func (s *Store) MarkPaidAndGrant(ctx context.Context, orderID, channel, transactionID string) (*GrantResult, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	tx, err := pool.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var (
		uid     string
		tier    string
		months  int
		status  string
		savedCh string
	)
	err = tx.QueryRowContext(ctx,
		`SELECT uid, tier, months, status, channel FROM membership_order WHERE order_id = ? FOR UPDATE`,
		orderID,
	).Scan(&uid, &tier, &months, &status, &savedCh)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.New("订单不存在")
	}
	if err != nil {
		return nil, err
	}

	if status == "paid" {
		// 重复回调。回 ok 让微信停止重推，但不再加时长。
		return &GrantResult{Repeated: true}, nil
	}

	if _, err := s.applyGrant(ctx, tx, uid, tier, months, "订单"); err != nil {
		return nil, err
	}

	// 渠道取用顺序：回调带进来的 → 下单时记下的 → 兜一个 manual。
	// manual 代表「人工确认过的支付」（比如线下转账后在后台补单），
	// 对账时按渠道分组就能把这些单独拎出来核对。
	ch := channel
	if ch == "" {
		ch = savedCh
	}
	if ch == "" {
		ch = "manual"
	}

	if _, err := tx.ExecContext(ctx,
		`UPDATE membership_order
		    SET status = 'paid', channel = ?, transaction_id = ?, paid_at = NOW(), updated_at = NOW()
		  WHERE order_id = ?`,
		ch, transactionID, orderID,
	); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return &GrantResult{}, nil
}

// OrderStatusResult 是订单查询结果，字段名与 App 端读取的一致。
type OrderStatusResult struct {
	OutTradeNo string  `json:"outTradeNo"`
	Plan       string  `json:"plan"`
	Amount     float64 `json:"amount"`
	Status     string  `json:"status"`
	Membership *Status `json:"membership"`
}

// OrderStatus 查订单。
//
// uid 非空时必须与订单归属一致，否则任何登录用户都能拿别人的订单号
// 反查别人买没买、买了多少。
func (s *Store) OrderStatus(ctx context.Context, orderID, uid string) (*OrderStatusResult, error) {
	pool, err := s.db.Pool(ctx)
	if err != nil {
		return nil, err
	}

	var (
		owner  string
		plan   string
		amount float64
		status string
	)
	err = pool.QueryRowContext(ctx,
		`SELECT uid, plan, amount, status FROM membership_order WHERE order_id = ? LIMIT 1`,
		orderID,
	).Scan(&owner, &plan, &amount, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, apperr.New("订单不存在")
	}
	if err != nil {
		return nil, err
	}

	if uid != "" && uid != owner {
		return nil, apperr.New("无权查看该订单")
	}

	// 注意这里用**订单归属人**去查会员状态，而不是入参 uid ——
	// 订单状态描述的是「这单付了之后那个账号变成了什么档位」。
	st, err := s.MembershipStatus(ctx, owner)
	if err != nil {
		return nil, err
	}

	return &OrderStatusResult{
		OutTradeNo: orderID,
		Plan:       plan,
		Amount:     amount,
		Status:     status,
		Membership: st,
	}, nil
}

/* ---------------- 开通（内部） ---------------- */

// applyGrant 在事务内完成开通/续期。
//
// 抽成一个函数是因为兑换码和订单支付两条路都要用它，
// 而「续费叠加、档位只升不降、当天到期算有效」这几条规则
// 一旦在两处各写一遍，早晚会有一处跑偏。
func (s *Store) applyGrant(ctx context.Context, tx *sql.Tx, uid, tier string, months int, source string) (*Status, error) {
	today := s.today()

	var (
		curTier    sql.NullString
		curExpires sql.NullString
	)
	err := tx.QueryRowContext(ctx,
		`SELECT tier, expires_at FROM membership WHERE uid = ? FOR UPDATE`, uid,
	).Scan(&curTier, &curExpires)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}

	curKey := dateKey(curExpires.String)
	// 到期日当天仍算有效：用户今天续费，应该是从今天往后加，而不是从明天
	active := curKey != "" && curKey >= today

	effective := "free"
	if active {
		effective = curTier.String
	}

	nextTier := effective
	if tierRank(tier) > tierRank(effective) {
		nextTier = tier
	}

	base := ""
	if active {
		base = curKey
	}
	expiresAt := s.extendFrom(base, months, today)

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO membership (uid, tier, expires_at, source, started_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, NOW())
		 ON DUPLICATE KEY UPDATE
		   tier = VALUES(tier),
		   expires_at = VALUES(expires_at),
		   source = VALUES(source),
		   started_at = COALESCE(started_at, VALUES(started_at)),
		   updated_at = NOW()`,
		uid, nextTier, expiresAt, source, today,
	); err != nil {
		return nil, err
	}

	return &Status{
		Tier:      nextTier,
		PaidTier:  nextTier,
		ExpiresAt: expiresAt,
		Source:    source,
	}, nil
}

/* ---------------- 日期 ---------------- */

const dateLayout = "2006-01-02"

// today 取本地自然日。用配置时区而不是 UTC：
// 「会员今天到期」对用户来说是北京时间的那一天。
func (s *Store) today() string {
	return time.Now().In(s.locOrLocal()).Format(dateLayout)
}

// dateKey 把数据库返回值裁成 yyyy-MM-dd。
// parseTime=false 时 DATE 列读出来已经是 "2026-09-19"，
// 这里再裁一次是为了兼容 DATETIME（例如误把 DATE 改成 DATETIME 后的历史数据）。
func dateKey(v string) string {
	if len(v) < 10 {
		return v
	}
	return v[:10]
}

// extendFrom 算新的到期日：未过期就从原到期日接着加，已过期从今天重新起算。
//
// 它是 **Store 的方法**而不是包级函数：算月份需要业务时区，
// 而时区是 Store 持有的。写成包级函数就得把时区一路当参数传，
// 那种写法迟早会出现「某一处忘了传、悄悄按 UTC 算」——
// 表现是月底续费的人到期日差一天，极难发现。
func (s *Store) extendFrom(base string, months int, today string) string {
	if base == "" || base < today {
		base = today
	}
	return plusMonths(base, months, s.locOrLocal())
}

// plusMonths 加 N 个自然月，月底自动收敛。
//
// 不收敛的话 1 月 31 日加一个月会得到 3 月 3 日（Go 的 AddDate 行为），
// 用户会发现自己买的「1 个月」变成了 33 天。收敛到目标月最后一天才符合直觉。
func plusMonths(dateKey string, months int, loc *time.Location) string {
	t, err := time.ParseInLocation(dateLayout, dateKey, loc)
	if err != nil {
		return dateKey
	}

	firstOfTarget := time.Date(t.Year(), t.Month()+time.Month(months), 1, 0, 0, 0, 0, loc)
	lastDay := firstOfTarget.AddDate(0, 1, -1).Day()

	day := t.Day()
	if day > lastDay {
		day = lastDay
	}

	return time.Date(firstOfTarget.Year(), firstOfTarget.Month(), day, 0, 0, 0, 0, loc).Format(dateLayout)
}

func (s *Store) locOrLocal() *time.Location {
	if s.loc == nil {
		return time.Local
	}
	return s.loc
}

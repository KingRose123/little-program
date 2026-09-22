// Package snapshot 校验客户端推上来的数据快照。
//
// 为什么服务端还要再校验一遍：客户端（app/src/utils/validate.js）已经做过
// 输入净化，但那一层属于**体验**，绕过去太容易了 —— 改包、抓包重放、或者
// 干脆用 curl 直接打 PUT /api/state 都行。而这条接口是**唯一的数据写入通道**
// （持仓、交易、分红全在同一份快照里），存进来什么，库里就一直是什么。
//
// 校验的三条取舍：
//
//  1. **只挡明显非法，不做严格 schema**。快照的字段由客户端定义，每个版本
//     都可能加字段、改结构。严格校验等于把「客户端升级」和「服务端发版」
//     绑死在一起 —— 老服务端会把新客户端的正常请求判为非法，用户表现为
//     「数据一直同步不上去」。所以：认识的字段查类型与上限，不认识的放过。
//
//  2. **数量必须有上限**。5MB 的体积上限挡的是字节数，挡不住「十几万条极短的
//     持仓」—— 那些会被影子表逐行写进 MySQL，是实打实的写放大。一屏能看到
//     几十只持仓，几千条已经远超真实用户。
//
//  3. **数字允许字符串**。客户端表单里数值本来就是字符串（"1000"），
//     store.js 也原样存、原样上传；强制要求 number 会误伤正常客户端。
//     但对「能解析成数字」和「是有限值」是严格的：NaN / Infinity / "abc"
//     一旦存进去，后面每个读它的地方都得各自兜底。
package snapshot

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits 是各项数量上限。默认值见 DefaultLimits。
type Limits struct {
	// Holdings 持仓条数上限
	Holdings int
	// RecordsTotal 交易 + 分红的总条数上限
	RecordsTotal int
	// RecordsPer 单个持仓下挂的记录条数上限
	RecordsPer int
	// Accounts / Expenses settings 里两个数组的长度上限
	Accounts int
	Expenses int
}

// DefaultLimits 是线上使用的上限。
//
// 取值依据：重度用户 100 只持仓约 30KB（见 config.DefaultMaxPayloadBytes 的注释），
// 所以 2000 只、2 万条记录都留了 20 倍以上余量，正常用户永远碰不到；
// 而攻击者想在 5MB 内堆到 20 万行就会在这里被挡住。
var DefaultLimits = Limits{
	Holdings:     2000,
	RecordsTotal: 20000,
	RecordsPer:   2000,
	Accounts:     50,
	Expenses:     100,
}

// 各文本字段的长度上限。**除 note 外**与影子表列宽保持一致（shadow.upsert*
// 里写入的那几列），免得多出来的部分在解析时被悄悄截断，而原文只留在 JSON 里
// —— 那种「存进去和查出来不一样」最难排查。
// note 是个例外：它要装得下用户写的长文，因此比影子表那一列宽（见 maxNote）。
//
// 【单位是字符，不是字节】与 MySQL 的 VARCHAR(n) 同口径，也与客户端一致：
// app 端一律按码点限长（validate.clip），服务端再按字节算的话，中文用户
// 写 86 个字就会被判超长 —— 而这不是「少存几个字」，是**整份快照被拒**，
// 表现为「数据一直同步不上去」且客户端只留下一行 warn。
const (
	maxID      = 64
	maxCode    = 24
	maxMarket  = 16
	maxName    = 64
	maxAccount = 64
	maxShort   = 32 // priceDate / phone 这类短标识
	// maxNote 是「心得体悟」类文本的上限：写了长文就该存得下。
	// 与客户端 api.js 的 MEMO_MAX 保持一致 —— 两边不同会让「本地写得进、
	// 同步被拒」，而那种失败在界面上是完全静默的。
	//
	// 这里**大于**影子表 holding_records.note 的列宽（VARCHAR(255)），
	// 是有意的：影子表是后台看板的派生数据，parse 时会按列宽截断；
	// 用户的原文完整存在 user_state.payload（LONGTEXT）里，不经过那一列。
	maxNote = 5000
)

// 数值的绝对值上限。只用来挡「明显荒唐」的值，不会碰到真实数据：
// 最贵的股价不过几万，成本/派息更小；股数再大也到不了万亿。
const (
	maxShares = 1e12
	maxMoney  = 1e9
)

// Problem 描述一处校验失败。
//
// Error() 的文案会**直接回给客户端**（handlePutState 里 Fail 原文），
// 所以措辞要能让用户看懂并自己纠正，而不是内部术语。
type Problem struct {
	Path string
	Msg  string
}

func (p *Problem) Error() string {
	return p.Path + " " + p.Msg
}

func problem(path, msg string) error {
	return &Problem{Path: path, Msg: msg}
}

// Validate 校验一份快照。返回 nil 表示通过，否则返回 *Problem。
//
// 只解析一遍：用 UseNumber 让数字保持字面量，避免 float64 把大整数
// 变成 1e+15 这种形态，也便于识别 "NaN" 之类能骗过 ParseFloat 的字符串。
func Validate(raw []byte, lim Limits) error {
	if len(raw) == 0 {
		return problem("payload", "不能为空")
	}

	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()

	var root map[string]interface{}
	if err := dec.Decode(&root); err != nil {
		return problem("payload", "不是合法的 JSON 对象")
	}
	// Decode 成功不代表没有多余内容，但这里是尽力而为的形状校验，
	// 不做「EOF 之后是否还有字节」的严格判断 —— 那属于体积校验的范畴。

	if err := checkHoldings(root["holdings"], lim); err != nil {
		return err
	}
	if err := checkRecords(root["records"], lim); err != nil {
		return err
	}
	if err := checkSettings(root["settings"], lim); err != nil {
		return err
	}
	if err := checkProfile(root["profile"]); err != nil {
		return err
	}

	return nil
}

/* ---------------- holdings ---------------- */

// 持仓里要校验的文本字段及长度。
var holdingTexts = []struct {
	key string
	max int
}{
	{"code", maxCode},
	{"market", maxMarket},
	{"name", maxName},
	{"accountId", maxAccount},
	{"priceDate", maxShort},
	{"buyDate", maxShort},
	{"costMode", maxShort},
	{"divMode", maxShort},
	// 清仓心得。客户端 api.js 的 MEMO_MAX 限 200 字符，这里 255 留点余量；
	// 它以前不在这张表里 —— 不认识的字段虽然会被放过，但「已知字段不管」
	// 等于给了一条绕过客户端、往库里塞任意长度文本的路。
	{"archiveReason", maxNote},
}

// 持仓里要校验的数值字段，以及各自的绝对值上限和是否要求非负。
//
// cost 允许为负（分红收回本金后是真实状态），dps / shares / price 不行。
var holdingNums = []struct {
	key         string
	maxAbs      float64
	nonNegative bool
}{
	{"shares", maxShares, true},
	{"cost", maxMoney, false},
	{"dps", maxMoney, false},
	{"price", maxMoney, false},
	{"received", maxMoney, false},
	{"fee", maxMoney, true},
	{"taxRate", 100, true},
	{"baseDps", maxMoney, false},
}

func checkHoldings(v interface{}, lim Limits) error {
	if v == nil {
		return nil // 允许缺失：新用户还没建仓
	}
	arr, ok := v.([]interface{})
	if !ok {
		return problem("holdings", "必须是数组")
	}
	if lim.Holdings > 0 && len(arr) > lim.Holdings {
		return problem("holdings", fmt.Sprintf("最多 %d 条，收到 %d 条", lim.Holdings, len(arr)))
	}

	for i, item := range arr {
		at := fmt.Sprintf("holdings[%d]", i)
		m, ok := item.(map[string]interface{})
		if !ok {
			return problem(at, "必须是对象")
		}

		// id 是影子表去重与批次清理的依据，空 id 的行会被静默丢弃 ——
		// 与其存一份查不到的持仓，不如在这里直接拒掉。
		if err := checkID(m["id"], at+".id", maxID, true); err != nil {
			return err
		}

		for _, f := range holdingTexts {
			if err := checkText(m[f.key], at+"."+f.key, f.max); err != nil {
				return err
			}
		}

		for _, f := range holdingNums {
			if err := checkNum(m[f.key], at+"."+f.key, f.maxAbs, f.nonNegative); err != nil {
				return err
			}
		}
	}

	return nil
}

/* ---------------- records ---------------- */

// 记录里要校验的文本字段。
var recordTexts = []struct {
	key string
	max int
}{
	{"type", maxShort},
	{"date", maxShort},
	{"note", maxNote},
	{"plan", maxNote},
}

// 记录里要校验的数值字段。
var recordNums = []struct {
	key         string
	maxAbs      float64
	nonNegative bool
}{
	{"shares", maxShares, true},
	{"price", maxMoney, false},
	{"fee", maxMoney, true},
	{"amount", maxMoney, false},
	{"dps", maxMoney, false},
	{"tax", maxMoney, true},
}

// records 的结构是 { 持仓id: { trade: [...], dividend: [...] } }。
func checkRecords(v interface{}, lim Limits) error {
	if v == nil {
		return nil
	}
	m, ok := v.(map[string]interface{})
	if !ok {
		return problem("records", "必须是对象")
	}
	if lim.Holdings > 0 && len(m) > lim.Holdings {
		return problem("records", fmt.Sprintf("最多 %d 个持仓的记录，收到 %d 个", lim.Holdings, len(m)))
	}

	total := 0
	for holdingID, bucket := range m {
		b, ok := bucket.(map[string]interface{})
		if !ok {
			return problem("records."+holdingID, "必须是对象")
		}

		for _, kind := range []string{"trade", "dividend"} {
			raw, exists := b[kind]
			if !exists || raw == nil {
				continue
			}
			arr, ok := raw.([]interface{})
			if !ok {
				return problem("records."+holdingID+"."+kind, "必须是数组")
			}
			if lim.RecordsPer > 0 && len(arr) > lim.RecordsPer {
				return problem(
					"records."+holdingID+"."+kind,
					fmt.Sprintf("最多 %d 条，收到 %d 条", lim.RecordsPer, len(arr)),
				)
			}

			total += len(arr)
			if lim.RecordsTotal > 0 && total > lim.RecordsTotal {
				return problem("records", fmt.Sprintf("记录总数最多 %d 条", lim.RecordsTotal))
			}

			for i, item := range arr {
				at := fmt.Sprintf("records.%s.%s[%d]", holdingID, kind, i)
				r, ok := item.(map[string]interface{})
				if !ok {
					return problem(at, "必须是对象")
				}
				if err := checkID(r["id"], at+".id", maxID, true); err != nil {
					return err
				}
				for _, f := range recordTexts {
					if err := checkText(r[f.key], at+"."+f.key, f.max); err != nil {
						return err
					}
				}
				for _, f := range recordNums {
					if err := checkNum(r[f.key], at+"."+f.key, f.maxAbs, f.nonNegative); err != nil {
						return err
					}
				}
			}
		}
	}

	return nil
}

/* ---------------- settings / profile ---------------- */

func checkSettings(v interface{}, lim Limits) error {
	if v == nil {
		return nil
	}
	m, ok := v.(map[string]interface{})
	if !ok {
		return problem("settings", "必须是对象")
	}

	for _, f := range []struct {
		key string
		max int
	}{
		{"accounts", lim.Accounts},
		{"lifeExpenses", lim.Expenses},
	} {
		raw, exists := m[f.key]
		if !exists || raw == nil {
			continue
		}
		arr, ok := raw.([]interface{})
		if !ok {
			return problem("settings."+f.key, "必须是数组")
		}
		if f.max > 0 && len(arr) > f.max {
			return problem("settings."+f.key, fmt.Sprintf("最多 %d 条，收到 %d 条", f.max, len(arr)))
		}
	}

	return nil
}

func checkProfile(v interface{}) error {
	if v == nil {
		return nil
	}
	m, ok := v.(map[string]interface{})
	if !ok {
		return problem("profile", "必须是对象")
	}

	for _, f := range []struct {
		key string
		max int
	}{
		{"nickName", 64},
		{"avatar", 16},
		{"phone", maxShort},
	} {
		if err := checkText(m[f.key], "profile."+f.key, f.max); err != nil {
			return err
		}
	}

	return nil
}

/* ---------------- 字段级校验 ---------------- */

// checkID 校验 ID 类字段。required 为真时不允许缺失或为空。
func checkID(v interface{}, path string, max int, required bool) error {
	s, ok := v.(string)
	if !ok {
		if v == nil && !required {
			return nil
		}
		return problem(path, "必须是字符串")
	}
	s = strings.TrimSpace(s)
	if s == "" {
		if required {
			return problem(path, "不能为空")
		}
		return nil
	}
	if utf8.RuneCountInString(s) > max {
		return problem(path, fmt.Sprintf("最长 %d 个字符", max))
	}
	return nil
}

// checkText 校验文本字段：类型是字符串（或缺失），且不超过长度上限。
//
// 数字/bool 出现在文本位置不算错 —— 客户端的 toString 会把它们写成字符串，
// 但老版本可能直接存了数字，为此拒绝一份正常快照不值得。这里只挡真正的
// 结构错误（数组 / 对象）与超长。
//
// 长度按 **rune** 数（不是 len 的字节数）：max 对应 MySQL 的 VARCHAR(n)，
// 而 VARCHAR(n) 数的是字符。用 len 的话中文一个顶三个 —— 客户端按码点
// 放行 200 字，这边 255 字节只容得下 85 个，超了整份快照被拒。
func checkText(v interface{}, path string, max int) error {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		if utf8.RuneCountInString(t) > max {
			return problem(path, fmt.Sprintf("最长 %d 个字符", max))
		}
		return nil
	case json.Number, float64, bool:
		return nil
	default:
		return problem(path, "必须是字符串")
	}
}

// checkNum 校验数值字段。
//
// 接受 number 与「能解析成数字的字符串」—— 客户端表单里数值就是字符串。
// 但拒绝：解析不了的字符串、NaN / Infinity、超出绝对值上限的值。
func checkNum(v interface{}, path string, maxAbs float64, nonNegative bool) error {
	if v == nil {
		return nil // 缺失视为未填，由客户端按 0 处理
	}

	var f float64
	switch t := v.(type) {
	case json.Number:
		parsed, err := t.Float64()
		if err != nil {
			return problem(path, "不是合法数字")
		}
		f = parsed
	case float64:
		f = t
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return nil // 空串 = 未填
		}
		parsed, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return problem(path, "不是合法数字")
		}
		f = parsed
	default:
		return problem(path, "必须是数字")
	}

	// NaN / Infinity 能骗过 ParseFloat（字符串 "NaN"），但一旦写进 MySQL
	// 就会变成怪值或直接被拒，所以在这里统一挡掉。
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return problem(path, "不是有效数字")
	}
	if nonNegative && f < 0 {
		return problem(path, "不能为负数")
	}
	if maxAbs > 0 && math.Abs(f) > maxAbs {
		return problem(path, "数值超出合理范围")
	}

	return nil
}

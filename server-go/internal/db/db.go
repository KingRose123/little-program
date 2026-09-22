// Package db 负责 MySQL 连接与表结构初始化。
//
// 设计取向与旧版 db.js 一致的地方（这些是踩过坑才定下来的，值得保留）：
//   - 建库、建表全部由代码自己完成，部署时不需要人工先执行 SQL；
//   - 结构初始化只在首次用到时跑一次，失败后允许下次请求重试
//     （一次网络抖动不该让进程永久卡死）；
//   - 连接池很小（5 条）：这是个小用户的记账应用，连接开大了只是白占内存。
//
// 不同之处：
//   - 列名迁移那套（renameColumnIfExists / ensureColumnIfExists）已经删掉。
//     它是为「uid 曾经叫 openid」那段历史准备的，新结构没有这段历史；
//     以后的结构变更走 schema_version 版本号。
//   - 建表语句放在 schema.sql 里内嵌进二进制，而不是拼在 Go 字符串里 ——
//     DDL 单独成文件才方便 review 和 diff。
package db

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-sql-driver/mysql"

	"xiji/api/internal/config"
)

//go:embed schema.sql
var schemaSQL string

//go:embed migrations.sql
var migrationsSQL string

// DB 包着连接池，并保证「建库 + 建表」只做一次。
type DB struct {
	cfg  *config.Config
	pool *sql.DB

	once  sync.Once
	ready error
}

// Open 只建立结构体，不碰网络。真正的连接推迟到第一次 Query 时（ensureReady）。
// 这样进程能先起来并对外提供 /api/health（用来排查「连不上库」），
// 而不是在 main 里直接 panic 掉、连日志都看不到。
func Open(cfg *config.Config) *DB {
	return &DB{cfg: cfg}
}

// Pool 返回已就绪的连接池。所有仓储方法都从这里拿。
func (d *DB) Pool(ctx context.Context) (*sql.DB, error) {
	if err := d.ensureReady(ctx); err != nil {
		return nil, err
	}
	return d.pool, nil
}

func (d *DB) ensureReady(ctx context.Context) error {
	d.once.Do(func() {
		d.ready = d.bootstrap(ctx)
	})
	if d.ready != nil {
		// 初始化失败要允许下次重试，否则一次抖动之后这个进程就废了
		d.once = sync.Once{}
	}
	return d.ready
}

// Close 供进程优雅退出时调用。
func (d *DB) Close() error {
	if d.pool == nil {
		return nil
	}
	return d.pool.Close()
}

func (d *DB) bootstrap(ctx context.Context) error {
	// 1) 先连到「不指定库」的地址，把库建出来。
	//    这一步不能省：全新的服务器上 xiji 这个库还不存在，
	//    直接按库名连会得到 Unknown database。
	if err := d.createDatabase(ctx); err != nil {
		return fmt.Errorf("建库失败: %w", err)
	}

	// 2) 建连接池
	pool, err := sql.Open("mysql", d.cfg.DSN)
	if err != nil {
		return fmt.Errorf("打开连接池失败: %w", err)
	}
	// 连接池大小。
	//
	// 原来写的是 5，那是按「只有用户请求在用连接」估的 —— 但影子表
	// （shadow）用的是**同一个池**，而它最多允许 8 个同步任务并行
	// （shadow.Service.syncSem = 8）。也就是说光影子表自己就能把 5 条全占满，
	// 用户请求只能排队等连接 —— 外观上表现为「偶尔整个 App 转圈」，
	// 而日志里什么都没有（等待连接不打日志），极难定位。
	//
	// 25 是按「影子表 8 条 + 用户请求十几条并发」定的，留了一倍余量。
	// 注意这是**每个实例**的连接数：将来多实例部署时，
	// 实例数 × 25 不能超过 MySQL 的 max_connections（默认 151）。
	pool.SetMaxOpenConns(25)
	// 空闲连接留 10 条就够：留满 25 会在低峰期白占 MySQL 的资源，
	// 留太少又会让每个请求都要重新握手。
	pool.SetMaxIdleConns(10)
	// 连接寿命比 MySQL 的 wait_timeout 短，避免拿到已被服务端断开的连接
	pool.SetConnMaxLifetime(30 * time.Minute)

	if err := pool.PingContext(ctx); err != nil {
		pool.Close()
		return fmt.Errorf("连接数据库失败: %w", err)
	}
	d.pool = pool

	// 3) 结构：先跑幂等的建表语句，再执行带版本号的变更
	if err := d.ensureSchema(ctx, pool); err != nil {
		pool.Close()
		d.pool = nil
		return fmt.Errorf("初始化表结构失败: %w", err)
	}
	if err := d.runMigrations(ctx, pool); err != nil {
		pool.Close()
		d.pool = nil
		return fmt.Errorf("执行结构变更失败: %w", err)
	}

	return nil
}

func (d *DB) createDatabase(ctx context.Context) error {
	conn, err := sql.Open("mysql", d.cfg.DSNWithoutDatabase())
	if err != nil {
		return err
	}
	defer conn.Close()

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	// 库名来自环境变量而非用户输入，但仍然自己校验一遍：
	// 库名没法用占位符传，只能拼进 SQL。
	if !validIdentifier(d.cfg.DBName) {
		return fmt.Errorf("库名不合法: %q", d.cfg.DBName)
	}

	stmt := fmt.Sprintf(
		"CREATE DATABASE IF NOT EXISTS `%s` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
		d.cfg.DBName,
	)
	_, err = conn.ExecContext(ctx, stmt)
	return err
}

// ensureSchema 按 `;` 切分 schema.sql 逐条执行。
//
// 全部语句都是 CREATE TABLE IF NOT EXISTS / INSERT IGNORE，天然幂等，
// 所以不需要额外记录「哪些执行过」——直接每次都跑一遍即可，
// 有新表时它会补建，已有表时它什么都不做。
//
// **只放幂等语句**。ALTER TABLE 之类要写进 migrations.sql，
// 那张表里的语句不幂等，得按版本号精确执行一次。
func (d *DB) ensureSchema(ctx context.Context, pool *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	for _, stmt := range splitStatements(schemaSQL) {
		if _, err := pool.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("执行失败: %s\n%w", firstLine(stmt), err)
		}
	}
	return nil
}

/* ---------------- 带版本号的结构变更 ---------------- */

// migration 是一条带版本的结构变更。
type migration struct {
	version int
	desc    string
	stmt    string
}

// migrationMark 匹配版本标记行：`-- @version 2 : 说明`。
//
// 要求 `--` 之后**直接**跟 @version，就是为了避开一个坑：
// migrations.sql 的文件头注释里写了这个格式的**示例**，
// 如果正则宽松一点（允许中间有别的注释符号），那段示例会被当成真迁移执行。
// 示例里也刻意用 `N` 而不是数字，双保险。
var migrationMark = regexp.MustCompile(`(?m)^--[ \t]*@version[ \t]+(\d+)[ \t]*:?[ \t]*(.*)$`)

// parseMigrations 把 migrations.sql 切成一条条带版本的语句。
//
// 顺序很关键：**先按标记切分，再剥注释**。反过来的话标记行会被当注释删掉，
// 就再也找不到每条语句属于哪个版本了（schema.sql 那边踩过对称的坑）。
func parseMigrations(src string) []migration {
	locs := migrationMark.FindAllStringSubmatchIndex(src, -1)

	var out []migration
	for i, loc := range locs {
		ver, err := strconv.Atoi(src[loc[2]:loc[3]])
		if err != nil {
			continue
		}
		desc := strings.TrimSpace(src[loc[4]:loc[5]])

		// 本条的内容：从标记行之后，到下一个标记之前
		start := loc[1]
		end := len(src)
		if i+1 < len(locs) {
			end = locs[i+1][0]
		}

		// 一个版本下允许写多条语句
		for _, stmt := range splitStatements(stripComments(src[start:end])) {
			out = append(out, migration{version: ver, desc: desc, stmt: stmt})
		}
	}
	return out
}

// runMigrations 执行版本号大于当前库的迁移。
//
// 为什么不和 ensureSchema 合成一个循环：那批语句每次启动都重跑，
// 而这批必须**只跑一次** —— ALTER TABLE ADD COLUMN 第二次执行会直接报
// Duplicate column name（MySQL 没有 ADD COLUMN IF NOT EXISTS），
// 合在一起就意味着要么每次启动都炸，要么得放个兜底把真错误也吞掉。
func (d *DB) runMigrations(ctx context.Context, pool *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	var cur int
	if err := pool.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version), 0) FROM schema_version`,
	).Scan(&cur); err != nil {
		return fmt.Errorf("读取结构版本失败: %w", err)
	}

	applied := 0
	latest := cur

	for _, m := range parseMigrations(migrationsSQL) {
		if m.version <= cur {
			continue
		}

		if _, err := pool.ExecContext(ctx, m.stmt); err != nil {
			// 「已经存在」不算失败：MySQL 的 DDL 是**隐式提交**的，
			// 上一次执行成功、但记录版本那一步失败时，回滚已经不可能。
			// 再跑一次就会撞 Duplicate column name —— 而这个报错恰恰说明
			// 结构已经改好了，应该补上版本记录继续走，而不是让服务再也起不来。
			if !isDuplicateErr(err) {
				return fmt.Errorf("v%d 执行失败: %s\n%w", m.version, firstLine(m.stmt), err)
			}
			log.Printf("[db] v%d 的目标已存在，按已执行处理", m.version)
		}

		if _, err := pool.ExecContext(ctx,
			`INSERT IGNORE INTO schema_version (version, description, applied_at) VALUES (?, ?, NOW())`,
			m.version, m.desc,
		); err != nil {
			return fmt.Errorf("记录版本 v%d 失败: %w", m.version, err)
		}

		applied++
		if m.version > latest {
			latest = m.version
		}
	}

	if applied > 0 {
		log.Printf("[db] 已执行 %d 条结构变更，版本 %d → %d", applied, cur, latest)
	}
	return nil
}

// isDuplicateErr 判断错误是不是「目标已经存在」。
//
// 只有这一类能被当成成功：它意味着上一次其实改成功了，只是没来得及记账。
// 其余错误（权限不足、磁盘满、语法错）都必须原样抛出。
func isDuplicateErr(err error) bool {
	var me *mysql.MySQLError
	if !errors.As(err, &me) {
		return false
	}
	switch me.Number {
	case 1050, // Table already exists
		1060, // Duplicate column name
		1061, // Duplicate key name
		1091: // Can't DROP ...; check that column/key exists
		return true
	}
	return false
}

// splitStatements 按分号切分 SQL。
//
// 顺序很关键：**先剥注释，再切分**。反过来写的话，
// 注释里出现的一个半角分号就会把注释拦腰截断 ——
// 后半截不以 `--` 开头（剥注释时不会被删掉），又会粘到下一句 SQL 前面，
// 拼出一段语法非法的语句，而且 MySQL 报的错指向的是**下一句**，极难定位。
// （这个坑在第一次写完就踩到了，所以顺序写在注释里提醒。）
func splitStatements(src string) []string {
	var out []string
	for _, raw := range strings.Split(stripComments(src), ";") {
		stmt := strings.TrimSpace(raw)
		if stmt == "" {
			continue
		}
		out = append(out, stmt)
	}
	return out
}

// stripComments 逐行去掉 `--` 开头的整行注释。
// 只处理整行注释，不处理行尾注释 —— 因为 DDL 里 COMMENT '...' 是合法内容，
// 如果去匹配行尾的 `--`，遇到值里带 `--` 的注释文本就会切错。
func stripComments(chunk string) string {
	var b strings.Builder
	for _, line := range strings.Split(chunk, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), "--") {
			continue
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimSpace(b.String())
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func validIdentifier(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		default:
			return false
		}
	}
	return true
}

// IsDuplicate 判断是不是唯一键冲突（MySQL 错误码 1062）。
//
// 注册重名、并发建号都要靠它区分「可预期的业务冲突」与「真的出故障了」——
// 前者要给用户一句人话，后者要记日志并回 500，两者的处理完全不同。
func IsDuplicate(err error) bool {
	var me *mysql.MySQLError
	return errors.As(err, &me) && me.Number == 1062
}

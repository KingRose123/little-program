package db

import (
	"strings"
	"testing"
)

// 真实的 migrations.sql 必须能解析出预期的版本与语句。
// 解析错了**不会报错**，只会静默不执行 —— 那是最难发现的一类问题：
// 服务正常起来了，但列根本没加上，直到某个功能用不了才暴露。
func TestParseRealMigrationsFile(t *testing.T) {
	ms := parseMigrations(migrationsSQL)
	if len(ms) == 0 {
		t.Fatal("migrations.sql 里应当至少解析出一条语句")
	}

	for _, m := range ms {
		// v1 是 schema.sql 里的结构基线，migrations.sql 必须从 2 起 ——
		// 写出 1 会让「基线那条永远被跳过」，版本号语义也乱了
		if m.version < 2 {
			t.Fatalf("migrations.sql 的版本号应当 ≥2，出现了 v%d", m.version)
		}
		if m.stmt == "" {
			t.Fatalf("v%d 解析出了空语句", m.version)
		}
		if m.desc == "" {
			t.Errorf("v%d 缺少说明文字（标记行应写成 '-- @version N : 说明'）", m.version)
		}
	}
}

// 文件头注释里写了标记格式的**示例**。它绝不能被当成真迁移 ——
// 否则每次启动都会去执行一段注释里的 SQL，多半直接报语法错。
func TestHeaderExampleIsNotParsedAsMigration(t *testing.T) {
	src := `
-- 写法：
--   -- @version N : 一句话说明
--   ALTER TABLE foo ADD COLUMN bar INT;

-- @version 7 : 真迁移
ALTER TABLE real_table ADD COLUMN real_col INT;
`
	ms := parseMigrations(src)
	if len(ms) != 1 {
		t.Fatalf("只应解析出 1 条真迁移，实际 %d 条：%+v", len(ms), ms)
	}
	if ms[0].version != 7 {
		t.Fatalf("版本应为 7，实际 %d", ms[0].version)
	}
	if !strings.Contains(ms[0].stmt, "real_table") {
		t.Fatalf("解析出的语句不对：%q", ms[0].stmt)
	}
}

// 一个版本下允许写多条语句（加列 + 加索引是最常见的一组）。
func TestMultipleStatementsPerVersion(t *testing.T) {
	src := `
-- @version 3 : 两条语句
ALTER TABLE a ADD COLUMN x INT;
ALTER TABLE a ADD INDEX idx_x (x);
`
	ms := parseMigrations(src)
	if len(ms) != 2 {
		t.Fatalf("应解析出 2 条语句，实际 %d", len(ms))
	}
	for _, m := range ms {
		if m.version != 3 {
			t.Fatalf("两条都属于 v3，实际 v%d", m.version)
		}
		if m.desc != "两条语句" {
			t.Errorf("说明应当被带上，实际 %q", m.desc)
		}
	}
}

// 标记行本身不能被当成 SQL 执行。
func TestMarkerLineIsStripped(t *testing.T) {
	ms := parseMigrations("-- @version 2 : x\nALTER TABLE a ADD COLUMN y INT;\n")
	if len(ms) != 1 {
		t.Fatalf("应解析出 1 条，实际 %d", len(ms))
	}
	if strings.Contains(ms[0].stmt, "@version") {
		t.Fatalf("标记行不该出现在语句里：%q", ms[0].stmt)
	}
}

// 版本号不连续也要能处理（比如 v3 被放弃了）。
func TestNonContiguousVersions(t *testing.T) {
	src := `
-- @version 2 : 二
ALTER TABLE a ADD COLUMN b INT;

-- @version 5 : 五
ALTER TABLE a ADD COLUMN c INT;
`
	ms := parseMigrations(src)
	if len(ms) != 2 {
		t.Fatalf("应解析出 2 条，实际 %d", len(ms))
	}
	if ms[0].version != 2 || ms[1].version != 5 {
		t.Fatalf("版本号应原样保留，实际 %d 与 %d", ms[0].version, ms[1].version)
	}
}

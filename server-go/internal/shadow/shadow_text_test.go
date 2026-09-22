package shadow

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// 影子表按**字符**截断，不能把一个多字节字符切成两半。
//
// max 对应 MySQL 的 VARCHAR(n)，数的是字符；而 s[:max] 数的是字节 ——
// 切在中间会留下无效 UTF-8，写库时要么报错、要么存成乱码。
// 中文一个字 3 字节，差得尤其明显。
func TestTextTruncatesByRune(t *testing.T) {
	// 100 个中文字 = 300 字节，限 10 字符 → 留 10 个字
	got := text(strings.Repeat("好", 100), 10)
	if got != strings.Repeat("好", 10) {
		t.Fatalf("应按字符截断，实际: %q", got)
	}
	if !utf8.ValidString(got) {
		t.Fatalf("截断后不是合法 UTF-8: %q", got)
	}

	// 未超限时原样保留
	if got := text("海澜之家", 64); got != "海澜之家" {
		t.Fatalf("未超限不应改动，实际: %q", got)
	}

	// 非字符串走 toString（快照 JSON 解析出来的数字是 float64），同样按字符
	if got := text(float64(12345), 3); got != "123" {
		t.Fatalf("数字应按字符截断，实际: %q", got)
	}

	// 缺失 / 空值照旧
	if got := text(nil, 10); got != "" {
		t.Fatalf("nil 应为空串，实际: %q", got)
	}
}

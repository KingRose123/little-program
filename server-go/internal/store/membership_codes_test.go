package store

import (
	"strings"
	"testing"
)

func TestCodeWhereEmpty(t *testing.T) {
	where, args := codeWhere(CodeFilter{})
	if where != "" || len(args) != 0 {
		t.Fatalf("没有筛选条件时不该产生 WHERE，实际 %q %v", where, args)
	}
}

func TestCodeWhereStatus(t *testing.T) {
	cases := []struct {
		status string
		want   string
	}{
		{"unused", "used_by IS NULL"},
		{"used", "used_by IS NOT NULL"},
		{"", ""},
		// 认不出的值按「全部」处理：宁多给几条，也不要因为客户端写错
		// 一个单词就返回空列表，让用户以为码丢了
		{"whatever", ""},
	}

	for _, c := range cases {
		where, _ := codeWhere(CodeFilter{Status: c.status})
		if c.want == "" {
			if where != "" {
				t.Errorf("status=%q 不该产生条件，实际 %q", c.status, where)
			}
			continue
		}
		if !strings.Contains(where, c.want) {
			t.Errorf("status=%q 应含 %q，实际 %q", c.status, c.want, where)
		}
	}
}

func TestCodeWhereCombines(t *testing.T) {
	where, args := codeWhere(CodeFilter{Batch: "20260922", Status: "unused"})

	if !strings.Contains(where, "batch_no = ?") {
		t.Fatalf("应含批次条件，实际 %q", where)
	}
	if !strings.Contains(where, "used_by IS NULL") {
		t.Fatalf("应含状态条件，实际 %q", where)
	}
	if !strings.Contains(where, " AND ") {
		t.Fatalf("多个条件应当用 AND 连接，实际 %q", where)
	}
	if len(args) != 1 || args[0] != "20260922" {
		t.Fatalf("批次号应作为占位符参数传出，实际 %v", args)
	}
}

// 批次号来自查询串，是外部输入。它必须**只作为参数**传递，
// 绝不能拼进 SQL 文本 —— 否则这个后台接口就是一个注入口。
func TestCodeWhereNeverInlinesValues(t *testing.T) {
	evil := `2026' OR 1=1 -- `
	where, args := codeWhere(CodeFilter{Batch: evil})

	if strings.Contains(where, "OR 1=1") || strings.Contains(where, evil) {
		t.Fatalf("批次号被拼进了 SQL 文本：%q", where)
	}
	if len(args) != 1 || args[0] != evil {
		t.Fatalf("批次号应原样作为参数传递，实际 %v", args)
	}
	// 结构本身要固定：条件数量不随输入变化
	if where != " WHERE batch_no = ?" {
		t.Fatalf("SQL 结构应恒定，实际 %q", where)
	}
}

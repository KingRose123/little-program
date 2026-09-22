package ratelimit

import (
	"sync"
	"testing"
	"time"
)

// newTest 造一个时间可控的限流器：now 是假的，测试不用真的 sleep。
// 返回 *time.Time 让测试能直接把时间往前推。
func newTest(perMinute, burst int) (*Limiter, *time.Time) {
	now := time.Unix(0, 0)
	l := New(perMinute, burst)
	l.now = func() time.Time { return now }
	return l, &now
}

func TestAllowConsumesTokens(t *testing.T) {
	l, _ := newTest(60, 3) // 桶容量 3

	for i := 1; i <= 3; i++ {
		if !l.Allow("a") {
			t.Fatalf("第 %d 次应当放行", i)
		}
	}
	if l.Allow("a") {
		t.Fatal("第 4 次应当被拦下")
	}
}

func TestRefillsOverTime(t *testing.T) {
	l, now := newTest(60, 1) // 每 60 秒补 1 个，桶容量 1

	if !l.Allow("a") {
		t.Fatal("第一次应放行")
	}
	if l.Allow("a") {
		t.Fatal("同一时刻的第二次应被拦下")
	}

	// 推进 1 秒：60/分钟 = 每秒补 1 个
	*now = now.Add(time.Second)
	if !l.Allow("a") {
		t.Fatal("过 1 秒应补回 1 个令牌")
	}
}

// 令牌最多补到桶容量，不会越攒越多 ——
// 否则一个用户离线一天后回来，就能一次性打出远超配额的量。
func TestRefillCapsAtBurst(t *testing.T) {
	l, now := newTest(60, 2)

	l.Allow("a")
	l.Allow("a")
	if l.Allow("a") {
		t.Fatal("应当已被限流")
	}

	*now = now.Add(time.Hour)

	if !l.Allow("a") || !l.Allow("a") {
		t.Fatal("长时间后应补满到桶容量")
	}
	if l.Allow("a") {
		t.Fatal("补满后只应有 burst 个，不该更多")
	}
}

// 按 key 隔离是限流的**核心**：一个人刷爆不能影响别人。
// 做成一个全局桶的话，攻击者一次刷满就等于让所有人一起被限 ——
// 那比不限流还糟。
func TestKeysAreIsolated(t *testing.T) {
	l, _ := newTest(60, 1)

	if !l.Allow("a") {
		t.Fatal("a 第一次应放行")
	}
	if l.Allow("a") {
		t.Fatal("a 第二次应被拦下")
	}
	if !l.Allow("b") {
		t.Fatal("b 不该受 a 的影响")
	}
}

// 取不到 key 时必须放行：不能因为认不出调用方，
// 就把「限流配置有问题」升级成「整站不可用」。
func TestEmptyKeyAlwaysAllowed(t *testing.T) {
	l, _ := newTest(60, 1)
	for i := 0; i < 10; i++ {
		if !l.Allow("") {
			t.Fatal("空 key 应当始终放行")
		}
	}
}

func TestCleanupRemovesStaleBuckets(t *testing.T) {
	l, now := newTest(60, 1)

	l.Allow("old")
	*now = now.Add(bucketTTL + time.Minute)
	l.Allow("new") // 此刻 "old" 已经过期

	l.mu.Lock()
	l.cleanupLocked(*now)
	l.mu.Unlock()

	if l.Size() != 1 {
		t.Fatalf("过期桶应被清掉，实际剩 %d 个", l.Size())
	}
}

// perMinute 传 0 或负数时要兜底，不能变成「永不补充」（等于永久封禁）
// 或「除以零」。
func TestNewSaneDefaults(t *testing.T) {
	l := New(60, 0)
	if l.burst != 60 {
		t.Fatalf("burst 缺省应等于 perMinute，实际 %v", l.burst)
	}

	l2 := New(0, 0)
	if !(l2.rate > 0) {
		t.Fatalf("perMinute 非法时应兜底成正数，实际 %v", l2.rate)
	}
	if !l2.Allow("x") {
		t.Fatal("兜底后仍应能放行第一次请求")
	}
}

// 多个 goroutine 同时打同一个 key 时，发出的令牌不能超过桶容量 ——
// 这是并发正确性的底线（配合 -race 跑）。
func TestConcurrentAllowIsSafe(t *testing.T) {
	l := New(6000, 100) // 桶容量 100

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		allow int
	)
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				if l.Allow("k") {
					mu.Lock()
					allow++
					mu.Unlock()
				}
			}
		}()
	}
	wg.Wait()

	if allow > 100 {
		t.Fatalf("放行数不应超过桶容量 100，实际 %d", allow)
	}
	if allow == 0 {
		t.Fatal("至少应当放行一些")
	}
}

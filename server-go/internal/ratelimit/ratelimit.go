// Package ratelimit 是进程内的令牌桶限流。
//
// 为什么是进程内、而不是 Redis：
// 这套后端目前是单实例（行情缓存、影子表的串行锁都在进程内存里），
// 为了限流再拖一个 Redis 进来，运维成本远大于收益。
// 代价是**多实例时每个实例各限一份**，真实额度 = 配置值 × 实例数 ——
// 将来真要多实例，把这个包换成 Redis 实现即可，调用方一行不用改。
//
// 它保护的主要是**公开接口**：行情那几条不校验登录，任何人拿到 URL 都能打，
// 而它们背后是东财的免费接口（按**出口 IP** 限流）。
// 被刷的后果不是「他一个人变慢」，而是**所有用户一起拿不到行情** ——
// 所以这里挡的不是资源滥用，是可用性。
package ratelimit

import (
	"sync"
	"time"
)

// Limiter 是一组按 key 隔离的令牌桶。
//
// key 用什么由调用方定：公开接口用客户端 IP，登录后的接口用 uid。
// 按 key 隔离是必须的 —— 一个全局桶意味着「一个人刷爆，所有人陪着一起被限」，
// 那比不限还糟。
type Limiter struct {
	rate  float64 // 每秒补充多少令牌
	burst float64 // 桶容量：允许一口气冲到多少

	mu      sync.Mutex
	buckets map[string]*bucket

	// now 可注入，测试里就不用真的 sleep 等时间流逝。
	now func() time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

const (
	// 桶数量超过它就顺手清一次。清理是**被动**触发的，不需要后台 goroutine，
	// 也就不存在「忘了停协程」这种泄漏。
	cleanupThreshold = 4096

	// 超过这个时长没动过的桶会被删掉。取值要**大于**一个正常用户重新访问的
	// 间隔：取得太小会把他当成新用户、白送一整桶令牌，限流就形同虚设。
	bucketTTL = 10 * time.Minute
)

// New 建一个限流器。
//
//	perMinute 每分钟允许的请求数（即令牌补充速率）
//	burst     允许的瞬时突发量；<=0 时取 perMinute
func New(perMinute, burst int) *Limiter {
	if perMinute < 1 {
		perMinute = 1
	}
	if burst <= 0 {
		burst = perMinute
	}
	return &Limiter{
		rate:    float64(perMinute) / 60.0,
		burst:   float64(burst),
		buckets: make(map[string]*bucket),
		now:     time.Now,
	}
}

// Allow 尝试取一个令牌。返回 false 表示这个 key 请求得太快了。
func (l *Limiter) Allow(key string) bool {
	if key == "" {
		// 取不到 key（比如认不出客户端 IP）时**放行**。
		//
		// 这是个刻意的取舍：限流是为了保可用性，不能因为识别不出调用方
		// 反而把正常用户挡在门外 —— 那等于把「限流配置有问题」
		// 升级成「整站不可用」。少一层保护，好过自己制造故障。
		return true
	}

	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.buckets) > cleanupThreshold {
		l.cleanupLocked(now)
	}

	b := l.buckets[key]
	if b == nil {
		// 新 key 从**满桶**开始：用户第一次访问不该被限。
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}

	// 按流逝的时间补令牌，补到桶容量为止
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * l.rate
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// cleanupLocked 删掉久未使用的桶。调用方必须已持锁。
func (l *Limiter) cleanupLocked(now time.Time) {
	for k, b := range l.buckets {
		if now.Sub(b.last) > bucketTTL {
			delete(l.buckets, k)
		}
	}
}

// Size 当前跟踪的 key 数量。测试与排查用 ——
// 它持续增长说明清理没生效，那是内存泄漏。
func (l *Limiter) Size() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}

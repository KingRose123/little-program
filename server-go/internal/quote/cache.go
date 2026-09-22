package quote

import (
	"fmt"
	"sort"
	"sync"
	"time"
)

/*
进程内缓存，带「单飞」（single-flight）。

为什么需要单飞：一个用户打开持仓页会一次请求十几只标的，
十个用户同时刷新就是上百个请求，而其中大量是**同一只票的同一个 key**。
没有单飞的话每只票都要打一次上游，东方财富那边很快会开始限流 ——
它的免费接口是按出口 IP 限的，一旦被限，所有用户一起受影响。

所以这里的规则是：同一个 key 的并发请求合并成一次上游调用，其他等结果。

为什么用进程内缓存而不是 Redis：
  1. 行情数据的价值衰减极快（15 秒 TTL），多实例共享的收益很小；
  2. 少一个依赖少一处故障点 —— 这个服务是给自己的服务器部署的，
     Redis 挂了不该让行情整体不可用。
将来真要多实例部署时，把 cache 换成接口实现即可。
*/

const cacheMaxEntries = 3000

type cacheEntry struct {
	val interface{}
	exp time.Time
}

// flightCall 是一次正在进行的加载。等待者只等 done，然后直接读 val/err。
//
// 注意 val 是**共享**的：调用方拿到后不能再改它（比如往切片里 append）。
// 目前所有缓存值都是不可变的结构体或新建的切片，没有这个问题。
type flightCall struct {
	done chan struct{}
	val  interface{}
	err  error
}

type cache struct {
	mu     sync.Mutex
	data   map[string]*cacheEntry
	flight map[string]*flightCall
}

func newCache() *cache {
	return &cache{
		data:   make(map[string]*cacheEntry),
		flight: make(map[string]*flightCall),
	}
}

// do 取缓存；未命中则调 load 并写入。
//
// 空结果（nil）**不写缓存** —— 这一条很重要：上游偶尔会返回空
// （限流、临时故障、不存在的代码），如果把它缓存下来，
// 用户会连续几分钟看到「查不到」，而我们连重试的机会都没有。
//
// 收尾逻辑全部放在 defer 里，并且带 recover。这不是防御性编程的洁癖：
// 加载路径要解析上游返回的 JSON、做正则匹配、按字段取值，
// 任何一处 slice 越界或类型断言失败都会 panic。
// 如果收尾写在函数体末尾，panic 一旦发生，flight 里的条目就永远删不掉、
// done 也永远不会被关闭 —— 之后凡是请求这只票的 goroutine 都会永久阻塞在
// <-f.done 上。一个偶发的解析错误，会被放大成「这只票的行情永久不可用」，
// 而且是静默的（没有错误日志，只是请求一直不返回）。
func (c *cache) do(key string, ttl time.Duration, load func() (interface{}, error)) (val interface{}, err error) {
	now := time.Now()

	c.mu.Lock()
	if e, ok := c.data[key]; ok && now.Before(e.exp) {
		c.mu.Unlock()
		return e.val, nil
	}
	if f, ok := c.flight[key]; ok {
		c.mu.Unlock()
		<-f.done
		return f.val, f.err
	}
	f := &flightCall{done: make(chan struct{})}
	c.flight[key] = f
	c.mu.Unlock()

	defer func() {
		if rec := recover(); rec != nil {
			// 把 panic 转成普通错误：调用方拿到 502 并降级直连，
			// 而不是整个进程被带走。
			f.val, f.err = nil, fmt.Errorf("处理行情数据时出错: %v", rec)
		}

		c.mu.Lock()
		delete(c.flight, key)
		if f.err == nil && f.val != nil {
			c.data[key] = &cacheEntry{val: f.val, exp: time.Now().Add(ttl)}
			c.pruneLocked()
		}
		c.mu.Unlock()

		// 必须在上面的写入之后关闭：等待者被唤醒时缓存已经就绪，
		// 它紧接着的请求就能直接命中，不会又打一次上游。
		close(f.done)

		// 让本函数的返回值与等待者看到的完全一致（panic 分支也要一致）
		val, err = f.val, f.err
	}()

	// 加载期间不持锁：上游可能慢到几秒，持锁会让整个缓存变成串行的
	f.val, f.err = load()
	return f.val, f.err
}

// pruneLocked 在条数超限时收缩。调用方必须持锁。
func (c *cache) pruneLocked() {
	if len(c.data) <= cacheMaxEntries {
		return
	}

	// 先清过期的：这类应用里绝大多数条目其实已经过期，只是没人来取
	now := time.Now()
	for k, e := range c.data {
		if now.Before(e.exp) {
			continue
		}
		delete(c.data, k)
	}
	if len(c.data) <= cacheMaxEntries {
		return
	}

	// 还超限就只能按到期时间淘汰最旧的一批。
	// 用 exp 排序近似插入顺序：同一类数据的 TTL 相同，exp 的先后就是写入的先后。
	type kv struct {
		k string
		t time.Time
	}
	all := make([]kv, 0, len(c.data))
	for k, e := range c.data {
		all = append(all, kv{k, e.exp})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t.Before(all[j].t) })

	drop := len(all) / 4
	for i := 0; i < drop; i++ {
		delete(c.data, all[i].k)
	}
}

// clean 清掉全部已过期条目，返回删除数与剩余数。
func (c *cache) clean() (int, int) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	dropped := 0
	for k, e := range c.data {
		if now.Before(e.exp) {
			continue
		}
		delete(c.data, k)
		dropped++
	}
	return dropped, len(c.data)
}

type cacheStats struct {
	Backend  string `json:"backend"`
	Size     int    `json:"size"`
	Max      int    `json:"max"`
	InFlight int    `json:"inflight"`
}

func (c *cache) stats() cacheStats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return cacheStats{
		Backend:  "memory",
		Size:     len(c.data),
		Max:      cacheMaxEntries,
		InFlight: len(c.flight),
	}
}

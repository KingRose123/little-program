const db = require('./db.js')
const quote = require('./quote.js')

/**
 * 定时任务
 *
 * 云托管没有控制台级的定时调度，官方做法是容器内跑 crond
 * （见 docker-entrypoint.sh），到点用 curl 打下面这些接口。
 * 走 HTTP 而不是直接跑脚本，是因为：
 *   1. 预热必须发生在「正在服务的那个进程」里，另起进程等于换了一份内存缓存；
 *   2. 换成 Redis 之后缓存虽然是共享的，但 HTTP 这条路一样通，不用改。
 */

// 单次预热最多扫多少个用户，防止用户量上来后一次任务跑太久
const MAX_USERS = 5000

/**
 * 预热行情缓存：把所有用户持仓涉及的标的刷一遍。
 * 用户白天打开持仓页时基本就是缓存命中，不用再等上游。
 */
async function warmQuotes() {
  const started = Date.now()
  const pool = await db.ensureReady()
  // payload 是整份用户数据，这里只取出来解析持仓，不落库、不改写
  const [rows] = await pool.query('SELECT payload FROM user_state LIMIT ?', [MAX_USERS])

  const seen = {}
  const items = []
  let broken = 0

  rows.forEach((row) => {
    let data = null
    try {
      data = JSON.parse(row.payload)
    } catch (e) {
      // 单条坏数据跳过，不能让整批任务失败
      broken++
      return
    }

    const holdings = data && data.holdings
    if (!(holdings instanceof Array)) return

    holdings.forEach((h) => {
      const code = String((h && h.code) || '').trim().toUpperCase()
      if (!code) return

      const market = String((h && h.market) || '').trim()
      const key = market + ':' + code
      // 去重：同一只票被多个用户持有只刷一次
      if (seen[key]) return
      seen[key] = true
      items.push({ code, market, secid: String((h && h.secid) || '') })
    })
  })

  let warmed = 0
  const failed = []

  // 分批串行：对上游温柔一点，失败也不中断后面的批次
  for (let i = 0; i < items.length; i += quote.MAX_BATCH) {
    const chunk = items.slice(i, i + quote.MAX_BATCH)
    const map = await quote.fetchDetails(chunk).catch(() => ({}))

    chunk.forEach((it) => {
      const hit = map[quote.batchKey(it)]
      if (hit && hit.quote) warmed++
      else failed.push(quote.batchKey(it))
    })
  }

  return {
    users: rows.length,
    brokenUsers: broken,
    codes: items.length,
    warmed,
    failedCount: failed.length,
    // 只回前 20 个失败项，避免日志里刷屏
    failed: failed.slice(0, 20),
    elapsedMs: Date.now() - started,
    cache: quote.cacheStats()
  }
}

module.exports = { warmQuotes }

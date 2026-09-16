/**
 * 行情代理：东方财富公开接口 + 缓存（内存 / Redis 可切换）
 *
 * 搬到服务端解决三件事：
 *   1. 小程序端不用再把东财那四个域名加进 request 合法域名；
 *   2. 所有用户共享一份缓存 —— 同一只标的在 TTL 内只打一次上游，
 *      既省请求也不容易被限流（同一 key 的并发请求还会合并成一次）；
 *      配合批量接口，持仓页 / 榜单页的客户端请求数从 2N 降到 1；
 *   3. 数据源藏在后端，以后换源只改这个文件。
 *
 * 缓存默认进程内；配了 Redis 就自动切过去，多实例共享（见「缓存后端」）。
 *
 * 解析逻辑与小程序端 utils/quote.js 保持逐字一致，
 * 只吐原始数值 + yyyy-MM-dd 日期，展示口径统一留在客户端 api.js。
 */

const HOST = {
  quote: 'https://push2.eastmoney.com',
  search: 'https://search-codetable.eastmoney.com',
  data: 'https://datacenter-web.eastmoney.com',
  fund: 'https://fund.eastmoney.com'
}

const TIMEOUT = 8000

// 东财市场号 -> 本项目市场标识
// 0 深市 / 1 沪市 / 105·106·107 美股 / 116 港股 / 150 场外基金 / 90 板块
const MARKET_BY_NO = {
  0: 'A',
  1: 'A',
  105: 'US',
  106: 'US',
  107: 'US',
  116: 'HK',
  150: 'FUND'
}

// 行情字段：最新价 / 最高 / 最低 / 今开 / 成交量 / 成交额 / 代码 / 名称 /
//           小数位 / 昨收 / 总市值 / 流通市值 / 市盈率 / 市净率 / 换手率 / 涨跌额 / 涨跌幅 / 振幅
const QUOTE_FIELDS = 'f43,f44,f45,f46,f47,f48,f57,f58,f59,f60,f116,f117,f162,f167,f168,f169,f170,f171'

// 各类数据的缓存时长。行情要「像实时」，分红记录一年才变几次
const TTL = {
  quote: 15 * 1000,
  search: 60 * 1000,
  fund: 30 * 1000,
  dividend: 12 * 3600 * 1000
}

// 单实例内存缓存上限，超了就丢掉最早的四分之一，防止长时间运行内存无限涨
const CACHE_MAX = 3000

// Redis 键前缀：与同一个实例上的其他业务隔开
const REDIS_PREFIX = 'xiji:cache:'

// 并发合并用（进程内）：Redis 也挡不住同一个实例里同时到来的重复请求
const inflight = new Map()

/* ---------------- 缓存后端 ----------------
 * 默认进程内 Map；配了 Redis 就换成 Redis，多实例之间共享一份缓存
 * （云托管扩容后每个实例各存一份，命中率会随实例数打折）。
 *
 * 识别方式（云托管开通 Redis 后会注入连接信息）：
 *   REDIS_URL                        redis://:password@host:port/0，显式指定时优先级最高
 *   REDIS_ADDRESS + REDIS_PASSWORD   云托管默认注入的连接信息
 * 都没配就自动退回内存缓存 —— 本地开发、没开 Redis 的环境都能直接跑。
 *
 * 后端契约：get / set 必须是异步的，get 未命中返回 null。
 */

function createMemoryBackend() {
  const map = new Map()

  function prune() {
    if (map.size <= CACHE_MAX) return
    const drop = Math.floor(CACHE_MAX / 4)
    let i = 0
    for (const key of map.keys()) {
      map.delete(key)
      if (++i >= drop) break
    }
  }

  return {
    name: 'memory',
    get(key) {
      const hit = map.get(key)
      if (!hit) return Promise.resolve(null)
      // 存的是绝对过期时间，读取时不需要再传 TTL
      if (hit.exp <= Date.now()) {
        map.delete(key)
        return Promise.resolve(null)
      }
      return Promise.resolve(hit.value)
    },
    set(key, value, ttl) {
      map.set(key, { exp: Date.now() + ttl, value })
      prune()
      return Promise.resolve()
    },
    clean() {
      const now = Date.now()
      let dropped = 0
      map.forEach((v, k) => {
        if (v.exp <= now) {
          map.delete(k)
          dropped++
        }
      })
      return { dropped, size: map.size }
    },
    stats() {
      return { backend: 'memory', size: map.size, max: CACHE_MAX }
    }
  }
}

function createRedisBackend(config, Redis) {
  const client = new Redis(
    Object.assign({}, config, {
      keyPrefix: REDIS_PREFIX,
      // 快速失败：Redis 抖动时不要挂住请求，也不要堆离线队列
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // 重连上限放宽到 30s 一次：Redis 恢复后不用重启容器就能接回来
      retryStrategy: (times) => Math.min(times * 500, 30000)
    })
  )

  let errors = 0
  let lastLogAt = 0

  // 日志节流：Redis 抖动时不要每个请求都刷一行日志
  function note(e) {
    errors++
    const now = Date.now()
    if (now - lastLogAt > 60000) {
      lastLogAt = now
      console.warn('[cache] Redis 异常，本次按未命中处理：', (e && e.message) || e)
    }
  }

  client.on('error', note)

  return {
    name: 'redis',
    get(key) {
      return client
        .get(key)
        .then((v) => (v ? JSON.parse(v) : null))
        .catch((e) => {
          // 失败当未命中：数据依然正确，只是多打一次上游
          note(e)
          return null
        })
    },
    set(key, value, ttl) {
      const seconds = Math.max(1, Math.ceil(ttl / 1000))
      return client.set(key, JSON.stringify(value), 'EX', seconds).catch((e) => note(e))
    },
    clean() {
      // 过期回收交给 Redis 自己（写入时带了 EX），这里只回报状态
      return { dropped: 0, size: -1, delegated: true }
    },
    stats() {
      return { backend: 'redis', errors, connected: client.status === 'ready' }
    }
  }
}

function redisConfig() {
  const url = String(process.env.REDIS_URL || '').trim()
  if (url) return { url }

  const addr = String(process.env.REDIS_ADDRESS || '').trim()
  if (!addr) return null

  // 云托管注入的是 host:port，个别环境会带 redis:// 前缀，这里都兼容
  const [host, port] = addr.replace(/^rediss?:\/\//, '').split(':')
  const password = String(process.env.REDIS_PASSWORD || '').trim()
  const username = String(process.env.REDIS_USERNAME || '').trim()

  return {
    host: host || '127.0.0.1',
    port: Number(port) || 6379,
    password: password || undefined,
    username: username || undefined
  }
}

function pickBackend() {
  const config = redisConfig()
  if (!config) return createMemoryBackend()

  try {
    // 延迟 require：这样没开 Redis、甚至没装 ioredis 的环境也能跑
    const Redis = require('ioredis')
    console.log('[cache] 使用 Redis 共享缓存')
    return createRedisBackend(config, Redis)
  } catch (e) {
    console.warn('[cache] ioredis 不可用，退回内存缓存：', (e && e.message) || e)
    return createMemoryBackend()
  }
}

const backend = pickBackend()

/**
 * 带缓存 + 并发合并的取数。
 * 同一个 key 上并发来的请求只打一次上游，其余等同一个 Promise。
 * 只缓存有效结果：失败或空结果不写缓存，下次请求会重试。
 */
function cached(key, ttl, loader) {
  const running = inflight.get(key)
  if (running) return running

  const task = backend
    .get(key)
    .then((hit) => {
      if (hit !== null && hit !== undefined) return hit
      return Promise.resolve()
        .then(loader)
        .then((value) => {
          if (value === null || value === undefined) return value
          return backend.set(key, value, ttl).then(() => value)
        })
    })
    .then((value) => {
      inflight.delete(key)
      return value
    })
    .catch((e) => {
      inflight.delete(key)
      throw e
    })

  inflight.set(key, task)
  return task
}

function cacheStats() {
  return Object.assign({ inflight: inflight.size }, backend.stats())
}

// 回收过期条目（定时任务用）。内存后端是真清理，Redis 由它自己按 EX 过期
function cleanCache() {
  return backend.clean()
}

/* ---------------- HTTP ---------------- */

async function requestText(url) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT)

  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        // 东财对没带 UA 的请求偶尔会返回空，带一个常规 UA 更稳
        'user-agent': 'Mozilla/5.0 (compatible; xiji-server/1.0)'
      }
    })
    if (!res.ok) throw { code: res.status, msg: '上游接口返回 ' + res.status }
    return await res.text()
  } catch (e) {
    if (e && e.name === 'AbortError') throw { code: 0, msg: '行情接口超时，请稍后重试' }
    if (e && e.code) throw e
    throw { code: 0, msg: (e && e.message) || '网络请求失败' }
  } finally {
    clearTimeout(timer)
  }
}

async function requestJson(url) {
  const text = await requestText(url)
  try {
    return JSON.parse(text)
  } catch (e) {
    throw { code: 0, msg: '上游返回的不是合法 JSON' }
  }
}

/* ---------------- 基础工具 ---------------- */

function num(v) {
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

// '2026-06-26 00:00:00' -> '2026-06-26'
function dateOf(v) {
  const s = String(v || '')
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : ''
}

// 时间戳 -> 'yyyy-MM-dd'
function dateOfTs(ts) {
  const d = new Date(num(ts))
  if (isNaN(d.getTime())) return ''
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

// 去掉多余小数位：280.2423 -> '280.2423'，0.3460 -> '0.346'
function trimNum(v, digits) {
  const n = num(v)
  return String(Number(n.toFixed(digits === undefined ? 4 : digits)))
}

/* ---------------- 搜索 ---------------- */

// 指数 / 板块等非个股标的过滤掉
function isTradeable(typeName) {
  const t = String(typeName || '')
  return t.indexOf('指数') === -1 && t.indexOf('板块') === -1
}

// 东财条目 -> 本项目标的；市场号直接拼 secid，不用猜沪深前缀
function toStock(item) {
  const market = MARKET_BY_NO[item.market]
  if (!market || !isTradeable(item.securityTypeName)) return null

  // 场内基金（ETF / LOF）走行情接口，场外基金走净值接口
  const isFund = String(item.securityTypeName || '').indexOf('基金') > -1
  const key = market === 'A' && isFund ? 'ETF' : market

  return {
    code: String(item.code || ''),
    name: String(item.shortName || ''),
    market: key,
    secid: market === 'FUND' ? '' : item.market + '.' + String(item.code || ''),
    typeName: item.securityTypeName || ''
  }
}

// 关键字搜索：代码、中文名、拼音首字母都能命中
function directSearch(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return Promise.resolve([])

  const url =
    HOST.search +
    '/codetable/search/web?client=web&clientType=webSuggest&clientVersion=lastest' +
    '&pageIndex=1&pageSize=20&keyword=' +
    encodeURIComponent(kw)

  return requestJson(url).then((res) => {
    const list = (res && res.result) || []
    return list.map(toStock).filter((s) => !!s)
  })
}

/* ---------------- 实时行情 ---------------- */

function toQuote(d) {
  if (!d || d.f43 === undefined || d.f43 === null || d.f43 === '-') return null

  return {
    code: String(d.f57 || ''),
    name: String(d.f58 || ''),
    price: num(d.f43),
    prevClose: num(d.f60),
    change: d.f169 === '-' ? 0 : num(d.f169),
    changeRate: d.f170 === '-' ? 0 : num(d.f170),
    open: d.f46 === '-' ? 0 : num(d.f46),
    high: d.f44 === '-' ? 0 : num(d.f44),
    low: d.f45 === '-' ? 0 : num(d.f45),
    amplitude: d.f171 === '-' ? 0 : num(d.f171),
    turnoverRate: d.f168 === '-' ? 0 : num(d.f168),
    volume: num(d.f47),
    amount: num(d.f48),
    pe: d.f162 === '-' ? 0 : num(d.f162),
    pb: d.f167 === '-' ? 0 : num(d.f167),
    marketCap: num(d.f116),
    floatCap: num(d.f117),
    digits: num(d.f59) || 2
  }
}

function quoteBySecid(secid) {
  const url = HOST.quote + '/api/qt/stock/get?secid=' + secid + '&fields=' + QUOTE_FIELDS + '&fltt=2&invt=2'
  return requestJson(url).then((res) => toQuote(res && res.data))
}

// 没有 secid 时按市场推：美股可能在纳斯达克 / 纽交所 / 美交所，逐个试
function secidCandidates(market, code) {
  const c = String(code || '').toUpperCase()
  if (!c) return []
  if (market === 'US') return ['105.' + c, '106.' + c, '107.' + c]
  if (market === 'HK') return ['116.' + c]
  if (market === 'FUND') return []
  // A股 / 场内基金：6、5、9 开头为沪市，其余归深市（含北交所）
  return [(/^[659]/.test(c) ? '1.' : '0.') + c]
}

// 行情查询：拿到行情即停，候选前缀逐个兜底
function directQuote(stock) {
  const list =
    stock && stock.secid ? [stock.secid] : secidCandidates(stock && stock.market, stock && stock.code)
  if (!list.length) return Promise.resolve(null)

  let chain = Promise.resolve(null)
  list.forEach((secid) => {
    chain = chain.then((got) => (got ? got : quoteBySecid(secid)))
  })
  return chain
}

/* ---------------- 场外基金净值 ---------------- */

function matchStr(src, key) {
  const m = src.match(new RegExp('var\\s+' + key + '\\s*=\\s*"([^"]*)"'))
  return m ? m[1] : ''
}

function matchArray(src, key) {
  const m = src.match(new RegExp(key + '\\s*=\\s*(\\[[\\s\\S]*?\\]);'))
  if (!m) return []
  try {
    return JSON.parse(m[1])
  } catch (e) {
    return []
  }
}

// 净值走势里带 unitMoney 的就是分红送配记录
function fundDividendOf(trend) {
  return trend
    .filter((p) => p && p.unitMoney && String(p.unitMoney).indexOf('派现金') > -1)
    .map((p) => {
      const m = String(p.unitMoney).match(/([\d]+(?:\.\d+)?)\s*元/)
      const dps = m ? num(m[1]) : 0
      return {
        period: dateOfTs(p.x),
        planText: String(p.unitMoney),
        dps: dps,
        exDate: dateOfTs(p.x),
        recordDate: '',
        payDate: '',
        progress: ''
      }
    })
    .filter((r) => r.dps > 0)
}

// pingzhongdata 一次给全：名称、最新净值、日涨幅、历史分红
function directFund(code) {
  return requestText(HOST.fund + '/pingzhongdata/' + code + '.js').then((src) => {
    const text = typeof src === 'string' ? src : ''
    if (!text) return null

    const trend = matchArray(text, 'Data_netWorthTrend')
    if (!trend.length) return null

    const last = trend[trend.length - 1]
    const prev = trend.length > 1 ? trend[trend.length - 2] : last
    const price = num(last.y)
    const prevClose = num(prev.y)

    return {
      quote: {
        code: String(code),
        name: matchStr(text, 'fS_name'),
        price: price,
        prevClose: prevClose,
        change: Number((price - prevClose).toFixed(4)),
        changeRate: last.equityReturn === undefined ? 0 : num(last.equityReturn),
        priceDate: dateOfTs(last.x),
        digits: 4
      },
      dividend: {
        source: '天天基金 · 基金分红',
        list: fundDividendOf(trend)
      }
    }
  })
}

/* ---------------- 分红档案 ---------------- */

function periodOf(reportDate) {
  const s = dateOf(reportDate)
  if (!s) return ''
  const year = s.slice(0, 4)
  const md = s.slice(5)
  if (md === '12-31') return year + '年报'
  if (md === '06-30') return year + '中报'
  if (md === '09-30') return year + '三季报'
  if (md === '03-31') return year + '一季报'
  return year + '年度'
}

// A股 / 场内基金：每 10 股派息（税前）
function toDividendA(r) {
  const per10 = num(r.PRETAX_BONUS_RMB)
  if (!(per10 > 0)) return null

  return {
    period: periodOf(r.REPORT_DATE),
    planText: '每 10 股派 ' + trimNum(per10) + ' 元（含税）',
    dps: per10 / 10,
    unit: '股',
    exDate: dateOf(r.EX_DIVIDEND_DATE),
    recordDate: dateOf(r.EQUITY_RECORD_DATE),
    payDate: '',
    progress: r.ASSIGN_PROGRESS || ''
  }
}

/**
 * 按「报告期」倒序取，而不是按除息日倒序。
 * 已经公告但还没实施的分红方案没有除息日（EX_DIVIDEND_DATE 为 null），
 * 按除息日倒序时 null 会排到最后，pageSize 一截就把最新方案整个丢掉。
 * 报告期（REPORT_DATE）一定有值，最新的中报 / 年报方案永远排在最前。
 */
function dividendA(code, size) {
  const url =
    HOST.data +
    '/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=' +
    encodeURIComponent('(SECURITY_CODE="' + code + '")') +
    '&pageNumber=1&pageSize=' + (size || 10) +
    '&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB'

  return requestJson(url).then((res) => {
    const rows = (res && res.result && res.result.data) || []
    return {
      source: '东方财富 · 分红送配',
      list: rows.map(toDividendA).filter((r) => !!r)
    }
  })
}

// 港股：方案原文形如「每股派港币5.3元」
function toDividendHK(r) {
  const text = String(r.PLAN_EXPLAIN || '')
  const m = text.match(/([\d]+(?:\.\d+)?)/)
  const dps = m ? num(m[1]) : 0
  if (!(dps > 0)) return null

  return {
    period: r.ASSIGN_PERIOD || '',
    planText: text,
    dps: dps,
    unit: '股',
    exDate: dateOf(r.EX_DIVIDEND_DATE),
    recordDate: dateOf(r.RECORD_DATE),
    payDate: dateOf(r.DIVIDEND_DATE),
    progress: r.ASSIGN_PROGRESS || ''
  }
}

/**
 * 港股报告里没有 REPORT_DATE，改用公告日（NOTICE_DATE）倒序：
 * 同样是为了让「刚公告、还没除息」的方案排在最前，不被 pageSize 截掉。
 */
function dividendHK(code, size) {
  const url =
    HOST.data +
    '/api/data/v1/get?reportName=RPT_HKF10_INFO_DIVIDEND&columns=ALL&filter=' +
    encodeURIComponent('(SECUCODE="' + code + '.HK")') +
    '&pageNumber=1&pageSize=' + (size || 10) +
    '&sortColumns=NOTICE_DATE&sortTypes=-1&source=WEB&client=WEB'

  return requestJson(url).then((res) => {
    const rows = (res && res.result && res.result.data) || []
    return {
      source: '东方财富 · 港股派息',
      list: rows.map(toDividendHK).filter((r) => !!r)
    }
  })
}

// 返回 null 表示这个市场没有可用的分红档案（美股），页面按「无数据」展示
function directDividend(stock, size) {
  const market = (stock && stock.market) || ''
  const n = size || 10
  if (market === 'A' || market === 'ETF') return dividendA(stock.code, n)
  if (market === 'HK') return dividendHK(stock.code, n)
  return Promise.resolve(null)
}

/* ---------------- 对外：带缓存 ---------------- */

function search(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return Promise.resolve([])
  return cached('search:' + kw, TTL.search, () => directSearch(kw))
}

function fetchQuote(stock) {
  const secids =
    stock && stock.secid
      ? [stock.secid]
      : secidCandidates(stock && stock.market, stock && stock.code)
  if (!secids.length) return Promise.resolve(null)

  // 同一个 secid 复用缓存，secid 才是真正决定取哪只标的的键
  return cached('quote:' + secids.join('|'), TTL.quote, () => directQuote(stock))
}

function fetchFund(code) {
  const c = String(code || '').trim()
  if (!c) return Promise.resolve(null)
  return cached('fund:' + c, TTL.fund, () => directFund(c))
}

function fetchDividend(stock, opts) {
  const market = (stock && stock.market) || ''
  const code = String((stock && stock.code) || '').toUpperCase()
  const size = (opts && opts.size) || 10
  if (!code) return Promise.resolve(null)

  // 美股没有分红档案；其余市场按 市场+代码+条数 缓存
  if (market !== 'A' && market !== 'ETF' && market !== 'HK') return Promise.resolve(null)
  return cached('div:' + market + ':' + code + ':' + size, TTL.dividend, () =>
    directDividend({ code, market }, size)
  )
}

// 一次取齐：实时行情 + 分红档案
function fetchDetail(stock) {
  if (!stock || !stock.code) {
    return Promise.reject({ code: 400, msg: '缺少标的代码' })
  }

  if (stock.market === 'FUND') {
    return fetchFund(stock.code).then((d) => ({
      quote: d ? d.quote : null,
      dividend: d ? d.dividend : null
    }))
  }

  return Promise.all([fetchQuote(stock), fetchDividend(stock)]).then((arr) => ({
    quote: arr[0],
    dividend: arr[1]
  }))
}

/* ---------------- 批量 ---------------- */

// 单次批量上限，防止一个请求把上游打爆
const MAX_BATCH = 60
// 批量内部的并发：上游是公开接口，压太高容易被限流
const BATCH_CONCURRENCY = 6

// 小并发限流（与小程序端同名工具保持一致的行为）
function mapLimit(list, limit, fn) {
  const src = list || []
  const out = new Array(src.length)
  let cursor = 0

  function run() {
    if (cursor >= src.length) return Promise.resolve()
    const i = cursor++
    return Promise.resolve(fn(src[i], i)).then((v) => {
      out[i] = v
      return run()
    })
  }

  const workers = []
  const n = Math.min(limit, src.length)
  for (let i = 0; i < n; i++) workers.push(run())
  return Promise.all(workers).then(() => out)
}

// 批量结果用「市场:代码」做键，客户端据此回填，顺序无关、缺项也能对上
function batchKey(it) {
  return String((it && it.market) || '') + ':' + String((it && it.code) || '').toUpperCase()
}

// 归一化入参：去空、去重、限流
function normalizeItems(list) {
  if (!(list instanceof Array)) return []

  const seen = {}
  const out = []
  list.forEach((it) => {
    const code = String((it && it.code) || '').trim().toUpperCase()
    if (!code) return
    const market = String((it && it.market) || '').trim()
    const key = market + ':' + code
    if (seen[key]) return
    seen[key] = true
    out.push({ code, market, secid: String((it && it.secid) || '').trim() })
  })

  return out.slice(0, MAX_BATCH)
}

/**
 * 批量行情：整批只回客户端一次网络，服务端每只各自命中自己的缓存。
 * 单只失败不影响整批，失败项返回 null。
 */
function fetchQuotes(list) {
  const items = normalizeItems(list)
  if (!items.length) return Promise.resolve({})

  return mapLimit(items, BATCH_CONCURRENCY, (it) => fetchQuote(it).catch(() => null)).then((arr) => {
    const out = {}
    items.forEach((it, i) => {
      out[batchKey(it)] = arr[i]
    })
    return out
  })
}

/**
 * 批量「行情 + 分红」：持仓页刷新用。
 * N 只持仓原来要 2N 次客户端请求（还撞小程序 10 并发上限），现在一次拿齐。
 */
function fetchDetails(list) {
  const items = normalizeItems(list)
  if (!items.length) return Promise.resolve({})

  return mapLimit(items, BATCH_CONCURRENCY, (it) =>
    fetchDetail(it).catch(() => ({ quote: null, dividend: null }))
  ).then((arr) => {
    const out = {}
    items.forEach((it, i) => {
      out[batchKey(it)] = arr[i] || { quote: null, dividend: null }
    })
    return out
  })
}

module.exports = {
  HOST,
  MARKET_BY_NO,
  TTL,
  MAX_BATCH,
  search,
  fetchQuote,
  fetchFund,
  fetchDividend,
  fetchDetail,
  fetchQuotes,
  fetchDetails,
  batchKey,
  cacheStats,
  cleanCache
}

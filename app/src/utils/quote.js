/**
 * 行情数据源
 *
 * 两条通道，优先走服务端：
 *   1) 云托管代理（推荐）：客户端只调自己的后端，不用配 request 合法域名，
 *      所有用户共享服务端缓存，数据源也藏在后端；
 *   2) 直连东方财富（兜底）：后端没部署 / 断网时自动回退，本地开发不受影响。
 *
 * 无论走哪条通道，返回结构和字段口径完全一致，所以 api.js 无感。
 * 这一层只负责取数与字段归一化，吐原始数值 + yyyy-MM-dd 日期，
 * 货币换算、千分位、涨跌配色等展示逻辑统一放在 api.js。
 *
 * 直连通道需要在小程序后台把下面四个域名加进 request 合法域名
 * （勾了「不校验合法域名」可跳过）：
 *   https://push2.eastmoney.com             实时行情
 *   https://search-codetable.eastmoney.com  代码 / 名称搜索
 *   https://datacenter-web.eastmoney.com    分红档案
 *   https://fund.eastmoney.com              场外基金净值
 */

const cloud = require('./cloud.js')

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

/**
 * 直连行情失败时的提示。
 *
 * 小程序那版要提示「域名没加白名单」——App 端没有白名单这回事（原生请求不受限），
 * 所以那条分支去掉了，只区分超时与一般网络故障。
 * RN 的网络错误大多是英文原文（Network request failed 之类），统一收成中文。
 */
function netError(e) {
  const msg = String((e && e.errMsg) || '')
  if (msg.indexOf('timeout') > -1 || /abort/i.test(msg)) return '行情接口超时，请稍后重试'
  return '行情接口连接失败，请检查网络后重试'
}

function request(url) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      timeout: TIMEOUT,
      header: { 'content-type': 'application/json' },
      success(res) {
        if (res.statusCode !== 200) {
          reject({ code: res.statusCode, msg: '接口返回 ' + res.statusCode })
          return
        }
        resolve(res.data)
      },
      fail(e) {
        reject({ code: 0, msg: netError(e) })
      }
    })
  })
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

  return request(url).then((res) => {
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
  return request(url).then((res) => toQuote(res && res.data))
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
  const list = stock && stock.secid ? [stock.secid] : secidCandidates(stock && stock.market, stock && stock.code)
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
  return request(HOST.fund + '/pingzhongdata/' + code + '.js').then((text) => {
    const src = typeof text === 'string' ? text : ''
    if (!src) return null

    const trend = matchArray(src, 'Data_netWorthTrend')
    if (!trend.length) return null

    const last = trend[trend.length - 1]
    const prev = trend.length > 1 ? trend[trend.length - 2] : last
    const price = num(last.y)
    const prevClose = num(prev.y)

    return {
      quote: {
        code: String(code),
        name: matchStr(src, 'fS_name'),
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

  return request(url).then((res) => {
    const rows = (res && res.result && res.result.data) || []
    return {
      source: '东方财富 · 分红送配',
      list: rows.map(toDividendA).filter((r) => !!r)
    }
  })
}

/**
 * 港股：方案原文有两种写法，必须分开认 ——
 *   以港币宣派：「每股派港币0.024元」
 *   以人民币宣派：「每股派人民币0.154元(相当于港币0.177元)」
 *
 * 后者在港股里非常常见（中资公司多按人民币记账，中国食品 00506 就是），
 * 而原来只取「原文里第一个数字」，拿到的是**人民币**金额却当成本币（港币）用。
 * 后果不是固定打几折，而是随当期汇率浮动，表现就是「股息率和市场公布的对不上、
 * 而且怎么调税率都对不上」—— 因为错在基数本身。
 *
 * 所以优先取括号里的港币等值（公司公告的官方折算值），其次认「派港币X元」，
 * 最后才退回第一个数字兜底。
 */
function toDividendHK(r) {
  const text = String(r.PLAN_EXPLAIN || '')

  const equivalent = text.match(/(?:相当于|折合|相等于)\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)/)
  const declaredHkd = text.match(/派\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)/)
  const fallback = text.match(/([\d]+(?:\.\d+)?)/)

  const m = equivalent || declaredHkd || fallback
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

  return request(url).then((res) => {
    const rows = (res && res.result && res.result.data) || []
    return {
      source: '东方财富 · 港股派息',
      list: rows.map(toDividendHK).filter((r) => !!r)
    }
  })
}

// 返回 null 表示这个市场没有可用的分红档案（美股），页面按「无数据」展示
// opts.size 用于统计「连续分红年数」这类需要更长历史的场景
function directDividend(stock, opts) {
  const market = (stock && stock.market) || ''
  const size = (opts && opts.size) || 10
  if (market === 'A' || market === 'ETF') return dividendA(stock.code, size)
  if (market === 'HK') return dividendHK(stock.code, size)
  return Promise.resolve(null)
}

/* ---------------- 聚合 ---------------- */

// 一次取齐：实时行情 + 分红档案（直连通道）
function directDetail(stock) {
  if (!stock || !stock.code) {
    return Promise.reject({ code: 400, msg: '缺少标的代码' })
  }

  // 场外基金净值与分红同源，一次请求拿全
  if (stock.market === 'FUND') {
    return directFund(stock.code).then((d) => ({
      quote: d ? d.quote : null,
      dividend: d ? d.dividend : null
    }))
  }

  return Promise.all([directQuote(stock), directDividend(stock)]).then((arr) => ({
    quote: arr[0],
    dividend: arr[1]
  }))
}

/* ================= 对外通道：优先服务端，失败回退直连 ================= */

function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .map((k) => k + '=' + encodeURIComponent(params[k]))
    .join('&')
}

// 连续失败就先别试服务端了：否则后端没部署时每次都要白等一轮超时
let failStreak = 0
let skipUntil = 0
const FAIL_LIMIT = 3
const SKIP_MS = 60 * 1000

/**
 * 云托管优先，直连兜底。
 *  - cloud 未启用（后端没部署 / 基础库不支持）→ 直接走直连，不打无谓请求；
 *  - 服务端返回失败（超时 / 上游异常）→ 回退直连，用户永远拿得到数据；
 *  - 连续失败到阈值 → 一分钟内直接走直连，避免每次都白等一次超时。
 */
function pick(cloudCall, directCall) {
  if (!cloud.enabled() || Date.now() < skipUntil) return directCall()

  return cloudCall().then(
    (value) => {
      failStreak = 0
      return value
    },
    (e) => {
      failStreak++
      if (failStreak >= FAIL_LIMIT) {
        failStreak = 0
        skipUntil = Date.now() + SKIP_MS
        console.warn('[quote] 服务端连续失败，' + SKIP_MS / 1000 + 's 内改走直连')
      }
      console.warn('[quote] 服务端取数失败，回退直连', e && e.msg)
      return directCall()
    }
  )
}

function search(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return Promise.resolve([])
  return pick(
    () => cloud.request('/api/quote/search?' + qs({ kw })).then((r) => r.data || []),
    () => directSearch(kw)
  )
}

function fetchQuote(stock) {
  const s = stock || {}
  return pick(
    () =>
      cloud
        .request('/api/quote?' + qs({ code: s.code, market: s.market, secid: s.secid }))
        .then((r) => r.data || null),
    () => directQuote(s)
  )
}

function fetchFund(code) {
  if (!code) return Promise.resolve(null)
  return pick(
    () => cloud.request('/api/fund?' + qs({ code })).then((r) => r.data || null),
    () => directFund(code)
  )
}

/* ---------------- 汇率 ----------------
 * 港币 / 美元兑离岸人民币（CNH）。用离岸价是因为投资者的视角就是它，
 * 而且东财只提供 CNH（没有在岸 CNY 的行情）。
 * 返回值是「1 单位外币 = 多少人民币」：{ CNY: 1, HKD: 0.8534, USD: 6.6953 }。
 */
const FX_SECID = { HKD: '133.HKDCNH', USD: '133.USDCNH' }

function fetchFx() {
  const codes = Object.keys(FX_SECID)

  return Promise.all(
    codes.map((c) =>
      request(HOST.quote + '/api/qt/stock/get?secid=' + FX_SECID[c] + '&fields=f43,f59')
        .then((res) => {
          const d = (res && res.data) || {}
          // f43 是放大过的整数，f59 是小数位数
          const price = Number(d.f43) / Math.pow(10, Number(d.f59) || 0)
          return price > 0 ? { code: c, price: price } : null
        })
        .catch(() => null)
    )
  ).then((arr) => {
    const out = { CNY: 1 }
    arr.forEach((r) => {
      if (r) out[r.code] = r.price
    })
    return out
  })
}

/**
 * 按公告原文再校正一次港股的每股派息。
 *
 * 服务端有可能还是「取方案原文里第一个数字」的老口径：以人民币宣派的港股
 * （原文形如「每股派人民币0.154元(相当于港币0.177元)」）会被低估一截，
 * 偏差还随当期汇率浮动，表现就是「股息率和市场公布的对不上」。
 *
 * 服务端返回里带着 planText（公告原文），所以客户端能自己重解析一遍。
 * 放在这一层是因为 dividend / detail / details 三条通道取回的分红都经过它，
 * 上游（持仓、详情、榜单、档案）不用各自处理。
 * 服务端更新后两边结果一致，这里自然成为空操作 —— 幂等，不会互相打架。
 */
function fixHkDividend(dividend) {
  if (!dividend || !dividend.list || !dividend.list.length) return dividend

  let changed = false
  const list = dividend.list.map((r) => {
    const m = String((r && r.planText) || '').match(
      /(?:相当于|折合|相等于)\s*港(?:币|元)\s*([\d]+(?:\.\d+)?)/
    )
    if (!m) return r
    const hkd = num(m[1])
    if (!(hkd > 0) || hkd === r.dps) return r
    changed = true
    return Object.assign({}, r, { dps: hkd })
  })

  return changed ? Object.assign({}, dividend, { list: list }) : dividend
}

// 档案挂在 detail / details 的返回值里，配套两个包装
function fixHkDetail(d) {
  if (!d) return d
  return Object.assign({}, d, { dividend: fixHkDividend(d.dividend) })
}

function fixHkDetailMap(map) {
  if (!map) return map
  const out = {}
  Object.keys(map).forEach((k) => {
    out[k] = fixHkDetail(map[k] || {})
  })
  return out
}

function fetchDividend(stock, opts) {
  const s = stock || {}
  const size = (opts && opts.size) || 10
  // 服务端对「该市场没有分红档案」的返回是 data:null，客户端原样透出去
  return pick(
    () =>
      cloud
        .request('/api/dividend?' + qs({ code: s.code, market: s.market, size }))
        .then((r) => (r.data === undefined ? null : r.data)),
    () => directDividend(s, opts)
  ).then(fixHkDividend)
}

function fetchDetail(stock) {
  const s = stock || {}
  if (!s.code) return Promise.reject({ code: 400, msg: '缺少标的代码' })
  return pick(
    () =>
      cloud
        .request('/api/detail?' + qs({ code: s.code, market: s.market, secid: s.secid }))
        .then((r) => r.data || { quote: null, dividend: null }),
    () => directDetail(s)
  ).then(fixHkDetail)
}

/* ================= 批量：一次请求拿齐多只标的 =================
 * 持仓页刷新、榜单、息率对比都是「十几只标的一次拉」的场景。
 * 走批量接口后，客户端请求数从 2N 降到 1，也天然避开了小程序
 * 单会话最多 10 个并发请求的限制。返回结构是 { '市场:代码': 数据 }。
 */

// 与批量接口约定的键格式，调用方用它回填
function batchKey(stock) {
  return (
    String((stock && stock.market) || '') + ':' + String((stock && stock.code) || '').toUpperCase()
  )
}

// 直连兜底时自己限流：上游是公开接口，压太高容易被风控
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

// 批量实时行情
function fetchQuotes(list) {
  const items = (list || []).filter((s) => s && s.code)
  if (!items.length) return Promise.resolve({})

  return pick(
    () => cloud.request('/api/quotes', 'POST', { items }).then((r) => r.data || {}),
    () =>
      mapLimit(items, 4, (s) => directQuote(s).catch(() => null)).then((arr) => {
        const out = {}
        items.forEach((s, i) => {
          out[batchKey(s)] = arr[i]
        })
        return out
      })
  )
}

// 批量「行情 + 分红」，持仓页刷新用
function fetchDetails(list) {
  const items = (list || []).filter((s) => s && s.code)
  if (!items.length) return Promise.resolve({})

  return pick(
    () => cloud.request('/api/details', 'POST', { items }).then((r) => r.data || {}),
    () =>
      mapLimit(items, 4, (s) =>
        directDetail(s).catch(() => ({ quote: null, dividend: null }))
      ).then((arr) => {
        const out = {}
        items.forEach((s, i) => {
          out[batchKey(s)] = arr[i] || { quote: null, dividend: null }
        })
        return out
      })
  ).then(fixHkDetailMap)
}

module.exports = {
  HOST,
  MARKET_BY_NO,
  request,
  search,
  fetchQuote,
  fetchFund,
  fetchDividend,
  fetchDetail,
  fetchQuotes,
  fetchDetails,
  fetchFx,
  batchKey
}

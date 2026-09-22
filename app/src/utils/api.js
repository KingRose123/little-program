/**
 * 数据服务层 —— 全项目唯一的数据读写入口
 *
 * 行情与分红：走 utils/quote.js 的东方财富实时接口（真实数据）。
 * 账户 / 持仓 / 内容：走 utils/mock.js + utils/store.js 的本地数据。
 * 会员门禁：档位与额度见 utils/membership.js，超限一律 fail(msg, 402) 抛出。
 * 所有方法统一返回 { code, msg, data }，页面无需关心底层是网络还是本地。
 *
 * 约定：code === 0 表示成功；其余为异常（含网络错误），统一由 util.onError 兜底。
 */
const mock = require('./mock.js')
const store = require('./store.js')
const util = require('./util.js')
const validate = require('./validate.js')
const appicon = require('./appicon.js')
const quote = require('./quote.js')
const cloud = require('./cloud.js')
const membership = require('./membership.js')

const LATENCY = 120

function clone(data) {
  if (data === undefined || data === null) return data
  return JSON.parse(JSON.stringify(data))
}

// 成功响应
function ok(data) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ code: 0, msg: 'ok', data: clone(data) })
    }, LATENCY)
  })
}

// 失败响应
function fail(msg, code) {
  return Promise.reject({ code: code === undefined ? -1 : code, msg: msg || '请求失败，请稍后重试' })
}

/* ================= 行情刷新节流 =================
 * 持仓页 / 详情页进入时刷新一次，同一次会话里 5 分钟内不重复拉。
 * 取数走 quote.fetchDetails 的批量接口，服务端另有 15s 缓存兜住并发，
 * 所以客户端不再自己攒一份按标的的缓存。
 */
const LIVE_TTL = 5 * 60 * 1000

// 除息日归属的年份；解析不出来时退回报告期里的四位年份
function exYearOf(r) {
  const m = String((r && (r.exDate || r.period)) || '').match(/(\d{4})/)
  return m ? Number(m[1]) : 0
}

// 派息归属的财年：报告期带年份就用它（A股「2025年报」、港股「2025末期」），
// 只有一串日期的（场外基金）退回除息日所在年份
function fiscalYearOf(r) {
  const m = String((r && r.period) || '').match(/(\d{4})/)
  return m ? Number(m[1]) : exYearOf(r)
}

// 年度方案：A股叫「年报」，港股叫「末期」。用来判断一个财年是不是已经派完
function isAnnualPeriod(r) {
  return /年报|年度|末期/.test(String((r && r.period) || ''))
}

/**
 * 最近一个完整财年的每股派息合计（税前），返回 { dps, year }。
 *
 * 不用「近 12 个月滚动」：滚动窗口会把今年的中期派息和上一年的年度派息叠在一起，
 * 同一家公司一年两度的节奏被打乱，息率被算高、而且每天都在变。
 *
 * 也不用「除息日所属自然年」：A股 / 港股的年度方案大多要等到下一年才除息，
 * 按自然年归集会把「上一年财年的年报」算进今年，最近一次真实派息反而被排除。
 *
 * 规则：按报告期归集到财年，取最近一个「不晚于去年、且已经出了年度方案」的财年；
 * 都还没出年度方案时，退回最近一个不晚于去年的财年；整体对不上（新股 / 刚改派息
 * 节奏）时才退回最近一期，避免口径归零。
 */
function annualDpsOf(dividend, fallback) {
  const list = (dividend && dividend.list) || []
  if (!list.length) return { dps: Number(fallback) || 0, year: 0 }

  const byYear = {}
  const annualYear = {}
  list.forEach((r) => {
    const y = fiscalYearOf(r)
    if (!y) return
    byYear[y] = (byYear[y] || 0) + r.dps
    if (isAnnualPeriod(r)) annualYear[y] = true
  })

  const lastFullYear = new Date().getFullYear() - 1
  const years = Object.keys(byYear)
    .map(Number)
    .filter((y) => y <= lastFullYear)
    .sort((a, b) => b - a)

  const complete = years.filter((y) => annualYear[y])[0]
  const hit = complete || years[0]
  if (hit) return { dps: byYear[hit], year: hit }

  return { dps: list[0].dps, year: 0 }
}

/**
 * 三种分红口径各自对应的「税前每股派息基数」。
 *
 *   近1年 = 最近一个完整财年的派息合计（沿用 annualDpsOf 的规则）
 *   近3年 = 最近 3 个完整财年合计的**均值**
 *   近5年 = 最近 5 个完整财年合计的**均值**
 *
 * 这里以前是「最近一年 × 固定系数」（1 / 0.92 / 0.85）。那个系数没有任何数据
 * 依据，方向甚至可能是反的：海澜之家近 5 年平均 0.4525 明明高于去年的 0.41，
 * 却被算成 0.41 × 0.85 = 0.3485 —— 息率凭空少了 15%，而"近5年"本该比"近1年"
 * 更平稳、不是无条件更低。
 *
 * 只统计**完整财年**（报告期年份 ≤ 去年），今年还没走完的中期派息不算进来，
 * 否则同一只标的今天一个数、明天一个数。够几个财年就用几个（新股、
 * 刚改派息节奏的标的不会因此归零）。
 */
function dpsByModeOf(dividend, fallback) {
  const annual = annualDpsOf(dividend, fallback)
  const list = (dividend && dividend.list) || []

  const byYear = {}
  list.forEach((r) => {
    const y = fiscalYearOf(r)
    if (!y) return
    byYear[y] = (byYear[y] || 0) + r.dps
  })

  const lastFullYear = new Date().getFullYear() - 1
  const years = Object.keys(byYear)
    .map(Number)
    .filter((y) => y <= lastFullYear)
    .sort((a, b) => b - a)

  const avgOf = (n) => {
    const pick = years.slice(0, n)
    if (!pick.length) return annual.dps
    return pick.reduce((s, y) => s + byYear[y], 0) / pick.length
  }

  return { m1: annual.dps, m3: avgOf(3), m5: avgOf(5) }
}

// 各口径在 dpsByModeOf 结果里对应的键（近1年 / 近3年 / 近5年 / 自定义）
const DIV_KEYS = ['m1', 'm3', 'm5', 'm1']

// 按口径索引取基数；索引越界或取不到时退回近1年
function dpsBaseFor(dividend, idx, fallback) {
  const m = dpsByModeOf(dividend, fallback)
  return Number(m[DIV_KEYS[idx] || 'm1']) || m.m1
}

// 从最新派息年份往前数，连续有派息的年数（中断一年即重新计数）
function liveYearsOf(dividend) {
  const list = (dividend && dividend.list) || []
  const seen = {}
  list.forEach((r) => {
    const y = yearOf(r)
    if (y) seen[y] = true
  })

  const years = Object.keys(seen)
    .map(Number)
    .sort((a, b) => b - a)
  if (!years.length) return 0

  let count = 1
  for (let i = 1; i < years.length; i++) {
    if (years[i] === years[i - 1] - 1) count++
    else break
  }
  return count
}

// 自由流通市值换算成人民币（港股按当前汇率折算），用于「红利指数」成分权重
function capToCny(q, market) {
  if (!q) return 0
  const cap = q.floatCap || q.marketCap || 0
  if (!cap) return 0
  // 港股给的是港元、美股给的是美元，A股 / ETF 本身就是人民币 —— 统一走折算，
  // 原先只处理了港股，美股的市值被当成人民币，权重会小到几乎看不见
  return cap * cnyPerUnitLive(market)
}

/**
 * 榜单 / 息率对比 / 定投回测共用的「实时息率项」。
 * 数值全部现算，本地只保留成员名单。
 */
function liveYieldItem(stock, entry) {
  const q = entry && entry.quote
  const market = (stock && stock.market) || (entry && entry.market) || 'A'
  const inPool = findStock(stock && stock.code)
  const price = q && q.price > 0 ? q.price : 0
  const dps = annualDpsOf(entry && entry.dividend, inPool ? inPool.dps : 0).dps
  // 榜单 / 息率对比没有「逐只配置」的入口，统一用该市场默认税率
  const taxRate = defaultTaxRateOf(market)
  const value = price > 0 && dps > 0 ? (netDpsOf(dps, taxRate) / price) * 100 : 0

  return {
    code: String((stock && stock.code) || '').toUpperCase(),
    name: (q && q.name) || (inPool ? inPool.name : '') || String(stock && stock.code),
    market,
    price,
    dps,
    taxRate,
    value,
    years: liveYearsOf(entry && entry.dividend),
    capCny: capToCny(q, market),
    live: !!q && price > 0
  }
}

// 按成员名单拉齐实时数据：走批量接口，一次请求拿齐十几只标的
function buildLiveList(codes) {
  const list = (codes || []).map((code) => ({ code, market: guessMarket(code) }))
  if (!list.length) return Promise.resolve([])

  return quote
    .fetchDetails(list)
    .catch(() => ({}))
    .then((map) =>
      // 保持入参顺序与长度：没拿到行情的标的由 liveYieldItem 自己兜底成 value 0
      list.map((s) => liveYieldItem(s, map[quote.batchKey(s)] || {}))
    )
}

/* ================= 显示货币 =================
 * 基准数据（mock / storage）始终按人民币存储，页面金额文案一律由下面这组
 * 函数产出：按当前显示货币的 rate 换算后带上符号。
 * 这样「我的 → 显示货币」改一次，全 App 的金额同步换汇，页面无需各自处理。
 */
function conv(n) {
  const v = Number(n) || 0
  const cur = readCurrency()
  // 人民币不用换算
  if (cur.code === 'CNY') return v
  // 显示货币之间也走**实时汇率**：记账 rate 的口径是「1 元 = rate 个该币种」，
  // 而实时那边拿到的是「1 单位外币 = 多少人民币」，取倒数即可。
  // 拿不到实时汇率时才退回记账 rate（此时至少口径自洽，不会忽大忽小）。
  const live = fxLive && Number(fxLive[cur.code])
  return live > 0 ? v / live : v * cur.rate
}

function curSymbol() {
  return readCurrency().symbol
}

// 千分位金额（d 为小数位）
function moneyText(n, d) {
  return curSymbol() + util.group(conv(n), d)
}

/**
 * 带正负号的金额（浮动盈亏用）：+¥1,234.56 / -¥1,234.56 / ¥0.00。
 *
 * 不复用 moneyText 直接传负数：那样负号会夹在货币符号后面（¥-1,234.56），
 * 做涨跌展示时读起来别扭。
 */
function signedMoneyText(n, d) {
  const v = Number(n) || 0
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return sign + moneyText(Math.abs(v), d)
}

// 带正负号的百分比：+20.55% / -8.30%
function signedPctText(n, d) {
  const v = Number(n) || 0
  const sign = v > 0 ? '+' : v < 0 ? '-' : ''
  return sign + util.money(Math.abs(v), d === undefined ? 2 : d) + '%'
}

// 固定小数金额
function fixedText(n, d) {
  return curSymbol() + util.money(conv(n), d)
}

// ≥1万自动折「万」，否则完整千分位
function amountText(n) {
  return curSymbol() + util.amount(conv(n))
}

// 概览用的「数字 + 万」文案（引导流 / 蓝图），带当前货币符号
function wanText(n) {
  return curSymbol() + util.wan(conv(n), 2)
}

/* ================= 通用视图模型 ================= */

// 市场元数据统一从 mock.stockMarkets 派生，标签与配色都不在多处硬编码
const MARKET = {}
const MARKET_LABEL = {}
// 持仓详情页副标题用的长文案
const MARKET_LONG_LABEL = {
  A: '人民币资产',
  HK: '港澳资产',
  ETF: '境内基金',
  FUND: '境内基金',
  US: '美元资产'
}

mock.stockMarkets.forEach((m) => {
  MARKET[m.key] = { tag: m.tag, cls: m.cls }
  MARKET_LABEL[m.key] = m.label
})

function marketOf(m) {
  return MARKET[m] || MARKET.US
}

// 各市场的本币：港股按港币、美股按美元、A股按人民币。
// 股票的价格与每股股息天然是「本币」计价（行情接口给的就是本币），
// 而资产类金额统一按人民币存储 —— 两者的折算全部走下面这组函数，
// 不要在页面上临时乘汇率。
function nativeCurrency(market) {
  const code = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'
  return mock.currencyOptions.filter((c) => c.code === code)[0] || mock.currencyOptions[0]
}

// 1 单位本币 = 多少人民币。currencyOptions 的 rate 是「1 元 = rate 个该币种」，
// 所以取倒数：港币 ≈ 0.926 元、美元 ≈ 7.25 元。
function cnyPerUnit(market) {
  const c = nativeCurrency(market)
  return c && c.rate ? 1 / c.rate : 1
}

// 本币金额 -> 人民币（录入时统一折成人民币存）
function toCny(v, market) {
  return (Number(v) || 0) * cnyPerUnit(market)
}

// 人民币 -> 本币金额（按本币展示、编辑面板回显时用）
function fromCny(v, market) {
  const r = cnyPerUnit(market)
  return r ? (Number(v) || 0) / r : Number(v) || 0
}

// 本币符号与名称：港币 HK$、美元 $、人民币 ¥
function nativeSymbol(market) {
  return nativeCurrency(market).symbol
}

function nativeName(market) {
  return nativeCurrency(market).name
}

/**
 * 给一个**已经是本币**的数值加上本币符号。
 *
 * 标的自身的报价（最新价、每股股息、每股成本）一律按本币展示：这些数字是
 * 「这只股票在它自己市场里的价格」，换成别的币种会和行情软件、券商 App 对不上，
 * 用户也没法照着填。资产类金额（市值 / 分红总额 / 净投入）走 moneyText，按显示货币来。
 *
 * 注意传进来的必须已经是本币 —— 接口原值和 nativeOf() 取出的本币原值都满足；
 * 再折一遍等于把汇率平方。
 */
function nativeRawText(v, market, d) {
  return nativeSymbol(market) + util.money(Number(v) || 0, d)
}

/**
 * 取某个字段的**本币原值**。
 *
 * 录入与刷新行情时，本币原值会跟着人民币值一起存下来（costNative / priceNative…），
 * 展示直接读它。不再从人民币反算，是因为反算要再乘一次记账汇率的倒数：
 * 来回两道既有舍入误差，又把「本币值」这个事实绑死在那个发版即固定的汇率上。
 *
 * 老数据没有这个字段，回落到 fromCny() —— 与改造前逐位相同，不会更差；
 * 下次编辑或刷新行情时它会自动补上。
 */
function nativeOf(row, key, market) {
  if (!row) return 0
  const v = row[key + 'Native']
  if (v === undefined || v === null || v === '') {
    return fromCny(row[key], market || row.market)
  }
  return Number(v) || 0
}

// 本币原值 + 本币符号（展示用）
function nativeOfText(row, key, market, d) {
  const m = market || (row && row.market)
  return nativeRawText(nativeOf(row, key, m), m, d)
}

/* ---------------- 实时汇率 ----------------
 * 快照里的本币金额是按「记账汇率」折成人民币存的 —— 也就是 mock.currencyOptions
 * 里那两个常量（HKD 1.08 / USD 0.1379），发版后就固定不动。它是
 * 「存储值 ⇄ 本币值」的固定桥梁：一旦改它，港币价格显示会跟着漂
 * （存的是按旧汇率折出来的数，用新汇率还原就对不上了）。
 *
 * 所以汇率更新**不动它**，只在外面乘一个重估系数：
 *   重估系数 = 实时汇率 ÷ 记账汇率
 * 市值、预测年分红这类「当下与未来的价值」乘上它 → 按最新汇率看；
 * 历史投入（成本）和实际到账（已收分红）不乘 → 它们本来就是当时的人民币。
 * 息率是同一币种相除，系数约掉，天然不受汇率影响。
 */
const FX_KEY = 'fxRates'

// 内存里那份实时汇率：启动时从 storage 恢复，联网后再刷新
let fxLive = null

// 1 单位本币 = 多少人民币（实时）；拿不到时返回 null，由调用方退回记账汇率
function liveCnyPerUnit(market) {
  const code = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'
  if (code === 'CNY') return 1
  const v = fxLive && Number(fxLive[code])
  return v > 0 ? v : null
}

/**
 * 折算用的汇率：1 单位本币 = 多少人民币。
 *
 * 优先实时，拿不到时退回记账汇率 —— 离线或汇率接口挂掉时，
 * 数字可能会有几个点的偏差，但不会出现数量级错误。
 */
function cnyPerUnitLive(market) {
  const live = liveCnyPerUnit(market)
  return live > 0 ? live : cnyPerUnit(market)
}

// 拉一次实时汇率；失败保持现状（继续用上次的缓存或记账汇率）
function refreshFx() {
  return quote
    .fetchFx()
    .then((rates) => {
      fxLive = rates
      wx.setStorageSync(FX_KEY, { at: Date.now(), rates: rates })
      return rates
    })
    .catch(() => null)
}

function restoreFx() {
  const saved = wx.getStorageSync(FX_KEY)
  if (saved && saved.rates) fxLive = saved.rates
  return fxLive
}

// store 是纯计算层，不该反过来依赖 api，所以把汇率以注入的方式给它。
// 注入的是「1 单位本币 = 多少人民币」—— store 用它把本币原值折成人民币，
// 每次 decorate 都现算，所以汇率一变，市值立刻跟着变，而录进去的数字不动。
if (typeof store.setFxProvider === 'function') store.setFxProvider(cnyPerUnitLive)

/**
 * 历史数据口径修正。
 *
 * 【最终口径】快照里**只存本币原值**：港股填 3.44 就存 3.44，美股填 25.8 就存 25.8。
 * 人民币金额不落库，由 store.decorate 按当时汇率现算。这样汇率怎么动，
 * 「录入的数字」永远是事实，人民币只是它的一个视图。
 *
 * 这一路改过四版，每版修的是上一版暴露出来的问题，读的时候容易绕，所以列清楚：
 *
 *   v1  最初录入侧不区分币种：行情 / 分红接口给的是本币，系统当人民币直接用，
 *       于是港股市值差约 7%、美股差约 7 倍。这一版把接口来的本币字段折成人民币。
 *
 *   v2  修 v1 折过头的两处 —— 它们本来就不是本币：
 *         · 自定义标的没有行情源，price 是拿成本推出来的，语义随成本；
 *         · 分红口径选「自定义」时，dps 是用户照界面提示手填的。
 *       这两类按 v1 的结果继续用，股价息率会整整差一个汇率。
 *
 *   v3  引入 xxxNative（本币原值），值由修正后的人民币反算。
 *       问题就出在这里：它对 **cost** 也做了同样的反算，但 cost 从来没被
 *       v1/v2 折过 —— 它里面一直是用户录入的**本币**数字。于是 3.44 被
 *       当成人民币再除一次记账汇率，显示成 3.72。用户看到的就是
 *       「我明明填了 3.44，它自己变成了别的数」。
 *
 *   v4（本版）统一到「只存本币」：
 *         · cost —— 旧值本就是本币，原样留下（这就是纠正 v3 的那一步）；
 *         · price / dps / baseDps —— v1/v2 折过，这里折回本币；
 *         · received —— 一直按人民币累加，折回本币；
 *         · fee / seedCost —— 同样折回本币，让种子基准跟着汇率一起动。
 *       迁移完成后，所有 xxx 与 xxxNative 同为本币，读取路径不再分情况。
 *
 * 版本标记存在 storage 且纳入 SETTING_KEYS（跟着账号上云）：
 * 只放本地的话，App 与小程序会各折一次，等于把汇率平方。
 */
const NATIVE_FIX_KEY = 'nativeCurrencyFix'
const NATIVE_FIX_VERSION = 6

// 已有的本币原值优先（新数据、以及 v3 对 price/dps 算对的那部分都要保留），
// 缺失时才用反算兜底
function useOr(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback
  const n = Number(v)
  return isNaN(n) ? fallback : n
}

function migrateNativeCurrency() {
  const done = Number(wx.getStorageSync(NATIVE_FIX_KEY)) || 0
  if (done >= NATIVE_FIX_VERSION) return 0

  let n = 0
  const next = store.allRows().map((h) => {
    const market = (h && h.market) || 'A'
    const cny = cnyPerUnit(market)

    // 先把 v1/v2 的修正复现出来，让 price / dps / baseDps 落在
    // 「改造后的人民币口径」这个已知状态上（done 为 0 或 1 时的处理不同）
    let price = h.price
    let dps = h.dps
    let baseDps = h.baseDps

    // 只涉及港股与美股 —— A股 / ETF / 场外基金的本币就是人民币，折算是恒等。
    // 而且只在 done < 2 时做：跑到 v3 之后的数据里 price/dps 已经是人民币了，
    // 再折一次会把数字推得更远（这条迁移会重跑，必须保证幂等）。
    if (cny !== 1 && done < 2) {
      // 没有行情时 price 是「按录入成本估算」来的，和成本同币种（人民币）
      const noQuote = h.priceDate === '按录入成本估算'
      // 分红口径「自定义」时 dps 是用户手填的，按界面提示是人民币
      const customDiv = h.divMode === '自定义'

      if (done < 1) {
        if (!noQuote) price = (Number(h.price) || 0) * cny
        if (!customDiv) dps = (Number(h.dps) || 0) * cny
        baseDps = (Number(h.baseDps) || 0) * cny
      } else {
        if (noQuote) price = (Number(h.price) || 0) / cny
        if (customDiv) dps = (Number(h.dps) || 0) / cny
      }
    }

    // 上面三个此刻都是人民币口径，折回本币（优先沿用已有的原值）
    const priceNative = useOr(h.priceNative, fromCny(price, market))
    const dpsNative = useOr(h.dpsNative, fromCny(dps, market))
    const baseDpsNative = useOr(h.baseDpsNative, fromCny(baseDps, market))

    // cost 从来没有被折过：它里面就是用户当初录入的本币数字，直接用它。
    // （v3 把它当人民币除了一次汇率，是本次要纠正的错误。）
    const costNative = Number(h.cost) || 0

    // received 的口径要分三种情况，因为它是最容易折错的一个字段：
    //   · 有 receivedNative —— 已经迁移过，直接用它（幂等）
    //   · done === 4 —— 那一版把 received 折成了本币却没留下 receivedNative，
    //     所以现在读到的是「本币 ÷ 记账汇率」，要乘回去而不是再除一次
    //   · 其余 —— 还是人民币口径，正常折回本币
    let receivedNative
    if (h.receivedNative !== undefined && h.receivedNative !== null && h.receivedNative !== '') {
      receivedNative = Number(h.receivedNative) || 0
    } else if (done === 4) {
      receivedNative = (Number(h.received) || 0) * cny
    } else {
      receivedNative = fromCny(h.received, market)
    }

    // fee 同样是人民币口径（addHolding 里存的是 feeNative × cny）
    const feeNative = useOr(h.feeNative, fromCny(h.fee, market))

    const withNative = Object.assign({}, h, {
      // 迁移后 xxx 与 xxxNative 同为本币，读取路径统一
      cost: costNative,
      costNative: costNative,
      price: priceNative,
      priceNative: priceNative,
      dps: dpsNative,
      dpsNative: dpsNative,
      baseDps: baseDpsNative,
      baseDpsNative: baseDpsNative,
      fee: feeNative,
      feeNative: feeNative,
      received: receivedNative,
      receivedNative: receivedNative
    })

    // 建仓基准：seedCost 冻结时取的就是用户录入值（本币），直接用；
    // v3 补的 seedCostNative 是反算来的，一并纠正
    if (h.seedShares !== undefined && h.seedShares !== null) {
      const seedCost = Number(h.seedCost) || 0
      withNative.seedCost = seedCost
      withNative.seedCostNative = seedCost
    }

    n++
    return withNative
  })

  // 先落标记再提交：即便这次上云失败，dirty 还留着，下次启动会重试推上去
  wx.setStorageSync(NATIVE_FIX_KEY, NATIVE_FIX_VERSION)
  // 一条持仓都没有时也要写标记，否则每次启动都会白跑一遍
  if (n) store.replaceHoldings(next)

  // 交易 / 分红明细也必须一起回到本币口径 —— 它们和持仓是同一份数据的两面。
  // 只改持仓的话，明细里的成交价还是旧的人民币折算值，一加权进成本就又串味了。
  const marketOf = {}
  store.allRows().forEach((h) => {
    if (h && h.id) marketOf[h.id] = h.market || 'A'
  })

  const recs = readRecords()
  let rn = 0
  Object.keys(recs).forEach((hid) => {
    const market = marketOf[hid] || 'A'
    if (cnyPerUnit(market) === 1) return // 人民币市场折算恒等，不用动

    const bucket = recs[hid] || {}
    ;['trade', 'dividend'].forEach((kind) => {
      const list = bucket[kind]
      if (!list || !list.length) return

      bucket[kind] = list.map((r) => {
        const t = Object.assign({}, r)
        if (kind === 'trade') {
          t.price = useOr(t.priceNative, fromCny(t.price, market))
          t.priceNative = t.price
          t.fee = useOr(t.feeNative, fromCny(t.fee, market))
          t.feeNative = t.fee
        } else {
          t.amount = useOr(t.amountNative, fromCny(t.amount, market))
          t.amountNative = t.amount
          t.dps = useOr(t.dpsNative, fromCny(t.dps, market))
          t.dpsNative = t.dps
          t.tax = useOr(t.taxNative, fromCny(t.tax, market))
          t.taxNative = t.tax
        }
        rn++
        return t
      })
    })
  })
  if (rn) writeRecords(recs)

  // 最后一步：让摊薄成本按新口径重算一遍。
  //
  // 为什么非做不可：迁移只改了「原始字段」（成本、成交价、手续费…），
  // 但页面上看到的每股成本是 positionOf 从「建仓基准 + 全部交易」算出来的，
  // 它上一次运行是在旧口径的数据上 —— 不重算的话，明细已经对了，
  // 汇总出来的成本却还是老数字，两边对不上。
  if (n || rn) {
    store.allRows().forEach((h) => {
      const trades = ((recs[h.id] || {}).trade) || []
      if (!trades.length) return
      const cur = store.getHolding(h.id)
      if (cur) applyTradesToHolding(cur, trades)
    })
  }

  return n + rn
}

// 单只持仓 -> 视图模型
function holdingVM(h) {
  const d = store.decorate(h)
  const mi = marketOf(d.market)
  const cur = readCurrency()
  const native = nativeCurrency(d.market)
  return {
    id: d.id,
    code: d.code,
    name: d.name,
    icon: d.name.substring(0, 1),
    market: d.market,
    marketLabel: d.marketLabel,
    marketTag: mi.tag,
    tagClass: mi.cls,
    shares: d.shares,
    sharesText: d.shares + '股',
    // 录入侧字段：编辑面板要回显
    buyDate: d.buyDate || '',
    fee: d.fee || 0,
    // 编辑面板按本币回显（手续费当初也是按本币录的）
    feeNative: nativeOf(d, 'fee'),
    costMode: d.costMode || '',
    divMode: d.divMode || '',
    negativeCost: !!d.negativeCost,
    custom: !!d.custom,
    // 每股股息、最新价、每股成本都是「这只股票自己的价格」，一律按本币展示
    // （和数据来源、券商对账单一致，用户也照着它填）；资产类金额才走显示货币
    dps: d.dps,
    dpsText: nativeOfText(d, 'dps', d.market, 4),
    price: d.price,
    priceText: nativeOfText(d, 'price', d.market, 2),
    priceDateText: d.priceDate,
    cost: d.cost,
    // 编辑面板按本币回显：用户当初按本币填，再打开就该看到本币
    costNative: nativeOf(d, 'cost'),
    costText: nativeOfText(d, 'cost', d.market, 4),
    dividend: d.dividend,
    dividendText: moneyText(d.dividend, 2),
    marketValue: d.marketValue,
    // 市值 ≥ 1万 时自动折算成「数字 + 万」
    marketValueText: amountText(d.marketValue),
    costValue: d.costValue,
    // 浮动盈亏 = 现市值 − 持仓成本（不含已收分红，那部分另有回本进度）。
    // 金额与比例都带正负号；up / down 供页面着色，两者都 false 即持平（走灰）
    floatProfit: d.floatProfit,
    floatProfitText: signedMoneyText(d.floatProfit, 2),
    floatProfitPctText: signedPctText(d.floatProfitPct, 2),
    floatProfitUp: d.floatProfit > 0,
    floatProfitDown: d.floatProfit < 0,
    costYieldText: util.money(d.costYield, 2) + '%',
    priceYieldText: util.money(d.priceYield, 2) + '%',
    // 持股天数按买入日现算：存下来的那个值只是录入当时的快照，放着不动会越来越旧
    holdingDays: d.buyDate ? daysSince(d.buyDate) : Number(d.holdingDays) || 0,
    received: d.received,
    receivedText: moneyText(d.received, 2),
    // 老数据没存过税率时按该市场默认值回显，保证编辑面板能选中
    taxRate:
      d.taxRate === undefined || d.taxRate === null || d.taxRate === ''
        ? defaultTaxRateOf(d.market)
        : d.taxRate,
    taxOn: d.taxOn !== false,
    netInvestText: moneyText(d.netInvest, 2),
    remainingText: moneyText(d.remaining, 2),
    paybackYearsText: util.money(d.paybackYears, 1),
    paybackProgress: d.paybackProgress,
    // 显示货币与本币不一致时才提示「换成港币看」
    currencyName: cur.name,
    nativeCurrencyName: native.name,
    showCurrencyTip: native.code !== cur.code
  }
}

// 持仓总览 -> 视图模型
function summaryVM() {
  const s = store.summary()
  // 20 年推演由成本息率实时算出，不再是写死的倍数
  const proj = returnProjection(s.costYield)
  return {
    count: s.count,
    dividend: s.dividend,
    dividendText: moneyText(s.dividend, 2),
    receivedText: moneyText(s.received, 2),
    costText: curSymbol() + util.wan(conv(s.costValue), 2),
    marketText: curSymbol() + util.wan(conv(s.marketValue), 2),
    costYieldText: util.money(s.costYield, 2) + '%',
    marketYieldText: util.money(s.marketYield, 2) + '%',
    monthlyText: moneyText(s.monthly, 2),
    multipleText: proj.multipleText,
    projection: proj,
    holdDays: s.holdDays
  }
}

/* ================= 汇总指标设置 ================= */

const METRIC_STORE_KEY = 'holdingMetrics'

function defaultMetricKeys() {
  return mock.metricCatalog.filter((m) => m.def).map((m) => m.key)
}

// 已保存的选择，未设置过则用默认 6 项
function readMetricKeys() {
  const saved = wx.getStorageSync(METRIC_STORE_KEY)
  if (saved && saved instanceof Array) return saved.slice()
  return defaultMetricKeys()
}

// 每项指标的展示值
function metricValueMap() {
  const s = store.summary()
  // 金额一律走显示货币：正负号由换算后的值决定，符号与数值都带在文案里
  const signed = (n) => {
    const v = conv(n)
    return (v >= 0 ? '+' : '-') + curSymbol() + util.group(Math.abs(v), 2)
  }
  const signedPct = (n) => (n >= 0 ? '+' : '-') + util.money(Math.abs(n), 2) + '%'
  return {
    received: moneyText(s.received, 2),
    cost: curSymbol() + util.wan(conv(s.costValue), 2),
    marketValue: curSymbol() + util.wan(conv(s.marketValue), 2),
    costYield: util.money(s.costYield, 2) + '%',
    marketYield: util.money(s.marketYield, 2) + '%',
    monthly: moneyText(s.monthly, 2),
    daily: moneyText(s.daily, 2),
    floatPnl: signed(s.floatPnl),
    floatRate: signedPct(s.floatRate),
    totalReceived: moneyText(s.totalReceived, 2),
    netInvest: curSymbol() + util.wan(conv(s.netInvest), 2),
    holdCount: s.count + ' 只'
  }
}

/**
 * 指标值的涨跌配色。
 *
 * mock.metricCatalog 里给 floatPnl / floatRate 标了 tone:'up'，那原本只是个
 * **"这项需要按涨跌着色"的标记**，但页面把它当成"固定用涨色"来用了 ——
 * 于是顶部汇总的浮动盈亏无论赚还是亏都是同一个橙色（metricUp = #E0892C），
 * 而下面卡片里同一个数字却是红涨绿跌，两处对不上。
 *
 * 这里按**实际正负**给出方向，与卡片上的 profitToneOf 保持同一套语义：
 * 盈利红、亏损绿、持平不着色（走默认白）。国内行情软件的约定。
 */
function metricToneOf(key) {
  if (key !== 'floatPnl' && key !== 'floatRate') return ''
  const v = Number(store.summary()[key]) || 0
  if (v > 0) return 'up'
  if (v < 0) return 'down'
  return ''
}

function toMetricVM(keys, onlySelected) {
  const values = metricValueMap()
  return mock.metricCatalog
    .filter((m) => (keys.indexOf(m.key) > -1) === onlySelected)
    .map((m) => ({
      key: m.key,
      name: m.name,
      desc: m.desc,
      value: values[m.key],
      tone: metricToneOf(m.key)
    }))
}

// 纯计算、无 IO，故设计为同步方法，保证开关指标时无延迟
function buildMetricLists(keys) {
  const k = keys || []
  return {
    selectedKeys: k.slice(),
    selectedMetrics: toMetricVM(k, true),
    optionalMetrics: toMetricVM(k, false)
  }
}

/**
 * 覆盖清单数据源：以「生活支出设置」里可编辑的清单为唯一真源，
 * 按年支出从小到大依次覆盖 —— 先搞定最容易的目标，这也是产品的核心语义。
 *
 *   已覆盖：累计金额 + 该项年支出 ≤ 预测年度分红
 *   进行中：第一个装不下的项，进度 = (分红 - 已累计) / 该项年支出
 *   未点亮：其余全部
 *
 * 状态是"算"出来的而不是写死的，所以在设置页改金额 / 增删项后会立刻重排。
 * 默认数据下精确还原参考图：话费、物业费已覆盖，水电燃气进行中 63%，还差 ¥1,777。
 */
function coverageSource() {
  const dividend = store.summary().dividend

  const list = readLifeExpenses()
    .slice()
    .sort((a, b) => (Number(a.amount) || 0) - (Number(b.amount) || 0))
    .map((e) => ({
      id: e.id,
      name: e.name,
      icon: e.icon,
      year: (Number(e.amount) || 0) * 12
    }))

  let cum = 0
  let hasDoing = false

  return list.map((i) => {
    if (!hasDoing && cum + i.year <= dividend) {
      cum += i.year
      return Object.assign(i, { status: 'covered', progress: 100, gap: 0 })
    }
    if (!hasDoing) {
      hasDoing = true
      const remain = dividend - cum
      const lack = i.year - remain
      return Object.assign(i, {
        status: 'doing',
        progress: i.year ? Math.round((remain / i.year) * 100) : 0,
        gap: lack > 0 ? Math.round(lack) : 0
      })
    }
    return Object.assign(i, { status: 'locked', progress: 0, gap: 0 })
  })
}

/**
 * 成长阶段：按「已用于覆盖的分红金额 ÷ 所有支出项目的年支出总额」递进，
 * 与顶部成长之路、成长日志徽章同源。
 *   0% 起始出发 · 25% 有所起色 · 50% 小有所成 · 75% 收支平衡 · 100% 财务自由
 * 分子分母都是金额（不是项数），分母是"所有项目"的开支合计。
 * 如需调整节奏，只改这里的档位即可，进度条与日志徽章会同步跟随。
 */
const STAGE_NAMES = ['起始出发', '有所起色', '小有所成', '收支平衡', '财务自由']
const STAGE_STEPS = [0, 25, 50, 75, 100]

function stageIndexOf(ratio) {
  let idx = 0
  for (let i = 0; i < STAGE_STEPS.length; i++) {
    if (ratio >= STAGE_STEPS[i]) idx = i
  }
  return idx
}

/**
 * 成长日志：与覆盖进度联动生成。
 *   进行中的项 -> 「正在点亮 xxx」
 *   已覆盖的项 -> 「点亮了 xxx」，最新点亮的排在最上面
 *
 * 小标签规则：按点亮顺序累计覆盖率，哪一条把覆盖率推进到新档位，
 * 就在哪一条右侧打上那一档的标签；没跨过节点的条目不显示标签。
 * （第一条必然跨过 0% 这一档，所以一定带「起始出发」）
 */
function growthLogsVM(src, totalYear) {
  const covered = src.filter((i) => i.status === 'covered')
  const doing = src.filter((i) => i.status === 'doing')[0]

  const now = new Date()
  const date =
    now.getFullYear() + '-' + util.pad(now.getMonth() + 1) + '-' + util.pad(now.getDate())

  // 逐项累计，记录每一档是在点亮哪一项时跨过的
  const badgeOf = {}
  let cum = 0
  let reached = -1
  covered.forEach((i) => {
    cum += i.year
    const idx = stageIndexOf(totalYear ? (cum / totalYear) * 100 : 0)
    if (idx > reached) {
      reached = idx
      badgeOf[i.id] = STAGE_NAMES[idx]
    }
  })

  const logs = []
  if (doing) {
    logs.push({
      id: 'doing_' + doing.id,
      date,
      text: '正在点亮',
      target: doing.name,
      badge: '',
      badgeClass: ''
    })
  }

  // covered 本身按"由易到难"排，也就是点亮顺序，倒过来即最新在前
  covered
    .slice()
    .reverse()
    .forEach((i) => {
      const badge = badgeOf[i.id]
      logs.push({
        id: 'covered_' + i.id,
        date,
        text: '点亮了',
        target: i.name,
        badge: badge || '',
        badgeClass: badge ? 'tag-green' : ''
      })
    })

  return logs
}

// 分红覆盖（持仓页精简版）
function coverageBriefVM() {
  const src = coverageSource()

  const grid = src.map((i) => ({
    id: i.id,
    name: i.name,
    icon: i.icon,
    on: i.status === 'covered',
    doing: i.status === 'doing'
  }))

  const doing = src.filter((i) => i.status === 'doing')[0]

  return {
    coveredCount: src.filter((i) => i.status === 'covered').length,
    totalCount: src.length,
    gapText: doing ? moneyText(doing.gap, 0) : curSymbol() + '0',
    nextName: doing ? doing.name : '',
    nextIcon: doing ? doing.icon : '',
    grid
  }
}

// 分红覆盖（详情页完整版）
function coverageVM() {
  const src = coverageSource()
  const dividend = store.summary().dividend
  const totalYear = src.reduce((s, i) => s + i.year, 0)
  const covered = src.filter((i) => i.status === 'covered').length

  const list = src.map((i) => {
    const done = i.status === 'covered'
    const doing = i.status === 'doing'
    return {
      id: i.id,
      name: i.name,
      icon: i.icon,
      yearText: moneyText(i.year, 0),
      status: i.status,
      done,
      doing,
      locked: i.status === 'locked',
      progress: done ? 100 : doing ? i.progress : 0,
      tagText: done ? '已覆盖' : doing ? '进行中' : '未点亮',
      tagClass: done ? 'tag-green' : doing ? 'tag-orange' : 'tag-gray',
      note: done
        ? '分红已稳定覆盖此项开销'
        : doing
        ? '还差 ' + moneyText(i.gap, 0) + '，进度 ' + i.progress + '%'
        : '需 ' + moneyText(i.year, 0) + ' 分红就能点亮'
    }
  })

  const uncovered = list.filter((i) => !i.done)
  const nextTwo = uncovered.slice(0, 2)

  // 成长阶段：覆盖率 = 已用于覆盖的分红金额 ÷ 所有支出项目的年支出总额
  // 分红全额都用在覆盖上（完全覆盖若干项 + 进行中项已覆盖的一部分），
  // 所以分子 = min(预测年度分红, 所有项目年支出总额)
  const coveredAmount = Math.min(dividend, totalYear)
  const stageRatio = totalYear ? (coveredAmount / totalYear) * 100 : 0
  const stageIndex = stageIndexOf(stageRatio)
  const stageName = STAGE_NAMES[stageIndex]

  /**
   * 下一档目标 —— 文案里的「再覆盖 N 项 / 还需 X 分红」都必须指向它。
   *
   * 原先这两处取的是「未覆盖项的前两项」，与档位推进没有任何关系，于是界面上会
   * 出现「说好再覆盖 2 项就进下一档、覆盖完了进度条却纹丝不动」；而且那句话里的
   * 档位名是写死的，根本不在 STAGE_NAMES 里，进度条永远不可能显示成它。
   *
   * 档位是按**金额**划的，所以这里也按金额算差额，再换算成「还要点亮几项」。
   */
  const lastIndex = STAGE_NAMES.length - 1
  const topped = stageIndex >= lastIndex
  const nextIndex = Math.min(stageIndex + 1, lastIndex)
  // 下一档的金额门槛（档位按金额划，分母是全部支出合计）
  const nextThreshold = (STAGE_STEPS[nextIndex] / 100) * totalYear
  const nextStageGap = topped ? 0 : Math.max(0, nextThreshold - coveredAmount)

  // 到门槛时还能多点亮几项：用同一套「由易到难、累计不超门槛」的规则模拟一遍。
  //
  // 不能拿「未覆盖项的全年金额」去累加 —— 那样会把只吃得下一部分的项也当成整项，
  // 项数会虚高。实测：门槛只够再点亮 1 项，累加全年金额却数成了 2 项、金额也多出一倍。
  let cum = 0
  let reachable = 0
  src.forEach((i) => {
    if (cum + i.year <= nextThreshold) {
      cum += i.year
      reachable++
    }
  })
  const needCount = topped ? 0 : Math.max(0, reachable - covered)

  return {
    coveredCount: covered,
    totalCount: src.length,
    totalYearText: moneyText(totalYear, 2),
    dividendText: moneyText(dividend, 2),
    receivedText: moneyText(0, 2),
    stageName,
    stageIndex,
    // 进度线 = 当前档位在 5 个节点中的位置
    stageLine: Math.round((stageIndex / lastIndex) * 100),
    stages: STAGE_NAMES.map((name, i) => ({
      name,
      done: i < stageIndex,
      current: i === stageIndex
    })),
    // 已抵达最后一档：文案改说「已达成」，不再提「再覆盖几项」
    topped,
    nextStageName: topped ? '' : STAGE_NAMES[nextIndex],
    nextStageGapText: moneyText(nextStageGap, 0),
    // 口径说明用：档位是按**金额**推进的，和「覆盖了几项」不是同一个口径。
    // 两者同屏出现时容易被当成对不上（覆盖 3/7 项 ≠ 15%），所以要给个明确的算式。
    coveredAmountText: moneyText(coveredAmount, 2),
    stageRatioText: util.money(stageRatio, 1) + '%',
    needCount,
    needGapText: moneyText(nextStageGap, 0),
    next: nextTwo[0] || null,
    list,
    logs: growthLogsVM(src, totalYear)
  }
}

/* ================= 用户 ================= */

/**
 * 登录 / 注册走 utils/cloud.js（用户名 + 密码 → token），这里不再有微信手机号那套。
 *
 * 小程序版曾经有 login(code) 与 bindPhone(code)：靠 <button open-type="getPhoneNumber">
 * 拿授权码、由服务端换手机号。App 端没有这个能力（那是微信生态独有的），
 * 手机号也整个不再收集，所以这两个函数连同 profile 里的手机号项一起删掉了。
 */

/**
 * 退出登录：先让服务端的 token 失效，再清本机登录态（cloud.logout 里做）。
 * 只清本地是不够的 —— 那个 token 在服务端还能一直用到过期（30 天），
 * 与隐私政策里「退出登录即可让它失效」的说法不符。
 */
function logout() {
  return cloud
    .logout()
    .catch(() => null)
    .then(() => ok(true))
}

function getUser() {
  // 与「我的」页同源：昵称 / 头像取当前登录用户，slogan 是全局文案
  return ok({
    nickName: nickNameOf(),
    avatar: avatarOf(),
    slogan: mock.user.slogan
  })
}

/* ================= 持仓 ================= */

// market: 'A' | 'HK' | 'ETF' | 'FUND' | 'US'
// 切换标签按「实际持有的市场」动态生成：有哪一类持仓才出现哪一类标签
function buildTabs(holdings) {
  return mock.stockMarkets
    .map((m) => ({
      key: m.key,
      label: m.label,
      count: holdings.filter((h) => h.market === m.key).length,
      dotClass: m.dot
    }))
    .filter((t) => t.count > 0)
}

function getHoldings(market) {
  const all = store.allHoldings()
  const tabs = buildTabs(all)
  // 传入的市场已被删空时，自动落到第一个仍有持仓的市场
  const active = tabs.filter((t) => t.key === market).length
    ? market
    : (tabs[0] ? tabs[0].key : market)

  return ok({
    tabs,
    list: all.filter((h) => h.market === active).map(holdingVM),
    activeMarket: active,
    sorts: mock.holdingSorts,
    groupOptions: mock.holdingGroups
  })
}

/* ---------- 我的持仓：排序 / 分组 ---------- */
/**
 * 纯计算、无 IO，故设计为同步方法：切换排序 / 分组时零延迟重绘。
 * list 为 holdingVM 数组，排序依据的 dividend / priceYield / marketValue 等数值字段都已带在 VM 上。
 */

// 息率档位（用股价息率，成本为负时成本息率没有意义）
function yieldBucket(h) {
  const y = h.priceYield
  if (!(y > 0)) return { key: 'y-none', title: '暂无分红', order: 3 }
  if (y >= 5) return { key: 'y-high', title: '高息 ≥5%', order: 0 }
  if (y >= 3) return { key: 'y-mid', title: '中息 3%~5%', order: 1 }
  return { key: 'y-low', title: '低息 <3%', order: 2 }
}

// 分红贡献：占当前列表合计分红的比例
function contributionBucket(h, total) {
  const p = total > 0 ? (h.dividend / total) * 100 : 0
  if (p >= 50) return { key: 'c-main', title: '主力仓 ≥50%', order: 0 }
  if (p >= 20) return { key: 'c-sub', title: '次要仓 20%~50%', order: 1 }
  return { key: 'c-small', title: '小额仓 <20%', order: 2 }
}

// 仓位大小：按持仓市值
function positionBucket(h) {
  const v = h.marketValue
  if (v >= 50000) return { key: 'p-heavy', title: '重仓 ≥5万', order: 0 }
  if (v >= 10000) return { key: 'p-mid', title: '中仓 1万~5万', order: 1 }
  return { key: 'p-light', title: '轻仓 <1万', order: 2 }
}

const BUCKET_OF = {
  yield: yieldBucket,
  contribution: contributionBucket,
  position: positionBucket
}

function buildHoldingGroups(list, sortKey, groupKey) {
  const key = sortKey || 'default'
  const gk = groupKey || 'none'
  const src = list || []

  // default 保持录入顺序，与参考图一致；其余按数值降序
  const sorted =
    key === 'default'
      ? src.slice()
      : src.slice().sort((a, b) => (b[key] || 0) - (a[key] || 0))

  if (gk === 'none' || !BUCKET_OF[gk]) {
    return {
      groups: [{ key: 'all', title: '', count: sorted.length, list: sorted }],
      total: sorted.length
    }
  }

  const totalDividend = sorted.reduce((s, h) => s + h.dividend, 0)
  const bucketOf = BUCKET_OF[gk]
  const map = {}
  const order = []

  // 遍历已排好序的列表，保证组内顺序与当前排序一致
  sorted.forEach((h) => {
    const b = bucketOf(h, totalDividend)
    if (!map[b.key]) {
      map[b.key] = { key: b.key, title: b.title, count: 0, list: [], order: b.order }
      order.push(b.key)
    }
    map[b.key].count++
    map[b.key].list.push(h)
  })

  const groups = order
    .map((k) => map[k])
    .sort((a, b) => a.order - b.order)
    .map((g) => ({ key: g.key, title: g.title, count: g.count, list: g.list }))

  return { groups, total: sorted.length }
}

function getHolding(id) {
  const target = store.getRaw(id)
  if (!target) return fail('未找到该持仓', 404)
  const vm = holdingVM(target)
  vm.menus = clone(mock.holdingMenus).map((m) =>
    m.key === 'dividend' ? Object.assign(m, { desc: '累计已获 ' + vm.receivedText }) : m
  )
  return ok(vm)
}

function getSummary() {
  const vm = summaryVM()
  vm.metrics = toMetricVM(readMetricKeys(), true)
  return ok(vm)
}

function getCoverageBrief() {
  return ok(coverageBriefVM())
}

/* ================= 汇总指标读写 ================= */

function getMetricSettings() {
  const keys = readMetricKeys()
  const svm = summaryVM()
  return ok(
    Object.assign(
      {
        max: mock.METRIC_MAX,
        dividendText: svm.dividendText
      },
      buildMetricLists(keys)
    )
  )
}

function getDefaultMetricKeys() {
  return ok(defaultMetricKeys())
}

// 允许选 0 个：此时首页汇总区自动收起
function saveMetricSettings(keys) {
  if (!(keys instanceof Array)) return fail('缺少指标参数')
  if (keys.length > mock.METRIC_MAX) return fail('最多选择 ' + mock.METRIC_MAX + ' 个指标')
  wx.setStorageSync(METRIC_STORE_KEY, keys.slice())
  store.markDirty()
  return ok(keys.slice())
}

const COST_MODES = ['分红摊薄', '摊薄成本', '加权平均']
const DIV_MODES = ['近1年', '近3年', '近5年', '自定义']

// 从买入日期算持股天数（含当天），异常日期兜底为 1 天
function daysSince(dateStr) {
  const t = new Date(String(dateStr || '').replace(/-/g, '/')).getTime()
  if (isNaN(t)) return 1
  const days = Math.floor((Date.now() - t) / 86400000) + 1
  return days > 0 ? days : 1
}

/**
 * 手动添加持仓：落本地 storage，首页与各统计随即包含这只持仓。
 * 录入侧只提供「股数 / 成本 / 日期」，行情侧字段按下面规则补齐：
 *   dps   —— 按分红口径（近1/3/5年系数或自定义）从股票池估算
 *   price —— 取标的池里的最新价；自定义标的没有行情源，退回成本绝对值，
 *            保证市值、股价息率、浮盈都能算出来
 */
function addHolding(form) {
  if (!form || !form.code || !form.name) return fail('请填写代码与名称')
  const shares = Number(form.shares)
  if (!(shares > 0)) return fail('请填写正确的持仓数量')

  const code = String(form.code).trim().toUpperCase()
  const market = form.market || guessMarket(code)

  // 会员门禁：持仓数量上限（免费 3 只），以及港股 / 美股仅 Pro 可用
  const gate = membership.checkHolding(store.allRaw(), market)
  if (!gate.ok) return fail(gate.msg, 402)

  const inPool = findStock(code)

  /**
   * 录入侧的钱一律是**本币**（港股按港币填、美股按美元填），快照也
   * **只存本币原值** —— 你填 3.44 港币，存进去的数字就是 3.44。
   * 人民币金额不落库，由 store.decorate 按当时的实时汇率现算。
   *
   * 这样汇率怎么变，你录入的数字都不会被偷偷改掉，只会让市值跟着汇率动；
   * 也不会再出现「成本是人民币、股息是港币」这种单位打架把息率算歪的情况。
   */
  const idx = Math.max(0, DIV_MODES.indexOf(form.divMode))
  const custom = Number(form.customDividend)

  // 分红口径基数按口径取：添加页会把分红档案的三口径值一起带过来；
  // 缺失时才退回单值（接口拿不到档案的情况）。两者都是本币
  const modes = form.dpsByMode
  const rawBaseDps = modes
    ? Number(modes[DIV_KEYS[idx] || 'm1']) || 0
    : Number(form.baseDps) > 0
    ? Number(form.baseDps)
    : inPool
    ? inPool.dps
    : 0
  const baseDps = rawBaseDps
  // 分红税率逐只可配；关掉「预测分红扣税」就按 0% 算
  const taxRate = taxRateFromForm(form, market)
  const taxOn = form.taxOn !== false
  // 持仓统一存税后口径；自定义口径是用户自己填的税后本币金额，同样要折成人民币存
  const dpsNative =
    idx === 3 && custom > 0 ? custom : Number(netDpsOf(rawBaseDps, taxOn ? taxRate : 0).toFixed(6))
  const dps = dpsNative

  // 以下全部只存本币原值：人民币金额由 decorate 按实时汇率现算，不落库
  const costNative = Number(form.cost) || 0
  const feeNative = Number(form.fee) || 0
  // 建仓手续费直接摊进每股成本：投入里本来就有它，不摊的话用户得等到
  // 以后加一笔交易才被算进去（那时才第一次跑 positionOf）。
  // 注意基准 seedCost 只放用户填的成本，手续费由 fee 字段单独记着 ——
  // 否则 positionOf 重算时会「基准里一份 + 再摊一份」，成本凭空膨胀。
  const cost = shares > 0 ? Number((costNative + feeNative / shares).toFixed(6)) : costNative
  // 现价优先用页面取回的实时行情（本币），拿不到时才退回录入成本
  const livePriceNative = Number(form.price) > 0 ? Number(form.price) : 0
  const livePrice = livePriceNative
  // 拿不到行情时现价的语义跟着成本走（「按录入成本估算」），本币原值同理
  const priceNative = livePrice > 0 ? livePriceNative : Math.abs(costNative)
  const price = priceNative

  const record = {
    id: 'u-' + market + '-' + code + '-' + Date.now(),
    code: code,
    name: form.name,
    market: market,
    marketLabel: MARKET_LONG_LABEL[market] || market,
    shares: shares,
    dps: dps,
    dpsNative: dpsNative,
    // 记一份真实派息基数（已折人民币），之后改分红口径时不必再请求接口
    baseDps: baseDps,
    baseDpsNative: rawBaseDps,
    price: price,
    priceNative: priceNative,
    priceDate: form.priceDate || (livePrice > 0 ? '实时行情' : '按录入成本估算'),
    cost: cost,
    costNative: cost,
    // 建仓基准：只放用户填的每股成本（不含手续费）。
    // 定下来是为了以后加交易时，重算从「真正录入的那个数」出发，
    // 而不是从摊过手续费的当前成本出发 —— 那会把手续费算两次。
    seedShares: shares,
    seedCost: costNative,
    seedCostNative: costNative,
    seedDate: form.buyDate || '',
    taxRate: taxRate,
    taxOn: taxOn,
    holdingDays: daysSince(form.buyDate),
    received: 0,
    // 以下为录入侧信息，持仓详情页/编辑时可回显
    buyDate: form.buyDate || '',
    fee: feeNative,
    feeNative: feeNative,
    costMode: form.costMode || '',
    divMode: form.divMode || '',
    negativeCost: !!form.negativeCost,
    custom: true,
    // 归到当前账户名下：切到别的账户就看不到它
    accountId: readActiveAccountId()
  }

  store.appendHolding(record)
  return ok(holdingVM(record))
}

/* ================= 添加持仓：选股与口径估算 ================= */

// 分红预测口径的基数改由 dpsByModeOf 按真实财年均值给出，见文件上方定义

function todayKey() {
  const now = new Date()
  return now.getFullYear() + '-' + util.pad(now.getMonth() + 1) + '-' + util.pad(now.getDate())
}

/* ================= 标的行情 / 分红档案 =================
 * 添加自选（持仓）时「输入代码或名称 -> 取到真实价格与分红档案」的统一出口。
 * 价格、涨跌、历史分红全部来自 utils/quote.js 的东方财富实时接口，
 * 本地不保存任何价格或分红数据；详情见 utils/quote.js 顶部的域名白名单说明。
 */

/* ---------------- 分红税率 ----------------
 * 各市场给出的只是「默认值」，真正生效的是每只持仓自己存的 taxRate + taxOn。
 * 同是港股，港股通 H 股（20%）、红筹（28%）、香港券商直投（10%）、
 * 本地股（0%）差别很大；美股也要按实际预扣填，所以做成逐只可调。
 */
const DEFAULT_TAX_RATE = { A: 0, ETF: 0, FUND: 0, HK: 20, US: 10 }

// 税率预设胶囊，与「添加持仓」页一一对应，rate 为 null 表示自定义
const TAX_OPTIONS = [
  { rate: 20, text: '20%' },
  { rate: 28, text: '28%' },
  { rate: 10, text: '10%' },
  { rate: 0, text: '0%' },
  { rate: null, text: '自定义' }
]

// 各市场的税率说明，选完股票后按市场取
const TAX_TIPS = {
  HK: '港股通 H 股默认 20%；红筹股选 28%；香港券商直投 H 股选 10%；港股直接持有本地股选 0%',
  US: '美股股息一般按税收协定预扣 10%，实际扣税不同可自定义',
  A: 'A 股股息红利按持股期限差别化征收，长期持有多为免征，默认 0%',
  ETF: '境内基金分红一般不额外扣税，默认 0%',
  FUND: '境内基金分红一般不额外扣税，默认 0%'
}

function defaultTaxRateOf(market) {
  const r = DEFAULT_TAX_RATE[market]
  return r === undefined ? 0 : r
}

// 持仓实际生效的税率：关掉「预测分红扣税」就等于按 0% 算
function effectiveTaxRate(h) {
  if (!h || h.taxOn === false) return 0
  const r = Number(h.taxRate)
  if (h.taxRate === undefined || h.taxRate === null || h.taxRate === '' || isNaN(r)) {
    return defaultTaxRateOf(h.market || 'A')
  }
  return r
}

// 表单传进来的税率；没填就退回该市场默认值
function taxRateFromForm(form, market) {
  const f = form || {}
  const r = Number(f.taxRate)
  if (f.taxRate !== undefined && f.taxRate !== null && f.taxRate !== '' && !isNaN(r)) return r
  return defaultTaxRateOf(market)
}

/**
 * 持仓里的每股派息一律存「税后」口径（详情页的预测年分红、成本息率、股价息率
 * 标题都写着税后），而分红接口给的是税前方案，所以统一在这里扣一道红利税。
 */
function netDpsOf(baseDps, taxRate) {
  const base = Number(baseDps) || 0
  if (!(base > 0)) return 0
  return base * (1 - (Number(taxRate) || 0) / 100)
}

// 用真实分红档案推出该持仓应有的派息（税前基数 + 按口径折算的税后每股派息）
// 自定义口径的金额是用户自己填的，不覆盖；档案里算不出来时返回 null
function holdingDpsPatch(h, dividend) {
  const idx = Math.max(0, DIV_MODES.indexOf(h.divMode || DIV_MODES[0]))
  if (idx === 3) return null

  // 基数按口径取：近1年 = 最近一个完整财年，近3/近5年 = 对应财年的合计均值
  const base = dpsBaseFor(dividend, idx)
  if (!(base > 0)) return null

  // 接口给的派息是**本币**，快照也只存本币原值（人民币由 decorate 现算）
  const dpsNative = Number(netDpsOf(base, effectiveTaxRate(h)).toFixed(6))

  return {
    baseDps: base,
    baseDpsNative: base,
    dps: dpsNative,
    dpsNative: dpsNative
  }
}

// 标的池仅用于「只拿到代码时判断市场」这类辅助场景，行情与分红一律以接口为准
function findStock(code) {
  const key = String(code || '').trim().toUpperCase()
  if (!key) return null
  return mock.stockPool.filter((s) => s.code.toUpperCase() === key)[0] || null
}

// 榜单 / 工具页只带 ?code= 跳进来时，用它推断市场
function guessMarket(code) {
  const c = String(code || '').trim().toUpperCase()
  if (!c) return 'A'
  const inPool = findStock(c)
  if (inPool) return inPool.market
  if (/^\d{5}$/.test(c)) return 'HK'
  if (/^[A-Z][A-Z.]{0,6}$/.test(c)) return 'US'
  if (/^[15]\d{5}$/.test(c)) return 'ETF'
  return 'A'
}

// 搜索结果项：带上真实市场标签，一行就能看清是哪个市场的标的
function stockBriefVM(s) {
  const mi = marketOf(s.market)
  return {
    // 同一代码可能出现在不同市场（如 000756 既是深A股票也是场外基金），key 用市场+代码
    key: s.market + '-' + s.code,
    code: s.code,
    name: s.name,
    market: s.market,
    marketLabel: MARKET_LABEL[s.market] || s.market,
    // marketTag 是短徽标（A / E / 基 / 港），已选行只放得下一个字
    marketTag: mi.tag,
    cls: mi.cls,
    tagClass: mi.cls,
    typeName: s.typeName || ''
  }
}

/* ---------- 行情：真实价格 -> 展示文案 ---------- */

// 价格按当前显示货币换算；涨跌幅是比例，不受换算影响
function quoteVM(q, market) {
  if (!q || !(q.price > 0)) return null

  const digits = q.digits || 2
  const sign = (v) => (v >= 0 ? '+' : '-')
  const trend = q.change > 0 ? 'up' : q.change < 0 ? 'down' : 'flat'

  return {
    price: q.price,
    // 价格与涨跌额是这只股票的本币报价（港股 HK$、美股 $）：按显示货币换算
    // 反而和行情软件对不上。涨跌幅 / 振幅是比例，不受币种影响，照旧
    priceText: nativeRawText(q.price, market, digits),
    prevCloseText: nativeRawText(q.prevClose, market, digits),
    change: q.change,
    changeText: sign(q.change) + nativeRawText(Math.abs(q.change), market, digits),
    changeRate: q.changeRate,
    changeRateText: sign(q.changeRate) + util.money(Math.abs(q.changeRate), 2) + '%',
    trend,
    trendText: trend === 'up' ? '涨' : trend === 'down' ? '跌' : '平',
    openText: q.open ? nativeRawText(q.open, market, digits) : '--',
    highText: q.high ? nativeRawText(q.high, market, digits) : '--',
    lowText: q.low ? nativeRawText(q.low, market, digits) : '--',
    amplitudeText: q.amplitude ? util.money(q.amplitude, 2) + '%' : '--',
    turnoverText: q.turnoverRate ? util.money(q.turnoverRate, 2) + '%' : '--',
    peText: q.pe ? util.money(q.pe, 2) : '--',
    pbText: q.pb ? util.money(q.pb, 2) : '--',
    capText: q.marketCap ? util.money(q.marketCap / 100000000, 2) + ' 亿' : '--',
    // 场外基金看单位净值，其它看最新价
    priceLabel: market === 'FUND' ? '单位净值' : '最新价',
    priceDate: q.priceDate || '实时行情'
  }
}

/* ---------- 分红档案：接口原始记录 -> 展示结构 ---------- */

function dividendDateLine(r) {
  // 刚公告、还没走到除权的方案没有除息日，退而显示方案进度
  if (!r.exDate) return r.progress || '尚未实施'

  const parts = ['除权除息 ' + r.exDate]
  if (r.payDate) parts.push('到账 ' + r.payDate)
  else if (r.recordDate) parts.push('登记 ' + r.recordDate)
  return parts.join(' · ')
}

/**
 * dividend 为 null 表示该市场没有开放分红接口（美股），页面按「无数据」展示；
 * list 为空数组表示接口查到了、但这只标的确实没有分红记录。
 * dps 是真实派息口径：最近一个完整财年的派息合计（见 annualDpsOf）。
 */
function dividendArchiveVM(dividend, price, market) {
  if (!dividend) {
    return {
      available: false,
      hasDividend: false,
      list: [],
      count: 0,
      source: '',
      basisText: '',
      dps: 0,
      dpsText: '--',
      totalDpsText: '--',
      emptyText: '该市场暂未开放分红档案接口，可在下方手动填写每股派息'
    }
  }

  const rows = dividend.list || []
  // 展示只露最近 6 期；派息口径要拿全量记录算，否则跨年的方案会被截断
  let markedCurrent = false
  const list = rows.slice(0, 6).map((r, i) => {
    // 已公告但还没除权（例如刚披露的中报方案）：单独标出来，不当作「最近一次」
    const pending = !r.exDate
    const current = !pending && !markedCurrent
    if (current) markedCurrent = true

    return {
      index: i,
      periodText: r.period || '—',
      planText: r.planText || '—',
      dps: r.dps,
      // 派息方案是这只股票的本币金额（接口原值），按本币展示
      dpsText: nativeRawText(r.dps, market, 4),
      exDate: r.exDate || '—',
      dateText: dividendDateLine(r),
      progress: r.progress || '',
      pending,
      current
    }
  })

  const annual = annualDpsOf(dividend)
  const dps = annual.dps

  return {
    available: true,
    hasDividend: list.length > 0,
    list,
    count: list.length,
    source: dividend.source || '',
    basisText: annual.year ? annual.year + ' 年度派息合计' : list.length ? '最近一期派息' : '',
    dps,
    // 三个口径各自的基数，添加页按用户选的口径取用（近1/3/5年）
    dpsByMode: dpsByModeOf(dividend),
    dpsText: nativeRawText(dps, market, 4),
    totalDpsText: nativeRawText(list.reduce((s, r) => s + r.dps, 0), market, 4),
    emptyText: '暂无分红记录'
  }
}

/* ---------- 标的详情：行情 + 分红档案 + 税后息率 ---------- */

const EMPTY_QUOTE = {
  priceText: '--',
  prevCloseText: '--',
  changeText: '',
  changeRateText: '',
  trend: 'flat',
  highText: '--',
  lowText: '--',
  openText: '--',
  peText: '--',
  pbText: '--',
  capText: '--',
  priceDate: '暂无行情'
}

function stockDetailVM(stock, q, dividend) {
  const market = stock.market
  const mi = marketOf(market)
  const quoteView = quoteVM(q, market)
  const price = quoteView ? quoteView.price : 0
  const div = dividendArchiveVM(dividend, price, market)
  // 这里只是「该市场默认税率」，用来在选完股票时先给出一个税后股息率，
  // 下一步用户可以在「分红税率」里逐只调整
  const taxRate = defaultTaxRateOf(market)
  const netYield = price > 0 ? (netDpsOf(div.dps, taxRate) / price) * 100 : 0

  return Object.assign(
    {
      code: stock.code,
      name: q && q.name ? q.name : stock.name,
      market,
      marketLabel: MARKET_LABEL[market] || market,
      marketTag: mi.tag,
      tagClass: mi.cls,
      // 分红预测口径的基数来自真实派息记录
      dps: div.dps,
      dpsText: div.dpsText,
      dpsBasisText: div.basisText,
      taxRate,
      yieldText: div.dps > 0 && price > 0 ? util.money(netYield, 2) + '%' : '--',
      taxTipText: taxRate > 0 ? '已按 ' + taxRate + '% 红利税折算' : '按税前股息计算',
      // 该市场的税率说明，页面「分红税率」卡片直接用
      taxTip: TAX_TIPS[market] || TAX_TIPS.A,
      dividend: div,
      hasQuote: !!quoteView,
      priceLabel: market === 'FUND' ? '单位净值' : '最新价',
      sourceText: '数据来源：东方财富（实时）'
    },
    EMPTY_QUOTE,
    quoteView || {}
  )
}

/**
 * 标的详情：一次取回实时行情 + 分红档案。
 * 支持两种入参：搜索结果对象（带 market / secid），或直接给代码字符串。
 */
function getStockDetail(stock) {
  const target =
    typeof stock === 'string'
      ? { code: String(stock).trim().toUpperCase(), market: guessMarket(stock) }
      : stock

  if (!target || !target.code) return fail('缺少标的代码', 400)

  const code = String(target.code).trim().toUpperCase()
  const market = target.market || guessMarket(code)

  return quote
    .fetchDetail({ code, market, secid: target.secid || '' })
    .then((res) => {
      if (!res.quote && !res.dividend) {
        return fail('未获取到行情，请确认代码是否正确或稍后重试', 404)
      }
      return ok(stockDetailVM({ code, market, name: target.name || '' }, res.quote, res.dividend))
    })
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

function getAddHoldingOptions() {
  return ok({
    markets: mock.stockMarkets,
    costModes: COST_MODES,
    divModes: DIV_MODES,
    buyDate: todayKey(),
    // 页面自己拼金额文案时要用当前显示货币的符号
    symbol: curSymbol(),
    // 分红税率：胶囊预设 / 各市场说明 / 各市场默认值
    taxOptions: TAX_OPTIONS,
    taxTips: TAX_TIPS,
    defaultTaxRates: DEFAULT_TAX_RATE
  })
}

// 从榜单 / 工具页带 ?code= 跳进来时，按代码直接取到标的详情
function getStockByCode(code) {
  return getStockDetail(code)
}

/**
 * 关键字搜索：走行情搜索接口，代码 / 中文名 / 拼音首字母都能命中，
 * 覆盖全市场标的而不是本地清单。
 * 当前所选市场的结果排前面，但不隐藏其它市场的匹配 —— 直接输代码也能搜到，
 * 选中后页面会把市场标签自动切到该标的的真实市场。
 */
function searchStocks(q) {
  const kw = String((q && q.keyword) || '').trim()
  const prefer = (q && q.market) || ''
  if (!kw) return ok([])

  return quote
    .search(kw)
    .then((list) => {
      const rank = (s) => (s.market === prefer ? 0 : 1)
      const sorted = list.slice().sort((a, b) => rank(a) - rank(b))
      return ok(sorted.map(stockBriefVM))
    })
    .catch((e) => fail((e && e.msg) || '搜索失败，请稍后重试', (e && e.code) || 0))
}

/**
 * 按选中标的 + 分红口径估算年均每股分红（税后），与 addHolding 落库的口径一致。
 * 基数优先用实时分红档案算出的税前年度派息（baseDps），
 * 只有接口拿不到时才退回标的池记录。
 */
function estimateDividend(q) {
  const code = String((q && q.code) || '').trim().toUpperCase()
  const idx = Number((q && q.divModeIndex) || 0)
  const custom = Number((q && q.customDividend) || 0)

  const inPool = findStock(code)
  const market = (q && q.market) || (inPool ? inPool.market : '') || guessMarket(code)

  // 自定义口径直接用用户填的税后金额。返回的一律是**本币**口径：
  // 它显示在「年均每股分红」旁边，下面紧跟着的就是按本币填的输入框
  if (idx === 3) {
    if (!(custom > 0)) return ok({ dividendText: '--', hasDividend: false })
    return ok({ dividendText: nativeRawText(custom, market, 4), hasDividend: true })
  }

  // 基数按口径取：优先用档案给出的三口径值，缺失时才退回单值
  const modes = q && q.dpsByMode
  const base = modes
    ? Number(modes[DIV_KEYS[idx] || 'm1']) || 0
    : Number((q && q.baseDps) || 0) > 0
    ? Number(q.baseDps)
    : inPool
    ? inPool.dps
    : 0
  if (!(base > 0)) return ok({ dividendText: '--', hasDividend: false })

  // 关掉「预测分红扣税」就等于不扣税
  const rate = q && q.taxOn === false ? 0 : taxRateFromForm(q, market)
  return ok({
    dividendText: nativeRawText(netDpsOf(base, rate), market, 4),
    hasDividend: true
  })
}

function removeHolding(id) {
  if (!id) return fail('缺少持仓 ID')
  store.removeHolding(id)
  return ok(true)
}

/* ================= 清仓归档（投资档案） =================
 * 清仓之后记录不该消失：用户要能回头验证「当初卖对了没有」。
 * 归档是**标记**而不是删除 —— 持仓、交易流水、每笔的想法全部保留，
 * 只是从持仓列表挪到档案页。
 *
 * 归档的两种来源见 store.isArchived：股数归零（卖出全部）自动归档，
 * 或在详情页手动点「清仓归档」。
 */

// 单只归档标的的展示模型
function archiveRowVM(h) {
  // 退出价：自动归档时是卖出价，手动归档时是当时的现价
  const exitNative = nativeOf(h, 'exitPrice') || nativeOf(h, 'price')
  const nowNative = nativeOf(h, 'price')
  // 卖出至今涨跌 —— 这个页面存在的意义就在这一行：
  // 负数是「躲过了下跌」（卖对了），正数是「卖早了」（少赚了），两种都值得看
  const sinceExit = exitNative > 0 ? ((nowNative - exitNative) / exitNative) * 100 : 0
  const mi = marketOf(h.market)

  return {
    id: h.id,
    name: h.name,
    code: h.code,
    icon: String(h.name || '?').substring(0, 1),
    marketTag: mi.tag,
    tagClass: mi.cls,
    sharesText: util.group(Number(h.shares) || 0, 0) + '股',
    exitPriceText: nativeRawText(exitNative, h.market, 2),
    nowPriceText: nativeRawText(nowNative, h.market, 2),
    sinceExitText: (sinceExit > 0 ? '+' : '') + util.money(sinceExit, 2) + '%',
    sinceExitUp: sinceExit > 0,
    sinceExitDown: sinceExit < 0,
    receivedText: moneyText(h.received, 2),
    archivedAt: h.archivedAt || '',
    // 清仓理由：优先用手动填的 archiveReason，否则回落到最后一笔交易的 note
    reason: archiveReasonOf(h),
    // 能不能退回持仓列表：只有「手动归档、且还持有」的可以。
    // 卖光那种归档状态是从 shares 推导出来的（见 store.isArchived），
    // 不写回股数就退不出去 —— 所以按钮只对 canRestore 的显示。
    canRestore: Number(h.shares) > 0
  }
}

// 清仓理由：手动归档时用户填的，或者最后一笔交易写下的想法
function archiveReasonOf(h) {
  const own = String(h.archiveReason || '').trim()
  if (own) return own
  const rec = recordsOf(h.id)
  const trades = (rec.trade || []).slice()
  // 取最后一笔有备注的，倒着找 —— 卖出那笔通常在最后
  for (let i = trades.length - 1; i >= 0; i--) {
    const n = String((trades[i] && trades[i].note) || '').trim()
    if (n) return n
  }
  return ''
}

function getArchive() {
  const rows = store.archivedHoldings().map(archiveRowVM)
  // 「卖对」= 卖出后价格跌了。给个一眼能看的比例，省得自己数
  const win = rows.filter((r) => r.sinceExitDown).length
  return ok({
    list: rows,
    count: rows.length,
    winCount: win,
    winText: rows.length ? win + ' / ' + rows.length : '—',
    emptyText: '还没有清仓的标的。卖出全部股数后，它会自动出现在这里。'
  })
}

// 归档标的的完整详情：持仓概览 + 全部流水（含每笔的想法）
function getArchivedHolding(id) {
  const h = store.getHoldingAny(id)
  if (!h || !store.isArchived(h)) return fail('未找到该归档标的', 404)

  return quote
    .fetchDividend({ code: h.code, market: h.market })
    .catch(() => null)
    .then((dividend) => {
      const vm = holdingVM(h)
      const file = dividendFileVM(h, dividend)
      return ok({
        holding: vm,
        archive: archiveRowVM(h),
        trade: tradeVM(h),
        dividend: dividendVM(h),
        file: file.list,
        fileTotalText: file.totalText,
        filePassedText: file.passedText,
        receivedText: vm.receivedText
      })
    })
}

/**
 * 心得体悟的字数上限：交易备注（addTradeRecord 的 note）与清仓心得
 * （archiveReason）共用。这个长度是**给人写长文**的，不是短评 ——
 * 5000 字约等于一篇完整的复盘，日常很难写满。
 *
 * 为什么不彻底取消上限：快照有 5MB 总额度（config.MaxPayloadBytes），
 * 单条不限的话一条记录就能把额度吃光，之后**整份同步都会被拒**
 * （400 数据过大）—— 那比「打不进去」糟得多，而且同样没有提示。
 * 真的需要更长，拆成多条记录写即可。
 *
 * 口径必须是**字符数**：前端按码点限（clip），服务端也按 rune 校
 * （snapshot.checkText）。两边不一致会造出「本地存得下、同步被服务端
 * 拒掉」这种最难查的问题。
 */
const MEMO_MAX = 5000

/**
 * 手动清仓归档：以当前价作为退出价，股数不动。
 *
 * reason 是归档时写下的心得体悟（可选）。「当初为什么买、现在为什么卖」
 * 在归档那一刻最好写，回头看时的价值也远高于清仓价本身 —— 所以把它
 * 做成归档流程的一步，而不是事后再去找入口。
 */
function archiveHolding(id, reason) {
  const raw = store.getRaw(id)
  if (!raw) return fail('未找到该持仓', 404)
  const h = store.getHolding(id)
  const exitNative = nativeOf(h, 'price')
  // clip 而不是 slice：slice 数的是 UTF-16 码元，emoji 会被切出半个代理项
  const memo = validate.clip(String(reason || '').trim(), MEMO_MAX)

  const patch = {
    archived: true,
    archivedAt: todayKey(),
    exitPrice: exitNative,
    exitPriceNative: exitNative
  }
  // 只在确实写了的时候覆盖：留空提交不该把之前写过的想法抹掉
  if (memo) patch.archiveReason = memo

  writeHoldingPatch(id, patch)
  return ok(true)
}

/**
 * 补写 / 修改清仓心得。
 *
 * 独立于归档动作，也不要求当前是归档态：归档时未必想清楚（也可能随手
 * 跳过），过段时间回看才最有话说 —— 那时必须还能补，否则「记一句」就
 * 成了一次性的事，错过就永远空着。
 */
function setArchiveReason(id, reason) {
  const h = store.getHoldingAny(id)
  if (!h) return fail('未找到该持仓', 404)

  writeHoldingPatch(id, {
    archiveReason: validate.clip(String(reason || '').trim(), MEMO_MAX)
  })
  return ok(true)
}

/**
 * 移出归档（恢复为在持）。
 *
 * 注意：股数归零的那类「归档」恢复不了 —— 它的归档状态是由 shares 推导的，
 * 不写回股数就还在档案里。这种情况只能靠重新买入来回到持仓列表。
 */
function unarchiveHolding(id) {
  const raw = store.getRawAny(id)
  if (!raw) return fail('未找到该持仓', 404)
  if (!(Number(raw.shares) > 0)) {
    return fail('这股已卖光，重新买入后才能回到持仓列表')
  }
  writeHoldingPatch(id, {
    archived: false,
    archivedAt: '',
    exitPrice: null,
    exitPriceNative: null
  })
  return ok(true)
}

/* ================= 分红覆盖 ================= */

function getCoverage() {
  return ok(coverageVM())
}

/* ================= 生活支出 ================= */

function expenseVM(list, onIds) {
  const list2 = list.map((e) =>
    Object.assign({}, e, {
      on: onIds.indexOf(e.id) > -1,
      // 卡片上的月度金额按显示货币换算
      amountText: moneyText(e.amount, 0)
    })
  )
  const on = list2.filter((i) => i.on)
  const year = on.reduce((s, i) => s + i.amount * 12, 0)
  return {
    list: list2,
    selectedIds: on.map((i) => i.id),
    selectedCount: on.length,
    yearText: moneyText(year, 0),
    monthText: moneyText(year / 12, 0)
  }
}

// 引导流：全部未勾选（与参考图 ¥0 状态一致）
function getOnboardingExpenses() {
  return ok(expenseVM(mock.expenses, []))
}

/* 我的 -> 生活支出设置：整份清单（含自定义项）持久化在本地 */

const EXPENSE_STORE_KEY = 'lifeExpenses'

function defaultLifeExpenses() {
  return mock.expenses
    .filter((e) => mock.selectedExpenseIds.indexOf(e.id) > -1)
    .sort((a, b) => a.sort - b.sort)
    .map((e) => ({ id: e.id, name: e.name, icon: e.icon, amount: e.amount, period: '月' }))
}

function readLifeExpenses() {
  const saved = wx.getStorageSync(EXPENSE_STORE_KEY)
  if (saved instanceof Array && saved.length) return saved
  return defaultLifeExpenses()
}

function writeLifeExpenses(list) {
  wx.setStorageSync(EXPENSE_STORE_KEY, list)
  store.markDirty()
}

function expenseStat(list) {
  const year = list.reduce((s, i) => s + (Number(i.amount) || 0) * 12, 0)
  return {
    count: list.length,
    yearText: moneyText(year, 0),
    monthText: moneyText(year / 12, 0)
  }
}

function getExpenses() {
  const list = readLifeExpenses()
  return ok(Object.assign({ list, icons: mock.expenseIcons }, expenseStat(list)))
}

// 编辑：整份清单回存
function saveExpenses(list) {
  if (!(list instanceof Array)) return fail('参数错误')
  writeLifeExpenses(
    list.map((i) => ({
      id: i.id,
      name: i.name,
      icon: i.icon,
      amount: Number(i.amount) || 0,
      period: i.period || '月'
    }))
  )
  return ok(true)
}

function removeExpense(id) {
  if (!id) return fail('缺少支出 ID')
  const list = readLifeExpenses().filter((i) => i.id !== id)
  writeLifeExpenses(list)
  return ok(Object.assign({ list }, expenseStat(list)))
}

// 添加自定义支出：名称 + 月度金额 + 图标
function addCustomExpense(payload) {
  const p = payload || {}
  const name = String(p.name || '').trim()
  const amount = Number(p.amount)
  if (!name) return fail('请填写名称')
  if (!amount || amount <= 0) return fail('请填写有效的月度金额')
  if (!p.icon) return fail('请选择一个图标')

  const list = readLifeExpenses().concat([
    { id: 'custom_' + Date.now(), name, icon: p.icon, amount, period: '月' }
  ])
  writeLifeExpenses(list)
  return ok(Object.assign({ list }, expenseStat(list)))
}

/* ================= 引导流 ================= */

function getOnboardingDemo() {
  const demo = clone(mock.onboardingDemo)
  const p = demo.preview
  const card = demo.predictCard
  const cp = demo.compound
  const foot = demo.planFooter

  return ok({
    slogan: demo.slogan,
    // 演示卡片：数值在这里按显示货币产出文案，页面不再拼 ¥
    preview: {
      name: p.name,
      icon: p.icon,
      market: MARKET_LABEL[p.market] || p.market,
      shares: util.group(p.shares, 0) + '股',
      cost: fixedText(p.cost, 2),
      yield: util.money(p.yield, 1) + '%',
      dividend: moneyText(p.dividend, 0)
    },
    predictCard: {
      totalText: moneyText(card.total, 0),
      receivedText: moneyText(card.received, 0),
      yieldText: util.money(card.yield, 1) + '%',
      nextPayText: card.nextPay
    },
    litChips: demo.litChips,
    unlitChips: demo.unlitChips,
    litCount: demo.litCount,
    chipTotal: demo.chipTotal,
    nextChip: demo.nextChip,
    compound: {
      nowText: wanText(cp.now),
      futureText: wanText(cp.future),
      years: cp.years,
      multiple: cp.multiple
    },
    tip: demo.tip,
    planFooter: {
      principalText: wanText(foot.principal),
      monthlyText: moneyText(foot.monthly, 0),
      rateText: foot.rate + '%'
    },
    steps: ['了解', '选支出', '定计划', '看蓝图'],
    expenses: expenseVM(mock.expenses, []).list
  })
}

// 逐项被买单的时间线：当年分红 >= 该项年支出
function buildTimeline(principal, monthly, rate, ids) {
  let assets = principal
  const r = rate / 100
  const real = []
  for (let i = 1; i <= 30; i++) {
    const dividend = assets * r
    assets = (assets + monthly * 12) * (1 + r)
    real.push({ year: i, total: assets, dividend })
  }

  const timeline = mock.expenses
    .filter((i) => ids.indexOf(i.id) > -1)
    .map((i) => {
      const need = i.amount * 12
      const hit = real.filter((y) => y.dividend >= need)[0]
      return {
        id: i.id,
        name: i.name,
        icon: i.icon,
        need,
        needText: moneyText(need, 0),
        year: hit ? hit.year : 0,
        yearText: hit ? 2026 + hit.year + '年达成' : '30年+',
        done: !!hit
      }
    })
    .sort((a, b) => (a.year || 99) - (b.year || 99))

  return { years: real, timeline }
}

/**
 * 预演收息蓝图
 * @param {Object} plan { principal, monthly, rate, ids }
 */
function previewPlan(plan) {
  const p = plan || {}
  const principal = Number(p.principal) || 0
  const monthly = Number(p.monthly) || 0
  const rate = Number(p.rate) || 0
  const ids = p.ids && p.ids.length ? p.ids : mock.selectedExpenseIds

  const target = mock.expenses
    .filter((i) => ids.indexOf(i.id) > -1)
    .reduce((s, i) => s + i.amount * 12, 0)

  const built = buildTimeline(principal, monthly, rate, ids)
  const last = built.years[built.years.length - 1]

  let percent = target ? (last.dividend / target) * 100 : 0
  if (percent > 100) percent = 100
  const rounded = Math.round(percent)

  return ok({
    targetYearText: moneyText(target, 0),
    targetMonthText: moneyText(target / 12, 0),
    finalAssetsText: wanText(last.total),
    coverPercent: rounded,
    coverTip: rounded >= 100 ? '按这个计划，30 年内就能全部覆盖' : '目标稍大，30 年内可覆盖 ' + rounded + '%',
    blueprint: built.years.map((y) => ({
      year: y.year,
      totalText: wanText(y.total),
      dividendText: moneyText(y.dividend, 2),
      label: 2026 + y.year + '年总资产'
    })),
    timeline: built.timeline
  })
}

function savePlan(plan) {
  if (!plan) return fail('缺少计划参数')
  return ok(clone(plan))
}

/* ================= 分红日历 ================= */

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

function dayKey(y, m, d) {
  return y + '-' + util.pad(m) + '-' + util.pad(d)
}

/* ---------------- 日历事件：从用户自己的持仓推导 ----------------
 * mock.calendarEvents 是空的（没有真实数据源），光靠它日历页会一直是空的：
 * 日期上的小圆点、「下一笔分红月份」、当日明细全都没东西可显示。
 * 这里改为从真实持仓推导三类事件：
 *   股权登记 recordDate / 除权除息 exDate / 派息日 payDate（分红档案）
 *   加上用户自己记的到账记录（派息日）
 * 分红档案走网络，所以按标的缓存 10 分钟 —— 切月重绘时才不会每次都打接口。
 */
const CAL_FILE_TTL = 10 * 60 * 1000
const dividendFileCache = {}

function fileCacheKey(h) {
  return (h.code || '') + '@' + (h.market || '')
}

function fetchDividendCached(h) {
  const key = fileCacheKey(h)
  const hit = dividendFileCache[key]
  if (hit && Date.now() - hit.at < CAL_FILE_TTL) return Promise.resolve(hit.data)
  return quote
    .fetchDividend({ code: h.code, market: h.market })
    .catch(() => null)
    .then((d) => {
      // 取不到（网络抖一下 / 该市场没接口）时只短暂记住，
      // 否则一次失败就会让日历空上 10 分钟，翻月也一直是空的
      dividendFileCache[key] = {
        at: d ? Date.now() : Date.now() - (CAL_FILE_TTL - 30 * 1000),
        data: d
      }
      return d
    })
}

// 档案里有些日期是「尚未公布」这类文案，只认 yyyy-MM-dd
function normDate(v) {
  const s = String(v || '').slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''
}

function pushEvent(out, date, ev) {
  const key = normDate(date)
  if (!key) return
  ;(out[key] = out[key] || []).push(ev)
}

// 一条分红方案 -> 登记 / 除权 / 派息三个日期各落一个事件
function pushFileEvents(out, h, dividend) {
  const rate = 1 - effectiveTaxRate(h) / 100
  const list = (dividend && dividend.list) || []
  list.forEach((r) => {
    const amount = (Number(r.dps) || 0) * (Number(h.shares) || 0) * rate
    const ev = (type) => ({ code: h.code, name: h.name, type: type, amount: amount })
    pushEvent(out, r.recordDate, ev('股权登记'))
    pushEvent(out, r.exDate, ev('除权除息'))
    pushEvent(out, r.payDate, ev('派息日'))
  })
}

// 同步版：只用本地已有的数据（到账记录 + 已缓存的档案），切月时零延迟重绘
function localCalendarEvents() {
  const out = {}
  store.allHoldings().forEach((h) => {
    // 用户自己记的到账记录，按派息日排进日历
    ;(recordsOf(h.id).dividend || []).forEach((r) => {
      pushEvent(out, r.date, {
        code: h.code,
        name: h.name,
        type: '派息日',
        amount: Number(r.amount) || 0
      })
    })

    const hit = dividendFileCache[fileCacheKey(h)]
    if (hit && hit.data) pushFileEvents(out, h, hit.data)
  })
  return out
}

// 异步版：先把每只持仓的分红档案补齐（走缓存或网络），再整体算一遍
function calendarEventsAsync() {
  return Promise.all(store.allHoldings().map((h) => fetchDividendCached(h))).then(() =>
    localCalendarEvents()
  )
}

// 待对账 = 已公告但除权日还没到；nextKey 取其中最早的除权日
function noticeVM() {
  const today = todayKey()
  let count = 0
  let amount = 0
  let nextKey = ''

  store.allHoldings().forEach((h) => {
    const hit = dividendFileCache[fileCacheKey(h)]
    const list = (hit && hit.data && hit.data.list) || []
    const rate = 1 - effectiveTaxRate(h) / 100

    list.forEach((r) => {
      const ex = normDate(r.exDate)
      if (!ex || ex < today) return
      count++
      amount += (Number(r.dps) || 0) * (Number(h.shares) || 0) * rate
      if (!nextKey || ex < nextKey) nextKey = ex
    })
  })

  return { count: count, amount: amount, amountText: moneyText(amount, 2), nextKey: nextKey }
}

/**
 * 纯计算生成某月的日历格子（同步、无 IO）
 * 页面切换月份时先本地重绘，再异步补事件点，避免整页骨架屏闪烁。
 * @param {Object} q { year, month, todayKey, selectedKey }
 * @param {Object} events 可选，缺省时用本地已有的事件
 */
function buildMonthCells(q, events) {
  const year = Number((q && q.year) || 0) || new Date().getFullYear()
  const month = Number((q && q.month) || 0) || 1
  const todayKey = (q && q.todayKey) || ''
  const selectedKey = (q && q.selectedKey) || todayKey
  const src = events || localCalendarEvents()

  const offset = new Date(year, month - 1, 1).getDay()
  const daysInMonth = new Date(year, month, 0).getDate()
  const daysInPrev = new Date(year, month - 1, 0).getDate()

  const cells = []
  for (let i = offset - 1; i >= 0; i--) {
    cells.push({ key: 'p' + i, day: daysInPrev - i, outside: true })
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dayKey(year, month, d)
    cells.push({
      key: key,
      day: d,
      outside: false,
      isToday: key === todayKey,
      selected: key === selectedKey,
      // 当天的分红事件，日期格上的小圆点与选中后的明细都用它
      events: src[key] || null
    })
  }
  const rest = 42 - cells.length
  for (let i = 1; i <= rest; i++) {
    cells.push({ key: 'n' + i, day: i, outside: true })
  }

  return { title: year + '年' + month + '月', week: WEEK, cells: cells }
}

/**
 * 按月取日历数据（含分红事件）
 * @param {Object} q { year, month, todayKey, selectedKey }
 */
function getCalendar(q) {
  // 先补齐分红档案（命中缓存就是纯本地计算），再排日历
  return calendarEventsAsync().then((events) => {
    const base = buildMonthCells(q, events)
    return ok({
      title: base.title,
      week: base.week,
      cells: base.cells,
      legend: mock.calendarLegend,
      notice: noticeVM(),
      events: events
    })
  })
}

// 某天的分红事件
function getDayEvents(key, events) {
  const src = (events || localCalendarEvents())[key] || []
  return src.map((e) => ({
    code: e.code,
    name: e.name,
    type: e.type,
    amount: Number(e.amount) || 0,
    amountText: moneyText(e.amount, 2),
    tagClass: e.type === '派息日' ? 'tag-green' : e.type === '除权除息' ? 'tag-orange' : 'tag-blue'
  }))
}

function getYearOverview(year) {
  const y = mock.yearOverview
  const raw = y.months
  const max = Math.max.apply(null, raw.concat([1]))
  return ok({
    year: year || y.year,
    receivedText: moneyText(y.received, 2),
    hasData: y.received > 0,
    months: mock.yearMonths.map((label, i) => {
      const value = raw[i] || 0
      return {
        label,
        value,
        valueText: moneyText(value, 2),
        height: value > 0 ? Math.max(8, Math.round((value / max) * 100)) : 4,
        active: value > 0
      }
    })
  })
}

/* ================= 发现 ================= */

function getDiscover() {
  return ok({
    tools: mock.discoverTools,
    ranks: mock.discoverRanks,
    articles: mock.discoverArticles
  })
}

/* ================= 我的 ================= */

// 当前登录用户的本地资料（注册 / 登录时写进 userInfo，跟着账号走）
function localUser() {
  const info = wx.getStorageSync('userInfo')
  return info && typeof info === 'object' ? info : {}
}

// 当前登录用户名：App 端不收集手机号，用户名就是唯一身份
function usernameOf() {
  return String(localUser().username || '').trim()
}

/**
 * 展示用昵称。
 *
 * 曾经「我的」页直接读 mock.user.nickName —— 那是个写死的"收息佬用户"，
 * 于是不管谁登录都显示同一个名字。真实昵称在注册 / 登录时就写进 userInfo 了
 * （见 Login.js 的 app.login({ nickName })，取的就是用户名）。
 *
 * 三层回退到默认值，保证任何情况下都有东西可显示：
 *   昵称 → 用户名 → 默认文案
 * 第二层不是多余的：早期版本的 userInfo 只存了 username，没存 nickName，
 * 那些用户升级上来昵称会是空的。
 */
function nickNameOf() {
  const u = localUser()
  return String(u.nickName || '').trim() || usernameOf() || '收息佬用户'
}

// 头像：目前只有默认 emoji，留成函数是为了和昵称同源，将来支持自定义头像时只改这里
function avatarOf() {
  return String(localUser().avatar || '').trim() || '👤'
}

function getProfile() {
  const src = coverageSource()
  const totalYear = src.reduce((s, i) => s + i.year, 0)
  const cur = readCurrency()
  const accounts = readAccounts()
  const active = accounts.filter((a) => a.active)[0]
  const mem = membership.current()

  // 免费开放期里，还没付费的人不再看到「升级解锁 / 去开通」这类引导；
  // 已付费的人照常显示自己的档位与到期时间（那是他们真实买过的东西）。
  const free = membership.freeForAll()
  const openAll = free && !mem.isPaid

  // 菜单右侧的 value 由当前设置实时回显，而不是写死在 mock 里
  const group1 = mock.profileMenus.group1.map((it) => {
    if (it.key === 'member') {
      return Object.assign({}, it, { value: openAll ? '全员免费开放' : membership.statusText() })
    }
    if (it.key === 'currency') return Object.assign({}, it, { value: cur.name + ' ' + cur.symbol })
    if (it.key === 'username') {
      // 登录账号：用户确认「我是谁」最直接的一项
      return Object.assign({}, it, { value: usernameOf() || '未知' })
    }
    if (it.key === 'account') {
      // 带上当前账户自己的持仓数：切完账户能立刻看出这是另一套账
      const mine = active
        ? store.allRows().filter((h) => String(h.accountId || '') === String(active.id)).length
        : 0
      return Object.assign({}, it, {
        value: active
          ? active.name + ' · ' + mine + ' 只持仓（共 ' + accounts.length + ' 个）'
          : '未设置'
      })
    }
    return it
  })

  return ok({
    // 昵称与头像取当前登录用户的真实资料，不用 mock 里那个写死的默认值 ——
    // 显示的是"谁在登录"，不是一份模板（见 nickNameOf 的说明）。
    // slogan 仍是全局文案，与用户无关。
    user: {
      nickName: nickNameOf(),
      avatar: avatarOf(),
      slogan: mock.user.slogan
    },
    // 会员状态：会员卡与「Pro」标记都读它，不再用写死的 user.isPro
    member: {
      tier: mem.tier,
      tierName: openAll ? '全员免费开放' : mem.tierName,
      // badge 是「我的」页顶部那个身份徽章的备选文案。档位判断全部由这里给出，
      // 页面不再自己从 tier 推导 —— 那种「两处各判一次」的写法迟早会跑偏。
      badge: openAll ? '免费' : mem.isPro ? '👑 Pro' : mem.isLite ? 'Lite' : '普通会员',
      isPaid: mem.isPaid,
      isPro: mem.isPro,
      isLite: mem.isLite,
      expired: mem.expired,
      expiresAt: mem.expiresAt,
      daysLeft: mem.daysLeft,
      statusText: openAll ? '当前所有功能对所有人免费开放' : membership.statusText(),
      // 免费期没有「去开通」：页面据此隐藏引导按钮
      cta: openAll ? '' : '去开通',
      tip: openAll
        ? '全部功能已解锁，无需开通'
        : mem.isPro
        ? 'Pro 权益已全部解锁'
        : mem.isLite
        ? 'Lite 已解锁无限持仓'
        : '升级解锁无限持仓 · 港股美股 · 多账户'
    },
    expenseCount: src.length,
    monthExpenseText: moneyText(totalYear / 12, 0),
    yearExpenseText: moneyText(totalYear, 0),
    // 备案号：留空时页面不渲染这一行（见 pages/profile/profile.wxml）
    icpNo: mock.appInfo.icpNo,
    group1,
    group2: mock.profileMenus.group2
  })
}

/* ================= 显示货币 ================= */

const CURRENCY_KEY = 'displayCurrency'

function readCurrency() {
  const code = wx.getStorageSync(CURRENCY_KEY) || 'CNY'
  return mock.currencyOptions.filter((c) => c.code === code)[0] || mock.currencyOptions[0]
}

function getCurrencyOptions() {
  const cur = readCurrency()
  return ok({
    current: cur.code,
    // 把「当前」直接写进文案，原生操作面板没有勾选态
    list: mock.currencyOptions.map((c) =>
      Object.assign({}, c, { label: c.name + ' ' + c.symbol + (c.code === cur.code ? '（当前）' : '') })
    )
  })
}

function saveCurrency(code) {
  const hit = mock.currencyOptions.filter((c) => c.code === code)[0]
  if (!hit) return fail('不支持的币种')
  wx.setStorageSync(CURRENCY_KEY, code)
  store.markDirty()
  return ok(hit)
}

/* ================= 会员 =================
 * 门禁统一在写操作里用 fail(msg, 402) 抛出，util.onError 会把 402 转成
 * 「去升级」弹窗 —— 所以各页面不必各自写一遍引导文案。
 */

// 金额文案：整数不带小数，非整数保留两位并去掉末尾的 0（¥98 / ¥59.6 / ¥0.27）
function priceText(n, d) {
  const v = Number(n) || 0
  const digits = d === undefined ? (v % 1 ? 2 : 0) : d
  const s = v.toFixed(digits)
  // 只在有小数点时才去掉末尾的 0 —— 否则 ¥40 会被截成 ¥4
  return '¥' + (s.indexOf('.') > -1 ? s.replace(/0+$/, '').replace(/\.$/, '') : s)
}

/**
 * 会员中心页的数据组装（同步）。
 * 权益表与方案本来就是本地定义，同步就能拿到 —— 页面必须先渲染出来，
 * 不能把「一进页面就有内容」押在一次异步请求上（请求慢了或抛错就是一片空白）。
 * 服务端那份只在后面覆盖档位与到期时间（见 syncMembership）。
 */
function membershipVM() {
  const cur = membership.current()
  // 免费开放期：状态文案、权益表说明与购买入口都要跟着变
  // （总闸在 utils/membership.js 的 FREE_FOR_ALL）
  const free = membership.freeForAll()
  const openAll = free && !cur.isPaid

  const features = mock.membershipFeatures.map((f) => ({
    name: f.name,
    free: f.free,
    lite: f.lite,
    pro: f.pro,
    // 还没上线的功能如实标注，避免「卖了会员却用不了」
    soon: f.ready === false
  }))

  const plans = mock.membershipPlans.map((p) => {
    const years = p.months / 12
    const isLite = p.tier === 'lite'
    // 划线价 = 按 1 年原价折算的时长总价，这样「省 ¥X」和「X 折」能互相印证
    const origin = Math.round(mock.membershipOriginPerYear * years)
    const perYear = p.price / years
    const perDay = p.price / ((p.months * 365) / 12)

    return {
      key: p.key,
      tier: p.tier,
      name: p.name,
      months: p.months,
      price: p.price,
      priceText: priceText(p.price),
      unit: p.months === 1 ? '/月' : '',
      // Lite 只有一行说明；Pro 写「折合 ¥X/年」，1 年档跟价格是同一个数就不重复写了
      subText: isLite || p.months === 12 ? '' : '折合 ' + priceText(perYear) + '/年',
      originText: isLite ? '' : priceText(origin),
      metaText: isLite
        ? p.note || ''
        : '约 ' +
          priceText(perDay, 2) +
          '/天 · 省 ' +
          priceText(origin - p.price) +
          ' · 相当于 ' +
          ((p.price / origin) * 10).toFixed(1) +
          ' 折',
      badge: p.badge || '',
      hot: !!p.hot,
      best: !!p.best,
      tip: p.tip || '',
      note: p.note || '',
      // 已开通的档位打个标，续费时一眼看到
      owned: cur.isPaid && cur.paidTier === p.tier
    }
  })

  const def = plans.filter((p) => p.hot)[0] || plans[0]

  return {
    status: {
      tier: cur.tier,
      tierName: openAll ? '全员免费开放' : cur.tierName,
      isPaid: cur.isPaid,
      isPro: cur.isPro,
      isLite: cur.isLite,
      expired: cur.expired,
      expiresAt: cur.expiresAt,
      daysLeft: cur.daysLeft,
      statusText: openAll ? '当前所有功能对所有人免费开放' : membership.statusText(),
      // 免费开放期不卖会员：否则等于为「本来就已经免费的功能」收钱
      selling: !free,
      // 这一行说的永远是「免费版」的限制，所以固定读免费档的额度 ——
      // 用当前档位会串成「最多 -1 只持仓」这种怪物
      freeText: openAll
        ? '持仓数量、港股美股、多账户等功能均已解锁，无需付费开通'
        : '免费版：最多 ' +
          mock.membershipLimits.free.holdings +
          ' 只持仓 · 不支持港股美股 · 多账户限 ' +
          mock.membershipLimits.free.accounts +
          ' 个'
    },
    // 权益表是「未来的档位规划」，免费期把标题说清楚，免得和实际行为矛盾
    tableTitle: free ? '档位权益规划（当前全员免费开放）' : '免费 · Lite · Pro 权益对比',
    tableNote: free
      ? '当前所有功能对所有人免费开放，无需开通；后续如调整档位会提前公告'
      : 'Lite 仅解锁无限持仓（不含港股美股）；Pro 解锁全部功能',
    tiers: mock.membershipTiers,
    features,
    plans,
    defaultPlanKey: def ? def.key : '',
    notes: mock.membershipNotes
  }
}

function getMembership() {
  return ok(membershipVM())
}

/**
 * 支付方式 + 「去哪买兑换码」的说明。
 *
 * 为什么单独一个异步接口，而不是并进 membershipVM()：
 * 那个是同步的，页面必须先渲染出来（不能把「一进页面就有内容」押在网络上）。
 * 这份文案只在服务端，要联网取；拿不到就用兜底文案，不能因此让整页空白。
 *
 * 也因此**失败不算错**：返回空的 guide，页面对它做降级处理。
 */
function getPayChannels() {
  // 里面的 try/catch 不是多余的：这层取的是「页面排版要用的辅助数据」，
  // 它不该有任何机会把整页带崩。真实踩过一次 —— cloud.getPayChannels
  // 忘了导出，于是这里同步抛 TypeError，而调用点在 onLoad 生命周期里，
  // release 包的表现就是**点进去直接闪退**。
  //
  // 也就是说：辅助数据要按辅助数据对待，失败退化成空，别让它有机会升级成崩溃。
  try {
    return cloud
      .getPayChannels()
      .then((res) => ok((res && res.data) || {}))
      .catch(() => ok({ channels: [], guide: null }))
  } catch (e) {
    console.warn('[pay] 读取支付方式失败：' + ((e && e.message) || e))
    return Promise.resolve(ok({ channels: [], guide: null }))
  }
}

// 兑换码：必须走服务端校验 —— 放在本地等于把码写死在小程序里
function redeemMembership(code) {
  const c = String(code || '').replace(/\s/g, '').toUpperCase()
  if (!c) return fail('请输入兑换码')

  return cloud
    .redeemMembership(c)
    .then((res) => {
      const m = (res && res.data && res.data.membership) || null
      if (m) membership.write({ tier: m.tier, expiresAt: m.expiresAt, source: '兑换码' })
      return ok(membership.current())
    })
    .catch((e) => fail((e && e.msg) || '兑换失败，请稍后重试'))
}

/**
 * 下单：服务端完成 RSA 签名，拿回一串「调起支付参数」交给微信 SDK。
 *
 * 小程序那版要先 wx.login 换 session_key（虚拟支付要用它签用户态），
 * App 支付不需要 —— 签名全在服务端用商户私钥做，客户端只认方案 key。
 */
function createMembershipOrder(planKey) {
  const plan = mock.membershipPlans.filter((p) => p.key === planKey)[0]
  if (!plan) return fail('请选择开通方案')

  return cloud
    .appayPrepay(plan.key)
    .then((res) => ok(res.data))
    .catch((e) => fail((e && e.msg) || '下单失败，请稍后重试'))
}

// 订单状态：官方明确说 requestVirtualPayment 的 success 回调可能丢失，
// 所以支付成功后要回来轮询，以服务端有没有发货为准
function getOrderStatus(outTradeNo) {
  if (!outTradeNo) return fail('缺少订单号')

  return cloud
    .getOrderStatus(outTradeNo)
    .then((res) => ok(res.data))
    .catch((e) => fail((e && e.msg) || '查询订单失败'))
}

/**
 * 降级宽限期的检查与执行。**必须在 syncMembership 之后调用** ——
 * 它读的是本地档位（刚被服务端结果覆盖过），顺序反了就会拿旧档位做判断。
 *
 * 三个阶段：
 *   1) 档位有效（含 Pro / Lite）→ 清除一切冻结。用户续费后回到 App 即恢复，
 *      不需要任何额外操作；
 *   2) 已过期但还在 7 天缓冲内 → **只提示，不动数据**；
 *   3) 缓冲期满 → 冻结超额部分（用户侧表现为消失，数据仍在，见 store.freezeExcess）。
 *
 * 单独成一个函数而不是并进 syncMembership：后者被会员页当作 boolean 用
 * （`.then((changed) => ...)`），改返回结构会牵动那一处。
 *
 * 返回 { show, phase, ... }，由 App 启动流程决定怎么提示。
 */
function notifyMembershipGrace() {
  const g = membership.graceState()

  // ① 档位有效：清掉可能残留的冻结
  if (!g.expired) {
    const n = store.unfreezeAll()
    return ok({ show: false, phase: '', restored: n })
  }

  const max = membership.limits().holdings
  if (membership.unlimited(max)) return ok({ show: false, phase: '' })

  // 在持 + 已冻结 = 这个账户实际持有的只数（allRaw 已排除冻结的）
  const total = store.allRaw().length + store.frozenRows().length

  // ② 缓冲期内：只提醒
  if (g.active) {
    const over = total - max
    if (over <= 0) {
      // 用户自己删到额度以内了 —— 没违规就不该继续收着
      store.unfreezeAll()
      return ok({ show: false, phase: '' })
    }
    return ok({
      show: true,
      phase: 'grace',
      daysLeft: g.daysLeft,
      deadline: g.deadline,
      over: over,
      max: max
    })
  }

  // ③ 缓冲期满：执行冻结
  store.freezeExcess(max)
  const frozen = store.frozenRows().length
  if (!frozen) return ok({ show: false, phase: '' })
  return ok({ show: true, phase: 'frozen', frozen: frozen, max: max })
}

// 启动时对齐：会员状态以服务端为准，本地只是缓存
function syncMembership() {
  if (!cloud.enabled()) return Promise.resolve(false)

  return cloud
    .getMembership()
    .then((res) => {
      const m = (res && res.data) || null
      if (!m) return false
      membership.write({ tier: m.tier, expiresAt: m.expiresAt, source: m.source || '' })

      // 桌面图标跟着档位走（普通白色版 / Pro 深色版）。
      //
      // 放在这里而不是各页面里，是因为「从服务端拿到权威档位」只有这一处 ——
      // 图标切换必须**恰好发生在此刻**：早了会按本地过期缓存切错，
      // 晚了则要等用户进某个页面才生效。
      //
      // 用 membership.current().isPro 而不是直接判 m.tier === 'pro'：
      // 后者漏掉了「已过期但仍写着 pro」的情况，那种用户不该用 Pro 图标。
      appicon.sync(membership.current().isPro)
      return true
    })
    .catch(() => false)
}

/* ================= 多账户 ================= */

const ACCOUNT_KEY = 'accounts'

function readAccounts() {
  const saved = wx.getStorageSync(ACCOUNT_KEY)
  const list = saved instanceof Array && saved.length ? saved : mock.accounts
  return list.map((a) => Object.assign({}, a, { active: a.id === readActiveAccountId(list) }))
}

function readActiveAccountId(list) {
  const saved = wx.getStorageSync('activeAccountId')
  const src = list || readAccounts()
  if (saved && src.filter((a) => a.id === saved).length) return saved
  const first = src.filter((a) => a.active)[0] || src[0]
  return first ? first.id : ''
}

function writeAccounts(list) {
  wx.setStorageSync(ACCOUNT_KEY, list)
  store.markDirty()
}

// 每个账户顺带给出自己名下的持仓数：删账户时要先说清楚会带走多少
function accountsWithCount(list) {
  const all = store.allRows()
  return list.map((a) =>
    Object.assign({}, a, {
      holdingCount: all.filter((h) => String(h.accountId || '') === String(a.id)).length
    })
  )
}

function getAccounts() {
  const list = readAccounts()
  return ok({ list: accountsWithCount(list), activeId: readActiveAccountId(list) })
}

function switchAccount(id) {
  if (!id) return fail('缺少账户 ID')
  if (!readAccounts().filter((a) => a.id === id).length) return fail('账户不存在')
  wx.setStorageSync('activeAccountId', id)
  // 持仓按 accountId 过滤，这里同步给 store，切完立刻按新账户出账
  store.setAccountId(id)
  // 当前账户也属于要跟着账号走的状态，标记一次让它同步上云
  store.markDirty()
  // 换账户了，行情缓存作废，进持仓页时按新账户那几只重刷
  holdingQuoteAt = 0
  return ok(accountsWithCount(readAccounts()))
}

// 新增账户：名称 + 用途说明
function addAccount(payload) {
  const p = payload || {}
  const name = String(p.name || '').trim()
  if (!name) return fail('请填写账户名称')

  // 会员门禁：账户数上限（免费 / Lite 为 1 个，Pro 为 10 个）
  const gate = membership.checkAccount(readAccounts().length)
  if (!gate.ok) return fail(gate.msg, 402)

  const list = readAccounts().map((a) => Object.assign({}, a, { active: false }))
  list.push({
    id: 'acc_' + Date.now(),
    name,
    broker: String(p.broker || '').trim() || '自定义账户',
    // 持有人写当前登录用户，不用那个写死的默认昵称 ——
    // 否则新建的每个账户都会被挂到"收息佬用户"名下
    holder: nickNameOf(),
    active: false
  })
  writeAccounts(list)
  return ok(list)
}

function removeAccount(id) {
  const list = readAccounts()
  if (list.length <= 1) return fail('至少保留一个账户')
  const next = list.filter((a) => a.id !== id)
  // 账户没了，它名下的持仓与流水也一起清掉，不留无主数据
  store.removeAccountHoldings(id)
  // 删掉的刚好是当前账户时，落到第一个账户
  if (wx.getStorageSync('activeAccountId') === id) {
    wx.setStorageSync('activeAccountId', next[0].id)
    store.setAccountId(next[0].id)
  }
  holdingQuoteAt = 0
  writeAccounts(next)
  return ok(accountsWithCount(next))
}

/* ================= 我的：文档 / 联系 / 注销 ================= */

function getStandardDoc() {
  return ok({ title: '数据口径说明', rows: mock.standardRows })
}

function getContactInfo() {
  return ok(mock.contactInfo)
}

function getLegalDoc(key) {
  const doc = mock.legalDocs[key]
  if (!doc) return fail('文档不存在', 404)
  return ok(Object.assign({ key }, doc))
}

/**
 * 注销账号：服务端删账号 + 业务数据，本机清到出厂状态。
 *
 * 两件都不能省：
 *   - 只清本地 → 下次登录会把云端数据原样拉回来；
 *   - 只清数据不删账号 → 用同一组用户名密码还能登回来，等于没注销。
 * 服务端失败就如实报错，不能让用户以为已经注销了。
 */
function destroyAccount() {
  if (!cloud.enabled()) return fail('云托管未启用，无法注销账号')

  return cloud
    .destroyAccount()
    .then(() => store.destroyUserData())
    .then(() => ok(true))
    .catch((e) => fail((e && e.msg) || '注销失败，请检查网络后重试'))
}

/* ================= 持仓：实时行情与派息口径刷新 =================
 * 进入持仓页 / 持仓详情页时调用，按 code + market 拉一次真实数据并回写本地持仓：
 *   price / priceDate —— 最新价，总市值、浮盈、股价息率跟着它走
 *   baseDps / dps     —— 最近一个完整财年的真实派息，按口径折算成税后每股派息
 * mock 里的 price / dps 只作首次尚未联网时的兜底快照。
 */
let holdingQuoteAt = 0

function refreshHoldingQuotes(force) {
  if (!force && Date.now() - holdingQuoteAt < LIVE_TTL) return Promise.resolve(0)

  // 在持的 + 已归档的都要刷：投资档案要拿「现价」算卖出至今涨跌，
  // 归档标的的现价若不更新，那个百分比会永远停在清仓那天 —— 而这恰恰
  // 是档案页唯一有信息量的数字。
  const list = store.allRaw().concat(store.rawArchived())
  if (!list.length) return Promise.resolve(0)

  // 一次批量请求拿齐所有持仓的行情 + 分红：
  // N 只持仓原来要 2N 次客户端请求（还会撞小程序 10 并发上限），现在只要 1 次；
  // 场外基金的净值与分红在服务端同源，也由同一个接口一并处理。
  return quote
    .fetchDetails(list.map((h) => ({ code: h.code, market: h.market, secid: h.secid || '' })))
    .catch(() => ({}))
    .then((map) => {
      let n = 0
      list.forEach((h) => {
        const entry = map[quote.batchKey(h)]
        const patch = {}

        const q = entry && entry.quote
        // 行情接口给的是**本币**价（港股港元、美股美元），快照也只存本币原值 ——
        // 两边同口径，直接比即可。这正是「只存原值」的好处：以前要先把行情折成
        // 人民币再和存储值比，汇率一动就被判成「价格变了」，白写一次库。
        const livePriceNative = Number(q && q.price) || 0
        if (q && q.price > 0 && livePriceNative !== nativeOf(h, 'price')) {
          patch.price = livePriceNative
          patch.priceNative = livePriceNative
          patch.priceDate = '实时行情 ' + (q.priceDate || todayKey())
        }

        const dpsPatch = holdingDpsPatch(h, entry && entry.dividend)
        if (dpsPatch) {
          if (dpsPatch.baseDps !== h.baseDps) {
            patch.baseDps = dpsPatch.baseDps
            patch.baseDpsNative = dpsPatch.baseDpsNative
          }
          if (dpsPatch.dps !== h.dps) {
            patch.dps = dpsPatch.dps
            patch.dpsNative = dpsPatch.dpsNative
          }
        }

        if (!Object.keys(patch).length) return
        // 用户新增的持仓直接改记录，内置持仓写一份本地覆盖补丁
        if (h.custom) store.updateAdded(h.id, patch)
        else store.patchBuiltin(h.id, patch)
        n++
      })
      holdingQuoteAt = Date.now()
      return n
    })
}

/* ================= 发现：榜单 / 文章 / 工具 ================= */

function withMarketLabel(item) {
  return Object.assign({}, item, {
    marketLabel: MARKET_LABEL[item.market] || item.market,
    cls: (MARKET[item.market] || MARKET.US).cls,
    valueText: util.money(item.value, 2)
  })
}

// 榜单条形：以榜首为 100%，最低保留 8% 保证可见
function boardRows(items, unit) {
  const max = Math.max.apply(null, items.map((i) => i.value).concat([1]))
  return items.map((item, i) =>
    Object.assign(withMarketLabel(item), {
      key: item.market + '-' + item.code,
      rank: i + 1,
      valueText: unit === '年' ? util.money(item.value, 0) : util.money(item.value, 2),
      width: Math.max(8, Math.round((item.value / max) * 100)),
      top3: i < 3
    })
  )
}

// 权重榜：按自由流通市值占比归一（港股已折人民币）
function weightedRows(pool) {
  const total = pool.reduce((s, i) => s + i.capCny, 0)
  if (!total) return []
  return pool
    .map((i) => Object.assign({}, i, { value: (i.capCny / total) * 100 }))
    .sort((a, b) => b.value - a.value)
}

/**
 * 榜单：成员名单来自 mock.rankBoards[type].codes（编辑侧精选），
 * 数值全部由「实时行情 + 真实分红记录」现算：
 *   yield  税后股价息率（%）  years  连续分红年数（年）  weight  自由流通市值加权占比（%）
 */
function getRank(type) {
  const board = mock.rankBoards[type]
  if (!board) return fail('榜单不存在', 404)

  return buildLiveList(board.codes)
    .then((pool) => {
      let rows
      if (board.metric === 'years') {
        rows = pool.filter((i) => i.live && i.years > 0).sort((a, b) => b.years - a.years)
      } else if (board.metric === 'weight') {
        rows = weightedRows(pool.filter((i) => i.live && i.capCny > 0))
      } else {
        rows = pool.filter((i) => i.live && i.value > 0).sort((a, b) => b.value - a.value)
      }

      if (!rows.length) return fail('行情获取失败，请稍后重试')

      return ok({
        id: board.id,
        name: board.name,
        icon: board.icon,
        badge: board.badge,
        unit: board.unit,
        note: board.note,
        list: boardRows(
          board.metric === 'years'
            ? rows.map((i) => Object.assign({}, i, { value: i.years }))
            : rows,
          board.unit
        )
      })
    })
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

function getArticle(id) {
  const meta = mock.discoverArticles.filter((a) => a.id === id)[0]
  const body = mock.articleBodies[id]
  if (!meta || !body) return fail('文章不存在', 404)

  return ok({
    id,
    title: meta.title,
    tag: meta.tag,
    read: meta.read,
    icon: meta.icon,
    updated: '2026-08-20',
    body: body.body
  })
}

// 定投回测的候选池：与息率对比同源，页面先异步取一次，再交给同步的 previewDca
function ensureYieldPool() {
  return buildLiveList(mock.yieldCompareCodes)
    .then((pool) => pool.filter((i) => i.live && i.value > 0).sort((a, b) => b.value - a.value))
    .then((pool) => (pool.length ? pool : fail('行情获取失败，请稍后重试')))
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

// 息率对比：跨市场横向拉平，息率实时计算，条形宽度对榜首归一
function getYieldCompare() {
  return ensureYieldPool()
    .then((pool) => {
      const max = Math.max.apply(null, pool.map((i) => i.value).concat([1]))
      return ok({
        note: '税后股价息率 = 上一个完整年度的每股派息 ÷ 最新股价（港股按默认 20% 红利税折算，持仓里可逐只调整），随行情实时计算。',
        list: pool.map((item, i) =>
          Object.assign(withMarketLabel(item), {
            key: item.market + '-' + item.code,
            rank: i + 1,
            width: Math.max(8, Math.round((item.value / max) * 100))
          })
        )
      })
    })
    .catch((e) => fail((e && e.msg) || '行情获取失败，请稍后重试', (e && e.code) || 0))
}

// 跨市场关键字搜索：发现页用，不限市场，走真实行情搜索接口
function searchAllStocks(keyword) {
  const kw = String(keyword || '').trim()
  if (!kw) return ok([])

  return quote
    .search(kw)
    .then((list) => ok(list.map(stockBriefVM)))
    .catch((e) => fail((e && e.msg) || '搜索失败，请稍后重试', (e && e.code) || 0))
}

/* ================= 复利 / 定投回测（同步纯计算） ================= */

/**
 * 定投 + 一次性本金 的复利终值。
 * 收益按月复利、月供在月末投入，是理财计算器的通行口径。
 */
function compoundValue(principal, monthly, rate, years) {
  const r = rate / 100 / 12
  const n = Math.max(1, Math.round(years * 12))
  const grow = Math.pow(1 + r, n)
  const fromPrincipal = principal * grow
  const fromMonthly = r > 0 ? monthly * ((grow - 1) / r) : monthly * n
  const invested = principal + monthly * n

  return {
    finalValue: fromPrincipal + fromMonthly,
    invested,
    gain: fromPrincipal + fromMonthly - invested,
    rate: invested > 0 ? ((fromPrincipal + fromMonthly - invested) / invested) * 100 : 0
  }
}

function previewCompound(params) {
  const p = params || {}
  const d = mock.compoundDefaults
  const principal = Number(p.principal) || d.principal
  const monthly = Number(p.monthly) || 0
  const rate = Number(p.rate) || 0
  const years = Math.min(d.maxYears, Math.max(1, Number(p.years) || d.years))

  const total = compoundValue(principal, monthly, rate, years)

  // 抽样出展示用的年度曲线：年数多时只取 6 个点，避免柱子挤成一团
  const step = Math.max(1, Math.ceil(years / 6))
  const curve = []
  for (let y = step; y <= years; y += step) {
    const c = compoundValue(principal, monthly, rate, y)
    curve.push({ label: y + '年', value: c.finalValue, valueText: amountText(c.finalValue) })
  }
  if (curve[curve.length - 1] && curve[curve.length - 1].label !== years + '年') {
    const c = compoundValue(principal, monthly, rate, years)
    curve.push({ label: years + '年', value: c.finalValue, valueText: amountText(c.finalValue) })
  }

  const max = Math.max.apply(null, curve.map((i) => i.value).concat([1]))
  curve.forEach((i) => {
    i.height = Math.max(6, Math.round((i.value / max) * 100))
  })

  return {
    principal,
    monthly,
    rate,
    years,
    // 滑块旁的数值文案由这里产出，页面不再自己拼金额
    principalText: moneyText(principal, 0),
    monthlyText: moneyText(monthly, 0),
    finalText: moneyText(total.finalValue, 2),
    investedText: moneyText(total.invested, 2),
    gainText: moneyText(total.gain, 2),
    rateText: util.money(total.rate, 1),
    multipleText: util.money(total.invested ? total.finalValue / total.invested : 0, 2),
    curve
  }
}

/**
 * 持仓页「20 年可达 X 倍」：以当前总成本为本金，按「成本息率 + 长期股息增长 3%」
 * 作为年化、分红全部再投入，推演 20 年后的资产倍数。
 */
const DIVIDEND_GROWTH = 3

function returnProjection(rate) {
  const years = 20
  const y = (Number(rate) || 0) / 100 + DIVIDEND_GROWTH / 100
  const multiple = Math.pow(1 + y, years)

  return {
    multiple,
    multipleText: util.money(multiple, 1),
    years,
    annualRateText: util.money((Number(rate) || 0) + DIVIDEND_GROWTH, 2),
    dividendGrowth: DIVIDEND_GROWTH
  }
}

/**
 * 定投回测：逐月买入、每年把分红按当年市价再投入。
 * 息率不写死：由调用方传入实时算好的候选池（api.ensureYieldPool），
 * 取池中该标的的税后股价息率；股价年增长是演示用的简化假设。
 * pool 为空时返回 null，页面据此给出重试提示。
 */
function previewDca(params, pool) {
  const src = (pool || []).slice().sort((a, b) => b.value - a.value)
  if (!src.length) return null

  const p = params || {}
  const d = mock.dcaDefaults
  // 候选标的直接用息率对比那份清单，息率即为该标的的税后股价息率
  const stock = src.filter((s) => s.code === p.code)[0] || src[0]

  const monthly = Number(p.monthly) || d.monthly
  const years = Math.min(30, Math.max(1, Number(p.years) || d.years))
  const yieldRate = stock.value
  const growth = d.priceGrowth

  // 起始价用 1 元，最终只关心相对收益，与真实股价无关
  let price = 1
  let shares = 0
  let invested = 0
  let dividendTotal = 0
  const rows = []

  for (let y = 0; y < years; y++) {
    let yearDividend = 0
    for (let m = 0; m < 12; m++) {
      const buy = monthly / price
      shares += buy
      invested += monthly
    }
    yearDividend = shares * price * (yieldRate / 100)
    dividendTotal += yearDividend
    // 分红按当年市价再投入
    shares += yearDividend / price

    rows.push({
      year: y + 1,
      label: y + 1 + '年',
      invested: invested,
      investedText: moneyText(invested, 0),
      shares: shares,
      sharesText: util.group(shares, 0),
      value: shares * price,
      valueText: moneyText(shares * price, 0),
      dividendText: moneyText(dividendTotal, 0)
    })

    price = price * (1 + growth / 100)
  }

  const last = rows[rows.length - 1] || { value: 0, shares: 0 }
  const finalValue = last.value
  const gain = finalValue - invested
  const max = Math.max.apply(null, rows.map((r) => r.value).concat([1]))
  rows.forEach((r) => {
    r.height = Math.max(6, Math.round((r.value / max) * 100))
  })

  // 年化收益率：用期末市值反推
  const annual = invested > 0 && years > 0 ? (Math.pow(finalValue / invested, 1 / years) - 1) * 100 : 0

  return {
    code: stock.code,
    name: stock.name,
    market: stock.market,
    marketLabel: MARKET_LABEL[stock.market] || stock.market,
    monthly,
    years,
    yieldRate,
    yieldText: util.money(yieldRate, 2) + '%',
    priceGrowth: growth,
    monthlyText: moneyText(monthly, 0),
    pool: src.map((s) =>
      Object.assign({}, s, {
        marketLabel: MARKET_LABEL[s.market] || s.market,
        cls: (MARKET[s.market] || MARKET.US).cls,
        valueText: util.money(s.value, 2)
      })
    ),
    investedText: moneyText(invested, 0),
    dividendText: moneyText(dividendTotal, 0),
    valueText: moneyText(finalValue, 0),
    gainText: moneyText(gain, 0),
    gainRateText: util.money(invested ? (gain / invested) * 100 : 0, 1),
    annualText: util.money(annual, 1),
    sharesText: util.group(last.shares || 0, 0),
    hasProfit: gain >= 0,
    rows
  }
}

/* ================= 持仓详情：交易明细 / 分红记录 / 分红档案 ================= */

// 交易 / 分红记录已交给 store 统一管理（本地快照 + 云端同步）
function readRecords() {
  return store.readRecords()
}

function writeRecords(all) {
  store.writeRecords(all)
}

function recordsOf(id) {
  const all = readRecords()
  return all[id] || { trade: [], dividend: [] }
}

/* ---------------- 持仓 = 建仓基准 + 全部交易明细 ----------------
 * 交易明细不只是流水：买入 / 卖出 / 送股会真实改变持仓的股数与摊薄成本。
 * 这里统一按「建仓基准 + 全部明细」整体重算，而不是在原值上做加减 ——
 * 删除记录能自然回退，反复增删也不会累积浮点误差。
 */

// 交易类型 -> 对持仓的影响
//   buy  股数与投入一起加，成本按加权平均（分红复投本质就是用分红再买）
//   sell 只减股数，摊薄单价不变
//   free 送股 / 转送股：股数白得，投入总额不变 → 单价被摊薄
const TRADE_EFFECT = {
  买入: 'buy',
  分红复投: 'buy',
  卖出: 'sell',
  送股: 'free',
  转送股: 'free'
}

/**
 * 建仓基准：首次由交易改动持仓时冻结下来，
 * 这样交易明细第一行（建仓记录）之后就不会跟着持仓一起变了。
 * 还没冻结过（刚建仓 / 老数据）时，当前持仓就是基准 —— 因为在此之前交易并没有改过持仓。
 */
function seedBaseOf(h) {
  const frozen = h && h.seedShares !== undefined && h.seedShares !== null
  // 基准成本一律取**本币原值** —— 快照里 cost 与 costNative 现在同为本币，
  // 但冻结过的那份只有 seedCostNative 是权威的
  const costNative = frozen ? nativeOf(h, 'seedCost') : nativeOf(h, 'cost')
  return {
    shares: Number(frozen ? h.seedShares : h.shares) || 0,
    cost: costNative,
    costNative: costNative,
    date: String((frozen ? h.seedDate : h.buyDate) || '')
  }
}

// 从建仓基准 + 全部交易明细重算股数与摊薄成本（按日期先后顺序算）
function positionOf(h, trades) {
  const seed = seedBaseOf(h)
  const market = (h && h.market) || 'A'
  const list = (trades || [])
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))

  // 两个口径并行推进，值相同（存储只保留本币原值），分开写是为了
  // 让「本币原值」这条主线在代码里始终显眼
  const seedFee = nativeOf(h, 'fee')
  let shares = seed.shares
  let cost = seed.cost
  let costNative = seed.costNative

  // 建仓时填的手续费也要算进投入 —— 它和那笔买入是一体的。
  // 以前这里只从交易明细取 fee，建仓那笔的手续费被整个丢掉了，
  // 用户看到的就是「我填了手续费，成本却按没填算」。
  if (seed.shares > 0 && seedFee > 0) {
    // 摊到这 seed.shares 股上，等价于「每股成本 + 手续费 ÷ 股数」
    cost += seedFee / seed.shares
    costNative += seedFee / seed.shares
  }

  list.forEach((t) => {
    // baked = 已被「重置建仓基准」计入基准的那部分历史交易，不再重复作用一次
    if (t.baked) return

    const n = Number(t.shares) || 0
    if (!(n > 0)) return

    const kind = TRADE_EFFECT[t.type] || 'buy'

    if (kind === 'sell') {
      // 卖出：只减股数，单价不变（最多卖到 0）
      shares = Math.max(0, shares - n)
      return
    }

    const total = shares + n
    if (total > 0) {
      const price = Number(t.price) || 0
      const fee = Number(t.fee) || 0
      // 记录上的本币原值；老记录没存过，由 nativeOf 按记账汇率反算兜底
      const priceNative = nativeOf(t, 'price', market)
      const feeNative = nativeOf(t, 'fee', market)

      cost =
        kind === 'free'
          ? // 送股不花钱：投入总额不变，单价被摊薄
            (cost * shares) / total
          : // 买入 / 分红复投：投入按股数加权，手续费计入成本
            (cost * shares + n * price + fee) / total

      costNative =
        kind === 'free'
          ? (costNative * shares) / total
          : (costNative * shares + n * priceNative + feeNative) / total
    }
    shares = total
  })

  return {
    shares,
    cost: Number(cost.toFixed(6)),
    costNative: Number(costNative.toFixed(6))
  }
}

// 写回持仓。内置持仓与用户新增持仓在 store 里已经是同一条路，这里给个统一入口。
//
// 取行必须用 getRawAny（含已归档）：归档标的的现价刷新、事后补写清仓心得
// 都要写回这一行。用 getRaw 的话归档行取不到 → 直接 return null，
// 调用方毫无察觉地丢掉这次写入。
function writeHoldingPatch(id, patch) {
  const cur = store.getRawAny(id)
  if (!cur) return null
  if (cur.custom) store.updateAdded(id, patch)
  else store.patchBuiltin(id, patch)
  return store.getHoldingAny(id)
}

// 把交易明细的影响落到持仓上（首次改动时顺手把建仓基准冻下来）
function applyTradesToHolding(h, trades) {
  const pos = positionOf(h, trades)
  const patch = { shares: pos.shares, cost: pos.cost, costNative: pos.costNative }

  if (h.seedShares === undefined || h.seedShares === null) {
    patch.seedShares = Number(h.shares) || 0
    // 冻结的基准成本同样取本币原值（h.cost 已被 decorate 按实时汇率折过，
    // 拿它当基准会让基准跟着汇率漂）
    patch.seedCost = nativeOf(h, 'cost')
    patch.seedCostNative = nativeOf(h, 'cost')
    patch.seedDate = h.buyDate || ''
  }

  return writeHoldingPatch(h.id, patch)
}

// 已收分红 = 全部到账记录的合计。增删都整体重算，删除记录自然回退
function applyDividendsToHolding(h, dividends) {
  const received = (dividends || []).reduce((s, r) => s + (Number(r.amount) || 0), 0)
  return writeHoldingPatch(h.id, { received: Number(received.toFixed(2)) })
}

/**
 * 重置建仓基准：把当前持仓当作新的起点，已有交易明细只作流水展示。
 * 用在「用户曾经为了让数字对上，手动改过持仓股数」的情况 ——
 * 否则下一次增删交易时，整体重算会把那些交易的量再加一遍。
 */
function resetSeedBase(id) {
  const raw = store.getRaw(id)
  if (!raw) return fail('未找到该持仓', 404)

  const h = store.getHolding(id)

  // 1. 明细先打上 baked 标记：这些量已经包含在新基准里了，不再参与重算
  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.trade = (cur.trade || []).map((t) => Object.assign({}, t, { baked: true }))
  all[id] = cur
  writeRecords(all)

  // 2. 再把当前持仓冻结成新的建仓基准
  // 基准里只放「用户填的成本」，手续费单独留在 fee 字段上由 positionOf 摊 ——
  // 而此刻 h.cost 已经含过手续费了，所以这里要先把 fee 减掉，否则重算时
  // positionOf 会再摊一次，成本凭空膨胀。
  const seedCost = Number((nativeOf(h, 'cost') - (nativeOf(h, 'fee') || 0) / (Number(h.shares) || 1)).toFixed(6))

  writeHoldingPatch(id, {
    seedShares: Number(h.shares) || 0,
    seedCost: seedCost,
    seedCostNative: seedCost,
    seedDate: h.buyDate || ''
  })

  return getHoldingRecords(id)
}

// 交易明细：把持仓本身的买入信息折算成第一条记录
// 交易类型 -> 标签配色：买入绿 / 卖出橙 / 送股&转送股金 / 分红复投蓝
const TRADE_TAG_CLASS = {
  买入: 'tag-green',
  卖出: 'tag-orange',
  转送股: 'tag-gold',
  送股: 'tag-gold',
  分红复投: 'tag-blue'
}

function tradeVM(h) {
  const market = h.market || 'A'
  // 首行用「建仓基准」而不是当前持仓：否则加完交易，这条历史记录会跟着一起变
  const base = seedBaseOf(h)
  // 建仓那行的手续费取持仓上的 fee（当初建仓时填的）——
  // 写死成 0 会让人以为这笔钱没算进成本，其实它算进去了，只是没显示
  const seedFee = nativeOf(h, 'fee')
  const seed = {
    id: 'seed-' + h.id,
    date: base.date,
    type: '买入',
    shares: base.shares,
    price: base.cost,
    priceNative: base.costNative,
    fee: seedFee,
    feeNative: seedFee,
    seed: true
  }
  const extra = recordsOf(h.id).trade || []
  const list = [seed].concat(extra)

  return list
    .map((r) => ({
      id: r.id,
      date: r.date || '—',
      type: r.type,
      typeClass: TRADE_TAG_CLASS[r.type] || 'tag-green',
      sharesText: util.group(r.shares, 0) + '股',
      // 成交价与手续费是「这只股票的价格」，按本币显示（与行情、券商对账单一致）；
      // 成交金额是资产类数字，按显示货币走
      priceText: nativeOfText(r, 'price', market, 4),
      // r.price 已是本币，成交金额是资产类数字：先折人民币，再按显示货币呈现
      amountText: moneyText(
        (Number(r.shares) || 0) * (Number(r.price) || 0) * cnyPerUnitLive(market),
        2
      ),
      feeText: nativeOfText(r, 'fee', market, 2),
      // 当时的想法：清仓那笔尤其值得陈列出来
      note: String(r.note || '').trim(),
      seed: !!r.seed
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// 分红记录：用户添加的到账记录 + 由持仓 received 汇总
function dividendVM(h) {
  const list = recordsOf(h.id).dividend || []
  return list
    .map((r) => ({
      id: r.id,
      date: r.date || '—',
      note: r.note || '现金分红',
      planText: r.plan || '—',
      // r.amount 是本币，折成实时人民币后按显示货币呈现
      amountText: moneyText((Number(r.amount) || 0) * cnyPerUnitLive(market), 2)
    }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

// '2025年报' -> 2025；'2026-06-26' -> 2026
function yearOf(r) {
  const m = String(r.period || r.exDate || '').match(/\d{4}/)
  return m ? Number(m[0]) : 0
}

/**
 * 分红档案：真实历史派息记录（与添加自选页同源），
 * 每行按当前股数与税率折算成税后到账金额。
 * dividend 为 null 表示该市场没有开放分红接口，退化为空档案。
 */
function dividendFileVM(h, dividend) {
  // 该持仓实际生效的税率（关掉「预测分红扣税」就等于 0%）
  const taxRate = effectiveTaxRate(h)
  // 税后到账 = 每股派息 × 股数 × (1 - 税率)
  const rate = 1 - taxRate / 100
  // 接口给的每股派息是**本币**，乘股数得到本币金额，再按**实时汇率**
  // 折成人民币 —— 这些是「未来能收到多少」，要用当下的汇率看。
  const cny = cnyPerUnitLive(h.market)
  const list = (dividend && dividend.list) || []

  let markedCurrent = false
  const rows = list.map((r, i) => {
    // 已公告但还没除权的方案：照常列出，但不标「最近一次」
    const pending = !r.exDate
    const current = !pending && !markedCurrent
    if (current) markedCurrent = true

    return {
      // 同年可能有多期方案（中报 + 年报），key 用下标保证唯一
      key: 'dv-' + i,
      year: yearOf(r) || '—',
      yearText: r.period || r.exDate || '—',
      planText: r.planText || '—',
      exDate: r.exDate || '—',
      payDate: r.payDate || r.recordDate || '—',
      dateText: dividendDateLine(r),
      // 每股派息按本币显示；到账金额是资产类数字，折成人民币后按显示货币走
      dpsText: nativeRawText(r.dps, h.market, 4),
      amount: r.dps * cny * h.shares * rate,
      amountText: moneyText(r.dps * cny * h.shares * rate, 2),
      pending,
      current
    }
  })

  return {
    list: rows,
    totalText: moneyText(rows.reduce((s, r) => s + r.amount, 0), 2),
    // h.received 已经由 decorate 按实时汇率折成人民币了，这里不要再乘汇率
    passedText: moneyText(h.received || 0, 2),
    source: dividend ? dividend.source : '',
    emptyText: dividend ? '该标的暂无分红记录' : '该市场暂未开放分红档案接口'
  }
}

function getHoldingRecords(id) {
  // 用 getHoldingAny 而不是 getHolding：已清仓归档的标的也要能翻看历史流水，
  // 否则投资档案点进去就是「未找到该持仓」—— 而记录明明还在。
  const h = store.getHoldingAny(id)
  if (!h) return fail('未找到该持仓', 404)

  // 历史派息走真实接口；取不到时退化为空档案，不影响其余内容展示
  return quote
    .fetchDividend({ code: h.code, market: h.market })
    .catch(() => null)
    .then((dividend) => {
      const vm = holdingVM(h)
      const file = dividendFileVM(h, dividend)

      return ok({
        holding: vm,
        // 已归档 = 这一页只读。页面据此收起「记一笔」与「删除」：
        // 档案页点进来是复盘，不是编辑；而且那两个入口点下去本来就取不到
        // 持仓（AddTrade 会直接报「未找到该持仓」），留着只会误导。
        archived: store.isArchived(h),
        trade: tradeVM(h),
        dividend: dividendVM(h),
        file: file.list,
        fileTotalText: file.totalText,
        filePassedText: file.passedText,
        fileSource: file.source,
        fileEmptyText: file.emptyText,
        receivedText: vm.receivedText
      })
    })
}

function addTradeRecord(id, form) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)

  const f = form || {}
  const shares = Number(f.shares)
  const price = Number(f.price)
  if (!(shares > 0)) return fail('请填写正确的股数')
  if (!(price >= 0)) return fail('请填写正确的成交价')

  const type = f.type || '买入'
  // 卖出不能超过当前持仓：拦下来比静默按 0 算要清楚
  if (TRADE_EFFECT[type] === 'sell' && shares > (Number(h.shares) || 0)) {
    return fail('卖出数量不能超过当前持仓 ' + util.group(Number(h.shares) || 0, 0) + ' 股')
  }

  // 成交价与手续费填的都是**本币**，快照也只存本币原值 ——
  // 与持仓里的 cost 同口径，加权摊薄时不会串味
  const feeNative = Number(f.fee) || 0
  // 「当时的想法」：过一段时间回看，「为什么卖」比「卖在什么价」有价值得多。
  // 用 clip 而不是 slice：slice 数的是 UTF-16 码元，emoji 会被切出半个代理项。
  const note = validate.clip(String(f.note || '').trim(), MEMO_MAX)

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.trade = (cur.trade || []).concat([
    {
      id: 'tr_' + Date.now(),
      date: f.date || todayKey(),
      type,
      shares,
      price: price,
      // 本币原值：成交价与手续费展示时直读，不再从人民币反算
      priceNative: price,
      fee: feeNative,
      feeNative: feeNative,
      note: note
    }
  ])
  all[id] = cur
  writeRecords(all)

  // 明细不只是流水：买入 / 卖出 / 送股会真的改变持仓的股数与摊薄成本
  const updated = applyTradesToHolding(h, cur.trade)

  // 清仓 = 卖出后股数归零。这里自动把它归档，并记下清仓价与日期 ——
  // 投资档案页要拿这两个数算「卖出至今涨跌」，用来验证当初的判断对不对。
  // 归档是标记而不是删除：交易流水一条不动，随时能翻回去看。
  if (updated && TRADE_EFFECT[type] === 'sell' && Number(updated.shares) <= 0) {
    writeHoldingPatch(id, {
      archived: true,
      archivedAt: f.date || todayKey(),
      archiveReason: note,
      exitPrice: price,
      exitPriceNative: price
    })
  }

  return getHoldingRecords(id)
}

// 分红记录的展示文案：方案按「每 10 股派 X」的惯例写，金额用该标的的**本币**
// （行情软件、券商对账单都是本币口径）；备注里的扣税金额则按显示货币走。
function dividendRemark(market, shares, dps, taxNative) {
  const plan = dps > 0 ? '每 10 股派 ' + nativeSymbol(market) + util.money(dps * 10, 2) : ''

  let note = '现金分红'
  if (taxNative > 0) {
    // 收的是本币，而扣税金额是资产类数字，按显示货币呈现
    note += '（扣税 ' + moneyText(taxNative * cnyPerUnitLive(market), 2) + '）'
  } else if (shares > 0 && dps > 0) {
    note += '（' + util.group(shares, 0) + ' 股）'
  }

  return { note, plan }
}

function addDividendRecord(id, form) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)

  const f = form || {}
  const amount = Number(f.amount)
  if (!(amount > 0)) return fail('请填写正确的到账金额')

  // 到账金额、每股派息、扣税填的都是**本币**（页面按该持仓的本币单位收），
  // 快照也只存本币原值
  const shares = Number(f.shares) || 0
  const dps = Number(f.dps) || 0
  const tax = Number(f.tax) || 0
  // 明细里只展示金额 + 一行小字，把「每 10 股派多少」和扣税情况拼进这一行
  const remark = dividendRemark(h.market, shares, dps, tax)

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.dividend = (cur.dividend || []).concat([
    {
      id: 'dv_' + Date.now(),
      date: f.date || todayKey(),
      amount: amount,
      amountNative: amount,
      // 记下派息三要素（本币），之后能还原这笔分红的算法
      shares,
      dps: dps,
      dpsNative: dps,
      tax,
      taxNative: tax,
      note: String(f.note || '').trim() || remark.note,
      plan: String(f.plan || '').trim() || remark.plan
    }
  ])
  all[id] = cur
  writeRecords(all)

  // 到账金额直接进「累计已收」，回本进度跟着走
  applyDividendsToHolding(h, cur.dividend)

  return getHoldingRecords(id)
}

// 删除一条交易记录（持仓自带的买入记录不允许删）
function removeTradeRecord(id, recordId) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)
  if (String(recordId).indexOf('seed-') === 0) return fail('持仓自带的买入记录不可删除')

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.trade = (cur.trade || []).filter((r) => r.id !== recordId)
  all[id] = cur
  writeRecords(all)

  // 删掉一笔交易，持仓要跟着退回这笔交易之前的状态
  applyTradesToHolding(h, cur.trade)

  return getHoldingRecords(id)
}

function removeDividendRecord(id, recordId) {
  const h = store.getHolding(id)
  if (!h) return fail('未找到该持仓', 404)

  const all = readRecords()
  const cur = all[id] || { trade: [], dividend: [] }
  cur.dividend = (cur.dividend || []).filter((r) => r.id !== recordId)
  all[id] = cur
  writeRecords(all)

  // 删掉一笔到账记录，累计已收跟着减回去
  applyDividendsToHolding(h, cur.dividend)

  return getHoldingRecords(id)
}

// 编辑持仓：只允许改录入侧字段，行情侧字段保持不动
function updateHolding(id, form) {
  const raw = store.getRaw(id)
  if (!raw) return fail('未找到该持仓', 404)

  const f = form || {}
  const shares = Number(f.shares)
  if (!(shares > 0)) return fail('请填写正确的持仓数量')

  // 编辑面板填的同样是**本币**，快照只存本币原值 ——
  // 与新增持仓、交易记录保持同一个口径，录入的数字不会再被汇率改写
  const costNative = Number(f.cost) || 0
  const cost = costNative
  const feeNative = Number(f.fee) || 0
  const buyDate = f.buyDate || raw.buyDate || ''
  // 税率：没传就沿用原值，传了以页面为准；都没值时才退回市场默认
  const taxRate = taxRateFromForm(
    { taxRate: f.taxRate === undefined ? raw.taxRate : f.taxRate },
    raw.market
  )
  const taxOn = f.taxOn === undefined ? raw.taxOn !== false : f.taxOn !== false
  const patch = {
    shares,
    cost,
    costNative,
    // 负成本时现价跟着成本走，本币原值同理；否则沿用原值（老数据交给 nativeOf 兜底）
    price: f.negativeCost ? Math.abs(cost) : raw.price,
    priceNative: f.negativeCost ? Math.abs(costNative) : nativeOf(raw, 'price'),
    buyDate,
    // 买入日期变了持股天数必须跟着重算，否则页面上还是录入时的老数字
    holdingDays: buyDate ? daysSince(buyDate) : raw.holdingDays,
    // 这里的 fee 沿用历史行为 —— 编辑面板存进来的是本币原值，没有像新增持仓
    // 那样折成人民币。为不动已有数据口径，暂不修正，只把本币那份显式记下来。
    fee: feeNative,
    feeNative: feeNative,
    costMode: f.costMode || raw.costMode || '',
    negativeCost: !!f.negativeCost,
    taxRate: taxRate,
    taxOn: taxOn,
    divMode: f.divMode || raw.divMode || ''
  }

  const write = () => {
    if (raw.custom) store.updateAdded(id, patch)
    // 内置持仓：以「本地覆盖」的方式存一份补丁，不改 mock 源数据
    else store.patchBuiltin(id, patch)

    // 首次编辑时把建仓基准定下来：基准只放用户刚填的每股成本（不含手续费），
    // 手续费由 fee 字段单独记着，重算时再摊进来。
    // 已冻结过的不动 —— 那份基准代表「用户当初录入的起点」，编辑不该改写它。
    if (raw.seedShares === undefined || raw.seedShares === null) {
      writeHoldingPatch(id, {
        seedShares: shares,
        seedCost: costNative,
        seedCostNative: costNative,
        seedDate: buyDate
      })
    }

    // 与新建持仓同一口径：编辑后的成本也要把手续费摊进去。
    // 否则用户在编辑面板改完成本，看到的还是「不含手续费」的那个数 ——
    // 而新建出来的是含的，同一只持仓两个入口两个结果。
    const cur = store.getHolding(id)
    if (cur) {
      const trades = (readRecords()[id] || {}).trade || []
      applyTradesToHolding(cur, trades)
    }

    return ok(holdingVM(store.getHolding(id)))
  }

  // 分红口径和税率都没动，就不用重算 dps
  if (!f.divMode && f.taxRate === undefined && f.taxOn === undefined) return write()

  const idx = Math.max(0, DIV_MODES.indexOf(f.divMode))
  const custom = Number(f.customDividend)

  // 自定义口径直接用用户填的金额
  if (idx === 3 && custom > 0) {
    patch.dps = custom
    patch.dpsNative = custom
    return write()
  }

  // 其余口径要按真实派息基数重算，否则预测分红不会跟着变
  return resolveBaseDps(raw, idx).then((base) => {
    patch.dps = base > 0 ? Number(netDpsOf(base, taxOn ? taxRate : 0).toFixed(6)) : raw.dps
    // 与上面那支分支保持一致：dps 存的就是本币值，原值直接跟着写一份
    patch.dpsNative = patch.dps
    return write()
  })
}

/**
 * 按口径取每股派息的基数（税前，本币）。
 *
 * 换口径时必须重新取一次真实分红记录 —— 记录里存的那份 baseDps 是**上一个口径**
 * 算出来的（比如原来是"近5年"的均值），拿来当"近3年"的基数只会越算越歪。
 * 所以顺序是：现取真实档案 → 取不到才退回记录里那份 → 都没有才用标的池。
 */
function resolveBaseDps(raw, idx) {
  return quote
    .fetchDividend({ code: raw.code, market: raw.market })
    .catch(() => null)
    .then((d) => {
      const base = d ? dpsBaseFor(d, idx, 0) : 0
      if (base > 0) return base
      const saved = Number(raw.baseDpsNative || raw.baseDps || 0)
      if (saved > 0) return saved
      const inPool = findStock(raw.code)
      return inPool ? inPool.dps : 0
    })
}

module.exports = {
  // 用户（登录 / 注册在 utils/cloud.js，这里只留账号相关的读操作）
  logout,
  getUser,
  // 持仓
  getHoldings,
  getHolding,
  getSummary,
  getCoverageBrief,
  // 进入持仓页前按实时行情刷新本地持仓价格
  refreshHoldingQuotes,
  addHolding,
  getAddHoldingOptions,
  getStockByCode,
  getStockDetail,
  searchStocks,
  estimateDividend,
  removeHolding,
  // 清仓归档（投资档案）
  getArchive,
  getArchivedHolding,
  archiveHolding,
  unarchiveHolding,
  setArchiveReason,
  // 心得类文本的字数上限：页面把它传给弹窗，保证「输入框能打多少」
  // 与「存下来多少」是同一个数
  MEMO_MAX,
  // 持仓排序 / 分组（同步纯计算，用于零延迟重绘）
  buildHoldingGroups,
  // 汇总指标（previewMetrics 为同步纯计算，其余为异步 IO）
  getMetricSettings,
  getDefaultMetricKeys,
  saveMetricSettings,
  previewMetrics: buildMetricLists,
  // 覆盖
  getCoverage,
  // 支出
  getOnboardingExpenses,
  getExpenses,
  saveExpenses,
  removeExpense,
  addCustomExpense,
  // 引导
  getOnboardingDemo,
  previewPlan,
  savePlan,
  // 日历（buildMonthCells 为同步纯计算，用于切月时零延迟重绘）
  getCalendar,
  buildMonthCells,
  getDayEvents,
  getYearOverview,
  // 发现 / 我的
  getDiscover,
  getProfile,
  // 会员：状态 / 兑换码 / 下单 / 支付结果查询 / 启动对齐
  membershipVM,
  getMembership,
  getPayChannels,
  redeemMembership,
  createMembershipOrder,
  getOrderStatus,
  syncMembership,
  notifyMembershipGrace,
  // 我的：显示货币 / 多账户 / 文档 / 注销
  getCurrencyOptions,
  saveCurrency,
  getAccounts,
  switchAccount,
  addAccount,
  removeAccount,
  getStandardDoc,
  getContactInfo,
  getLegalDoc,
  destroyAccount,
  // 发现：榜单 / 文章 / 搜索 / 工具
  getRank,
  getArticle,
  getYieldCompare,
  ensureYieldPool,
  searchAllStocks,
  // 同步纯计算：滑块拖动时零延迟重算
  previewCompound,
  previewDca,
  returnProjection,
  // 同步货币文案（页面内联拼金额时用，保证与显示货币一致）
  curSymbol,
  moneyText,
  fixedText,
  amountText,
  wanText,
  // 本币（港股港币 / 美股美元）折算与文案：页面提示输入单位时用
  nativeName,
  nativeSymbol,
  cnyPerUnit,
  fromCny,
  migrateNativeCurrency,
  // 实时汇率：启动时恢复缓存 + 联网刷新
  restoreFx,
  refreshFx,
  // 持仓详情：交易明细 / 分红记录 / 分红档案
  getHoldingRecords,
  addTradeRecord,
  addDividendRecord,
  removeTradeRecord,
  removeDividendRecord,
  updateHolding,
  // 把当前持仓校准为新的建仓基准（旧交易只作流水）
  resetSeedBase
}

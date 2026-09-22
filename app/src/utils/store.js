const cloud = require('./cloud.js')

/* ================= 用户数据：本地快照 + 云端同步 =================
 *
 * 为什么是「本地快照」而不是直接读云端：
 *   api.js 里大量地方是同步调用 store（allRaw / getRaw / summary / decorate），
 *   全改成异步会把上百个调用点一起搅乱。所以本地留一份完整镜像供同步读取，
 *   写操作先改镜像（页面零延迟），再异步推给云托管。
 *
 * 快照结构：
 *   {
 *     holdings: [ { id, code, name, shares, cost, dps, ... } ],   // 最终持仓列表
 *     records:  { [holdingId]: { trade: [], dividend: [] } },     // 交易 / 分红记录
 *     settings: { displayCurrency, holdingMetrics, lifeExpenses, accounts, activeAccountId },
 *     dirty:    false,   // 本地有未推送的改动
 *     rev:      0,       // 云端写入版本号
 *     syncedAt: 0
 *   }
 *
 * settings 刻意按「本地 storage 的原始键」保存：api.js 和页面里那些
 * wx.getStorageSync('displayCurrency') 之类的读写完全不用改，就跟着账号走了。
 */

const STATE_KEY = 'appState'

// 与 mock.accounts 里的第一个账户保持一致：老数据没有 accountId 时都归到它
const DEFAULT_ACCOUNT = 'acc-main'

// 需要跟着账号走的设置项（其余如 isLogin / hasOnboarded 属于本机状态，不上云）
const SETTING_KEYS = [
  'displayCurrency',
  'holdingMetrics',
  'lifeExpenses',
  'accounts',
  'activeAccountId',
  // 会员档位与到期时间：本来就属于账号，换设备登录后要能带过去
  'membership',
  // 币种口径修正的版本标记：它是「这份数据已经折算过了」的凭据，必须跟着账号走。
  // 只存本机的话，App 与小程序会各折一次，等于把汇率平方，港美股数字会离谱地小。
  'nativeCurrencyFix'
]

// 改造前分散存储的键，只在首次升级时用来搬迁数据
const LEGACY = {
  added: 'addedHoldings',
  hidden: 'hiddenHoldings',
  patches: 'builtinPatches',
  records: 'holdingRecords'
}

// 改动合并推送的等待时间：连续改多次只推最后一次
const PUSH_DEBOUNCE = 1200

let state = null
let pushTimer = null
let migrated = false

/* ---------------- 多账户：持仓按账户分开记账 ----------------
 * 账户列表本身由 api.js 管（settings 里的 accounts / activeAccountId），
 * store 只关心「当前是哪个账户」：每条持仓都带 accountId，读的时候按它过滤 ——
 * 切到另一个账户看到的就是另一套持仓，不会几个账户共用一份。
 */
let accountId = null

function defaultAccountId() {
  const list = wx.getStorageSync('accounts')
  if (list instanceof Array && list.length && list[0] && list[0].id) return String(list[0].id)
  return DEFAULT_ACCOUNT
}

function currentAccountId() {
  if (accountId) return accountId

  const saved = String(wx.getStorageSync('activeAccountId') || '')
  const list = wx.getStorageSync('accounts')
  const ids = (list instanceof Array ? list : []).map((a) => String((a && a.id) || ''))

  // 存下来的那个 id 可能已经不在账户列表里了（老数据，或账号合并后换了账户体系）。
  // 继续用它的话，持仓会因为「不属于任何已列出的账户」而一条都显示不出来 ——
  // 页面上看着就像数据被清空了。这时回落到第一个账户最稳妥。
  if (saved && ids.indexOf(saved) === -1) {
    accountId = ids[0] || DEFAULT_ACCOUNT
    return accountId
  }

  accountId = saved || defaultAccountId()
  return accountId
}

// 切账户 / 删账户时由 api.js 调一下，免得这里一直用旧值
function setAccountId(id) {
  accountId = String(id || '')
}

/* ---------------- 基础工具 ---------------- */

function asArray(v) {
  return v instanceof Array ? v : []
}

function asObject(v) {
  return v && typeof v === 'object' && !(v instanceof Array) ? v : {}
}

function hasStored(key) {
  const v = wx.getStorageSync(key)
  return v !== '' && v !== undefined && v !== null
}

/* ---------------- 本地快照 ---------------- */

function readLocal() {
  const saved = wx.getStorageSync(STATE_KEY)
  return saved && typeof saved === 'object' && saved.holdings ? saved : null
}

function persist() {
  wx.setStorageSync(STATE_KEY, state)
}

function ensureState() {
  if (state) return state

  const local = readLocal()
  state = local || buildInitialState()
  if (!local) persist()

  // 老版本没有账户概念，持仓上都没有 accountId —— 升级时补一次
  if (!migrated) {
    migrated = true
    migrateAccountId()
  }
  return state
}

/**
 * 老持仓统一归到第一个账户（用户看到的还是「原来那些持仓」），
 * 之后新增的持仓都带上当前账户 id，切换账户各看各的。
 */
function migrateAccountId() {
  const s = ensureState()
  const fallback = defaultAccountId()
  let changed = false

  const holdings = asArray(s.holdings).map((h) => {
    if (h && h.accountId) return h
    changed = true
    return Object.assign({}, h, { accountId: fallback })
  })

  if (!changed) return
  state = Object.assign({}, s, { holdings })
  persist()
}

/**
 * 首次启动（或从老版本升级上来）时拼出第一份快照。
 * 持仓只来自用户自己录入（老版本升级时从 added 搬迁过来，并去掉被隐藏的），
 * 没有任何内置示例数据。
 *
 * dirty 的判定很关键：
 *   老版本升级上来 → true，本地数据是权威的，启动时会推给云端；
 *   全新安装 / 卸载重装 → false，这样如果云端已经有数据（换设备、重装），
 *   会以云端为准覆盖，而不是把一份空列表推上去把云端真数据冲掉。
 */
function buildInitialState() {
  const hadLegacy =
    hasStored(LEGACY.added) ||
    hasStored(LEGACY.hidden) ||
    hasStored(LEGACY.patches) ||
    hasStored(LEGACY.records)

  const hidden = asArray(wx.getStorageSync(LEGACY.hidden))

  const holdings = asArray(wx.getStorageSync(LEGACY.added)).filter(
    (h) => hidden.indexOf(h.id) === -1
  )

  const next = {
    holdings,
    records: asObject(wx.getStorageSync(LEGACY.records)),
    settings: readSettings(),
    dirty: hadLegacy,
    rev: 0,
    syncedAt: 0
  }

  // 数据已经并进快照，旧的分散键清掉，避免以后又被当成「有历史数据」
  Object.keys(LEGACY).forEach((k) => wx.removeStorageSync(LEGACY[k]))

  return next
}

function readSettings() {
  const bag = {}
  SETTING_KEYS.forEach((k) => {
    const v = wx.getStorageSync(k)
    if (v !== '' && v !== undefined && v !== null) bag[k] = v
  })
  return bag
}

function applySettings(bag) {
  const src = asObject(bag)
  SETTING_KEYS.forEach((k) => {
    if (src[k] === undefined) {
      wx.removeStorageSync(k)
      return
    }
    wx.setStorageSync(k, src[k])
  })
}

/* ---------------- 持仓：同步读（签名与改造前完全一致） ---------------- */

// 全量：写操作一定基于它，否则改一个账户会把其他账户的持仓弄丢
function allRows() {
  return asArray(ensureState().holdings)
}

/**
 * 是否已清仓归档。
 *
 * 两种来源，合成一个判定：
 *   1) 显式标记 archived —— 用户在详情页手动点了「清仓归档」；
 *   2) 股数归零 —— 卖出全部后 shares 变成 0，不需要再点一次。
 *
 * 为什么股数也算：卖出全部是清仓的**唯一**客观信号，让用户为一笔已经
 * 卖光的持仓再点一次「归档」，纯属多余且容易忘。手动入口留给
 * 「还没卖完但决定不再跟踪」的情况。
 */
function isArchived(h) {
  if (!h) return false
  if (h.archived === true) return true
  return !(Number(h.shares) > 0)
}

/**
 * 是否处于「降级冻结」状态。
 *
 * 会员到期后若超过免费额度，多出来的那几只会被打上这个标记 ——
 * **用户侧表现为消失，但数据仍在本地、也仍会上传云端**。
 *
 * 为什么是"标记"而不是"删除"：真正删掉的话，降级期间用户随手记一笔交易
 * 就会触发快照上传，而那时上传的只有剩下的几只 —— 云端那份也跟着被截断，
 * 之后再开通也拉不回来了。标记冻结则不影响快照（行还在，只是被过滤掉），
 * 所以重新开通时取消标记即可完整恢复。
 */
function isFrozen(h) {
  return !!(h && h.frozen === true)
}

// 当前账户的全部持仓（含已归档、含冻结），投资档案页与冻结逻辑用
function accountRows() {
  const id = currentAccountId()
  return allRows().filter((h) => String((h && h.accountId) || '') === id)
}

/**
 * 对外只读当前账户的**在持**持仓 —— 切账户后看到的就是另一个账户的账。
 *
 * 两类排除在外：
 *   1) 已清仓的 —— 挪去「投资档案」，既不占持仓列表，也不占免费档的数量上限
 *      （成员门禁用的就是这个列表）；
 *   2) 降级冻结的 —— 会员到期又超额，期满后暂时收起，重新开通即恢复。
 */
function allRaw() {
  return accountRows().filter((h) => !isArchived(h) && !isFrozen(h))
}

// 当前账户里被冻结的那几只（仅用于提示文案，不参与列表渲染）
function frozenRows() {
  return accountRows().filter((h) => !isArchived(h) && isFrozen(h))
}

// 已归档的持仓（补齐派生字段，页面直接用）
function archivedHoldings() {
  return accountRows().filter(isArchived).map((h) => decorate(h))
}

// 已归档的**原始**记录（未 decorate）—— 行情刷新要 patch 回存储，需要原始行
function rawArchived() {
  return accountRows().filter(isArchived)
}

// 按 id 取单只持仓：同样只认当前账户的 ——
// 别的账户即便知道 id 也取不到（详情页不给看，也不给改）
function getRaw(id) {
  return allRaw().filter((h) => h.id === id)[0] || null
}

// 同上，但**包含**已归档的 —— 档案页要点进已清仓标的看历史流水
function getRawAny(id) {
  return accountRows().filter((h) => h.id === id)[0] || null
}

function getHoldingAny(id) {
  const target = getRawAny(id)
  return target ? decorate(target) : null
}

/* ---------------- 汇率注入 ----------------
 * 【口径】快照里只存**本币原值**：你在港股持仓上填 3.44，存的数字就是 3.44；
 * 美股填 25.8，存的就是 25.8。人民币金额不落库 —— 它一律由 decorate 按
 * **当前汇率**现算。
 *
 * 为什么不再像以前那样「录入时折成人民币存下来」：
 *   那样存下来的数字被绑死在录入当天的汇率上，之后汇率怎么动它都不会变，
 *   于是「成本」和「市值」用的汇率不同步，用户看到的就是
 *   「我明明填了 3.44，它显示 3.72」这种数字被偷偷改掉的情况。
 *   改成本币原值之后，录入的数字是**事实**、永远不动，人民币只是它的一个视图。
 *
 * store 是纯计算层，不反向依赖 api，所以汇率用注入而不是 require。
 * 注入的函数返回「1 单位本币 = 多少人民币」；没注入时退回 1
 * （A股 不受影响，港美股 会退化成直接用原值 —— 只在测试环境会发生）。
 */
let fxProvider = null

function setFxProvider(fn) {
  fxProvider = typeof fn === 'function' ? fn : null
}

// 1 单位本币 = 多少人民币
function fxOf(market) {
  if (!fxProvider) return 1
  const v = Number(fxProvider(market))
  return v > 0 ? v : 1
}

/**
 * 取某字段的**本币原值**。
 *
 * 优先读 xxxNative（新数据一定有）；没有时回落到同名的旧字段 ——
 * 旧数据里那份其实也是本币（当年录入时没折算过），所以这么回落在
 * 迁移完成前也是对的。
 */
function nativeVal(row, key) {
  const v = row[key + 'Native']
  if (v === undefined || v === null || v === '') {
    return Number(row[key]) || 0
  }
  return Number(v) || 0
}

// 给单只持仓补齐派生字段，页面只做展示
function decorate(h, plan) {
  const rate = plan && plan.rate ? plan.rate : 1 // A股 1，港股 (1 - 税率)

  // 先取出各字段的**本币原值**，再统一按当前汇率折成人民币。
  // 关键：不再读 h.cost / h.price / h.dps（那是历史汇率下的旧折算值），
  // 否则汇率一变，这些数字就和「用户当初录入的那个数」对不上了。
  const cny = fxOf(h.market)
  const costNative = nativeVal(h, 'cost')
  const priceNative = nativeVal(h, 'price')
  const dpsNative = nativeVal(h, 'dps')
  const receivedNative = nativeVal(h, 'received')

  const cost = costNative * cny
  const price = priceNative * cny
  const dps = dpsNative * cny
  const received = receivedNative * cny

  const dividend = dps * h.shares * rate
  const marketValue = price * h.shares
  const costValue = cost * h.shares
  // 息率是同币种相除，与汇率无关 —— 直接用本币原值算更干净，也不会被
  // 两道折算的舍入影响
  const priceYield = priceNative ? (dpsNative / priceNative) * 100 : 0
  const costYield = costNative ? (dpsNative / costNative) * 100 : 0
  const netInvest = costValue - received
  const remaining = netInvest - received
  const paybackYears = dividend > 0 ? remaining / dividend : 0
  // 浮动盈亏 = 现市值 − 持仓成本。不含已收分红 —— 那部分走「分红回本进度」，
  // 两者分开看才清楚「股价赚了多少」和「分红收回了多少」。
  // 两边都用同一时刻的汇率折算，所以汇率变动不会凭空造出盈亏。
  const floatProfit = marketValue - costValue
  // 负成本持仓（成本被分红摊成负数）时分母取绝对值，否则涨跌方向会被翻转
  const floatProfitPct = costValue ? (floatProfit / Math.abs(costValue)) * 100 : 0

  return Object.assign({}, h, {
    // 覆盖成「当前汇率下的人民币值」：下游凡是用 h.cost / h.price 的地方
    // 拿到的都是实时口径，不需要各自再乘汇率
    cost,
    price,
    dps,
    received,
    costNative,
    priceNative,
    dpsNative,
    receivedNative,
    dividend,
    marketValue,
    costValue,
    floatProfit,
    floatProfitPct,
    priceYield,
    costYield,
    netInvest,
    remaining,
    paybackYears,
    // 回本进度 = 已收分红 / 总投入，收满即封顶 100%
    paybackProgress: costValue ? Math.min(100, Math.round((received / costValue) * 100)) : 0
  })
}

function allHoldings() {
  return allRaw().map((h) => decorate(h))
}

function getHolding(id) {
  const target = getRaw(id)
  return target ? decorate(target) : null
}

/**
 * 收息天数：按最早的一笔买入日实时算。
 * 持仓记录里的 holdingDays 只是「录入当时」的天数快照，放着不动会越来越旧，
 * 所以这里不看它，直接拿 buyDate 现算；一条买入日都没有时返回 0（页面隐藏该行）。
 */
function holdDaysOf(list) {
  let earliest = 0
  list.forEach((h) => {
    const t = new Date(String(h.buyDate || '').replace(/-/g, '/')).getTime()
    if (t && (!earliest || t < earliest)) earliest = t
  })
  if (!earliest) return 0
  return Math.max(0, Math.floor((Date.now() - earliest) / 86400000) + 1)
}

// 顶部汇总：预测年度分红 / 今年已收 / 总成本 / 总市值 / 成本息率 / 市息率 / 月均
function summary() {
  const list = allHoldings()
  const dividend = list.reduce((s, h) => s + h.dividend, 0)
  const received = list.reduce((s, h) => s + h.received, 0)
  const costValue = list.reduce((s, h) => s + h.costValue, 0)
  const marketValue = list.reduce((s, h) => s + h.marketValue, 0)

  const floatPnl = marketValue - costValue

  return {
    count: list.length,
    dividend,
    received,
    costValue,
    marketValue,
    costYield: costValue ? (dividend / costValue) * 100 : 0,
    marketYield: marketValue ? (dividend / marketValue) * 100 : 0,
    monthly: dividend / 12,
    daily: dividend / 365,
    totalReceived: received,
    netInvest: costValue - received,
    floatPnl,
    floatRate: costValue ? (floatPnl / costValue) * 100 : 0,
    holdDays: holdDaysOf(list)
  }
}

/* ---------------- 持仓：写（先本地，再排队上云） ---------------- */

function commit(next) {
  state = Object.assign({}, ensureState(), next, { dirty: true })
  persist()
  schedulePush()
}

// patch 里的值和现值完全一致时什么都不做，
// 否则「刷新行情」这种无实际改动的操作会白白打一串同步请求
function patchChanged(cur, patch) {
  const keys = Object.keys(patch)
  for (let i = 0; i < keys.length; i++) {
    if (patch[keys[i]] !== cur[keys[i]]) return true
  }
  return false
}

function updateHoldingById(id, patch) {
  // 用 getRawAny 而不是 getRaw：**已归档的持仓也必须能改**。
  //
  // 归档是标记不是删除，这两件事都要写回归档行：
  //   1) 刷新归档标的的现价 —— 投资档案靠它算「卖出至今」，不更新的话
  //      那个百分比会永远停在清仓那天（也就是恒为 0），而这恰恰是档案页
  //      唯一有信息量的数字；
  //   2) 事后补写清仓心得。
  // 原先用 getRaw（只认在持）会让这两件事**静默失败** —— 流量照花、
  // 值一个字节都没落盘，且没有任何报错。
  const cur = getRawAny(id)
  if (!cur) return null
  if (!patchChanged(cur, patch)) return cur

  const merged = Object.assign({}, cur, patch)
  commit({ holdings: allRows().map((h) => (h.id === id ? merged : h)) })
  return merged
}

// 新持仓一律记在当前账户名下（外面没传就补上）
function appendHolding(record) {
  const row = Object.assign({}, record, { accountId: record.accountId || currentAccountId() })
  commit({ holdings: allRows().concat([row]) })
  return row
}

/**
 * 整份替换持仓（数据口径修正用，例如币种折算迁移）。
 * 必须走 commit：它负责标脏并排队上云；绕过它直接写 storage 的话，
 * 云端那份旧口径的数据下次启动又会被拉回来盖掉，等于白修。
 */
function replaceHoldings(list) {
  const rows = asArray(list)
  commit({ holdings: rows })
  return rows
}

/**
 * 降级冻结：把当前账户里**超出额度**的持仓标记为 frozen。
 *
 * 「最晚添加的」= 数组里靠后的。allRows 的顺序就是添加顺序
 * （appendHolding 用 concat 追加），所以保留前 keep 只即可，不必另做排序 ——
 * 一旦改成排序，就得面对"买入日期缺失时怎么算"这种分支，而顺序本身
 * 已经是权威的添加次序。
 *
 * 只动当前账户：额度判定（membership.checkHolding）看的也是当前账户，
 * 两边口径必须一致，否则会出现"切个账户额度就变了"的怪现象。
 *
 * 返回实际改动的条数。
 */
function freezeExcess(keep) {
  const mine = accountRows().filter((h) => !isArchived(h))

  // 没超额：不做事。但顺手解冻 —— 用户可能自己删到了额度以内，
  // 那种情况下他并没有续费，但已经不再违规，没有理由继续收着。
  if (mine.length <= keep) return unfreezeAll()

  const keepIds = {}
  mine.slice(0, keep).forEach((h) => {
    keepIds[h.id] = true
  })

  let changed = 0
  const next = allRows().map((h) => {
    // 归档的、以及别的账户的，一律不动
    if (isArchived(h)) return h
    if (String((h && h.accountId) || '') !== currentAccountId()) return h

    if (keepIds[h.id]) {
      if (!isFrozen(h)) return h
      changed++
      return Object.assign({}, h, { frozen: false })
    }
    if (isFrozen(h)) return h
    changed++
    return Object.assign({}, h, { frozen: true })
  })

  if (changed) replaceHoldings(next)
  return changed
}

/**
 * 解冻当前账户的全部持仓（重新开通会员时调用）。
 * 只清标记，数据一直都在。
 */
function unfreezeAll() {
  const rows = allRows()
  const hit = rows.filter((h) => isFrozen(h))
  if (!hit.length) return 0

  replaceHoldings(
    rows.map((h) => (isFrozen(h) ? Object.assign({}, h, { frozen: false }) : h))
  )
  return hit.length
}

function updateAdded(id, patch) {
  return updateHoldingById(id, patch)
}

// 改造前内置持仓是「写一份本地覆盖补丁」，现在所有持仓都是快照里的真实记录，
// 于是和 updateAdded 变成同一件事 —— api.js 的调用点因此一行都不用改
function patchBuiltin(id, patch) {
  return !!updateHoldingById(id, patch)
}

function removeHolding(id) {
  const list = allRows()
  if (!list.filter((h) => h.id === id).length) return false

  // 交易 / 分红明细挂在持仓 id 下，必须一起删 ——
  // 只删持仓会留下一串「没有持仓认领」的流水：本机白占空间，
  // 推到云端后影子表的 holding_records 里也会留下孤儿行，
  // 后台按标的统计时会把已删持仓的流水一并算进去。
  // （删账户那条路 removeAccountHoldings 一直是两个都删的，这里之前漏了。）
  const records = ensureState().records || {}
  const kept = {}
  Object.keys(records).forEach((k) => {
    if (k !== id) kept[k] = records[k]
  })

  commit({ holdings: list.filter((h) => h.id !== id), records: kept })
  return true
}

/**
 * 删除账户时连它的持仓与流水一起清掉，
 * 否则会留下一批「没有账户认领」的持仓，再也点不到。
 */
function removeAccountHoldings(id) {
  const s = ensureState()
  const all = asArray(s.holdings)
  const ids = {}
  let n = 0

  all.forEach((h) => {
    if (String((h && h.accountId) || '') === String(id)) {
      ids[h.id] = true
      n++
    }
  })
  if (!n) return 0

  const src = asObject(s.records)
  const records = {}
  Object.keys(src).forEach((k) => {
    if (!ids[k]) records[k] = src[k]
  })

  commit({ holdings: all.filter((h) => !ids[h.id]), records })
  return n
}

// 兼容旧导出：用户自己添加的持仓（改造前与内置持仓分开存）
function readAdded() {
  return allRaw().filter((h) => h.custom)
}

/* ---------------- 交易 / 分红记录 ---------------- */

function readRecords() {
  const src = ensureState().records || {}
  // 返回深一层的拷贝：api.js 习惯拿到后就地改再回写，
  // 拷贝一份可以确保它不会绕过 commit 直接改到快照上
  const out = {}
  Object.keys(src).forEach((k) => {
    const r = src[k] || {}
    out[k] = { trade: asArray(r.trade).slice(), dividend: asArray(r.dividend).slice() }
  })
  return out
}

function writeRecords(all) {
  commit({ records: asObject(all) })
  return state.records
}

/* ---------------- 云端同步 ---------------- */

function cancelPushTimer() {
  if (pushTimer) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

/**
 * 本地这份快照是不是属于**另一个账号**。
 *
 * 靠 state.ownerUid（推送 / 拉取成功时记下）与当前登录 uid 比对。
 * 有了它才能区分两种「本地已经有数据」的情形：
 *   同一个人换设备或重装后再次登录 → 数据本来就是他的，该保留、该推上去；
 *   同一个人在这台机器上换成另一个账号 → 那是别人的数据，必须丢掉。
 *
 * 老版本没有登录概念，快照里没有这个字段 —— 那种情况按「数据就是本人的」处理
 * （首次登录时保留并推送），随后补上标记。
 */
function isOtherAccount() {
  // 必须走 ensureState()：冷启动时内存里的 state 还是 null，
  // 直接读会得到空 ownerUid，判断就永远不成立，等于没做隔离。
  const owner = String(ensureState().ownerUid || '')
  const cur = String(cloud.uid() || '')
  return !!owner && !!cur && owner !== cur
}

/**
 * 丢掉本地快照，**不碰云端**。
 *
 * 与 destroyUserData 的区别：那个是「注销账号」，云端那份也要一起删；
 * 这里只是换人 —— 上一个人的数据还得留在服务器上，只是不能继续待在新账号名下。
 *
 * 设置项一并清掉：它们也是跟着账号走的（displayCurrency / accounts / …），
 * 不清的话新账号会继承上一个人选的显示货币和账户列表。
 */
function resetLocal() {
  cancelPushTimer()
  state = null
  accountId = null
  wx.removeStorageSync(STATE_KEY)
  SETTING_KEYS.forEach((k) => wx.removeStorageSync(k))
}

function schedulePush() {
  cancelPushTimer()
  if (!cloud.enabled()) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushToCloud()
  }, PUSH_DEBOUNCE)
}

/**
 * 设置类改动（显示货币 / 账户 / 指标 / 生活支出）走的是 wx.setStorageSync，
 * 不经过 commit，所以默认不会触发上云。后果不只是「设置同步不上去」：
 * 下次冷启动 pull 时本地不脏，云端那份旧设置会把刚改的直接覆盖回来。
 * 由 api.js 在这些写入口补调一下，把改动并进下一次同步。
 */
function markDirty() {
  state = Object.assign({}, ensureState(), { dirty: true })
  persist()
  schedulePush()
}

/**
 * 上传给运营侧看的资料（昵称 / 头像 / 手机号）。
 * 它只往上走、不参与 adopt：本机身份属于「本机状态」（换设备要重新登录），
 * 快照里带一份只是为了让后台能看到「这个 openid 是谁」。
 */
function readProfile() {
  const info = wx.getStorageSync('userInfo')
  const src = info && typeof info === 'object' ? info : {}
  return {
    nickName: String(src.nickName || ''),
    avatar: String(src.avatar || ''),
    phone: String(src.phone || '')
  }
}

function cloudPayload() {
  const s = ensureState()
  return {
    // settings 现读：页面可能刚通过 wx.setStorageSync 写过设置
    settings: readSettings(),
    profile: readProfile(),
    holdings: s.holdings,
    records: s.records || {}
  }
}

function pushToCloud() {
  if (!cloud.enabled()) return Promise.resolve(false)
  cancelPushTimer()

  const s = ensureState()
  return cloud
    .saveState(cloudPayload())
    .then((res) => {
      state = Object.assign({}, s, {
        dirty: false,
        syncedAt: Date.now(),
        rev: (res && res.rev) || s.rev,
        // 云端收下了，就说明这份数据属于当前账号 —— 记下来，供下次换账号时比对
        ownerUid: cloud.uid()
      })
      persist()
      return true
    })
    .catch((e) => {
      // 保留 dirty，下次启动或下次改动时会重试
      console.warn('[store] 上云失败，改动留在本地', e && e.msg)
      return false
    })
}

/**
 * 启动时对齐一次：
 *   云端还没有这份数据 → 把本地推上去（新用户，或老版本升级上来）
 *   本地有未推送的改动 → 以本地为准推上去
 *   否则              → 以云端为准拉下来覆盖本地
 *
 * 返回「本地是否被云端覆盖」，调用方据此决定要不要让当前页面重新取数。
 */
function pullFromCloud() {
  if (!cloud.enabled()) return Promise.resolve(false)

  // 换账号了：本地这份属于上一个人，先丢掉再拉。
  //
  // 这一步必须排在任何 push 之前 —— 否则下面「云端还没有数据」那条分支会把
  // 它原样推到新账号名下。那不只是显示不对：新账号会凭空多出别人的持仓与流水，
  // 而且是**写进服务端**的，之后很难分清哪些是真数据。
  if (isOtherAccount()) {
    console.warn('[store] 检测到换账号，丢弃本地快照')
    resetLocal()
  }

  const local = ensureState()

  return cloud
    .getState()
    .then((res) => {
      const remote = res && res.payload
      if (!remote || local.dirty) return pushToCloud().then(() => false)
      adopt(remote)
      return true
    })
    .catch((e) => {
      // 后端没部署 / 断网 / 不在小程序里调用：静默退化为纯本地模式
      console.warn('[store] 拉取失败，按纯本地运行', e && e.msg)
      return false
    })
}

/**
 * 强制以云端为准拉一次。
 *
 * 与 pullFromCloud 的区别：这个不看本地 dirty。用于「服务端那份才是最新事实」
 * 的场景 —— 这时本地任何未推送的改动都得让位，否则紧接着一次 push
 * 会把服务端的结果整个盖掉。
 */
function adoptFromCloud() {
  if (!cloud.enabled()) return Promise.resolve(false)

  return cloud
    .getState()
    .then((res) => {
      const remote = res && res.payload
      if (!remote) return false
      adopt(remote)
      return true
    })
    .catch((e) => {
      console.warn('[store] 以云端为准拉取失败', e && e.msg)
      return false
    })
}

function adopt(remote) {
  state = {
    holdings: asArray(remote.holdings),
    records: asObject(remote.records),
    settings: asObject(remote.settings),
    dirty: false,
    rev: remote.rev || 0,
    syncedAt: Date.now(),
    // 从云端拉下来这份，归属当前账号
    ownerUid: cloud.uid()
  }
  // 云端的设置里带着 activeAccountId，重新按它读一次
  accountId = null
  applySettings(state.settings)
  // 云端下来的老持仓可能也没有 accountId，一并归到第一个账户
  migrateAccountId()
  persist()
  return state
}

/**
 * 注销账号 = 恢复出厂：云端和本地一起清。
 * 顺序不能反：只清本地的话，下次启动会把云端数据原样拉回来。
 */
function destroyUserData() {
  cancelPushTimer()
  state = null
  accountId = null

  return cloud
    .clearState()
    .catch(() => null)
    .then(() => {
      wx.clearStorageSync()
      return true
    })
}

module.exports = {
  // 持仓
  decorate,
  allHoldings,
  allRaw,
  allRows,
  getRaw,
  getHolding,
  summary,
  readAdded,
  appendHolding,
  updateAdded,
  patchBuiltin,
  removeHolding,
  replaceHoldings,
  // 降级冻结
  isFrozen,
  frozenRows,
  freezeExcess,
  unfreezeAll,
  // 清仓归档
  isArchived,
  archivedHoldings,
  rawArchived,
  getRawAny,
  getHoldingAny,
  // 汇率注入：api 层把「实时汇率 ÷ 记账汇率」的系数交给这里
  setFxProvider,
  // 多账户
  currentAccountId,
  setAccountId,
  removeAccountHoldings,
  // 交易 / 分红记录
  readRecords,
  writeRecords,
  // 云端同步
  pullFromCloud,
  adoptFromCloud,
  pushToCloud,
  markDirty,
  resetLocal,
  destroyUserData
}

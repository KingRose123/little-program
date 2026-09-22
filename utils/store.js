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

// 对外只读当前账户的持仓 —— 切账户后看到的就是另一个账户的账
function allRaw() {
  const id = currentAccountId()
  return allRows().filter((h) => String((h && h.accountId) || '') === id)
}

// 按 id 取单只持仓：同样只认当前账户的 ——
// 别的账户即便知道 id 也取不到（详情页不给看，也不给改）
function getRaw(id) {
  return allRaw().filter((h) => h.id === id)[0] || null
}

/* ---------------- 汇率注入 ----------------
 * 快照里的本币金额都是按「记账汇率」折成人民币存的，那个汇率是固定桥梁，
 * 不能动。这里由 api 层注入一个**重估系数**（实时汇率 ÷ 记账汇率），
 * 供 decorate 把「当下与未来的价值」按最新汇率重算。
 *
 * store 是纯计算层，不反向依赖 api，所以用注入而不是 require；
 * 没注入（或拿不到实时汇率）时系数为 1，行为与从前完全一致。
 */
let fxProvider = null

function setFxProvider(fn) {
  fxProvider = typeof fn === 'function' ? fn : null
}

function fxOf(market) {
  if (!fxProvider) return 1
  const v = Number(fxProvider(market))
  return v > 0 ? v : 1
}

// 给单只持仓补齐派生字段，页面只做展示
function decorate(h, plan) {
  const rate = plan && plan.rate ? plan.rate : 1 // A股 1，港股 (1 - 税率)
  // 重估系数：所有人民币金额都按**最新汇率**看一遍 —— 效果等同于
  //「本质上是港元资产，人民币金额只是当下的折算值」。
  //   市值、成本、已收分红、预测分红 → 都乘
  //   息率 → 同一币种相除，系数约掉，不受汇率影响（这正是它该有的性质）
  // 浮动盈亏 = 市值 − 成本，两边同乘一个系数，所以汇率变了也不会凭空
  // 多出或吃掉盈亏 —— 这是「成本必须一起重估」的原因。
  const fx = fxOf(h.market)
  const received = h.received * fx
  const dividend = h.dps * h.shares * rate * fx
  const marketValue = h.price * h.shares * fx
  const costValue = h.cost * h.shares * fx
  const priceYield = h.price ? (h.dps / h.price) * 100 : 0
  const costYield = h.cost ? (h.dps / h.cost) * 100 : 0
  const netInvest = costValue - received
  const remaining = netInvest - received
  const paybackYears = dividend > 0 ? remaining / dividend : 0

  return Object.assign({}, h, {
    dividend,
    marketValue,
    costValue,
    priceYield,
    costYield,
    netInvest,
    remaining,
    paybackYears,
    // 回本进度 = 已收分红 / 总投入，收满即封顶 100%
    //（两边同口径，所以汇率变化不影响它）
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
  const cur = getRaw(id)
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
  commit({ holdings: list.filter((h) => h.id !== id) })
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

function schedulePush() {
  cancelPushTimer()
  if (!cloud.enabled()) return
  pushTimer = setTimeout(() => {
    pushTimer = null
    pushToCloud()
  }, PUSH_DEBOUNCE)
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
      state = Object.assign({}, s, { dirty: false, syncedAt: Date.now(), rev: (res && res.rev) || s.rev })
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
 * force = true 时忽略本地 dirty，一律以云端为准（关联账号之后用，见 adoptFromCloud）。
 *
 * 返回「本地是否被云端覆盖」，调用方据此决定要不要让当前页面重新取数。
 */
function pullFromCloud(force) {
  if (!cloud.enabled()) return Promise.resolve(false)

  const local = ensureState()

  return cloud
    .getState()
    .then((res) => {
      const remote = res && res.payload

      // 云端还没有这份数据：推本地上去是唯一选择（force 也一样，
      // 否则一份空快照会把本地的东西也一起抹掉）
      if (!remote) return pushToCloud().then(() => false)
      if (local.dirty && !force) return pushToCloud().then(() => false)

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
 * 强制以云端为准拉一次（关联 App 账号之后用）。
 *
 * 与 pullFromCloud 的区别是**不看本地 dirty**。账号合并完成后，云端那份是
 * 「两份数据并起来」的结果，本地任何未推送的改动在这个场景下都得让位 ——
 * 否则紧接着的一次 push 会把合并结果整个盖掉，表现就是
 * 「App 那边显示已关联，小程序这边的持仓却一点没变」。
 * 合并读的就是云端那两份快照，所以这里也不需要再推一次本地。
 */
function adoptFromCloud() {
  return pullFromCloud(true)
}

function adopt(remote) {
  state = {
    holdings: asArray(remote.holdings),
    records: asObject(remote.records),
    settings: asObject(remote.settings),
    dirty: false,
    rev: remote.rev || 0,
    syncedAt: Date.now()
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
  destroyUserData
}

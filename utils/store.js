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

// 需要跟着账号走的设置项（其余如 isLogin / hasOnboarded 属于本机状态，不上云）
const SETTING_KEYS = [
  'displayCurrency',
  'holdingMetrics',
  'lifeExpenses',
  'accounts',
  'activeAccountId',
  // 会员档位与到期时间：本来就属于账号，换设备登录后要能带过去
  'membership'
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
  return state
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

function allRaw() {
  return ensureState().holdings
}

function getRaw(id) {
  return allRaw().filter((h) => h.id === id)[0] || null
}

// 给单只持仓补齐派生字段，页面只做展示
function decorate(h, plan) {
  const rate = plan && plan.rate ? plan.rate : 1 // A股 1，港股 (1 - 税率)
  const dividend = h.dps * h.shares * rate
  const marketValue = h.price * h.shares
  const costValue = h.cost * h.shares
  const priceYield = h.price ? (h.dps / h.price) * 100 : 0
  const costYield = h.cost ? (h.dps / h.cost) * 100 : 0
  const netInvest = costValue - h.received
  const remaining = netInvest - h.received
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
    paybackProgress: costValue ? Math.min(100, Math.round((h.received / costValue) * 100)) : 0
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
  commit({ holdings: allRaw().map((h) => (h.id === id ? merged : h)) })
  return merged
}

function appendHolding(record) {
  commit({ holdings: allRaw().concat([record]) })
  return record
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
  const list = allRaw()
  if (!list.filter((h) => h.id === id).length) return false
  commit({ holdings: list.filter((h) => h.id !== id) })
  return true
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
 * 返回「本地是否被云端覆盖」，调用方据此决定要不要让当前页面重新取数。
 */
function pullFromCloud() {
  if (!cloud.enabled()) return Promise.resolve(false)

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

function adopt(remote) {
  state = {
    holdings: asArray(remote.holdings),
    records: asObject(remote.records),
    settings: asObject(remote.settings),
    dirty: false,
    rev: remote.rev || 0,
    syncedAt: Date.now()
  }
  applySettings(state.settings)
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
  getRaw,
  getHolding,
  summary,
  readAdded,
  appendHolding,
  updateAdded,
  patchBuiltin,
  removeHolding,
  // 交易 / 分红记录
  readRecords,
  writeRecords,
  // 云端同步
  pullFromCloud,
  pushToCloud,
  destroyUserData
}

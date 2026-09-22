/**
 * 会员档位与门禁
 *
 * 这里是「当前是什么档位、这一档能干什么」的唯一出口：
 *   - 状态读写（本地 storage 的 membership 键，并跟着账号上云）
 *   - 各功能门禁（持仓数量、港股美股、多账户…）都读 mock 里的额度表
 *
 * 权威值在服务端：本地这份只是缓存，App 启动时会用 /api/membership 的结果覆盖，
 * 所以手改本地缓存最多撑到下次启动。过期后按免费档算，
 * 但不抹掉原来的档位与到期日 —— 续费时还能看到历史。
 */
const mock = require('./mock.js')
const store = require('./store.js')

const KEY = 'membership'
const TIERS = ['free', 'lite', 'pro']
const TIER_NAMES = { free: '免费版', lite: 'Lite 会员', pro: 'Pro 会员' }

function todayKey() {
  const d = new Date()
  return (
    d.getFullYear() +
    '-' +
    ('0' + (d.getMonth() + 1)).slice(-2) +
    '-' +
    ('0' + d.getDate()).slice(-2)
  )
}

// 'yyyy-MM-dd' -> 距今天数（正数表示还没到期）
function daysUntil(dateKey) {
  if (!dateKey) return 0
  const t = new Date(String(dateKey).replace(/-/g, '/')).getTime()
  if (isNaN(t)) return 0
  return Math.ceil((t - Date.now()) / 86400000)
}

/* ---------------- 状态 ---------------- */

function read() {
  const saved = wx.getStorageSync(KEY)
  if (!saved || typeof saved !== 'object') {
    return { tier: 'free', expiresAt: '', source: '', updatedAt: 0 }
  }
  return {
    tier: TIERS.indexOf(saved.tier) > -1 ? saved.tier : 'free',
    expiresAt: String(saved.expiresAt || ''),
    source: String(saved.source || ''),
    updatedAt: Number(saved.updatedAt) || 0
  }
}

// 写入状态。补上 updatedAt，便于排查「到底什么时候被改过」
function write(next) {
  const state = Object.assign(read(), next || {}, { updatedAt: Date.now() })
  wx.setStorageSync(KEY, state)
  return state
}

// 当前生效档位（过期即降级为免费）
function current() {
  const s = read()
  const expired = !!(s.expiresAt && s.expiresAt < todayKey())

  return {
    tier: expired ? 'free' : s.tier,
    paidTier: s.tier,
    tierName: TIER_NAMES[expired ? 'free' : s.tier] || '免费版',
    expiresAt: s.expiresAt,
    expired: expired,
    daysLeft: expired ? 0 : daysUntil(s.expiresAt),
    isPro: !expired && s.tier === 'pro',
    isLite: !expired && s.tier === 'lite',
    isPaid: !expired && s.tier !== 'free'
  }
}

/* ---------------- 降级宽限期 ----------------
 *
 * 会员到期后，超额的持仓不立刻冻结，先给 7 天缓冲：
 *   - 期间正常使用，只是每次打开 App 提醒还剩几天；
 *   - 期满后把超出的那几只**冻结**（用户侧表现为消失，见 store.freezeExcess）；
 *   - 重新开通即可解冻，数据一条都不会丢。
 *
 * 为什么起点取 expiresAt 而不是"发现的时候"：到期日是一个**确定的时间点**，
 * 而"发现"取决于用户什么时候打开 App —— 一周不打开，宽限期就会被无限顺延。
 * 用 expiresAt 算，无论何时打开，剩余天数都是同一个数。
 */
const GRACE_DAYS = 7

// 'yyyy-MM-dd' + N 天 → 'yyyy-MM-dd'
function addDays(dateKey, n) {
  const t = new Date(String(dateKey).replace(/-/g, '/'))
  if (isNaN(t.getTime())) return ''
  t.setDate(t.getDate() + n)
  return (
    t.getFullYear() +
    '-' +
    ('0' + (t.getMonth() + 1)).slice(-2) +
    '-' +
    ('0' + t.getDate()).slice(-2)
  )
}

/**
 * 宽限期状态。
 *
 * 只有「曾经付费、现已过期」才进入宽限 —— 从没买过的人本来就该按免费档
 * 限制走，给他 7 天缓冲反而说不通（他并没有"降级"）。
 */
function graceState() {
  const s = read()
  const wasPaid = s.tier !== 'free' && !!s.expiresAt
  const expired = wasPaid && s.expiresAt < todayKey()

  if (!expired) {
    return { wasPaid: wasPaid, expired: false, active: false, deadline: '', daysLeft: 0 }
  }

  const deadline = addDays(s.expiresAt, GRACE_DAYS)
  const left = daysUntil(deadline)

  return {
    wasPaid: true,
    expired: true,
    // active：还在缓冲期内（可以继续用超额的持仓）
    active: left > 0,
    deadline: deadline,
    daysLeft: Math.max(0, left)
  }
}

/**
 * ⭐ 总闸：免费开放期结束，恢复按档位区分权限。
 *
 * 2026-09-22 从 true 改为 false —— 也就是「开始卖会员」。它同时管两件事，
 * 这两件事必须一起翻（只翻一半会得到一个自相矛盾的产品）：
 *   - limits() 按档位返回，三个 check* 开始真正拦截；
 *   - 会员中心的购买入口与兑换码入口由 api.membershipVM().status.selling
 *     驱动（= !FREE_FOR_ALL），免费期藏起来，收费后自动出现。
 *
 * 如果只开入口不恢复限制，用户会看到「卖的是我现在本来就免费在用的功能」，
 * 那比不卖更伤信任 —— 所以联动是刻意的，不是巧合。
 *
 * 档位记账（free / lite / pro、到期日、兑换码、订单）不受这行影响，
 * 已有会员照常显示到期时间，历史数据一行都不用动。
 */
const FREE_FOR_ALL = false

// 全免费期的额度：-1 = 不限，true = 放开
const FREE_LIMITS = {
  holdings: -1,
  overseas: true,
  accounts: -1,
  ocr: -1,
  plans: -1,
  fundamental: -1,
  watch: -1,
  analysis: true,
  screener: -1
}

function freeForAll() {
  return FREE_FOR_ALL
}

function limits() {
  if (FREE_FOR_ALL) return FREE_LIMITS
  return mock.membershipLimits[current().tier] || mock.membershipLimits.free
}

// -1 表示不限
function unlimited(n) {
  return Number(n) < 0
}

function quotaText(n) {
  return unlimited(n) ? '无限' : n + ''
}

/* ---------------- 门禁 ----------------
 * 统一返回 { ok, msg }：msg 是直接给用户看的一句话，
 * 调用方（页面）拿到后弹「去升级」引导就行。
 */

// 持仓数量与市场：list 用 store.allRaw() 的原值
function checkHolding(list, market) {
  if (FREE_FOR_ALL) return { ok: true }

  const lim = limits()

  if (market === 'HK' || market === 'US') {
    if (!lim.overseas) {
      return {
        ok: false,
        msg: '港股 / 美股持仓是 Pro 会员功能，升级后即可录入港股、美股标的。'
      }
    }
  }

  const rows = list instanceof Array ? list : []
  const count = rows.filter((h) => h.market !== 'HK' && h.market !== 'US').length
  const isOverseas = market === 'HK' || market === 'US'

  if (!isOverseas && !unlimited(lim.holdings) && count >= lim.holdings) {
    return {
      ok: false,
      msg: '免费版最多记录 ' + lim.holdings + ' 只 A股 / ETF / 基金，升级 Lite 即可无限添加。'
    }
  }

  return { ok: true }
}

function checkAccount(count) {
  if (FREE_FOR_ALL) return { ok: true }

  const lim = limits()
  if (!unlimited(lim.accounts) && Number(count) >= lim.accounts) {
    return {
      ok: false,
      msg:
        '当前档位最多创建 ' +
        lim.accounts +
        ' 个投资账户，升级 Pro 可建 10 个（按账户分开记账）。'
    }
  }
  return { ok: true }
}

// 额度类功能（截图导入 / 基本面 / 筛选器…）：本月已用次数 vs 额度
function checkQuota(key, usedThisMonth) {
  if (FREE_FOR_ALL) return { ok: true }

  const lim = limits()
  const max = lim[key]
  if (max === undefined || unlimited(max) || max === false) {
    return { ok: max !== false }
  }
  if (Number(usedThisMonth) >= max) {
    return { ok: false, msg: '本月 ' + max + ' 次已用完，升级 Pro 可以不限次数使用。' }
  }
  return { ok: true }
}

// 会员中心页顶部的状态文案
function statusText() {
  const cur = current()
  if (!cur.isPaid) return cur.expired ? '会员已过期' : '未开通会员'
  return cur.tierName + ' · ' + (cur.expiresAt ? cur.expiresAt + ' 到期' : '长期有效')
}

module.exports = {
  KEY,
  TIERS,
  GRACE_DAYS,
  read,
  write,
  current,
  graceState,
  addDays,
  limits,
  unlimited,
  quotaText,
  freeForAll,
  checkHolding,
  checkAccount,
  checkQuota,
  statusText,
  todayKey
}

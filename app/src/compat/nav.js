/**
 * 导航桥：把小程序那套 wx.navigateTo('/pages/x/x?a=1') 接到 react-navigation 上。
 *
 * 为什么保留「/pages/...」这种 URL：页面代码里有 25 处硬编码跳转，
 * 全改成 route name 要动 19 个页面的几十处，且以后对照小程序代码会看不懂。
 * 所以这里维护一张映射表 + 解析 query，页面代码一行都不用改。
 */

const ui = require('./ui.js')

// 小程序的页面路径 → RN 的 route name（顺序与 app.json 的 tabBar 无关）
const ROUTES = {
  '/pages/holdings/holdings': 'Holdings',
  '/pages/holding-detail/holding-detail': 'HoldingDetail',
  '/pages/holding-record/holding-record': 'HoldingRecord',
  '/pages/add-holding/add-holding': 'AddHolding',
  '/pages/add-trade/add-trade': 'AddTrade',
  '/pages/add-dividend/add-dividend': 'AddDividend',
  '/pages/article/article': 'Article',
  '/pages/calendar/calendar': 'Calendar',
  '/pages/coverage/coverage': 'Coverage',
  '/pages/discover/discover': 'Discover',
  '/pages/doc/doc': 'Doc',
  '/pages/life-expense/life-expense': 'LifeExpense',
  '/pages/login/login': 'Login',
  '/pages/membership/membership': 'Membership',
  '/pages/metric-settings/metric-settings': 'MetricSettings',
  '/pages/onboarding/onboarding': 'Onboarding',
  '/pages/profile/profile': 'Profile',
  '/pages/rank/rank': 'Rank',
  '/pages/tool/tool': 'Tool',
  '/pages/archive/archive': 'Archive'
}

// 底部 tab（switchTab 只能去这几个，与 app.json 的 tabBar 一致）
const TABS = {
  '/pages/holdings/holdings': 'Holdings',
  '/pages/calendar/calendar': 'Calendar',
  '/pages/discover/discover': 'Discover',
  '/pages/profile/profile': 'Profile'
}

// 已登记的路由名。兜底推导出来的名字必须落在这里面才放行 ——
// react-navigation 遇到未注册的路由名会直接抛错（红屏），
// 那比「点了没反应」更难排查。
// 注意位置：它依赖 ROUTES 与 TABS 两个常量，必须排在两者之后。
const KNOWN = new Set(
  Object.keys(ROUTES)
    .map((k) => ROUTES[k])
    .concat(Object.keys(TABS).map((k) => TABS[k]))
)

let ref = null
// 为了 getCurrentPages()：只记路径，够 util.back() 判断「是不是栈底」了
const stack = ['/pages/holdings/holdings']

/**
 * 标题订阅按**路由名**分开存。
 *
 * 之前是一个全局 Set + 一个全局 currentTitle，页面订阅时会立刻收到「上一个人留下的标题」
 * ——于是从「用户协议」返回再进「持仓详情」，顶部显示的还是「用户协议」，
 * 而且因为 push 之后旧页面仍挂载，一次 setTitle 会把所有页面的标题一起改掉。
 */
const titleListeners = new Map()

function bind(navigationRef) {
  ref = navigationRef
}

/** '/pages/doc/doc?key=privacy' → { path, params } */
function parseUrl(url) {
  const raw = String(url || '')
  const at = raw.indexOf('?')
  const path = at > -1 ? raw.slice(0, at) : raw
  const params = {}

  if (at > -1) {
    raw
      .slice(at + 1)
      .split('&')
      .forEach((pair) => {
        if (!pair) return
        const i = pair.indexOf('=')
        const k = decodeURIComponent(i > -1 ? pair.slice(0, i) : pair)
        const v = i > -1 ? decodeURIComponent(pair.slice(i + 1)) : ''
        params[k] = v
      })
  }

  return { path: path, params: params }
}

/**
 * 路径 → 路由名的兜底推导：取最后一段并按命名规律转成大驼峰。
 *   /pages/holding-detail/holding-detail → HoldingDetail
 *
 * 为什么要有它：显式表一旦漏登记，表现是**点下去毫无反应** ——
 * 只有一行 warn 落在控制台里，用户看不到、开发时也容易忽略。
 * 「投资档案」页就这么漏过一次（页面注册了、菜单加了、跳转也写了，
 * 唯独忘了这张表）。
 */
function deriveName(path) {
  const seg = String(path || '').split('/').filter(Boolean).pop() || ''
  if (!seg) return ''
  return seg
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}

function nameOf(path) {
  // 先剥掉 query：调用点都传过 parseUrl 的 path，但万一哪天有人直接把
  // 完整 url 递进来，带 query 的字符串查表必然落空 —— 又是一次「点了
  // 没反应」。这里兜一下，成本一个 indexOf。
  const raw = String(path || '')
  const at = raw.indexOf('?')
  const p = at > -1 ? raw.slice(0, at) : raw

  const hit = ROUTES[p]
  if (hit) return hit

  // 推导出来的名字必须是已登记的路由名；否则宁可返回空（下面的调用方
  // 会打 warn 并放弃跳转），也不要让未注册的名字流到 navigator 里去抛错。
  const guess = deriveName(p)
  return guess && KNOWN.has(guess) ? guess : ''
}

function navigateTo(url) {
  const r = parseUrl(url)
  const name = nameOf(r.path)
  if (!name) {
    console.warn('[nav] 未登记的页面路径：' + r.path)
    return
  }
  if (!ref || !ref.isReady()) {
    console.warn('[nav] 导航还没就绪，忽略跳转 ' + r.path)
    return
  }
  stack.push(r.path)
  ref.navigate(name, r.params)
}

function switchTab(url) {
  const r = parseUrl(url)
  const name = TABS[r.path] || nameOf(r.path)
  if (!name || !ref || !ref.isReady()) return
  stack.length = 1
  stack[0] = r.path
  ref.navigate(name, r.params)
}

// 重定向 / 重启：都当「换掉当前页」处理，行为差异在 App 里没有意义
function redirectTo(url) {
  const r = parseUrl(url)
  const name = nameOf(r.path)
  if (!name || !ref || !ref.isReady()) return
  stack.pop()
  stack.push(r.path)
  ref.navigate(name, r.params)
}

function reLaunch(url) {
  const r = parseUrl(url)
  const name = nameOf(r.path)
  if (!name || !ref || !ref.isReady()) return
  stack.length = 1
  stack[0] = r.path
  ref.reset({ index: 0, routes: [{ name: name, params: r.params }] })
}

function navigateBack(delta) {
  const n = Math.max(1, Number(delta) || 1)
  if (!ref || !ref.isReady() || !ref.canGoBack()) return
  for (let i = 0; i < n; i++) stack.pop()
  if (!stack.length) stack.push('/pages/holdings/holdings')
  ref.goBack()
}

/* ---------------- 页面标题 ---------------- */

/** 当前最上层页面的 route name */
function activeName() {
  if (!ref || !ref.isReady() || !ref.getCurrentRoute) return ''
  const r = ref.getCurrentRoute()
  return (r && r.name) || ''
}

function setTitle(title) {
  const name = activeName()
  if (!name) return
  const set = titleListeners.get(name)
  if (!set) return
  set.forEach((fn) => fn(String(title || '')))
}

function onTitle(name, fn) {
  let set = titleListeners.get(name)
  if (!set) {
    set = new Set()
    titleListeners.set(name, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) titleListeners.delete(name)
  }
}

module.exports = {
  ROUTES,
  TABS,
  bind,
  parseUrl,
  nameOf,
  navigateTo,
  switchTab,
  redirectTo,
  reLaunch,
  navigateBack,
  getCurrentPages: () => stack,
  setTitle,
  onTitle
}

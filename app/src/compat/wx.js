/**
 * 微信小程序 API 兼容垫片 —— 这次迁移的关键件。
 *
 * 目的：让 utils/ 里那 3000 多行已经验证过的业务逻辑（分红计算、持仓整理、
 * 行情批量取数、云端快照同步）**原样**在 React Native 里跑起来。
 * 只实现项目真正用到的那几个 API（先统计过再写的，见下）：
 *
 *   存储：getStorageSync / setStorageSync / removeStorageSync / clearStorageSync
 *   交互：showToast / showModal / showLoading / hideLoading / pageScrollTo / setNavigationBarTitle
 *   路由：navigateTo / switchTab / redirectTo / reLaunch / navigateBack
 *   网络：request
 *
 * 用不到的（wx.login / wx.requestVirtualPayment / wx.cloud）刻意做成「一调就报错」的桩，
 * 而不是静默什么都不做 —— 以后真要接支付，问题会立刻暴露，不会悄悄失败。
 */
const storage = require('./storage.js')
const ui = require('./ui.js')
const nav = require('./nav.js')

let installed = null

function install() {
  if (installed) return installed

  const wx = {
    /* ---------------- 存储 ---------------- */
    getStorageSync: (key) => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: (key) => storage.remove(key),
    clearStorageSync: () => storage.clear(),
    // 小程序里这个方法偶尔被用来探测有没有缓存；这里给真实实现
    getStorageInfoSync: () => ({ keys: Object.keys(storage.dump()) }),

    /* ---------------- 交互 ---------------- */
    showToast: (opts) => {
      const o = opts || {}
      ui.toast(o)
      if (typeof o.success === 'function') o.success({ errMsg: 'showToast:ok' })
    },
    showLoading: (opts) => {
      const o = opts || {}
      ui.loading(o.title)
      if (typeof o.success === 'function') o.success({ errMsg: 'showLoading:ok' })
    },
    hideLoading: () => {
      ui.hideLoading()
    },
    showModal: (opts) => {
      ui.modal(opts)
    },
    // 页面滚动：屏幕上自己用 ScrollView ref 实现，这里发个事件就够（没人听就忽略）
    pageScrollTo: () => {},
    setNavigationBarTitle: (opts) => nav.setTitle((opts || {}).title),

    /* ---------------- 路由 ---------------- */
    navigateTo: (opts) => nav.navigateTo((opts || {}).url),
    switchTab: (opts) => nav.switchTab((opts || {}).url),
    redirectTo: (opts) => nav.redirectTo((opts || {}).url),
    reLaunch: (opts) => nav.reLaunch((opts || {}).url),
    navigateBack: (opts) => nav.navigateBack((opts || {}).delta),

    /* ---------------- 网络 ----------------
     * 只有 utils/quote.js 的「直连兜底」在用（后端挂了时直连东财）。
     * RN 没有小程序那种域名白名单，所以这条路在 App 上是真的能用。
     */
    request: (opts) => {
      const o = opts || {}
      const method = String(o.method || 'GET').toUpperCase()

      fetch(o.url, {
        method: method,
        headers: o.header || { 'content-type': 'application/json' },
        body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(o.data || {}),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(o.timeout || 10000) : undefined
      })
        .then((res) =>
          res.text().then((text) => {
            let data = text
            try {
              data = text ? JSON.parse(text) : null
            } catch (e) {
              // 上游偶尔会回非 JSON（比如风控页），原样交出去让调用方判断
            }
            if (typeof o.success === 'function') o.success({ statusCode: res.status, data: data })
          })
        )
        .catch((e) => {
          if (typeof o.fail === 'function') o.fail({ errMsg: (e && e.message) || 'request:fail' })
        })
    },

    /* ---------------- 故意报错的桩 ---------------- */
    login: (opts) => {
      const msg = 'wx.login 在 App 端不可用（它只用于小程序虚拟支付）'
      console.warn('[wx] ' + msg)
      if (opts && typeof opts.fail === 'function') opts.fail({ errMsg: msg })
    },
    requestVirtualPayment: (opts) => {
      const msg = '虚拟支付在 App 端不可用；App 内购要接微信开放平台的 App 支付'
      console.warn('[wx] ' + msg)
      if (opts && typeof opts.fail === 'function') opts.fail({ errMsg: msg, errCode: -1 })
    },
    cloud: undefined,

    /* ---------------- 杂项 ---------------- */
    getSystemInfoSync: () => ({ platform: 'android', system: 'Android', SDKVersion: '3.0.0' }),
    getLaunchOptionsSync: () => ({ path: '/pages/holdings/holdings', query: {} })
  }

  global.wx = wx
  global.getCurrentPages = () => nav.getCurrentPages()
  // 页面代码里的 app.isLogin() / app.toGuide() 走这里（App.js 启动时注册进来）
  global.getApp = () => app

  installed = wx
  return wx
}

// App.js 里把真正的 App 实例注册进来
let app = null
function setApp(instance) {
  app = instance
}

module.exports = { install, setApp }

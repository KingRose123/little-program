const mock = require('./utils/mock.js')
const store = require('./utils/store.js')
const cloud = require('./utils/cloud.js')
const api = require('./utils/api.js')

/**
 * 云端对齐：进小程序时做一次，从后台切回来时也做一次。
 *
 * 只在 onLaunch 拉的话，用户在小程序里停留期间 App 那边加了数据，
 * 切回来看到的还是「进小程序那一刻」的快照 —— 表现就是「没同步」。
 * 手机上 App 和小程序来回切是常态，所以 onShow 也要对一次。
 * 加最小间隔是为了避免频繁切前后台反复打请求。
 */
let lastSyncAt = 0
const SYNC_MIN_GAP = 5000

function syncFromCloud(force) {
  // 没部署后端 / 断网时 cloud.init() 或请求失败，整段静默降级为纯本地模式
  if (!cloud.init()) return Promise.resolve(false)

  const now = Date.now()
  if (!force && now - lastSyncAt < SYNC_MIN_GAP) return Promise.resolve(false)
  lastSyncAt = now

  // 会员档位以服务端为准（兑换码 / 订单都在那边记账），本地那份只是缓存
  api.syncMembership()

  /**
   * 要不要「强制以云端为准」取决于关联状态：
   *
   *   本机已经记过记号 → 普通同步（本地有未推送的改动就以本地为准）
   *   还没记过        → 先问一次服务端。它说「已关联」，就说明服务端刚把两边
   *                     合并过，云端那份才是全的、本地已经是旧的 ——
   *                     这时必须强制以云端为准，否则紧接着的一次 push
   *                     会把合并结果整个盖掉，用户看到的就是
   *                     「App 那边显示已关联，小程序这边持仓一点没变」。
   */
  const pulled = api.linkedWechat()
    ? store.pullFromCloud()
    : api.linkStatus().then((s) => store.pullFromCloud(!!(s && s.linked)))

  // 页面先按本地快照渲染（零等待），拉到云端更新的数据后再让当前页重新取数
  return pulled.then((adopted) => {
    if (!adopted) return false

    const pages = getCurrentPages()
    const top = pages[pages.length - 1]
    // 页面基本都实现了 load()，直接复用；没有的话下次切页也会重新读快照
    if (top && typeof top.load === 'function') top.load()
    return true
  })
}

App({
  globalData: {
    isLogin: false,
    userInfo: null,
    hasOnboarded: false,
    // 引导流程中用户的选择，登录前属于临时态
    guestPlan: null
  },

  onLaunch() {
    this.globalData.isLogin = wx.getStorageSync('isLogin') || false
    this.globalData.userInfo = wx.getStorageSync('userInfo') || null
    this.globalData.hasOnboarded = wx.getStorageSync('hasOnboarded') || false
    this.globalData.guestPlan = wx.getStorageSync('guestPlan') || null

    // 老数据的币种口径修正必须排在拉云端**之前**：它会把改动标脏，
    // 紧接着的 pull 就按「本地优先」推上去。反过来先拉的话，
    // 版本标记已经写下、云端那份旧口径又把本地覆盖回来，等于没修。
    api.migrateNativeCurrency()

    // 实时汇率：先用上次缓存的（有就不必等网络），再后台刷一次。
    // 市值与预测年分红要按最新汇率看，所以这一步排在渲染之前。
    api.restoreFx()
    api.refreshFx()

    // 启动时强制对齐一次（不受最小间隔限制）
    syncFromCloud(true)
  },

  // 从后台切回来也对齐一次 —— 这是「这边改了那边没跟上」最常见的场景
  onShow() {
    syncFromCloud()
  },

  login(userInfo) {
    this.globalData.isLogin = true
    this.globalData.userInfo = userInfo || mock.user
    wx.setStorageSync('isLogin', true)
    wx.setStorageSync('userInfo', this.globalData.userInfo)
  },

  // 统一登录态判断，页面守卫统一走这里
  isLogin() {
    return !!this.globalData.isLogin
  },

  // 未登录时统一先回到引导页（reLaunch 清空页面栈，Tab 页也可安全跳转）
  toGuide() {
    wx.reLaunch({ url: '/pages/onboarding/onboarding' })
  },

  // 引导页的「跳过，直接登录」与「开始收息之路」回登录页
  toLogin() {
    wx.reLaunch({ url: '/pages/login/login' })
  },

  logout() {
    this.globalData.isLogin = false
    this.globalData.userInfo = null
    wx.removeStorageSync('isLogin')
    wx.removeStorageSync('userInfo')
  },

  finishOnboarding(plan) {
    this.globalData.hasOnboarded = true
    this.globalData.guestPlan = plan || null
    wx.setStorageSync('hasOnboarded', true)
    wx.setStorageSync('guestPlan', this.globalData.guestPlan)
  }
})

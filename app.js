const mock = require('./utils/mock.js')
const store = require('./utils/store.js')
const cloud = require('./utils/cloud.js')
const api = require('./utils/api.js')

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

    // 云托管数据对齐：页面先按本地快照渲染（零等待），
    // 拉到云端更新的数据后再让当前页面重新取一次数。
    // 没部署后端 / 断网时 cloud.init() 或请求失败，整段静默降级为纯本地模式。
    if (cloud.init()) {
      // 会员档位以服务端为准（兑换码 / 订单都在那边记账），本地那份只是缓存
      api.syncMembership()

      store.pullFromCloud().then((adopted) => {
        if (!adopted) return
        const pages = getCurrentPages()
        const top = pages[pages.length - 1]
        // 页面基本都实现了 load()，直接复用；没有的话下次切页也会重新读快照
        if (top && typeof top.load === 'function') top.load()
      })
    }
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

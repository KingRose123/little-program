/**
 * 全局 App 实例（对应小程序的 app.js）。
 *
 * 页面代码里会调 app.isLogin() / app.toGuide() / app.toLogin() / app.finishOnboarding()，
 * 所以这里提供同名方法，页面逻辑搬过来时不用改。
 *
 * 注意「登录态以 token 为准」：本地可能残留上次的 isLogin 标记，
 * 但 token 被清了（比如过期、或在别处退出登录）就必须算未登录。
 */
const storage = require('./compat/storage.js')
const nav = require('./compat/nav.js')
const cloud = require('./utils/cloud.js')

const authListeners = new Set()

const appInst = {
  globalData: { isLogin: false, userInfo: null, hasOnboarded: false, guestPlan: null },

  // 启动时从本地恢复一次
  restore() {
    this.globalData.userInfo = storage.get('userInfo') || null
    this.globalData.hasOnboarded = !!storage.get('hasOnboarded')
    this.globalData.guestPlan = storage.get('guestPlan') || null
    this.globalData.isLogin = this.isLogin()
    return this.globalData.isLogin
  },

  isLogin() {
    return !!cloud.token()
  },

  getUser() {
    return this.globalData.userInfo || {}
  },

  login(userInfo) {
    this.globalData.isLogin = true
    if (userInfo) {
      this.globalData.userInfo = userInfo
      storage.set('userInfo', userInfo)
    }
    storage.set('isLogin', true)
    this.emitAuth()
  },

  logout() {
    this.globalData.isLogin = false
    this.globalData.userInfo = null
    // App 端的身份就是 token：退出登录必须把它清掉，
    // 否则「已退出」还带着身份，下次启动又被当成登录状态（小程序那份没这个问题，身份是平台注入的）
    cloud.clearLogin()
    storage.remove('isLogin')
    storage.remove('userInfo')
    this.emitAuth()
  },

  toGuide() {
    nav.reLaunch('/pages/onboarding/onboarding')
  },

  toLogin() {
    // 有登录门禁后，「去登录页」= 清掉登录态，导航会自动切回 Login
    // （不能直接 reLaunch 到 Login：未登录分支里的 Login 不受路由控制）
    cloud.clearLogin()
    this.logout()
  },

  finishOnboarding(plan) {
    this.globalData.hasOnboarded = true
    this.globalData.guestPlan = plan || null
    storage.set('hasOnboarded', true)
    storage.set('guestPlan', this.globalData.guestPlan)
  },

  /* ---------------- 登录态订阅（导航据此切换登录页 / 主页面）---------------- */

  onAuthChange(fn) {
    authListeners.add(fn)
    return () => authListeners.delete(fn)
  },

  emitAuth() {
    const logged = this.isLogin()
    authListeners.forEach((fn) => {
      try {
        fn(logged)
      } catch (e) {
        console.warn('[app] 登录态回调出错', e && e.message)
      }
    })
  }
}

module.exports = appInst

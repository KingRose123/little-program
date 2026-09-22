const app = getApp()
const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    // 默认**不**勾选：审核要求「应当由用户阅读后自行选择是否同意，不得默认强制同意」。
    // 也不落本地存储 —— 每次进来都得用户自己勾一次，不能替他记住。
    agreed: false,
    submitting: false
  },

  onLoad() {
    if (app.isLogin()) {
      wx.switchTab({ url: '/pages/holdings/holdings' })
    }
  },

  toggleAgree() {
    if (this.data.submitting) return
    this.setData({ agreed: !this.data.agreed })
  },

  onNeedAgree() {
    wx.showToast({ title: '请先勾选同意用户协议和隐私政策', icon: 'none' })
  },

  /* ---------------- 微信手机号快捷验证 ---------------- */
  // <button open-type="getPhoneNumber"> 的授权回调
  onGetPhoneNumber(e) {
    const d = e.detail || {}

    if (d.errMsg !== 'getPhoneNumber:ok') {
      this.handleAuthFail(d)
      return
    }

    // 新版（基础库 2.21.2+）返回 code，需交后端换取手机号
    // 旧版返回 encryptedData + iv，同样由后端解密
    this.doLogin({
      scene: 'phoneQuick',
      code: d.code || '',
      encryptedData: d.encryptedData || '',
      iv: d.iv || ''
    })
  },

  handleAuthFail(d) {
    const errMsg = d.errMsg || ''

    // 用户主动取消
    if (errMsg.indexOf('deny') > -1 || errMsg.indexOf('cancel') > -1) {
      wx.showToast({ title: '已取消授权', icon: 'none' })
      return
    }

    // 未开通「手机号快速验证」组件 / 其它失败。
    // 短信登录这条退路已经去掉，所以留一个「先看看」的出口 ——
    // 否则组件没开通时，用户在登录页就彻底进不来了。
    wx.showModal({
      title: '无法获取微信手机号',
      content: '登录需要用到微信手机号授权。如果一直失败，可能是小程序未开通「手机号快速验证」组件，请联系我们。',
      confirmText: '先看看',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) this.goGuide()
      }
    })
  },

  doLogin(payload) {
    util
      .submit(this, api.login(payload), { loadingText: '登录中', key: 'submitting' })
      .then((res) => {
        if (!res) return
        app.login(res.data)
        wx.switchTab({ url: '/pages/holdings/holdings' })
      })
  },

  // 进入未登录引导流
  goGuide() {
    if (this.data.submitting) return
    wx.navigateTo({ url: '/pages/onboarding/onboarding' })
  },

  // 协议正文统一放在 doc 页（和「我的」页的 DOC_KEYS 是同一套 key）。
  // 之前这里写的是「本地演示版本、不采集任何真实用户数据」——
  // 现在会存云端快照与微信手机号，那句话已经不成立了。
  onPrivacy() {
    wx.navigateTo({ url: '/pages/doc/doc?key=privacy' })
  },

  onAgreement() {
    wx.navigateTo({ url: '/pages/doc/doc?key=agreement' })
  }
})

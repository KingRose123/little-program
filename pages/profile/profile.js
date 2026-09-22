const app = getApp()
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const util = require('../../utils/util.js')

// 这五个 key 都跳「说明文档」页，由 doc 页按 key 分流内容
const DOC_KEYS = ['standard', 'contact', 'disclaimer', 'agreement', 'privacy']

Page({
  data: {
    guest: false,
    loading: true,
    submitting: false,
    user: {},
    member: {},
    expenseCount: 0,
    monthExpenseText: '0',
    yearExpenseText: '0',
    group1: [],
    group2: [],

    // 显示货币面板
    curOpen: false,
    curCode: '',
    curList: [],

    // 多账户面板
    accOpen: false,
    accounts: [],
    activeAccId: '',

    // 新增账户面板
    addAccOpen: false,
    accForm: { name: '', broker: '' }
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    this.boot()
  },

  // 登录守卫：未登录先去引导页
  boot() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false })
      app.toGuide()
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
  },

  load() {
    // 先问一次服务端的关联状态，再取 profile：本机那个记号会随卸载重装丢掉，
    // 以服务端为准才能正确显示「已关联」，顺带把记号补回来
    return api
      .linkStatus()
      .then(() => api.getProfile())
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  },

  goExpense() {
    wx.navigateTo({ url: '/pages/life-expense/life-expense' })
  },

  // 会员入口：档位与权益对比都在会员中心页
  onPro() {
    wx.navigateTo({ url: '/pages/membership/membership' })
  },

  /* ---------------- 设置项分流 ---------------- */

  onItem(e) {
    const key = e.currentTarget.dataset.key

    if (DOC_KEYS.indexOf(key) > -1) {
      wx.navigateTo({ url: '/pages/doc/doc?key=' + key })
      return
    }

    if (key === 'member') {
      wx.navigateTo({ url: '/pages/membership/membership' })
      return
    }

    if (key === 'currency') {
      this.openCurrency()
      return
    }

    if (key === 'account') {
      this.openAccounts()
      return
    }

    if (key === 'phone') {
      const hit = this.data.group1.filter((it) => it.key === 'phone')[0] || {}

      // 没绑定时那行被 getPhoneNumber 按钮盖住，正常走不到这里；兜一句免得点了没反应
      if (!hit.bound) {
        wx.showToast({ title: '请点击右侧授权绑定手机号', icon: 'none' })
        return
      }

      wx.showModal({
        title: '已绑定手机号',
        content: hit.value + '\n\n手机号用于登录与账号找回。',
        showCancel: false
      })
      return
    }

    if (key === 'link') {
      this.openLink()
    }
  },

  /* ---------------- 关联 App 账号 ---------------- */

  /**
   * 生成一次性配对码，交给 App 输入即可把两边账号并成一个账号。
   * 小程序这边本来就是微信身份，不需要再验证手机号，所以全程没有短信费用。
   * 顺手把码复制到剪贴板，省得用户两个端对着抄。
   */
  openLink() {
    // 已经关联过就别再生成码了：合并是一次性的，再生成的码在 App 那边输进去
    // 只会得到「这是你自己的账号」—— 不如直接把现状说清楚
    if (api.linkedWechat()) {
      wx.showModal({
        title: '已关联',
        content: '这个微信账号已经和 App 账号关联过了，两边的持仓、账户与设置共用同一份数据，不用再关联。',
        showCancel: false
      })
      return
    }

    wx.showLoading({ title: '生成中', mask: true })

    // 生成码之前先把本地推上云：服务端合并的是**云端那两份快照**，
    // 本地还没推上去的改动不会参与合并，合完反而会被云端盖掉
    store
      .pushToCloud()
      .catch(() => false)
      .then(() => api.createLinkCode())
      .then((res) => {
        wx.hideLoading()
        const code = (res && res.data && res.data.code) || ''
        if (!code) {
          wx.showToast({ title: '生成失败，请重试', icon: 'none' })
          return
        }

        wx.setClipboardData({
          data: code,
          success: () => {
            wx.showModal({
              title: '配对码已复制',
              content:
                code +
                '\n\n打开 App，在「我的 → 关联小程序账号」里粘贴这串码即可（10 分钟内有效）。两边的数据会合并到一起。',
              showCancel: false
            })
          },
          // 复制失败（用户没给剪贴板权限）也要把码显示出来，否则他抄不到
          fail: () => {
            wx.showModal({
              title: '配对码',
              content:
                code + '\n\n请在 App 的「我的 → 关联小程序账号」里输入这串码（10 分钟内有效）。',
              showCancel: false
            })
          }
        })
      })
      .catch((e) => {
        wx.hideLoading()
        util.onError(e)
      })
  },

  /* ---------------- 手机号绑定 ---------------- */

  /**
   * 绑定手机号（「我的」页那一行的 getPhoneNumber 回调）。
   * 授权拿到的 code 交给 api.bindPhone —— 换号码要用 AppSecret，只能在服务端做。
   * 走这条路而不是复用登录流程，是为了让「已经登录过但没留手机号」的老用户也能补绑。
   */
  onBindPhone(e) {
    const d = (e && e.detail) || {}

    if (d.errMsg !== 'getPhoneNumber:ok') {
      // 用户主动取消就不打扰
      if (String(d.errMsg || '').indexOf('deny') === -1) {
        wx.showToast({ title: '未获取到手机号授权', icon: 'none' })
      }
      return
    }

    if (!d.code) {
      wx.showToast({ title: '请升级微信后重试', icon: 'none' })
      return
    }

    wx.showLoading({ title: '绑定中', mask: true })
    api
      .bindPhone(d.code)
      .then(() => {
        wx.hideLoading()
        wx.showToast({ title: '已绑定', icon: 'success' })
        this.load()
      })
      .catch((err) => {
        wx.hideLoading()
        util.onError(err)
      })
  },

  /* ---------------- 显示货币 ---------------- */

  openCurrency() {
    api
      .getCurrencyOptions()
      .then((res) => {
        this.setData({ curOpen: true, curCode: res.data.current, curList: res.data.list })
      })
      .catch(util.onError)
  },

  closeCurrency() {
    if (this.data.curOpen) this.setData({ curOpen: false })
  },

  onPickCurrency(e) {
    const code = e.currentTarget.dataset.code
    if (code === this.data.curCode) {
      this.closeCurrency()
      return
    }

    util
      .submit(this, api.saveCurrency(code), { loadingText: '切换中', success: '已切换显示货币' })
      .then((r) => {
        if (!r) return
        this.setData({ curCode: code })
        this.closeCurrency()
        // 菜单右侧的币种文案与页面金额都要跟着变
        this.load()
      })
  },

  /* ---------------- 多账户管理 ---------------- */

  openAccounts() {
    api
      .getAccounts()
      .then((res) => {
        this.setData({
          accOpen: true,
          accounts: res.data.list,
          activeAccId: res.data.activeId
        })
      })
      .catch(util.onError)
  },

  closeAccounts() {
    if (this.data.accOpen) this.setData({ accOpen: false })
  },

  refreshAccounts() {
    return api.getAccounts().then((res) => {
      this.setData({ accounts: res.data.list, activeAccId: res.data.activeId })
      this.load()
    })
  },

  onPickAccount(e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.activeAccId) {
      this.closeAccounts()
      return
    }

    util
      .submit(this, api.switchAccount(id), { loadingText: '切换中', success: '已切换账户' })
      .then((r) => {
        if (!r) return
        this.closeAccounts()
        this.refreshAccounts()
      })
  },

  onRemoveAccount(e) {
    const id = e.currentTarget.dataset.id
    const acc = this.data.accounts.filter((a) => a.id === id)[0] || {}

    // 说清楚会带走什么：账户下的持仓是跟着账户一起走的
    const n = Number(acc.holdingCount) || 0
    const extra = n ? '，该账户下的 ' + n + ' 只持仓与流水也会一并清除' : ''

    wx.showModal({
      title: '删除账户',
      content: '删除「' + acc.name + '」后不可恢复' + extra + '，确定继续吗？',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.removeAccount(id), { loadingText: '删除中', success: '已删除' })
          .then((r) => {
            if (r) this.refreshAccounts()
          })
      }
    })
  },

  openAddAccount() {
    this.setData({ addAccOpen: true, accForm: { name: '', broker: '' } })
  },

  closeAddAccount() {
    if (this.data.addAccOpen) this.setData({ addAccOpen: false })
  },

  onAccInput(e) {
    const field = e.currentTarget.dataset.field
    const accForm = Object.assign({}, this.data.accForm)
    accForm[field] = e.detail.value
    this.setData({ accForm })
  },

  onSubmitAccount() {
    const f = this.data.accForm
    if (!String(f.name).trim()) {
      wx.showToast({ title: '请填写账户名称', icon: 'none' })
      return
    }

    util
      .submit(this, api.addAccount(f), { loadingText: '添加中', success: '已添加' })
      .then((r) => {
        if (!r) return
        // 新增后直接切到新账户，省一步操作
        const list = r.data
        const created = list[list.length - 1]
        this.setData({ addAccOpen: false })

        if (created) {
          api
            .switchAccount(created.id)
            .then(() => this.refreshAccounts())
            .catch(util.onError)
        } else {
          this.refreshAccounts()
        }
      })
  },

  /* ---------------- 退出 / 注销 ---------------- */

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录，确定继续吗？',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.logout(), { loadingText: '退出中', success: '已退出登录' })
          .then((r) => {
            if (!r) return
            app.logout()
            setTimeout(() => app.toGuide(), 600)
          })
      }
    })
  },

  // 注销：清空本机全部数据，等同于恢复出厂设置
  onDestroyAccount() {
    wx.showModal({
      title: '注销账号',
      content: '注销会清空本机的持仓、账户与全部设置，且不可恢复。确定继续吗？',
      confirmText: '确认注销',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.destroyAccount(), { loadingText: '注销中', success: '账号已注销' })
          .then((r) => {
            if (!r) return
            app.logout()
            setTimeout(() => app.toLogin(), 700)
          })
      }
    })
  }
})

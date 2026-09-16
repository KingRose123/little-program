const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    ready: false, // 本地权益数据已渲染
    error: false, // 连本地数据都拿不到（理论上不该发生，兜底用）
    submitting: false,

    status: {},
    tiers: [],
    features: [],
    plans: [],
    notes: [],
    // 当前选中的方案（底部购买栏读它）
    pickedKey: '',
    picked: {},
    // 权益表的标题与脚注：免费开放期会换成「档位规划」的说法，由 api 层给
    tableTitle: '',
    tableNote: ''
  },

  onLoad() {
    this.load()
  },

  // 支付完成 / 兑换成功回来，重新对齐一次档位
  onShow() {
    if (this.data.ready) this.load()
  },

  /* ---------------- 渲染 ---------------- */

  apply(d) {
    // 已选的方案优先保留，否则用默认档（热门 Pro）
    const keys = d.plans.map((p) => p.key)
    const pickedKey = keys.indexOf(this.data.pickedKey) > -1 ? this.data.pickedKey : d.defaultPlanKey

    this.setData({
      ready: true,
      error: false,
      status: d.status,
      tiers: d.tiers,
      features: d.features,
      plans: d.plans,
      notes: d.notes,
      tableTitle: d.tableTitle,
      tableNote: d.tableNote,
      pickedKey: pickedKey,
      picked: d.plans.filter((p) => p.key === pickedKey)[0] || {}
    })
  },

  /**
   * 权益表与方案都是本地定义，先同步渲染出来 ——
   * 这个页面是用户「看自己有哪些权益」的地方，不能因为一次网络请求慢或失败就一片空白。
   * 渲染完再去服务端对齐档位（支付成功后、换设备登录后需要），拿到后重渲染一次。
   */
  load() {
    try {
      this.apply(api.membershipVM())
    } catch (e) {
      console.error('[membership] 权益数据渲染失败', e)
      this.setData({ ready: false, error: true })
      return Promise.resolve()
    }

    return api
      .syncMembership()
      .then((changed) => {
        if (changed) this.apply(api.membershipVM())
      })
      .catch(() => null)
  },

  onRetry() {
    this.setData({ error: false })
    this.load()
  },

  /* ---------------- 方案选择 ---------------- */

  onPick(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      pickedKey: key,
      picked: this.data.plans.filter((p) => p.key === key)[0] || {}
    })
  },

  /* ---------------- 支付 ---------------- */

  // 开通：服务端签名 → 调起虚拟支付 → 回来等发货
  onBuy() {
    // 免费开放期不卖会员 —— 兜底拦一道，万一入口被绕过也不该收钱
    if (this.data.status && this.data.status.selling === false) {
      wx.showToast({ title: '当前全员免费，无需开通', icon: 'none' })
      return
    }

    const plan = this.data.picked
    if (!plan || !plan.key || this.data.submitting) return

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建订单', mask: true })

    api
      .createMembershipOrder(plan.key)
      .then((res) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        this.pay(res.data)
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        // 支付通道还没配好（缺 offerId / AppKey / 道具）时也会走到这里，
        // 如实转达服务端的说明，并把兑换码这条路递过去
        wx.showModal({
          title: '暂时无法在线支付',
          content: (e && e.msg) || '请稍后重试。',
          confirmText: '去兑换',
          cancelText: '稍后',
          success: (r) => {
            if (r.confirm) this.onRedeem()
          }
        })
      })
  },

  // 调起小程序虚拟支付（会员是虚拟商品，只能走这个通道）
  pay(order) {
    if (!order || !order.signData) {
      wx.showModal({ title: '开通失败', content: '没拿到支付参数，请稍后重试。', showCancel: false })
      return
    }

    if (!wx.requestVirtualPayment) {
      wx.showModal({
        title: '微信版本过低',
        content: '当前微信版本不支持小程序虚拟支付，请升级微信后重试，或先用兑换码开通。',
        confirmText: '去兑换',
        cancelText: '知道了',
        success: (r) => {
          if (r.confirm) this.onRedeem()
        }
      })
      return
    }

    wx.requestVirtualPayment({
      signData: order.signData,
      paySig: order.paySig,
      signature: order.signature,
      mode: order.mode,
      success: () => this.awaitDelivery(order.outTradeNo),
      fail: (e) => {
        // -2 是用户主动取消，不必打扰
        if (e && e.errCode === -2) return
        wx.showModal({
          title: '支付未完成',
          content: (e && e.errMsg) || '请稍后重试',
          showCancel: false
        })
      }
    })
  },

  /**
   * 支付成功后等发货。
   * 官方文档明确说 requestVirtualPayment 的 success 回调可能丢失，
   * 所以不能只看它 —— 这里轮询服务端的订单状态，以服务端有没有发货为准。
   */
  awaitDelivery(outTradeNo) {
    if (!outTradeNo) return this.load()

    wx.showLoading({ title: '开通中', mask: true })
    let tries = 0

    const tick = () => {
      tries++

      api
        .getOrderStatus(outTradeNo)
        .then((res) => {
          const d = (res && res.data) || {}

          if (d.status === 'paid') {
            wx.hideLoading()
            wx.showToast({ title: '已开通', icon: 'success' })
            this.load()
            return
          }

          if (tries >= 6) {
            wx.hideLoading()
            wx.showModal({
              title: '正在开通',
              content: '支付已成功，开通可能还需一会儿。稍后回到本页会自动刷新；若长时间未开通，请联系我们。',
              showCancel: false
            })
            this.load()
            return
          }

          setTimeout(tick, 1500)
        })
        .catch(() => {
          wx.hideLoading()
          wx.showToast({ title: '支付已成功，稍后自动开通', icon: 'none' })
          this.load()
        })
    }

    tick()
  },

  /* ---------------- 兑换码 ---------------- */

  // 兑换码：校验在服务端，本地不硬编码任何码
  onRedeem() {
    wx.showModal({
      title: '输入兑换码',
      editable: true,
      placeholderText: '请输入兑换码',
      success: (r) => {
        if (!r.confirm) return
        const code = String(r.content || '').trim()
        if (!code) return

        util
          .submit(this, api.redeemMembership(code), { loadingText: '兑换中', success: '已开通' })
          .then((res) => {
            if (res) this.load()
          })
      }
    })
  }
})

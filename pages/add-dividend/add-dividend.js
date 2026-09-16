const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

// 各市场对红利税的默认口径不同，提示文案跟着市场走
const TAX_TIPS = {
  A: 'A 股分红默认全额到账，如实际被扣税可手动填写',
  ETF: '境内基金分红默认全额到账，如实际被扣税可手动填写',
  FUND: '境内基金分红默认全额到账，如实际被扣税可手动填写',
  HK: '港股红利税通常在派息时已按约 28% 预扣，如仍被额外扣税可手动填写',
  US: '美股股息税通常在派息时已预扣，如仍被额外扣税可手动填写'
}

Page({
  data: {
    loading: true,
    submitting: false,

    // 持仓侧信息：股票信息卡与「人民币/股」这类单位文案
    holding: null,
    taxTip: TAX_TIPS.A,

    date: '',
    shares: '',
    dps: '',
    tax: '',
    amount: ''
  },

  onLoad(options) {
    this.holdingId = (options && options.id) || ''

    if (!this.holdingId) {
      util.onError({ msg: '缺少持仓信息' })
      this.setData({ loading: false })
      util.backLater(this, 800)
      return
    }

    api
      .getHolding(this.holdingId)
      .then((res) => {
        const h = res.data
        this.setData({
          loading: false,
          holding: h,
          taxTip: TAX_TIPS[h.market] || TAX_TIPS.A
        })
      })
      .catch((e) => {
        util.onError(e)
        this.setData({ loading: false })
        util.backLater(this, 800)
      })
  },

  onUnload() {
    util.cancelBack(this)
  },

  /* ---------------- 表单 ---------------- */

  onDate(e) {
    this.setData({ date: e.detail.value })
  },

  // 股数 / 每股派息 / 红利税改动后重算到账金额
  onInput(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
    this.syncAmount()
  },

  // 手动改过金额就以用户的为准；清空则恢复自动计算
  onAmount(e) {
    const v = e.detail.value
    this.amountTouched = String(v).trim() !== ''
    this.setData({ amount: v })
    if (!this.amountTouched) this.syncAmount()
  },

  computeAmount() {
    const d = this.data
    return (Number(d.shares) || 0) * (Number(d.dps) || 0) - (Number(d.tax) || 0)
  },

  syncAmount() {
    if (this.amountTouched) return
    const v = this.computeAmount()
    this.setData({ amount: v > 0 ? util.money(v, 2) : '' })
  },

  onTaxHelp() {
    wx.showModal({
      title: '红利税',
      content:
        '分红所得被扣缴的税款。A 股按持股期限差别化征收（持股越久税率越低，超过一年免征），港股通一般按 20%～28% 预扣。实际被扣多少就填多少，留空视为全额到账。',
      showCancel: false
    })
  },

  /* ---------------- 提交 ---------------- */

  confirm() {
    const d = this.data
    const shares = Number(d.shares)
    const dps = Number(d.dps)
    const amount = Number(d.amount)

    if (!d.date) {
      wx.showToast({ title: '请选择红利入账日期', icon: 'none' })
      return
    }
    if (!(shares > 0)) {
      wx.showToast({ title: '请填写持仓数量', icon: 'none' })
      return
    }
    if (!(dps > 0)) {
      wx.showToast({ title: '请填写每股派息', icon: 'none' })
      return
    }
    if (!(amount > 0)) {
      wx.showToast({ title: '请填写实际到账金额', icon: 'none' })
      return
    }

    util
      .submit(
        this,
        api.addDividendRecord(this.holdingId, {
          date: d.date,
          shares,
          dps,
          tax: Number(d.tax) || 0,
          amount
        }),
        { loadingText: '保存中', success: '已记录' }
      )
      .then((res) => {
        if (!res) return
        util.backLater(this, 700)
      })
  }
})

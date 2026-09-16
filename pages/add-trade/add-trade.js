const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

// 交易类型：与参考图一致，顺序即展示顺序
const TRADE_TYPES = ['买入', '卖出', '送股', '分红复投']

function today() {
  const d = new Date()
  return d.getFullYear() + '-' + util.pad(d.getMonth() + 1) + '-' + util.pad(d.getDate())
}

Page({
  data: {
    loading: true,
    submitting: false,

    // 持仓侧信息：标题、市场徽标、显示货币
    holding: null,

    types: TRADE_TYPES,
    typeIndex: 0,
    typeName: TRADE_TYPES[0],

    date: '',
    shares: '',
    price: '',
    fee: ''
  },

  onLoad(options) {
    this.holdingId = (options && options.id) || ''
    this.setData({ date: today() })

    if (!this.holdingId) {
      util.onError({ msg: '缺少持仓信息' })
      this.setData({ loading: false })
      util.backLater(this, 800)
      return
    }

    api
      .getHolding(this.holdingId)
      .then((res) => this.setData({ loading: false, holding: res.data }))
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

  onType(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ typeIndex: i, typeName: this.data.types[i] })
  },

  onDate(e) {
    this.setData({ date: e.detail.value })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    const patch = {}
    patch[field] = e.detail.value
    this.setData(patch)
  },

  /* ---------------- 提交 ---------------- */

  confirm() {
    const d = this.data
    const shares = Number(d.shares)
    const price = Number(d.price)

    if (!(shares > 0)) {
      wx.showToast({ title: '请填写正确的数量', icon: 'none' })
      return
    }
    // 价格允许为 0（送股这类没有成交价），但不能是空或非法值
    if (String(d.price).trim() === '' || isNaN(price) || price < 0) {
      wx.showToast({ title: '请填写正确的价格', icon: 'none' })
      return
    }

    util
      .submit(
        this,
        api.addTradeRecord(this.holdingId, {
          date: d.date,
          type: d.types[d.typeIndex],
          shares,
          price,
          fee: Number(d.fee) || 0
        }),
        { loadingText: '保存中', success: '已记录' }
      )
      .then((res) => {
        if (!res) return
        util.backLater(this, 700)
      })
  }
})

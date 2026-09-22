const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

// 与「添加持仓」保持同一套口径说明
const DIV_TIPS = [
  '取最近 1 年的分红记录，计算每股派息',
  '取最近 3 年的分红记录，计算每股平均派息',
  '取最近 5 年的分红记录，计算每股平均派息',
  '手动填写每股派息金额'
]

Page({
  data: {
    loading: true,
    h: null,
    menus: [],
    showCurrency: true,
    submitting: false,

    // 编辑持仓面板
    editOpen: false,
    costModes: [],
    divModes: [],
    divTip: DIV_TIPS[0],
    // 分红税率：与「添加持仓」页同一套预设与说明
    taxOptions: [],
    taxTips: {},
    taxTip: '',
    form: {
      shares: '',
      cost: '',
      buyDate: '',
      fee: '',
      costModeIndex: 0,
      divModeIndex: 0,
      customDividend: '',
      negativeCost: false,
      taxIndex: 0,
      taxCustom: false,
      taxCustomRate: '',
      taxOn: true
    }
  },

  onLoad(options) {
    this.holdingId = (options && options.id) || 'hk06049'
    this.load()

    api
      .getAddHoldingOptions()
      .then((res) => {
        this.setData({
          costModes: res.data.costModes,
          divModes: res.data.divModes,
          taxOptions: res.data.taxOptions || [],
          taxTips: res.data.taxTips || {}
        })
      })
      .catch(util.onError)
  },

  // 从交易明细 / 分红记录返回时数据可能已变，重新拉一次
  onShow() {
    if (!this.data.loading) this.load()
  },

  load() {
    // 先渲染本地数据：编辑保存后立刻能看到新值，不必等网络。
    // 然后再刷一次实时行情与派息口径（内部有 5 分钟缓存），拿到后覆盖一遍。
    return api
      .getHolding(this.holdingId)
      .then((res) => this.apply(res.data))
      .then(() => api.refreshHoldingQuotes().catch(() => 0))
      .then(() => api.getHolding(this.holdingId))
      .then((res) => this.apply(res.data))
      .catch(util.onError)
  },

  apply(d) {
    this.setData({ loading: false, h: d, menus: d.menus })
  },

  // 提示条上把显示货币直接切到该持仓的本币
  switchCurrency() {
    if (this.data.submitting) return
    const market = this.data.h.market
    const code = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'

    this.setData({ showCurrency: false })
    util
      .submit(this, api.saveCurrency(code), { loadingText: '切换中', success: '已切换显示货币' })
      .then((r) => {
        if (r) this.load()
      })
  },

  /* ---------------- 功能菜单 ---------------- */

  onMenu(e) {
    const key = e.currentTarget.dataset.key

    // 明细类都进「持仓记录」页，用 tab 分流
    if (key === 'trade' || key === 'dividend' || key === 'file') {
      wx.navigateTo({
        url: '/pages/holding-record/holding-record?id=' + this.holdingId + '&tab=' + key
      })
      return
    }

    if (key === 'edit') {
      this.openEdit()
      return
    }

    // 校准持仓起点：把当前持仓定为新基准，旧交易只作流水
    if (key === 'reseed') {
      wx.showModal({
        title: '校准持仓起点',
        content:
          '会把当前持仓（' +
          this.data.h.sharesText +
          '）当作新的起点，已有交易明细只保留为流水、不再重复计入。\n\n适合你之前手动改过持仓、又记过交易的情况。',
        success: (res) => {
          if (!res.confirm) return
          util
            .submit(this, api.resetSeedBase(this.holdingId), {
              loadingText: '校准中',
              success: '已按当前持仓校准'
            })
            .then((r) => {
              if (r) this.load()
            })
        }
      })
      return
    }

    if (key === 'del') {
      wx.showModal({
        title: '删除持仓',
        content: '删除后不可恢复，确定继续吗？',
        confirmColor: '#E5484D',
        success: (res) => {
          if (!res.confirm) return
          util
            .submit(this, api.removeHolding(this.holdingId), {
              loadingText: '删除中',
              success: '已删除'
            })
            .then((r) => {
              if (!r) return
              util.backLater(this, 700)
            })
        }
      })
    }
  },

  // 菜单行右侧的「＋ 添加」：交易 / 分红各自对应一个整页表单
  onMenuAdd(e) {
    const key = e.currentTarget.dataset.key
    const path = key === 'dividend' ? '/pages/add-dividend/add-dividend?id=' : '/pages/add-trade/add-trade?id='
    wx.navigateTo({ url: path + this.holdingId })
  },

  // 「觉得不准？」说明预测口径，避免用户以为数字是官方数据
  onExplain() {
    wx.showModal({
      title: '分红怎么算的',
      content:
        '预测年分红 = 每股派息 × 持股数量，港股按 28% 税率扣税。每股派息取自所选分红口径（近1/3/5年或自定义），可在「编辑持仓」里调整。',
      showCancel: false
    })
  },

  /* ---------------- 编辑持仓 ---------------- */

  // 表单里当前生效的税率：预设档直接取，自定义档取输入框
  formTaxRate() {
    const opt = (this.data.taxOptions || [])[this.data.form.taxIndex]
    if (opt && opt.rate !== null && opt.rate !== undefined) return opt.rate
    const v = Number(this.data.form.taxCustomRate)
    return isNaN(v) ? 0 : v
  },

  openEdit() {
    const h = this.data.h
    if (!h) return

    const costModeIndex = Math.max(0, this.data.costModes.indexOf(h.costMode))
    const divModeIndex = Math.max(0, this.data.divModes.indexOf(h.divMode))

    // 税率 -> 胶囊下标；不在预设档位里就落到「自定义」
    const opts = this.data.taxOptions || []
    const lastIndex = opts.length - 1
    const hit = opts.map((o) => o.rate).indexOf(h.taxRate)
    const taxIndex = hit === -1 ? (lastIndex >= 0 ? lastIndex : 0) : hit
    const taxCustom = lastIndex >= 0 && taxIndex === lastIndex

    this.setData({
      editOpen: true,
      divTip: DIV_TIPS[divModeIndex],
      taxTip: (this.data.taxTips || {})[h.market] || '',
      form: {
        shares: String(h.shares),
        // 录入面板按**本币**回显：用户当初按本币填，重新打开就该看到同一个数
        // （h.cost 存的是折算后的人民币，直接用会让港股/美股显示成另一个数）
        cost: String(h.costNative === undefined ? h.cost : h.costNative),
        buyDate: h.buyDate || '',
        fee: h.feeNative ? String(h.feeNative) : '',
        costModeIndex,
        divModeIndex,
        customDividend: '',
        negativeCost: !!h.negativeCost,
        taxIndex,
        taxCustom,
        taxCustomRate: taxCustom ? String(h.taxRate) : '',
        taxOn: h.taxOn !== false
      }
    })
  },

  closeEdit() {
    this.setData({ editOpen: false })
  },

  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    const form = Object.assign({}, this.data.form)
    form[field] = e.detail.value
    this.setData({ form })
  },

  onFormDate(e) {
    this.setData({ form: Object.assign({}, this.data.form, { buyDate: e.detail.value }) })
  },

  onFormCostMode(e) {
    this.setData({
      form: Object.assign({}, this.data.form, { costModeIndex: Number(e.currentTarget.dataset.i) })
    })
  },

  onFormDivMode(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({
      form: Object.assign({}, this.data.form, { divModeIndex: i }),
      divTip: DIV_TIPS[i]
    })
  },

  onFormCustomDividend(e) {
    this.setData({
      form: Object.assign({}, this.data.form, { customDividend: e.detail.value })
    })
  },

  toggleFormNegative() {
    this.setData({
      form: Object.assign({}, this.data.form, { negativeCost: !this.data.form.negativeCost })
    })
  },

  /* ---------------- 分红税率 ---------------- */

  onFormTax(e) {
    const i = Number(e.currentTarget.dataset.i)
    const opt = (this.data.taxOptions || [])[i] || {}
    this.setData({
      form: Object.assign({}, this.data.form, { taxIndex: i, taxCustom: opt.rate === null })
    })
  },

  onFormTaxCustom(e) {
    this.setData({
      form: Object.assign({}, this.data.form, { taxCustomRate: e.detail.value })
    })
  },

  toggleFormTaxOn() {
    this.setData({
      form: Object.assign({}, this.data.form, { taxOn: !this.data.form.taxOn })
    })
  },

  onSaveEdit() {
    const f = this.data.form
    const shares = Number(f.shares)
    const cost = Number(f.cost)
    const customDividend = Number(f.customDividend)

    if (!(shares > 0)) {
      wx.showToast({ title: '请填写正确的持仓数量', icon: 'none' })
      return
    }
    if (String(f.cost).trim() === '' || isNaN(cost)) {
      wx.showToast({ title: '请填写当前成本', icon: 'none' })
      return
    }
    if (f.divModeIndex === 3 && !(customDividend > 0)) {
      wx.showToast({ title: '请填写每股派息', icon: 'none' })
      return
    }

    const payload = {
      shares,
      cost,
      buyDate: f.buyDate,
      fee: Number(f.fee) || 0,
      costMode: this.data.costModes[f.costModeIndex],
      divMode: this.data.divModes[f.divModeIndex],
      customDividend: f.divModeIndex === 3 ? customDividend : 0,
      negativeCost: f.negativeCost,
      // 分红税率逐只可配：关掉扣税开关时金额按 0% 算，但档位照存
      taxRate: this.formTaxRate(),
      taxOn: f.taxOn
    }

    util
      .submit(this, api.updateHolding(this.holdingId, payload), {
        loadingText: '保存中',
        success: '已保存'
      })
      .then((res) => {
        if (!res) return
        this.setData({ editOpen: false })
        this.load()
      })
  },

  onUnload() {
    util.cancelBack(this)
  }
})

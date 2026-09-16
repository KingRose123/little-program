const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    submitting: false,
    expenses: [],
    count: 0,
    monthText: '0',
    yearText: '0',

    // 添加自定义支出弹层
    showAdd: false,
    addForm: { name: '', amount: '', icon: '📌' },
    icons: { life: [], travel: [] }
  },

  onLoad() {
    this.load()
  },

  load() {
    return api
      .getExpenses()
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          expenses: d.list,
          count: d.count,
          monthText: d.monthText,
          yearText: d.yearText,
          icons: d.icons
        })
      })
      .catch(util.onError)
  },

  /* ================= 编辑金额 ================= */
  onAmountInput(e) {
    const id = e.currentTarget.dataset.id
    const expenses = this.data.expenses.map((i) =>
      i.id === id ? Object.assign({}, i, { amount: e.detail.value }) : i
    )
    this.setData({ expenses })
    this.refreshStat()
  },

  // 失焦时才落库，避免每次按键都写存储
  onAmountBlur() {
    this.persist()
  },

  refreshStat() {
    const year = this.data.expenses.reduce((s, i) => s + (Number(i.amount) || 0) * 12, 0)
    // 合计按显示货币换算展示（录入与存储仍为人民币）
    this.setData({
      count: this.data.expenses.length,
      yearText: api.moneyText(year, 0),
      monthText: api.moneyText(year / 12, 0)
    })
  },

  persist() {
    return api.saveExpenses(this.data.expenses).catch(util.onError)
  },

  /* ================= 删除 ================= */
  onRemove(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.expenses.filter((i) => i.id === id)[0]
    if (!item) return

    wx.showModal({
      title: '删除支出',
      content: '确定删除「' + item.name + '」吗？',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.removeExpense(id), { loadingText: '删除中', key: 'submitting' })
          .then((r) => {
            if (!r) return
            this.setData({
              expenses: r.data.list,
              count: r.data.count,
              monthText: r.data.monthText,
              yearText: r.data.yearText
            })
          })
      }
    })
  },

  /* ================= 添加自定义支出 ================= */
  openAdd() {
    if (this.data.submitting) return
    this.setData({
      showAdd: true,
      addForm: { name: '', amount: '', icon: this.data.icons.life[0] || '📌' }
    })
  },

  closeAdd() {
    this.setData({ showAdd: false })
  },

  // 阻止弹层内部点击冒泡到遮罩
  noop() {},

  onAddInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ addForm: Object.assign({}, this.data.addForm, { [key]: e.detail.value }) })
  },

  pickIcon(e) {
    this.setData({ addForm: Object.assign({}, this.data.addForm, { icon: e.currentTarget.dataset.icon }) })
  },

  confirmAdd() {
    const f = this.data.addForm
    util
      .submit(
        this,
        api.addCustomExpense({ name: f.name, amount: f.amount, icon: f.icon }),
        { loadingText: '添加中', success: '已添加', key: 'submitting' }
      )
      .then((res) => {
        if (!res) return
        this.setData({
          showAdd: false,
          expenses: res.data.list,
          count: res.data.count,
          monthText: res.data.monthText,
          yearText: res.data.yearText
        })
      })
  },

  /* ================= 排序 / 跳转 ================= */
  onSort() {
    const list = this.data.expenses
      .slice()
      .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    this.setData({ expenses: list })
    this.persist()
    wx.showToast({ title: '已按金额从高到低排序', icon: 'none' })
  },

  goCoverage() {
    this.persist().then(() => {
      const pages = getCurrentPages()
      const prev = pages[pages.length - 2]
      // 从分红覆盖页进来的就返回，否则用 redirectTo 顶掉本页
      if (prev && prev.route === 'pages/coverage/coverage') {
        wx.navigateBack()
      } else {
        wx.redirectTo({ url: '/pages/coverage/coverage' })
      }
    })
  }
})

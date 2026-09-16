const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

const TITLES = { trade: '交易明细', dividend: '分红记录', file: '分红档案' }

// 悬浮「记一笔」按钮的文案：分红档案是只读的，没有可添加的记录
function addLabelOf(tab) {
  if (tab === 'trade') return '添加交易'
  if (tab === 'dividend') return '添加分红'
  return ''
}

Page({
  data: {
    loading: true,
    holding: null,
    tab: 'trade',
    tabs: [],
    trade: [],
    dividend: [],
    file: [],
    fileTotalText: '',
    filePassedText: '',
    fileSource: '',
    fileEmptyText: '',
    receivedText: '',

    // 悬浮「记一笔」按钮：addLabel 为空时整个按钮不出现
    addLabel: '',
    fabReady: false
  },

  onLoad(options) {
    this.id = (options && options.id) || ''
    const tab = (options && options.tab) || 'trade'
    wx.setNavigationBarTitle({ title: TITLES[tab] || '持仓记录' })
    this.setData({ tab })
    this.load()
  },

  // 从「添加交易」/「添加记录」返回时明细已变，重新拉一次
  onShow() {
    if (!this.data.loading) this.load()
  },

  load() {
    return api
      .getHoldingRecords(this.id)
      .then((res) => this.apply(res.data))
      .catch(util.onError)
  },

  apply(d) {
    this.setData({
      loading: false,
      holding: d.holding,
      trade: d.trade,
      dividend: d.dividend,
      file: d.file,
      fileTotalText: d.fileTotalText,
      filePassedText: d.filePassedText,
      fileSource: d.fileSource || '',
      fileEmptyText: d.fileEmptyText || '',
      receivedText: d.receivedText,
      addLabel: addLabelOf(this.data.tab),
      tabs: [
        { key: 'trade', label: '交易明细', count: d.trade.length },
        { key: 'dividend', label: '分红记录', count: d.dividend.length },
        { key: 'file', label: '分红档案', count: d.file.length }
      ]
    })

    // 悬浮按钮的入场动效：先渲染出初始态（透明 + 缩小），下一帧再加 .in，
    // 否则元素插入时就已经是终态，CSS 过渡根本不会跑
    if (!this.fabAnimated) {
      this.fabAnimated = true
      this.fabTimer = setTimeout(() => {
        if (!this.data.loading) this.setData({ fabReady: true })
      }, 80)
    }
  },

  onUnload() {
    if (this.fabTimer) clearTimeout(this.fabTimer)
  },

  onTab(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.tab) return
    wx.setNavigationBarTitle({ title: TITLES[key] || '持仓记录' })
    this.setData({ tab: key, addLabel: addLabelOf(key) })
  },

  /* ---------------- 添加记录 ---------------- */

  // 两个页签各自对应一个整页表单，加完回来自动刷新（onShow）
  onAdd() {
    const path =
      this.data.tab === 'dividend'
        ? '/pages/add-dividend/add-dividend?id='
        : '/pages/add-trade/add-trade?id='
    wx.navigateTo({ url: path + this.id })
  },

  onDelRecord(e) {
    const recordId = e.currentTarget.dataset.id
    const kind = e.currentTarget.dataset.kind

    wx.showModal({
      title: '删除这条记录？',
      content: '删除后不可恢复。',
      confirmColor: '#E5484D',
      success: (r) => {
        if (!r.confirm) return
        const req =
          kind === 'trade'
            ? api.removeTradeRecord(this.id, recordId)
            : api.removeDividendRecord(this.id, recordId)

        req
          .then((res) => {
            this.apply(res.data)
            wx.showToast({ title: '已删除', icon: 'none' })
          })
          .catch(util.onError)
      }
    })
  },

  goDetail() {
    util.back()
  }
})

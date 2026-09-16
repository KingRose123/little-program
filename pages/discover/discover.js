const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

// 四个工具卡片的落点：t2 分红日历是本 App 的 Tab，其余进工具页
const TOOL_ROUTES = {
  t1: '/pages/tool/tool?id=t1',
  t3: '/pages/tool/tool?id=t3',
  t4: '/pages/tool/tool?id=t4'
}

Page({
  data: {
    loading: true,
    tools: [],
    ranks: [],
    articles: [],

    // 搜索面板
    searchOpen: false,
    keyword: '',
    results: [],
    noResult: false
  },

  onLoad() {
    this.load()
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 2 })
    }
  },

  load() {
    api
      .getDiscover()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  },

  onTool(e) {
    const id = e.currentTarget.dataset.id

    if (id === 't2') {
      wx.switchTab({ url: '/pages/calendar/calendar' })
      return
    }

    const url = TOOL_ROUTES[id]
    if (url) wx.navigateTo({ url })
  },

  onRank(e) {
    wx.navigateTo({ url: '/pages/rank/rank?type=' + e.currentTarget.dataset.id })
  },

  onArticle(e) {
    wx.navigateTo({ url: '/pages/article/article?id=' + e.currentTarget.dataset.id })
  },

  /* ---------------- 跨市场搜索 ---------------- */

  onSearch() {
    this.setData({ searchOpen: true, keyword: '', results: [], noResult: false })
  },

  closeSearch() {
    if (this.data.searchOpen) this.setData({ searchOpen: false })
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })

    // 搜索走真实接口，防抖一下，避免每敲一个字都打一次请求
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.doSearch()
    }, 300)
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
  },

  doSearch() {
    const kw = String(this.data.keyword).trim()
    // 只认最后一次请求的结果，避免快速输入时旧结果覆盖新结果
    this.searchSeq = (this.searchSeq || 0) + 1
    const seq = this.searchSeq

    if (!kw) {
      this.setData({ results: [], noResult: false })
      return
    }

    api
      .searchAllStocks(kw)
      .then((res) => {
        if (seq !== this.searchSeq) return
        this.setData({ results: res.data, noResult: res.data.length === 0 })
      })
      .catch(util.onError)
  },

  // 搜到的标的可以直接带进添加持仓，省一次手输
  // 同一代码可能存在于不同市场（如 000756 既是深A也是场外基金），把市场一起带过去
  onPickStock(e) {
    const ds = e.currentTarget.dataset
    this.setData({ searchOpen: false })
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }
})

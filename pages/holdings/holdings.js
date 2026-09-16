const app = getApp()
const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    guest: false,
    loading: true,
    expanded: false,

    /* ---------- 我的持仓 ---------- */
    market: 'A',
    tabList: [],
    rawList: [], // 当前市场的持仓，未排序未分组
    viewGroups: [], // 渲染用：分组后的结构；不分组时是唯一一组、无组标题
    listTotal: 0,

    // 排序 / 分组
    sortOptions: [],
    groupOptions: [],
    sortKey: 'default',
    groupKey: 'none',

    // 排序 / 分组选择面板：'' 表示收起
    sheetKey: '',
    sheetTitle: '',
    sheetItems: [],

    coverageGrid: [],
    coveredCount: 0,
    totalCount: 0,
    gapText: '0',
    nextName: '',
    nextIcon: '',
    sum: {},

    // 悬浮操作菜单
    fabOpen: false,
    fabActions: [
      { key: 'ocr', icon: '📷', label: '截图识别', btnClass: '' },
      { key: 'manual', icon: '✏️', label: '手动添加', btnClass: 'warm' }
    ]
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 0 })
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
    // 先按 code + market 刷新实时行情（内部有 5 分钟缓存），再拉数据，
    // 这样总市值 / 浮盈 / 市值息率都是用最新价算出来的
    api
      .refreshHoldingQuotes()
      .catch(() => 0)
      .then(() =>
        Promise.all([api.getSummary(), api.getCoverageBrief(), api.getHoldings(this.data.market)])
      )
      .then((res) => {
        const sum = res[0].data
        const cov = res[1].data
        const hold = res[2].data
        // 直接在赋值前算好分组结构，避免渲染两遍（先空列表再重排）
        const view = api.buildHoldingGroups(hold.list, this.data.sortKey, this.data.groupKey)

        this.setData({
          loading: false,
          sum,
          coveredCount: cov.coveredCount,
          totalCount: cov.totalCount,
          gapText: cov.gapText,
          nextName: cov.nextName,
          nextIcon: cov.nextIcon,
          coverageGrid: cov.grid,
          // 标签由实际持仓动态生成，当前市场可能已被删空而回退到别的市场
          market: hold.activeMarket,
          tabList: hold.tabs,
          rawList: hold.list,
          viewGroups: view.groups,
          listTotal: view.total,
          sortOptions: hold.sorts,
          groupOptions: hold.groupOptions
        })
      })
      .catch(util.onError)
  },

  onMarket(e) {
    const key = e.currentTarget.dataset.key
    if (key === this.data.market) return
    this.setData({ market: key })
    api
      .getHoldings(key)
      .then((res) => {
        const d = res.data
        this.setData({ market: d.activeMarket, tabList: d.tabs, rawList: d.list })
        this.applyView()
      })
      .catch(util.onError)
  },

  /* ---------------- 排序 / 分组 ---------------- */

  // 排序与分组都是纯计算，切换时不需要重新请求接口，零延迟重绘
  applyView() {
    const view = api.buildHoldingGroups(this.data.rawList, this.data.sortKey, this.data.groupKey)
    this.setData({
      viewGroups: view.groups,
      listTotal: view.total
    })
  },

  onSort() {
    this.openSheet('sort')
  },

  onGroup() {
    this.openSheet('group')
  },

  // kind: 'sort' | 'group'；面板里每一项带 on 标记，勾出当前生效的口径
  openSheet(kind) {
    const isSort = kind === 'sort'
    const options = isSort ? this.data.sortOptions : this.data.groupOptions
    if (!options.length) return

    const current = isSort ? this.data.sortKey : this.data.groupKey
    this.setData({
      sheetKey: kind,
      sheetTitle: isSort ? '排序方式' : '分组方式',
      sheetItems: options.map((o) => Object.assign({}, o, { on: o.key === current }))
    })
  },

  closeSheet() {
    if (this.data.sheetKey) this.setData({ sheetKey: '' })
  },

  onSheetPick(e) {
    const key = e.currentTarget.dataset.key
    const isSort = this.data.sheetKey === 'sort'
    const patch = { sheetKey: '' }
    patch[isSort ? 'sortKey' : 'groupKey'] = key

    this.setData(patch)
    this.applyView()
  },

  toggleExpand() {
    this.setData({ expanded: !this.data.expanded })
  },

  // 「20 年可达 N 倍」的口径来自复利推演，直接打开复利计算器看推导过程
  goProjection() {
    wx.navigateTo({ url: '/pages/tool/tool?id=t1' })
  },

  goMetricSettings() {
    wx.navigateTo({ url: '/pages/metric-settings/metric-settings' })
  },

  goCoverage() {
    wx.navigateTo({ url: '/pages/coverage/coverage' })
  },

  goDetail(e) {
    wx.navigateTo({ url: '/pages/holding-detail/holding-detail?id=' + e.currentTarget.dataset.id })
  },

  /* ---------------- 悬浮操作菜单 ---------------- */
  toggleFab() {
    this.setData({ fabOpen: !this.data.fabOpen })
  },

  closeFab() {
    if (this.data.fabOpen) this.setData({ fabOpen: false })
  },

  // 阻止菜单展开时页面跟着滚动
  noop() {},

  onFabAction(e) {
    const key = e.currentTarget.dataset.key
    this.closeFab()

    if (key === 'manual') {
      wx.navigateTo({ url: '/pages/add-holding/add-holding' })
      return
    }

    // 截图识别要依赖服务端 OCR，未接入前如实说明，并把用户引导到手动添加
    wx.showModal({
      title: '截图识别',
      content: '截图识别需要接入 OCR 服务，当前版本尚未开放。可以先用「手动添加」录入持仓。',
      confirmText: '手动添加',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/add-holding/add-holding' })
      }
    })
  },

  // 离开页面时收起菜单与面板，避免返回时还是展开态
  onHide() {
    this.closeFab()
    this.closeSheet()
  }
})

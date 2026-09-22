const app = getApp()
const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    guest: false,

    // 0 = 日历，1 = 年度总览（同一个页面的两个标签）
    segment: 0,

    /* ---------- 日历 ---------- */
    loading: true,
    year: 2026,
    month: 9,
    title: '',
    week: [],
    cells: [],
    legend: [],
    todayKey: '',
    selectedKey: '',
    monthEvents: [],
    noticeCount: 0,
    noticeAmount: '0.00',
    noticeNextKey: '',

    /* ---------- 年度总览 ---------- */
    ovLoading: true,
    ovLoaded: false,
    ovYear: 2026,
    ovReceivedText: '0.00',
    ovMonths: [],
    ovHasData: false
  },

  onLoad() {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const todayKey = year + '-' + util.pad(month) + '-' + util.pad(now.getDate())
    this.setData({
      year,
      month,
      ovYear: year,
      todayKey,
      selectedKey: todayKey
    })
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 1 })
    }
    this.boot()
  },

  // 登录守卫：未登录先去引导页
  boot() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false, ovLoading: false })
      app.toGuide()
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
    this.loadYearOverview()
  },

  /* ================= 标签切换 ================= */
  switchSegment(e) {
    this.setSegment(Number(e.currentTarget.dataset.i))
  },

  toCalendarTab() {
    this.setSegment(0)
  },

  // 同一页面内切换标签，不产生任何页面跳转
  setSegment(i) {
    if (i === this.data.segment) return
    this.setData({ segment: i })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  /* ================= 日历 ================= */
  // 连点翻月时会有多个请求同时在飞，只认最后一次，
  // 否则先发的请求后返回，会把上个月的格子盖到当前月（事件就跑错日期了）
  load() {
    const seq = (this.calSeq = (this.calSeq || 0) + 1)
    return api
      .getCalendar({
        year: this.data.year,
        month: this.data.month,
        todayKey: this.data.todayKey,
        selectedKey: this.data.selectedKey
      })
      .then((res) => {
        if (seq !== this.calSeq) return false
        const d = res.data
        this.events = d.events
        this.setData({
          loading: false,
          title: d.title,
          week: d.week,
          cells: d.cells,
          legend: d.legend,
          noticeCount: d.notice.count,
          noticeAmount: d.notice.amountText,
          noticeNextKey: d.notice.nextKey
        })
        this.loadDay(this.data.selectedKey)
        return true
      })
      .catch((e) => {
        util.onError(e)
        return false
      })
  },

  loadDay(key) {
    this.setData({ monthEvents: api.getDayEvents(key, this.events) })
  },

  onDay(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key.indexOf('-') < 0) {
      wx.showToast({ title: '请选择本月日期', icon: 'none' })
      return
    }
    const cells = this.data.cells.map((c) => Object.assign({}, c, { selected: c.key === key }))
    this.setData({ cells, selectedKey: key })
    this.loadDay(key)
  },

  prevMonth() {
    let year = this.data.year
    let month = this.data.month - 1
    if (month < 1) {
      month = 12
      year--
    }
    this.setMonth(year, month)
  },

  nextMonth() {
    let year = this.data.year
    let month = this.data.month + 1
    if (month > 12) {
      month = 1
      year++
    }
    this.setMonth(year, month)
  },

  setMonth(year, month) {
    // 切换月份时保留"几号"，超出该月天数则取月末（如 1/31 -> 2/28）
    const daysInMonth = new Date(year, month, 0).getDate()
    const cur = String(this.data.selectedKey || '').split('-')
    const day = Math.min(Number(cur[2]) || 1, daysInMonth)
    const selectedKey = year + '-' + util.pad(month) + '-' + util.pad(day)

    // 先用同步方法本地重绘网格，界面立刻响应，不再整页骨架屏闪烁
    const base = api.buildMonthCells({
      year,
      month,
      todayKey: this.data.todayKey,
      selectedKey
    })
    this.setData({
      year,
      month,
      selectedKey,
      title: base.title,
      week: base.week,
      cells: base.cells
    })

    // 再异步取分红事件，回来时覆盖为等价格子，视觉无跳变
    this.load()
  },

  // 回到今天：把月份与选中日期都拨回今天
  backToday() {
    const parts = this.data.todayKey.split('-')
    // 不置 loading，避免整块内容闪一下骨架屏
    this.setData({
      year: Number(parts[0]),
      month: Number(parts[1]),
      selectedKey: this.data.todayKey
    })
    this.load().then((applied) => {
      if (applied) wx.showToast({ title: '已回到今天', icon: 'none' })
    })
  },

  /* ================= 年度总览 ================= */
  loadYearOverview() {
    return api
      .getYearOverview(this.data.ovYear)
      .then((res) => {
        const d = res.data
        this.setData({
          ovLoading: false,
          ovLoaded: true,
          ovYear: d.year,
          ovReceivedText: d.receivedText,
          ovHasData: d.hasData,
          ovMonths: d.months
        })
      })
      .catch(util.onError)
  },

  prevYear() {
    this.loadOvYear(this.data.ovYear - 1)
  },

  nextYear() {
    this.loadOvYear(this.data.ovYear + 1)
  },

  // 年份照常切换，没有分红记录的年份如实提示，而不是拦住用户
  loadOvYear(y) {
    if (y < 2000 || y > 2100) {
      wx.showToast({ title: '年份超出可查询范围', icon: 'none' })
      return
    }
    this.setData({ ovYear: y, ovLoading: true })
    this.loadYearOverview().then(() => {
      if (!this.data.ovHasData) {
        wx.showToast({ title: y + ' 年暂无分红记录', icon: 'none' })
      }
    })
  },

  // 分红预告卡：跳到最早一笔待除权日，当天的分红会一并列在下方的当日明细里
  onNotice() {
    const key = this.data.noticeNextKey
    if (!key) {
      wx.showToast({ title: '暂无待除权的分红', icon: 'none' })
      return
    }
    this.goToKey(key, '已跳到最近一笔除权日')
  },

  // 「本月暂无待对账分红」：直接跳到下一笔有分红的月份
  goNextPayingMonth() {
    const keys = Object.keys(this.events || {}).sort()
    if (!keys.length) {
      wx.showToast({ title: '还没有分红安排，先添加持仓吧', icon: 'none' })
      return
    }

    const monthEnd = this.data.year + '-' + util.pad(this.data.month) + '-32'
    let next = ''
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] > monthEnd) {
        next = keys[i]
        break
      }
    }

    if (!next) {
      wx.showToast({ title: '后面没有更多分红安排', icon: 'none' })
      return
    }
    this.goToKey(next, '已跳到下一笔分红的月份')
  },

  // 把月份与选中日期一起拨到指定日期，重新拉取事件
  goToKey(key, tip) {
    const parts = key.split('-')
    this.setData({
      year: Number(parts[0]),
      month: Number(parts[1]),
      selectedKey: key
    })
    this.load().then((applied) => {
      if (applied) wx.showToast({ title: tip, icon: 'none' })
    })
  }
})

const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    coveredCount: 0,
    totalCount: 0,
    totalYearText: '0.00',
    dividendText: '0.00',
    receivedText: '0.00',
    stageName: '',
    stageIndex: 0,
    stageLine: 0,
    stages: [],
    needCount: 0,
    needGapText: '0',
    next: null,
    list: [],
    logs: []
  },

  onLoad() {
    this.load()
  },

  // 从「生活支出设置」返回时同步刷新覆盖清单
  // 首次进入时 onLoad 已触发，loading 仍为 true，这里跳过避免重复请求
  onShow() {
    if (this.data.loading) return
    this.load()
  },

  load() {
    return api
      .getCoverage()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  },

  // 顶部齿轮 -> 生活支出设置
  goExpenseSettings() {
    wx.navigateTo({ url: '/pages/life-expense/life-expense' })
  }
})

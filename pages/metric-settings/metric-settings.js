const app = getApp()
const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    submitting: false,
    max: 6,
    dividendText: '0.00',
    selectedKeys: [],
    selectedMetrics: [],
    optionalMetrics: []
  },

  onLoad() {
    // 登录守卫
    if (!app.isLogin()) {
      app.toGuide()
      return
    }
    api
      .getMetricSettings()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  },

  // 本地即时重算（同步，无请求延迟）
  apply(keys) {
    this.setData(api.previewMetrics(keys))
  },

  toggle(e) {
    if (this.data.submitting) return
    const key = e.currentTarget.dataset.key
    const keys = this.data.selectedKeys.slice()
    const i = keys.indexOf(key)

    if (i > -1) {
      keys.splice(i, 1)
    } else {
      if (keys.length >= this.data.max) {
        wx.showToast({ title: '最多选择 ' + this.data.max + ' 个指标', icon: 'none' })
        return
      }
      keys.push(key)
    }
    this.apply(keys)
  },

  // 恢复默认：只改预览，点「确认保存」才落库
  onReset() {
    if (this.data.submitting) return
    api
      .getDefaultMetricKeys()
      .then((res) => {
        this.apply(res.data)
        wx.showToast({ title: '已恢复默认，记得保存', icon: 'none' })
      })
      .catch(util.onError)
  },

  save() {
    util
      .submit(this, api.saveMetricSettings(this.data.selectedKeys), {
        loadingText: '保存中',
        success: '已保存'
      })
      .then((res) => {
        if (!res) return
        // 留一点时间让"已保存"提示被看到，再回上一页
        util.backLater(this, 600)
      })
  },

  onUnload() {
    // 用户在本页自行返回时，清掉待执行的定时器，避免多退一页
    util.cancelBack(this)
  }
})

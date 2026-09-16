const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

// 三个工具共用一个页面壳，靠 id 分流：t1 复利计算器 / t3 息率对比 / t4 定投回测
const TITLES = { t1: '复利计算器', t3: '息率对比', t4: '定投回测' }

Page({
  data: {
    loading: true,
    kind: '',

    // t1
    compound: null,
    cp: { principal: 100000, monthly: 3000, rate: 6, years: 20 },
    cpText: {},

    // t3
    compare: null,

    // t4
    dca: null,
    dcaParams: { code: '', monthly: 3000, years: 10 }
  },

  onLoad(options) {
    const kind = (options && options.id) || 't1'
    wx.setNavigationBarTitle({ title: TITLES[kind] || '工具' })
    this.setData({ kind })

    if (kind === 't3') {
      api
        .getYieldCompare()
        .then((res) => this.setData({ loading: false, compare: res.data }))
        .catch(util.onError)
      return
    }

    if (kind === 't4') {
      // 候选池与「息率对比」同源：先按实时行情 + 真实分红算好，再交给同步的 previewDca
      api
        .ensureYieldPool()
        .then((pool) => {
          this.yieldPool = pool
          const d = api.previewDca(this.data.dcaParams, pool)
          this.setData({
            loading: false,
            dca: d,
            dcaParams: { code: d.code, monthly: d.monthly, years: d.years }
          })
        })
        .catch((e) => {
          this.setData({ loading: false, dca: null })
          util.onError(e)
        })
      return
    }

    this.setData({ loading: false })
    this.refreshCompound()
  },

  /* ---------------- t1 复利计算器 ---------------- */

  // 同步重算，滑块拖动时零延迟
  refreshCompound() {
    const cp = this.data.cp
    const compound = api.previewCompound(cp)
    this.setData({
      compound,
      // 金额文案统一由数据层按显示货币产出，页面只保留百分比与年限
      cpText: {
        rate: util.money(cp.rate, 1),
        years: cp.years
      }
    })
  },

  onCpSlide(e) {
    const field = e.currentTarget.dataset.field
    const value = Number(e.detail.value)
    if (this.data.cp[field] === value) return

    const cp = Object.assign({}, this.data.cp)
    cp[field] = value
    this.setData({ cp })
    this.refreshCompound()
  },

  // 一键切到「只投本金」或「加满月投」，方便对比月投的作用
  onPreset(e) {
    const monthly = Number(e.currentTarget.dataset.monthly)
    this.setData({ cp: Object.assign({}, this.data.cp, { monthly }) })
    this.refreshCompound()
  },

  /* ---------------- t4 定投回测 ---------------- */

  // 参数变了只重算，不再请求接口：候选池已随实时行情缓存下来
  refreshDca() {
    this.setData({ dca: api.previewDca(this.data.dcaParams, this.yieldPool) })
  },

  onDcaSlide(e) {
    const field = e.currentTarget.dataset.field
    const value = Number(e.detail.value)
    if (this.data.dcaParams[field] === value) return

    const dcaParams = Object.assign({}, this.data.dcaParams)
    dcaParams[field] = value
    this.setData({ dcaParams })
    this.refreshDca()
  },

  onPickStock(e) {
    const code = e.currentTarget.dataset.code
    if (code === this.data.dcaParams.code) return
    this.setData({ dcaParams: Object.assign({}, this.data.dcaParams, { code }) })
    this.refreshDca()
  },

  /* ---------------- 通用 ---------------- */

  // 榜单 / 对比里的条目都能直接去添加持仓（带上市场，避免同代码取错标的）
  onAdd(e) {
    const ds = e.currentTarget.dataset
    if (!ds.code) return
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }
})

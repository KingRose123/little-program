const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    board: null
  },

  onLoad(options) {
    this.type = (options && options.type) || 'r1'
    this.load()
  },

  load() {
    api
      .getRank(this.type)
      .then((res) => {
        this.setData({ loading: false, board: res.data })
        wx.setNavigationBarTitle({ title: res.data.name })
      })
      .catch(util.onError)
  },

  // 点榜单条目 => 带着代码进添加页，省掉一次手输
  // 同一代码可能跨市场，把 market 一起带过去才能取对标的
  onPick(e) {
    const ds = e.currentTarget.dataset
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }
})

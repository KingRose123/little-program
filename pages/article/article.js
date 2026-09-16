const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    loading: true,
    article: null
  },

  onLoad(options) {
    this.id = (options && options.id) || 'a1'

    api
      .getArticle(this.id)
      .then((res) => {
        this.setData({ loading: false, article: res.data })
      })
      .catch(util.onError)
  },

  // 文章底部「去看看」：跳到对应工具
  onTool(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/tool/tool?id=' + id })
  },

  onShare() {
    wx.showToast({ title: '已复制文章链接', icon: 'none' })
  }
})

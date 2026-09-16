const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

// 三类法律文本 + 两类说明型文档共用这一个页面，靠 key 分流
const TITLES = {
  standard: '数据口径说明',
  contact: '联系我们',
  disclaimer: '免责声明',
  agreement: '用户协议',
  privacy: '隐私政策'
}

// 表格型（键值对）：其余走段落型
const TABLE_KEYS = ['standard', 'contact']

Page({
  data: {
    loading: true,
    title: '',
    updated: '',
    paras: [],
    rows: [],
    isTable: false
  },

  onLoad(options) {
    const key = (options && options.key) || 'agreement'
    wx.setNavigationBarTitle({ title: TITLES[key] || '说明' })
    this.setData({ isTable: TABLE_KEYS.indexOf(key) > -1 })

    const req = key === 'standard' ? api.getStandardDoc() : key === 'contact' ? api.getContactInfo() : api.getLegalDoc(key)

    req
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          title: d.title,
          updated: d.updated || '',
          paras: d.paras || [],
          rows: d.rows || []
        })
      })
      .catch(util.onError)
  }
})

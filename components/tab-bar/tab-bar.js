const TABS = [
  { index: 0, text: '持仓', icon: 'bars', path: '/pages/holdings/holdings' },
  { index: 1, text: '分红日历', icon: 'calendar', path: '/pages/calendar/calendar' },
  { index: 2, text: '发现', icon: 'compass', path: '/pages/discover/discover' },
  { index: 3, text: '我的', icon: 'user', path: '/pages/profile/profile' }
]

Component({
  properties: {
    selected: { type: Number, value: 0 },
    jump: { type: Boolean, value: true }
  },
  data: { tabs: TABS },

  methods: {
    onTap(e) {
      const index = Number(e.currentTarget.dataset.index)
      const tab = TABS[index]
      if (!tab || index === this.data.selected) return
      if (!this.data.jump) {
        this.triggerEvent('change', { index: index })
        return
      }
      wx.switchTab({ url: tab.path })
    }
  }
})

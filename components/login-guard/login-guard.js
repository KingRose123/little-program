Component({
  properties: {
    title: { type: String, value: '先登录后查看' },
    desc: { type: String, value: '未登录，带你回到收息佬的收息引导' },
    icon: { type: String, value: '🔒' }
  },

  methods: {
    // 主入口：未登录统一先去引导页
    goGuide() {
      wx.reLaunch({ url: '/pages/onboarding/onboarding' })
    },

    // 次入口：已有账号直接登录
    goLogin() {
      wx.reLaunch({ url: '/pages/login/login' })
    }
  }
})

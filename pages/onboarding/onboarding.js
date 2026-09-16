const app = getApp()
const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

Page({
  data: {
    step: 0,
    steps: ['了解', '选支出', '定计划', '看蓝图'],
    loading: true,

    // 步骤一
    slogan: '',
    preview: {},
    predict: {},
    litChips: [],
    unlitChips: [],
    litCount: 0,
    chipTotal: 0,
    nextChip: '',
    compound: {},
    tip: '',
    planFooter: {},

    // 步骤二
    expenses: [],
    selectedIds: [],
    selectedCount: 0,
    yearTotal: 0,
    yearTotalText: '',

    // 自定义支出面板
    addOpen: false,
    iconOptions: ['🐾', '🎓', '✈️', '🏥', '🎁', '📱', '🥗', '🚗'],
    addForm: { name: '', amount: '', icon: '🐾' },

    // 步骤三
    principal: 100000,
    monthly: 3000,
    rate: 5,
    principalText: '10万',
    monthlyText: '3,000元',
    rateText: '5%',

    // 步骤四
    targetYearText: '0',
    targetMonthText: '0',
    finalAssetsText: '0',
    coverPercent: 0,
    coverTip: '',
    blueprint: [],
    blueprintVisible: [],
    showAllYears: false,
    timeline: []
  },

  onLoad() {
    // 已登录直接进主页；未登录停留在引导页
    if (app.isLogin()) {
      wx.switchTab({ url: '/pages/holdings/holdings' })
      return
    }

    Promise.all([api.getOnboardingDemo(), api.getOnboardingExpenses()])
      .then((res) => {
        const demo = res[0].data
        const exp = res[1].data
        this.setData({
          loading: false,
          steps: demo.steps,
          slogan: demo.slogan,
          preview: demo.preview,
          predict: demo.predictCard,
          litChips: demo.litChips,
          unlitChips: demo.unlitChips,
          litCount: demo.litCount,
          chipTotal: demo.chipTotal,
          nextChip: demo.nextChip,
          compound: demo.compound,
          tip: demo.tip,
          planFooter: demo.planFooter,
          expenses: exp.list,
          // 滑块旁的金额文案按当前显示货币产出
          principalText: api.curSymbol() + util.wan(this.data.principal, 2),
          monthlyText: api.moneyText(this.data.monthly, 0)
        })
        return this.refreshPlan()
      })
      .catch(util.onError)
  },

  /* ---------------- 步骤切换 ---------------- */
  goStep(e) {
    this.setData({ step: Number(e.currentTarget.dataset.step) })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  next() {
    if (this.data.step === 1 && this.data.selectedCount === 0) {
      wx.showToast({ title: '请至少选择一项支出', icon: 'none' })
      return
    }
    this.setData({ step: Math.min(3, this.data.step + 1) })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  prev() {
    this.setData({ step: Math.max(0, this.data.step - 1) })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  /* ---------------- 步骤二：选支出 ---------------- */
  toggleExpense(e) {
    const id = e.currentTarget.dataset.id
    const expenses = this.data.expenses.map((item) => {
      if (item.id === id) item.on = !item.on
      return item
    })
    const selectedIds = expenses.filter((i) => i.on).map((i) => i.id)
    const yearTotal = expenses.filter((i) => i.on).reduce((s, i) => s + i.amount * 12, 0)
    this.setData({
      expenses,
      selectedIds,
      selectedCount: selectedIds.length,
      yearTotal,
      yearTotalText: api.moneyText(yearTotal, 0)
    })
  },

  /* 自定义支出：存进生活支出清单，登录后「我的 -> 生活支出设置」里也能看到 */
  addCustom() {
    this.setData({ addOpen: true, addForm: { name: '', amount: '', icon: '🐾' } })
  },

  closeAdd() {
    if (this.data.addOpen) this.setData({ addOpen: false })
  },

  onAddInput(e) {
    const field = e.currentTarget.dataset.field
    const addForm = Object.assign({}, this.data.addForm)
    addForm[field] = e.detail.value
    this.setData({ addForm })
  },

  onPickIcon(e) {
    this.setData({
      addForm: Object.assign({}, this.data.addForm, { icon: e.currentTarget.dataset.icon })
    })
  },

  onSubmitAdd() {
    const f = this.data.addForm
    util
      .submit(this, api.addCustomExpense(f), { loadingText: '添加中', success: '已添加' })
      .then((res) => {
        if (!res) return
        // 新项目直接勾上，回到列表后立刻计入合计
        const list = res.data.list
        const created = Object.assign({}, list[list.length - 1], { on: true })
        const expenses = this.data.expenses.concat([created])
        const selectedIds = expenses.filter((i) => i.on).map((i) => i.id)
        const yearTotal = expenses.filter((i) => i.on).reduce((s, i) => s + i.amount * 12, 0)

        this.setData(
          {
            addOpen: false,
            expenses,
            selectedIds,
            selectedCount: selectedIds.length,
            yearTotal,
            yearTotalText: api.moneyText(yearTotal, 0)
          },
          () => this.refreshPlan()
        )
      })
  },

  /* ---------------- 步骤三：定计划 ---------------- */
  // 拖动中只更新文案，避免高频请求
  onSliding(e) {
    const key = e.currentTarget.dataset.key
    const value = Number(e.detail.value)
    const patch = {}
    patch[key] = value
    if (key === 'principal') patch.principalText = api.curSymbol() + util.wan(value, 2)
    if (key === 'monthly') patch.monthlyText = api.moneyText(value, 0)
    if (key === 'rate') patch.rateText = value + '%'
    this.setData(patch)
  },

  onSlideEnd(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch[key] = Number(e.detail.value)
    this.setData(patch, () => this.refreshPlan())
  },

  // 计划参数或勾选项变化后重算蓝图
  refreshPlan() {
    return api
      .previewPlan({
        principal: this.data.principal,
        monthly: this.data.monthly,
        rate: this.data.rate,
        ids: this.data.selectedIds
      })
      .then((res) => {
        const d = res.data
        this.setData(
          {
            targetYearText: d.targetYearText,
            targetMonthText: d.targetMonthText,
            finalAssetsText: d.finalAssetsText,
            coverPercent: d.coverPercent,
            coverTip: d.coverTip,
            blueprint: d.blueprint,
            timeline: d.timeline,
            blueprintVisible: this.data.showAllYears ? d.blueprint : d.blueprint.slice(0, 4)
          }
        )
      })
      .catch(util.onError)
  },

  /* ---------------- 步骤四：看蓝图 ---------------- */
  enterBlueprint() {
    this.setData({ step: 3 })
    wx.pageScrollTo({ scrollTop: 0, duration: 0 })
  },

  toggleAllYears() {
    const showAllYears = !this.data.showAllYears
    this.setData({
      showAllYears,
      blueprintVisible: showAllYears ? this.data.blueprint : this.data.blueprint.slice(0, 4)
    })
  },

  /* ---------------- 收尾：引导登录 ---------------- */
  // 「跳过，直接登录」与「开始收息之路」都回到登录页
  skip() {
    app.finishOnboarding(null)
    app.toLogin()
  },

  finish() {
    util
      .submit(
        this,
        api.savePlan({
          principal: this.data.principal,
          monthly: this.data.monthly,
          rate: this.data.rate,
          ids: this.data.selectedIds
        }),
        { loadingText: '生成蓝图', key: 'submitting' }
      )
      .then((res) => {
        if (!res) return
        app.finishOnboarding(res.data)
        app.toLogin()
      })
  },

  // 未登录态点击 Tab 栏 -> 引导登录
  onTabChange() {
    app.toLogin()
  }
})

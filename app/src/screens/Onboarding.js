const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, Modal, StyleSheet } = require('react-native')
// 见 Tool.js 同名注释：4.5.x 导的是 { default: Slider }，必须取 .default
const Slider = require('@react-native-community/slider').default
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

/**
 * 引导页（登录前的四步引导）。
 *
 * 方法体与小程序那份逐字一致 —— 靠两个小助手把 RN 的回调包成小程序的事件形状：
 *   tap({k: 'v'}) → e.currentTarget.dataset
 *   val('1000')   → e.detail.value
 *
 * 三处 RN 特有的替换：
 *   1. 小程序用 <swiper> 做分步，这里用 step 下标 + 条件渲染（更可控，也方便步骤二挂底部固定栏）
 *   2. <slider> → @react-native-community/slider（见下面的 SliderRow）
 *   3. 自定义支出面板 → RN 的 Modal（小程序是靠 class 切换做滑入动画的常驻 sheet）
 */
const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

// wxss 里的 tag-* 类名 → RN 样式
const TAG_STYLES = {
  'tag-green': { backgroundColor: 'rgba(31, 157, 107, 0.10)', color: colors.primary },
  'tag-gold': { backgroundColor: 'rgba(217, 169, 60, 0.16)', color: '#9C7A1E' },
  'tag-blue': { backgroundColor: 'rgba(59, 130, 196, 0.12)', color: '#3B82C4' },
  'tag-orange': { backgroundColor: 'rgba(224, 137, 44, 0.14)', color: colors.orange },
  'tag-gray': { backgroundColor: colors.line2, color: colors.t3 }
}
const tagStyleOf = (cls) => TAG_STYLES[cls] || TAG_STYLES['tag-gray']

/**
 * 参数滑块。
 * 小程序的 <slider> 在 RN 里用 @react-native-community/slider；
 * 这里把「拖动中 / 松手」分别映射成 bindchanging / bindchange 的事件形状，
 * 页面的 onSliding / onSlideEnd 就能逐字沿用（拖动只更文案，松手才重算蓝图）。
 */
function SliderRow(props) {
  return (
    <View style={styles.slRow}>
      <View style={s.between}>
        <Text style={styles.slName}>{props.name}</Text>
        <Text style={[styles.slVal, s.num]}>{props.valueText}</Text>
      </View>
      <Slider
        style={styles.slider}
        minimumValue={props.min}
        maximumValue={props.max}
        step={props.step}
        value={props.value}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor="#EFF2F1"
        thumbTintColor={colors.primary}
        onValueChange={(v) => props.onSliding(Object.assign(tap({ key: props.field }), val(v)))}
        onSlidingComplete={(v) => props.onSlideEnd(Object.assign(tap({ key: props.field }), val(v)))}
      />
    </View>
  )
}

class Onboarding extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
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
    }
  }

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
  }

  /* ---------------- 步骤切换 ---------------- */

  // wx.pageScrollTo 在 RN 垫片里是空实现，滚动回顶部由 ScrollView ref 自己做
  scrollTop() {
    if (this.scrollRef && this.scrollRef.scrollTo) this.scrollRef.scrollTo({ y: 0, animated: false })
  }

  goStep(e) {
    this.setData({ step: Number(e.currentTarget.dataset.step) })
    this.scrollTop()
  }

  next() {
    if (this.data.step === 1 && this.data.selectedCount === 0) {
      wx.showToast({ title: '请至少选择一项支出', icon: 'none' })
      return
    }
    this.setData({ step: Math.min(3, this.data.step + 1) })
    this.scrollTop()
  }

  prev() {
    this.setData({ step: Math.max(0, this.data.step - 1) })
    this.scrollTop()
  }

  /* ---------------- 步骤二：选支出 ---------------- */

  toggleExpense(e) {
    const id = e.currentTarget.dataset.id
    const expenses = this.data.expenses.map((item) => {
      if (item.id === id) item.on = !item.on
      return item
    })
    const selectedIds = expenses.filter((i) => i.on).map((i) => i.id)
    const yearTotal = expenses.filter((i) => i.on).reduce((sum, i) => sum + i.amount * 12, 0)

    this.setData({
      expenses,
      selectedIds,
      selectedCount: selectedIds.length,
      yearTotal,
      yearTotalText: api.moneyText(yearTotal, 0)
    })
  }

  /* 自定义支出：存进生活支出清单，登录后「我的 → 生活支出设置」里也能看到 */

  addCustom() {
    this.setData({ addOpen: true, addForm: { name: '', amount: '', icon: '🐾' } })
  }

  closeAdd() {
    if (this.data.addOpen) this.setData({ addOpen: false })
  }

  onAddInput(e) {
    const field = e.currentTarget.dataset.field
    const raw = e.detail.value
    // 与支出页同一口径：名称是文本、每月金额是数字
    const addForm = Object.assign({}, this.data.addForm)
    addForm[field] = field === 'amount' ? validate.decimal(raw, { decimals: 2 }) : validate.plain(raw, { max: 12 })
    this.setData({ addForm })
  }

  onPickIcon(e) {
    this.setData({ addForm: Object.assign({}, this.data.addForm, { icon: e.currentTarget.dataset.icon }) })
  }

  onSubmitAdd() {
    const f = this.data.addForm

    // 与「生活支出」同一口径：名称必填、金额必须是正数
    const nameErr = validate.checkText(f.name, { max: 12 }, '支出名称')
    if (nameErr) {
      wx.showToast({ title: nameErr, icon: 'none' })
      return
    }
    const amountErr = validate.checkNum(f.amount, { positive: true }, '每月金额')
    if (amountErr) {
      wx.showToast({ title: amountErr, icon: 'none' })
      return
    }

    util
      .submit(this, api.addCustomExpense(f), { loadingText: '添加中', success: '已添加' })
      .then((res) => {
        if (!res) return

        // 新项目直接勾上，回到列表后立刻计入合计
        const list = res.data.list
        const created = Object.assign({}, list[list.length - 1], { on: true })
        const expenses = this.data.expenses.concat([created])
        const selectedIds = expenses.filter((i) => i.on).map((i) => i.id)
        const yearTotal = expenses.filter((i) => i.on).reduce((sum, i) => sum + i.amount * 12, 0)

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
  }

  /* ---------------- 步骤三：定计划 ---------------- */

  // 拖动中只更新文案，避免高频重算
  onSliding(e) {
    const key = e.currentTarget.dataset.key
    const value = Number(e.detail.value)
    const patch = {}
    patch[key] = value
    if (key === 'principal') patch.principalText = api.curSymbol() + util.wan(value, 2)
    if (key === 'monthly') patch.monthlyText = api.moneyText(value, 0)
    if (key === 'rate') patch.rateText = value + '%'
    this.setData(patch)
  }

  onSlideEnd(e) {
    const key = e.currentTarget.dataset.key
    const patch = {}
    patch[key] = Number(e.detail.value)
    this.setData(patch, () => this.refreshPlan())
  }

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
        this.setData({
          targetYearText: d.targetYearText,
          targetMonthText: d.targetMonthText,
          finalAssetsText: d.finalAssetsText,
          coverPercent: d.coverPercent,
          coverTip: d.coverTip,
          blueprint: d.blueprint,
          timeline: d.timeline,
          blueprintVisible: this.data.showAllYears ? d.blueprint : d.blueprint.slice(0, 4)
        })
      })
      .catch(util.onError)
  }

  /* ---------------- 步骤四：看蓝图 ---------------- */

  enterBlueprint() {
    this.setData({ step: 3 })
    this.scrollTop()
  }

  toggleAllYears() {
    const showAllYears = !this.data.showAllYears
    this.setData({
      showAllYears,
      blueprintVisible: showAllYears ? this.data.blueprint : this.data.blueprint.slice(0, 4)
    })
  }

  /* ---------------- 收尾：引导登录 ---------------- */

  // 「跳过，直接登录」与「开始收息之路」都回到登录页
  skip() {
    app.finishOnboarding(null)
    app.toLogin()
  }

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
  }

  // 未登录态点击底部 Tab → 引导登录。
  // RN 这版底部 Tab 归根导航器管，引导页不挂 TabBar，所以这个方法暂未接到渲染上；
  // 将来要给引导页加底部栏时，把它挂到对应 Pressable 即可。
  onTabChange() {
    app.toLogin()
  }

  /* ================= 渲染 ================= */

  // 固定头部：跳过 + 四步标签（RN 里放在 ScrollView 外面，天然固定）
  renderHead() {
    return (
      <View style={styles.head}>
        <Pressable style={styles.skipBtn} onPress={() => this.skip()}>
          <Text style={styles.skipText}>跳过，直接登录 ›</Text>
        </Pressable>
        <View style={styles.tabs}>
          {this.data.steps.map((item, index) => {
            const on = this.data.step === index
            return (
              <Pressable key={item} style={styles.tab} onPress={() => this.goStep(tap({ step: index }))}>
                <Text style={on ? styles.tabTextOn : styles.tabText}>{item}</Text>
                <View style={[styles.tabLine, on ? styles.tabLineOn : null]} />
              </Pressable>
            )
          })}
        </View>
      </View>
    )
  }

  renderLoading() {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyEmoji}>💰</Text>
        <Text style={styles.emptyTitle}>正在准备你的收息图谱…</Text>
      </View>
    )
  }

  /* ---------------- 步骤一：了解 ---------------- */

  renderIntro() {
    const pv = this.data.preview
    const pd = this.data.predict
    const cp = this.data.compound

    return (
      <View>
        <View style={styles.hero}>
          <Text style={styles.heroLogo}>💰</Text>
          <Text style={styles.heroName}>收息佬</Text>
          <Text style={styles.heroSub}>你的股息收入管家</Text>
          <Text style={styles.heroSlogan}>{this.data.slogan}</Text>
        </View>

        {/* 记录你的印钞机 */}
        <View style={s.card}>
          <View style={s.row}>
            <View style={[styles.iconBoxLg, styles.iconSoftGreen]}>
              <Text style={styles.iconEmojiLg}>📊</Text>
            </View>
            <View style={[s.flex1, { marginLeft: 12 }]}>
              <Text style={s.h3}>记录你的印钞机</Text>
              <Text style={[s.small, s.dim, { marginTop: 8 }]}>A股 · 港股 · 美股 · 基金 · ETF 全覆盖</Text>
            </View>
          </View>

          <View style={styles.demo}>
            <View style={s.between}>
              <View style={s.row}>
                <View style={styles.stockIco}>
                  <Text style={styles.stockIcoText}>{pv.icon}</Text>
                </View>
                <View style={[s.row, { marginLeft: 10 }]}>
                  <Text style={s.bold}>{pv.name}</Text>
                  <Text style={[s.tag, tagStyleOf('tag-green'), { marginLeft: 8 }]}>{pv.market}</Text>
                </View>
              </View>
              <View style={styles.alignEnd}>
                <Text style={[styles.demoDividend, s.num]}>{pv.dividend}</Text>
                <Text style={[s.tiny, s.dim]}>预测分红</Text>
              </View>
            </View>
            <View style={styles.demoMeta}>
              <Text style={styles.demoMetaCell}>持仓 {pv.shares}</Text>
              <Text style={styles.demoMetaCell}>成本 {pv.cost}</Text>
              <Text style={styles.demoMetaCell}>
                股价息率 <Text style={{ color: colors.orange }}>{pv.yield}</Text>
              </Text>
            </View>
          </View>
        </View>

        {/* 预测分红，追踪日历 */}
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.row}>
            <View style={[styles.iconBoxLg, styles.iconSoftGold]}>
              <Text style={styles.iconEmojiLg}>🔮</Text>
            </View>
            <View style={[s.flex1, { marginLeft: 12 }]}>
              <Text style={s.h3}>预测分红，追踪日历</Text>
              <Text style={[s.small, s.dim, { marginTop: 8 }]}>知道每一笔钱什么时候到账</Text>
            </View>
          </View>

          {/* 小程序是 linear-gradient(150deg, #323232, #212121)；RN 未装渐变库，取中间深色 */}
          <View style={styles.demoDark}>
            <Text style={[s.small, s.dimOnDark]}>预测年度分红</Text>
            <Text style={styles.demoDarkNum}>{pd.totalText}</Text>
            <View style={styles.demoDarkGrid}>
              <View style={styles.gridCol}>
                <Text style={[s.tiny, s.dimOnDark]}>今年已收</Text>
                <Text style={[s.mid, s.onDark, { marginTop: 8 }]}>{pd.receivedText}</Text>
              </View>
              <View style={styles.gridCol}>
                <Text style={[s.tiny, s.dimOnDark]}>综合息率</Text>
                <Text style={[s.mid, s.onDark, { marginTop: 8 }]}>{pd.yieldText}</Text>
              </View>
              <View style={styles.gridCol}>
                <Text style={[s.tiny, s.dimOnDark]}>下笔到账</Text>
                <Text style={[s.mid, styles.cGold, { marginTop: 8 }]}>{pd.nextPayText}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 用分红点亮你的生活 */}
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.row}>
            <View style={[styles.iconBoxLg, styles.iconSoftOrange]}>
              <Text style={styles.iconEmojiLg}>🎯</Text>
            </View>
            <View style={[s.flex1, { marginLeft: 12 }]}>
              <Text style={s.h3}>用分红点亮你的生活</Text>
              <Text style={[s.small, s.dim, { marginTop: 8 }]}>话费、咖啡、物业费…逐项被股息买单</Text>
            </View>
          </View>

          <View style={styles.chips}>
            {this.data.litChips.map((item) => (
              <View key={item} style={[styles.chip, styles.chipOn]}>
                <Text style={[s.small, styles.chipTextOn]}>{item}</Text>
              </View>
            ))}
            {this.data.unlitChips.map((item) => (
              <View key={item} style={styles.chip}>
                <Text style={[s.small, { color: colors.t2 }]}>{item}</Text>
              </View>
            ))}
          </View>
          <Text style={[s.tiny, s.dim]}>
            已点亮 {this.data.litCount}/{this.data.chipTotal} 项 · 下一目标：{this.data.nextChip}
          </Text>
        </View>

        {/* 复利 */}
        <View style={[s.darkCard, { marginTop: 16 }]}>
          <View style={s.row}>
            <View style={[styles.iconBox, styles.iconSoftGold]}>
              <Text style={styles.iconEmoji}>📈</Text>
            </View>
            <View style={[s.flex1, { marginLeft: 12 }]}>
              <Text style={[s.mid, s.bold, s.onDark]}>坚持 10 年，分红翻 10 倍</Text>
              <Text style={[s.tiny, s.dimOnDark, { marginTop: 8 }]}>复利模拟器，看看未来的你</Text>
            </View>
          </View>

          <View style={[s.between, { marginTop: 18 }]}>
            <View>
              <Text style={[s.tiny, s.dimOnDark]}>现在</Text>
              <Text style={[s.h3, s.onDark, { marginTop: 8 }]}>
                {cp.nowText}
                <Text style={[s.tiny, s.dimOnDark]}>年分红</Text>
              </Text>
            </View>
            <Text style={styles.scaleArrow}>→</Text>
            <View style={styles.alignEnd}>
              <Text style={[s.tiny, s.dimOnDark]}>{cp.years}年后</Text>
              <Text style={[s.h3, styles.cGold, { marginTop: 8 }]}>
                {cp.futureText}
                <Text style={[s.tiny, s.dimOnDark]}>年分红</Text>
              </Text>
            </View>
          </View>
        </View>

        <View style={[styles.warmTip, { marginTop: 16 }]}>
          <Text style={styles.warmTipText}>🍵 {this.data.tip}</Text>
        </View>

        <Pressable style={[styles.bigBtn, { marginTop: 20 }]} onPress={() => this.next()}>
          <Text style={styles.bigBtnText}>开始规划收息之路 →</Text>
        </Pressable>
        <Pressable style={styles.footLink} onPress={() => this.skip()}>
          <Text style={styles.footLinkText}>先随便看看，跳过引导</Text>
        </Pressable>
      </View>
    )
  }

  /* ---------------- 步骤二：选支出 ---------------- */

  renderExpenses() {
    return (
      <View>
        <View style={styles.stepHead}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeText}>1</Text>
          </View>
          <Text style={styles.stepTitle}>选择你的日常开销</Text>
          <Text style={styles.stepSub}>选几项你每月必花的钱，我帮你算算分红多久能帮你买单</Text>
        </View>

        <View style={styles.expGrid}>
          {this.data.expenses.map((item) => (
            <Pressable
              key={item.id}
              style={[styles.expCard, item.on ? styles.expCardOn : null]}
              onPress={() => this.toggleExpense(tap({ id: item.id }))}
            >
              <View style={s.row}>
                <View style={styles.expIcon}>
                  <Text style={styles.expIconText}>{item.icon}</Text>
                </View>
                <View style={[s.flex1, { marginLeft: 12 }]}>
                  <Text style={[s.mid, s.bold]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>
                    {item.amountText} / {item.period}
                  </Text>
                </View>
                <View style={[styles.radio, item.on ? styles.radioOn : null]}>
                  {item.on ? <Text style={styles.tick}>✓</Text> : null}
                </View>
              </View>
            </Pressable>
          ))}

          <Pressable style={[styles.expCard, styles.expCardAdd]} onPress={() => this.addCustom()}>
            <View style={s.row}>
              <View style={styles.expIcon}>
                <Text style={styles.expIconAdd}>+</Text>
              </View>
              <View style={[s.flex1, { marginLeft: 12 }]}>
                <Text style={[s.mid, s.bold, s.dim]}>自定义</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>添加你的支出项</Text>
              </View>
            </View>
          </Pressable>
        </View>
      </View>
    )
  }

  /* ---------------- 步骤三：定计划 ---------------- */

  renderPlan() {
    return (
      <View>
        <View style={styles.stepHead}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeText}>2</Text>
          </View>
          <Text style={styles.stepTitle}>说说你的投入计划</Text>
          <Text style={styles.stepSub}>手上有多少、每月能投多少，我来帮你算</Text>
        </View>

        <View style={styles.warmTip}>
          <Text style={styles.warmTipText}>
            🎯 要让分红供养你选的 {this.data.selectedCount || 8} 项开销，每年需 {this.data.targetYearText}
          </Text>
        </View>

        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.row}>
            <View style={[styles.iconBox, styles.iconSoftGreen]}>
              <Text style={styles.iconEmoji}>🧊</Text>
            </View>
            <Text style={[s.h3, { marginLeft: 12 }]}>你的投入</Text>
          </View>

          <SliderRow
            name="初始本金"
            field="principal"
            valueText={this.data.principalText}
            min={0}
            max={1000000}
            step={10000}
            value={this.data.principal}
            onSliding={(e) => this.onSliding(e)}
            onSlideEnd={(e) => this.onSlideEnd(e)}
          />

          <View style={styles.divider} />

          <SliderRow
            name="每月定投"
            field="monthly"
            valueText={this.data.monthlyText}
            min={0}
            max={20000}
            step={500}
            value={this.data.monthly}
            onSliding={(e) => this.onSliding(e)}
            onSlideEnd={(e) => this.onSlideEnd(e)}
          />

          <View style={styles.divider} />

          <SliderRow
            name="预期股息率"
            field="rate"
            valueText={this.data.rateText}
            min={1}
            max={10}
            step={0.5}
            value={this.data.rate}
            onSliding={(e) => this.onSliding(e)}
            onSlideEnd={(e) => this.onSlideEnd(e)}
          />
        </View>

        <View style={[s.darkCard, { marginTop: 16 }]}>
          <View style={s.between}>
            <View style={s.flex1}>
              <Text style={[s.mid, s.onDark]}>{this.data.coverTip}</Text>
              <Text style={[s.tiny, s.dimOnDark, { marginTop: 10 }]}>按每年分红继续买入，利滚利估算</Text>
            </View>
            <View style={styles.alignEnd}>
              <Text style={styles.pctGold}>{this.data.coverPercent}%</Text>
              <Text style={[s.tiny, s.dimOnDark]}>30年内</Text>
            </View>
          </View>
        </View>

        <Pressable style={[styles.bigBtn, { marginTop: 20 }]} onPress={() => this.enterBlueprint()}>
          <Text style={styles.bigBtnText}>看我的收息蓝图 →</Text>
        </Pressable>
        <Pressable style={styles.footLink} onPress={() => this.prev()}>
          <Text style={styles.footLinkText}>← 返回改支出</Text>
        </Pressable>
      </View>
    )
  }

  /* ---------------- 步骤四：看蓝图 ---------------- */

  renderBlueprint() {
    const foot = this.data.planFooter

    return (
      <View>
        <View style={styles.stepHead}>
          <View style={styles.stepBadge}>
            <Text style={styles.stepBadgeText}>3</Text>
          </View>
          <Text style={styles.stepTitle}>你的收息蓝图</Text>
          <Text style={styles.stepSub}>假设每年分红继续买入，利滚利估算</Text>
        </View>

        <View style={s.darkCard}>
          <View style={s.between}>
            <View>
              <Text style={[s.small, s.dimOnDark]}>按你定的计划</Text>
              <Text style={[s.tiny, s.dimOnDark, { marginTop: 6 }]}>每天前进一点点</Text>
            </View>
            <Text style={styles.pctGold}>{this.data.coverPercent}%</Text>
          </View>

          <View style={styles.dividerDark} />

          <View style={s.row}>
            <View style={[s.col, s.flex1]}>
              <Text style={[s.tiny, s.dimOnDark]}>覆盖开销</Text>
              <Text style={[s.mid, s.onDark, { marginTop: 8 }]}>
                {this.data.targetYearText}
                <Text style={[s.tiny, s.dimOnDark]}>/年</Text>
              </Text>
            </View>
            <View style={[s.col, s.flex1]}>
              <Text style={[s.tiny, s.dimOnDark]}>折合每月</Text>
              <Text style={[s.mid, s.onDark, { marginTop: 8 }]}>
                {this.data.targetMonthText}
                <Text style={[s.tiny, s.dimOnDark]}>/月</Text>
              </Text>
            </View>
            <View style={[s.col, s.flex1, styles.alignEnd]}>
              <Text style={[s.tiny, s.dimOnDark]}>届时总资产</Text>
              <Text style={[s.mid, s.onDark, { marginTop: 8 }]}>{this.data.finalAssetsText}</Text>
            </View>
          </View>
        </View>

        {/* 逐年资产与分红 */}
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.row}>
            <View style={[styles.iconBox, styles.iconSoftGreen]}>
              <Text style={styles.iconEmoji}>📈</Text>
            </View>
            <View style={[s.flex1, { marginLeft: 12 }]}>
              <Text style={s.h3}>逐年资产与分红</Text>
              <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>每年定投 + 分红再投，资产滚雪球的过程</Text>
            </View>
          </View>

          <View style={styles.yearRows}>
            {this.data.blueprintVisible.map((item) => (
              <View key={item.year} style={styles.yearRow}>
                <View style={styles.yearBadge}>
                  <Text style={styles.yearBadgeText}>{item.year}年</Text>
                </View>
                <View style={[s.flex1, { marginLeft: 12 }]}>
                  <Text style={[s.mid, s.num]}>{item.totalText}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{item.label}</Text>
                </View>
                <View style={styles.alignEnd}>
                  <Text style={[s.mid, s.num]}>{item.dividendText}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>当年分红</Text>
                </View>
              </View>
            ))}
          </View>

          <Pressable style={styles.more} onPress={() => this.toggleAllYears()}>
            <Text style={styles.moreText}>{this.data.showAllYears ? '收起' : '展开全部 30 年'}</Text>
            <Text style={styles.chev}>{this.data.showAllYears ? '︿' : '﹀'}</Text>
          </Pressable>
        </View>

        {/* 时间线 */}
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.row}>
            <View style={[styles.iconBox, styles.iconSoftGold]}>
              <Text style={styles.iconEmoji}>🏷</Text>
            </View>
            <View style={[s.flex1, { marginLeft: 12 }]}>
              <Text style={s.h3}>开销逐项被买单的时间线</Text>
              <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>
                本金 {foot.principalText} · 月投 {foot.monthlyText} · 息率 {foot.rateText} · 分红继续买入
              </Text>
            </View>
          </View>

          <View style={styles.tlRows}>
            {this.data.timeline.map((item) => (
              <View key={item.id} style={styles.tlRow}>
                <View style={styles.expIcon}>
                  <Text style={styles.expIconText}>{item.icon}</Text>
                </View>
                <View style={[s.flex1, { marginLeft: 12 }]}>
                  <Text style={[s.mid, s.bold]}>{item.name}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{item.needText} / 年</Text>
                </View>
                <Text style={[s.tiny, item.done ? styles.yearDone : s.dim]}>{item.yearText}</Text>
              </View>
            ))}
          </View>
        </View>

        <Pressable
          style={[styles.bigBtn, this.data.submitting ? styles.bigBtnOff : null, { marginTop: 20 }]}
          onPress={() => this.finish()}
          disabled={!!this.data.submitting}
        >
          <Text style={styles.bigBtnText}>{this.data.submitting ? '生成中…' : '开始收息之路 →'}</Text>
        </Pressable>
        <Pressable style={styles.footLink} onPress={() => this.prev()}>
          <Text style={styles.footLinkText}>← 返回调整计划</Text>
        </Pressable>
      </View>
    )
  }

  /* ---------------- 自定义支出面板 ---------------- */

  renderAddSheet() {
    const f = this.data.addForm

    return (
      <View style={styles.sheetMask}>
        <Pressable style={StyleSheet.absoluteFillObject} onPress={() => this.closeAdd()} />
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>自定义支出</Text>

          <View style={styles.fRow}>
            <Text style={styles.fLabel}>名称</Text>
            <TextInput
              style={[s.input, s.flex1]}
              value={f.name}
              onChangeText={(v) => this.onAddInput(Object.assign(tap({ field: 'name' }), val(v)))}
              placeholder="如 宠物粮"
              placeholderTextColor={colors.t3}
            />
          </View>

          <View style={styles.fRow}>
            <Text style={styles.fLabel}>每月金额</Text>
            <TextInput
              style={[s.input, s.flex1]}
              value={String(f.amount)}
              onChangeText={(v) => this.onAddInput(Object.assign(tap({ field: 'amount' }), val(v)))}
              keyboardType="decimal-pad"
              placeholder="人民币元"
              placeholderTextColor={colors.t3}
            />
          </View>

          <View style={[styles.fRow, styles.fCol]}>
            <Text style={styles.fLabel}>图标</Text>
            <View style={styles.chips}>
              {this.data.iconOptions.map((item) => (
                <Pressable
                  key={item}
                  style={[styles.chip, styles.iconChip, f.icon === item ? styles.chipOn : null]}
                  onPress={() => this.onPickIcon(tap({ icon: item }))}
                >
                  <Text style={styles.iconChipText}>{item}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* 小程序是 linear-gradient(90deg, #2FB57E, #1F9D6B)；RN 未装渐变库，取主色 */}
          <Pressable style={styles.sheetBtn} onPress={() => this.onSubmitAdd()}>
            <Text style={styles.sheetBtnText}>确定</Text>
          </Pressable>
          <Pressable style={styles.sheetCancel} onPress={() => this.closeAdd()}>
            <Text style={styles.sheetCancelText}>取消</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  render() {
    const step = this.data.step

    return (
      <View style={s.page}>
        {this.renderHead()}

        <ScrollView
          ref={(r) => (this.scrollRef = r)}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
        >
          {this.data.loading ? this.renderLoading() : null}
          {!this.data.loading && step === 0 ? this.renderIntro() : null}
          {!this.data.loading && step === 1 ? this.renderExpenses() : null}
          {!this.data.loading && step === 2 ? this.renderPlan() : null}
          {!this.data.loading && step === 3 ? this.renderBlueprint() : null}
        </ScrollView>

        {/* 步骤二底部固定操作条 */}
        {step === 1 ? (
          <View style={styles.bottomBar}>
            <View style={s.flex1}>
              <Text style={[s.tiny, s.dim]}>已选支出合计</Text>
              <Text style={[s.h3, s.num]}>
                {this.data.yearTotalText}
                <Text style={[s.tiny, s.dim]}>/年</Text>
              </Text>
            </View>
            <Pressable
              style={[styles.nextBtn, this.data.selectedCount === 0 ? styles.nextBtnOff : null]}
              onPress={() => this.next()}
            >
              <Text style={styles.nextBtnText}>下一步：定计划 →</Text>
            </Pressable>
          </View>
        ) : null}

        {/* 自定义支出：RN 的 showModal 不支持输入，自己画一个底部面板 */}
        <Modal visible={this.data.addOpen} transparent animationType="slide" onRequestClose={() => this.closeAdd()}>
          {this.renderAddSheet()}
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  /* 固定头部 */
  head: {
    paddingTop: 10,
    paddingHorizontal: 16,
    backgroundColor: colors.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  skipBtn: { alignSelf: 'flex-end', paddingVertical: 6, paddingHorizontal: 4 },
  skipText: { fontSize: 12.5, color: colors.t3 },
  tabs: { flexDirection: 'row', alignItems: 'flex-end' },
  tab: { flex: 1, alignItems: 'center', paddingBottom: 8 },
  tabText: { fontSize: 14, color: colors.t3 },
  tabTextOn: { fontSize: 16, fontWeight: '700', color: colors.t1 },
  tabLine: { marginTop: 6, width: 0, height: 3, borderRadius: 3, backgroundColor: colors.t1 },
  tabLineOn: { width: 20 },

  /* 加载中 */
  empty: { alignItems: 'center', paddingTop: 80 },
  emptyEmoji: { fontSize: 40 },
  emptyTitle: { marginTop: 12, fontSize: 14, color: colors.t2 },

  /* Hero */
  hero: { alignItems: 'center', paddingVertical: 20 },
  heroLogo: { fontSize: 56 },
  heroName: { marginTop: 10, fontSize: 26, fontWeight: '700', letterSpacing: 4, color: colors.t1 },
  heroSub: { marginTop: 6, fontSize: 13.5, color: colors.t2 },
  heroSlogan: { marginTop: 8, fontSize: 13, color: colors.up },

  /* 图标盒子（wxss 的 icon-box / icon-box-lg + icon-soft-*） */
  iconBox: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  iconBoxLg: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  iconEmoji: { fontSize: 16 },
  iconEmojiLg: { fontSize: 20 },
  iconSoftGreen: { backgroundColor: 'rgba(31, 157, 107, 0.12)' },
  iconSoftGold: { backgroundColor: 'rgba(201, 162, 39, 0.16)' },
  iconSoftOrange: { backgroundColor: 'rgba(240, 154, 60, 0.16)' },

  /* 示例持仓 */
  demo: { marginTop: 16, backgroundColor: '#F7F9F8', borderRadius: 12, padding: 14 },
  stockIco: {
    width: 28,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#E9EDEB',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stockIcoText: { fontSize: 14, color: colors.t2 },
  demoDividend: { fontSize: 16, fontWeight: '700', color: colors.orange },
  alignEnd: { alignItems: 'flex-end' },
  demoMeta: {
    flexDirection: 'row',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#EAEEEC'
  },
  demoMetaCell: { flex: 1, fontSize: 11, color: colors.t2 },

  /* 深色演示块（原 linear-gradient(150deg,#323232,#212121) → colors.dark） */
  demoDark: { marginTop: 16, backgroundColor: colors.dark, borderRadius: 14, padding: 16 },
  demoDarkNum: {
    marginTop: 4,
    fontSize: 28,
    fontWeight: '700',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums']
  },
  demoDarkGrid: {
    flexDirection: 'row',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)'
  },
  gridCol: { flex: 1 },
  cGold: { color: colors.gold },
  scaleArrow: { paddingHorizontal: 10, fontSize: 16, color: 'rgba(255,255,255,0.5)' },

  /* chips */
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 14 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#F4F6F5',
    marginRight: 8,
    marginBottom: 8
  },
  chipOn: { backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: 'rgba(31, 157, 107, 0.35)' },
  chipTextOn: { color: colors.primary, fontWeight: '600' },
  iconChip: { paddingHorizontal: 10 },
  iconChipText: { fontSize: 16 },

  /* 暖色提示条 */
  warmTip: { backgroundColor: colors.warm, borderRadius: 12, padding: 12 },
  warmTipText: { fontSize: 12, lineHeight: 18, color: '#8A6A3A' },

  /* 通用按钮 */
  bigBtn: { height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.dark },
  bigBtnOff: { backgroundColor: '#C9CFCC' },
  bigBtnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  footLink: { alignItems: 'center', paddingVertical: 16 },
  footLinkText: { fontSize: 12.5, color: colors.t3 },

  /* 步骤标题 */
  stepHead: { paddingBottom: 16 },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#232323',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepBadgeText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
  stepTitle: { marginTop: 10, fontSize: 22, fontWeight: '700', color: colors.t1 },
  stepSub: { marginTop: 8, fontSize: 13, lineHeight: 20, color: colors.t2 },

  /* 支出网格（wxss 的 48.5% 两列） */
  expGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  expCard: {
    width: '48.5%',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1.5,
    borderColor: 'transparent'
  },
  expCardOn: { borderColor: colors.primary },
  expCardAdd: { backgroundColor: 'transparent', borderStyle: 'dashed', borderColor: '#D6DCD9' },
  expIcon: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: '#F4F6F5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  expIconText: { fontSize: 16 },
  expIconAdd: { fontSize: 18, fontWeight: '300', color: colors.t3 },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1.5,
    borderColor: '#D6DCD9',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  radioOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  tick: { color: '#FFFFFF', fontSize: 11, lineHeight: 13 },

  /* 滑块 */
  slRow: { paddingTop: 16 },
  slName: { fontSize: 14, color: colors.t1 },
  slVal: { fontSize: 16, fontWeight: '700', color: colors.primary },
  slider: { width: '100%', height: 32, marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginTop: 6 },
  dividerDark: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginVertical: 14
  },

  /* 深色卡片百分比 */
  pctGold: { fontSize: 32, fontWeight: '700', color: colors.gold, fontVariant: ['tabular-nums'], lineHeight: 38 },

  /* 逐年行 */
  yearRows: { marginTop: 10 },
  yearRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  yearBadge: {
    width: 40,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#F4F6F5',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  yearBadgeText: { fontSize: 12, color: colors.t2 },
  more: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },
  moreText: { fontSize: 12.5, color: colors.t3, lineHeight: 16 },
  chev: { marginLeft: 6, fontSize: 12, color: colors.t3 },

  /* 时间线 */
  tlRows: { marginTop: 10 },
  tlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  yearDone: { color: colors.primary, fontWeight: '700' },

  /* 底部固定条 */
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  },
  nextBtn: { paddingHorizontal: 18, paddingVertical: 11, borderRadius: 24, backgroundColor: colors.dark },
  nextBtnOff: { backgroundColor: '#E5E8E7' },
  nextBtnText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },

  /* 自定义支出面板 */
  sheetMask: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingBottom: 20
  },
  sheetTitle: { paddingVertical: 16, textAlign: 'center', fontSize: 15, fontWeight: '600', color: colors.t1 },
  fRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },
  fCol: { flexDirection: 'column', alignItems: 'flex-start' },
  fLabel: { width: 90, fontSize: 13.5, color: colors.t2, flexShrink: 0 },
  sheetBtn: { marginTop: 16, paddingVertical: 14, alignItems: 'center', borderRadius: 12, backgroundColor: colors.primary },
  sheetBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  sheetCancel: { marginTop: 8, paddingVertical: 12, alignItems: 'center' },
  sheetCancelText: { fontSize: 14, color: colors.t2 }
})

module.exports = Onboarding

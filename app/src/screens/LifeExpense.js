const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

// 图标每行几个。
const ICONS_PER_ROW = 6

// 图标边长（固定值，不随容器缩放）。
//
// 为什么不用「宽度百分比」那套：那样色块尺寸 = 容器宽 / 6 − 间距，
// 于是同一个图标在不同屏宽上大小不一 —— 而图标是**内容**，内容的尺寸
// 不该随版心变化，否则窄屏上挤、宽屏上散。
//
// 固定尺寸后就靠**间距**的吸收能力来对齐两边：每行用 space-between，
// 6 个固定宽的图标把剩余空间均分成 5 段间隙。这样图标永远一样大，
// 而整行左右两边又正好压住输入框的边界。
const ICON_SIZE = 44

// 按每行 N 个把图标切成若干行。
//
// 用 space-between 就必须逐行成组 —— 直接在一个 flexWrap 容器里用它，
// 最后一行不满时会被拉开成"首尾贴边、中间散开"，非常难看。
const chunk = (list, size) => {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/** 生活支出：编辑每月金额 → 算出每年合计，用来对齐「分红覆盖生活支出」。 */
class LifeExpense extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      submitting: false,
      expenses: [],
      count: 0,
      monthText: '0',
      yearText: '0',

      showAdd: false,
      addForm: { name: '', amount: '', icon: '📌' },
      icons: { life: [], travel: [] }
    }
  }

  onLoad() {
    this.load()
  }

  load() {
    return api
      .getExpenses()
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          expenses: d.list,
          count: d.count,
          monthText: d.monthText,
          yearText: d.yearText,
          icons: d.icons
        })
      })
      .catch(util.onError)
  }

  /* ================= 编辑金额 ================= */

  onAmountInput(e) {
    const id = e.currentTarget.dataset.id
    // 每月金额：两位小数够用（记账到分）
    const v = validate.decimal(e.detail.value, { decimals: 2 })
    const expenses = this.data.expenses.map((i) =>
      i.id === id ? Object.assign({}, i, { amount: v }) : i
    )
    this.setData({ expenses: expenses })
    this.refreshStat()
  }

  // 失焦时才落库，避免每次按键都写存储
  onAmountBlur() {
    this.persist()
  }

  refreshStat() {
    const year = this.data.expenses.reduce((sum, i) => sum + (Number(i.amount) || 0) * 12, 0)
    this.setData({
      count: this.data.expenses.length,
      yearText: api.moneyText(year, 0),
      monthText: api.moneyText(year / 12, 0)
    })
  }

  persist() {
    return api.saveExpenses(this.data.expenses).catch(util.onError)
  }

  /* ================= 删除 ================= */

  onRemove(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.expenses.filter((i) => i.id === id)[0]
    if (!item) return

    wx.showModal({
      title: '删除支出',
      content: '确定删除「' + item.name + '」吗？',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.removeExpense(id), { loadingText: '删除中', key: 'submitting' })
          .then((r) => {
            if (!r) return
            this.setData({
              expenses: r.data.list,
              count: r.data.count,
              monthText: r.data.monthText,
              yearText: r.data.yearText
            })
          })
      }
    })
  }

  /* ================= 添加自定义支出 ================= */

  openAdd() {
    if (this.data.submitting) return
    this.setData({
      showAdd: true,
      addForm: { name: '', amount: '', icon: this.data.icons.life[0] || '📌' }
    })
  }

  closeAdd() {
    this.setData({ showAdd: false })
  }

  onAddInput(e) {
    const key = e.currentTarget.dataset.key
    const raw = e.detail.value
    // 名称是文本、每月金额是数字，两个入口共用一个处理函数
    const v = key === 'amount' ? validate.decimal(raw, { decimals: 2 }) : validate.plain(raw, { max: 12 })
    this.setData({ addForm: Object.assign({}, this.data.addForm, { [key]: v }) })
  }

  pickIcon(icon) {
    this.setData({ addForm: Object.assign({}, this.data.addForm, { icon: icon }) })
  }

  confirmAdd() {
    const f = this.data.addForm

    // 原先没有任何校验：名称空着、金额为 0 或负数都能提交，
    // 存进去之后「分红覆盖生活支出」的分母就失真了
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
      .submit(this, api.addCustomExpense({ name: f.name, amount: f.amount, icon: f.icon }), {
        loadingText: '添加中',
        success: '已添加',
        key: 'submitting'
      })
      .then((res) => {
        if (!res) return
        this.setData({
          showAdd: false,
          expenses: res.data.list,
          count: res.data.count,
          monthText: res.data.monthText,
          yearText: res.data.yearText
        })
      })
  }

  /* ================= 排序 / 跳转 ================= */

  onSort() {
    const list = this.data.expenses
      .slice()
      .sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))
    this.setData({ expenses: list })
    this.persist()
    wx.showToast({ title: '已按金额从高到低排序', icon: 'none' })
  }

  /**
   * 底部「确认」：存下改动并返回上一页。
   *
   * 原来这里叫 goCoverage，文案是「看看分红能覆盖多少」，点了会 redirectTo 到
   * 覆盖页。两处都不对：
   *
   *   1) **与页面职责不符**。本页是「编辑每月支出」，用户改完金额点底部按钮，
   *      预期就是「确认」。跳去另一个页面是答非所问。
   *   2) **redirectTo 会替换掉当前页**。它把这一页从栈里换掉，用户再按返回
   *      就回不到来处了 —— 而从齿轮进来的人，来处正是分红覆盖页。
   *
   * 想去分红覆盖页本来就有两条自然的路：从齿轮进来时按返回即可回到那里；
   * 或在首页直接点分红覆盖卡片。不需要在这里再架一条。
   */
  submit() {
    this.persist().then(() => util.back())
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={[s.mid, s.dim]}>加载中…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {/* 汇总 */}
          <View style={s.darkCard}>
            <View style={s.between}>
              <View>
                <Text style={[s.tiny, s.dimOnDark]}>每月支出</Text>
                <Text style={styles.sumNum}>{this.data.monthText}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.tiny, s.dimOnDark]}>每年支出</Text>
                <Text style={styles.sumNum}>{this.data.yearText}</Text>
              </View>
            </View>
            <Text style={[s.tiny, s.dimOnDark, { marginTop: 12 }]}>
              共 {this.data.count} 项 · 分红覆盖到这些支出，就算「息养生活」
            </Text>
          </View>

          <View style={[s.between, { marginTop: 20, marginBottom: 10 }]}>
            <Text style={s.h3}>支出项</Text>
            <View style={s.row}>
              <Pressable style={s.mini} onPress={() => this.onSort()}>
                <Text style={[s.small, { fontSize: 13 }]}>按金额排序</Text>
              </Pressable>
              <Pressable style={[s.mini, { marginLeft: 10 }]} onPress={() => this.openAdd()}>
                <Text style={[s.small, { fontSize: 13, color: colors.primary }]}>＋ 自定义</Text>
              </Pressable>
            </View>
          </View>

          <View style={s.card}>
            {this.data.expenses.map((item, i) => (
              <View key={item.id} style={[styles.row, i ? styles.rowLine : null]}>
                <Text style={styles.icon}>{item.icon}</Text>
                <View style={s.flex1}>
                  <Text style={s.mid}>{item.name}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>每月</Text>
                </View>
                <TextInput
                  style={styles.amountInput}
                  value={String(item.amount)}
                  onChangeText={(v) => this.onAmountInput(Object.assign(tap({ id: item.id }), val(v)))}
                  onBlur={() => this.onAmountBlur()}
                  keyboardType="decimal-pad"
                  placeholderTextColor={colors.t3}
                />
                <Pressable onPress={() => this.onRemove(tap({ id: item.id }))} style={{ paddingLeft: 10 }}>
                  <Text style={{ fontSize: 12, color: colors.up }}>删除</Text>
                </Pressable>
              </View>
            ))}

            {!this.data.expenses.length ? (
              <Text style={[s.small, s.dim, { paddingVertical: 20, textAlign: 'center' }]}>
                还没有支出项，点右上「＋ 自定义」加一个
              </Text>
            ) : null}
          </View>

          <Pressable style={[s.btn, { marginTop: 20 }]} onPress={() => this.submit()}>
            <Text style={s.btnText}>确认</Text>
          </Pressable>
        </ScrollView>

        {/* 添加自定义支出 */}
        {this.data.showAdd ? (
          <View style={styles.overlay}>
            <View style={styles.dialog}>
              <Text style={s.h3}>自定义支出</Text>

              <TextInput
                style={[s.input, { marginTop: 14 }]}
                value={this.data.addForm.name}
                onChangeText={(v) => this.onAddInput(Object.assign(tap({ key: 'name' }), val(v)))}
                placeholder="名称，如「健身房」"
                placeholderTextColor={colors.t3}
              />
              <TextInput
                style={[s.input, { marginTop: 10 }]}
                value={String(this.data.addForm.amount)}
                onChangeText={(v) => this.onAddInput(Object.assign(tap({ key: 'amount' }), val(v)))}
                keyboardType="decimal-pad"
                placeholder="每月金额"
                placeholderTextColor={colors.t3}
              />

              <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>图标</Text>
              <ScrollView style={styles.iconScroll} nestedScrollEnabled>
                {chunk(this.data.icons.life || [], ICONS_PER_ROW).map((row, ri) => (
                  <View
                    key={ri}
                    style={[styles.iconLine, row.length < ICONS_PER_ROW ? styles.iconLineStart : null]}
                  >
                    {row.map((ic) => (
                      <Pressable
                        key={ic}
                        style={styles.iconCell}
                        onPress={() => this.pickIcon(ic)}
                      >
                        <View style={[styles.iconChip, this.data.addForm.icon === ic ? styles.iconChipOn : null]}>
                          <Text style={{ fontSize: 18 }}>{ic}</Text>
                        </View>
                      </Pressable>
                    ))}
                  </View>
                ))}
              </ScrollView>

              <View style={[s.row, { marginTop: 20 }]}>
                <Pressable
                  style={[s.btn, s.flex1, { backgroundColor: colors.line2 }]}
                  onPress={() => this.closeAdd()}
                >
                  <Text style={[s.btnText, { color: colors.t2 }]}>取消</Text>
                </Pressable>
                <View style={{ width: 12 }} />
                <Pressable style={[s.btn, s.flex1]} onPress={() => this.confirmAdd()}>
                  <Text style={s.btnText}>添加</Text>
                </Pressable>
              </View>
            </View>
          </View>
        ) : null}
      </View>
    )
  }
}

const styles = StyleSheet.create({
  sumNum: { marginTop: 8, fontSize: 26, fontWeight: '700', color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  icon: { fontSize: 18, marginRight: 12 },
  amountInput: {
    width: 96,
    height: 40,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: colors.line2,
    fontSize: 15,
    color: colors.t1,
    textAlign: 'right'
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24
  },
  dialog: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20 },
  // 图标池现在有 50 多个，全铺开会把弹窗撑得比屏幕还高（按钮被顶出去）。
  // 限高 + 内部滚动：一次能看三行半，够挑也不会盖住下面的输入与按钮。
  iconScroll: { maxHeight: 184, marginTop: 10 },

  // 每行：固定尺寸的图标 + space-between 分配间隙。
  //
  // 两端对齐能把整行拉满内容区宽 —— 于是图标区左右边界与上面的输入框一致，
  // 而每个图标本身仍然是 ICON_SIZE 的正方形，不随屏宽伸缩。
  // 间隙是算出来的（剩余空间 / 5），不是写死的，所以各种屏宽下都成立。
  iconLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  // 最后一行不满 6 个时不能再用 space-between —— 那会把仅有的几个图标
  // 拉成"首尾贴边、中间散开"。改成靠左依次排，间距与上面几行一致。
  iconLineStart: { justifyContent: 'flex-start' },

  iconCell: { width: ICON_SIZE, height: ICON_SIZE },
  iconChip: {
    flex: 1,
    borderRadius: 10,
    backgroundColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  iconChipOn: { backgroundColor: colors.primarySoft }
})

module.exports = LifeExpense

const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const DateField = require('../components/DateField.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

// 交易类型：与参考图一致，顺序即展示顺序
const TRADE_TYPES = ['买入', '卖出', '送股', '分红复投']

function today() {
  const d = new Date()
  return d.getFullYear() + '-' + util.pad(d.getMonth() + 1) + '-' + util.pad(d.getDate())
}

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

/** 添加交易。逻辑与小程序一致，只是日期从 picker 换成了文本输入（见下方注释）。 */
class AddTrade extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      submitting: false,

      holding: null,

      types: TRADE_TYPES,
      typeIndex: 0,
      typeName: TRADE_TYPES[0],

      date: '',
      shares: '',
      price: '',
      fee: '',
      // 当时的想法：清仓那笔尤其重要（见 confirm 里的提醒）
      note: ''
    }
  }

  onLoad(options) {
    this.holdingId = (options && options.id) || ''
    this.setData({ date: today() })

    if (!this.holdingId) {
      util.onError({ msg: '缺少持仓信息' })
      this.setData({ loading: false })
      util.backLater(this, 800)
      return
    }

    api
      .getHolding(this.holdingId)
      .then((res) => this.setData({ loading: false, holding: res.data }))
      .catch((e) => {
        util.onError(e)
        this.setData({ loading: false })
        util.backLater(this, 800)
      })
  }

  onUnload() {
    util.cancelBack(this)
  }

  /* ---------------- 表单 ---------------- */

  onType(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ typeIndex: i, typeName: this.data.types[i] })
  }

  onDate(e) {
    this.setData({ date: e.detail.value })
  }

  // 想法是自由文本，能写长文：上限取 api.MEMO_MAX，与提交侧的 clip 共用同一个数，
  // 免得出现「打得进、存不下」。
  // multiline：框本来就是多行的，不保留换行的话用户分的段会被压平。
  onNote(e) {
    this.setData({ note: validate.plain(e.detail.value, { max: api.MEMO_MAX, multiline: true }) })
  }

  // 这笔是否会把持仓卖光 —— 卖光就是清仓，归档会在提交后自动发生
  willClear() {
    const d = this.data
    const h = this.data.holding || {}
    if (d.types[d.typeIndex] !== '卖出') return false
    const n = Number(d.shares) || 0
    return n > 0 && n >= (Number(h.shares) || 0)
  }

  onInput(e) {
    const field = e.currentTarget.dataset.field
    // 本页三个输入框（数量、成交价、手续费）都是数字，负数不成立
    const patch = {}
    patch[field] = validate.decimal(e.detail.value, { decimals: 4 })
    this.setData(patch)
  }

  confirm() {
    const d = this.data
    const shares = Number(d.shares)
    const price = Number(d.price)

    if (!(shares > 0)) {
      wx.showToast({ title: '请填写正确的数量', icon: 'none' })
      return
    }
    // 价格允许为 0（送股这类没有成交价），但不能是空或非法值
    if (String(d.price).trim() === '' || isNaN(price) || price < 0) {
      wx.showToast({ title: '请填写正确的价格', icon: 'none' })
      return
    }
    // 手续费可留空，填了就不能是负数
    const feeErr = validate.checkNum(d.fee, { optional: true, min: 0 }, '手续费')
    if (feeErr) {
      wx.showToast({ title: feeErr, icon: 'none' })
      return
    }

    // 清仓这笔最值得留下理由：以后回看时「为什么卖」比「卖在什么价」有用得多。
    // 没写就先问一次 —— 但不强制，用户完全可以选「直接清仓」。
    if (this.willClear() && !String(d.note || '').trim()) {
      wx.showModal({
        title: '这笔会清仓',
        content:
          '卖出后股数归零，它会移到「我的 → 投资档案」（流水都留着，随时能回看）。' +
          '建议写一句为什么卖 —— 过段时间再翻，这句最有用。',
        confirmText: '直接清仓',
        cancelText: '去写一句',
        success: (res) => {
          if (res.confirm) this.submit()
        }
      })
      return
    }

    this.submit()
  }

  submit() {
    const d = this.data
    util
      .submit(
        this,
        api.addTradeRecord(this.holdingId, {
          date: d.date,
          type: d.types[d.typeIndex],
          shares: Number(d.shares),
          price: Number(d.price),
          fee: Number(d.fee) || 0,
          note: d.note
        }),
        { loadingText: '保存中', success: '已记录' }
      )
      .then((res) => {
        if (!res) return
        util.backLater(this, 700)
      })
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={[s.mid, s.dim]}>加载中…</Text>
        </View>
      )
    }

    const h = this.data.holding || {}

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {/* 持仓头：确认给哪只记 */}
          <View style={s.card}>
            <View style={s.row}>
              <Text style={{ fontSize: 16 }}>{h.icon}</Text>
              <Text style={[s.bold, { marginLeft: 8 }]}>{h.name}</Text>
              <Text style={[s.tag, styles.marketTag, { marginLeft: 8 }]}>{h.marketTag}</Text>
            </View>
            <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>
              {h.code} · 当前持有 {h.sharesText}
            </Text>
          </View>

          {/* 交易类型 */}
          <Text style={styles.secTitle}>交易类型</Text>
          <View style={s.card}>
            <View style={styles.pillRow}>
              {this.data.types.map((t, i) => (
                <Pressable
                  key={t}
                  style={[styles.pill, i === this.data.typeIndex ? styles.pillOn : null]}
                  onPress={() => this.onType(tap({ i: i }))}
                >
                  <Text style={[s.small, i === this.data.typeIndex ? styles.pillTextOn : null]}>{t}</Text>
                </Pressable>
              ))}
            </View>

            <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>成交日期</Text>
            {/* 原生滚轮日期选择器（组件自带「今天」） */}
            <DateField
              value={String(this.data.date)}
              placeholder="选择成交日期"
              onChange={(v) => this.onDate(val(v))}
            />

            <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>数量（股）</Text>
            <TextInput
              style={[s.input, { marginTop: 8 }]}
              value={String(this.data.shares)}
              onChangeText={(v) => this.onInput(Object.assign(tap({ field: 'shares' }), val(v)))}
              keyboardType="decimal-pad"
              placeholder="1000"
              placeholderTextColor={colors.t3}
            />

            <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>
              成交价（每股，送股可填 0，{((this.data.holding || {}).nativeCurrencyName) || ''}）
            </Text>
            <TextInput
              style={[s.input, { marginTop: 8 }]}
              value={String(this.data.price)}
              onChangeText={(v) => this.onInput(Object.assign(tap({ field: 'price' }), val(v)))}
              keyboardType="decimal-pad"
              placeholder="5.92"
              placeholderTextColor={colors.t3}
            />

            <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>手续费（可选）</Text>
            <TextInput
              style={[s.input, { marginTop: 8 }]}
              value={String(this.data.fee)}
              onChangeText={(v) => this.onInput(Object.assign(tap({ field: 'fee' }), val(v)))}
              keyboardType="decimal-pad"
              placeholder="5"
              placeholderTextColor={colors.t3}
            />

            {/* 当时的想法：这是给未来的自己看的，值得单独占一块地方 */}
            <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>当时的想法（可选）</Text>
            <TextInput
              style={[s.input, styles.noteInput, { marginTop: 8 }]}
              value={String(this.data.note)}
              onChangeText={(v) => this.onNote(val(v))}
              placeholder="为什么做这笔操作？例如：股息率跌破 3%，换到更便宜的标的"
              placeholderTextColor={colors.t3}
              multiline
              textAlignVertical="top"
            />
            {this.willClear() ? (
              <Text style={[s.tiny, styles.clearTip, { marginTop: 8 }]}>
                ⚠️ 这笔会清仓 —— 提交后它会移到「我的 → 投资档案」
              </Text>
            ) : null}
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>

        <View style={styles.bottomBar}>
          <Pressable style={[s.btn, s.flex1]} onPress={() => this.confirm()}>
            <Text style={s.btnText}>保存这笔交易</Text>
          </Pressable>
        </View>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  marketTag: { backgroundColor: colors.line2, color: colors.t2 },
  // 多行输入：给足高度，并且顶部对齐（否则光标会飘在中间）。
  // 高度按「能写长文」给 —— 只露三四行的话，写复盘时会一直在小窗口里滚。
  noteInput: { height: 132, paddingTop: 10, lineHeight: 20 },
  clearTip: { color: '#E0892C' },
  secTitle: { marginTop: 20, marginBottom: 10, fontSize: 15, fontWeight: '600', color: colors.t1 },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 6 },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.line2,
    marginRight: 8,
    marginBottom: 8
  },
  pillOn: { backgroundColor: colors.primarySoft },
  pillTextOn: { color: colors.primary, fontWeight: '600' },
  todayBtn: {
    marginLeft: 10,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  },
  bottomBar: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  }
})

module.exports = AddTrade

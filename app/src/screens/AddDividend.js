const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const DateField = require('../components/DateField.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

// 各市场对红利税的默认口径不同，提示文案跟着市场走
const TAX_TIPS = {
  A: 'A 股分红默认全额到账，如实际被扣税可手动填写',
  ETF: '境内基金分红默认全额到账，如实际被扣税可手动填写',
  FUND: '境内基金分红默认全额到账，如实际被扣税可手动填写',
  HK: '港股红利税通常在派息时已按约 28% 预扣，如仍被额外扣税可手动填写',
  US: '美股股息税通常在派息时已预扣，如仍被额外扣税可手动填写'
}

function today() {
  const d = new Date()
  return d.getFullYear() + '-' + util.pad(d.getMonth() + 1) + '-' + util.pad(d.getDate())
}

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

/** 添加分红到账记录。金额默认按「股数 × 每股派息 − 红利税」现算，手改过就以手填为准。 */
class AddDividend extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      submitting: false,

      holding: null,
      taxTip: TAX_TIPS.A,

      date: '',
      shares: '',
      dps: '',
      tax: '',
      amount: ''
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
      .then((res) => {
        const h = res.data
        this.setData({
          loading: false,
          holding: h,
          taxTip: TAX_TIPS[h.market] || TAX_TIPS.A,
          // 默认带上当前持仓数量，多数情况一次分红就是这个数
          shares: String(h.shares || '')
        })
        this.syncAmount()
      })
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

  onDate(e) {
    this.setData({ date: e.detail.value })
  }

  onInput(e) {
    const field = e.currentTarget.dataset.field
    // 持股数量、每股派息、红利税都是数字
    const patch = {}
    patch[field] = validate.decimal(e.detail.value, { decimals: 4 })
    this.setData(patch)
    this.syncAmount()
  }

  // 手动改过金额就以用户的为准；清空则恢复自动计算
  onAmount(e) {
    const v = validate.decimal(e.detail.value, { decimals: 2 })
    this.amountTouched = String(v).trim() !== ''
    this.setData({ amount: v })
    if (!this.amountTouched) this.syncAmount()
  }

  computeAmount() {
    const d = this.data
    return (Number(d.shares) || 0) * (Number(d.dps) || 0) - (Number(d.tax) || 0)
  }

  syncAmount() {
    if (this.amountTouched) return
    const v = this.computeAmount()
    this.setData({ amount: v > 0 ? util.money(v, 2) : '' })
  }

  onTaxHelp() {
    wx.showModal({
      title: '红利税',
      content:
        '分红所得被扣缴的税款。A 股按持股期限差别化征收（持股越久税率越低，超过一年免征），港股通一般按 20%～28% 预扣。实际被扣多少就填多少，留空视为全额到账。',
      showCancel: false
    })
  }

  confirm() {
    const d = this.data
    const shares = Number(d.shares)
    const dps = Number(d.dps)
    const amount = Number(d.amount)

    if (!d.date) {
      wx.showToast({ title: '请填写红利入账日期', icon: 'none' })
      return
    }
    if (!(shares > 0)) {
      wx.showToast({ title: '请填写持仓数量', icon: 'none' })
      return
    }
    if (!(dps > 0)) {
      wx.showToast({ title: '请填写每股派息', icon: 'none' })
      return
    }
    if (!(amount > 0)) {
      wx.showToast({ title: '请填写实际到账金额', icon: 'none' })
      return
    }
    // 红利税可留空，但不能为负，也不该超过毛股息（否则到账金额反而变大）
    const taxErr = validate.checkNum(d.tax, { optional: true, min: 0, max: shares * dps }, '红利税')
    if (taxErr) {
      wx.showToast({ title: taxErr, icon: 'none' })
      return
    }

    util
      .submit(
        this,
        api.addDividendRecord(this.holdingId, {
          date: d.date,
          shares: shares,
          dps: dps,
          tax: Number(d.tax) || 0,
          amount: amount
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

          <Text style={styles.secTitle}>到账信息</Text>
          <View style={s.card}>
            <Text style={[s.tiny, s.dim]}>红利入账日期</Text>
            {/* 原生滚轮日期选择器（组件自带「今天」） */}
            <DateField
              value={String(this.data.date)}
              placeholder="选择入账日期"
              onChange={(v) => this.onDate(val(v))}
            />

            <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>分红时持股数量</Text>
            <TextInput
              style={[s.input, { marginTop: 8 }]}
              value={String(this.data.shares)}
              onChangeText={(v) => this.onInput(Object.assign(tap({ field: 'shares' }), val(v)))}
              keyboardType="decimal-pad"
              placeholderTextColor={colors.t3}
            />

            <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>
              每股派息（{(this.data.holding || {}).nativeCurrencyName || ''}）
            </Text>
            <TextInput
              style={[s.input, { marginTop: 8 }]}
              value={String(this.data.dps)}
              onChangeText={(v) => this.onInput(Object.assign(tap({ field: 'dps' }), val(v)))}
              keyboardType="decimal-pad"
              placeholder="0.41"
              placeholderTextColor={colors.t3}
            />

            <View style={[s.between, { marginTop: 14 }]}>
              <Text style={[s.tiny, s.dim]}>红利税（留空视为全额到账）</Text>
              <Pressable onPress={() => this.onTaxHelp()}>
                <Text style={[s.tiny, { color: colors.primary }]}>说明</Text>
              </Pressable>
            </View>
            <TextInput
              style={[s.input, { marginTop: 8 }]}
              value={String(this.data.tax)}
              onChangeText={(v) => this.onInput(Object.assign(tap({ field: 'tax' }), val(v)))}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors.t3}
            />
            <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{this.data.taxTip}</Text>

            <Text style={[s.tiny, s.dim, { marginTop: 16 }]}>
              实际到账金额（{(this.data.holding || {}).nativeCurrencyName || ''}）
            </Text>
            <TextInput
              style={[s.input, styles.amountInput, { marginTop: 8 }]}
              value={String(this.data.amount)}
              onChangeText={(v) => this.onAmount(val(v))}
              keyboardType="decimal-pad"
              placeholder="0.00"
              placeholderTextColor={colors.t3}
            />
            <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>
              默认按「持股数量 × 每股派息 − 红利税」自动计算，改过就以你填的为准。
            </Text>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>

        <View style={styles.bottomBar}>
          <Pressable style={[s.btn, s.flex1]} onPress={() => this.confirm()}>
            <Text style={s.btnText}>保存这笔分红</Text>
          </Pressable>
        </View>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  marketTag: { backgroundColor: colors.line2, color: colors.t2 },
  secTitle: { marginTop: 20, marginBottom: 10, fontSize: 15, fontWeight: '600', color: colors.t1 },
  todayBtn: {
    marginLeft: 10,
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  },
  amountInput: { fontSize: 20, fontWeight: '600', color: colors.primary },
  bottomBar: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  }
})

module.exports = AddDividend

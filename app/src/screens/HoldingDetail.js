const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, Modal, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const DateField = require('../components/DateField.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

// 与「添加持仓」保持同一套口径说明
const DIV_TIPS = [
  '取最近 1 年的分红记录，计算每股派息',
  '取最近 3 年的分红记录，计算每股平均派息',
  '取最近 5 年的分红记录，计算每股平均派息',
  '手动填写每股派息金额'
]

// 小程序 app.wxss 里的 --orange（.c-orange），比 theme 里的 colors.orange 深一档
const ORANGE = '#E0892C'

// 市场徽标：数据层给的是小程序的全局 class（tag-green…），RN 没有全局 class，
// 这里映射成等价样式（配色取 app.wxss 的 .tag-*）
const TAG_STYLES = {
  'tag-green': { backgroundColor: 'rgba(31, 157, 107, 0.10)', color: colors.primary },
  'tag-gold': { backgroundColor: 'rgba(217, 169, 60, 0.16)', color: '#9C7A1E' },
  'tag-blue': { backgroundColor: 'rgba(59, 130, 196, 0.12)', color: '#3B82C4' },
  'tag-orange': { backgroundColor: 'rgba(224, 137, 44, 0.14)', color: colors.orange },
  'tag-gray': { backgroundColor: colors.line2, color: colors.t3 }
}
const tagStyleOf = (cls) => TAG_STYLES[cls] || TAG_STYLES['tag-gray']

// 把 RN 回调包装成小程序的事件形状，这样方法体可以逐字沿用
const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

class HoldingDetail extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      h: null,
      menus: [],
      showCurrency: true,
      submitting: false,

      editOpen: false,
      costModes: [],
      divModes: [],
      divTip: DIV_TIPS[0],
      taxOptions: [],
      taxTips: {},
      taxTip: '',
      form: {
        shares: '',
        cost: '',
        buyDate: '',
        fee: '',
        costModeIndex: 0,
        divModeIndex: 0,
        customDividend: '',
        negativeCost: false,
        taxIndex: 0,
        taxCustom: false,
        taxCustomRate: '',
        taxOn: true
      }
    }
  }

  onLoad(options) {
    this.holdingId = (options && options.id) || ''
    this.load()

    api
      .getAddHoldingOptions()
      .then((res) => {
        this.setData({
          costModes: res.data.costModes,
          divModes: res.data.divModes,
          taxOptions: res.data.taxOptions || [],
          taxTips: res.data.taxTips || {}
        })
      })
      .catch(util.onError)
  }

  onShow() {
    if (!this.data.loading && this.holdingId) this.load()
  }

  load() {
    // 先渲染本地数据（编辑保存后立刻能看到新值），再刷一次实时行情覆盖
    return api
      .getHolding(this.holdingId)
      .then((res) => this.apply(res.data))
      .then(() => api.refreshHoldingQuotes().catch(() => 0))
      .then(() => api.getHolding(this.holdingId))
      .then((res) => this.apply(res.data))
      .catch(util.onError)
  }

  apply(d) {
    this.setData({ loading: false, h: d, menus: d.menus })
  }

  switchCurrency() {
    if (this.data.submitting) return
    const market = this.data.h.market
    const code = market === 'HK' ? 'HKD' : market === 'US' ? 'USD' : 'CNY'

    this.setData({ showCurrency: false })
    util
      .submit(this, api.saveCurrency(code), { loadingText: '切换中', success: '已切换显示货币' })
      .then((r) => {
        if (r) this.load()
      })
  }

  /* ---------------- 功能菜单 ---------------- */

  onMenu(e) {
    const key = e.currentTarget.dataset.key

    if (key === 'trade' || key === 'dividend' || key === 'file') {
      wx.navigateTo({
        url: '/pages/holding-record/holding-record?id=' + this.holdingId + '&tab=' + key
      })
      return
    }

    if (key === 'edit') {
      this.openEdit()
      return
    }

    if (key === 'reseed') {
      wx.showModal({
        title: '校准持仓起点',
        content:
          '会把当前持仓（' +
          this.data.h.sharesText +
          '）当作新的起点，已有交易明细只保留为流水、不再重复计入。\n\n适合你之前手动改过持仓、又记过交易的情况。',
        success: (res) => {
          if (!res.confirm) return
          util
            .submit(this, api.resetSeedBase(this.holdingId), {
              loadingText: '校准中',
              success: '已按当前持仓校准'
            })
            .then((r) => {
              if (r) this.load()
            })
        }
      })
      return
    }

    if (key === 'archive') {
      // 归档前先让人写一句：这是「当初为什么买、现在为什么卖」最新鲜的时刻。
      // 事后当然也能补（档案页每张卡片都能改），但那时候记忆已经凉了。
      wx.showModal({
        title: '清仓归档',
        content:
          '它会被移到「我的 → 投资档案」，持仓、流水和这句想法都保留。\n\n' +
          '顺手记一句吧：当初为什么买、现在为什么卖？过段时间回看，这句比清仓价有用得多。\n\n' +
          '（反悔也不怕：档案页点「返回持仓」就能退回来。）',
        editable: true,
        multiline: true,
        maxLength: api.MEMO_MAX,
        placeholderText: '例如：股息率跌破 3%，换到更便宜的标的',
        confirmText: '归档',
        success: (res) => {
          if (!res.confirm) return
          util
            .submit(this, api.archiveHolding(this.holdingId, res.content), {
              loadingText: '归档中',
              success: '已归档'
            })
            .then((r) => {
              if (!r) return
              util.backLater(this, 700)
            })
        }
      })
    }

    if (key === 'del') {
      wx.showModal({
        title: '删除持仓',
        content: '删除后不可恢复，确定继续吗？',
        confirmColor: '#E5484D',
        success: (res) => {
          if (!res.confirm) return
          util
            .submit(this, api.removeHolding(this.holdingId), {
              loadingText: '删除中',
              success: '已删除'
            })
            .then((r) => {
              if (!r) return
              util.backLater(this, 700)
            })
        }
      })
    }
  }

  onMenuAdd(e) {
    const key = e.currentTarget.dataset.key
    const path = key === 'dividend' ? '/pages/add-dividend/add-dividend?id=' : '/pages/add-trade/add-trade?id='
    wx.navigateTo({ url: path + this.holdingId })
  }

  onExplain() {
    wx.showModal({
      title: '分红怎么算的',
      content:
        '预测年分红 = 每股派息 × 持股数量，港股按 28% 税率扣税。每股派息取自所选分红口径（近1/3/5年或自定义），可在「编辑持仓」里调整。',
      showCancel: false
    })
  }

  /* ---------------- 编辑持仓 ---------------- */

  formTaxRate() {
    const opt = (this.data.taxOptions || [])[this.data.form.taxIndex]
    if (opt && opt.rate !== null && opt.rate !== undefined) return opt.rate
    const v = Number(this.data.form.taxCustomRate)
    return isNaN(v) ? 0 : v
  }

  openEdit() {
    const h = this.data.h
    if (!h) return

    const costModeIndex = Math.max(0, this.data.costModes.indexOf(h.costMode))
    const divModeIndex = Math.max(0, this.data.divModes.indexOf(h.divMode))

    const opts = this.data.taxOptions || []
    const lastIndex = opts.length - 1
    const hit = opts.map((o) => o.rate).indexOf(h.taxRate)
    const taxIndex = hit === -1 ? (lastIndex >= 0 ? lastIndex : 0) : hit
    const taxCustom = lastIndex >= 0 && taxIndex === lastIndex

    this.setData({
      editOpen: true,
      divTip: DIV_TIPS[divModeIndex],
      taxTip: (this.data.taxTips || {})[h.market] || '',
      form: {
        shares: String(h.shares),
        // 录入面板按**本币**回显：用户当初按本币填，重新打开就该看到同一个数
        // （h.cost 存的是折算后的人民币，直接用会让港股/美股显示成另一个数）
        cost: String(h.costNative === undefined ? h.cost : h.costNative),
        buyDate: h.buyDate || '',
        fee: h.feeNative ? String(h.feeNative) : '',
        costModeIndex: costModeIndex,
        divModeIndex: divModeIndex,
        customDividend: '',
        negativeCost: !!h.negativeCost,
        taxIndex: taxIndex,
        taxCustom: taxCustom,
        taxCustomRate: taxCustom ? String(h.taxRate) : '',
        taxOn: h.taxOn !== false
      }
    })
  }

  closeEdit() {
    this.setData({ editOpen: false })
  }

  onFormInput(e) {
    const field = e.currentTarget.dataset.field
    // 编辑面板里五个字段全是数字：只有成本允许为负（分红回本后成本会是负数），
    // 税率是百分比留两位小数，其余（股数、费用、每股派息）留四位
    const v = validate.decimal(e.detail.value, {
      decimals: field === 'taxCustomRate' ? 2 : 4,
      allowNegative: field === 'cost'
    })
    const form = Object.assign({}, this.data.form)
    form[field] = v
    this.setData({ form: form })
  }

  onFormDate(e) {
    this.setData({ form: Object.assign({}, this.data.form, { buyDate: e.detail.value }) })
  }

  onFormCostMode(e) {
    this.setData({
      form: Object.assign({}, this.data.form, { costModeIndex: Number(e.currentTarget.dataset.i) })
    })
  }

  onFormDivMode(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({
      form: Object.assign({}, this.data.form, { divModeIndex: i }),
      divTip: DIV_TIPS[i]
    })
  }

  toggleFormNegative() {
    this.setData({
      form: Object.assign({}, this.data.form, { negativeCost: !this.data.form.negativeCost })
    })
  }

  onFormTax(e) {
    const i = Number(e.currentTarget.dataset.i)
    const opt = (this.data.taxOptions || [])[i] || {}
    this.setData({
      form: Object.assign({}, this.data.form, { taxIndex: i, taxCustom: opt.rate === null })
    })
  }

  toggleFormTaxOn() {
    this.setData({
      form: Object.assign({}, this.data.form, { taxOn: !this.data.form.taxOn })
    })
  }

  onSaveEdit() {
    const f = this.data.form
    const shares = Number(f.shares)
    const cost = Number(f.cost)
    const customDividend = Number(f.customDividend)

    if (!(shares > 0)) {
      wx.showToast({ title: '请填写正确的持仓数量', icon: 'none' })
      return
    }
    if (String(f.cost).trim() === '' || isNaN(cost)) {
      wx.showToast({ title: '请填写当前成本', icon: 'none' })
      return
    }
    if (f.divModeIndex === 3 && !(customDividend > 0)) {
      wx.showToast({ title: '请填写每股派息', icon: 'none' })
      return
    }
    // 交易费用可留空，填了就不能是负数
    const feeErr = validate.checkNum(f.fee, { optional: true, min: 0 }, '交易费用')
    if (feeErr) {
      wx.showToast({ title: feeErr, icon: 'none' })
      return
    }
    // 自定义税率必须落在 0~100
    if (f.taxCustom) {
      const taxErr = validate.checkNum(f.taxCustomRate, { min: 0, max: 100 }, '分红税率')
      if (taxErr) {
        wx.showToast({ title: taxErr, icon: 'none' })
        return
      }
    }

    const payload = {
      shares: shares,
      cost: cost,
      buyDate: f.buyDate,
      fee: Number(f.fee) || 0,
      costMode: this.data.costModes[f.costModeIndex],
      divMode: this.data.divModes[f.divModeIndex],
      customDividend: f.divModeIndex === 3 ? customDividend : 0,
      negativeCost: f.negativeCost,
      taxRate: this.formTaxRate(),
      taxOn: f.taxOn
    }

    util
      .submit(this, api.updateHolding(this.holdingId, payload), {
        loadingText: '保存中',
        success: '已保存'
      })
      .then((res) => {
        if (!res) return
        this.setData({ editOpen: false })
        this.load()
      })
  }

  onUnload() {
    util.cancelBack(this)
  }

  /* ---------------- 渲染 ----------------
   * 与小程序 pages/holding-detail 的 wxml 逐块对齐：
   * 币种提示 → 标题 → 预测分红 → 市值 → 持股天数 → 2×2 指标 → 累计已获分红
   * → 分红税率 → 回本进度 → 功能菜单 → 编辑持仓面板
   */

  renderEmpty(text) {
    return (
      <View style={[s.page, styles.empty]}>
        <Text style={styles.emptyEmoji}>📄</Text>
        <Text style={styles.emptyTitle}>{text}</Text>
      </View>
    )
  }

  // 显示货币与该持仓本币不一致时才出现
  renderCurrencyTip() {
    const h = this.data.h
    if (!h.showCurrencyTip || !this.data.showCurrency) return null

    return (
      <Pressable style={styles.warmTip} onPress={() => this.switchCurrency()}>
        <Text style={[styles.warmTipText, s.flex1]}>💱 当前按{h.currencyName}显示</Text>
        <Text style={styles.curLink}>换成{h.nativeCurrencyName}看 →</Text>
      </Pressable>
    )
  }

  renderTitle() {
    const h = this.data.h
    return (
      <View>
        <View style={styles.titleRow}>
          <Text style={styles.code}>{h.code}</Text>
          <Text style={[styles.name, { marginLeft: 6 }]}>{h.name}</Text>
          <Text style={[s.tag, tagStyleOf(h.tagClass), { marginLeft: 6 }]}>{h.marketTag}</Text>
        </View>
        <Text style={[s.small, s.dim, { marginTop: 4 }]}>{h.marketLabel}</Text>
      </View>
    )
  }

  // 预测年分红：主数字最大，下面一行写清口径
  renderDividend() {
    const h = this.data.h
    return (
      <View style={[styles.card, { marginTop: 12 }]}>
        <View style={s.between}>
          <Text style={[s.small, s.dim]}>预测年分红（税后）</Text>
          <Pressable onPress={() => this.onExplain()}>
            <Text style={[s.tiny, s.dim]}>觉得不准？ ›</Text>
          </Pressable>
        </View>
        <Text style={styles.huge}>{h.dividendText}</Text>
        <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>每股 {h.dpsText} × {h.sharesText}</Text>
      </View>
    )
  }

  renderMarketValue() {
    const h = this.data.h
    return (
      <View style={[styles.card, { marginTop: 10 }]}>
        <View style={s.between}>
          <View>
            <Text style={[s.small, s.dim]}>当前市值</Text>
            <Text style={[styles.value, s.num, { marginTop: 4 }]}>{h.marketValueText}</Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={[s.tiny, s.dim]}>{h.priceDateText}</Text>
            <Text style={[s.mid, s.num, { marginTop: 4 }]}>{h.priceText} × {h.sharesText}</Text>
          </View>
        </View>
      </View>
    )
  }

  // 2×2 指标：每格「标题 / 数值 / 副说明」，与小程序 .grid-cell 一致
  renderGrid() {
    const h = this.data.h
    const cell = (title, value, sub, tagNode) => (
      <View style={styles.gridCell}>
        <Text style={[s.tiny, s.dim]}>{title}</Text>
        <Text style={[s.h3, s.num, { marginTop: 6 }]}>{value}</Text>
        {tagNode || <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{sub}</Text>}
      </View>
    )

    return (
      <View style={styles.grid}>
        {cell('成本息率（税后）ⓘ', h.costYieldText, '成本 ' + h.costText)}
        {cell('股价息率（税后）ⓘ', h.priceYieldText, '基于' + h.priceDateText + ' ' + h.priceText)}
        {cell('持仓数量', h.sharesText, '—')}
        {cell('当前成本 ⓘ', h.costText, '', (
          <View style={{ marginTop: 4 }}>
            <Text style={[s.tag, h.received > 0 ? styles.tagGreen : styles.tagGray]}>
              {h.received > 0 ? '分红摊薄' : '未摊薄'}
            </Text>
          </View>
        ))}
      </View>
    )
  }

  renderPayback() {
    const h = this.data.h
    const pct = Math.max(0, Math.min(100, Number(h.paybackProgress) || 0))

    const item = (title, value, align) => (
      <View style={[s.flex1, align === 'right' ? { alignItems: 'flex-end' } : null]}>
        <Text style={[s.tiny, s.dim]}>{title}</Text>
        <Text style={[s.mid, s.num, { marginTop: 4 }]}>{value}</Text>
      </View>
    )

    return (
      <View style={[styles.card, { marginTop: 10 }]}>
        <View style={s.between}>
          <Text style={[s.small, s.dim]}>分红回本进度 ⓘ</Text>
          <Text style={[s.h3, styles.cOrange, s.num]}>{h.paybackProgress}%</Text>
        </View>

        <View style={styles.pbar}>
          <View style={[styles.pbarIn, { width: pct + '%' }]} />
        </View>

        <View style={[s.row, { marginTop: 12 }]}>
          {item('净投入', h.netInvestText)}
          {item('已收分红', h.receivedText)}
          {item('剩余待回收', h.remainingText)}
          {item('预计回本（税后）', h.paybackYearsText + '年', 'right')}
        </View>
      </View>
    )
  }

  renderMenus() {
    const menus = this.data.menus || []
    return (
      <View style={[styles.cardFlat, { marginTop: 12 }]}>
        {menus.map((m, i) => (
          <View key={m.key} style={[styles.menuRow, i === menus.length - 1 ? null : styles.menuRowLine]}>
            <Pressable style={[s.row, s.flex1]} onPress={() => this.onMenu(tap({ key: m.key }))}>
              <View style={styles.menuIconBox}>
                <Text style={{ fontSize: 15 }}>{m.icon}</Text>
              </View>
              <View style={[s.flex1, { marginLeft: 8 }]}>
                <Text style={[s.mid, s.bold, m.danger ? styles.cUp : null]}>{m.name}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{m.desc}</Text>
              </View>
            </Pressable>

            {m.action ? (
              <Pressable style={styles.btnMiniDark} onPress={() => this.onMenuAdd(tap({ key: m.key }))}>
                <Text style={styles.btnMiniDarkText}>＋ {m.action}</Text>
              </Pressable>
            ) : (
              <Text style={[s.mid, s.dim]}>›</Text>
            )}
          </View>
        ))}
      </View>
    )
  }

  /* ---------------- 编辑持仓面板 ---------------- */

  // 胶囊组：成本口径用绿色选中态，分红税率用橙色实心（与「添加持仓」页一致）
  renderChips(options, activeIndex, onPick, labelOf, tax) {
    return (
      <View style={styles.chipRow}>
        {options.map((o, i) => (
          <Pressable
            key={labelOf(o, i)}
            style={[styles.chip, i === activeIndex ? (tax ? styles.chipOnTax : styles.chipOn) : null]}
            onPress={() => onPick(i)}
          >
            <Text style={[styles.chipText, i === activeIndex ? (tax ? styles.chipTextOnTax : styles.chipTextOn) : null]}>
              {labelOf(o, i)}
            </Text>
          </Pressable>
        ))}
      </View>
    )
  }

  // 简易开关：与小程序 .switch 同尺寸（84×46rpx → 42×23），税率那个用橙色
  renderSwitch(on, onToggle, tax) {
    return (
      <Pressable style={[styles.switch, on ? (tax ? styles.switchOnTax : styles.switchOn) : null]} onPress={onToggle}>
        <View style={[styles.switchDot, on ? styles.switchDotOn : null]} />
      </Pressable>
    )
  }

  renderEditSheet() {
    const f = this.data.form
    const d = this.data

    return (
      <Modal
        visible={this.data.editOpen}
        transparent
        animationType="slide"
        onRequestClose={() => this.closeEdit()}
      >
        <View style={styles.sheetRoot}>
          <Pressable style={styles.sheetMask} onPress={() => this.closeEdit()} />
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.sheetTitle}>编辑持仓</Text>

              <View style={styles.fRow}>
                <Text style={styles.fLabel}>持仓数量</Text>
                <TextInput
                  style={styles.fInput}
                  value={f.shares}
                  onChangeText={(v) => this.onFormInput(Object.assign(tap({ field: 'shares' }), val(v)))}
                  keyboardType="decimal-pad"
                  placeholder="股数"
                  placeholderTextColor={colors.t3}
                />
                <Text style={styles.fUnit}>股</Text>
              </View>

              <View style={styles.fRow}>
                <Text style={styles.fLabel}>当前成本</Text>
                <TextInput
                  style={styles.fInput}
                  value={f.cost}
                  onChangeText={(v) => this.onFormInput(Object.assign(tap({ field: 'cost' }), val(v)))}
                  keyboardType="decimal-pad"
                  placeholder="每股成本，可为负"
                  placeholderTextColor={colors.t3}
                />
                <Text style={styles.fUnit}>
                  {(this.data.h || {}).nativeCurrencyName || ''}/股
                </Text>
              </View>

              <View style={[styles.fRow, styles.fCol]}>
                <Text style={styles.fLabel}>成本口径</Text>
                {this.renderChips(
                  d.costModes,
                  f.costModeIndex,
                  (i) => this.onFormCostMode(tap({ i: i })),
                  (o) => o
                )}
              </View>

              <View style={styles.fRow}>
                <Text style={styles.fLabel}>买入日期</Text>
                <View style={s.flex1}>
                  <DateField
                    value={f.buyDate}
                    placeholder="请选择"
                    today={false}
                    onChange={(v) => this.onFormDate(val(v))}
                  />
                </View>
              </View>

              <View style={styles.fRow}>
                <Text style={styles.fLabel}>交易费用</Text>
                <TextInput
                  style={styles.fInput}
                  value={f.fee}
                  onChangeText={(v) => this.onFormInput(Object.assign(tap({ field: 'fee' }), val(v)))}
                  keyboardType="decimal-pad"
                  placeholder="可选"
                  placeholderTextColor={colors.t3}
                />
              </View>

              <View style={[styles.fRow, styles.fCol]}>
                <Text style={styles.fLabel}>分红预测口径</Text>
                {this.renderChips(
                  d.divModes,
                  f.divModeIndex,
                  (i) => this.onFormDivMode(tap({ i: i })),
                  (o) => o
                )}
                {f.divModeIndex === 3 ? (
                  <TextInput
                    style={[styles.fInputBox, { marginTop: 10 }]}
                    value={f.customDividend}
                    onChangeText={(v) =>
                      this.onFormInput(Object.assign(tap({ field: 'customDividend' }), val(v)))
                    }
                    keyboardType="decimal-pad"
                    placeholder={
                      '请输入每股派息（' + ((this.data.h || {}).nativeCurrencyName || '') + '）'
                    }
                    placeholderTextColor={colors.t3}
                  />
                ) : null}
                <Text style={styles.fTip}>ⓘ {d.divTip}</Text>
              </View>

              <View style={[styles.fRow, styles.fCol]}>
                <Text style={styles.fLabel}>分红税率</Text>
                {this.renderChips(
                  d.taxOptions,
                  f.taxIndex,
                  (i) => this.onFormTax(tap({ i: i })),
                  (o) => o.text,
                  true
                )}
                {f.taxCustom ? (
                  <TextInput
                    style={[styles.fInputBox, { marginTop: 10 }]}
                    value={f.taxCustomRate}
                    onChangeText={(v) =>
                      this.onFormInput(Object.assign(tap({ field: 'taxCustomRate' }), val(v)))
                    }
                    keyboardType="decimal-pad"
                    placeholder="请输入税率（%）"
                    placeholderTextColor={colors.t3}
                  />
                ) : null}
                {d.taxTip ? <Text style={styles.fTip}>ⓘ {d.taxTip}</Text> : null}
              </View>

              <View style={styles.fRow}>
                <Text style={styles.fLabel}>预测分红扣税</Text>
                <View style={s.flex1} />
                {this.renderSwitch(f.taxOn, () => this.toggleFormTaxOn(), true)}
              </View>

              <View style={styles.fRow}>
                <Text style={styles.fLabel}>负成本</Text>
                <View style={s.flex1} />
                {this.renderSwitch(f.negativeCost, () => this.toggleFormNegative())}
              </View>

              <Pressable style={styles.sheetBtn} onPress={() => this.onSaveEdit()}>
                <Text style={styles.sheetBtnText}>{d.submitting ? '保存中…' : '保存'}</Text>
              </Pressable>
              <Pressable style={styles.sheetCancel} onPress={() => this.closeEdit()}>
                <Text style={styles.sheetCancelText}>取消</Text>
              </Pressable>

              <View style={{ height: 24 }} />
            </ScrollView>
          </View>
        </View>
      </Modal>
    )
  }

  render() {
    if (this.data.loading) return this.renderEmpty('正在加载持仓详情…')
    if (!this.data.h) return this.renderEmpty('没找到这只持仓')

    const h = this.data.h

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {this.renderCurrencyTip()}
          {this.renderTitle()}
          {this.renderDividend()}
          {this.renderMarketValue()}

          <View style={[styles.card, { marginTop: 10 }]}>
            <View style={s.between}>
              <Text style={[s.small, s.dim]}>🔥 持股天数 ⓘ</Text>
              <Text style={s.h3}>{h.holdingDays}天</Text>
            </View>
          </View>

          {this.renderGrid()}

          <View style={[styles.card, { marginTop: 10 }]}>
            <View style={s.between}>
              <Text style={[s.small, s.dim]}>累计已获分红</Text>
              <Text style={[s.h3, styles.cOrange, s.num]}>{h.receivedText}</Text>
            </View>
          </View>

          {h.taxOn && h.taxRate > 0 ? (
            <View style={[styles.card, { marginTop: 10 }]}>
              <View style={s.between}>
                <Text style={[s.small, s.dim]}>分红税率 ⓘ</Text>
                <Text style={s.h3}>{h.taxRate}%</Text>
              </View>
            </View>
          ) : null}

          {this.renderPayback()}
          {this.renderMenus()}

          <View style={{ height: 30 }} />
        </ScrollView>

        {this.renderEditSheet()}
      </View>
    )
  }
}

const styles = StyleSheet.create({
  // 与小程序 .page 一致：只有上下留白，底部不用给悬浮按钮让位
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 },

  // 卡片：小程序 .card / .card-flat 都带一层很淡的投影
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    shadowColor: '#172B23',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  cardFlat: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 4,
    paddingHorizontal: 14,
    overflow: 'hidden',
    shadowColor: '#172B23',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },

  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  // 币种提示条（.warm-tip + .cur-link）
  warmTip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FDF4E4',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F2E1BF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12
  },
  warmTipText: { fontSize: 13, color: '#8A6A22', lineHeight: 18 },
  curLink: { fontSize: 13, color: ORANGE, fontWeight: '500', marginLeft: 6 },

  titleRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  code: { fontSize: 17, fontWeight: '700', fontVariant: ['tabular-nums'] },
  name: { fontSize: 21, fontWeight: '700', color: colors.t1, lineHeight: 25 },

  // .huge：62rpx，负字距，是整页最大的数字
  huge: {
    marginTop: 6,
    fontSize: 31,
    fontWeight: '700',
    letterSpacing: -0.5,
    lineHeight: 36,
    color: ORANGE,
    fontVariant: ['tabular-nums']
  },
  value: { fontSize: 17, fontWeight: '600', color: colors.t1 },
  cOrange: { color: ORANGE },
  cUp: { color: colors.up },

  // 2×2 指标（.grid / .grid-cell）
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', marginTop: 10 },
  gridCell: {
    width: '48.6%',
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 13,
    marginBottom: 10,
    minHeight: 95,
    shadowColor: '#172B23',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2
  },
  tagGreen: { backgroundColor: 'rgba(31, 157, 107, 0.1)', color: colors.primary },
  tagGray: { backgroundColor: colors.line2, color: colors.t3 },

  // 回本进度条（.pbar / .pbar-in）
  pbar: { marginTop: 10, height: 6, borderRadius: 999, backgroundColor: '#EFF2F1', overflow: 'hidden' },
  pbarIn: { height: '100%', borderRadius: 999, backgroundColor: ORANGE },

  // 功能菜单（.card-flat + .menu-row + .icon-box + .btn-mini-dark）
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13
  },
  menuRowLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  menuIconBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F3F5F4'
  },
  btnMiniDark: {
    paddingHorizontal: 11,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: '#1F1F1F'
  },
  btnMiniDarkText: { fontSize: 12, color: '#FFFFFF' },

  /* ---------- 编辑持仓面板（.sheet / .f-row / .chip / .switch） ---------- */
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheetMask: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: '82%',
    paddingHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 24
  },
  sheetTitle: {
    paddingTop: 15,
    paddingBottom: 10,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    color: colors.t1
  },

  fRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },
  fCol: { flexDirection: 'column', alignItems: 'flex-start' },
  fLabel: { width: 90, fontSize: 13.5, color: colors.t2, flexShrink: 0 },
  fInput: { flex: 1, minWidth: 0, fontSize: 14, color: colors.t1, paddingVertical: 0 },
  fInputBox: {
    width: '100%',
    height: 46,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.line2,
    fontSize: 14,
    color: colors.t1
  },
  fUnit: { fontSize: 11.5, color: colors.t3, marginLeft: 6 },

  chipRow: { flexDirection: 'row', flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: '#EFF2F1',
    marginRight: 7,
    marginBottom: 6
  },
  chipText: { fontSize: 12, color: colors.t2 },
  chipOn: { backgroundColor: 'rgba(31, 157, 107, 0.12)' },
  chipTextOn: { color: colors.primary, fontWeight: '600' },
  // 税率胶囊：选中是实心橙底白字，与「成本口径」的绿字区分开
  chipOnTax: { backgroundColor: ORANGE },
  chipTextOnTax: { color: '#FFFFFF', fontWeight: '500' },

  fTip: {
    marginTop: 8,
    paddingHorizontal: 11,
    paddingVertical: 9,
    backgroundColor: '#F7F9F8',
    borderRadius: 7,
    fontSize: 11.5,
    lineHeight: 17,
    color: colors.t3
  },

  switch: {
    width: 42,
    height: 23,
    borderRadius: 999,
    backgroundColor: '#D9DEDC',
    padding: 2,
    justifyContent: 'center'
  },
  switchOn: { backgroundColor: colors.primary },
  switchOnTax: { backgroundColor: ORANGE },
  switchDot: { width: 19, height: 19, borderRadius: 9.5, backgroundColor: '#FFFFFF' },
  switchDotOn: { transform: [{ translateX: 19 }] },

  sheetBtn: {
    marginTop: 15,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.primary
  },
  sheetBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
  sheetCancel: { marginTop: 8, paddingVertical: 12, alignItems: 'center' },
  sheetCancelText: { fontSize: 14, color: colors.t2 }
})

module.exports = HoldingDetail

const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')
const DateField = require('../components/DateField.js')

/**
 * 添加持仓。
 *
 * 方法体与小程序那份**逐字一致** —— 靠两个小助手把 RN 的回调包装成小程序的事件形状：
 *   tap({i: 2})     → e.currentTarget.dataset
 *   val('1000')     → e.detail.value
 * 只改渲染部分，逻辑不动，就不用重新验证一遍业务规则。
 */
const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

const DIV_TIPS = [
  '取最近 1 年的分红记录，计算每股派息',
  '取最近 3 年的分红记录，计算每股平均派息',
  '取最近 5 年的分红记录，计算每股平均派息',
  '手动填写每股派息金额'
]

// 输入即搜：停止输入 300ms 后才发请求，避免每个字符都打一次接口
const SEARCH_DEBOUNCE = 300

class AddHolding extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      submitting: false,

      markets: [],
      marketIndex: 0,
      keyword: '',
      results: [],
      noResult: false,
      picked: null,
      stockPicked: false,

      detail: null,
      detailLoading: false,
      detailNote: '',
      archiveOpen: false,

      shares: '',
      buyDate: '',
      fee: '',
      costModes: [],
      costModeIndex: 0,
      cost: '',
      negativeCost: false,
      showCostMinus: false,
      realCost: 0,

      divModes: [],
      divModeIndex: 0,
      divTip: DIV_TIPS[0],
      customDividend: '',
      dividendText: '--',
      dividendEmpty: true,

      taxOptions: [],
      taxTips: {},
      defaultTaxRates: {},
      taxIndex: 0,
      taxCustom: false,
      taxCustomRate: '',
      taxOn: true,
      taxTip: '',

      symbol: '',

      customOpen: false,
      cf: { code: '', name: '', dps: '' },

      canSubmit: false
    }
  }

  onLoad(options) {
    this.prefillCode = (options && options.code) || ''
    this.prefillMarket = (options && options.market) || ''

    api
      .getAddHoldingOptions()
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          markets: d.markets,
          costModes: d.costModes,
          divModes: d.divModes,
          buyDate: d.buyDate,
          symbol: d.symbol,
          taxOptions: d.taxOptions || [],
          taxTips: d.taxTips || {},
          defaultTaxRates: d.defaultTaxRates || {}
        })
        this.applyDefaultTax((d.markets[0] || {}).key)
        if (this.prefillCode) this.applyPrefill(this.prefillCode, this.prefillMarket)
      })
      .catch(util.onError)
  }

  applyPrefill(code, market) {
    const req = market ? api.getStockDetail({ code, market }) : api.getStockByCode(code)
    req
      .then((res) => {
        const stock = res.data
        const marketIndex = Math.max(0, this.data.markets.map((m) => m.key).indexOf(stock.market))
        this.setData({
          marketIndex,
          picked: stock,
          stockPicked: true,
          keyword: stock.name,
          detail: stock,
          detailLoading: false,
          detailNote: '',
          archiveOpen: false
        })
        this.applyDefaultTax(stock.market)
        this.refreshDividend()
        this.refreshState()
      })
      .catch((e) => {
        wx.showToast({ title: (e && e.msg) || '行情获取失败', icon: 'none' })
      })
  }

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    util.cancelBack(this)
  }

  /* ================= 标的实时数据 ================= */

  loadDetail(stock) {
    this.detailSeq = (this.detailSeq || 0) + 1
    const seq = this.detailSeq
    const target = typeof stock === 'string' ? { code: stock } : stock

    this.setData({ detail: null, detailLoading: true, detailNote: '', archiveOpen: false })

    api
      .getStockDetail(target)
      .then((res) => {
        if (seq !== this.detailSeq) return
        this.setData({ detail: res.data, detailLoading: false, detailNote: '' })
        this.refreshDividend()
      })
      .catch((e) => {
        if (seq !== this.detailSeq) return
        this.setData({
          detail: null,
          detailLoading: false,
          detailNote: (e && e.msg) || '行情获取失败，请稍后重试'
        })
        this.refreshDividend()
      })
  }

  onRefreshQuote() {
    if (this.data.picked) this.loadDetail(this.data.picked)
  }

  clearDetail(note) {
    this.detailSeq = (this.detailSeq || 0) + 1
    this.setData({
      detail: null,
      detailLoading: false,
      detailNote: note || '',
      archiveOpen: false
    })
  }

  toggleArchive() {
    this.setData({ archiveOpen: !this.data.archiveOpen })
  }

  /* ================= 选择股票 ================= */

  onMarket(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i === this.data.marketIndex) return
    this.setData({ marketIndex: i, results: [] })
    this.applyDefaultTax((this.data.markets[i] || {}).key)
    this.doSearch()
  }

  onCustom() {
    this.setData({ customOpen: true, cf: { code: '', name: '', dps: '' } })
  }

  onCustomHelp() {
    wx.showModal({
      title: '自定义标的',
      content: '标的池里查不到的股票，可以自己填代码、名称与每股派息，市场按当前所选标签归属。',
      showCancel: false
    })
  }

  closeCustom() {
    this.setData({ customOpen: false })
  }

  onCfInput(e) {
    const field = e.currentTarget.dataset.field
    const raw = e.detail.value
    // 三个字段口径不同：代码只用字母数字、名称是纯文本、每股派息是数字
    const v =
      field === 'code'
        ? validate.code(raw, { max: 12 })
        : field === 'dps'
        ? validate.decimal(raw, { decimals: 4 })
        : validate.plain(raw, { max: 20 })
    const cf = Object.assign({}, this.data.cf)
    cf[field] = v
    this.setData({ cf: cf })
  }

  onCfSubmit() {
    const cf = this.data.cf
    const code = String(cf.code).trim()
    const name = String(cf.name).trim()
    const dps = Number(cf.dps)

    if (!code) {
      wx.showToast({ title: '请填写股票代码', icon: 'none' })
      return
    }
    if (!name) {
      wx.showToast({ title: '请填写股票名称', icon: 'none' })
      return
    }
    if (!(dps > 0)) {
      wx.showToast({ title: '请填写每股派息', icon: 'none' })
      return
    }

    const m = this.data.markets[this.data.marketIndex] || {}
    this.setData({
      customOpen: false,
      picked: {
        code: code,
        name: name,
        market: m.key || 'A',
        marketTag: m.tag || '',
        tagClass: m.cls || 'tag-gray',
        dps: dps,
        custom: true
      },
      stockPicked: true,
      keyword: name,
      results: [],
      noResult: false,
      divModeIndex: 3,
      divTip: DIV_TIPS[3],
      customDividend: cf.dps,
      // 手填的每股派息是**本币**口径，预览也用本币符号，和下面的输入框一致
      dividendText: api.nativeSymbol(m.key || 'A') + util.money(dps, 4)
    })
    this.applyDefaultTax(m.key || 'A')
    this.clearDetail('自定义标的：无行情与分红档案，分红按手填每股派息计算')
    this.refreshState()
  }

  onSearchInput(e) {
    this.setData({ keyword: validate.plain(e.detail.value, { max: 20 }) })
    this.scheduleSearch()
  }

  scheduleSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.doSearch()
    }, SEARCH_DEBOUNCE)
  }

  doSearch() {
    if (!String(this.data.keyword).trim()) {
      this.searchSeq = (this.searchSeq || 0) + 1
      this.setData({ results: [], noResult: false })
      return
    }

    this.searchSeq = (this.searchSeq || 0) + 1
    const seq = this.searchSeq
    const market = (this.data.markets[this.data.marketIndex] || {}).key

    api
      .searchStocks({ market: market, keyword: this.data.keyword })
      .then((res) => {
        if (seq !== this.searchSeq) return
        this.setData({ results: res.data, noResult: res.data.length === 0 })
      })
      .catch(util.onError)
  }

  onPickStock(e) {
    const ds = e.currentTarget.dataset
    const stock = this.data.results.filter((x) => x.code === ds.code && x.market === ds.market)[0]
    if (!stock) return

    const marketIndex = Math.max(0, this.data.markets.map((m) => m.key).indexOf(stock.market))

    this.setData({
      picked: stock,
      marketIndex: marketIndex,
      stockPicked: true,
      results: [],
      noResult: false,
      keyword: stock.name
    })
    this.applyDefaultTax(stock.market)
    this.loadDetail(stock)
    this.refreshState()
  }

  onRepick() {
    this.detailSeq = (this.detailSeq || 0) + 1
    this.searchSeq = (this.searchSeq || 0) + 1
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = null

    this.setData({
      stockPicked: false,
      picked: null,
      keyword: '',
      results: [],
      noResult: false,
      detail: null,
      detailLoading: false,
      detailNote: '',
      archiveOpen: false
    })
    this.refreshState()
  }

  /* ================= 持仓信息 ================= */

  onShares(e) {
    // 不做整数限制：美股允许碎股，港股也有不足一手的零股
    this.setData({ shares: validate.decimal(e.detail.value, { decimals: 4 }) })
    this.refreshState()
  }

  onFee(e) {
    this.setData({ fee: validate.decimal(e.detail.value, { decimals: 4 }) })
  }

  onCost(e) {
    // 成本允许为负（分红收回了本金，负成本也是真实存在的持仓状态）
    this.setData({ cost: validate.decimal(e.detail.value, { decimals: 4, allowNegative: true }) })
    this.refreshCostSign()
    this.refreshState()
  }

  onDateChange(e) {
    this.setData({ buyDate: e.detail.value })
  }

  onCostMode(e) {
    this.setData({ costModeIndex: Number(e.currentTarget.dataset.i) })
  }

  toggleNegative() {
    if (!this.data.stockPicked) return
    this.setData({ negativeCost: !this.data.negativeCost })
    this.refreshCostSign()
  }

  refreshCostSign() {
    const raw = String(this.data.cost).trim()
    const num = Number(raw)
    const hasValue = raw !== '' && !isNaN(num)
    const realCost = hasValue ? (this.data.negativeCost ? -Math.abs(num) : num) : 0

    this.setData({
      showCostMinus: this.data.negativeCost && raw.charAt(0) !== '-',
      realCost: realCost
    })
  }

  onCostModeHelp() {
    wx.showModal({
      title: '成本口径说明',
      content:
        '分红摊薄：已收分红从成本中扣除后的成本\n摊薄成本：按摊薄口径计算的单位成本\n加权平均：多次买入的加权平均成本',
      showCancel: false
    })
  }

  /* ================= 分红预测口径 ================= */

  onDivMode(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ divModeIndex: i, divTip: DIV_TIPS[i] })
    this.refreshDividend()
  }

  onCustomDividend(e) {
    this.setData({ customDividend: validate.decimal(e.detail.value, { decimals: 4 }) })
    this.refreshDividend()
  }

  onDivHelp() {
    wx.showModal({
      title: '分红预测口径',
      content: '按所选年数取该标的的历史分红记录，估算每股年度派息，用于预测你的年度分红。',
      showCancel: false
    })
  }

  onDivDetail() {
    wx.showModal({
      title: '计算明细',
      content: this.data.divTip + '\n\n本次结果：' + this.data.dividendText,
      showCancel: false
    })
  }

  refreshDividend() {
    const idx = this.data.divModeIndex
    // 手填的每股派息是**本币**口径，预览跟着用本币符号（不是显示货币）
    const nativeSym = api.nativeSymbol((this.data.picked && this.data.picked.market) || 'A')

    if (idx === 3) {
      const v = Number(this.data.customDividend)
      this.setData({
        dividendText: v > 0 ? nativeSym + util.money(v, 4) : '--',
        dividendEmpty: !(v > 0)
      })
      return
    }

    const code = this.data.picked ? this.data.picked.code : ''
    if (!code) {
      this.setData({ dividendText: '--', dividendEmpty: true })
      return
    }

    const detail = this.data.detail
    const dividend = detail && detail.dividend ? detail.dividend : null
    const baseDps = dividend ? dividend.dps : 0

    api
      .estimateDividend({
        code: code,
        market: this.data.picked ? this.data.picked.market : '',
        divModeIndex: idx,
        customDividend: Number(this.data.customDividend) || 0,
        baseDps: baseDps,
        // 三个口径各自的基数（近1/3/5年），后端按所选口径取用
        dpsByMode: dividend ? dividend.dpsByMode : null,
        taxRate: this.currentTaxRate(),
        taxOn: this.data.taxOn
      })
      .then((res) => {
        const d = res.data
        this.setData({ dividendText: d.dividendText, dividendEmpty: !d.hasDividend })
      })
      .catch(util.onError)
  }

  /* ================= 分红税率 ================= */

  applyDefaultTax(market) {
    const rates = this.data.defaultTaxRates || {}
    const def = rates[market]
    const rate = def === undefined ? 0 : def

    const rates2 = (this.data.taxOptions || []).map((o) => o.rate)
    const hit = rates2.indexOf(rate)
    const customIndex = rates2.length - 1
    const taxIndex = hit === -1 ? customIndex : hit

    this.setData({
      taxIndex: taxIndex,
      taxCustom: taxIndex === customIndex,
      taxCustomRate: taxIndex === customIndex ? String(rate) : '',
      taxTip: (this.data.taxTips || {})[market] || (this.data.taxTips || {}).A || '',
      // 顺便把该市场的本币带下来：成本、每股派息这些输入框的单位要跟着市场换
      // （港股填港币、美股填美元，折成人民币是入库时统一做的）
      nativeName: api.nativeName(market),
      nativeSymbol: api.nativeSymbol(market)
    })
  }

  currentTaxRate() {
    const opt = (this.data.taxOptions || [])[this.data.taxIndex]
    if (opt && opt.rate !== null && opt.rate !== undefined) return opt.rate
    const v = Number(this.data.taxCustomRate)
    return isNaN(v) ? 0 : v
  }

  onTax(e) {
    const i = Number(e.currentTarget.dataset.i)
    const opt = (this.data.taxOptions || [])[i] || {}
    this.setData({ taxIndex: i, taxCustom: opt.rate === null })
    this.refreshDividend()
  }

  onTaxCustom(e) {
    // 税率是百分比，两位小数足够；上限在提交前校验（见 confirm）
    this.setData({ taxCustomRate: validate.decimal(e.detail.value, { decimals: 2 }) })
    this.refreshDividend()
  }

  toggleTaxOn() {
    if (!this.data.stockPicked) return
    this.setData({ taxOn: !this.data.taxOn })
    this.refreshDividend()
  }

  onTaxHelp() {
    wx.showModal({
      title: '分红税率',
      content:
        '股息红利所得税率。港股通 H 股默认 20%，红筹股 28%，香港券商直投 H 股 10%，港股直接持有本地股 0%；美股一般按税收协定预扣 10%；A 股按持股期限差别化征收，长期持有多为免征。\n\n按你的实际开户方式选，拿不准就填一个保守值。',
      showCancel: false
    })
  }

  /* ================= 提交 ================= */

  refreshState() {
    const d = this.data
    const picked = !!d.picked
    const hasShares = String(d.shares).trim() !== ''
    const hasCost = String(d.cost).trim() !== ''

    this.setData({ canSubmit: picked && hasShares && hasCost })
  }

  confirm() {
    const d = this.data
    if (!d.picked) {
      wx.showToast({ title: '请先选择股票', icon: 'none' })
      return
    }
    // 数量必须 > 0：净化后不会是「一千」这种非法值，但可能是空或 0，
    // 所以这里仍然要拦一道，否则 0 股持仓能建出来
    const sharesErr = validate.checkNum(d.shares, { positive: true }, '持仓数量')
    if (sharesErr) {
      wx.showToast({ title: sharesErr, icon: 'none' })
      return
    }
    // 成本允许为负（分红回本后是真实状态），但不能留空或只有个负号
    const costErr = validate.checkNum(d.cost, {}, '当前成本')
    if (costErr) {
      wx.showToast({ title: costErr, icon: 'none' })
      return
    }
    // 手续费可留空，填了就不能是负数
    const feeErr = validate.checkNum(d.fee, { optional: true, min: 0 }, '手续费')
    if (feeErr) {
      wx.showToast({ title: feeErr, icon: 'none' })
      return
    }
    // 选「自定义」分红口径时必须填正数（前三种口径由接口数据算，不看这个输入框）
    if (d.divModeIndex === 3) {
      const dpsErr = validate.checkNum(d.customDividend, { positive: true }, '每股派息')
      if (dpsErr) {
        wx.showToast({ title: dpsErr, icon: 'none' })
        return
      }
    }
    // 税率是百分比，必须落在 0~100，否则会算出负分红或超过全额
    if (d.taxCustom) {
      const taxErr = validate.checkNum(d.taxCustomRate, { min: 0, max: 100 }, '税率')
      if (taxErr) {
        wx.showToast({ title: taxErr, icon: 'none' })
        return
      }
    }

    util
      .submit(
        this,
        api.addHolding({
          code: d.picked.code,
          name: d.picked.name,
          market: d.picked.market,
          shares: Number(d.shares),
          buyDate: d.buyDate,
          fee: Number(d.fee) || 0,
          cost: d.realCost,
          costMode: d.costModes[d.costModeIndex],
          negativeCost: d.negativeCost,
          divMode: d.divModes[d.divModeIndex],
          customDividend: d.divModeIndex === 3 ? Number(d.customDividend) || 0 : 0,
          price: d.detail ? d.detail.price : 0,
          priceDate: d.detail ? d.detail.priceDate : '',
          baseDps: d.detail && d.detail.dividend ? d.detail.dividend.dps : 0,
          dpsByMode: d.detail && d.detail.dividend ? d.detail.dividend.dpsByMode : null,
          taxRate: this.currentTaxRate(),
          taxOn: d.taxOn
        }),
        { loadingText: '添加中', success: '已添加' }
      )
      .then((res) => {
        if (!res) return
        util.backLater(this, 700)
        // 返回上一个页面后，持仓页的 onShow 会重新拉数据
      })
  }

  /* ================= 渲染 ================= */

  renderPills(options, activeIndex, onPick, labelOf) {
    return (
      <View style={styles.pillRow}>
        {options.map((o, i) => (
          <Pressable
            key={labelOf(o, i)}
            style={[styles.pill, i === activeIndex ? styles.pillOn : null]}
            onPress={() => onPick(i)}
          >
            <Text style={[s.small, i === activeIndex ? styles.pillTextOn : null]}>{labelOf(o, i)}</Text>
          </Pressable>
        ))}
      </View>
    )
  }

  render() {
    const d = this.data

    if (d.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={s.mid}>加载中…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {/* 1. 选择标的 */}
          <Text style={styles.secTitle}>1 选择标的</Text>

          {d.stockPicked && d.picked ? (
            <View style={s.card}>
              <View style={s.between}>
                <View style={s.row}>
                  <Text style={s.bold}>{d.picked.name}</Text>
                  <Text style={[s.tag, styles.marketTag, { marginLeft: 8 }]}>{d.picked.marketTag}</Text>
                </View>
                <Pressable onPress={() => this.onRepick()}>
                  <Text style={{ color: colors.primary, fontSize: 13 }}>重新选择</Text>
                </Pressable>
              </View>
              <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{d.picked.code}</Text>

              {d.detailLoading ? (
                <Text style={[s.small, s.dim, { marginTop: 12 }]}>正在获取行情…</Text>
              ) : d.detail ? (
                <View style={styles.quoteBox}>
                  <Text style={styles.quotePrice}>{d.detail.priceText || d.detail.price}</Text>
                  <Text style={[s.small, { marginLeft: 8, color: (d.detail.change || 0) >= 0 ? colors.up : colors.primary }]}>
                    {d.detail.changeText || ''} {d.detail.changeRateText || ''}
                  </Text>
                  <Pressable style={{ marginLeft: 'auto' }} onPress={() => this.onRefreshQuote()}>
                    <Text style={[s.tiny, { color: colors.primary }]}>刷新</Text>
                  </Pressable>
                </View>
              ) : d.detailNote ? (
                <Text style={[s.tiny, styles.warn, { marginTop: 10 }]}>{d.detailNote}</Text>
              ) : null}
            </View>
          ) : (
            <View style={s.card}>
              <View style={styles.pillRow}>
                {d.markets.map((m, i) => (
                  <Pressable
                    key={m.key}
                    style={[styles.pill, i === d.marketIndex ? styles.pillOn : null]}
                    onPress={() => this.onMarket(tap({ i: i }))}
                  >
                    <Text style={[s.small, i === d.marketIndex ? styles.pillTextOn : null]}>{m.label || m.tag}</Text>
                  </Pressable>
                ))}
                <Pressable style={styles.pill} onPress={() => this.onCustom()}>
                  <Text style={s.small}>自定义</Text>
                </Pressable>
              </View>

              <TextInput
                style={[s.input, { marginTop: 12 }]}
                value={d.keyword}
                onChangeText={(v) => this.onSearchInput(val(v))}
                placeholder="输入代码 / 名称 / 拼音首字母"
                placeholderTextColor={colors.t3}
              />

              {d.results.map((item) => (
                <Pressable
                  key={item.market + '-' + item.code}
                  style={styles.resultRow}
                  onPress={() => this.onPickStock(tap({ code: item.code, market: item.market }))}
                >
                  <View style={s.flex1}>
                    <Text style={s.mid}>{item.name}</Text>
                    <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{item.code}</Text>
                  </View>
                  <Text style={[s.tiny, s.dim]}>{item.marketTag}</Text>
                </Pressable>
              ))}

              {d.noResult ? (
                <Text style={[s.small, s.dim, { marginTop: 14 }]}>
                  没搜到？可以点「自定义」自己填代码、名称与每股派息
                </Text>
              ) : null}
            </View>
          )}

          {/* 2. 持仓信息 */}
          {d.stockPicked ? (
            <View>
              <Text style={styles.secTitle}>2 持仓信息</Text>
              <View style={s.card}>
                <Text style={[s.tiny, s.dim]}>持仓数量（股）</Text>
                <TextInput
                  style={[s.input, { marginTop: 8 }]}
                  value={String(d.shares)}
                  onChangeText={(v) => this.onShares(val(v))}
                  keyboardType="decimal-pad"
                  placeholder="1000"
                  placeholderTextColor={colors.t3}
                />

                <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>
                  当前成本（每股，{d.nativeName || ''}）
                </Text>
                <View style={s.row}>
                  {d.showCostMinus ? <Text style={[styles.minus, { marginTop: 8 }]}>-</Text> : null}
                  <TextInput
                    style={[s.input, { flex: 1, marginTop: 8 }]}
                    value={String(d.cost)}
                    onChangeText={(v) => this.onCost(val(v))}
                    keyboardType="decimal-pad"
                    placeholder="6.07"
                    placeholderTextColor={colors.t3}
                  />
                </View>

                <View style={[s.row, { marginTop: 12 }]}>
                  <Pressable style={styles.checkRow} onPress={() => this.toggleNegative()}>
                    <View style={[styles.checkbox, d.negativeCost ? styles.checkboxOn : null]} />
                    <Text style={[s.small, { marginLeft: 6 }]}>负成本</Text>
                  </Pressable>
                  <Pressable style={{ marginLeft: 'auto' }} onPress={() => this.onCostModeHelp()}>
                    <Text style={[s.tiny, { color: colors.primary }]}>口径说明</Text>
                  </Pressable>
                </View>

                {this.renderPills(
                  d.costModes,
                  d.costModeIndex,
                  (i) => this.onCostMode(tap({ i: i })),
                  (o) => o
                )}

                <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>买入日期</Text>
                {/* 原生滚轮日期选择器（组件自带「今天」），与成交 / 入账日期保持一致 */}
                <DateField
                  value={String(d.buyDate)}
                  placeholder="选择买入日期"
                  onChange={(v) => this.onDateChange(val(v))}
                />

                <Text style={[s.tiny, s.dim, { marginTop: 14 }]}>手续费（可选）</Text>
                <TextInput
                  style={[s.input, { marginTop: 8 }]}
                  value={String(d.fee)}
                  onChangeText={(v) => this.onFee(val(v))}
                  keyboardType="decimal-pad"
                  placeholder="5"
                  placeholderTextColor={colors.t3}
                />
              </View>

              {/* 3. 分红预测口径 */}
              <Text style={styles.secTitle}>3 分红预测口径</Text>
              <View style={s.card}>
                {this.renderPills(
                  [0, 1, 2, 3],
                  d.divModeIndex,
                  (i) => this.onDivMode(tap({ i: i })),
                  (o, i) => ['近1年', '近3年', '近5年', '自定义'][i]
                )}

                {d.divModeIndex === 3 ? (
                  <TextInput
                    style={[s.input, { marginTop: 12 }]}
                    value={String(d.customDividend)}
                    onChangeText={(v) => this.onCustomDividend(val(v))}
                    keyboardType="decimal-pad"
                    placeholder={'每股派息（' + (d.nativeName || '') + '），如 0.41'}
                    placeholderTextColor={colors.t3}
                  />
                ) : null}

                <Pressable style={[s.between, { marginTop: 14 }]} onPress={() => this.onDivDetail()}>
                  <Text style={[s.small, { flex: 1 }]}>{d.divTip}</Text>
                  <Text style={[s.mid, { color: colors.primary, fontWeight: '600' }]}>
                    {d.dividendText}
                  </Text>
                </Pressable>
               </View>

              {/* 4. 分红税率 */}
              <Text style={styles.secTitle}>4 分红税率</Text>
              <View style={s.card}>
                <View style={s.between}>
                  <Text style={[s.small, s.bold]}>按你的实际开户方式选择</Text>
                  <Pressable onPress={() => this.onTaxHelp()}>
                    <Text style={[s.tiny, { color: colors.primary }]}>说明</Text>
                  </Pressable>
                </View>

                {this.renderPills(
                  d.taxOptions,
                  d.taxIndex,
                  (i) => this.onTax(tap({ i: i })),
                  (o) => (o.rate === null ? '自定义' : o.label || o.rate + '%')
                )}

                {d.taxCustom ? (
                  <TextInput
                    style={[s.input, { marginTop: 12 }]}
                    value={String(d.taxCustomRate)}
                    onChangeText={(v) => this.onTaxCustom(val(v))}
                    keyboardType="decimal-pad"
                    placeholder="税率 %"
                    placeholderTextColor={colors.t3}
                  />
                ) : null}

                {d.taxTip ? <Text style={[s.tiny, s.dim, { marginTop: 10 }]}>{d.taxTip}</Text> : null}

                <Pressable style={[s.row, { marginTop: 12 }]} onPress={() => this.toggleTaxOn()}>
                  <View style={[styles.checkbox, d.taxOn ? styles.checkboxOn : null]} />
                  <Text style={[s.small, { marginLeft: 6 }]}>预测分红时扣除红利税</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          <View style={{ height: 40 }} />
        </ScrollView>

        <View style={styles.bottomBar}>
          <Pressable
            style={[s.btn, s.flex1, d.canSubmit ? null : styles.btnOff]}
            onPress={() => this.confirm()}
            disabled={!d.canSubmit}
          >
            <Text style={s.btnText}>添加持仓</Text>
          </Pressable>
        </View>

        {/* 自定义标的面板 */}
        {d.customOpen ? (
          <View style={styles.overlay}>
            <View style={styles.sheet}>
              <View style={s.between}>
                <Text style={s.h3}>自定义标的</Text>
                <Pressable onPress={() => this.onCustomHelp()}>
                  <Text style={[s.tiny, { color: colors.primary }]}>说明</Text>
                </Pressable>
              </View>

              <TextInput
                style={[s.input, { marginTop: 14 }]}
                value={d.cf.code}
                onChangeText={(v) => this.onCfInput(Object.assign(tap({ field: 'code' }), val(v)))}
                placeholder="代码"
                placeholderTextColor={colors.t3}
              />
              <TextInput
                style={[s.input, { marginTop: 10 }]}
                value={d.cf.name}
                onChangeText={(v) => this.onCfInput(Object.assign(tap({ field: 'name' }), val(v)))}
                placeholder="名称"
                placeholderTextColor={colors.t3}
              />
              <TextInput
                style={[s.input, { marginTop: 10 }]}
                value={String(d.cf.dps)}
                onChangeText={(v) => this.onCfInput(Object.assign(tap({ field: 'dps' }), val(v)))}
                keyboardType="decimal-pad"
                placeholder={'每股派息（' + (d.nativeName || '') + '）'}
                placeholderTextColor={colors.t3}
              />

              <View style={[s.row, { marginTop: 18 }]}>
                <Pressable style={[s.btn, s.flex1, styles.btnGhost]} onPress={() => this.closeCustom()}>
                  <Text style={[s.btnText, { color: colors.t2 }]}>取消</Text>
                </Pressable>
                <View style={{ width: 12 }} />
                <Pressable style={[s.btn, s.flex1]} onPress={() => this.onCfSubmit()}>
                  <Text style={s.btnText}>确定</Text>
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
  secTitle: { marginTop: 22, marginBottom: 10, fontSize: 15, fontWeight: '600', color: colors.t1 },
  marketTag: { backgroundColor: colors.line2, color: colors.t2 },
  warn: { color: colors.orange },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: colors.line2,
    marginRight: 8,
    marginBottom: 8
  },
  pillOn: { backgroundColor: colors.primarySoft },
  pillTextOn: { color: colors.primary, fontWeight: '600' },

  quoteBox: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  quotePrice: { fontSize: 22, fontWeight: '700', color: colors.t1, fontVariant: ['tabular-nums'] },

  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },

  minus: { marginRight: 6, fontSize: 18, color: colors.orange },
  checkRow: { flexDirection: 'row', alignItems: 'center' },
  checkbox: {
    width: 16,
    height: 16,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.t3
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },

  bottomBar: {
    flexDirection: 'row',
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  },
  btnOff: { backgroundColor: '#C9CFCC' },
  btnGhost: { backgroundColor: colors.line2 },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.35)',
    justifyContent: 'center',
    paddingHorizontal: 24
  },
  sheet: { backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20 }
})

module.exports = AddHolding

const api = require('../../utils/api.js')
const util = require('../../utils/util.js')

const DIV_TIPS = [
  '取最近 1 年的分红记录，计算每股派息',
  '取最近 3 年的分红记录，计算每股平均派息',
  '取最近 5 年的分红记录，计算每股平均派息',
  '手动填写每股派息金额'
]

// 输入即搜：停止输入 300ms 后才发请求，避免每个字符都打一次接口
const SEARCH_DEBOUNCE = 300

Page({
  data: {
    loading: true,
    submitting: false,

    /* ---------- 1. 选择股票 ---------- */
    markets: [],
    marketIndex: 0,
    keyword: '',
    results: [],
    noResult: false,
    picked: null,
    stockPicked: false,

    /* ---------- 1.1 标的实时数据（行情 + 分红档案） ---------- */
    detail: null,
    detailLoading: false,
    detailNote: '',
    archiveOpen: false,

    /* ---------- 2. 持仓信息 ---------- */
    shares: '',
    buyDate: '',
    fee: '',
    costModes: [],
    costModeIndex: 0,
    cost: '',
    negativeCost: false,
    showCostMinus: false,
    realCost: 0,

    /* ---------- 3. 分红预测口径 ---------- */
    divModes: [],
    divModeIndex: 0,
    divTip: DIV_TIPS[0],
    customDividend: '',
    dividendText: '--',
    // 该口径下没有真实派息记录时，右侧不显示金额而是给一句说明
    dividendEmpty: true,

    /* ---------- 4. 分红税率（逐只可配） ---------- */
    taxOptions: [],
    taxTips: {},
    defaultTaxRates: {},
    taxIndex: 0,
    taxCustom: false,
    taxCustomRate: '',
    taxOn: true,
    taxTip: '',

    // 显示货币符号：自填每股派息时用来拼预览文案
    symbol: '',

    // 自定义标的面板
    customOpen: false,
    cf: { code: '', name: '', dps: '' },

    canSubmit: false
  },

  onLoad(options) {
    // 榜单 / 工具页 / 发现页搜索会带 ?code= 跳进来，加载完选项后直接回填，省掉一次搜索
    this.prefillCode = (options && options.code) || ''
    // 同一代码可能跨市场（如 000756 既是深A也是场外基金），带上 market 才能取对标的
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
        // 先按当前市场标签套一档税率，选完股票后会跟着标的真实市场再套一次
        this.applyDefaultTax((d.markets[0] || {}).key)
        if (this.prefillCode) this.applyPrefill(this.prefillCode, this.prefillMarket)
      })
      .catch(util.onError)
  },

  applyPrefill(code, market) {
    // 带了市场就按 code + market 精确取详情；否则退回按代码猜市场
    const req = market ? api.getStockDetail({ code, market }) : api.getStockByCode(code)
    req
      .then((res) => {
        // getStockByCode 返回的已是完整详情（行情 + 分红档案），不用再拉一次
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
      // 取不到行情时提示原因（多半是域名白名单 / 代码不存在），用户仍可继续手填
      .catch((e) => {
        wx.showToast({ title: (e && e.msg) || '行情获取失败', icon: 'none' })
      })
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    util.cancelBack(this)
  },

  /* ================= 标的实时数据：行情 + 分红档案 =================
   * 选中标的后拉一次详情，数据全部来自实时接口（东方财富）：
   * 最新价、涨跌、税后股息率 + 真实历史分红记录。
   * seq 用于丢弃过期响应：连续换股时只认最后一次请求的结果。
   */
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
        // 分红档案里的真实派息会作为分红预测口径的基数
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
  },

  // 手动刷新一次行情，盘中想看重时价时用
  onRefreshQuote() {
    if (this.data.picked) this.loadDetail(this.data.picked)
  },

  // 自定义标的：没有行情源与分红记录，直接给一句说明
  clearDetail(note) {
    this.detailSeq = (this.detailSeq || 0) + 1
    this.setData({
      detail: null,
      detailLoading: false,
      detailNote: note || '',
      archiveOpen: false
    })
  },

  toggleArchive() {
    this.setData({ archiveOpen: !this.data.archiveOpen })
  },

  /* ================= 1. 选择股票 ================= */
  onMarket(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i === this.data.marketIndex) return
    this.setData({ marketIndex: i, results: [] })
    // 换市场等于重新选标的，税率跟着回到该市场的默认档
    this.applyDefaultTax((this.data.markets[i] || {}).key)
    this.doSearch()
  },

  /* 自定义标的：标的池里没有的股票（打新、场外基金等）自己填 */
  onCustom() {
    this.setData({ customOpen: true, cf: { code: '', name: '', dps: '' } })
  },

  onCustomHelp() {
    wx.showModal({
      title: '自定义标的',
      content: '标的池里查不到的股票，可以自己填代码、名称与每股派息，市场按当前所选标签归属。',
      showCancel: false
    })
  },

  closeCustom() {
    this.setData({ customOpen: false })
  },

  onCfInput(e) {
    const field = e.currentTarget.dataset.field
    const cf = Object.assign({}, this.data.cf)
    cf[field] = e.detail.value
    this.setData({ cf })
  },

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
      // 补上市场徽标，已选那一行的样式与搜索选中的标的保持一致
      picked: {
        code,
        name,
        market: m.key || 'A',
        marketTag: m.tag || '',
        tagClass: m.cls || 'tag-gray',
        dps,
        custom: true
      },
      stockPicked: true,
      keyword: name,
      results: [],
      noResult: false,
      // 自定义标的没有历史分红可取，直接按手填的每股派息算
      divModeIndex: 3,
      divTip: DIV_TIPS[3],
      customDividend: cf.dps,
      dividendText: this.data.symbol + util.money(dps, 4)
    })
    this.applyDefaultTax(m.key || 'A')
    this.clearDetail('自定义标的：无行情与分红档案，分红按手填每股派息计算')
    this.refreshState()
  },

  /* ================= 1. 搜索（输入即搜） ================= */
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })
    this.scheduleSearch()
  },

  // 防抖：连续输入时只让最后一次落到接口，输入过程依然保持"实时"手感
  scheduleSearch() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.doSearch()
    }, SEARCH_DEBOUNCE)
  },

  doSearch() {
    // 清空关键字时直接收起下拉，不显示空态
    if (!String(this.data.keyword).trim()) {
      this.searchSeq = (this.searchSeq || 0) + 1
      this.setData({ results: [], noResult: false })
      return
    }

    // 只有最后一次请求的结果会被写回，避免快速输入时旧结果覆盖新结果
    this.searchSeq = (this.searchSeq || 0) + 1
    const seq = this.searchSeq
    const market = (this.data.markets[this.data.marketIndex] || {}).key

    api
      .searchStocks({ market, keyword: this.data.keyword })
      .then((res) => {
        if (seq !== this.searchSeq) return
        this.setData({
          results: res.data,
          noResult: res.data.length === 0
        })
      })
      .catch(util.onError)
  },

  onPickStock(e) {
    const ds = e.currentTarget.dataset
    // 同一代码在不同市场都存在（如 000756 既是深A股票也是场外基金），按 code + market 双条件定位
    const stock = this.data.results.filter((s) => s.code === ds.code && s.market === ds.market)[0]
    if (!stock) return

    // 市场标签自动跟到标的真实市场，避免搜到港股却按 A股 提交
    const marketIndex = Math.max(
      0,
      this.data.markets.map((m) => m.key).indexOf(stock.market)
    )

    this.setData({
      picked: stock,
      marketIndex,
      stockPicked: true,
      results: [],
      noResult: false,
      keyword: stock.name
    })
    this.applyDefaultTax(stock.market)
    this.loadDetail(stock)
    this.refreshState()
  },

  // 重新选股
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
  },

  /* ================= 2. 持仓信息 ================= */
  onShares(e) {
    this.setData({ shares: e.detail.value })
    this.refreshState()
  },

  onFee(e) {
    this.setData({ fee: e.detail.value })
  },

  onCost(e) {
    this.setData({ cost: e.detail.value })
    this.refreshCostSign()
    this.refreshState()
  },

  onDateChange(e) {
    this.setData({ buyDate: e.detail.value })
  },

  onCostMode(e) {
    this.setData({ costModeIndex: Number(e.currentTarget.dataset.i) })
  },

  toggleNegative() {
    if (!this.data.stockPicked) return
    this.setData({ negativeCost: !this.data.negativeCost })
    this.refreshCostSign()
  },

  // 勾选负成本后：真实成本改写为负数，并在金额前显示橙色负号
  // cost 仍保留输入框里的原始字符串（供 input 绑定），realCost 才是提交用的真实值
  refreshCostSign() {
    const raw = String(this.data.cost).trim()
    const num = Number(raw)
    const hasValue = raw !== '' && !isNaN(num)

    // 勾选负成本 -> 取绝对值再取负；未勾选 -> 沿用输入值（允许用户手输负号）
    const realCost = hasValue ? (this.data.negativeCost ? -Math.abs(num) : num) : 0

    this.setData({
      // 输入框里已经手输了负号就不再重复渲染橙色的
      showCostMinus: this.data.negativeCost && raw.charAt(0) !== '-',
      realCost: realCost
    })
  },

  onCostModeHelp() {
    wx.showModal({
      title: '成本口径说明',
      content:
        '分红摊薄：已收分红从成本中扣除后的成本\n摊薄成本：按摊薄口径计算的单位成本\n加权平均：多次买入的加权平均成本',
      showCancel: false
    })
  },

  /* ================= 3. 分红预测口径 ================= */
  onDivMode(e) {
    const i = Number(e.currentTarget.dataset.i)
    this.setData({ divModeIndex: i, divTip: DIV_TIPS[i] })
    this.refreshDividend()
  },

  onCustomDividend(e) {
    this.setData({ customDividend: e.detail.value })
    this.refreshDividend()
  },

  onDivHelp() {
    wx.showModal({
      title: '分红预测口径',
      content: '按所选年数取该标的的历史分红记录，估算每股年度派息，用于预测你的年度分红。',
      showCancel: false
    })
  },

  // 「查看计算明细」：把当前口径的取数规则与结果摊开说清楚
  onDivDetail() {
    wx.showModal({
      title: '计算明细',
      content: this.data.divTip + '\n\n本次结果：' + this.data.dividendText,
      showCancel: false
    })
  },

  refreshDividend() {
    const idx = this.data.divModeIndex

    // 自定义口径：直接用手填值
    if (idx === 3) {
      const v = Number(this.data.customDividend)
      this.setData({
        dividendText: v > 0 ? this.data.symbol + util.money(v, 4) : '--',
        dividendEmpty: !(v > 0)
      })
      return
    }

    const code = this.data.picked ? this.data.picked.code : ''
    if (!code) {
      this.setData({ dividendText: '--', dividendEmpty: true })
      return
    }

    // 基数用实时分红档案算出的真实派息，接口没拿到时才退回本地记录
    const detail = this.data.detail
    const baseDps = detail && detail.dividend ? detail.dividend.dps : 0

    api
      .estimateDividend({
        code,
        // 税后口径要按市场扣红利税，页面把真实市场带过去
        market: this.data.picked ? this.data.picked.market : '',
        divModeIndex: idx,
        customDividend: Number(this.data.customDividend) || 0,
        baseDps,
        // 税率 / 扣税开关一改，这里要立刻跟着重算
        taxRate: this.currentTaxRate(),
        taxOn: this.data.taxOn
      })
      .then((res) => {
        const d = res.data
        this.setData({ dividendText: d.dividendText, dividendEmpty: !d.hasDividend })
      })
      .catch(util.onError)
  },

  /* ================= 4. 分红税率 =================
   * 港股与美股的红利税差别很大（港股通 H 股 20%、红筹 28%、券商直投 10%、本地股 0%；
   * 美股一般按协定预扣 10%），所以税率做成逐只可配，默认值只按市场给一个起点。
   */

  // 按市场套用默认税率档位；市场默认值不在预设里时落到「自定义」
  applyDefaultTax(market) {
    const rates = this.data.defaultTaxRates || {}
    const def = rates[market]
    const rate = def === undefined ? 0 : def

    const rates2 = (this.data.taxOptions || []).map((o) => o.rate)
    const hit = rates2.indexOf(rate)
    const customIndex = rates2.length - 1
    const taxIndex = hit === -1 ? customIndex : hit

    this.setData({
      taxIndex,
      taxCustom: taxIndex === customIndex,
      taxCustomRate: taxIndex === customIndex ? String(rate) : '',
      taxTip: (this.data.taxTips || {})[market] || (this.data.taxTips || {}).A || ''
    })
  },

  // 当前生效的税率数值：预设档位直接取，自定义档取输入框
  currentTaxRate() {
    const opt = (this.data.taxOptions || [])[this.data.taxIndex]
    if (opt && opt.rate !== null && opt.rate !== undefined) return opt.rate
    const v = Number(this.data.taxCustomRate)
    return isNaN(v) ? 0 : v
  },

  onTax(e) {
    const i = Number(e.currentTarget.dataset.i)
    const opt = (this.data.taxOptions || [])[i] || {}
    this.setData({ taxIndex: i, taxCustom: opt.rate === null })
    this.refreshDividend()
  },

  onTaxCustom(e) {
    this.setData({ taxCustomRate: e.detail.value })
    this.refreshDividend()
  },

  toggleTaxOn() {
    if (!this.data.stockPicked) return
    this.setData({ taxOn: !this.data.taxOn })
    this.refreshDividend()
  },

  onTaxHelp() {
    wx.showModal({
      title: '分红税率',
      content:
        '股息红利所得税率。港股通 H 股默认 20%，红筹股 28%，香港券商直投 H 股 10%，港股直接持有本地股 0%；美股一般按税收协定预扣 10%；A 股按持股期限差别化征收，长期持有多为免征。\n\n按你的实际开户方式选，拿不准就填一个保守值。',
      showCancel: false
    })
  },

  /* ================= 提交 ================= */
  // 同步底部按钮可用态
  refreshState() {
    const d = this.data
    const picked = !!d.picked
    const hasShares = String(d.shares).trim() !== ''
    const hasCost = String(d.cost).trim() !== ''

    this.setData({ canSubmit: picked && hasShares && hasCost })
  },

  confirm() {
    const d = this.data
    if (!d.picked) {
      wx.showToast({ title: '请先选择股票', icon: 'none' })
      return
    }
    if (String(d.shares).trim() === '') {
      wx.showToast({ title: '请填写持仓数量', icon: 'none' })
      return
    }
    if (String(d.cost).trim() === '') {
      wx.showToast({ title: '请填写当前成本', icon: 'none' })
      return
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
          // 自定义口径下才带手填的每股派息
          customDividend: d.divModeIndex === 3 ? Number(d.customDividend) || 0 : 0,
          // 把实时行情与真实派息一起带进持仓，避免用成本反推现价
          price: d.detail ? d.detail.price : 0,
          priceDate: d.detail ? d.detail.priceDate : '',
          baseDps: d.detail && d.detail.dividend ? d.detail.dividend.dps : 0,
          // 分红税率逐只可配；扣税开关关掉时金额按 0% 算，但档位照存，方便以后改回来
          taxRate: this.currentTaxRate(),
          taxOn: d.taxOn
        }),
        { loadingText: '添加中', success: '已添加' }
      )
      .then((res) => {
        if (!res) return
        util.backLater(this, 700)
      })
  }
})

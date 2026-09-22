const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
// 4.5.x 的 main 是 babel 编译产物，导出的是 { default: Slider } 而不是组件本身，
// 直接 require() 整个模块当组件用会报「Element type is invalid... got: object」
const Slider = require('@react-native-community/slider').default
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

// 三个工具共用一个页面壳，靠 id 分流：t1 复利计算器 / t3 息率对比 / t4 定投回测
const TITLES = { t1: '复利计算器', t3: '息率对比', t4: '定投回测' }

// 「每月定投」的一键预设，与小程序那份一致
const MONTHLY_PRESETS = [0, 3000, 5000, 10000]

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
 * 小程序的 <slider> 在 RN 里用的是 @react-native-community/slider（Expo 收录，SDK 53 → 4.5.6），
 * 拖动时回调一条与小程序一模一样的事件（dataset.field + detail.value），
 * 所以页面的 onCpSlide / onDcaSlide 这些方法可以逐字沿用。
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
        onValueChange={(v) => props.onChange(Object.assign(tap({ field: props.field }), val(v)))}
      />
      {props.children}
    </View>
  )
}

class Tool extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      kind: '',

      // t1
      compound: null,
      cp: { principal: 100000, monthly: 3000, rate: 6, years: 20 },
      cpText: {},

      // t3
      compare: null,

      // t4
      dca: null,
      dcaParams: { code: '', monthly: 3000, years: 10 }
    }
  }

  onLoad(options) {
    const kind = (options && options.id) || 't1'
    wx.setNavigationBarTitle({ title: TITLES[kind] || '工具' })
    this.setData({ kind })

    if (kind === 't3') {
      api
        .getYieldCompare()
        .then((res) => this.setData({ loading: false, compare: res.data }))
        .catch(util.onError)
      return
    }

    if (kind === 't4') {
      // 候选池与「息率对比」同源：先按实时行情 + 真实分红算好，再交给同步的 previewDca
      api
        .ensureYieldPool()
        .then((pool) => {
          this.yieldPool = pool
          const d = api.previewDca(this.data.dcaParams, pool)
          this.setData({
            loading: false,
            dca: d,
            dcaParams: { code: d.code, monthly: d.monthly, years: d.years }
          })
        })
        .catch((e) => {
          this.setData({ loading: false, dca: null })
          util.onError(e)
        })
      return
    }

    this.setData({ loading: false })
    this.refreshCompound()
  }

  /* ---------------- t1 复利计算器 ---------------- */

  // 同步重算，拖动时零延迟
  refreshCompound() {
    const cp = this.data.cp
    this.setData({
      compound: api.previewCompound(cp),
      // 金额文案统一由数据层按显示货币产出，页面只保留百分比与年限
      cpText: { rate: util.money(cp.rate, 1), years: cp.years }
    })
  }

  onCpSlide(e) {
    const field = e.currentTarget.dataset.field
    const value = Number(e.detail.value)
    if (this.data.cp[field] === value) return

    this.setData({ cp: Object.assign({}, this.data.cp, { [field]: value }) })
    this.refreshCompound()
  }

  // 一键切到「只投本金」或「加满月投」，方便对比月投的作用
  onPreset(e) {
    const monthly = Number(e.currentTarget.dataset.monthly)
    this.setData({ cp: Object.assign({}, this.data.cp, { monthly: monthly }) })
    this.refreshCompound()
  }

  /* ---------------- t4 定投回测 ---------------- */

  refreshDca() {
    this.setData({ dca: api.previewDca(this.data.dcaParams, this.yieldPool) })
  }

  onDcaSlide(e) {
    const field = e.currentTarget.dataset.field
    const value = Number(e.detail.value)
    if (this.data.dcaParams[field] === value) return

    this.setData({ dcaParams: Object.assign({}, this.data.dcaParams, { [field]: value }) })
    this.refreshDca()
  }

  onPickStock(e) {
    const code = e.currentTarget.dataset.code
    if (code === this.data.dcaParams.code) return
    this.setData({ dcaParams: Object.assign({}, this.data.dcaParams, { code: code }) })
    this.refreshDca()
  }

  /* ---------------- 通用 ---------------- */

  // 榜单 / 对比里的条目都能直接去添加持仓（带上市场，避免同代码取错标的）
  onAdd(e) {
    const ds = e.currentTarget.dataset
    if (!ds.code) return
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }

  /* ---------------- 渲染 ---------------- */

  renderHero(label, num, sub, tags) {
    return (
      <View style={[s.card, styles.hero]}>
        <Text style={styles.heroLabel}>{label}</Text>
        <Text style={[styles.heroNum, s.num]}>{num}</Text>
        <Text style={styles.heroSub}>{sub}</Text>

        <View style={styles.heroTags}>
          {tags.map((t) => (
            <View key={t.label} style={styles.htag}>
              <Text style={[styles.htagV, s.num]}>{t.value}</Text>
              <Text style={styles.htagL}>{t.label}</Text>
            </View>
          ))}
        </View>
      </View>
    )
  }

  renderCompound() {
    const c = this.data.compound
    const cp = this.data.cp

    return (
      <View>
        {this.renderHero(cp.years + ' 年后可达', c.finalText, '累计投入 ' + c.investedText + ' · 累计收益 ' + c.gainText, [
          { value: c.multipleText, label: '投入产出比（倍）' },
          { value: c.rateText + '%', label: '总收益率' }
        ])}

        <View style={styles.secHead}>
          <Text style={s.h3}>调整参数</Text>
          <Text style={[s.tiny, s.dim, { marginLeft: 12 }]}>拖动即时重算</Text>
        </View>

        <View style={styles.cardFlat}>
          <SliderRow
            name="初始本金"
            valueText={c.principalText}
            min={10000}
            max={1000000}
            step={10000}
            value={cp.principal}
            field="principal"
            onChange={(e) => this.onCpSlide(e)}
          />
          <SliderRow
            name="每月定投"
            valueText={c.monthlyText}
            min={0}
            max={20000}
            step={500}
            value={cp.monthly}
            field="monthly"
            onChange={(e) => this.onCpSlide(e)}
          >
            <View style={styles.quick}>
              {MONTHLY_PRESETS.map((item) => (
                <Pressable
                  key={item}
                  style={[styles.quickBtn, cp.monthly === item ? styles.quickBtnOn : null]}
                  onPress={() => this.onPreset(tap({ monthly: item }))}
                >
                  <Text
                    style={[styles.quickText, cp.monthly === item ? styles.quickTextOn : null]}
                  >
                    {item === 0 ? '不定投' : item}
                  </Text>
                </Pressable>
              ))}
            </View>
          </SliderRow>
          <SliderRow
            name="预期年化"
            valueText={this.data.cpText.rate + '%'}
            min={1}
            max={15}
            step={0.5}
            value={cp.rate}
            field="rate"
            onChange={(e) => this.onCpSlide(e)}
          />
          <SliderRow
            name="持有年限"
            valueText={this.data.cpText.years + ' 年'}
            min={1}
            max={40}
            step={1}
            value={cp.years}
            field="years"
            onChange={(e) => this.onCpSlide(e)}
          />
        </View>

        <View style={styles.secHead}>
          <Text style={s.h3}>增长曲线</Text>
        </View>

        <View style={s.card}>
          <View style={styles.curve}>
            {c.curve.map((item) => (
              <View key={item.label} style={styles.curveCol}>
                <Text style={[styles.curveVal, s.num]}>{item.valueText}</Text>
                <View style={styles.curveBarWrap}>
                  <View style={[styles.curveBar, { height: item.height + '%' }]} />
                </View>
                <Text style={styles.curveLabel}>{item.label}</Text>
              </View>
            ))}
          </View>
          <Text style={styles.curveNote}>按月复利、月投在月末投入，分红全部再投入。</Text>
        </View>
      </View>
    )
  }

  renderCompare() {
    const cmp = this.data.compare

    return (
      <View>
        <Text style={styles.tip}>📊 {cmp.note}</Text>

        <View style={styles.cardFlat}>
          {cmp.list.map((item) => (
            <Pressable
              key={item.code}
              style={styles.cmpRow}
              onPress={() => this.onAdd(tap({ code: item.code, market: item.market }))}
            >
              <View style={[styles.cmpNo, item.rank <= 3 ? styles.cmpNoTop : null]}>
                <Text style={[styles.cmpNoText, item.rank <= 3 ? styles.cmpNoTextTop : null]}>
                  {item.rank}
                </Text>
              </View>

              <View style={[s.flex1, styles.cmpBody]}>
                <View style={s.row}>
                  <Text style={[s.mid, s.bold]}>{item.name}</Text>
                  <Text style={[s.tag, tagStyleOf(item.cls), { marginLeft: 8 }]}>
                    {item.marketLabel}
                  </Text>
                </View>
                <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{item.code}</Text>
                <View style={styles.bar}>
                  <View style={[styles.barIn, { width: item.width + '%' }]} />
                </View>
              </View>

              <Text style={[styles.cmpVal, s.num]}>{item.valueText}%</Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.footTip}>
          点任一条可直接加入持仓。息率按最新价与上一年度真实派息实时计算。
        </Text>
      </View>
    )
  }

  renderDca() {
    const d = this.data.dca

    // 行情没取到时 previewDca 返回 null，给一个明确的重试态
    if (!d) {
      return (
        <View style={[s.card, styles.empty]}>
          <Text style={styles.emptyEmoji}>📉</Text>
          <Text style={styles.emptyTitle}>行情获取失败，请退出后重进</Text>
        </View>
      )
    }

    const dp = this.data.dcaParams

    return (
      <View>
        <View style={styles.secHead}>
          <Text style={s.h3}>选择标的</Text>
          <Text style={[s.tiny, s.dim, { marginLeft: 12 }]}>横向可滑</Text>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pool}>
          {d.pool.map((item) => (
            <Pressable
              key={item.code}
              style={[styles.poolItem, dp.code === item.code ? styles.poolItemOn : null]}
              onPress={() => this.onPickStock(tap({ code: item.code }))}
            >
              <Text style={[styles.poolName, dp.code === item.code ? styles.poolNameOn : null]}>
                {item.name}
              </Text>
              <Text style={[styles.poolYield, s.num, dp.code === item.code ? styles.poolYieldOn : null]}>
                {item.valueText}%
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {this.renderHero(d.name + ' · 定投 ' + d.years + ' 年', d.valueText, '累计投入 ' + d.investedText + ' · 分红再投入 ' + d.dividendText, [
          { value: d.gainRateText + '%', label: '累计收益率' },
          { value: d.annualText + '%', label: '年化收益率' },
          { value: d.sharesText, label: '期末份额' }
        ])}

        <View style={styles.secHead}>
          <Text style={s.h3}>调整参数</Text>
        </View>

        <View style={styles.cardFlat}>
          <SliderRow
            name="每月定投"
            valueText={d.monthlyText}
            min={500}
            max={20000}
            step={500}
            value={dp.monthly}
            field="monthly"
            onChange={(e) => this.onDcaSlide(e)}
          />
          <SliderRow
            name="定投年限"
            valueText={dp.years + ' 年'}
            min={1}
            max={30}
            step={1}
            value={dp.years}
            field="years"
            onChange={(e) => this.onDcaSlide(e)}
          />
          <Text style={styles.paramNote}>
            按该标的的税后股价息率 {d.yieldText} 逐年分红并再投入，股价按年化 {d.priceGrowth}% 增长推演。
          </Text>
        </View>

        <View style={styles.secHead}>
          <Text style={s.h3}>逐年明细</Text>
        </View>

        <View style={styles.cardFlat}>
          <View style={styles.dcaHead}>
            <Text style={styles.dcaC1}>年度</Text>
            <Text style={styles.dcaC2}>累计投入</Text>
            <Text style={styles.dcaC3}>期末市值</Text>
            <Text style={styles.dcaC4}>累计分红</Text>
          </View>
          {d.rows.map((item) => (
            <View key={item.year} style={styles.dcaRow}>
              <Text style={styles.dcaC1}>{item.label}</Text>
              <Text style={[styles.dcaC2, s.num]}>{item.investedText}</Text>
              <Text style={[styles.dcaC3, s.num]}>{item.valueText}</Text>
              <Text style={[styles.dcaC4, s.num, styles.up]}>{item.dividendText}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.footTip}>
          回测为简化模型：假设分红政策稳定、无税费差异与汇率波动，结果仅供横向比较参考。
        </Text>
      </View>
    )
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={s.page}>
          <View style={[s.card, styles.empty]}>
            <Text style={styles.emptyEmoji}>🧮</Text>
            <Text style={styles.emptyTitle}>正在加载…</Text>
          </View>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {this.data.kind === 't3' ? this.renderCompare() : null}
          {this.data.kind === 't4' ? this.renderDca() : null}
          {this.data.kind === 't1' ? this.renderCompound() : null}
        </ScrollView>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  /* ---------- 结果主卡 ---------- */
  // 小程序这里是一段渐变（#323232 → #1C1C1C），RN 没有 CSS 渐变且不加依赖，用同一色系的深底
  hero: { padding: 18, backgroundColor: '#262626' },
  heroLabel: { fontSize: 12.5, color: 'rgba(255,255,255,0.72)' },
  heroNum: { marginTop: 8, fontSize: 34, fontWeight: '700', lineHeight: 40, color: '#FFFFFF' },
  heroSub: { marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.78)' },
  heroTags: {
    flexDirection: 'row',
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.16)'
  },
  htag: { flex: 1 },
  htagV: { fontSize: 16, fontWeight: '700', color: '#FFFFFF' },
  htagL: { marginTop: 4, fontSize: 10, color: 'rgba(255,255,255,0.66)' },

  /* ---------- 参数滑块 ---------- */
  secHead: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 10,
    paddingHorizontal: 4
  },
  cardFlat: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 2
  },
  slRow: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  slName: { fontSize: 13, color: colors.t2 },
  slVal: { fontSize: 14, fontWeight: '700', color: colors.primary },
  slider: { height: 32, marginLeft: -7, marginRight: -7 },
  quick: { flexDirection: 'row', marginTop: 2 },
  quickBtn: {
    paddingHorizontal: 11,
    paddingVertical: 4,
    marginRight: 7,
    borderRadius: 999,
    backgroundColor: '#EFF2F1'
  },
  quickBtnOn: { backgroundColor: 'rgba(31, 157, 107, 0.12)' },
  quickText: { fontSize: 11, color: colors.t2 },
  quickTextOn: { color: colors.primary, fontWeight: '600' },
  paramNote: {
    marginTop: 11,
    marginBottom: 12,
    paddingVertical: 10,
    paddingHorizontal: 11,
    borderRadius: 10,
    backgroundColor: '#F7F9F8',
    fontSize: 11,
    lineHeight: 19,
    color: colors.t2
  },

  /* ---------- 增长曲线 ---------- */
  curve: { flexDirection: 'row', alignItems: 'flex-end' },
  curveCol: { flex: 1, alignItems: 'center' },
  curveVal: { marginBottom: 5, fontSize: 9, color: colors.t3 },
  // 统一的柱高基准（170rpx），柱子按百分比在其中生长
  curveBarWrap: { height: 85, justifyContent: 'flex-end' },
  curveBar: { width: 13, borderTopLeftRadius: 4, borderTopRightRadius: 4, backgroundColor: colors.primary },
  curveLabel: { marginTop: 6, fontSize: 9, color: colors.t3 },
  curveNote: {
    marginTop: 13,
    paddingTop: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    fontSize: 11,
    color: colors.t3
  },

  /* ---------- 息率对比 ---------- */
  tip: { marginTop: 12, fontSize: 12, lineHeight: 20, color: colors.t2, paddingHorizontal: 4 },
  cmpRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  cmpNo: {
    width: 23,
    height: 23,
    marginRight: 10,
    borderRadius: 999,
    backgroundColor: '#EFF2F1',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  cmpNoTop: { backgroundColor: colors.primary },
  cmpNoText: { fontSize: 11.5, fontWeight: '600', color: colors.t2 },
  cmpNoTextTop: { color: '#FFFFFF' },
  cmpBody: { minWidth: 0 },
  bar: { marginTop: 7, height: 4, borderRadius: 999, backgroundColor: '#EFF2F1', overflow: 'hidden' },
  barIn: { height: '100%', borderRadius: 999, backgroundColor: colors.primary },
  cmpVal: { marginLeft: 10, fontSize: 16, fontWeight: '700', color: colors.t1, flexShrink: 0 },

  /* ---------- 定投标的池 ---------- */
  pool: { marginBottom: 16 },
  poolItem: {
    paddingHorizontal: 13,
    paddingVertical: 10,
    marginRight: 8,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    alignItems: 'center'
  },
  poolItemOn: { borderColor: colors.primary, backgroundColor: 'rgba(31, 157, 107, 0.08)' },
  poolName: { fontSize: 12.5, color: colors.t1 },
  poolNameOn: { color: colors.primary, fontWeight: '600' },
  poolYield: { marginTop: 4, fontSize: 11, color: colors.t3 },
  poolYieldOn: { color: colors.primary },

  /* ---------- 逐年明细 ---------- */
  dcaHead: {
    flexDirection: 'row',
    paddingBottom: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    fontSize: 10.5,
    color: colors.t3
  },
  dcaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    fontSize: 12,
    color: colors.t1
  },
  // 四列定宽，数字列右对齐并等宽，便于纵向比对
  dcaC1: { width: 55, flexShrink: 0 },
  dcaC2: { flex: 1, textAlign: 'right' },
  dcaC3: { flex: 1.1, textAlign: 'right', fontWeight: '600' },
  dcaC4: { flex: 1, textAlign: 'right' },
  up: { color: colors.primary },

  footTip: { marginTop: 15, paddingHorizontal: 4, fontSize: 11, lineHeight: 19, color: colors.t3 }
})

module.exports = Tool

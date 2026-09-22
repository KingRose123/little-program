const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet, Animated, Easing } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

const TITLES = { trade: '交易明细', dividend: '分红记录', file: '分红档案' }

// 市场徽标：数据层给的是小程序的全局 class（tag-green…），RN 没有全局 class，
// 这里映射成等价样式（配色取 app.wxss 的 .tag-*）
const TAG_STYLES = {
  'tag-green': { backgroundColor: 'rgba(31, 157, 107, 0.10)', color: colors.primary },
  'tag-gold': { backgroundColor: 'rgba(217, 169, 60, 0.16)', color: '#9C7A1E' },
  'tag-blue': { backgroundColor: 'rgba(59, 130, 196, 0.12)', color: '#3B82C4' },
  'tag-orange': { backgroundColor: 'rgba(224, 137, 44, 0.14)', color: '#E0892C' },
  'tag-gray': { backgroundColor: colors.line2, color: colors.t3 }
}
const tagStyleOf = (cls) => TAG_STYLES[cls] || TAG_STYLES['tag-gray']

// 悬浮「记一笔」按钮的文案：分红档案是只读的，没有可添加的记录
function addLabelOf(tab) {
  if (tab === 'trade') return '添加交易'
  if (tab === 'dividend') return '添加分红'
  return ''
}

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/** 持仓记录：交易明细 / 分红记录 / 分红档案 三个页签。逻辑与小程序一致。 */
class HoldingRecord extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      holding: null,
      // 已归档标的的记录页是只读的（收起记一笔与删除），见 apply
      archived: false,
      tab: 'trade',
      tabs: [],
      trade: [],
      dividend: [],
      file: [],
      fileTotalText: '',
      filePassedText: '',
      fileSource: '',
      fileEmptyText: '',
      receivedText: '',

      addLabel: '',
      fabReady: false
    }

    // 悬浮按钮的入场动效（0=初始态，1=落定），与小程序 .add-fab / .in 对应
    this.fabAnim = new Animated.Value(0)
    this.glowAnim = new Animated.Value(0)
  }

  onLoad(options) {
    this.id = (options && options.id) || ''
    const tab = (options && options.tab) || 'trade'
    // 标题交给导航头（小程序里是 setNavigationBarTitle）
    wx.setNavigationBarTitle({ title: TITLES[tab] || '持仓记录' })
    this.setData({ tab: tab })
    this.load()
  }

  // 从「添加交易」/「添加分红」返回时明细已变，重新拉一次
  onShow() {
    if (!this.data.loading) this.load()
  }

  load() {
    return api
      .getHoldingRecords(this.id)
      .then((res) => this.apply(res.data))
      .catch(util.onError)
  }

  apply(d) {
    // 归档的标的是只读的：既不给「记一笔」，也不给「删除」——
    // 投资档案是复盘台，不是编辑台。何况从档案页进来时那两个入口点下去
    // 本来就取不到持仓（AddTrade 会直接报「未找到该持仓」），留着只会误导。
    const archived = !!d.archived

    this.setData({
      loading: false,
      archived: archived,
      holding: d.holding,
      trade: d.trade,
      dividend: d.dividend,
      file: d.file,
      fileTotalText: d.fileTotalText,
      filePassedText: d.filePassedText,
      fileSource: d.fileSource || '',
      fileEmptyText: d.fileEmptyText || '',
      receivedText: d.receivedText,
      addLabel: archived ? '' : addLabelOf(this.data.tab),
      tabs: [
        { key: 'trade', label: '交易明细', count: d.trade.length },
        { key: 'dividend', label: '分红记录', count: d.dividend.length },
        { key: 'file', label: '分红档案', count: d.file.length }
      ]
    })

    // 悬浮按钮的入场：先渲染初始态，下一帧再点亮（否则过渡不会跑）
    if (!this.fabAnimated) {
      this.fabAnimated = true
      this.fabTimer = setTimeout(() => {
        if (!this.data.loading) this.animateFab()
      }, 80)
    }
  }

  /**
   * 入场动效照抄小程序的 CSS：
   *   .add-fab      opacity 0.34s ease, transform 0.42s cubic-bezier(.22,1.18,.36,1)
   *   .add-fab.in   animation: fab-glow 0.9s ease-out 0.2s  —— 落定后扩散一圈光晕
   */
  animateFab() {
    this.setData({ fabReady: true })

    Animated.timing(this.fabAnim, {
      toValue: 1,
      duration: 420,
      easing: Easing.bezier(0.22, 1.18, 0.36, 1),
      useNativeDriver: true
    }).start()

    Animated.sequence([
      Animated.delay(200),
      Animated.timing(this.glowAnim, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true
      })
    ]).start()
  }

  onUnload() {
    if (this.fabTimer) clearTimeout(this.fabTimer)
  }

  onTab(key) {
    if (key === this.data.tab) return
    wx.setNavigationBarTitle({ title: TITLES[key] || '持仓记录' })
    // 切页签也要带上只读判断，否则归档标的切回「交易明细」时按钮又冒出来了
    this.setData({ tab: key, addLabel: this.data.archived ? '' : addLabelOf(key) })
  }

  /* ---------------- 添加 / 删除记录 ---------------- */

  onAdd() {
    const path =
      this.data.tab === 'dividend' ? '/pages/add-dividend/add-dividend?id=' : '/pages/add-trade/add-trade?id='
    wx.navigateTo({ url: path + this.id })
  }

  onDelRecord(recordId, kind) {
    wx.showModal({
      title: '删除这条记录？',
      content: '删除后不可恢复。',
      confirmColor: '#E5484D',
      success: (r) => {
        if (!r.confirm) return
        const req =
          kind === 'trade'
            ? api.removeTradeRecord(this.id, recordId)
            : api.removeDividendRecord(this.id, recordId)

        req
          .then((res) => {
            this.apply(res.data)
            wx.showToast({ title: '已删除', icon: 'none' })
          })
          .catch(util.onError)
      }
    })
  }

  /* ---------------- 渲染 ----------------
   * 与小程序 pages/holding-record 的 wxml 逐块对齐：
   * 持仓头 → 三个页签 → 交易明细 / 分红记录 / 分红档案 → 悬浮「记一笔」
   */

  renderEmpty(emoji, title, desc) {
    return (
      <View style={[s.page, styles.empty]}>
        <Text style={styles.emptyEmoji}>{emoji}</Text>
        <Text style={styles.emptyTitle}>{title}</Text>
        {desc ? <Text style={styles.emptyDesc}>{desc}</Text> : null}
      </View>
    )
  }

  // 持仓头：先让用户确认自己看的是哪只，再给两个汇总值
  renderHeader() {
    const h = this.data.holding
    if (!h) return null

    return (
      <View style={styles.card}>
        <View style={s.row}>
          <View style={styles.stockIco}>
            <Text style={styles.stockIcoText}>{h.icon}</Text>
          </View>
          <View style={[s.flex1, { marginLeft: 6 }]}>
            <View style={s.row}>
              <Text style={s.bold}>{h.name}</Text>
              <Text style={[s.tag, tagStyleOf(h.tagClass), { marginLeft: 4 }]}>{h.marketTag}</Text>
            </View>
            <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>
              {h.code} · 持有 {h.sharesText}
            </Text>
          </View>
        </View>

        <View style={styles.hrMetrics}>
          <View style={s.flex1}>
            <Text style={[styles.hrL]}>预测年分红</Text>
            <Text style={[styles.hrV, s.num]}>{h.dividendText}</Text>
          </View>
          <View style={s.flex1}>
            <Text style={styles.hrL}>累计已收</Text>
            <Text style={[styles.hrV, s.num, { color: colors.primary }]}>{this.data.receivedText}</Text>
          </View>
        </View>
      </View>
    )
  }

  renderTabs() {
    return (
      <View style={styles.segs}>
        {this.data.tabs.map((t) => {
          const on = this.data.tab === t.key
          return (
            <Pressable key={t.key} style={[styles.seg, on ? styles.segOn : null]} onPress={() => this.onTab(t.key)}>
              <Text style={[styles.segText, on ? styles.segTextOn : null]}>{t.label}</Text>
              {t.count ? (
                <Text style={[styles.segBadge, on ? styles.segBadgeOn : null]}>{t.count}</Text>
              ) : null}
            </Pressable>
          )
        })}
      </View>
    )
  }

  renderTrade() {
    return (
      <View>
        <View style={styles.cardFlat}>
          {this.data.trade.map((item) => (
            <View key={item.id} style={styles.recRow}>
              <Text style={[styles.recDate, s.num]}>{item.date}</Text>
              <View style={styles.recBody}>
                <View style={s.row}>
                  <Text style={[s.tag, tagStyleOf(item.typeClass)]}>{item.type}</Text>
                  <Text style={[styles.recMain, { marginLeft: 4 }]}>
                    {item.sharesText} × {item.priceText}
                  </Text>
                </View>
                <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>
                  成交金额 {item.amountText} · 手续费 {item.feeText}
                </Text>
                {/* 当时的想法：用左侧竖线引出来，和上面的数字区隔开，
                    一眼能看出这是「人写的」而不是「算出来的」 */}
                {item.note ? (
                  <View style={styles.recNote}>
                    <Text style={[s.tiny, styles.recNoteText]}>{item.note}</Text>
                  </View>
                ) : null}
              </View>
              {!this.data.archived && !item.seed ? (
                <Pressable
                  style={styles.recDel}
                  onPress={() => this.onDelRecord(item.id, 'trade')}
                >
                  <Text style={styles.recDelText}>删除</Text>
                </Pressable>
              ) : null}
            </View>
          ))}
        </View>
        <Text style={styles.note}>第一条为建立持仓时录入的买入记录，不可删除。</Text>
      </View>
    )
  }

  renderDividend() {
    if (!this.data.dividend.length) {
      return (
        <View style={[styles.card, styles.empty]}>
          <Text style={styles.emptyEmoji}>💰</Text>
          <Text style={styles.emptyTitle}>还没有分红到账记录</Text>
          <Text style={styles.emptyDesc}>每次收到分红后记一笔，累计已收会同步更新</Text>
        </View>
      )
    }

    return (
      <View style={styles.cardFlat}>
        {this.data.dividend.map((item) => (
          <View key={item.id} style={styles.recRow}>
            <Text style={[styles.recDate, s.num]}>{item.date}</Text>
            <View style={styles.recBody}>
              <Text style={[styles.recMain, s.bold]}>{item.amountText}</Text>
              <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>
                {item.note}
                {item.planText && item.planText !== '—' ? ' · ' + item.planText : ''}
              </Text>
            </View>
            {!this.data.archived ? (
              <Pressable style={styles.recDel} onPress={() => this.onDelRecord(item.id, 'dividend')}>
                <Text style={styles.recDelText}>删除</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>
    )
  }

  renderFile() {
    return (
      <View>
        <View style={styles.card}>
          <View style={s.between}>
            <View>
              <Text style={[s.tiny, s.dim]}>历次方案合计</Text>
              <Text style={[styles.fileTotal, s.num]}>{this.data.fileTotalText}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={[s.tiny, s.dim]}>已实际到账</Text>
              <Text style={[styles.fileTotal, s.num, { color: colors.primary }]}>
                {this.data.filePassedText}
              </Text>
            </View>
          </View>
        </View>

        <View style={styles.secHead}>
          <Text style={s.h3}>历年分红方案</Text>
        </View>

        {this.data.file.length ? (
          <View style={styles.cardFlat}>
            {this.data.file.map((item) => (
              <View key={item.key} style={styles.recRow}>
                <View style={styles.fileYear}>
                  <Text style={[styles.fileYearNum, s.num]}>{item.year}</Text>
                  {item.current ? <Text style={styles.fileNow}>最近一次</Text> : null}
                  {!item.current && item.pending ? <Text style={styles.filePending}>已公告</Text> : null}
                </View>
                <View style={styles.recBody}>
                  <Text style={styles.recMain}>{item.planText}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{item.dateText}</Text>
                </View>
                <View style={styles.fileAmt}>
                  <Text style={[styles.fileAmtV, s.num]}>{item.amountText}</Text>
                  <Text style={[s.tiny, s.dim]}>按当前股数</Text>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.note}>{this.data.fileEmptyText}</Text>
        )}

        {this.data.file.length ? (
          <Text style={styles.note}>
            数据来源：{this.data.fileSource}；金额按当前股数与红利税折算，实际以公司公告为准。
          </Text>
        ) : null}
      </View>
    )
  }

  // 悬浮「记一笔」：深色胶囊 + 两条白线画的加号，落定时扩散一圈光晕
  renderFab() {
    if (!this.data.addLabel) return null

    return (
      <View style={styles.fabWrap} pointerEvents="box-none">
        <Animated.View
          pointerEvents="none"
          style={[
            styles.fabGlow,
            {
              opacity: this.glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
              transform: [{ scale: this.glowAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 1.6] }) }]
            }
          ]}
        />

        <Animated.View
          style={[
            styles.addFab,
            {
              opacity: this.fabAnim,
              transform: [
                { translateY: this.fabAnim.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
                { scale: this.fabAnim.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }
              ]
            }
          ]}
        >
          <Pressable style={styles.fabInner} onPress={() => this.onAdd()}>
            <View style={styles.fabPlus}>
              <View style={styles.fabPlusH} />
              <View style={styles.fabPlusV} />
            </View>
            <Text style={styles.fabText}>{this.data.addLabel}</Text>
          </Pressable>
        </Animated.View>
      </View>
    )
  }

  render() {
    if (this.data.loading) return this.renderEmpty('📋', '正在加载记录…')

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={styles.content}>
          {this.renderHeader()}
          {this.renderTabs()}
          {this.data.tab === 'trade' ? this.renderTrade() : null}
          {this.data.tab === 'dividend' ? this.renderDividend() : null}
          {this.data.tab === 'file' ? this.renderFile() : null}

          {/* 只读时说明一句：按钮是「收起」了而不是坏了，并指出想继续记录该去哪 */}
          {this.data.archived ? (
            <Text style={styles.note}>
              这是已归档的标的，记录仅供回看。想继续记一笔，先在档案页点「返回持仓」。
            </Text>
          ) : null}

          <View style={this.data.archived ? styles.bottomSpaceFlat : styles.bottomSpace} />
        </ScrollView>

        {this.renderFab()}
      </View>
    )
  }
}

const styles = StyleSheet.create({
  // 底部给悬浮按钮留位：小程序 .bottom-space 是 200rpx
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 },
  bottomSpace: { height: 100 },
  // 只读时没有悬浮按钮，底部不必留出它的位置
  bottomSpaceFlat: { height: 20 },

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
  emptyDesc: { marginTop: 6, fontSize: 11.5, color: colors.t3 },

  // ---------- 持仓头 ----------
  stockIco: {
    width: 34,
    height: 34,
    borderRadius: 10,
    backgroundColor: 'rgba(31, 157, 107, 0.1)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stockIcoText: { fontSize: 15, fontWeight: '700', color: colors.primary },
  hrMetrics: {
    flexDirection: 'row',
    marginTop: 13,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },
  hrL: { fontSize: 11, color: colors.t3 },
  hrV: { marginTop: 5, fontSize: 16, fontWeight: '700', color: colors.t1 },

  // ---------- 页签 ----------
  segs: { flexDirection: 'row', marginTop: 13, marginBottom: 11 },
  seg: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 13,
    paddingVertical: 7,
    marginRight: 7,
    borderRadius: 999,
    backgroundColor: '#FFFFFF'
  },
  segOn: { backgroundColor: '#232323' },
  segText: { fontSize: 12.5, color: colors.t2 },
  segTextOn: { color: '#FFFFFF', fontWeight: '600' },
  segBadge: {
    marginLeft: 5,
    paddingHorizontal: 6,
    borderRadius: 999,
    backgroundColor: colors.line2,
    fontSize: 9.5,
    lineHeight: 16,
    color: colors.t3,
    overflow: 'hidden'
  },
  // 选中态的计数反白，用半透明白底而不是实色，压在深色胶囊上才不跳
  segBadgeOn: { backgroundColor: 'rgba(255, 255, 255, 0.22)', color: '#FFFFFF' },

  // ---------- 记录行 ----------
  recRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  // 日期定宽，多行之间才对得齐（小程序 .rec-date 是 160rpx）
  recDate: { width: 80, fontSize: 11.5, color: colors.t3, flexShrink: 0 },
  recBody: { flex: 1, minWidth: 0 },
  recMain: { fontSize: 13, color: colors.t1 },
  recDel: { paddingLeft: 10, paddingVertical: 4, flexShrink: 0 },
  recDelText: { fontSize: 11.5, color: colors.t3 },
  // 「当时的想法」：左侧竖线把它和上面的数字区分开 ——
  // 一眼能看出这是人写的，不是算出来的
  recNote: { marginTop: 6, paddingLeft: 8, borderLeftWidth: 2, borderLeftColor: '#D3E3DA' },
  recNoteText: { lineHeight: 18, color: colors.t2 },
  note: { paddingTop: 12, paddingHorizontal: 4, fontSize: 11, lineHeight: 19, color: colors.t3 },

  // ---------- 分红档案 ----------
  secHead: { marginTop: 18, marginBottom: 10, paddingHorizontal: 4 },
  fileTotal: { marginTop: 4, fontSize: 20, fontWeight: '700', color: colors.t1 },
  fileYear: { width: 75, flexShrink: 0 },
  fileYearNum: { fontSize: 14, fontWeight: '600', color: colors.t1 },
  fileNow: { marginTop: 3, fontSize: 9, color: colors.primary },
  filePending: { marginTop: 3, fontSize: 9, color: '#E0892C' },
  fileAmt: { alignItems: 'flex-end', flexShrink: 0 },
  fileAmtV: { fontSize: 14, fontWeight: '700', color: colors.t1 },

  // ---------- 悬浮「记一笔」----------
  fabWrap: { position: 'absolute', right: 16, bottom: 24, alignItems: 'flex-end' },
  fabGlow: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(35, 35, 35, 0.26)'
  },
  addFab: {
    height: 48,
    borderRadius: 999,
    backgroundColor: '#232323',
    shadowColor: '#000000',
    shadowOpacity: 0.26,
    shadowRadius: 15,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8
  },
  fabInner: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingLeft: 14,
    paddingRight: 17
  },
  // 加号用两条白线画（小程序 .fab-plus），不用字体符号，字号与基线更稳
  fabPlus: { width: 15, height: 15, marginRight: 7, alignItems: 'center', justifyContent: 'center' },
  fabPlusH: { position: 'absolute', width: 15, height: 2, borderRadius: 1, backgroundColor: '#FFFFFF' },
  fabPlusV: { position: 'absolute', width: 2, height: 15, borderRadius: 1, backgroundColor: '#FFFFFF' },
  fabText: { fontSize: 14, fontWeight: '500', color: '#FFFFFF' }
})

module.exports = HoldingRecord

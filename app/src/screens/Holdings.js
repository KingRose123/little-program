const React = require('react')
const { View, Text, ScrollView, Pressable, Modal, StyleSheet, Animated, Easing, Dimensions } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const LoginGuard = require('../components/LoginGuard.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

/**
 * 分红覆盖网格：小程序是「7×84rpx + 7×8rpx 间隙」的固定排布（卡片内容宽 646rpx），
 * RN 端按屏幕宽换算成像素，保证一行刚好排下 7 个。
 * 64 = 页面左右 padding 16×2 + 卡片 padding 16×2
 */
const COV_GAP = 4
const COV_ITEM_W = (Dimensions.get('window').width - 64 - COV_GAP * 7) / 7

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

/**
 * 持仓列表页。
 *
 * 逻辑部分（load / onMarket / 排序分组 / 悬浮菜单）与小程序那份**逐字一致** ——
 * 这是 Page 适配层的收益：只有 render 是重写的。
 */
class Holdings extends MiniPage {
  constructor(props) {
    super(props)
    // 子类的 data 用实例字段（MiniPage 在 componentDidMount 之后才读它）
    this.data = {
      guest: false,
      loading: true,
      expanded: false,

      market: 'A',
      tabList: [],
      rawList: [],
      viewGroups: [],
      listTotal: 0,

      sortOptions: [],
      groupOptions: [],
      sortKey: 'default',
      groupKey: 'none',

      sheetKey: '',
      sheetTitle: '',
      sheetItems: [],

      coverageGrid: [],
      coveredCount: 0,
      totalCount: 0,
      gapText: '0',
      nextName: '',
      nextIcon: '',
      sum: {},

      fabOpen: false,
      fabActions: [
        { key: 'ocr', icon: '📷', label: '截图识别', btnClass: '' },
        { key: 'manual', icon: '✏️', label: '手动添加', btnClass: 'warm' }
      ]
    }

    // ＋ 的旋转（0=收起，1=展开）与两个动作的逐个弹出
    this.fabAnim = new Animated.Value(0)
    this.itemAnims = this.data.fabActions.map(() => new Animated.Value(0))
  }

  /* ---------------- 生命周期 ---------------- */

  onShow() {
    this.boot()
  }

  boot() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false })
      app.toGuide()
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
  }

  load() {
    // 先按 code + market 刷新实时行情（内部有 5 分钟缓存），再拉数据，
    // 这样总市值 / 浮盈 / 市值息率都是用最新价算出来的
    return api
      .refreshHoldingQuotes()
      .catch(() => 0)
      .then(() =>
        Promise.all([api.getSummary(), api.getCoverageBrief(), api.getHoldings(this.data.market)])
      )
      .then((res) => {
        const sum = res[0].data
        const cov = res[1].data
        const hold = res[2].data
        const view = api.buildHoldingGroups(hold.list, this.data.sortKey, this.data.groupKey)

        this.setData({
          loading: false,
          sum: sum,
          coveredCount: cov.coveredCount,
          totalCount: cov.totalCount,
          gapText: cov.gapText,
          nextName: cov.nextName,
          nextIcon: cov.nextIcon,
          coverageGrid: cov.grid,
          market: hold.activeMarket,
          tabList: hold.tabs,
          rawList: hold.list,
          viewGroups: view.groups,
          listTotal: view.total,
          sortOptions: hold.sorts,
          groupOptions: hold.groupOptions
        })
      })
      .catch(util.onError)
  }

  onMarket(key) {
    if (key === this.data.market) return
    this.setData({ market: key })
    api
      .getHoldings(key)
      .then((res) => {
        const d = res.data
        this.setData({ market: d.activeMarket, tabList: d.tabs, rawList: d.list })
        this.applyView()
      })
      .catch(util.onError)
  }

  applyView() {
    const view = api.buildHoldingGroups(this.data.rawList, this.data.sortKey, this.data.groupKey)
    this.setData({ viewGroups: view.groups, listTotal: view.total })
  }

  /* ---------------- 排序 / 分组 ---------------- */

  openSheet(kind) {
    const isSort = kind === 'sort'
    const options = isSort ? this.data.sortOptions : this.data.groupOptions
    if (!options.length) return

    const current = isSort ? this.data.sortKey : this.data.groupKey
    this.setData({
      sheetKey: kind,
      sheetTitle: isSort ? '排序方式' : '分组方式',
      sheetItems: options.map((o) => Object.assign({}, o, { on: o.key === current }))
    })
  }

  closeSheet() {
    if (this.data.sheetKey) this.setData({ sheetKey: '' })
  }

  onSheetPick(key) {
    const isSort = this.data.sheetKey === 'sort'
    const patch = { sheetKey: '' }
    patch[isSort ? 'sortKey' : 'groupKey'] = key

    this.setData(patch)
    this.applyView()
  }

  toggleExpand() {
    this.setData({ expanded: !this.data.expanded })
  }

  goProjection() {
    wx.navigateTo({ url: '/pages/tool/tool?id=t1' })
  }

  goMetricSettings() {
    wx.navigateTo({ url: '/pages/metric-settings/metric-settings' })
  }

  goCoverage() {
    wx.navigateTo({ url: '/pages/coverage/coverage' })
  }

  goDetail(id) {
    wx.navigateTo({ url: '/pages/holding-detail/holding-detail?id=' + id })
  }

  /* ---------------- 悬浮操作菜单 ---------------- */

  toggleFab() {
    const next = !this.data.fabOpen
    this.setData({ fabOpen: next })
    this.animateFab(next)
  }

  closeFab() {
    if (!this.data.fabOpen) return
    this.setData({ fabOpen: false })
    this.animateFab(false)
  }

  /**
   * 悬浮菜单动画，参数照抄小程序的 CSS（app.wxss / holdings.wxss）：
   *   .fab-icon   transform 0.32s ease          —— ＋ 旋转 45° 变 ×
   *   .speed-item 0.42s cubic-bezier(.22,1,.36,1)，延迟 (len-1-index)*120ms
   * 延迟是倒着算的，所以最靠近 ＋ 的那一项先弹出来，这里同样倒序排。
   */
  animateFab(open) {
    Animated.timing(this.fabAnim, {
      toValue: open ? 1 : 0,
      duration: 320,
      easing: Easing.out(Easing.ease),
      useNativeDriver: true
    }).start()

    const items = this.itemAnims
      .map((v) =>
        Animated.timing(v, {
          toValue: open ? 1 : 0,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true
        })
      )
      .reverse()

    Animated.stagger(120, items).start()
  }

  onFabAction(key) {
    this.closeFab()

    if (key === 'manual') {
      wx.navigateTo({ url: '/pages/add-holding/add-holding' })
      return
    }

    // 截图识别要依赖服务端 OCR，未接入前如实说明，并把用户引导到手动添加
    wx.showModal({
      title: '截图识别',
      content: '截图识别需要接入 OCR 服务，当前版本尚未开放。可以先用「手动添加」录入持仓。',
      confirmText: '手动添加',
      cancelText: '知道了',
      success: (res) => {
        if (res.confirm) wx.navigateTo({ url: '/pages/add-holding/add-holding' })
      }
    })
  }

  onHide() {
    this.closeFab()
    this.closeSheet()
  }

  /* ---------------- 渲染 ---------------- */

  renderTop() {
    const sum = this.data.sum || {}
    const metrics = sum.metrics || []

    return (
      <View style={styles.topCard}>
        {sum.holdDays > 0 ? (
          <View style={styles.streak}>
            <View style={styles.streakIco}>
              <Text style={styles.streakIcoText}>🔥</Text>
            </View>
            {/* flex: 0 1 auto —— 文案按内容宽度排，句尾的 💪 紧跟文字，不被推到行末 */}
            <Text style={styles.streakText} numberOfLines={1}>
              收息第 {sum.holdDays} 天，每一段伟大的旅程都从第一步开始
            </Text>
            <View style={styles.streakEmojiBox}>
              <Text style={styles.streakEmoji}>💪</Text>
            </View>
          </View>
        ) : null}

        <View style={[s.between, { marginTop: 16 }]}>
          <Text style={styles.onDarkSmall}>预测年度分红</Text>
          <Text style={styles.onDarkTiny}>基于 {sum.count || 0} 只持仓</Text>
        </View>

        <View style={[s.between, { marginTop: 4 }]}>
          <Text style={styles.bigNum}>{sum.dividendText || '0.00'}</Text>
          <Pressable onPress={() => this.goProjection()}>
            <Text style={styles.future}>✨ 20年可达 {sum.multipleText || '—'} 倍 ›</Text>
          </Pressable>
        </View>

        {metrics.length ? (
          <View>
            {this.data.expanded ? (
              <View>
                <View style={styles.dividerDark} />
                <View style={styles.metricGrid}>
                  {metrics.map((m) => (
                    <View key={m.key} style={styles.metric}>
                      <Text style={styles.onDarkTiny}>{m.name}</Text>
                      <Text
                        style={[
                          styles.metricValue,
                          m.tone === 'up' ? styles.metricUp : m.tone === 'down' ? styles.metricDown : null
                        ]}
                      >
                        {m.value}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}

            <View style={styles.toggleRow}>
              <Pressable style={styles.toggle} onPress={() => this.toggleExpand()}>
                <Text style={styles.toggleText}>{this.data.expanded ? '收起' : '查看更多指标'}</Text>
                {/* 小程序用两条边旋转画箭头，RN 同样只描两条边，颜色跟随文字 */}
                <View style={[styles.chev, this.data.expanded ? styles.chevUp : null]} />
              </Pressable>
              <Pressable onPress={() => this.goMetricSettings()}>
                <Text style={styles.metricSet}>⚙ 设置指标</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    )
  }

  renderCoverage() {
    return (
      <View style={[styles.card, { marginTop: 12 }]}>
        <Pressable style={s.between} onPress={() => this.goCoverage()}>
          <View style={s.row}>
            <View style={styles.covIconBox}>
              <Text style={styles.covIcon}>🎯</Text>
            </View>
            <Text style={[styles.h3, { marginLeft: 6 }]}>分红覆盖</Text>
          </View>
          <Text style={s.dim}>›</Text>
        </Pressable>

        <View style={styles.covGrid}>
          {this.data.coverageGrid.map((item) => (
            <View
              key={item.id}
              style={[
                styles.covItem,
                item.on ? styles.covOn : null,
                item.doing ? styles.covDoing : null
              ]}
            >
              <Text style={styles.covItemIcon}>{item.icon}</Text>
              <Text
                style={[styles.covItemName, item.on || item.doing ? styles.covItemNameOn : null]}
                numberOfLines={1}
              >
                {item.name}
              </Text>
            </View>
          ))}
        </View>

        <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>
          已点亮 {this.data.coveredCount}/{this.data.totalCount} 项
        </Text>

        <Pressable style={[styles.warmTip, { marginTop: 8 }]} onPress={() => this.goCoverage()}>
          <Text style={[styles.warmTipText, { flex: 1 }]}>
            再攒 {this.data.gapText} 分红就能点亮 {this.data.nextIcon}
            {this.data.nextName}
          </Text>
          <Text style={s.dim}>›</Text>
        </Pressable>
      </View>
    )
  }

  renderList() {
    return (
      <View>
        <View style={styles.secHead}>
          <View style={s.row}>
            <Text style={styles.h2}>我的持仓</Text>
            <Text style={styles.countTag}>{(this.data.sum || {}).count || 0}只</Text>
          </View>
          <View style={s.row}>
            {/* 改了默认口径时按钮变绿，具体选了哪项在面板里打勾 */}
            <Pressable
              style={[styles.mini, this.data.sortKey !== 'default' ? styles.miniActed : null]}
              onPress={() => this.openSheet('sort')}
            >
              <Text
                style={[styles.miniText, this.data.sortKey !== 'default' ? styles.miniTextActed : null]}
              >
                排序
              </Text>
            </Pressable>
            <Pressable
              style={[styles.mini, styles.miniMl, this.data.groupKey !== 'none' ? styles.miniActed : null]}
              onPress={() => this.openSheet('group')}
            >
              <Text
                style={[styles.miniText, this.data.groupKey !== 'none' ? styles.miniTextActed : null]}
              >
                分组
              </Text>
            </Pressable>
          </View>
        </View>

        {/* 标签由实际持仓动态生成，放不下时横向滚动 */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabs}>
          {this.data.tabList.map((t) => (
            <Pressable
              key={t.key}
              style={[styles.tab, this.data.market === t.key ? styles.tabOn : null]}
              onPress={() => this.onMarket(t.key)}
            >
              <View style={[styles.dot, { backgroundColor: dotColor(t.dotClass) }]} />
              <Text style={[styles.tabText, this.data.market === t.key ? styles.tabTextOn : null]}>
                {t.label} {t.count}
              </Text>
            </Pressable>
          ))}
        </ScrollView>

        {this.data.viewGroups.map((group) => (
          <View key={group.key}>
            {group.title ? (
              <View style={styles.groupHead}>
                <Text style={styles.groupTitle}>{group.title}</Text>
                <Text style={[s.tiny, s.dim, { marginLeft: 4 }]}>{group.count}只</Text>
              </View>
            ) : null}

            {group.list.map((h) => (
              <Pressable key={h.id} style={[styles.card, styles.holdCard]} onPress={() => this.goDetail(h.id)}>
                <View style={s.between}>
                  <View style={s.row}>
                    <View style={styles.stockIco}>
                      <Text style={styles.stockIcoText}>{h.icon}</Text>
                    </View>
                    <View style={{ marginLeft: 6 }}>
                      <View style={s.row}>
                        <Text style={s.bold}>{h.name}</Text>
                        <Text style={[s.tag, tagStyleOf(h.tagClass), { marginLeft: 4 }]}>
                          {h.marketTag}
                        </Text>
                      </View>
                      <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>{h.code}</Text>
                    </View>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={[styles.holdDividend, s.num]}>{h.dividendText}</Text>
                    <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>预测分红</Text>
                  </View>
                </View>

                <View style={styles.holdMeta}>
                  <MetaCell label="市值" value={h.marketValueText} first />
                  <MetaCell label="成本" value={h.costText} />
                  <MetaCell label="持仓" value={h.sharesText} />
                  <MetaCell label="股价息率" value={h.priceYieldText} tone="up" />
                </View>

                {/* 浮动盈亏（现市值 − 持仓成本）：单独一行，不占上面四格的位置 */}
                <View style={styles.profitRow}>
                  <Text style={styles.profitLabel}>浮动盈亏</Text>
                  <View style={s.row}>
                    <Text style={[styles.profitValue, s.num, profitToneOf(h)]}>
                      {h.floatProfitText}
                    </Text>
                    <Text style={[styles.profitPct, s.num, profitToneOf(h)]}>
                      {h.floatProfitPctText}
                    </Text>
                  </View>
                </View>
              </Pressable>
            ))}
          </View>
        ))}

        {!this.data.listTotal ? (
          <View style={styles.holdEmpty}>
            <Text style={styles.holdEmptyText}>还没有持仓，点右下角 ＋ 添加第一只收息标的</Text>
          </View>
        ) : null}
      </View>
    )
  }

  render() {
    if (this.data.guest) {
      return (
        <View style={s.page}>
          <LoginGuard
            icon="💰"
            title="登录后查看你的持仓"
            desc="登录即可同步持仓、分红与覆盖进度"
            onPress={() => app.toLogin()}
          />
        </View>
      )
    }

    if (this.data.loading) {
      return (
        <View style={[s.page, styles.empty]}>
          <Text style={styles.emptyEmoji}>💰</Text>
          <Text style={styles.emptyTitle}>正在加载你的持仓…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={styles.content}>
          {this.renderTop()}
          <View style={styles.warmTip}>
            <Text style={styles.warmTipText}>☕ 今天的咖啡钱，可能已经被股息买单了</Text>
          </View>
          {this.renderCoverage()}
          {this.renderList()}
          {/* 给悬浮 ＋ 留出高度，最后一张卡不会被压住 */}
          <View style={styles.bottomSpace} />
        </ScrollView>

        {/* 悬浮操作：＋ 旋转成 ×，两个动作自下而上逐个弹出（与小程序一致） */}
        {this.data.fabOpen ? (
          <Pressable style={styles.fabMask} onPress={() => this.toggleFab()} />
        ) : null}

        {/* 收起时也要留在树里，否则没有收拢动画；靠 pointerEvents 挡住误触 */}
        <View style={[styles.fabMenu, { pointerEvents: this.data.fabOpen ? 'box-none' : 'none' }]}>
          {this.data.fabActions.map((a, i) => {
            const v = this.itemAnims[i]
            return (
              <Animated.View
                key={a.key}
                style={[
                  styles.fabItem,
                  {
                    opacity: v,
                    transform: [
                      { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
                      { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] }) }
                    ]
                  }
                ]}
              >
                <Pressable style={styles.fabRow} onPress={() => this.onFabAction(a.key)}>
                  <Text style={styles.fabLabel}>
                    {a.icon} {a.label}
                  </Text>
                  <View style={[styles.fabMini, a.btnClass === 'warm' ? styles.fabMiniWarm : null]}>
                    <Text style={styles.fabMiniEmoji}>{a.icon}</Text>
                  </View>
                </Pressable>
              </Animated.View>
            )
          })}
        </View>

        <Pressable style={[styles.fab, this.data.fabOpen ? styles.fabOn : null]} onPress={() => this.toggleFab()}>
          {/* 加号用两条白线画，整体转 45° 就是叉号 —— 与小程序 .fab-icon 同一套做法 */}
          <Animated.View
            style={[
              styles.fabIcon,
              {
                transform: [
                  {
                    rotate: this.fabAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: ['0deg', '45deg']
                    })
                  }
                ]
              }
            ]}
          >
            <View style={styles.fabBarH} />
            <View style={styles.fabBarV} />
          </Animated.View>
        </Pressable>

        {/* 排序 / 分组面板 */}
        <Modal visible={!!this.data.sheetKey} transparent animationType="slide" onRequestClose={() => this.closeSheet()}>
          <Pressable style={styles.sheetMask} onPress={() => this.closeSheet()} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{this.data.sheetTitle}</Text>
            {this.data.sheetItems.map((item) => (
              <Pressable key={item.key} style={styles.sheetItem} onPress={() => this.onSheetPick(item.key)}>
                <Text style={[styles.sheetItemText, item.on ? styles.sheetItemTextOn : null]}>
                  {item.desc}
                </Text>
                {item.on ? <Text style={styles.sheetTick}>✓</Text> : null}
              </Pressable>
            ))}
            <Pressable style={styles.sheetCancel} onPress={() => this.closeSheet()}>
              <Text style={styles.sheetCancelText}>取消</Text>
            </Pressable>
          </View>
        </Modal>
      </View>
    )
  }
}

// 浮动盈亏配色：盈利红、亏损绿（与国内行情软件一致），持平走灰
function profitToneOf(h) {
  if (h.floatProfitUp) return styles.profitUp
  if (h.floatProfitDown) return styles.profitDown
  return styles.profitFlat
}

function MetaCell(props) {
  return (
    <View style={[styles.metaCell, props.first ? null : styles.metaCellLine]}>
      <Text style={styles.metaLabel}>{props.label}</Text>
      <Text style={[styles.metaValue, s.num, props.tone === 'up' ? styles.metaValueUp : null]}>
        {props.value}
      </Text>
    </View>
  )
}

// 标签页前面的小圆点：不同市场用不同颜色，取自小程序 .dot-a / .dot-hk / …
const DOT_COLORS = {
  'dot-a': '#E5484D', // A股 —— 红
  'dot-hk': '#1F9D6B', // 港股 —— 绿
  'dot-etf': '#D9A93C', // ETF —— 金
  'dot-fund': '#7B61FF', // 基金 —— 紫
  'dot-us': '#3B82C4' // 美股 —— 蓝
}
function dotColor(name) {
  return DOT_COLORS[name] || colors.t3
}

const styles = StyleSheet.create({
  // 页面留白：小程序是 .page-flat（左右 24rpx、底部 60rpx）
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30 },
  bottomSpace: { height: 90 },

  // 卡片带小程序 .card 那层很淡的投影
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

  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  /* ---------- 顶部深色卡 ---------- */
  topCard: { backgroundColor: '#232323', borderRadius: 14, padding: 14 },
  streak: { flexDirection: 'row', alignItems: 'center' },
  // 🔥 的底板：小程序是 150° 渐变（#FF9E8E → #F4586B），RN 没装渐变库，取中间色
  streakIco: {
    width: 26,
    height: 26,
    borderRadius: 8,
    marginRight: 6,
    backgroundColor: '#FA7B7C',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  streakIcoText: { fontSize: 14, lineHeight: 14 },
  // flex 0 1 auto：文案按内容宽度排，句尾的 💪 紧跟文字，不会被推到行末
  streakText: { flexShrink: 1, fontSize: 11, lineHeight: 15, color: 'rgba(255,255,255,0.88)' },
  streakEmojiBox: {
    height: 16,
    paddingHorizontal: 4,
    marginLeft: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.13)',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  streakEmoji: { fontSize: 10, lineHeight: 10 },

  onDarkSmall: { fontSize: 12, color: 'rgba(255,255,255,0.55)' },
  onDarkTiny: { fontSize: 11, color: 'rgba(255,255,255,0.55)' },
  bigNum: {
    fontSize: 33,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums']
  },
  future: { fontSize: 11, color: 'rgba(255,255,255,0.6)' },

  dividerDark: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: 12
  },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  metric: { width: '33.33%', paddingVertical: 7 },
  metricValue: { marginTop: 4, fontSize: 13, color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  // 顶部汇总里「按涨跌着色」的指标（浮动盈亏 / 盈亏率）。
  //
  // ⚠️ metricUp 曾经被当成**浮动盈亏的固定色**用 —— mock 的 metricCatalog 里给它
  // 标了 tone:'up'，页面就照着这个常量上色，于是**赚和亏是同一个橙色**。
  // 现在 tone 由 api 层按实际正负给出（metricToneOf），'up' 才真的表示涨。
  //
  // 两个色都比卡片上那组（#E5484D / #1F9D6B）亮一档：这里是深色卡，
  // 同样的红绿压上去会发闷、认不出方向。语义与卡片上的 profitToneOf 一致：
  // 盈利红、亏损绿、持平时两个都不加（走 metricValue 的白）。
  metricUp: { color: '#FF7A7D' },
  metricDown: { color: '#3DD68C' },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12 },
  toggle: { flexDirection: 'row', alignItems: 'center' },
  toggleText: { fontSize: 12, lineHeight: 12, color: 'rgba(255,255,255,0.78)' },
  metricSet: { fontSize: 12, lineHeight: 12, color: 'rgba(255,255,255,0.65)' },
  // 箭头只描两条边再旋转，与小程序 .chev 同一套做法（不用字体符号，基线更稳）
  chev: {
    width: 6.5,
    height: 6.5,
    marginLeft: 6,
    marginTop: -3,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.78)',
    transform: [{ rotate: '45deg' }]
  },
  chevUp: { transform: [{ rotate: '-135deg' }], marginTop: 3 },

  /* ---------- 暖色提示条 ---------- */
  warmTip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    backgroundColor: '#FDF4E4',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F2E1BF',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  warmTipText: { fontSize: 13, lineHeight: 19, color: '#8A6A22' },

  // 小程序里 🎯 是装在 .icon-box（56rpx≈28px、圆角 16rpx、浅金底）里的，字号 30rpx≈15px；
  // RN 这端之前是裸 emoji 且字号更大，在 App 上看着发胖，补回同样的容器与字号
  h3: { fontSize: 15, fontWeight: '600', color: colors.t1 },

  // 小程序里 🎯 装在 .icon-box（56rpx≈28px、圆角 16rpx、浅金底）里，字号 30rpx≈15px
  covIconBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(217, 169, 60, 0.14)'
  },
  covIcon: { fontSize: 15, lineHeight: 15 },
  covGrid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 12 },
  // 一行 7 个固定宽块 + 固定间隙，不用 space-between，否则最后一行不满会被拉到两头
  covItem: {
    width: COV_ITEM_W,
    marginRight: COV_GAP,
    marginBottom: 7,
    paddingTop: 7,
    paddingBottom: 6,
    borderRadius: 7,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#E9EDEB',
    backgroundColor: '#F7F9F8',
    alignItems: 'center',
    opacity: 0.45
  },
  covOn: {
    opacity: 1,
    backgroundColor: colors.primarySoft,
    borderColor: 'rgba(31, 157, 107, 0.3)'
  },
  // 「进行中」与「已完成」同色，只把实线换成虚线（小程序 .cov-item.doing）
  covDoing: {
    opacity: 1,
    backgroundColor: colors.primarySoft,
    borderColor: 'rgba(31, 157, 107, 0.3)',
    borderStyle: 'dashed'
  },
  covItemIcon: { fontSize: 16, lineHeight: 17 },
  covItemName: { marginTop: 5, fontSize: 10, lineHeight: 10, color: colors.t3 },
  covItemNameOn: { color: colors.primary },

  /* ---------- 我的持仓 ---------- */
  secHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 20,
    paddingHorizontal: 4
  },
  h2: { fontSize: 17, fontWeight: '600', color: colors.t1 },
  // 数量角标：小程序是浅灰底，不是绿色
  countTag: {
    marginLeft: 4,
    fontSize: 11,
    color: colors.t2,
    backgroundColor: '#EFF2F1',
    borderRadius: 5,
    paddingHorizontal: 7,
    paddingVertical: 2,
    overflow: 'hidden'
  },

  mini: { backgroundColor: '#EFF2F1', borderRadius: 7, paddingHorizontal: 12, paddingVertical: 6 },
  miniMl: { marginLeft: 6 },
  miniActed: { backgroundColor: 'rgba(31, 157, 107, 0.12)' },
  miniText: { fontSize: 12, color: colors.t2 },
  miniTextActed: { color: colors.primary, fontWeight: '600' },

  tabs: { marginTop: 11, marginBottom: 11 },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    marginRight: 8
  },
  // 选中的市场标签是深色底白字（小程序 .tab.on）
  tabOn: { backgroundColor: '#232323' },
  tabText: { fontSize: 13, color: colors.t2 },
  tabTextOn: { color: '#FFFFFF', fontWeight: '600' },
  dot: { width: 7, height: 7, borderRadius: 3.5, marginRight: 6 },

  groupHead: { flexDirection: 'row', alignItems: 'center', paddingTop: 10, paddingBottom: 7 },
  groupTitle: { fontSize: 13.5, fontWeight: '600', color: colors.t1 },

  holdCard: { marginBottom: 10 },
  // .stock-ico：64rpx 方块、18rpx 圆角、浅灰底
  stockIco: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: '#EDF0EF',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stockIcoText: { fontSize: 15, color: colors.t2 },
  // 预测分红主数字用深色，橙色只留给息率等强调值
  holdDividend: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.t1,
    letterSpacing: -0.25,
    lineHeight: 21
  },
  // 四列指标：浅灰底圆角容器，列内居中，列间细分隔线
  holdMeta: {
    flexDirection: 'row',
    marginTop: 13,
    backgroundColor: '#F7F9F8',
    borderRadius: 9,
    paddingVertical: 11
  },
  metaCell: { flex: 1, alignItems: 'center' },
  metaCellLine: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#E7EBE9' },
  metaLabel: { fontSize: 11, color: colors.t3 },
  metaValue: { marginTop: 5, fontSize: 13.5, fontWeight: '500', color: colors.t1 },
  metaValueUp: { color: '#E0892C' },

  // 浮动盈亏：标签在左、金额与比例在右；金额为主、比例退一档
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 10,
    paddingHorizontal: 2
  },
  profitLabel: { fontSize: 11, color: colors.t3 },
  profitValue: { fontSize: 14, fontWeight: '600' },
  profitPct: { fontSize: 12, fontWeight: '500', marginLeft: 6 },
  // 红涨绿跌，与国内行情软件一致
  profitUp: { color: '#E5484D' },
  profitDown: { color: '#1F9D6B' },
  profitFlat: { color: colors.t3 },

  holdEmpty: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingVertical: 35,
    paddingHorizontal: 10,
    alignItems: 'center'
  },
  holdEmptyText: { fontSize: 12.5, color: colors.t3, textAlign: 'center' },

  /* ---------- 悬浮操作菜单 ---------- */
  fabMask: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.18)' },
  // .speed-dial：FAB 底部 150rpx + FAB 高 96rpx + 间距 20rpx
  fabMenu: { position: 'absolute', right: 16, bottom: 133, alignItems: 'flex-end' },
  fabItem: { marginBottom: 13 },
  fabRow: { flexDirection: 'row', alignItems: 'center' },
  fabLabel: {
    fontSize: 13,
    color: colors.t1,
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    marginRight: 8,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3
  },
  fabMini: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3
  },
  // 小程序里手动添加那个是暖色底（.speed-btn.warm）
  fabMiniWarm: { backgroundColor: '#FDF4D8' },
  fabMiniEmoji: { fontSize: 18, lineHeight: 18 },

  // 与小程序 .fab 一致：96rpx 的黑圆底 + 阴影
  fab: {
    position: 'absolute',
    right: 16,
    bottom: 75,
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#232323',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.28,
    shadowRadius: 14,
    elevation: 8
  },
  fabOn: { backgroundColor: '#101010' },
  fabIcon: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  fabBarH: { position: 'absolute', width: 20, height: 2, borderRadius: 1, backgroundColor: '#FFFFFF' },
  fabBarV: { position: 'absolute', width: 2, height: 20, borderRadius: 1, backgroundColor: '#FFFFFF' },

  /* ---------- 排序 / 分组面板 ---------- */
  sheetMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    paddingTop: 4,
    paddingBottom: 10
  },
  sheetTitle: {
    paddingTop: 15,
    paddingHorizontal: 16,
    paddingBottom: 9,
    textAlign: 'center',
    fontSize: 12.5,
    color: colors.t3
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 15,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },
  sheetItemText: { flex: 1, fontSize: 14.5, color: colors.t1 },
  sheetItemTextOn: { color: colors.primary, fontWeight: '600' },
  sheetTick: { fontSize: 15, color: colors.primary },
  sheetCancel: {
    marginHorizontal: 12,
    marginTop: 10,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#F4F6F5',
    alignItems: 'center'
  },
  sheetCancelText: { fontSize: 15, color: colors.t2 }
})

module.exports = Holdings

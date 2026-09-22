const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const LoginGuard = require('../components/LoginGuard.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

/**
 * 投资档案：已清仓标的的复盘台。
 *
 * 它要回答的问题不是「我赚了多少」，而是**「我当初卖对了吗」** ——
 * 所以每张卡片的主角是「卖出至今」的涨跌：
 *   跌了 → 躲过下跌，卖对了
 *   涨了 → 卖早了，少赚了
 * 两个方向都有价值，不存在「只该看对的」。
 *
 * 清仓有两种来源（见 store.isArchived）：
 *   · 卖出全部股数 → 自动进来，不需额外操作；
 *   · 详情页手动点「清仓归档」→ 还没卖完但决定不再跟踪。
 * 归档是标记不是删除：持仓、每一笔流水、每笔写下的想法，全都留着 ——
 * 点进任意一只仍能翻到完整的操作记录。
 */
class Archive extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      guest: false,
      list: [],
      count: 0,
      winText: '—',
      emptyText: ''
    }
  }

  onShow() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false })
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
  }

  load() {
    // 先按实时行情刷新：卖出至今涨跌要靠最新价，
    // 拿缓存里的旧价算出来的结论是错的（还会正好反过来）
    return api
      .refreshHoldingQuotes()
      .catch(() => 0)
      .then(() => api.getArchive())
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          list: d.list,
          count: d.count,
          winText: d.winText,
          emptyText: d.emptyText
        })
      })
      .catch(util.onError)
  }

  // 走 wx.navigateTo 而不是直接 navigation.navigate：
  // 与项目里其余 25 处跳转保持同一路径，nav.js 的页面栈才不会漏记这一层
  // （util.back() 靠它判断是不是栈底）。
  goRecords(id) {
    wx.navigateTo({ url: '/pages/holding-record/holding-record?id=' + id })
  }

  /**
   * 把归档标的退回持仓列表（撤销手动归档）。
   *
   * 只对「手动归档、还没卖完」的有意义：股数归零那种归档状态是从 shares
   * 推导出来的，不写回股数就退不出去 —— 那种卡片不显示这个按钮，
   * 接口那边也会拦一道并说明原因。
   */
  restore(h) {
    wx.showModal({
      title: '返回持仓',
      content:
        '「' + h.name + '」会回到持仓列表，重新计入市值与分红。\n\n' +
        '归档是标记不是删除 —— 流水和这段想法都留着，以后再归档还在。',
      confirmText: '返回持仓',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.unarchiveHolding(h.id), {
            loadingText: '处理中',
            success: '已回到持仓列表'
          })
          .then((r) => {
            if (r) this.load()
          })
      }
    })
  }

  /**
   * 补写 / 修改清仓心得。
   *
   * 独立于归档动作，也不挑时机：归档那一刻未必想得清楚，也可能随手跳过，
   * 过了几个月回看才有话想说 —— 那时必须还能补。否则「记一句」就成了
   * 一次性的事，错过便永远空着。
   */
  editReason(h) {
    wx.showModal({
      title: '当时的想法',
      content: '当初为什么买、后来为什么卖？这段是写给以后的自己看的。',
      editable: true,
      multiline: true,
      maxLength: api.MEMO_MAX,
      // 预填原文：否则一打开是空白，改一个字就等于把原来那段全抹了
      initialContent: h.reason,
      placeholderText: '例如：股息率跌破 3%，换到更便宜的标的',
      confirmText: '保存',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.setArchiveReason(h.id, res.content), {
            loadingText: '保存中',
            success: '已记下'
          })
          .then((r) => {
            if (r) this.load()
          })
      }
    })
  }

  render() {
    if (this.data.guest) {
      return (
        <View style={s.page}>
          <LoginGuard
            icon="📦"
            title="登录后查看投资档案"
            desc="清仓记录会跟着账号同步，换设备也丢不了"
            onPress={() => app.toLogin()}
          />
        </View>
      )
    }

    if (this.data.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={[s.mid, s.dim]}>加载中…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {/* 总览：清了多少只、其中几只是「卖对了」 */}
          <View style={s.card}>
            <Text style={[s.tiny, s.dim]}>已清仓标的</Text>
            <View style={[s.row, { marginTop: 6, alignItems: 'flex-end' }]}>
              <Text style={styles.big}>{this.data.count}</Text>
              <Text style={[s.tiny, s.dim, { marginLeft: 5, marginBottom: 5 }]}>只</Text>
            </View>

            <View style={[s.between, { marginTop: 14 }]}>
              <Text style={[s.tiny, s.dim]}>卖出后下跌（卖对了）</Text>
              <Text style={[s.small, styles.win]}>{this.data.winText}</Text>
            </View>

            <Text style={[s.tiny, s.dim, { marginTop: 10, lineHeight: 18 }]}>
              「卖出至今」= 清仓价到现价的涨跌。跌了说明躲过下跌，涨了说明卖早了 ——
              两个方向都值得回看，所以这里不做筛选。
            </Text>
          </View>

          {this.data.list.length ? (
            this.data.list.map((h) => (
              <Pressable
                key={h.id}
                style={[s.card, styles.card]}
                onPress={() => this.goRecords(h.id)}
              >
                <View style={s.between}>
                  <View style={s.row}>
                    <View style={styles.ico}>
                      <Text style={styles.icoText}>{h.icon}</Text>
                    </View>
                    <View style={{ marginLeft: 6 }}>
                      <View style={s.row}>
                        <Text style={s.bold}>{h.name}</Text>
                        <Text style={[s.tag, styles.tagGray, { marginLeft: 4 }]}>{h.marketTag}</Text>
                      </View>
                      <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>
                        {h.code} · {h.sharesText}
                      </Text>
                    </View>
                  </View>

                  {/* 主角：卖出至今的涨跌 */}
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text
                      style={[
                        styles.diff,
                        s.num,
                        h.sinceExitUp ? styles.up : h.sinceExitDown ? styles.down : styles.flat
                      ]}
                    >
                      {h.sinceExitText}
                    </Text>
                    <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>卖出至今</Text>
                  </View>
                </View>

                <View style={styles.meta}>
                  <Cell label="清仓价" value={h.exitPriceText} first />
                  <Cell label="现价" value={h.nowPriceText} />
                  <Cell label="已收分红" value={h.receivedText} />
                </View>

                {h.reason ? (
                  <View style={styles.reason}>
                    <View style={s.between}>
                      <Text style={[s.tiny, s.dim]}>当时的想法</Text>
                      <Pressable hitSlop={10} onPress={() => this.editReason(h)}>
                        <Text style={styles.reasonEdit}>改</Text>
                      </Pressable>
                    </View>
                    <Text style={[s.small, styles.reasonText]}>{h.reason}</Text>
                  </View>
                ) : (
                  // 空着时给一个能点的补写入口。以前这里只写「下次卖出时写一句」，
                  // 可「下次」是另一只标的，这一条就永远补不上了。
                  <Pressable style={styles.noReasonWrap} hitSlop={10} onPress={() => this.editReason(h)}>
                    <Text style={[s.tiny, styles.noReason]}>
                      还没写下当时的想法 —— 点这里补一句，回头最有用
                    </Text>
                  </Pressable>
                )}

                {/* 退回持仓列表。只有手动归档、且还持有的标的能退（见 canRestore）；
                    卖光的那种归档状态是股数推导出来的，写不回股数就退不出去。 */}
                {h.canRestore ? (
                  <View style={styles.actions}>
                    <Pressable style={styles.restoreBtn} hitSlop={8} onPress={() => this.restore(h)}>
                      <Text style={styles.restoreText}>返回持仓</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={[s.tiny, styles.soldOut]}>已卖光 —— 重新买入后会回到持仓列表</Text>
                )}
              </Pressable>
            ))
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>📦</Text>
              <Text style={[s.mid, s.dim, { marginTop: 10, textAlign: 'center' }]}>
                {this.data.emptyText}
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    )
  }
}

function Cell(props) {
  return (
    <View style={[styles.cell, props.first ? null : styles.cellLine]}>
      <Text style={styles.cellLabel}>{props.label}</Text>
      <Text style={[styles.cellValue, s.num]}>{props.value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  big: { fontSize: 30, fontWeight: '700', color: colors.t1, letterSpacing: -0.5 },
  win: { color: colors.primary, fontWeight: '600' },

  card: { marginTop: 10 },
  ico: {
    width: 32,
    height: 32,
    borderRadius: 9,
    backgroundColor: '#EDF0EF',
    alignItems: 'center',
    justifyContent: 'center'
  },
  icoText: { fontSize: 15, color: colors.t2 },
  tagGray: { backgroundColor: colors.line2, color: colors.t2 },

  // 卖出至今：整张卡片里最大的一行
  diff: { fontSize: 19, fontWeight: '700', letterSpacing: -0.25 },
  // 红涨绿跌，与国内行情软件一致
  up: { color: '#E5484D' },
  down: { color: '#1F9D6B' },
  flat: { color: colors.t3 },

  meta: {
    flexDirection: 'row',
    marginTop: 13,
    backgroundColor: '#F7F9F8',
    borderRadius: 9,
    paddingVertical: 10
  },
  cell: { flex: 1, alignItems: 'center' },
  cellLine: { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: '#E7EBE9' },
  cellLabel: { fontSize: 11, color: colors.t3 },
  cellValue: { marginTop: 5, fontSize: 13, fontWeight: '500', color: colors.t1 },

  reason: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E7EBE9'
  },
  reasonText: { marginTop: 4, lineHeight: 20, color: colors.t1 },
  reasonEdit: { fontSize: 11, fontWeight: '600', color: colors.primary },
  // 外距挂在这一层：里面的文字要能被 Pressable 的 hitSlop 一起放大
  noReasonWrap: { marginTop: 12 },
  noReason: { color: colors.t3 },

  // 「返回持仓」：右对齐的小胶囊，贴着卡片底边，不抢「卖出至今」那行的主角位
  actions: { marginTop: 12, flexDirection: 'row', justifyContent: 'flex-end' },
  restoreBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.line2
  },
  restoreText: { fontSize: 12, fontWeight: '600', color: colors.primary },
  soldOut: { marginTop: 12, textAlign: 'right', color: colors.t3 },

  empty: { paddingVertical: 60, alignItems: 'center', paddingHorizontal: 20 },
  emptyIcon: { fontSize: 40 }
})

module.exports = Archive

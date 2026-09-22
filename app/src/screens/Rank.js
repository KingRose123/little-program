const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

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

/** 榜单页：名单来自 api.getRank，数值（息率 / 连续分红年数 / 权重）都是实时现算的。 */
class Rank extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      board: null
    }
  }

  onLoad(options) {
    this.type = (options && options.type) || 'r1'
    this.load()
  }

  load() {
    api
      .getRank(this.type)
      .then((res) => {
        this.setData({ loading: false, board: res.data })
        wx.setNavigationBarTitle({ title: res.data.name })
      })
      .catch(util.onError)
  }

  // 点榜单条目 => 带着代码进添加页，省掉一次手输
  // 同一代码可能跨市场，把 market 一起带过去才能取对标的
  onPick(e) {
    const ds = e.currentTarget.dataset
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={s.page}>
          <ScrollView contentContainerStyle={s.content}>
            <View style={[s.card, styles.empty]}>
              <Text style={styles.emptyEmoji}>🏆</Text>
              <Text style={styles.emptyTitle}>正在加载榜单…</Text>
            </View>
          </ScrollView>
        </View>
      )
    }

    const board = this.data.board
    const rows = board.list

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {/* 榜头 */}
          <View style={s.card}>
            <View style={s.row}>
              <Text style={styles.heroIcon}>{board.icon}</Text>
              <View style={[s.flex1, { marginLeft: 12 }]}>
                <Text style={styles.heroName}>{board.name}</Text>
                <Text style={styles.heroBadge}>{board.badge}</Text>
              </View>
              <Text style={[s.tiny, s.dim]}>{rows.length} 只</Text>
            </View>
            <Text style={styles.heroNote}>{board.note}</Text>
          </View>

          <View style={styles.secHead}>
            <Text style={s.h3}>完整榜单</Text>
            <Text style={[s.tiny, s.dim, { marginLeft: 12 }]}>点任意标的可直接添加</Text>
          </View>

          <View style={[s.card, styles.cardFlat]}>
            {rows.map((item, i) => (
              <Pressable
                key={item.code}
                style={[styles.rankRow, i === rows.length - 1 ? styles.rowLast : null]}
                onPress={() => this.onPick(tap({ code: item.code, market: item.market }))}
              >
                <View style={[styles.rankNo, item.top3 ? styles.rankNoTop : null]}>
                  <Text style={[styles.rankNoText, item.top3 ? styles.rankNoTextTop : null]}>
                    {item.rank}
                  </Text>
                </View>

                <View style={s.flex1}>
                  <View style={s.row}>
                    <Text style={[s.mid, s.bold]}>{item.name}</Text>
                    <Text style={[s.tag, tagStyleOf(item.cls), { marginLeft: 8 }]}>
                      {item.marketLabel}
                    </Text>
                  </View>
                  <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{item.code}</Text>
                  {/* 条形宽度对榜首归一（小程序的 --w 变量 → 内联百分比） */}
                  <View style={styles.bar}>
                    <View style={[styles.barIn, { width: item.width + '%' }]} />
                  </View>
                </View>

                <View style={styles.rankVal}>
                  <Text style={[styles.rankNum, s.num]}>{item.valueText}</Text>
                  <Text style={styles.rankUnit}>{board.unit}</Text>
                </View>
              </Pressable>
            ))}
          </View>

          <Text style={styles.footTip}>榜单基于公开数据整理，仅供研究参考，不构成投资建议。</Text>
        </ScrollView>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  heroIcon: { fontSize: 26 },
  heroName: { fontSize: 17, fontWeight: '700', color: colors.t1 },
  heroBadge: {
    alignSelf: 'flex-start',
    marginTop: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(31, 157, 107, 0.12)',
    color: colors.primary,
    fontSize: 10.5,
    overflow: 'hidden'
  },
  heroNote: {
    marginTop: 11,
    paddingTop: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    fontSize: 12,
    lineHeight: 20,
    color: colors.t2
  },

  secHead: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 18,
    marginBottom: 10,
    paddingHorizontal: 4
  },
  // 内边距交给每一行，行与行之间只留一条分隔线
  cardFlat: { paddingHorizontal: 14, paddingVertical: 0 },

  rankRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  rowLast: { borderBottomWidth: 0 },

  // 名次：前三名主色实心，其余弱化
  rankNo: {
    width: 23,
    height: 23,
    marginRight: 10,
    borderRadius: 999,
    backgroundColor: '#EFF2F1',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  rankNoTop: { backgroundColor: colors.primary },
  rankNoText: { fontSize: 11.5, fontWeight: '600', color: colors.t2 },
  rankNoTextTop: { color: '#FFFFFF' },

  bar: { marginTop: 7, height: 4, borderRadius: 999, backgroundColor: '#EFF2F1', overflow: 'hidden' },
  // 小程序这里是 linear-gradient，RN 无 CSS 渐变且不加依赖，用纯主色
  barIn: { height: '100%', borderRadius: 999, backgroundColor: colors.primary },

  rankVal: { flexDirection: 'row', alignItems: 'flex-end', marginLeft: 10, flexShrink: 0 },
  rankNum: { fontSize: 16, fontWeight: '700', color: colors.t1 },
  rankUnit: { marginLeft: 2, fontSize: 11, color: colors.t3 },

  footTip: { marginTop: 15, paddingHorizontal: 4, fontSize: 11, lineHeight: 19, color: colors.t3 }
})

module.exports = Rank

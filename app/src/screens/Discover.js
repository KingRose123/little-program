const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, Modal, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

// 四个工具卡片的落点：t2 分红日历是本 App 的 Tab，其余进工具页
const TOOL_ROUTES = {
  t1: '/pages/tool/tool?id=t1',
  t3: '/pages/tool/tool?id=t3',
  t4: '/pages/tool/tool?id=t4'
}

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

class Discover extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      tools: [],
      ranks: [],
      articles: [],

      searchOpen: false,
      keyword: '',
      results: [],
      noResult: false
    }
  }

  onLoad() {
    this.load()
  }

  load() {
    api
      .getDiscover()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  }

  onTool(e) {
    const id = e.currentTarget.dataset.id

    if (id === 't2') {
      wx.switchTab({ url: '/pages/calendar/calendar' })
      return
    }

    const url = TOOL_ROUTES[id]
    if (url) wx.navigateTo({ url: url })
  }

  onRank(e) {
    wx.navigateTo({ url: '/pages/rank/rank?type=' + e.currentTarget.dataset.id })
  }

  onArticle(e) {
    wx.navigateTo({ url: '/pages/article/article?id=' + e.currentTarget.dataset.id })
  }

  /* ---------------- 跨市场搜索 ---------------- */

  onSearch() {
    this.setData({ searchOpen: true, keyword: '', results: [], noResult: false })
  }

  closeSearch() {
    if (this.data.searchOpen) this.setData({ searchOpen: false })
  }

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value })

    // 搜索走真实接口，防抖一下，避免每敲一个字都打一次请求
    if (this.searchTimer) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null
      this.doSearch()
    }, 300)
  }

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer)
  }

  doSearch() {
    const kw = String(this.data.keyword).trim()
    this.searchSeq = (this.searchSeq || 0) + 1
    const seq = this.searchSeq

    if (!kw) {
      this.setData({ results: [], noResult: false })
      return
    }

    api
      .searchAllStocks(kw)
      .then((res) => {
        if (seq !== this.searchSeq) return
        this.setData({ results: res.data, noResult: res.data.length === 0 })
      })
      .catch(util.onError)
  }

  onPickStock(e) {
    const ds = e.currentTarget.dataset
    this.setData({ searchOpen: false })
    wx.navigateTo({
      url: '/pages/add-holding/add-holding?code=' + ds.code + '&market=' + (ds.market || '')
    })
  }

  /* ---------------- 渲染 ---------------- */

  renderTools() {
    return (
      <View style={styles.cardRow}>
        {this.data.tools.map((t) => (
          <Pressable key={t.id} style={styles.toolCard} onPress={() => this.onTool(tap({ id: t.id }))}>
            <Text style={styles.toolIcon}>{t.icon}</Text>
            <Text style={[s.small, s.bold, { marginTop: 8 }]}>{t.name}</Text>
            <Text style={[s.tiny, s.dim, { marginTop: 4, textAlign: 'center' }]}>{t.desc}</Text>
          </Pressable>
        ))}
      </View>
    )
  }

  renderRanks() {
    return (
      <View style={{ marginTop: 20 }}>
        <Text style={[s.h2, { marginBottom: 12 }]}>榜单</Text>
        {this.data.ranks.map((r) => (
          <Pressable key={r.id} style={[s.card, { marginBottom: 12 }]} onPress={() => this.onRank(tap({ id: r.id }))}>
            <View style={s.between}>
              <View style={s.row}>
                <View style={[styles.iconBox, styles.iconSoftGold]}>
                  <Text style={styles.iconText}>{r.icon}</Text>
                </View>
                <View style={{ marginLeft: 10 }}>
                  <View style={s.row}>
                    <Text style={s.bold}>{r.name}</Text>
                    {r.badge ? <Text style={[s.tag, styles.badge, { marginLeft: 8 }]}>{r.badge}</Text> : null}
                  </View>
                  <Text style={[s.tiny, s.dim, { marginTop: 5 }]}>{r.subText || ''}</Text>
                </View>
              </View>
              <Text style={s.dim}>›</Text>
            </View>
          </Pressable>
        ))}
      </View>
    )
  }

  renderArticles() {
    return (
      <View style={{ marginTop: 20 }}>
        <Text style={[s.h2, { marginBottom: 12 }]}>收息小课</Text>
        {this.data.articles.map((a) => (
          <Pressable key={a.id} style={[s.card, { marginBottom: 12 }]} onPress={() => this.onArticle(tap({ id: a.id }))}>
            <View style={s.row}>
              <View style={[styles.iconBox, styles.iconSoftGray, { marginRight: 12 }]}>
                <Text style={styles.iconText}>{a.icon || '📖'}</Text>
              </View>
              <View style={s.flex1}>
                <Text style={s.bold}>{a.title}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{a.desc || ''}</Text>
              </View>
            </View>
          </Pressable>
        ))}
      </View>
    )
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={[s.page, s.center]}>
          <Text style={s.mid}>加载中…</Text>
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          <Pressable style={styles.searchBar} onPress={() => this.onSearch()}>
            <Text style={[s.small, s.dim]}>🔍 搜索代码 / 名称 / 拼音</Text>
          </Pressable>

          {this.renderTools()}
          {this.renderRanks()}
          {this.renderArticles()}
        </ScrollView>

        {/* 跨市场搜索 */}
        <Modal visible={this.data.searchOpen} animationType="slide" onRequestClose={() => this.closeSearch()}>
          <View style={[s.page, { paddingTop: 40 }]}>
            <View style={styles.searchHead}>
              <TextInput
                style={[s.input, s.flex1]}
                value={this.data.keyword}
                onChangeText={(v) => this.onSearchInput(val(validate.plain(v, { max: 20 })))}
                placeholder="输入代码 / 名称 / 拼音首字母"
                placeholderTextColor={colors.t3}
                autoFocus
              />
              <Pressable onPress={() => this.closeSearch()} style={{ marginLeft: 12 }}>
                <Text style={{ color: colors.primary, fontSize: 15 }}>取消</Text>
              </Pressable>
            </View>

            <ScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}>
              {this.data.results.map((item) => (
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

              {this.data.noResult ? (
                <Text style={[s.small, s.dim, { marginTop: 20 }]}>没搜到，换个关键词试试</Text>
              ) : null}
            </ScrollView>
          </View>
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  searchBar: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 16
  },
  cardRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  toolCard: {
    width: '48%',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 20,
    paddingHorizontal: 12,
    alignItems: 'center',
    marginBottom: 12
  },
  // 工具卡：emoji 的默认行高比字号大，会让图标在行里偏下；锁行高 + 1px 下移压回视觉中线
  toolIcon: { fontSize: 26, lineHeight: 30, transform: [{ translateY: 1 }] },
  badge: { backgroundColor: colors.primarySoft, color: colors.primary },
  // 榜单 / 收息小课行的图标：与小程序 .icon-box（56rpx≈28px、圆角 16rpx≈8px、浅金/浅灰底）
  // 一致，用固定容器兜住 emoji 并居中，避免裸 emoji 因行高/基线不同而与右侧文字不齐
  // 方块默认与右侧整块文字（标题 + 副标题）垂直居中，但文字块比 28 的方块高得多，
  // 居中后标题就跑到方块上方去了；整个方块上移 11px，让方块与标题居中对齐，
  // 文字正好落在方块的垂直中线上，不再相对底块偏高
  iconBox: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -11 }]
  },
  iconSoftGold: { backgroundColor: 'rgba(217, 169, 60, 0.14)' },
  iconSoftGray: { backgroundColor: '#F3F5F4' },
  // 方块内的 emoji 重心仍偏下（原生 Text 渲染，方向与小程序的 WebView 相反），再补 2px；
  // 与方块自身的 -8 叠加后，emoji 相对右侧文字合计上移 10px
  iconText: { fontSize: 15, lineHeight: 15, transform: [{ translateY: -2 }] },
  searchHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 14 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  }
})

module.exports = Discover

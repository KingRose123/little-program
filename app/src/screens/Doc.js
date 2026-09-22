const React = require('react')
const { View, Text, ScrollView, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

// 三类法律文本 + 两类说明型文档共用这一个页面，靠 key 分流
const TITLES = {
  standard: '数据口径说明',
  contact: '联系我们',
  disclaimer: '免责声明',
  agreement: '用户协议',
  privacy: '隐私政策'
}

// 这两类是「键值对」形态，其余是段落型
const TABLE_KEYS = ['standard', 'contact']

/** 说明文档页：协议 / 隐私 / 免责声明 与 数据口径说明 / 联系我们 共用一套渲染。 */
class Doc extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      title: '',
      updated: '',
      paras: [],
      rows: [],
      isTable: false
    }
  }

  onLoad(options) {
    const key = (options && options.key) || 'agreement'
    wx.setNavigationBarTitle({ title: TITLES[key] || '说明' })
    this.setData({ isTable: TABLE_KEYS.indexOf(key) > -1 })

    const req =
      key === 'standard'
        ? api.getStandardDoc()
        : key === 'contact'
        ? api.getContactInfo()
        : api.getLegalDoc(key)

    req
      .then((res) => {
        const d = res.data
        this.setData({
          loading: false,
          title: d.title,
          updated: d.updated || '',
          paras: d.paras || [],
          rows: d.rows || []
        })
      })
      .catch(util.onError)
  }

  render() {
    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {this.data.loading ? (
            <View style={[s.card, styles.empty]}>
              <Text style={styles.emptyEmoji}>📄</Text>
              <Text style={styles.emptyTitle}>正在加载…</Text>
            </View>
          ) : this.data.isTable ? (
            // 说明型：键值对列表
            <View style={styles.cardFlat}>
              {this.data.rows.map((item, i) => (
                <View
                  key={String(item.name || item.label) + '-' + i}
                  style={[styles.docRow, i ? styles.docRowLine : null]}
                >
                  <Text style={styles.docLabel}>{item.name || item.label}</Text>
                  <Text style={styles.docValue}>{item.desc || item.value}</Text>
                </View>
              ))}
            </View>
          ) : (
            // 法律文本：逐段渲染（小程序那份是 <rich-text>，这里直接是段落数组）
            <View>
              <View style={s.card}>
                <Text style={styles.docTitle}>{this.data.title}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>更新日期 {this.data.updated}</Text>
                {this.data.paras.map((p, i) => (
                  <Text key={i} style={styles.docP}>
                    {p}
                  </Text>
                ))}
              </View>
              <Text style={styles.docFoot}>
                以上内容为应用内的完整说明文本，如有疑问可通过「联系我们」反馈。
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  cardFlat: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 4
  },
  docRow: { paddingVertical: 13 },
  docRowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  docLabel: { fontSize: 14, fontWeight: '600', color: colors.t1 },
  docValue: { marginTop: 5, fontSize: 13, lineHeight: 22, color: colors.t2 },

  docTitle: { fontSize: 18, fontWeight: '700', color: colors.t1 },
  docP: { marginTop: 13, fontSize: 14, lineHeight: 26, color: colors.t2, textAlign: 'justify' },
  docFoot: { paddingTop: 14, paddingHorizontal: 4, fontSize: 11, lineHeight: 19, color: colors.t3 }
})

module.exports = Doc

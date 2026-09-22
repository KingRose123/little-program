const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

// 底部「动手算一算」的两行入口（与 article.wxml 一一对应）
const TOOLS = [
  { id: 't1', ico: '🧮', name: '复利计算器', desc: '按你自己的本金与月投，算出 20 年后的样子' },
  { id: 't4', ico: '📈', name: '定投回测', desc: '把分红再投入，看看历史能滚出多少' }
]

/* ---------------- 正文渲染 ----------------
 * 当前接口的 body 是块数组（{ t: 'h' | 'p' | 'q', v }），按类型直接渲染。
 * 另附一个「HTML 字符串 → 块数组」的极简兜底解析（万一以后改成富文本）：
 * 支持 <p> <h1>-<h4> <ul>/<li> <blockquote>，其它标签降级为纯文本，不引入任何依赖。
 */
function stripTags(html) {
  return String(html === null || html === undefined ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function htmlToBlocks(html) {
  const src = String(html === null || html === undefined ? '' : html)
  const blocks = []
  const re = /<(h1|h2|h3|h4|p|li|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi
  let m

  while ((m = re.exec(src)) !== null) {
    const tag = m[1].toLowerCase()
    const text = stripTags(m[2])
    if (!text) continue
    blocks.push({ t: tag.charAt(0) === 'h' ? 'h' : tag === 'blockquote' ? 'q' : 'p', v: text })
  }

  // 一个结构都没解析出来（纯文本或其它标签）就整段降级成一段正文
  if (!blocks.length) {
    const text = stripTags(src)
    if (text) blocks.push({ t: 'p', v: text })
  }
  return blocks
}

// 统一成块数组：已经是数组（当前接口）就用它，是字符串（HTML）就先解析
function bodyBlocks(body) {
  if (body && typeof body.map === 'function') return body
  return htmlToBlocks(body)
}

/** 文章页：正文按块数组渲染，底部两个入口跳到对应工具。 */
class Article extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      article: null
    }
  }

  onLoad(options) {
    this.id = (options && options.id) || 'a1'

    api
      .getArticle(this.id)
      .then((res) => {
        this.setData({ loading: false, article: res.data })
      })
      .catch(util.onError)
  }

  // 文章底部「去看看」：跳到对应工具
  onTool(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/tool/tool?id=' + id })
  }

  // 小程序里是分享菜单用的；App 端还没挂入口，方法体保持原样
  onShare() {
    wx.showToast({ title: '已复制文章链接', icon: 'none' })
  }

  renderBody(blocks) {
    return blocks.map((b, i) => {
      const text = stripTags(b.v)

      if (b.t === 'h') return <Text key={i} style={styles.artH}>{text}</Text>
      if (b.t === 'q') return <Text key={i} style={styles.artQ}>{text}</Text>

      return <Text key={i} style={styles.artP}>{text}</Text>
    })
  }

  render() {
    if (this.data.loading) {
      return (
        <View style={s.page}>
          <ScrollView contentContainerStyle={s.content}>
            <View style={[s.card, styles.empty]}>
              <Text style={styles.emptyEmoji}>📖</Text>
              <Text style={styles.emptyTitle}>正在加载文章…</Text>
            </View>
          </ScrollView>
        </View>
      )
    }

    const a = this.data.article || {}

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          <View style={s.card}>
            <View style={s.row}>
              <Text style={[s.tag, styles.tagGreen]}>{a.tag}</Text>
              <Text style={[s.tiny, s.dim, { marginLeft: 12 }]}>{a.read}</Text>
            </View>

            <Text style={styles.artTitle}>{a.title}</Text>
            <Text style={[s.tiny, s.dim, { marginTop: 12 }]}>更新于 {a.updated}</Text>

            <View style={styles.artBody}>{this.renderBody(bodyBlocks(a.body))}</View>
          </View>

          <View style={styles.secHead}>
            <Text style={s.h3}>动手算一算</Text>
          </View>

          <View style={[s.card, styles.cardFlat]}>
            {TOOLS.map((t, i) => (
              <Pressable
                key={t.id}
                style={[styles.toolRow, i === TOOLS.length - 1 ? styles.rowLast : null]}
                onPress={() => this.onTool(tap({ id: t.id }))}
              >
                <Text style={styles.toolIco}>{t.ico}</Text>
                <View style={s.flex1}>
                  <Text style={[s.mid, s.bold]}>{t.name}</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{t.desc}</Text>
                </View>
                <Text style={styles.arrow}>›</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.artFoot}>本文为理念分享，不构成任何投资建议。</Text>
        </ScrollView>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  tagGreen: { backgroundColor: 'rgba(31, 157, 107, 0.10)', color: colors.primary },

  artTitle: { marginTop: 11, fontSize: 20, fontWeight: '700', lineHeight: 28, color: colors.t1 },
  artBody: { marginTop: 6 },
  artP: { marginTop: 14, fontSize: 14, lineHeight: 27, color: colors.t2, textAlign: 'justify' },
  // 小标题：左侧主色竖条
  artH: {
    marginTop: 22,
    paddingLeft: 10,
    borderLeftWidth: 3,
    borderLeftColor: colors.primary,
    fontSize: 15,
    fontWeight: '700',
    lineHeight: 24,
    color: colors.t1
  },
  // 金句：暖色底 + 描边
  artQ: {
    marginTop: 15,
    paddingVertical: 12,
    paddingHorizontal: 13,
    borderRadius: 8,
    backgroundColor: colors.warm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F2E1BF',
    fontSize: 13,
    lineHeight: 23,
    color: '#8A5B1C'
  },

  secHead: { marginTop: 18, marginBottom: 10, paddingHorizontal: 4 },
  cardFlat: { paddingHorizontal: 14, paddingVertical: 0 },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  rowLast: { borderBottomWidth: 0 },
  toolIco: { marginRight: 10, fontSize: 20 },
  arrow: { fontSize: 17, color: colors.t3 },

  artFoot: { marginTop: 15, paddingHorizontal: 4, fontSize: 11, lineHeight: 19, color: colors.t3 }
})

module.exports = Article

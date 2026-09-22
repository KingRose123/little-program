const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet, InteractionManager } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

// 支出项 / 日志项的标签配色，对齐 app.wxss 的 tag-green / tag-orange / tag-gray
const TAG_STYLE = {
  'tag-green': { backgroundColor: 'rgba(31,157,107,0.1)', color: colors.primary },
  'tag-orange': { backgroundColor: 'rgba(224,137,44,0.14)', color: colors.orange },
  'tag-gray': { backgroundColor: colors.line2, color: colors.t3 }
}
const tagStyle = (cls) => TAG_STYLE[cls] || TAG_STYLE['tag-gray']

/** 分红覆盖详情：概览 + 成长之路 + 支出清单 + 成长日志。数据与文案全部来自 api.getCoverage()。 */
class Coverage extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      loading: true,
      coveredCount: 0,
      totalCount: 0,
      totalYearText: '0.00',
      dividendText: '0.00',
      receivedText: '0.00',
      stageName: '',
      stageIndex: 0,
      stageLine: 0,
      stages: [],
      topped: false,
      nextStageName: '',
      nextStageGapText: '0',
      needCount: 0,
      needGapText: '0',
      coveredAmountText: '0.00',
      stageRatioText: '0%',
      next: null,
      list: [],
      logs: [],
      syncedAt: 0
    }
  }

  onLoad() {
    this.load()
  }

  // 从「生活支出设置」返回时同步刷新；首次进入 onLoad 已触发，这里跳过避免重复请求
  onShow() {
    if (this.data.loading) return
    this.load()
  }

  load() {
    return api
      .getCoverage()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
        // 再补一次写入，逼 RN 重新提交一帧。
        // 首次渲染那帧偶发不提交（见 onLoad 的说明），补一拍最稳。
        setTimeout(() => this.setData({ syncedAt: Date.now() }), 200)
      })
      .catch(util.onError)
  }

  // 右上角齿轮：生活支出设置
  goExpenseSettings() {
    wx.navigateTo({ url: '/pages/life-expense/life-expense' })
  }

  /* ---------------- 概览 ---------------- */

  renderOverview() {
    return (
      <View style={styles.darkCard}>
        {/* 右上角装饰弧：以卡片右上为圆心的圆，配合 overflow:hidden 只露一段弧。

            pointerEvents="none" 是必须的 —— 这是一块 150×150dp 的实心圆
            （有 backgroundColor，因此会参与命中测试），而齿轮正好完全落在它
            的范围里。虽然它在齿轮之前渲染（理论上在下层），但在 Android 上
            「overflow:hidden 裁剪 + 绝对定位子元素」这套组合的触摸分发并不
            可靠，实测齿轮点了没反应。纯装饰元素本就不该参与触摸，
            直接关掉最干净。 */}
        <View style={styles.setArc} pointerEvents="none" />

        <Pressable
          style={styles.setBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          onPress={() => this.goExpenseSettings()}
        >
          <Text style={styles.gear}>⚙</Text>
        </Pressable>

        <Text style={[s.small, s.dimOnDark]}>分红已覆盖</Text>
        <Text style={styles.coverNum}>
          {this.data.coveredCount}
          <Text style={styles.coverUnit}>项支出</Text>
        </Text>

        <View style={styles.dividerDark} />

        <View style={s.row}>
          <View style={s.flex1}>
            <Text style={[s.tiny, s.dimOnDark]}>固定支出总额</Text>
            <Text style={[s.mid, s.num, s.onDark, { marginTop: 8 }]}>{this.data.totalYearText}</Text>
          </View>
          <View style={s.flex1}>
            <Text style={[s.tiny, s.dimOnDark]}>预测年度分红</Text>
            <Text style={[s.mid, s.num, s.onDark, { marginTop: 8 }]}>{this.data.dividendText}</Text>
          </View>
          <View style={[s.flex1, { alignItems: 'flex-end' }]}>
            <Text style={[s.tiny, s.dimOnDark]}>今年已实现</Text>
            <Text style={[s.mid, s.num, s.onDark, { marginTop: 8 }]}>{this.data.receivedText}</Text>
          </View>
        </View>
      </View>
    )
  }

  /* ---------------- 成长之路 ---------------- */

  renderStages() {
    const d = this.data

    return (
      <View style={[s.card, styles.mt]}>
        <View style={s.between}>
          <View style={s.row}>
            <View style={[styles.iconBox, styles.iconSoftGreen]}>
              <Text style={styles.iconText}>🌱</Text>
            </View>
            <Text style={[s.h3, { marginLeft: 6 }]}>成长之路</Text>
          </View>
          <Text style={[s.h3, { color: colors.primary }]}>{d.stageName}</Text>
        </View>

        <View style={styles.stageWrap}>
          <View style={styles.stageLine}>
            <View style={[styles.stageLineIn, { width: d.stageLine + '%' }]} />
          </View>
          <View style={styles.stageDots}>
            {d.stages.map((item) => (
              <View key={item.name} style={styles.stageItem}>
                <View
                  style={[
                    styles.stageDot,
                    item.done ? styles.stageDotDone : null,
                    item.current ? styles.stageDotCurrent : null
                  ]}
                />
                <Text
                  style={[
                    styles.stageName,
                    item.done ? styles.stageNameOn : null,
                    item.current ? styles.stageNameCurrent : null
                  ]}
                >
                  {item.name}
                </Text>
              </View>
            ))}
          </View>
        </View>

        {/* 档位名不能写死：必须取下一档的真实名字，否则会与进度条显示的档位对不上 */}
        <Text style={[s.small, s.dim, { marginTop: 8 }]}>
          {d.topped
            ? '已抵达终点 ✦ ' + d.stageName + '，全部开支都能被分红覆盖'
            : '再覆盖 ' +
              d.needCount +
              ' 项即达成 ✦ ' +
              d.nextStageName +
              '，还需 ' +
              d.needGapText +
              ' 分红'}
        </Text>

        {/* 下一个目标 */}
        {d.next ? (
          <View style={styles.nextBox}>
            <View style={s.between}>
              <Text style={[s.mid, s.bold]}>
                {d.next.icon} {d.next.name} · {d.next.yearText}/年
              </Text>
              <Text style={[s.tiny, { color: colors.orange }]}>{d.next.progress}%</Text>
            </View>
            <View style={[styles.pbar, { marginTop: 8 }]}>
              <View style={[styles.pbarIn, { width: d.next.progress + '%' }]} />
            </View>
            <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{d.next.note}</Text>
          </View>
        ) : null}
      </View>
    )
  }

  /* ---------------- 支出清单 ---------------- */

  renderList() {
    const list = this.data.list

    return (
      <View style={[s.card, styles.mt]}>
        {list.map((item, i) => (
          <View key={item.id} style={[styles.covRow, i ? styles.rowLine : null]}>
            <View style={s.between}>
              <View style={s.row}>
                <Text style={styles.covEmoji}>{item.icon}</Text>
                <Text style={[s.mid, s.bold, { marginLeft: 6 }]}>{item.name}</Text>
                <Text style={[s.tag, tagStyle(item.tagClass), { marginLeft: 6 }]}>
                  {item.tagText}
                </Text>
              </View>
              <View style={s.row}>
                <Text style={[s.tiny, s.dim]}>{item.yearText}/年</Text>
                {item.locked ? <Text style={[styles.lock, { marginLeft: 4 }]}>🔒</Text> : null}
              </View>
            </View>
            <View style={[styles.pbar, { marginTop: 8 }]}>
              <View
                style={[styles.pbarIn, item.done ? styles.pbarGreen : null, { width: item.progress + '%' }]}
              />
            </View>
            <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>{item.note}</Text>
          </View>
        ))}
      </View>
    )
  }

  /* ---------------- 成长日志 ---------------- */

  renderLogs() {
    const d = this.data
    const logs = d.logs

    // 口径说明：上面的档位按**金额**推进（分红能覆盖多少开支），而概览里的
    // 「已覆盖 N 项」按**项数**算。两者同屏出现却不同口径，很容易被当成对不上
    //（覆盖 3/7 项却只走了 15%），所以把算式摆出来。
    //
    // 注意：这段说明写在 JSX 里时（{/* … */}）会导致整页首帧白屏 ——
    // 注释会生成一个空表达式子节点，新架构下渲染提交会卡住，切前后台才恢复。
    // 所以说明一律写成 JS 注释，不要放进 JSX。
    return (
      <View style={[s.card, styles.mt]}>
        <View style={s.row}>
          <View style={[styles.iconBox, styles.iconSoftGold]}>
            <Text style={styles.iconText}>📖</Text>
          </View>
          <Text style={[s.h3, { marginLeft: 6 }]}>成长日志</Text>
        </View>

        <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>
          {'覆盖进度按金额累计（不是按项数）：已覆盖 ' +
            d.coveredAmountText +
            ' / 总支出 ' +
            d.totalYearText +
            ' = ' +
            d.stageRatioText}
        </Text>

        {logs.length ? (
          <View style={{ marginTop: 10 }}>
            {logs.map((item, i) => (
              <View key={item.id} style={[styles.logRow, i ? styles.rowLine : null]}>
                <Text style={[styles.logDate, s.num]}>{item.date}</Text>
                <Text style={[s.small, s.flex1, { marginLeft: 8 }]}>
                  {item.text} {item.target}
                </Text>
                {item.badge ? <Text style={[s.tag, tagStyle(item.badgeClass)]}>{item.badge}</Text> : null}
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.logEmpty}>还没有点亮任何支出，先从最容易的一项开始吧</Text>
        )}
      </View>
    )
  }

  render() {
    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          <Text style={s.h1}>分红覆盖</Text>

          {this.data.loading ? (
            <View style={[s.card, styles.empty, styles.mt]}>
              <Text style={styles.emptyEmoji}>🌱</Text>
              <Text style={styles.emptyTitle}>正在统计覆盖进度…</Text>
            </View>
          ) : (
            <View>
              {this.renderOverview()}
              {this.renderStages()}
              {this.renderList()}
              {this.renderLogs()}
            </View>
          )}
        </ScrollView>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  mt: { marginTop: 12 },

  empty: { paddingVertical: 45, alignItems: 'center' },
  emptyEmoji: { fontSize: 38 },
  emptyTitle: { marginTop: 11, fontSize: 14, color: colors.t2 },

  /* 概览深色卡 */
  darkCard: { backgroundColor: colors.dark, borderRadius: 16, padding: 18, overflow: 'hidden', marginTop: 12 },
  setArc: {
    position: 'absolute',
    right: -75,
    top: -75,
    width: 150,
    height: 150,
    borderRadius: 75,
    backgroundColor: 'rgba(255,255,255,0.12)'
  },
  setBtn: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    // 显式抬到装饰弧之上。不能只靠"后渲染的在上" ——
    // 那套规则在同层级绝对定位元素上并不总成立（见 setArc 的说明）。
    zIndex: 2
  },
  gear: { fontSize: 18, color: 'rgba(255,255,255,0.85)' },
  coverNum: {
    fontSize: 36,
    fontWeight: '700',
    lineHeight: 42,
    marginTop: 4,
    color: '#FFFFFF',
    fontVariant: ['tabular-nums']
  },
  coverUnit: { fontSize: 14, fontWeight: '400', marginLeft: 6, color: 'rgba(255,255,255,0.7)' },
  dividerDark: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginVertical: 12
  },

  /* 图标底 */
  iconBox: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  iconSoftGreen: { backgroundColor: 'rgba(31,157,107,0.1)' },
  iconSoftGold: { backgroundColor: 'rgba(217,169,60,0.14)' },
  iconText: { fontSize: 15 },

  /* 成长之路 */
  stageWrap: { marginTop: 17 },
  stageLine: { height: 4, borderRadius: 999, backgroundColor: '#EFF2F1', overflow: 'hidden' },
  stageLineIn: { height: '100%', borderRadius: 999, backgroundColor: colors.primary },
  // 浮到线上：负 margin 让圆点压在进度线中间
  stageDots: { flexDirection: 'row', marginTop: -7 },
  stageItem: { flex: 1, alignItems: 'center' },
  stageDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#D9DEDC',
    borderWidth: 2,
    borderColor: '#FFFFFF'
  },
  stageDotDone: { backgroundColor: colors.primary },
  stageDotCurrent: { backgroundColor: '#FFFFFF', borderColor: colors.primary },
  stageName: { marginTop: 6, fontSize: 10, color: colors.t3 },
  stageNameOn: { color: colors.primary },
  stageNameCurrent: { color: colors.primary, fontWeight: '600' },

  /* 下一个目标（暖色框） */
  nextBox: {
    marginTop: 13,
    backgroundColor: colors.warm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#F2E1BF',
    borderRadius: 9,
    padding: 12
  },

  /* 进度条：小程序的 --w 变量 → 内联百分比；渐变压平成纯色 */
  pbar: { height: 6, borderRadius: 999, backgroundColor: '#EFF2F1', overflow: 'hidden' },
  pbarIn: { height: '100%', borderRadius: 999, backgroundColor: colors.orange },
  pbarGreen: { backgroundColor: colors.primary },

  /* 支出清单 */
  covRow: { paddingVertical: 12 },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  covEmoji: { fontSize: 17 },
  lock: { fontSize: 12 },

  /* 成长日志 */
  logRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  logDate: { fontSize: 12, color: colors.t3 },
  logEmpty: { marginTop: 12, paddingVertical: 20, textAlign: 'center', fontSize: 12, color: colors.t3 }
})

module.exports = Coverage

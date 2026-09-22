const React = require('react')
const { View, Text, ScrollView, Pressable, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const LoginGuard = require('../components/LoginGuard.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/**
 * 分红日历 + 年度总览（同一页两个标签）。
 * 逻辑与小程序那份一致：切月时先用 buildMonthCells 本地重绘（界面立刻响应），
 * 再异步取分红事件覆盖 —— 视觉上不会闪骨架屏。
 */
class Calendar extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      guest: false,
      segment: 0,

      loading: true,
      year: 2026,
      month: 9,
      title: '',
      week: [],
      cells: [],
      legend: [],
      todayKey: '',
      selectedKey: '',
      monthEvents: [],
      noticeCount: 0,
      noticeAmount: '0.00',
      noticeNextKey: '',

      ovLoading: true,
      ovLoaded: false,
      ovYear: 2026,
      ovReceivedText: '0.00',
      ovMonths: [],
      ovHasData: false
    }
  }

  onLoad() {
    const now = new Date()
    const year = now.getFullYear()
    const month = now.getMonth() + 1
    const todayKey = year + '-' + util.pad(month) + '-' + util.pad(now.getDate())
    this.setData({ year: year, month: month, ovYear: year, todayKey: todayKey, selectedKey: todayKey })
  }

  onShow() {
    this.boot()
  }

  boot() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false, ovLoading: false })
      app.toGuide()
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.load()
    this.loadYearOverview()
  }

  /* ================= 标签切换 ================= */

  setSegment(i) {
    if (i === this.data.segment) return
    this.setData({ segment: i })
  }

  /* ================= 日历 ================= */

  // 连点翻月时会有多个请求同时在飞，只认最后一次，
  // 否则先发的请求后返回，会把上个月的格子盖到当前月（事件就跑错日期了）
  load() {
    const seq = (this.calSeq = (this.calSeq || 0) + 1)
    return api
      .getCalendar({
        year: this.data.year,
        month: this.data.month,
        todayKey: this.data.todayKey,
        selectedKey: this.data.selectedKey
      })
      .then((res) => {
        if (seq !== this.calSeq) return false
        const d = res.data
        this.events = d.events
        this.setData({
          loading: false,
          title: d.title,
          week: d.week,
          cells: d.cells,
          legend: d.legend,
          noticeCount: d.notice.count,
          noticeAmount: d.notice.amountText,
          noticeNextKey: d.notice.nextKey
        })
        this.loadDay(this.data.selectedKey)
        return true
      })
      .catch((e) => {
        util.onError(e)
        return false
      })
  }

  loadDay(key) {
    this.setData({ monthEvents: api.getDayEvents(key, this.events) })
  }

  onDay(e) {
    const key = e.currentTarget.dataset.key
    if (!key || key.indexOf('-') < 0) {
      wx.showToast({ title: '请选择本月日期', icon: 'none' })
      return
    }
    const cells = this.data.cells.map((c) => Object.assign({}, c, { selected: c.key === key }))
    this.setData({ cells: cells, selectedKey: key })
    this.loadDay(key)
  }

  prevMonth() {
    let year = this.data.year
    let month = this.data.month - 1
    if (month < 1) {
      month = 12
      year--
    }
    this.setMonth(year, month)
  }

  nextMonth() {
    let year = this.data.year
    let month = this.data.month + 1
    if (month > 12) {
      month = 1
      year++
    }
    this.setMonth(year, month)
  }

  setMonth(year, month) {
    // 切换月份时保留「几号」，超出该月天数则取月末（如 1/31 -> 2/28）
    const daysInMonth = new Date(year, month, 0).getDate()
    const cur = String(this.data.selectedKey || '').split('-')
    const day = Math.min(Number(cur[2]) || 1, daysInMonth)
    const selectedKey = year + '-' + util.pad(month) + '-' + util.pad(day)

    const base = api.buildMonthCells({ year: year, month: month, todayKey: this.data.todayKey, selectedKey: selectedKey })
    this.setData({
      year: year,
      month: month,
      selectedKey: selectedKey,
      title: base.title,
      week: base.week,
      cells: base.cells
    })

    this.load()
  }

  backToday() {
    const parts = this.data.todayKey.split('-')
    this.setData({
      year: Number(parts[0]),
      month: Number(parts[1]),
      selectedKey: this.data.todayKey
    })
    this.load().then((applied) => {
      if (applied) wx.showToast({ title: '已回到今天', icon: 'none' })
    })
  }

  /* ================= 年度总览 ================= */

  loadYearOverview() {
    return api
      .getYearOverview(this.data.ovYear)
      .then((res) => {
        const d = res.data
        this.setData({
          ovLoading: false,
          ovLoaded: true,
          ovYear: d.year,
          ovReceivedText: d.receivedText,
          ovHasData: d.hasData,
          ovMonths: d.months
        })
      })
      .catch(util.onError)
  }

  loadOvYear(y) {
    if (y < 2000 || y > 2100) {
      wx.showToast({ title: '年份超出可查询范围', icon: 'none' })
      return
    }
    this.setData({ ovYear: y, ovLoading: true })
    this.loadYearOverview().then(() => {
      if (!this.data.ovHasData) {
        wx.showToast({ title: y + ' 年暂无分红记录', icon: 'none' })
      }
    })
  }

  onNotice() {
    const key = this.data.noticeNextKey
    if (!key) {
      wx.showToast({ title: '暂无待除权的分红', icon: 'none' })
      return
    }
    this.goToKey(key, '已跳到最近一笔除权日')
  }

  goNextPayingMonth() {
    const keys = Object.keys(this.events || {}).sort()
    if (!keys.length) {
      wx.showToast({ title: '还没有分红安排，先添加持仓吧', icon: 'none' })
      return
    }

    const monthEnd = this.data.year + '-' + util.pad(this.data.month) + '-32'
    let next = ''
    for (let i = 0; i < keys.length; i++) {
      if (keys[i] > monthEnd) {
        next = keys[i]
        break
      }
    }

    if (!next) {
      wx.showToast({ title: '后面没有更多分红安排', icon: 'none' })
      return
    }
    this.goToKey(next, '已跳到下一笔分红的月份')
  }

  goToKey(key, tip) {
    const parts = key.split('-')
    this.setData({
      year: Number(parts[0]),
      month: Number(parts[1]),
      selectedKey: key
    })
    this.load().then((applied) => {
      if (applied) wx.showToast({ title: tip, icon: 'none' })
    })
  }

  /* ================= 渲染 ================= */

  renderSegments() {
    const items = ['分红日历', '年度总览']
    return (
      <View style={styles.segWrap}>
        {items.map((t, i) => (
          <Pressable
            key={t}
            style={[styles.seg, i === this.data.segment ? styles.segOn : null]}
            onPress={() => this.setSegment(i)}
          >
            <Text style={[s.small, i === this.data.segment ? styles.segTextOn : null]}>{t}</Text>
          </Pressable>
        ))}
      </View>
    )
  }

  renderCalendar() {
    const d = this.data

    return (
      <View>
        {/* 分红预告 */}
        <Pressable style={styles.noticeCard} onPress={() => this.onNotice()}>
          <Text style={[s.tiny, { color: '#8A6A2F' }]}>待对账分红</Text>
          <View style={[s.row, { marginTop: 6 }]}>
            <Text style={styles.noticeAmount}>{d.noticeAmount}</Text>
            <Text style={[s.tiny, { color: '#8A6A2F', marginLeft: 8 }]}>共 {d.noticeCount} 笔</Text>
            <Text style={[s.tiny, { color: '#8A6A2F', marginLeft: 'auto' }]}>看最近一笔 ›</Text>
          </View>
        </Pressable>

        {/* 月份 */}
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.between}>
            <Pressable style={styles.navBtn} onPress={() => this.prevMonth()}>
              <Text style={styles.navText}>‹</Text>
            </Pressable>
            <Text style={s.h3}>{d.title}</Text>
            <View style={s.row}>
              <Pressable style={styles.todayBtn} onPress={() => this.backToday()}>
                <Text style={[s.tiny, { color: colors.primary }]}>今天</Text>
              </Pressable>
              <Pressable style={[styles.navBtn, { marginLeft: 8 }]} onPress={() => this.nextMonth()}>
                <Text style={styles.navText}>›</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.weekRow}>
            {d.week.map((w) => (
              <Text key={w} style={[s.tiny, s.dim, styles.weekCell]}>
                {w}
              </Text>
            ))}
          </View>

          <View style={styles.grid}>
            {d.cells.map((c, i) => (
              <Pressable
                key={c.key || 'empty-' + i}
                style={[styles.cell, c.selected ? styles.cellOn : null]}
                onPress={() => this.onDay(tap({ key: c.key }))}
              >
                <Text
                  style={[
                    s.small,
                    c.outside ? { color: '#C7CDCB' } : null,
                    c.isToday && !c.selected ? { color: colors.primary, fontWeight: '700' } : null,
                    c.selected ? { color: '#FFFFFF' } : null
                  ]}
                >
                  {c.day}
                </Text>
                {dotTypes(c.events).length ? (
                  <View style={styles.dots}>
                    {dotTypes(c.events)
                      .slice(0, 3)
                      .map((t) => (
                        <View
                          key={t}
                          style={[styles.dot, { backgroundColor: c.selected ? '#FFFFFF' : dotColor(t) }]}
                        />
                      ))}
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>

          <View style={styles.legendRow}>
            {d.legend.map((l) => (
              <View key={l.key || l.label} style={[s.row, { marginRight: 14 }]}>
                <View style={[styles.dot, { backgroundColor: dotColor(l.color), marginRight: 4 }]} />
                <Text style={[s.tiny, s.dim]}>{l.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 当日明细 */}
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.between}>
            <Text style={s.h3}>{d.selectedKey} 明细</Text>
            <Pressable onPress={() => this.goNextPayingMonth()}>
              <Text style={[s.tiny, { color: colors.primary }]}>下一笔分红月份 ›</Text>
            </Pressable>
          </View>

          {d.monthEvents.length ? (
            d.monthEvents.map((ev, i) => (
              <View key={i} style={styles.eventRow}>
                <View style={s.flex1}>
                  <View style={s.row}>
                    <Text style={s.mid}>{ev.name}</Text>
                    <Text style={[s.tag, tagStyleOf(ev.tagClass), { marginLeft: 6 }]}>{ev.type}</Text>
                  </View>
                  <Text style={[s.tiny, s.dim, { marginTop: 5 }]}>{ev.code}</Text>
                </View>
                <Text style={[s.mid, s.num, ev.amount ? { color: colors.primary } : null]}>
                  {ev.amountText || ''}
                </Text>
              </View>
            ))
          ) : (
            <Text style={[s.small, s.dim, { marginTop: 12 }]}>这一天没有分红安排</Text>
          )}
        </View>
      </View>
    )
  }

  renderOverview() {
    const d = this.data

    return (
      <View>
        <View style={[s.card, { marginTop: 16 }]}>
          <View style={s.between}>
            <Pressable style={styles.navBtn} onPress={() => this.loadOvYear(d.ovYear - 1)}>
              <Text style={styles.navText}>‹</Text>
            </Pressable>
            <View style={{ alignItems: 'center' }}>
              <Text style={s.h1}>{d.ovYear}</Text>
              <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>已收分红</Text>
            </View>
            <Pressable style={styles.navBtn} onPress={() => this.loadOvYear(d.ovYear + 1)}>
              <Text style={styles.navText}>›</Text>
            </Pressable>
          </View>

          <Text style={[styles.ovAmount, s.num]}>{d.ovReceivedText}</Text>

          <View style={styles.barArea}>
            {d.ovMonths.map((m) => (
              <View key={m.label} style={styles.barCol}>
                <View style={[styles.bar, { height: m.height, backgroundColor: m.active ? colors.primary : colors.line }]} />
                <Text style={[s.tiny, s.dim, { marginTop: 6, fontSize: 9 }]}>{m.label}</Text>
              </View>
            ))}
          </View>

          {!d.ovHasData ? (
            <Text style={[s.small, s.dim, { marginTop: 16, textAlign: 'center' }]}>
              这一年还没有分红记录
            </Text>
          ) : null}
        </View>
      </View>
    )
  }

  render() {
    if (this.data.guest) {
      return (
        <View style={s.page}>
          <LoginGuard
            icon="📅"
            title="登录后查看分红日历"
            desc="登录即可同步持仓、分红与覆盖进度"
            onPress={() => app.toLogin()}
          />
        </View>
      )
    }

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {this.renderSegments()}
          {this.data.segment === 0 ? this.renderCalendar() : this.renderOverview()}
        </ScrollView>
      </View>
    )
  }
}

// 圆点颜色：图例项给的是颜色名（blue / orange / green），事件项给的是类型名，两种都要认
// 取值与小程序 .tag-blue / .tag-orange / .tag-green 一致
const DOT_COLORS = {
  blue: '#3B82C4',
  orange: '#E0892C',
  green: colors.primary,
  股权登记: '#3B82C4',
  除权除息: '#E0892C',
  派息日: colors.primary
}
function dotColor(name) {
  return DOT_COLORS[String(name || '').trim()] || colors.t3
}

// 同一天可能有多笔同类型的事件，圆点按类型去重后再画，最多 3 个
function dotTypes(events) {
  const out = []
  ;(events || []).forEach((e) => {
    if (e && e.type && out.indexOf(e.type) < 0) out.push(e.type)
  })
  return out
}

// 类型标签的配色（与上面同一套色）
const TAG_STYLES = {
  'tag-green': { backgroundColor: 'rgba(31, 157, 107, 0.10)', color: colors.primary },
  'tag-orange': { backgroundColor: 'rgba(224, 137, 44, 0.14)', color: '#E0892C' },
  'tag-blue': { backgroundColor: 'rgba(59, 130, 196, 0.12)', color: '#3B82C4' }
}
const tagStyleOf = (cls) => TAG_STYLES[cls] || { backgroundColor: colors.line2, color: colors.t3 }

const styles = StyleSheet.create({
  segWrap: {
    flexDirection: 'row',
    backgroundColor: colors.line2,
    borderRadius: 10,
    padding: 3
  },
  seg: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: '#FFFFFF' },
  segTextOn: { color: colors.t1, fontWeight: '600' },

  noticeCard: { backgroundColor: colors.warm, borderRadius: 12, padding: 14, marginTop: 16 },
  noticeAmount: { fontSize: 20, fontWeight: '700', color: '#8A6A2F' },

  navBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.line2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  navText: { fontSize: 18, color: colors.t2, lineHeight: 20 },
  todayBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: colors.primarySoft
  },

  weekRow: { flexDirection: 'row', marginTop: 16 },
  weekCell: { flex: 1, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  cell: {
    width: `${100 / 7}%`,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10
  },
  cellOn: { backgroundColor: colors.primary },
  dots: { flexDirection: 'row', marginTop: 3 },
  dot: { width: 5, height: 5, borderRadius: 2.5, marginHorizontal: 1 },
  legendRow: { flexDirection: 'row', marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },

  eventRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },

  ovAmount: { marginTop: 18, fontSize: 34, fontWeight: '700', color: colors.primary, textAlign: 'center' },
  barArea: { flexDirection: 'row', alignItems: 'flex-end', height: 120, marginTop: 20 },
  barCol: { flex: 1, alignItems: 'center' },
  bar: { width: 10, borderRadius: 5, minHeight: 4 }
})

module.exports = Calendar

const React = require('react')
const { View, Text, Pressable, Modal, StyleSheet } = require('react-native')
const { colors, s } = require('../theme.js')

/**
 * 日期选择：自绘的月历面板（底部抽屉）。
 *
 * 为什么不用 @react-native-community/datetimepicker：
 *   Android 上它只能以**系统对话框**出现，外观完全随 ROM 走、改不了
 *   （默认那套滚轮相当老气），iOS 又是另一种形态 —— 两端观感不一致，
 *   也跟 App 自己的配色对不上。这里的月历完全按主题画：
 *   品牌色选中态、圆角抽屉，两端长得一模一样，也不再依赖那个原生模块。
 *
 * 对外接口没变：只暴露 value / onChange，值统一是 'YYYY-MM-DD' 字符串 ——
 * 四个页面（添加持仓 / 成交 / 入账 / 编辑持仓）里的调用一行都不用改。
 */

const WEEK = ['一', '二', '三', '四', '五', '六', '日']

function parse(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || '').trim())
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return isNaN(d.getTime()) ? null : d
}

function fmt(d) {
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function sameDay(a, b) {
  if (!a || !b) return false
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 当月网格：周一开头，前后补空格子把整周对齐 */
function buildCells(year, month) {
  const first = new Date(year, month, 1)
  const lead = (first.getDay() + 6) % 7 // getDay 里 0 是周日，这里换算成「周一为第 0 天」
  const days = new Date(year, month + 1, 0).getDate()
  const cells = []
  for (let i = 0; i < lead; i++) cells.push(0)
  for (let d = 1; d <= days; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(0)
  return cells
}

class DateField extends React.Component {
  constructor(props) {
    super(props)
    const cur = parse(props.value) || new Date()
    this.state = { open: false, year: cur.getFullYear(), month: cur.getMonth(), picked: parse(props.value) }
  }

  // 每次打开都以当前值为准（没值就落今天），免得残留上一次翻月的位置
  open() {
    const base = parse(this.props.value) || new Date()
    this.setState({
      open: true,
      year: base.getFullYear(),
      month: base.getMonth(),
      picked: base
    })
  }

  close() {
    this.setState({ open: false })
  }

  shiftMonth(step) {
    let y = this.state.year
    let m = this.state.month + step
    if (m < 0) {
      m = 11
      y--
    } else if (m > 11) {
      m = 0
      y++
    }
    this.setState({ year: y, month: m })
  }

  choose(day) {
    if (!day) return
    this.setState({ picked: new Date(this.state.year, this.state.month, day) })
  }

  pickToday() {
    const now = new Date()
    this.setState({ year: now.getFullYear(), month: now.getMonth(), picked: now })
  }

  confirm() {
    const d = this.state.picked
    this.close()
    if (d && typeof this.props.onChange === 'function') this.props.onChange(fmt(d))
  }

  render() {
    const p = this.props
    const text = p.value || p.placeholder || '选择日期'
    const st = this.state
    const cells = buildCells(st.year, st.month)
    const today = new Date()

    return (
      <View>
        <View style={s.row}>
          <Pressable style={[s.input, s.flex1, styles.tap]} onPress={() => this.open()}>
            <Text style={styles.calIcon}>📅</Text>
            <Text style={[s.mid, s.flex1, p.value ? null : s.dim]}>{text}</Text>
            <Text style={styles.caret}>▾</Text>
          </Pressable>
          {p.today === false ? null : (
            <Pressable style={styles.todayBtn} onPress={() => this.pickToday()}>
              <Text style={[s.tiny, { color: colors.primary }]}>今天</Text>
            </Pressable>
          )}
        </View>

        <Modal visible={st.open} transparent animationType="slide" onRequestClose={() => this.close()}>
          <View style={styles.modalRoot}>
            <Pressable style={styles.mask} onPress={() => this.close()} />

            <View style={styles.sheet}>
              <View style={[s.between, styles.head]}>
                <Pressable style={styles.headBtn} onPress={() => this.close()}>
                  <Text style={[s.mid, s.dim]}>取消</Text>
                </Pressable>
                <Text style={s.h3}>选择日期</Text>
                <Pressable style={styles.headBtn} onPress={() => this.confirm()}>
                  <Text style={styles.doneText}>完成</Text>
                </Pressable>
              </View>

              <View style={styles.monthBar}>
                <Pressable style={styles.navBtn} onPress={() => this.shiftMonth(-1)}>
                  <Text style={styles.navText}>‹</Text>
                </Pressable>
                <Text style={styles.monthText}>
                  {st.year} 年 {st.month + 1} 月
                </Text>
                <Pressable style={styles.navBtn} onPress={() => this.shiftMonth(1)}>
                  <Text style={styles.navText}>›</Text>
                </Pressable>
              </View>

              <View style={styles.weekRow}>
                {WEEK.map((w) => (
                  <Text key={w} style={styles.weekText}>
                    {w}
                  </Text>
                ))}
              </View>

              <View style={styles.grid}>
                {cells.map((day, i) => {
                  const d = day ? new Date(st.year, st.month, day) : null
                  const on = sameDay(d, st.picked)
                  const isToday = !on && sameDay(d, today)
                  return (
                    <Pressable key={i} style={styles.cell} disabled={!day} onPress={() => this.choose(day)}>
                      <View style={[styles.dayBox, on ? styles.dayOn : null, isToday ? styles.dayToday : null]}>
                        <Text
                          style={[
                            styles.dayText,
                            on ? styles.dayTextOn : null,
                            isToday ? styles.dayTextToday : null
                          ]}
                        >
                          {day ? day : ''}
                        </Text>
                      </View>
                    </Pressable>
                  )
                })}
              </View>

              <View style={styles.foot}>
                <Pressable style={styles.footBtn} onPress={() => this.pickToday()}>
                  <Text style={[s.small, { color: colors.primary }]}>回到今天</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    )
  }
}

const CELL_W = '14.2857%' // 1/7，用百分比让不同屏宽都正好铺满

const styles = StyleSheet.create({
  // 长得像输入框，实际是个按钮（点哪都打开选择器）
  tap: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  calIcon: { fontSize: 13, marginRight: 8 },
  caret: { fontSize: 12, color: colors.t3, marginLeft: 6 },
  todayBtn: {
    marginTop: 8,
    marginLeft: 10,
    height: 46,
    paddingHorizontal: 16,
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  },

  modalRoot: { flex: 1, justifyContent: 'flex-end' },
  mask: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 20
  },
  head: {
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  headBtn: { paddingVertical: 4, paddingHorizontal: 4 },
  doneText: { fontSize: 15, color: colors.primary, fontWeight: '600' },

  monthBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 16
  },
  navBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.line2
  },
  navText: { fontSize: 19, lineHeight: 21, color: colors.t2 },
  monthText: { fontSize: 15, fontWeight: '600', color: colors.t1 },

  weekRow: { flexDirection: 'row', paddingHorizontal: 10, marginTop: 14 },
  weekText: { width: CELL_W, textAlign: 'center', fontSize: 11, color: colors.t3 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingTop: 6 },
  cell: { width: CELL_W, height: 44, alignItems: 'center', justifyContent: 'center' },
  dayBox: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  dayOn: { backgroundColor: colors.primary },
  dayToday: { backgroundColor: colors.primarySoft },
  dayText: { fontSize: 14, color: colors.t1 },
  dayTextOn: { color: '#FFFFFF', fontWeight: '600' },
  dayTextToday: { color: colors.primary, fontWeight: '600' },

  foot: { alignItems: 'center', paddingTop: 10, paddingHorizontal: 18 },
  footBtn: {
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 999,
    backgroundColor: colors.primarySoft
  }
})

module.exports = DateField

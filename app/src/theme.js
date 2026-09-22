const { StyleSheet } = require('react-native')

/**
 * 通用颜色与样式。
 *
 * 小程序那份的公共类（row / between / dim / ml12…）散在 app.wxss 里由页面直接用，
 * RN 没有全局 class，所以把等价的样式对象收在这里，页面按需取用。
 */
const colors = {
  bg: '#F5F7F6',
  card: '#FFFFFF',
  t1: '#1F1F1F',
  t2: '#6B7370',
  t3: '#9AA3A0',
  line: '#EDF0EF',
  line2: '#F4F6F5',
  primary: '#1F9D6B',
  primarySoft: '#EAF6F0',
  orange: '#F09A3C',
  warm: '#FFF7EC',
  up: '#D9534F',
  dark: '#232323',
  gold: '#C9A227'
}

const s = StyleSheet.create({
  flex1: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center' },
  col: { flexDirection: 'column' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  center: { alignItems: 'center', justifyContent: 'center' },

  page: { flex: 1, backgroundColor: colors.bg },
  // 页面内容的统一内边距；底部留出固定元素（悬浮按钮 / 底部栏）的空间
  // 页面内容的统一内边距；paddingTop 是标题条下方的留白，
  // 不然第一张卡片会直接贴着导航栏，看着像糊在一起
  content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 120 },

  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 16
  },
  darkCard: {
    backgroundColor: colors.dark,
    borderRadius: 16,
    padding: 18
  },

  h1: { fontSize: 24, fontWeight: '700', color: colors.t1 },
  h2: { fontSize: 18, fontWeight: '700', color: colors.t1 },
  h3: { fontSize: 16, fontWeight: '600', color: colors.t1 },
  mid: { fontSize: 15, color: colors.t1 },
  small: { fontSize: 13, color: colors.t2 },
  tiny: { fontSize: 12, color: colors.t3 },
  dim: { color: colors.t3 },
  dimOnDark: { color: 'rgba(255,255,255,0.62)' },
  onDark: { color: '#FFFFFF' },
  bold: { fontWeight: '600' },
  // 数字用等宽字形，滚动时不会左右跳
  num: { fontVariant: ['tabular-nums'] },

  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    fontSize: 11,
    overflow: 'hidden'
  },

  mini: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    fontSize: 13,
    color: colors.t2,
    overflow: 'hidden'
  },

  input: {
    height: 46,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.line2,
    fontSize: 15,
    color: colors.t1
  },

  btn: {
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dark
  },
  btnText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' }
})

module.exports = { colors, s }

const React = require('react')
const { View, StyleSheet } = require('react-native')

/**
 * 底部 tab 图标。
 *
 * 小程序那份是 components/tab-bar/tab-bar.wxml + wxss 里用 div 拼出来的
 * （bars / calendar / compass / user），App 这边之前直接用 emoji（📊📅🧭👤）
 * 顶上了——emoji 是彩色字形，既不跟随选中色变化，每个系统长得也不一样。
 * 这里按同一套线宽与比例重画：rpx / 2 = pt，色值由调用方传入（跟随选中态）。
 * 边框在 RN 里是画在 width 之内的（border-box），所以尺寸比 CSS 版略收一点。
 */
function TabIcon(props) {
  const c = props.color || '#9CA3AF'
  const kind = props.name

  if (kind === 'bars') {
    return (
      <View style={styles.box}>
        <View style={styles.barsRow}>
          <View style={[styles.bar, { height: 7.5, backgroundColor: c }]} />
          <View style={[styles.bar, { height: 17, backgroundColor: c }]} />
          <View style={[styles.bar, { height: 12, backgroundColor: c }]} />
        </View>
      </View>
    )
  }

  if (kind === 'calendar') {
    return (
      <View style={styles.box}>
        <View style={[styles.cal, { borderColor: c }]}>
          <View style={[styles.calLeg, { left: 3.5, backgroundColor: c }]} />
          <View style={[styles.calLeg, { right: 3.5, backgroundColor: c }]} />
          <View style={[styles.calHead, { backgroundColor: c }]} />
        </View>
      </View>
    )
  }

  if (kind === 'compass') {
    return (
      <View style={styles.box}>
        <View style={[styles.compass, { borderColor: c }]}>
          <View
            style={[
              styles.needle,
              { backgroundColor: c, transform: [{ rotate: '-45deg' }] }
            ]}
          />
        </View>
      </View>
    )
  }

  // user
  return (
    <View style={styles.box}>
      <View style={[styles.userHead, { borderColor: c }]} />
      <View style={[styles.userBody, { borderColor: c }]} />
    </View>
  )
}

const styles = StyleSheet.create({
  // 小程序 .tab-icon 是 44rpx，这里 22pt
  box: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },

  barsRow: { flexDirection: 'row', alignItems: 'flex-end' },
  bar: { width: 3.5, borderRadius: 2, marginHorizontal: 1.5 },

  cal: {
    width: 17,
    height: 16,
    borderWidth: 1.25,
    borderRadius: 4
  },
  calHead: { position: 'absolute', left: 1, right: 1, top: 4, height: 1.25 },
  calLeg: { position: 'absolute', top: -3, width: 1.25, height: 3.5, borderRadius: 2 },

  compass: { width: 17, height: 17, borderWidth: 1.25, borderRadius: 8.5 },
  // 用 margin 负移替代 translate(-50%,-50%)，百分比位移在部分 RN 版本不支持
  needle: { position: 'absolute', left: '50%', top: '50%', width: 7.5, height: 1.25, marginLeft: -3.75, marginTop: -0.6, borderRadius: 2 },

  userHead: {
    position: 'absolute',
    left: '50%',
    top: 0.5,
    width: 7,
    height: 7,
    marginLeft: -3.5,
    borderWidth: 1.25,
    borderRadius: 3.5
  },
  userBody: {
    position: 'absolute',
    left: '50%',
    bottom: 0.5,
    width: 13,
    height: 6.5,
    marginLeft: -6.5,
    borderWidth: 1.25,
    borderBottomWidth: 0,
    borderTopLeftRadius: 6.5,
    borderTopRightRadius: 6.5
  }
})

module.exports = TabIcon

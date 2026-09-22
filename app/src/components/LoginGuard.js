const React = require('react')
const { View, Text, Pressable, StyleSheet } = require('react-native')
const { colors } = require('../theme.js')

/**
 * 未登录守卫（对应小程序的 <login-guard> 组件）。
 * App 端正常情况下看不到它 —— 登录门禁已经把人挡在登录页了，
 * 留着是为了「token 在页面停留期间失效」这种边角情况不出现白屏。
 */
function LoginGuard(props) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.icon}>{props.icon || '💰'}</Text>
      <Text style={styles.title}>{props.title || '登录后查看'}</Text>
      <Text style={styles.desc}>{props.desc || ''}</Text>
      <Pressable style={styles.btn} onPress={props.onPress}>
        <Text style={styles.btnText}>去登录</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  icon: { fontSize: 52 },
  title: { marginTop: 16, fontSize: 17, fontWeight: '600', color: colors.t1 },
  desc: { marginTop: 8, fontSize: 13, color: colors.t3, textAlign: 'center', lineHeight: 20 },
  btn: {
    marginTop: 24,
    paddingHorizontal: 32,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.dark
  },
  btnText: { color: '#FFFFFF', fontSize: 15, fontWeight: '600' }
})

module.exports = LoginGuard

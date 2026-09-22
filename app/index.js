/**
 * 启动顺序（这里踩过两个很难查的坑，写下原因免得再犯）：
 *
 * 坑一：注册入口必须**同步**发生。
 * 原生侧启动后**立刻**就会调 AppRegistry.runApplication('main')，
 * 只要注册晚一步（哪怕只晚 35 毫秒 —— 把注册放在 async 函数里就会这样），
 * 用户看到的就是 "main has not been registered" 或 Expo 的 "App entry not found"
 * （白屏 + 一句看不懂的话），而且 JS 日志里未必有线索。
 * 所以：同步注册，异步初始化，两者用一个「启动壳」衔接。
 *
 * 坑二：读本地数据要在页面渲染之前完成。
 * 业务逻辑里有 30 多处同步读存储（见 compat/storage.js），数据没进内存就渲染，
 * 页面会以为「用户什么数据都没有」。所以启动壳会等 boot() 完成再挂载真正的 App。
 *
 * 另外：注册只用 RN 自己的 AppRegistry，不用 expo 的 registerRootComponent ——
 * 后者只是薄封装，多一层依赖就多一种失败方式（解构出来是 undefined 时，
 * 调用即抛错，而这个错发生在启动阶段，日志里往往看不到）。
 */

const React = require('react')
const { AppRegistry, View, Text, ActivityIndicator, StyleSheet } = require('react-native')
const storage = require('./src/compat/storage.js')
const wxShim = require('./src/compat/wx.js')
const App = require('./App.js')

// 原生侧 runApplication 用的就是这个名字，不能改
const APP_KEY = 'main'

// 初始化的最坏等待时间。AsyncStorage 理论上不会卡住，
// 但「卡住」的后果是白屏且没有任何提示，代价太大，不值得赌。
const BOOT_TIMEOUT = 4000

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, ms))])
}

async function boot() {
  try {
    await withTimeout(storage.loadAll(), BOOT_TIMEOUT)
  } catch (e) {
    // 读不出来也照常启动：最多是本地数据空一份，云端拉回来还能补
    console.warn('[boot] 读取本地数据失败，按空数据启动', (e && e.message) || e)
  }

  try {
    wxShim.install()
  } catch (e) {
    console.error('[boot] wx 兼容垫片安装失败', (e && e.message) || e)
  }
}

/** 启动壳：等本地数据与垫片就绪，再把真正的 App 挂上去 */
class Root extends React.Component {
  constructor(props) {
    super(props)
    this.state = { ready: false }
  }

  componentDidMount() {
    boot()
      .catch((e) => console.error('[boot] 初始化异常', (e && e.stack) || e))
      .then(() => this.setState({ ready: true }))
  }

  render() {
    if (this.state.ready) return <App />

    // 只有几百毫秒，给个安静的白底 + 名字，避免闪一下黑屏
    return (
      <View style={styles.boot}>
        <Text style={styles.logo}>💰</Text>
        <Text style={styles.name}>收息佬</Text>
        <ActivityIndicator style={{ marginTop: 18 }} color="#1F9D6B" />
      </View>
    )
  }
}

const styles = StyleSheet.create({
  boot: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  logo: { fontSize: 46 },
  name: { marginTop: 10, fontSize: 18, fontWeight: '700', letterSpacing: 4, color: '#1F1F1F' }
})

// 同步注册，必须在最外层执行
AppRegistry.registerComponent(APP_KEY, () => Root)

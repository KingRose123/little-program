const React = require('react')
const { AppState } = require('react-native')
const nav = require('./nav.js')

/**
 * 小程序 Page 的适配层。
 *
 * 页面里最有价值的是方法体（load / 各种事件处理），WXML 反正要改写成 JSX，
 * 所以这里让 this.data / this.setData 在 React 里行为**完全一致**：
 *   - data 是普通对象，setData(patch) 之后 this.data 立刻是新值（读得到自己的写）
 *   - 每次 setData 触发一次重渲染
 * 这样页面方法体可以整段搬过来，只有渲染部分要重写。
 *
 * 生命周期映射：
 *   componentDidMount   → onLoad(params) + onShow()
 *   navigation focus    → onShow()（Tab 来回切换，对应小程序的 onShow）
 *   进后台再回前台      → onHide() / onShow()
 *   componentWillUnmount→ onUnload()（同时清掉 util.backLater 的定时器）
 */
class MiniPage extends React.Component {
  constructor(props) {
    super(props)
    this.state = { v: 0 }
    // 页面代码里习惯写 this.xxx，保持一致
    this.page = this
    this.nav = props.navigation
    this.route = props.route
    this.data = {}
  }

  componentDidMount() {
    const self = this

    // 页面自己设标题（wx.setNavigationBarTitle）：只改自己这一屏
    this._unTitle = nav.onTitle((this.props.route && this.props.route.name) || '', function (title) {
      if (!title) return
      if (self.props.navigation && self.props.navigation.setOptions) {
        self.props.navigation.setOptions({ title: title })
      }
    })

    if (typeof this.onLoad === 'function') {
      this.onLoad((this.props.route && this.props.route.params) || {})
    }
    if (typeof this.onShow === 'function') this.onShow()

    // Tab 切换回来 = 小程序的 onShow（首次挂载已经手动调过，跳过第一次）
    let firstFocus = true
    if (this.props.navigation && this.props.navigation.addListener) {
      this._unFocus = this.props.navigation.addListener('focus', function () {
        if (firstFocus) {
          firstFocus = false
          return
        }
        if (typeof self.onShow === 'function') self.onShow()
      })
    }

    this._appState = AppState.addEventListener('change', function (next) {
      if (next === 'active') {
        if (typeof self.onShow === 'function') self.onShow()
      } else if (next === 'background') {
        if (typeof self.onHide === 'function') self.onHide()
      }
    })
  }

  componentWillUnmount() {
    if (this._unTitle) this._unTitle()
    if (this._unFocus) this._unFocus()
    if (this._appState) this._appState.remove()
    // util.backLater 就是往 page.backTimer 上挂定时器，卸载时清掉
    if (this.backTimer) {
      clearTimeout(this.backTimer)
      this.backTimer = null
    }
    if (typeof this.onUnload === 'function') this.onUnload()
  }

  /**
   * 与小程序语义一致：同步改 data 再触发一次渲染。
   * 不能直接用 this.setState 合并 —— 页面里大量 this.data.xxx 的读取依赖「立刻可见」。
   */
  setData(patch, cb) {
    if (!patch) return
    Object.assign(this.data, patch)
    this.setState({ v: this.state.v + 1 }, cb)
  }

  // util.backLater / cancelBack 通过 page.backTimer 存取
  get backTimer() {
    return this._backTimer
  }

  set backTimer(v) {
    this._backTimer = v
  }
}

module.exports = { MiniPage }

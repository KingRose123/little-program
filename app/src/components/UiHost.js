const React = require('react')
const { View, Text, Modal, ActivityIndicator, StyleSheet, Pressable, TextInput } = require('react-native')
const ui = require('../compat/ui.js')
const validate = require('../utils/validate.js')

/**
 * Toast / Loading / Modal 的渲染层。
 *
 * 兼容层只负责发事件（wx.showToast 等），这里订阅并画出来。
 * 好处是 utils/ 那一整套逻辑完全不用知道 React 存在，也能在 Node 里跑测试。
 * 界面风格沿用小程序那份的暗色 Toast + 居中卡片。
 */
class UiHost extends React.Component {
  constructor(props) {
    super(props)
    this.state = { ui: ui.getState(), input: '' }
  }

  componentDidMount() {
    this._un = ui.subscribe((s) => {
      const patch = { ui: s }
      // 换了新弹窗就预填输入框：编辑已有心得时必须先看到原文，
      // 否则一打开是空白，用户改一个字就等于把原来那段全抹了。
      const m = s.modal
      if (m && m.id !== this._modalId) {
        this._modalId = m.id
        patch.input = String(m.initialContent || '')
      } else if (!m) {
        this._modalId = 0
      }
      this.setState(patch)
    })
  }

  componentWillUnmount() {
    if (this._un) this._un()
  }

  resolve(confirm) {
    const m = this.state.ui.modal
    // 先读出值、再清空：setState 不会立刻改 this.state，
    // 这里正是靠「读到的是清空前的值」，所以两行顺序不能反。
    const value = this.state.input
    this.setState({ input: '' })
    if (m && m.resolve) m.resolve({ confirm: !!confirm, cancel: !confirm, content: value })
  }

  render() {
    const { toast, loading, modal } = this.state.ui
    // 字数按**码点**数，与 plain/clip 的限长口径一致（否则 emoji 会被算成两个）
    const inputLen = modal && modal.editable ? Array.from(this.state.input).length : 0

    return (
      <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
        {loading ? (
          <View style={styles.mask}>
            <View style={styles.loadingBox}>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.loadingText}>{loading.title}</Text>
            </View>
          </View>
        ) : null}

        {toast ? (
          <View pointerEvents="none" style={styles.toastWrap}>
            <View style={styles.toastBox}>
              <Text style={styles.toastText}>{toast.title}</Text>
            </View>
          </View>
        ) : null}

        <Modal
          visible={!!modal}
          transparent
          animationType="fade"
          onRequestClose={() => this.resolve(false)}
        >
          <View style={styles.mask}>
            <View style={styles.modalBox}>
              <Text style={styles.modalTitle}>{modal ? modal.title : ''}</Text>
              {modal && modal.content ? <Text style={styles.modalContent}>{modal.content}</Text> : null}

              {modal && modal.editable ? (
                <TextInput
                  style={[styles.modalInput, modal.multiline ? styles.modalInputMulti : null]}
                  value={this.state.input}
                  onChangeText={(v) =>
                    this.setState({
                      input: validate.plain(v, { max: modal.maxLength, multiline: modal.multiline })
                    })
                  }
                  placeholder={modal.placeholderText}
                  placeholderTextColor="#9AA3A0"
                  autoFocus
                  multiline={modal.multiline}
                  textAlignVertical={modal.multiline ? 'top' : 'center'}
                />
              ) : null}

              {/* 字数只在快到上限时才显示：写短评时它只是噪音，
                  而写长文时又能说清「还有多少余地」，免得对着打不进去发懵 */}
              {modal && modal.editable && modal.multiline && inputLen >= modal.maxLength * 0.8 ? (
                <Text style={styles.modalCount}>
                  {inputLen} / {modal.maxLength}
                </Text>
              ) : null}

              <View style={styles.modalBtns}>
                {modal && modal.cancelText ? (
                  <Pressable style={styles.modalBtn} onPress={() => this.resolve(false)}>
                    <Text style={styles.modalCancel}>{modal.cancelText}</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.modalBtn} onPress={() => this.resolve(true)}>
                  <Text style={styles.modalConfirm}>{modal ? modal.confirmText : '确定'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  mask: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)'
  },
  loadingBox: {
    minWidth: 160,
    paddingHorizontal: 28,
    paddingVertical: 24,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center'
  },
  loadingText: { color: '#FFFFFF', marginTop: 12, fontSize: 14 },
  toastWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  toastBox: {
    maxWidth: '80%',
    paddingHorizontal: 24,
    paddingVertical: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.8)'
  },
  toastText: { color: '#FFFFFF', fontSize: 15, textAlign: 'center' },
  modalBox: {
    width: '82%',
    paddingTop: 28,
    paddingBottom: 8,
    borderRadius: 18,
    backgroundColor: '#FFFFFF'
  },
  modalTitle: { fontSize: 17, fontWeight: '600', color: '#1F1F1F', textAlign: 'center' },
  modalContent: {
    marginTop: 14,
    marginHorizontal: 24,
    fontSize: 14,
    lineHeight: 21,
    color: '#6B7370',
    textAlign: 'center'
  },
  modalInput: {
    marginTop: 18,
    marginHorizontal: 24,
    paddingHorizontal: 14,
    height: 46,
    borderRadius: 10,
    backgroundColor: '#F4F6F5',
    fontSize: 16,
    color: '#1F1F1F'
  },
  // 多行：给足高度并顶部对齐，否则光标会飘在中间（与 AddTrade 的备注框同一处理）。
  // 这是写心得体悟的地方，按「能写长文」给高度，不是只露两行。
  modalInputMulti: { height: 150, paddingTop: 12, paddingBottom: 12, lineHeight: 21 },
  modalCount: {
    marginTop: 6,
    marginHorizontal: 24,
    fontSize: 11,
    textAlign: 'right',
    color: '#9AA3A0'
  },
  modalBtns: {
    flexDirection: 'row',
    marginTop: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#E6EAE8'
  },
  modalBtn: { flex: 1, paddingVertical: 15, alignItems: 'center' },
  modalCancel: { fontSize: 16, color: '#8A9391' },
  modalConfirm: { fontSize: 16, fontWeight: '600', color: '#1F9D6B' }
})

module.exports = UiHost

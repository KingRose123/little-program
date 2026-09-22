const React = require('react')
const {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView
} = require('react-native')
const cloud = require('../utils/cloud.js')
const store = require('../utils/store.js')
const app = require('../app.js')
const ui = require('../compat/ui.js')
const validate = require('../utils/validate.js')

/**
 * 登录 / 注册（用户名 + 密码）。
 *
 * 前面评估过短信验证码登录，最后选了账号密码：不用申请短信服务商、没有按条计费，
 * 也不必处理「验证码收不到」这类客服问题。代价是要有「忘记密码」的兜底，
 * 这一步等后面接短信或邮箱再说（服务端 sms.js 已经留着）。
 *
 * 注册成功即登录（服务端直接发 token），省一次手动登录。
 */
class Login extends React.Component {
  constructor(props) {
    super(props)
    this.state = {
      mode: 'login', // login | register
      username: '',
      password: '',
      confirm: '',
      // 默认不勾选：合规要求「由用户阅读后自行选择是否同意，不得默认强制同意」
      agreed: false,
      busy: false,
      showPwd: false
    }
  }

  setField(key, value) {
    const patch = {}
    patch[key] = value
    this.setState(patch)
  }

  switchMode(mode) {
    if (this.state.mode === mode) return
    this.setState({ mode: mode, password: '', confirm: '' })
  }

  // 用户名统一小写（与服务端一致，避免「Tom」和「tom」被看成两个账号）
  onUsername(v) {
    this.setField('username', String(v).replace(/[^a-zA-Z0-9_]/g, '').toLowerCase().slice(0, 20))
  }

  onSubmit() {
    if (this.state.busy) return

    const username = String(this.state.username).trim()
    const password = String(this.state.password)

    if (!this.state.agreed) {
      ui.toast('请先勾选同意用户协议和隐私政策')
      return
    }
    if (username.length < 4) {
      ui.toast('用户名至少 4 位（小写字母、数字或下划线）')
      return
    }
    if (password.length < 6) {
      ui.toast('密码至少 6 位')
      return
    }
    if (this.state.mode === 'register' && password !== String(this.state.confirm)) {
      ui.toast('两次输入的密码不一致')
      return
    }

    this.setState({ busy: true })
    ui.loading(this.state.mode === 'register' ? '注册中' : '登录中')

    const req =
      this.state.mode === 'register'
        ? cloud.register(username, password)
        : cloud.loginByPassword(username, password)

    req
      .then((res) => {
        const d = (res && res.data) || {}
        cloud.saveLogin(d.token, d.uid)

        // 登录 / 注册成功后先把云端快照拉回来，再切进主界面。
        // 顺序反了的话，主界面会先按本地的空快照渲染 —— 重装 App 或换设备时
        // 看着就是「账号里的数据全没了」，其实只是还没拉下来。
        // 期间保留 loading，避免用户看到「已登录但一条持仓都没有」的中间态。
        return store
          .pullFromCloud()
          .catch(() => false)
          .then(() => {
            ui.hideLoading()
            this.setState({ busy: false })
            app.login({
              username: d.username || username,
              nickName: d.username || username,
              avatar: '👤'
            })
            ui.toast(this.state.mode === 'register' ? '注册成功' : '登录成功')
          })
      })
      .catch((e) => {
        ui.hideLoading()
        this.setState({ busy: false })
        ui.toast((e && e.msg) || '操作失败，请稍后重试')
      })
  }

  render() {
    const { mode, username, password, confirm, agreed, busy, showPwd } = this.state
    const isRegister = mode === 'register'

    return (
      <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.inner} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <Text style={styles.logo}>💰</Text>
            <Text style={styles.appName}>收息佬</Text>
            <Text style={styles.slogan}>记录持仓，追踪分红，规划收息之路</Text>
          </View>

          {/* 登录 / 注册切换 */}
          <View style={styles.segWrap}>
            {[
              { key: 'login', label: '登录' },
              { key: 'register', label: '注册' }
            ].map((t) => (
              <Pressable
                key={t.key}
                style={[styles.seg, mode === t.key ? styles.segOn : null]}
                onPress={() => this.switchMode(t.key)}
              >
                <Text style={[styles.segText, mode === t.key ? styles.segTextOn : null]}>{t.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.form}>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={(v) => this.onUsername(v)}
              placeholder="用户名（4-20 位小写字母 / 数字 / 下划线）"
              placeholderTextColor="#9AA3A0"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <View style={styles.pwdRow}>
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={password}
                onChangeText={(v) => this.setField('password', validate.plain(v, { max: 64 }))}
                placeholder={isRegister ? '设置密码（至少 6 位）' : '密码'}
                placeholderTextColor="#9AA3A0"
                secureTextEntry={!showPwd}
                autoCapitalize="none"
              />
              <Pressable style={styles.eye} onPress={() => this.setField('showPwd', !showPwd)}>
                <Text style={styles.eyeText}>{showPwd ? '隐藏' : '显示'}</Text>
              </Pressable>
            </View>

            {isRegister ? (
              <TextInput
                style={[styles.input, { marginTop: 12 }]}
                value={confirm}
                onChangeText={(v) => this.setField('confirm', validate.plain(v, { max: 64 }))}
                placeholder="再输一次密码"
                placeholderTextColor="#9AA3A0"
                secureTextEntry={!showPwd}
                autoCapitalize="none"
              />
            ) : null}

            <Pressable style={[styles.mainBtn, busy ? styles.mainBtnOff : null]} onPress={() => this.onSubmit()}>
              <Text style={styles.mainBtnText}>
                {busy ? '处理中…' : isRegister ? '注册并登录' : '登录'}
              </Text>
            </Pressable>

            <View style={styles.agreeRow}>
              <Pressable style={styles.checkbox} onPress={() => this.setField('agreed', !agreed)}>
                <Text style={styles.tick}>{agreed ? '✓' : ''}</Text>
              </Pressable>
              <Text style={styles.agreeText}>
                我已阅读并同意
                <Text
                  style={styles.link}
                  onPress={() => this.props.navigation.navigate('Doc', { key: 'agreement' })}
                >
                  《用户协议》
                </Text>
                和
                <Text
                  style={styles.link}
                  onPress={() => this.props.navigation.navigate('Doc', { key: 'privacy' })}
                >
                  《隐私政策》
                </Text>
              </Text>
            </View>

            <Text style={styles.note}>
              账号用于同步你的持仓与分红记录。密码只保存加密哈希值，我们看不到也无法还原你的明文密码。
              忘记密码请通过「我的 → 联系我们」联系我们重置。
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    )
  }
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFFFFF' },
  inner: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: 32, paddingVertical: 40 },
  brand: { alignItems: 'center', marginBottom: 32 },
  logo: { fontSize: 68 },
  appName: { marginTop: 16, fontSize: 28, fontWeight: '700', color: '#1F1F1F', letterSpacing: 4 },
  slogan: { marginTop: 10, fontSize: 13, color: '#8A9391' },

  segWrap: {
    flexDirection: 'row',
    backgroundColor: '#F4F6F5',
    borderRadius: 10,
    padding: 3,
    marginBottom: 22
  },
  seg: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center' },
  segOn: { backgroundColor: '#FFFFFF' },
  segText: { fontSize: 14, color: '#8A9391' },
  segTextOn: { color: '#1F1F1F', fontWeight: '600' },

  form: { width: '100%' },
  input: {
    height: 50,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: '#F4F6F5',
    fontSize: 15,
    color: '#1F1F1F'
  },
  pwdRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  eye: { marginLeft: 10, paddingHorizontal: 6, paddingVertical: 8 },
  eyeText: { fontSize: 13, color: '#1F9D6B' },

  mainBtn: {
    marginTop: 24,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#1F1F1F'
  },
  mainBtnOff: { backgroundColor: '#C9CFCC' },
  mainBtnText: { color: '#FFFFFF', fontSize: 17, fontWeight: '600' },

  agreeRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 22 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: '#1F9D6B',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginTop: 2
  },
  tick: { color: '#1F9D6B', fontSize: 12, lineHeight: 14 },
  agreeText: { flex: 1, fontSize: 12, lineHeight: 19, color: '#8A9391' },
  link: { color: '#1F9D6B' },
  note: { marginTop: 18, fontSize: 11, lineHeight: 17, color: '#B0B7B4' }
})

module.exports = Login

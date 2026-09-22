const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, Modal, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const LoginGuard = require('../components/LoginGuard.js')
const app = require('../app.js')
const api = require('../utils/api.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

// 这几个 key 都跳「说明文档」页，由 doc 页按 key 分流内容
const DOC_KEYS = ['standard', 'contact', 'disclaimer', 'agreement', 'privacy']

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })
const val = (v) => ({ detail: { value: v } })

class Profile extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      guest: false,
      loading: true,
      submitting: false,
      user: {},
      member: {},
      expenseCount: 0,
      monthExpenseText: '0',
      yearExpenseText: '0',
      group1: [],
      group2: [],

      curOpen: false,
      curCode: '',
      curList: [],

      accOpen: false,
      accounts: [],
      activeAccId: '',

      addAccOpen: false,
      accForm: { name: '', broker: '' }
    }
  }

  onShow() {
    this.boot()
  }

  boot() {
    if (!app.isLogin()) {
      this.setData({ guest: true, loading: false })
      app.toGuide()
      return
    }
    if (this.data.guest) this.setData({ guest: false })
    this.refresh()
  }

  /**
   * 先对齐服务端档位，再渲染。
   *
   * 为什么不能直接 load()：会员档位的**权威值在服务端**（兑换码和订单都在那边
   * 记账），本地那份只是缓存。App 启动时确实会在后台同步一次（App.js 的
   * syncOnBoot），但那是「发出去就不管」的异步调用，而本页 onShow 紧接着
   * 就读缓存渲染了 —— 两者竞态的结果是：刚开通、刚续费、或刚被后台改过档位的
   * 用户，进来看到的仍是**旧档位**。表现就是「服务器上明明是 Pro，App 里还是普通会员」。
   *
   * 所以这里把顺序定死：先同步、再读。加最小间隔是因为 onShow 每次切回本页
   * 都会走一遍，没必要反复打请求（与 App.js 里 SYNC_MIN_GAP 同一个考虑）。
   */
  refresh() {
    const now = Date.now()
    if (now - (this._syncedAt || 0) < 5000) return this.load()

    this._syncedAt = now
    return api
      .syncMembership()
      .catch(() => null)
      .then(() => this.load())
  }

  load() {
    return api
      .getProfile()
      .then((res) => {
        this.setData(Object.assign({ loading: false }, res.data))
      })
      .catch(util.onError)
  }

  goExpense() {
    wx.navigateTo({ url: '/pages/life-expense/life-expense' })
  }

  onPro() {
    wx.navigateTo({ url: '/pages/membership/membership' })
  }

  /* ---------------- 设置项分流 ---------------- */

  onItem(e) {
    const key = e.currentTarget.dataset.key

    if (DOC_KEYS.indexOf(key) > -1) {
      wx.navigateTo({ url: '/pages/doc/doc?key=' + key })
      return
    }

    if (key === 'member') {
      wx.navigateTo({ url: '/pages/membership/membership' })
      return
    }

    if (key === 'currency') {
      this.openCurrency()
      return
    }

    if (key === 'account') {
      this.openAccounts()
      return
    }

    // 已清仓标的的复盘台：卖出至今涨跌 + 每笔决策的想法
    if (key === 'archive') {
      wx.navigateTo({ url: '/pages/archive/archive' })
      return
    }

    if (key === 'username') {
      const hit = this.data.group1.filter((it) => it.key === 'username')[0] || {}
      wx.showModal({
        title: '登录账号',
        content:
          (hit.value || '未知') +
          '\n\n用户名用于登录与区分账号，密码只保存加密哈希值。忘记密码请联系我们重置。',
        showCancel: false
      })
      return
    }

  }

  /* ---------------- 显示货币 ---------------- */

  openCurrency() {
    api
      .getCurrencyOptions()
      .then((res) => {
        this.setData({ curOpen: true, curCode: res.data.current, curList: res.data.list })
      })
      .catch(util.onError)
  }

  closeCurrency() {
    if (this.data.curOpen) this.setData({ curOpen: false })
  }

  onPickCurrency(e) {
    const code = e.currentTarget.dataset.code
    if (code === this.data.curCode) {
      this.closeCurrency()
      return
    }

    util
      .submit(this, api.saveCurrency(code), { loadingText: '切换中', success: '已切换显示货币' })
      .then((r) => {
        if (!r) return
        this.setData({ curCode: code })
        this.closeCurrency()
        this.load()
      })
  }

  /* ---------------- 多账户管理 ---------------- */

  openAccounts() {
    api
      .getAccounts()
      .then((res) => {
        this.setData({
          accOpen: true,
          accounts: res.data.list,
          activeAccId: res.data.activeId
        })
      })
      .catch(util.onError)
  }

  closeAccounts() {
    if (this.data.accOpen) this.setData({ accOpen: false })
  }

  refreshAccounts() {
    return api.getAccounts().then((res) => {
      this.setData({ accounts: res.data.list, activeAccId: res.data.activeId })
      this.load()
    })
  }

  onPickAccount(e) {
    const id = e.currentTarget.dataset.id
    if (id === this.data.activeAccId) {
      this.closeAccounts()
      return
    }

    util
      .submit(this, api.switchAccount(id), { loadingText: '切换中', success: '已切换账户' })
      .then((r) => {
        if (!r) return
        this.closeAccounts()
        this.refreshAccounts()
      })
  }

  onRemoveAccount(e) {
    const id = e.currentTarget.dataset.id
    const acc = this.data.accounts.filter((a) => a.id === id)[0] || {}

    // 说清楚会带走什么：账户下的持仓是跟着账户一起走的
    const n = Number(acc.holdingCount) || 0
    const extra = n ? '，该账户下的 ' + n + ' 只持仓与流水也会一并清除' : ''

    wx.showModal({
      title: '删除账户',
      content: '删除「' + acc.name + '」后不可恢复' + extra + '，确定继续吗？',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.removeAccount(id), { loadingText: '删除中', success: '已删除' })
          .then((r) => {
            if (r) this.refreshAccounts()
          })
      }
    })
  }

  openAddAccount() {
    this.setData({ addAccOpen: true, accForm: { name: '', broker: '' } })
  }

  closeAddAccount() {
    if (this.data.addAccOpen) this.setData({ addAccOpen: false })
  }

  onAccInput(e) {
    const field = e.currentTarget.dataset.field
    const accForm = Object.assign({}, this.data.accForm)
    // 账户名与券商都是纯文本，限长防止撑破卡片
    accForm[field] = validate.plain(e.detail.value, { max: field === 'name' ? 20 : 30 })
    this.setData({ accForm: accForm })
  }

  onSubmitAccount() {
    const f = this.data.accForm
    if (!String(f.name).trim()) {
      wx.showToast({ title: '请填写账户名称', icon: 'none' })
      return
    }

    util
      .submit(this, api.addAccount(f), { loadingText: '添加中', success: '已添加' })
      .then((r) => {
        if (!r) return
        const list = r.data
        const created = list[list.length - 1]
        this.setData({ addAccOpen: false })

        if (created) {
          api
            .switchAccount(created.id)
            .then(() => this.refreshAccounts())
            .catch(util.onError)
        } else {
          this.refreshAccounts()
        }
      })
  }

  /* ---------------- 退出 / 注销 ---------------- */

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录，确定继续吗？',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.logout(), { loadingText: '退出中', success: '已退出登录' })
          .then((r) => {
            if (!r) return
            app.logout()
          })
      }
    })
  }

  onDestroyAccount() {
    wx.showModal({
      title: '注销账号',
      content:
        '注销会删除服务器与本机的全部数据（账号、持仓、分红记录与设置），且不可恢复。确定继续吗？',
      confirmText: '确认注销',
      success: (res) => {
        if (!res.confirm) return
        util
          .submit(this, api.destroyAccount(), { loadingText: '注销中', success: '账号已注销' })
          .then((r) => {
            if (!r) return
            app.logout()
          })
      }
    })
  }

  /* ---------------- 渲染 ---------------- */

  renderRow(item) {
    return (
      <Pressable key={item.key} style={styles.menuRow} onPress={() => this.onItem(tap({ key: item.key }))}>
        <Text style={styles.menuIcon}>{item.icon}</Text>
        <Text style={[s.mid, { flex: 1, marginLeft: 12 }]}>{item.name}</Text>
        {item.value ? <Text style={[s.small, s.dim]}>{item.value}</Text> : null}
        <Text style={[s.dim, { marginLeft: 8 }]}>›</Text>
      </Pressable>
    )
  }

  render() {
    if (this.data.guest) {
      return (
        <View style={s.page}>
          <LoginGuard
            icon="👤"
            title="登录后查看我的"
            desc="登录即可同步持仓、分红与个人设置"
            onPress={() => app.toLogin()}
          />
        </View>
      )
    }

    const m = this.data.member || {}
    const u = this.data.user || {}

    // 会员身份的三个判断，顶部卡片整块都靠它们分档。
    // 三个标志都由 api 层给出（见 getProfile 的 member），页面不再自己推导档位 ——
    // 那种「页面再判一次 tier」的写法迟早会和 api 的判断跑偏。
    const isPro = !!m.isPro
    const isLite = !!m.isLite
    const isPaid = !!m.isPaid

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {/* 用户卡 —— 「我是谁 + 我什么身份」最该一眼看清的地方。
              所以档位不能只靠一个容易看漏的小胶囊：Pro 与普通要拉开明显差别，
              否则付了钱的用户翻到这页会觉得「跟没开一样」（这正是反馈的原话）。
              差别做三层，任何一层单独看都够辨认：
                1) 卡片：Pro 加金色描边 + 右上角光晕；
                2) 昵称旁：Pro 是金色「👑 Pro」徽章，普通是素色「普通会员」；
                3) 副标题：付费用户直接给到期日，其他人给一句引导。 */}
          <View style={[styles.userCard, isPro ? styles.userCardPro : null]}>
            <View style={s.between}>
              <View style={[s.row, s.flex1]}>
                <View style={[styles.avatar, isPro ? styles.avatarPro : null]}>
                  <Text style={{ fontSize: 24 }}>{u.avatar || '👤'}</Text>
                </View>
                <View style={{ marginLeft: 14, flex: 1 }}>
                  <View style={s.row}>
                    <Text style={[styles.nick, isPro ? styles.nickPro : null]} numberOfLines={1}>
                      {u.nickName || '收息佬用户'}
                    </Text>
                    <View style={[styles.tierTag, isPro ? styles.tierTagPro : isLite ? styles.tierTagLite : null]}>
                      <Text style={[styles.tierTagText, isPro ? styles.tierTagTextPro : null]}>
                        {isPro ? '👑 Pro' : isLite ? 'Lite' : '普通会员'}
                      </Text>
                    </View>
                  </View>
                  <Text style={[s.tiny, s.dimOnDark, { marginTop: 8 }]} numberOfLines={1}>
                    {isPaid ? '有效期至 ' + (m.expiresAt || '—') : u.slogan || '开通会员解锁全部功能'}
                  </Text>
                </View>
              </View>
              <Pressable style={[styles.proChip, isPro ? styles.proChipPro : null]} onPress={() => this.onPro()}>
                <Text style={[styles.proChipText, isPro ? styles.proChipTextPro : null]}>
                  {isPaid ? '管理' : '去开通'}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* 会员卡 */}
          <Pressable style={[s.card, { marginTop: 16 }, s.between]} onPress={() => this.onPro()}>
            <View style={s.row}>
              <Text style={{ color: '#4C86C6', fontSize: 13 }}>◆</Text>
              <Text style={[s.mid, s.bold, { marginLeft: 10 }]}>{m.tierName || '免费版'}</Text>
              <Text style={[s.tiny, s.dim, { marginLeft: 10 }]}>
                {m.isPaid ? '· ' + m.expiresAt + ' 到期' : '· ' + (m.tip || '')}
              </Text>
            </View>
            <View style={s.row}>
              {m.cta ? <Text style={styles.cta}>{m.cta}</Text> : null}
              <Text style={s.dim}>›</Text>
            </View>
          </Pressable>

          {/* 生活支出 */}
          <Pressable style={[s.card, { marginTop: 16 }]} onPress={() => this.goExpense()}>
            <View style={s.between}>
              <View style={s.row}>
                <Text style={{ fontSize: 18 }}>☕</Text>
                <Text style={[s.h3, { marginLeft: 10 }]}>生活支出</Text>
              </View>
              <Text style={s.dim}>›</Text>
            </View>
            <View style={styles.expRow}>
              <View style={s.flex1}>
                <Text style={s.h3}>{this.data.expenseCount}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>支出项</Text>
              </View>
              <View style={s.flex1}>
                <Text style={s.h3}>{this.data.monthExpenseText}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>每月支出</Text>
              </View>
              <View style={s.flex1}>
                <Text style={s.h3}>{this.data.yearExpenseText}</Text>
                <Text style={[s.tiny, s.dim, { marginTop: 6 }]}>每年支出</Text>
              </View>
            </View>
          </Pressable>

          {/* 设置组 */}
          <View style={styles.group}>{this.data.group1.map((it) => this.renderRow(it))}</View>
          <View style={styles.group}>{this.data.group2.map((it) => this.renderRow(it))}</View>

          <Pressable style={[s.card, { marginTop: 16, alignItems: 'center' }]} onPress={() => this.onLogout()}>
            <Text style={{ color: colors.up, fontSize: 15 }}>退出登录</Text>
          </Pressable>

          <Pressable style={{ marginTop: 18, alignItems: 'center' }} onPress={() => this.onDestroyAccount()}>
            <Text style={[s.small, s.dim]}>注销账号</Text>
          </Pressable>

          {/* 备案号：填了 utils/mock.js 的 appInfo.icpNo 才显示 */}
          {this.data.icpNo ? (
            <Text style={[s.tiny, s.dim, { marginTop: 16, textAlign: 'center' }]}>{this.data.icpNo}</Text>
          ) : null}
        </ScrollView>

        {/* 显示货币 */}
        <Modal visible={this.data.curOpen} transparent animationType="slide" onRequestClose={() => this.closeCurrency()}>
          <Pressable style={styles.mask} onPress={() => this.closeCurrency()} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>显示货币</Text>
            {this.data.curList.map((c) => (
              <Pressable
                key={c.code}
                style={styles.sheetItem}
                onPress={() => this.onPickCurrency(tap({ code: c.code }))}
              >
                <Text style={[s.mid, { flex: 1 }, c.code === this.data.curCode ? { color: colors.primary } : null]}>
                  {c.label}
                </Text>
                {c.code === this.data.curCode ? <Text style={{ color: colors.primary }}>✓</Text> : null}
              </Pressable>
            ))}
          </View>
        </Modal>

        {/* 多账户 */}
        <Modal visible={this.data.accOpen} transparent animationType="slide" onRequestClose={() => this.closeAccounts()}>
          <Pressable style={styles.mask} onPress={() => this.closeAccounts()} />
          <View style={styles.sheet}>
            <View style={[s.between, { marginBottom: 8 }]}>
              <Text style={styles.sheetTitle}>投资账户</Text>
              <Pressable onPress={() => this.openAddAccount()}>
                <Text style={{ color: colors.primary, fontSize: 14 }}>＋ 新增</Text>
              </Pressable>
            </View>

            {this.data.accounts.map((a) => (
              <View key={a.id} style={styles.accRow}>
                <Pressable style={s.flex1} onPress={() => this.onPickAccount(tap({ id: a.id }))}>
                  <View style={s.row}>
                    <Text style={s.mid}>{a.name}</Text>
                    {a.id === this.data.activeAccId ? (
                      <Text style={[s.tiny, { color: colors.primary, marginLeft: 8 }]}>使用中</Text>
                    ) : null}
                  </View>
                  <Text style={[s.tiny, s.dim, { marginTop: 4 }]}>
                    {a.broker || '自定义账户'} · {a.holdingCount || 0} 只持仓
                  </Text>
                </Pressable>
                <Pressable onPress={() => this.onRemoveAccount(tap({ id: a.id }))}>
                  <Text style={[s.tiny, { color: colors.up }]}>删除</Text>
                </Pressable>
              </View>
            ))}
          </View>
        </Modal>

        {/* 新增账户 */}
        <Modal
          visible={this.data.addAccOpen}
          transparent
          animationType="fade"
          onRequestClose={() => this.closeAddAccount()}
        >
          <View style={[styles.mask, s.center]}>
            <View style={styles.dialog}>
              <Text style={s.h3}>新增账户</Text>
              <TextInput
                style={[s.input, { marginTop: 14 }]}
                value={this.data.accForm.name}
                onChangeText={(v) => this.onAccInput(Object.assign(tap({ field: 'name' }), val(v)))}
                placeholder="账户名称，如「A股主账户」"
                placeholderTextColor={colors.t3}
              />
              <TextInput
                style={[s.input, { marginTop: 10 }]}
                value={this.data.accForm.broker}
                onChangeText={(v) => this.onAccInput(Object.assign(tap({ field: 'broker' }), val(v)))}
                placeholder="券商 / 说明（可选）"
                placeholderTextColor={colors.t3}
              />
              <View style={[s.row, { marginTop: 20 }]}>
                <Pressable style={[s.btn, s.flex1, { backgroundColor: colors.line2 }]} onPress={() => this.closeAddAccount()}>
                  <Text style={[s.btnText, { color: colors.t2 }]}>取消</Text>
                </Pressable>
                <View style={{ width: 12 }} />
                <Pressable style={[s.btn, s.flex1]} onPress={() => this.onSubmitAccount()}>
                  <Text style={s.btnText}>确定</Text>
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
  // overflow:'hidden' 保留着 —— 不是为了光晕（它已经删了），而是因为
  // Pro 态的 borderWidth 描边配上圆角时，不裁的话某些机型会在圆角外侧
  // 露出一线底色。
  userCard: { backgroundColor: colors.dark, borderRadius: 16, padding: 18, overflow: 'hidden' },

  // Pro 的金色描边。
  //
  // ⚠️ 这里曾经还有一个「右上角光晕」（绝对定位的半透明金圆）。它已被删除，
  // 记一下原因，免得以后有人觉得「不够华丽」又加回来：
  //   1) 它不占布局位置，却把视觉重量全压在右上角 —— 整张卡的重心被拽歪，
  //      第一眼会觉得右侧的「管理」按钮没居中（其实垂直居中一直是准的）；
  //   2) 不裁切时它糊在卡片外面，像渲染错位；裁切后又只剩半块生硬的弧，
  //      比不画还难看。
  // 结论：这种「绝对定位 + 半透明大色斑」的伪渐变不适合用在有对齐诉求的
  // 版式里。Pro 的识别度交给下面三层就够了 —— 描边、昵称旁的金色徽章、
  // 副标题的到期日，任何一层单独看都能分辨。
  userCardPro: { borderWidth: 1, borderColor: 'rgba(245,169,75,0.5)' },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarPro: { backgroundColor: 'rgba(245,169,75,0.18)' },
  nick: { fontSize: 17, fontWeight: '600', color: '#FFFFFF' },
  // Pro：昵称本身转金 —— 「VIP 化」里最直接的一层。
  //
  // 名字是这张卡上最显眼的文字，**用颜色做区分最省事也最不动布局**。
  // 上一版试过在右上角叠半透明色块，结果把右侧「管理」按钮的视觉重心都带歪了；
  // 改文字颜色则完全不影响任何元素的位置。
  // 普通会员不加这条，保持默认的白色。
  nickPro: { color: '#F5A94B' },
  // 昵称旁的身份徽章：普通是素色，Pro 转金。这是三层区分里最关键的一层 ——
  // 它就在昵称旁边，视线扫过名字时一定会看到。
  tierTag: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.14)'
  },
  tierTagPro: { backgroundColor: 'rgba(245,169,75,0.24)' },
  tierTagLite: { backgroundColor: 'rgba(76,134,198,0.28)' },
  tierTagText: { fontSize: 11, fontWeight: '600', color: 'rgba(255,255,255,0.82)' },
  tierTagTextPro: { color: '#F5A94B' },
  proChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.14)'
  },
  proChipPro: { backgroundColor: 'rgba(240,154,60,0.22)' },
  proChipText: { fontSize: 12, color: 'rgba(255,255,255,0.82)' },
  proChipTextPro: { color: '#F5A94B' },
  cta: { fontSize: 12, color: colors.primary, marginRight: 6 },

  expRow: {
    flexDirection: 'row',
    marginTop: 16,
    paddingTop: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line
  },

  group: { backgroundColor: '#FFFFFF', borderRadius: 14, marginTop: 16, paddingHorizontal: 16 },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 15,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  menuIcon: { fontSize: 16 },

  mask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 30
  },
  sheetTitle: { fontSize: 15, fontWeight: '600', color: colors.t1, marginBottom: 6 },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  accRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  dialog: { width: '84%', backgroundColor: '#FFFFFF', borderRadius: 16, padding: 20, marginBottom: 80 }
})

module.exports = Profile

const React = require('react')
const { View, Text, ScrollView, Pressable, TextInput, Modal, StyleSheet } = require('react-native')
const { MiniPage } = require('../compat/page.js')
const { colors, s } = require('../theme.js')
const api = require('../utils/api.js')
const wxpay = require('../utils/wxpay.js')
const util = require('../utils/util.js')
const validate = require('../utils/validate.js')

const tap = (dataset) => ({ currentTarget: { dataset: dataset } })

/** 会员页：当前档位 + 权益对比 + 方案选择。 */
class Membership extends MiniPage {
  constructor(props) {
    super(props)
    this.data = {
      ready: false, // 本地权益数据已渲染
      error: false, // 连本地数据都拿不到（理论上不该发生，兜底用）
      submitting: false,

      status: {},
      tiers: [],
      features: [],
      plans: [],
      notes: [],
      // 当前选中的方案（底部购买栏读它）
      pickedKey: '',
      picked: {},
      // 权益表的标题与脚注：免费开放期会换成「档位规划」的说法，由 api 层给
      tableTitle: '',
      tableNote: '',
      // 兑换码弹窗（RN 没有 editable 的 showModal，自己画一个）
      codeOpen: false,
      code: '',
      // 「去哪买兑换码」的说明，来自服务端（卖码渠道会变，写死就得发版）。
      // 拿不到时为 null，页面用兜底文案。
      guide: null,
      guideOpen: false
    }
  }

  onLoad() {
    this.load()
  }

  // 开通 / 兑换回来，重新对齐一次档位
  onShow() {
    if (this.data.ready) this.load()
  }

  /* ---------------- 渲染 ---------------- */

  apply(d) {
    // 已选的方案优先保留，否则用默认档（热门 Pro）
    const keys = d.plans.map((p) => p.key)
    const pickedKey = keys.indexOf(this.data.pickedKey) > -1 ? this.data.pickedKey : d.defaultPlanKey

    this.setData({
      ready: true,
      error: false,
      status: d.status,
      tiers: d.tiers,
      features: d.features,
      plans: d.plans,
      notes: d.notes,
      tableTitle: d.tableTitle,
      tableNote: d.tableNote,
      pickedKey: pickedKey,
      picked: d.plans.filter((p) => p.key === pickedKey)[0] || {}
    })
  }

  /**
   * 权益表与方案都是本地定义，先同步渲染出来 ——
   * 这个页面是用户「看自己有哪些权益」的地方，不能因为一次网络请求慢或失败就一片空白。
   * 渲染完再去服务端对齐档位（换设备登录后需要），拿到后重渲染一次。
   */
  load() {
    try {
      this.apply(api.membershipVM())
    } catch (e) {
      console.error('[membership] 权益数据渲染失败', e)
      this.setData({ ready: false, error: true })
      return Promise.resolve()
    }

    // 购买指引跟主数据**并行**取，而且失败不算错：
    // 它只是「去哪买码」的一段说明，拿不到就退化成兜底文案，
    // 不能让这页本身跟着失败（api 层已经把失败转成空结果了）。
    api.getPayChannels().then((res) => {
      this.setData({ guide: ((res && res.data) || {}).guide || null })
    })

    return api
      .syncMembership()
      .then((changed) => {
        if (changed) this.apply(api.membershipVM())
      })
      .catch(() => null)
  }

  onRetry() {
    this.setData({ error: false })
    this.load()
  }

  /* ---------------- 方案选择 ---------------- */

  onPick(e) {
    const key = e.currentTarget.dataset.key
    this.setData({
      pickedKey: key,
      picked: this.data.plans.filter((p) => p.key === key)[0] || {}
    })
  }

  /* ---------------- 开通 ---------------- */

  /**
   * 开通：服务端下单签名 → 微信 SDK 调起支付 → 回来轮询等发货。
   *
   * 与小程序那版的差别：那边是 wx.requestVirtualPayment（小程序虚拟支付通道），
   * App 端没有这个接口，走的是微信支付 APIv3 的 APP 支付，靠原生 SDK 调起
   * （见 utils/wxpay.js）。
   *
   * 注意当前全员免费（utils/membership.js 的 FREE_FOR_ALL），入口是隐藏的，
   * 所以下面这条链路要走起来，得同时满足：服务端配好商户号与证书 + 包里装了微信 SDK。
   */
  onBuy() {
    // 免费开放期不卖会员 —— 兜底拦一道，万一入口被绕过也不该收钱
    if (this.data.status && this.data.status.selling === false) {
      wx.showToast({ title: '当前全员免费，无需开通', icon: 'none' })
      return
    }

    const plan = this.data.picked
    if (!plan || !plan.key || this.data.submitting) return

    // 原生 SDK 没打进包里（例如跑在 Expo Go 上）：说清楚，别给一个必然崩的入口
    if (!wxpay.available()) {
      wx.showModal({ title: '暂不支持在线支付', content: wxpay.reason(), showCancel: false })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建订单', mask: true })

    api
      .createMembershipOrder(plan.key)
      .then((res) => {
        wx.hideLoading()
        if (!res || res.code !== 0) throw { msg: (res && res.msg) || '下单失败' }
        this.pay(res.data)
      })
      .catch((e) => {
        wx.hideLoading()
        this.setData({ submitting: false })
        util.onError(e)
      })
  }

  // 调起微信收银台。参数全部来自服务端，客户端不改动其中任何一个
  pay(params) {
    wxpay
      .pay(params)
      .then(() => this.awaitDelivery(params.outTradeNo))
      .catch((e) => {
        this.setData({ submitting: false })
        // -2 是用户主动取消，不必打扰
        if (e && (e.errCode === -2 || e.errStr === '-2')) return
        wx.showModal({
          title: '支付未完成',
          content: (e && (e.errStr || e.msg)) || '请稍后重试',
          showCancel: false
        })
      })
  }

  /**
   * 支付成功后等发货。
   * 官方明确说调起支付的回调可能丢失，所以不能只看它 ——
   * 回来轮询服务端的订单状态，以服务端有没有发货为准。
   */
  awaitDelivery(outTradeNo) {
    if (!outTradeNo) return this.load()

    wx.showLoading({ title: '开通中', mask: true })
    let tries = 0

    const tick = () => {
      tries++

      api
        .getOrderStatus(outTradeNo)
        .then((res) => {
          const d = (res && res.data) || {}

          if (d.status === 'paid') {
            wx.hideLoading()
            this.setData({ submitting: false })
            wx.showToast({ title: '已开通', icon: 'success' })
            this.load()
            return
          }

          if (tries >= 6) {
            wx.hideLoading()
            this.setData({ submitting: false })
            wx.showModal({
              title: '正在开通',
              content: '支付已成功，开通可能还需一会儿。稍后回到本页会自动刷新；若长时间未开通，请联系我们。',
              showCancel: false
            })
            this.load()
            return
          }

          setTimeout(tick, 1500)
        })
        .catch(() => {
          wx.hideLoading()
          this.setData({ submitting: false })
          wx.showToast({ title: '支付已成功，稍后自动开通', icon: 'none' })
          this.load()
        })
    }

    tick()
  }

  /* ---------------- 兑换码 ---------------- */

  // 兑换码：校验在服务端，本地不硬编码任何码
  onRedeem() {
    this.setData({ codeOpen: true, code: '' })
  }

  closeCode() {
    this.setData({ codeOpen: false })
  }

  // 「怎么拿到兑换码」。没有独立页面，用一个弹窗就够 ——
  // 内容只有几句：去哪买、怎么收到码、在哪兑换。
  openGuide() {
    this.setData({ guideOpen: true })
  }

  closeGuide() {
    this.setData({ guideOpen: false })
  }

  submitCode() {
    const code = String(this.data.code || '').trim()
    // 空码时以前是静默返回，用户点了「确定」像没反应；这里给出明确提示
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'none' })
      return
    }
    if (code.length < 4) {
      wx.showToast({ title: '兑换码长度不对', icon: 'none' })
      return
    }

    this.setData({ codeOpen: false })
    util
      .submit(this, api.redeemMembership(code), { loadingText: '兑换中', success: '已开通' })
      .then((res) => {
        if (res) this.load()
      })
  }

  /* ---------------- 渲染 ---------------- */

  renderPlan(item) {
    const on = item.key === this.data.pickedKey

    return (
      <Pressable
        key={item.key}
        style={[styles.plan, on ? styles.planOn : null]}
        onPress={() => this.onPick(tap({ key: item.key }))}
      >
        {item.badge ? (
          <View style={[styles.planBadge, item.best ? styles.planBadgeBest : null]}>
            <Text style={[styles.planBadgeText, item.best ? styles.planBadgeBestText : null]}>
              {item.badge}
            </Text>
          </View>
        ) : null}

        <View style={styles.planHead}>
          <View style={s.flex1}>
            <View style={s.row}>
              <Text style={styles.planName}>{item.name}</Text>
              {item.owned ? <Text style={styles.planOwn}>使用中</Text> : null}
            </View>
            {item.subText ? <Text style={[s.tiny, s.dim, { marginTop: 8 }]}>{item.subText}</Text> : null}
          </View>
          <View style={styles.planPrice}>
            <Text style={[styles.planNum, s.num]}>{item.priceText}</Text>
            {item.unit ? <Text style={styles.planUnit}>{item.unit}</Text> : null}
            {item.originText ? <Text style={styles.planStrike}>{item.originText}</Text> : null}
          </View>
        </View>

        {item.metaText ? <Text style={styles.planMeta}>{item.metaText}</Text> : null}
        {item.tip ? <Text style={styles.planTip}>💡 {item.tip}</Text> : null}
      </Pressable>
    )
  }

  render() {
    if (this.data.error) {
      return (
        <View style={s.page}>
          <View style={[s.card, styles.err]}>
            <Text style={styles.errEmoji}>😵</Text>
            <Text style={[s.h3, { marginTop: 8 }]}>会员权益加载失败</Text>
            <Text style={[s.tiny, s.dim, { marginTop: 8, textAlign: 'center' }]}>
              请点重试；如果一直失败，可通过「我的 → 联系我们」反馈
            </Text>
            <Pressable style={styles.errBtn} onPress={() => this.onRetry()}>
              <Text style={styles.errBtnText}>重试</Text>
            </Pressable>
          </View>
        </View>
      )
    }

    const st = this.data.status
    const selling = st.selling

    // 购买指引（服务端下发）。没取到时 steps 为空，弹窗里走兜底文案，
    // 所以这里不需要为「guide 是 null」单独写一套渲染。
    const guide = this.data.guide || {}
    const steps = guide.steps || []
    const contact = guide.contact || ''

    return (
      <View style={s.page}>
        <ScrollView contentContainerStyle={s.content}>
          {/* 当前档位 */}
          <View style={styles.status}>
            <View style={s.between}>
              <View style={s.row}>
                <Text style={styles.crown}>👑</Text>
                <View style={{ marginLeft: 12 }}>
                  <Text style={styles.statusName}>{st.tierName}</Text>
                  <Text style={[s.tiny, s.dimOnDark, { marginTop: 8 }]}>{st.statusText}</Text>
                </View>
              </View>
              {st.isPaid ? <Text style={styles.statusTag}>剩 {st.daysLeft} 天</Text> : null}
            </View>
            {!st.isPaid ? <Text style={styles.statusFree}>{st.freeText}</Text> : null}
          </View>

          {/* 免费开放期：说清楚哪些权益已经免费，避免有人为「本来就免费的功能」付钱 */}
          {!selling ? (
            <View style={[s.card, styles.freeOpen]}>
              <View style={s.row}>
                <Text style={styles.freeEmoji}>🎉</Text>
                <View style={[s.flex1, { marginLeft: 12 }]}>
                  <Text style={[s.mid, s.bold]}>全员免费开放中</Text>
                  <Text style={[s.tiny, s.dim, { marginTop: 8, lineHeight: 18 }]}>
                    持仓数量、港股美股、多账户等功能全部免费使用，无需开通。后续如调整档位会提前公告。
                  </Text>
                </View>
              </View>
            </View>
          ) : null}

          {/* 权益对比 */}
          <View style={s.card}>
            <Text style={styles.secTitleCenter}>{this.data.tableTitle}</Text>

            <View style={styles.tHead}>
              <Text style={styles.cName}>功能</Text>
              <Text style={styles.cVal}>免费</Text>
              <Text style={styles.cVal}>Lite</Text>
              <Text style={[styles.cVal, styles.proCol]}>Pro</Text>
            </View>

            {this.data.features.map((item) => (
              <View key={item.name} style={styles.tRow}>
                <View style={styles.cName}>
                  <Text style={styles.cell}>{item.name}</Text>
                  {item.soon ? <Text style={styles.soon}>即将上线</Text> : null}
                </View>
                <Text style={[styles.cVal, item.free === '不支持' ? styles.off : null]}>{item.free}</Text>
                <Text style={[styles.cVal, item.lite === '不支持' ? styles.off : null]}>{item.lite}</Text>
                <Text style={[styles.cVal, styles.proCol, styles.on]}>{item.pro}</Text>
              </View>
            ))}

            <Text style={styles.tableNote}>{this.data.tableNote}</Text>
          </View>

          {/* 选择方案 */}
          <Text style={[styles.secTitle, { marginTop: 16 }]}>选择方案</Text>
          {this.data.plans.map((p) => this.renderPlan(p))}

          {/* 说明 */}
          <View style={styles.notes}>
            {this.data.notes.map((n, i) => (
              <View key={i} style={styles.noteRow}>
                <Text style={styles.tick}>✓</Text>
                <Text style={[s.small, s.flex1, { marginLeft: 8 }]}>{n}</Text>
              </View>
            ))}
          </View>

          {/* 兑换码的两个入口：跟购买入口同生共死 —— 免费开放期隐藏，改回收费自动出现。
              「还没码」那个是给新用户看的：点支付发现不支持、点兑换又没码，
              如果这时候没地方可去，这条路就断了。 */}
          {selling ? (
            <View style={styles.redeemRow}>
              <Pressable onPress={() => this.onRedeem()}>
                <Text style={styles.redeem}>有兑换码？点击兑换 ›</Text>
              </Pressable>
              <Pressable onPress={() => this.openGuide()}>
                <Text style={[styles.redeem, styles.redeemSub]}>还没码？看看怎么获取 ›</Text>
              </Pressable>
            </View>
          ) : null}
        </ScrollView>

        {/* 底部栏：免费开放期整条换成说明条，不给付款入口 */}
        {this.data.ready && !selling ? (
          <View style={styles.buyBar}>
            <View style={styles.buyInfo}>
              <Text style={styles.buyPriceFree}>免费开放中</Text>
              <Text style={styles.buySub}>全部功能已解锁，无需开通</Text>
            </View>
            <View style={[styles.buyBtn, styles.buyBtnOff]}>
              <Text style={styles.buyBtnText}>已免费</Text>
            </View>
          </View>
        ) : null}

        {this.data.ready && selling ? (
          <View style={styles.buyBar}>
            <View style={styles.buyInfo}>
              <Text style={styles.buyPrice}>
                {this.data.picked.priceText}
                {this.data.picked.unit ? (
                  <Text style={styles.buyUnit}>{this.data.picked.unit}</Text>
                ) : null}
              </Text>
              <Text style={styles.buySub}>
                {this.data.picked.name}
                {this.data.picked.subText ? ' · ' + this.data.picked.subText : ''}
              </Text>
            </View>
            <Pressable
              style={[styles.buyBtn, this.data.submitting ? styles.buyBtnOff : null]}
              onPress={() => this.onBuy()}
            >
              <Text style={styles.buyBtnText}>{this.data.submitting ? '处理中…' : '立即开通'}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* 兑换码弹窗：RN 的 showModal 不支持输入，自己画一个 */}
        <Modal
          visible={this.data.codeOpen}
          transparent
          animationType="fade"
          onRequestClose={() => this.closeCode()}
        >
          <View style={styles.codeMask}>
            <View style={styles.codeBox}>
              <Text style={s.h3}>输入兑换码</Text>
              <TextInput
                style={[s.input, { marginTop: 14 }]}
                value={this.data.code}
                onChangeText={(v) => this.setData({ code: validate.code(v, { max: 32 }) })}
                placeholder="请输入兑换码"
                placeholderTextColor={colors.t3}
                autoCapitalize="characters"
              />

              {/* 在这里也放一个「怎么获取」：用户多半是听说要用码才点进来的，
                  打开发现手里没有码 —— 正好是他最需要知道去哪买的时候 */}
              <Pressable
                style={{ marginTop: 12, alignItems: 'center' }}
                onPress={() => {
                  this.closeCode()
                  this.openGuide()
                }}
              >
                <Text style={[s.tiny, styles.guideLink]}>还没有兑换码？看看怎么获取 ›</Text>
              </Pressable>

              <View style={[s.row, { marginTop: 16 }]}>
                <Pressable style={[s.flex1, styles.codeBtn]} onPress={() => this.closeCode()}>
                  <Text style={[s.mid, s.dim]}>取消</Text>
                </Pressable>
                <View style={styles.codeGap} />
                <Pressable style={[s.flex1, styles.codeBtn, styles.codeBtnOn]} onPress={() => this.submitCode()}>
                  <Text style={[s.mid, { color: colors.primary }]}>兑换</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* 「怎么拿到兑换码」。
            内容由服务端下发：卖码渠道会变（今天闲鱼、明天淘宝、后天加客服微信），
            写死在 App 里意味着每改一句话都要发版等审核。
            改服务端的 REDEEM_GUIDE_* 环境变量重启即可，App 一行都不用动。 */}
        <Modal
          visible={this.data.guideOpen}
          transparent
          animationType="fade"
          onRequestClose={() => this.closeGuide()}
        >
          <View style={styles.codeMask}>
            <View style={styles.codeBox}>
              <Text style={s.h3}>{guide.title || '如何获取兑换码'}</Text>

              {steps.length ? (
                <View style={{ marginTop: 16, alignSelf: 'stretch' }}>
                  {steps.map((t, i) => (
                    <View key={i} style={styles.stepRow}>
                      <View style={styles.stepNo}>
                        <Text style={styles.stepNoText}>{i + 1}</Text>
                      </View>
                      <Text style={[s.small, s.flex1, styles.stepText]}>{t}</Text>
                    </View>
                  ))}
                </View>
              ) : (
                <Text style={[s.small, s.dim, styles.guideFallback]}>
                  兑换码通过购买或活动获得。如果不知道该从哪里拿，请联系我们。
                </Text>
              )}

              {contact ? (
                <View style={styles.contactBox}>
                  <Text style={[s.small, styles.contactText]}>{contact}</Text>
                </View>
              ) : null}

              {/* 底部按钮直接给「去兑换」：看完说明的人下一步几乎一定是这个动作，
                  让他关掉弹窗再去找入口是多余的一步 */}
              <Pressable
                style={[styles.guideBtn, { alignSelf: 'stretch', marginTop: 18 }]}
                onPress={() => {
                  this.closeGuide()
                  this.onRedeem()
                }}
              >
                <Text style={[s.mid, { color: colors.primary }]}>我已拿到码，去兑换</Text>
              </Pressable>

              <Pressable style={{ marginTop: 12, alignItems: 'center' }} onPress={() => this.closeGuide()}>
                <Text style={[s.mid, s.dim]}>关闭</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    )
  }
}

const styles = StyleSheet.create({
  /* 错误兜底 */
  err: { marginTop: 12, alignItems: 'center', paddingVertical: 34 },
  errEmoji: { fontSize: 38 },
  errBtn: {
    marginTop: 16,
    paddingHorizontal: 28,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: colors.primarySoft
  },
  errBtnText: { fontSize: 14, color: colors.primary, fontWeight: '600' },

  /* 当前档位 */
  status: { backgroundColor: colors.dark, borderRadius: 16, padding: 18, marginTop: 12 },
  crown: { fontSize: 26 },
  statusName: { fontSize: 17, fontWeight: '700', color: '#FFFFFF' },
  statusTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
    fontSize: 11,
    color: '#FFFFFF',
    overflow: 'hidden'
  },
  statusFree: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.14)',
    fontSize: 11.5,
    lineHeight: 19,
    color: 'rgba(255,255,255,0.66)'
  },

  /* 免费开放期 */
  freeOpen: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(47, 181, 126, 0.28)',
    backgroundColor: 'rgba(47, 181, 126, 0.08)'
  },
  freeEmoji: { fontSize: 22, flexShrink: 0 },

  /* 权益对比表 */
  secTitleCenter: {
    marginBottom: 12,
    textAlign: 'center',
    fontSize: 15,
    fontWeight: '600',
    color: colors.t1
  },
  secTitle: { marginBottom: 10, paddingHorizontal: 4, fontSize: 15, fontWeight: '600', color: colors.t1 },
  tHead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line
  },
  tRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line2
  },
  cName: { flex: 1.7, flexDirection: 'row', alignItems: 'center', paddingRight: 6 },
  cVal: { flex: 1, textAlign: 'center', fontSize: 11.5, color: colors.t2 },
  cell: { fontSize: 12.5, color: colors.t1 },
  proCol: { color: colors.primary },
  on: { fontWeight: '600' },
  off: { color: colors.t3 },
  soon: {
    marginLeft: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.line2,
    fontSize: 9,
    color: colors.t3,
    overflow: 'hidden'
  },
  tableNote: { marginTop: 13, fontSize: 11, lineHeight: 18, color: colors.t3 },

  /* 方案卡 */
  plan: {
    marginBottom: 10,
    padding: 15,
    borderRadius: 14,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.line
  },
  planOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  planBadge: {
    alignSelf: 'flex-start',
    marginBottom: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: colors.line2,
    overflow: 'hidden'
  },
  // 「最超值」标签。
  //
  // 原来这里是绿色底（colors.primary = #1F9D6B）配 planBadgeText 的灰色字
  // （colors.t2 = #6B7370）—— 两者亮度接近，对比度只有约 1.8:1，
  // 远低于正文可读所需的 4.5:1，实际就是一团糊。
  //
  // 换成金色底 + 深棕字，对比度约 7:1。选金色还有个语义上的好处：
  // 「最超值」是推荐标记，本来就该用暖色，而绿色在本页是"已选中 / 主操作"
  // 的颜色（planOn 的描边、底部开通按钮），拿它当徽章底色会和选中态打架。
  planBadgeBest: { backgroundColor: '#F0A83C' },
  // 灰色取 #5C6360 而不是 colors.t2(#6B7370)：后者配浅灰底只有 4.49:1，
  // 恰好卡在 4.5 的达标线下面 —— 差 0.01 也是不合格，而且这种"差一点点"
  // 靠肉眼根本发现不了，只有算出来才知道。这一档深灰是 5.5:1。
  planBadgeText: { fontSize: 10, fontWeight: '600', color: '#5C6360' },
  // 与 planBadgeText 同字号字重，只换颜色 —— 分开定义而不是覆盖，
  // 是因为「热门」那个徽章继续用浅灰底 + 灰字（4.3:1，及格），不该被牵连。
  planBadgeBestText: { fontSize: 10, fontWeight: '600', color: '#4A3200' },
  planHead: { flexDirection: 'row', alignItems: 'flex-start' },
  planName: { fontSize: 15, fontWeight: '700', color: colors.t1 },
  planOwn: {
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: colors.primarySoft,
    fontSize: 10,
    color: colors.primary,
    overflow: 'hidden'
  },
  planPrice: { flexDirection: 'row', alignItems: 'flex-end', flexShrink: 0 },
  planNum: { fontSize: 20, fontWeight: '700', color: colors.t1 },
  planUnit: { marginLeft: 2, fontSize: 11, color: colors.t3 },
  planStrike: {
    marginLeft: 8,
    fontSize: 11,
    color: colors.t3,
    textDecorationLine: 'line-through'
  },
  planMeta: { marginTop: 10, fontSize: 11.5, color: colors.t2 },
  planTip: { marginTop: 6, fontSize: 11, color: colors.orange },

  /* 说明 */
  notes: { marginTop: 6, marginBottom: 4 },
  noteRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7 },
  tick: { fontSize: 12, color: colors.primary },

  /* 兑换码的两个入口 */
  redeemRow: { marginTop: 20, alignItems: 'center' },
  redeem: { textAlign: 'center', fontSize: 12, color: colors.primary },
  // 第二个入口（还没码）弱一档：两行一样抢眼反而看不出哪个是主路径
  redeemSub: { marginTop: 10, color: colors.t2 },

  /* 底部栏 */
  buyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    backgroundColor: '#FFFFFF'
  },
  buyInfo: { flex: 1 },
  buyPrice: { fontSize: 19, fontWeight: '700', color: colors.t1 },
  buyPriceFree: { fontSize: 19, fontWeight: '700', color: colors.primary },
  buyUnit: { fontSize: 11, color: colors.t3 },
  buySub: { marginTop: 3, fontSize: 11, color: colors.t3 },
  buyBtn: {
    paddingHorizontal: 26,
    paddingVertical: 11,
    borderRadius: 24,
    backgroundColor: colors.dark
  },
  buyBtnOff: { backgroundColor: colors.primarySoft },
  buyBtnText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },

  /* 兑换码弹窗 */
  codeMask: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32
  },
  codeBox: { width: '100%', padding: 20, borderRadius: 16, backgroundColor: '#FFFFFF' },
  codeBtn: { height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 10, backgroundColor: colors.line2 },
  codeBtnOn: { backgroundColor: colors.primarySoft },
  codeGap: { width: 12 },

  /* 「怎么获取兑换码」弹窗 */
  guideLink: { color: colors.primary },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 12 },
  stepNo: {
    width: 19,
    height: 19,
    borderRadius: 10,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1
  },
  stepNoText: { fontSize: 11, fontWeight: '700', color: colors.primary },
  stepText: { marginLeft: 9, lineHeight: 20, color: colors.t1 },
  guideFallback: { marginTop: 14, lineHeight: 21, textAlign: 'center' },
  // 联系方式单独框出来：它是要被拿去加微信/发邮件的，
  // 混在步骤文字里很容易看漏
  contactBox: {
    alignSelf: 'stretch',
    marginTop: 16,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  },
  contactText: { textAlign: 'center', fontWeight: '600', color: colors.primary },
  guideBtn: {
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 10,
    backgroundColor: colors.primarySoft
  }
})

module.exports = Membership

const React = require('react')
const { View, Text, StyleSheet, AppState } = require('react-native')
const { StatusBar } = require('expo-status-bar')
const { NavigationContainer, createNavigationContainerRef } = require('@react-navigation/native')
const { createNativeStackNavigator } = require('@react-navigation/native-stack')
const { createBottomTabNavigator } = require('@react-navigation/bottom-tabs')
const { SafeAreaProvider } = require('react-native-safe-area-context')

const nav = require('./src/compat/nav.js')
const wxShim = require('./src/compat/wx.js')
const cloud = require('./src/utils/cloud.js')
const store = require('./src/utils/store.js')
const api = require('./src/utils/api.js')
const appInst = require('./src/app.js')
const { colors } = require('./src/theme.js')
const UiHost = require('./src/components/UiHost.js')
const TabIcon = require('./src/components/TabIcon.js')
const FloatingTabBar = require('./src/components/FloatingTabBar.js')
const { NavBar } = require('./src/components/NavBar.js')
const LoginScreen = require('./src/screens/Login.js')
const HoldingsScreen = require('./src/screens/Holdings.js')
const AddHoldingScreen = require('./src/screens/AddHolding.js')
const HoldingDetailScreen = require('./src/screens/HoldingDetail.js')
const CalendarScreen = require('./src/screens/Calendar.js')
const DiscoverScreen = require('./src/screens/Discover.js')
const ProfileScreen = require('./src/screens/Profile.js')
const HoldingRecordScreen = require('./src/screens/HoldingRecord.js')
const AddTradeScreen = require('./src/screens/AddTrade.js')
const AddDividendScreen = require('./src/screens/AddDividend.js')
const LifeExpenseScreen = require('./src/screens/LifeExpense.js')
const MetricSettingsScreen = require('./src/screens/MetricSettings.js')
const RankScreen = require('./src/screens/Rank.js')
const ArticleScreen = require('./src/screens/Article.js')
const DocScreen = require('./src/screens/Doc.js')
const CoverageScreen = require('./src/screens/Coverage.js')
const ToolScreen = require('./src/screens/Tool.js')
const MembershipScreen = require('./src/screens/Membership.js')
const OnboardingScreen = require('./src/screens/Onboarding.js')
const ArchiveScreen = require('./src/screens/Archive.js')

const navigationRef = createNavigationContainerRef()
const Stack = createNativeStackNavigator()
const Tab = createBottomTabNavigator()

// 已经迁移完成的页面（其余仍是占位）
const SCREENS = {
  Holdings: HoldingsScreen,
  AddHolding: AddHoldingScreen,
  HoldingDetail: HoldingDetailScreen,
  Calendar: CalendarScreen,
  Discover: DiscoverScreen,
  Profile: ProfileScreen,
  HoldingRecord: HoldingRecordScreen,
  AddTrade: AddTradeScreen,
  AddDividend: AddDividendScreen,
  LifeExpense: LifeExpenseScreen,
  MetricSettings: MetricSettingsScreen,
  Rank: RankScreen,
  Article: ArticleScreen,
  Doc: DocScreen,
  Coverage: CoverageScreen,
  Tool: ToolScreen,
  Membership: MembershipScreen,
  Onboarding: OnboardingScreen,
  Archive: ArchiveScreen
}

/**
 * 统一入口：已迁移的页面渲染真实组件，其余的显示占位。
 * 这样每轮迁移一个新页面，只需要往 SCREENS 里加一行，导航结构完全不用动。
 */
function Placeholder(props) {
  const Real = SCREENS[props.route.name]

  if (Real) return <Real {...props} />

  return (
    <View style={styles.ph}>
      <Text style={styles.phName}>{props.route.name}</Text>
      <Text style={styles.phSub}>页面迁移中</Text>
    </View>
  )
}

/**
 * 给页面套一层自绘标题条（原生 header 已在下面全局关掉）。
 *
 * 按 initialTitle 缓存组件实例：如果每次 render 都现造一个函数组件，
 * App 重渲染（登录态切换）时整棵树会被当成换类型而重建。
 */
const shellCache = new Map()

function withBar(initialTitle) {
  const key = initialTitle || ''
  let Made = shellCache.get(key)
  if (!Made) {
    Made = function ScreenWithBar(props) {
      return (
        <View style={shellStyles.wrap}>
          <NavBar route={props.route} navigation={props.navigation} initialTitle={initialTitle} />
          <View style={shellStyles.body}>
            <Placeholder {...props} />
          </View>
        </View>
      )
    }
    shellCache.set(key, Made)
  }
  return Made
}

/**
 * 与小程序 app.json 的 tabBar + components/tab-bar/tab-bar.js 逐项对齐：
 * 文案、顺序、图标画法都取自小程序那份，改小程序时要同步改这里。
 */
const TAB_LIST = [
  { name: 'Holdings', title: '持仓', icon: 'bars' },
  { name: 'Calendar', title: '分红日历', icon: 'calendar' },
  { name: 'Discover', title: '发现', icon: 'compass' },
  { name: 'Profile', title: '我的', icon: 'user' }
]

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        // 同上：tab 页的标题也走 ScreenWithBar 里那条自绘的
        headerShown: false
      }}
      // 换成悬浮式毛玻璃导航栏：不再用原生 tabBar。
      // 配色、圆角、悬浮缝隙、划过动效都在组件里（components/FloatingTabBar.js），
      // 图标与标题仍来自上面的 TAB_LIST，避免两处各写一份。
      tabBar={(props) => <FloatingTabBar {...props} icons={TAB_LIST.map((t) => t.icon)} />}
    >
      {TAB_LIST.map((t) => (
        <Tab.Screen key={t.name} name={t.name} component={withBar(t.title)} options={{ title: t.title }} />
      ))}
    </Tab.Navigator>
  )
}

/**
 * 顶部标题：与小程序各页 *.json 的 navigationBarTitleText 一一对应。
 * 没登记在这里的就是小程序里继承 app.json 的「收息佬」。
 * Doc / HoldingRecord / Tool / Rank 会在 onLoad 里再调 setNavigationBarTitle 覆盖。
 */
const TITLES = {
  HoldingDetail: '收息佬',
  HoldingRecord: '持仓记录',
  AddHolding: '收息佬',
  AddTrade: '收息佬',
  AddDividend: '收息佬',
  Article: '文章',
  Coverage: '收息佬',
  LifeExpense: '收息佬',
  Membership: '收息佬会员',
  MetricSettings: '汇总指标设置',
  Archive: '投资档案',
  Rank: '榜单',
  Tool: '工具',
  Doc: '说明',
  // 引导页正文里自己画了「收息佬」大字（Onboarding.js 的 heroName），
  // 这里再给同名标题，顶部会连着出现两次。留空：不显示标题，返回键照旧。
  Onboarding: ''
}

// 登录后才会出现的页面
const AUTH_PAGES = [
  'HoldingDetail',
  'HoldingRecord',
  'AddHolding',
  'AddTrade',
  'AddDividend',
  'Article',
  'Coverage',
  'LifeExpense',
  'Membership',
  'MetricSettings',
  'Archive',
  'Rank',
  'Tool'
]

// 登录前也要能打开的页面（协议正文、引导流 —— 登录页上会跳过去）
const PUBLIC_PAGES = ['Doc', 'Onboarding']

// 主界面可能的当前路由（Tab 页会把自己的名字报上来，不只是 Main）
const MAIN_ROUTES = ['Main', 'Holdings', 'Calendar', 'Discover', 'Profile']

/**
 * 冷启动时的云端对齐（对应小程序 app.js 的 onLaunch）。
 *
 * 页面先按本地快照渲染（零等待），这里再去拉云端更新的数据；
 * 拉到了就把导航重置回主界面，让页面重新取一次数。
 * 未部署后端 / 断网 / 未登录时静默跳过，退化成纯本地模式。
 */
let lastSyncAt = 0
const SYNC_MIN_GAP = 5000

/**
 * 会员到期后的降级提示。
 *
 * 两个阶段分开说，因为用户该做的事不一样：
 *   - grace（宽限期内）：还有几天，**现在续费就不用折腾**；
 *   - frozen（期满已收起）：已经收起了，重新开通即可原样恢复。
 *
 * 都留一个「知道了」，不要只给「去续费」—— 用户在没法立刻付款时
 * 需要一个不显得被强迫的出口，否则他会直接杀进程，连提示都没看清。
 */
function notifyDowngrade(d) {
  if (!d || !d.show) return

  if (d.phase === 'grace') {
    wx.showModal({
      title: '会员已到期',
      content:
        '你有 ' + d.over + ' 只持仓超出免费额度（' + d.max + ' 只）。\n\n' +
        '还有 ' + d.daysLeft + ' 天（' + d.deadline + '）会暂时收起这部分持仓 —— ' +
        '现在续费就不用折腾。',
      confirmText: '去续费',
      cancelText: '知道了',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/membership/membership' })
      }
    })
    return
  }

  if (d.phase === 'frozen') {
    wx.showModal({
      title: '部分持仓已收起',
      content:
        '会员到期已超过宽限期，' + d.frozen + ' 只超出免费额度的持仓已暂时收起。\n\n' +
        '只是从列表里收起，**数据没有删除** —— 重新开通会员后会自动恢复。',
      confirmText: '去续费',
      cancelText: '知道了',
      success: (r) => {
        if (r.confirm) wx.navigateTo({ url: '/pages/membership/membership' })
      }
    })
  }
}

function syncOnBoot() {
  if (!appInst.isLogin()) return

  // 冷启动之外，从后台回到前台也会走到这里：加个最小间隔，
  // 免得在几个 App 之间来回切时反复打请求
  const now = Date.now()
  if (now - lastSyncAt < SYNC_MIN_GAP) return
  lastSyncAt = now

  // 会员档位以服务端为准（兑换码 / 订单都在那边记账），本地那份只是缓存
  //
  // 紧随其后的 notifyMembershipGrace 必须**等同步完成**再跑：它读的是本地档位，
  // 而那份刚被服务端结果覆盖过 —— 顺序反了就会拿旧档位做判断，
  // 出现「刚续费却被提示已到期」这种离谱结果。
  api
    .syncMembership()
    .then(() => api.notifyMembershipGrace())
    .then((res) => notifyDowngrade((res && res.data) || {}))
    .catch(() => null)

  store
    .pullFromCloud()
    .then((adopted) => {
      if (!adopted || !navigationRef.isReady()) return
      // 只在还停在主界面时重置：用户已经点进二级页了就不打扰他，
      // 那几页返回时会重新按快照 load 一次
      const r = navigationRef.getCurrentRoute()
      if (!r || MAIN_ROUTES.indexOf(r.name) === -1) return
      navigationRef.reset({ index: 0, routes: [{ name: 'Main' }] })
    })
    .catch(() => null)
}

function App() {
  const [logged, setLogged] = React.useState(false)

  React.useEffect(() => {
    wxShim.setApp(appInst)
    appInst.restore()
    setLogged(appInst.isLogin())

    // 老数据的币种口径修正要排在拉云端**之前**：它会把改动标脏，
    // 随后的 syncOnBoot 就按「本地优先」推上去。反过来先拉的话，
    // 版本标记已经写下、云端那份旧口径又把本地覆盖回来，等于没修。
    api.migrateNativeCurrency()

    // 实时汇率：先用上次缓存的（有就不必等网络），再后台刷一次。
    // 市值与预测年分红要按最新汇率看，所以这一步排在渲染之前。
    api.restoreFx()
    api.refreshFx()

    const offAuth = appInst.onAuthChange(setLogged)
    // 服务端回 401（token 过期/被踢）→ 清登录态，门禁自动把人送回登录页
    const off401 = cloud.onUnauthorized(() => {
      appInst.logout()
    })

    // 从后台回到前台也对齐一次：手机上 App 和小程序来回切，
    // 最容易出现「这边刚加的，那边还看不到」
    const appStateSub = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncOnBoot()
    })

    return () => {
      offAuth()
      off401()
      appStateSub.remove()
    }
  }, [])

  return (
    <SafeAreaProvider>
      <NavigationContainer
        ref={navigationRef}
        onReady={() => {
          nav.bind(navigationRef)
          syncOnBoot()
        }}
      >
        <StatusBar style="dark" />
        <Stack.Navigator
          screenOptions={{
            // 关掉原生 header：它的高度由原生定（iOS 44pt / Android 56dp），压不矮，
            // 统一换成 ScreenWithBar 里那条自绘的（见 components/NavBar.js）
            headerShown: false,
            // 【临时诊断】禁用页面切换动画，验证「白屏是不是过渡动画没正常结束」
            animation: 'none'
          }}
        >
          {!logged ? (
            <>
              <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
              {PUBLIC_PAGES.map((p) => (
                <Stack.Screen key={p} name={p} component={withBar(TITLES[p])} />
              ))}
            </>
          ) : (
            <>
              <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
              {AUTH_PAGES.map((p) => (
                <Stack.Screen key={p} name={p} component={withBar(TITLES[p])} />
              ))}
              {PUBLIC_PAGES.map((p) => (
                <Stack.Screen key={p} name={p} component={withBar(TITLES[p])} />
              ))}
            </>
          )}
        </Stack.Navigator>

        {/* Toast / Loading / Modal 的渲染层：兼容层只发事件，这里画出来 */}
        <UiHost />
      </NavigationContainer>
    </SafeAreaProvider>
  )
}

const shellStyles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#FFFFFF' },
  body: { flex: 1 }
})

const styles = StyleSheet.create({
  ph: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F5F7F6' },
  phName: { fontSize: 16, color: '#6B7370' },
  phSub: { marginTop: 8, fontSize: 13, color: '#B0B7B4' }
})

module.exports = App

const React = require('react')
const { View, Text, Pressable, StyleSheet, Animated, Easing, Platform } = require('react-native')
const { BlurView } = require('expo-blur')
const { useSafeAreaInsets } = require('react-native-safe-area-context')

const { colors } = require('../theme.js')
const TabIcon = require('./TabIcon.js')

/**
 * 悬浮式底部导航栏。
 *
 * 与原生 tabBar 的三点不同：
 *   1. 悬浮：整条从页面流里脱出来 —— 四周留边、底部还留一道缝隙，
 *      内容会从它下面滚过去。各页已经预留了 paddingBottom（见 theme.s.content），
 *      所以最后一屏不会被压住。
 *   2. 毛玻璃：用 BlurView 让下方内容透出模糊轮廓，而不是盖一块实心白。
 *      Android 上必须显式给 experimentalBlurMethod，否则 BlurView 会退化成
 *      半透明色块（Android 12 以下没有系统级模糊，那时它就是这个观感）。
 *   3. 划过动效：选中项背后是一枚高光胶囊，切换时从旧位置滑到新位置 ——
 *      像是有一块玻璃在栏上滑过去。
 *
 * 图标沿用 TabIcon（与小程序同一套画法），文案与顺序仍以 App.js 的 TAB_LIST 为准。
 */

// 胶囊滑动的时长与缓动：320ms + ease-out，快起步慢收尾，滑到位时不生硬
const SLIDE_MS = 320

// inner 的左右内边距。这里提成常量是因为胶囊要用到它两次：
//   1) 起点偏移（glass.left）—— 胶囊坐标是在 inner 的 padding box 里算的；
//   2) 每格宽度要扣掉两侧 padding。
// 之前 left 写死 6、格宽却拿 barWidth 整宽均分，两者口径不一致，
// 于是滑块从第 2 格起就开始向右偏，越靠右偏得越多。
const INNER_PAD = 6

function FloatingTabBar(props) {
  const { state, descriptors, navigation } = props
  const insets = useSafeAreaInsets()

  // 栏内可排布的宽度（onLayout 拿到后才好算每格多宽）
  const [barWidth, setBarWidth] = React.useState(0)

  // 用一个「第几格」的动画值驱动胶囊位移：直接对像素做动画的话，
  // 旋转屏或字号变化后要重算，而按格数插值天然自适应。
  const slide = React.useRef(new Animated.Value(state.index)).current

  React.useEffect(() => {
    Animated.timing(slide, {
      toValue: state.index,
      duration: SLIDE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start()
  }, [state.index, slide])

  // 图标名由调用方给（App.js 的 TAB_LIST），顺序与 routes 一致
  const icons = props.icons || TAB_ICONS

  const count = state.routes.length
  // 每格宽度 = 内容区宽度 / 格数，必须扣掉 inner 的左右 padding。
  // 用 barWidth / count 的话每格多算 12/count，误差逐格累加：
  // 第 1 格只偏 1.5dp（看着正常），最后一格能偏出 10dp 以上。
  const itemWidth = barWidth ? (barWidth - INNER_PAD * 2) / count : 0

  const translateX = itemWidth
    ? slide.interpolate({
        inputRange: [0, Math.max(1, count - 1)],
        outputRange: [0, itemWidth * Math.max(1, count - 1)]
      })
    : 0

  return (
    <View
      style={[styles.host, { paddingBottom: Math.max(insets.bottom, 10) }]}
      pointerEvents="box-none"
    >
      <View style={styles.shadowWrap}>
        <BlurView
          // Android 的模糊要显式开：dimezisBlurView 是 expo-blur 自带的实现，
          // 在系统不支持 RenderEffect 的机型上会自动退回半透明，不会崩
          experimentalBlurMethod={Platform.OS === 'android' ? 'dimezisBlurView' : undefined}
          intensity={Platform.OS === 'android' ? 70 : 45}
          tint="light"
          style={styles.blur}
        >
          <View style={styles.inner} onLayout={(e) => setBarWidth(e.nativeEvent.layout.width)}>
            {/* 划过的高光胶囊：位置由 slide 驱动，宽度恒等于一格 */}
            {itemWidth ? (
              <Animated.View
                pointerEvents="none"
                style={[styles.glass, { width: itemWidth, transform: [{ translateX }] }]}
              >
                <View style={styles.glassBody} />
              </Animated.View>
            ) : null}

            {state.routes.map((route, index) => {
              const focused = state.index === index
              const opts = descriptors[route.key].options || {}
              const label = opts.title || route.name
              const color = focused ? colors.primary : colors.t3

              const onPress = () => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true
                })
                if (!focused && !event.defaultPrevented) {
                  navigation.navigate(route.name)
                }
              }

              return (
                <Pressable
                  key={route.key}
                  style={styles.item}
                  onPress={onPress}
                  android_ripple={{ color: 'rgba(31,157,107,0.10)', borderless: false }}
                >
                  <TabIcon name={icons[index]} color={color} />
                  <Text style={[styles.label, { color }]} numberOfLines={1}>
                    {label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </BlurView>
      </View>
    </View>
  )
}

// 与 App.js 的 TAB_LIST 一一对应（顺序即图标顺序）
const TAB_ICONS = ['bars', 'calendar', 'compass', 'user']

const styles = StyleSheet.create({
  // 悬浮层：不吃点击（内容能滚过去），只有里面的栏能点
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14
  },

  // 阴影得由外层带：BlurView 要 overflow:hidden 才能裁圆角，
  // 而被裁掉之后 iOS 的阴影就没了，所以分成两层
  shadowWrap: {
    borderRadius: 22,
    backgroundColor: 'transparent',
    ...Platform.select({
      ios: {
        shadowColor: '#0B1F17',
        shadowOpacity: 0.14,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 }
      },
      android: { elevation: 12 }
    })
  },

  blur: {
    borderRadius: 22,
    overflow: 'hidden',
    // 半透明白是底色，模糊负责把下面的内容揉开
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.75)'
  },

  inner: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 58,
    paddingHorizontal: INNER_PAD
  },

  // 高光胶囊
  glass: {
    position: 'absolute',
    top: 5,
    bottom: 5,
    // 绝对定位以父级 padding box 为基准，所以要跳过左侧 padding 才对齐内容区起点
    left: INNER_PAD,
    alignItems: 'center',
    justifyContent: 'center'
  },
  glassBody: {
    flex: 1,
    alignSelf: 'stretch',
    marginHorizontal: 5,
    borderRadius: 17,
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(31,157,107,0.18)',
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOpacity: 0.16,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 }
      },
      android: { elevation: 2 }
    })
  },

  item: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center'
  },
  label: {
    marginTop: 3,
    fontSize: 11,
    fontWeight: '500'
  }
})

module.exports = FloatingTabBar

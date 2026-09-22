/**
 * 桌面图标切换（仅 Android）。
 *
 * 普通会员用白色版图标，Pro 会员用深色版。真正的切换在原生层完成
 * （Android 只允许通过 activity-alias + PackageManager 改图标，
 * 见 android/app/src/main/java/com/xiji/app/AppIconModule.kt）。
 *
 * 这个文件只做三件事：
 *   1) 把原生模块的存在性判断收在一处，调用方不必到处判平台；
 *   2) **失败静默** —— 换图标是锦上添花，它绝不能影响任何主流程。
 *      原生模块缺失（iOS / 旧包 / 库还没接上）就是什么都不做；
 *   3) 记住上一次设置过的值，避免重复触发启动器重建图标。
 */
const { NativeModules, Platform } = require('react-native')

// 只有 Android 有这套机制；iOS 不允许运行时改图标（要用户在设置里选）
const mod = Platform.OS === 'android' ? NativeModules.AppIcon : null

// 上一次设置的值。null 表示还没设置过 —— 与 false 不同：
// false 是"已确认为普通图标"，null 是"不知道当前是什么"。
let last = null

function available() {
  return !!(mod && typeof mod.setPro === 'function')
}

/**
 * 按会员档位切换图标。isPro 为 true 用深色版，否则用白色版。
 *
 * 幂等且绝不抛错：无论原生侧报什么问题，这里都 resolve(false)，
 * 让调用方可以无脑 .then() 而不必包 try/catch。
 */
function sync(isPro) {
  const want = !!isPro

  if (!available()) return Promise.resolve(false)
  if (last === want) return Promise.resolve(false)

  return mod
    .setPro(want)
    .then((res) => {
      last = want
      // changed=false 说明原生侧判定状态已经对了（例如用户重装后
      // 桌面还留着上一个图标），此时也要更新 last，免得下次白跑一趟
      return !!(res && res.changed)
    })
    .catch((e) => {
      console.warn('[appicon] 切换桌面图标失败：' + ((e && e.message) || e))
      return false
    })
}

/** 从原生侧读当前图标状态，用于排查「图标和档位对不上」。 */
function current() {
  if (!available() || typeof mod.isProIcon !== 'function') return Promise.resolve(null)
  return mod
    .isProIcon()
    .catch(() => null)
}

module.exports = { available, sync, current, _reset: () => { last = null } }

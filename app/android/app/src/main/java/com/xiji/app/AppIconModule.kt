package com.xiji.app

import android.content.ComponentName
import android.content.pm.PackageManager

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * 桌面图标切换：普通会员用一版图标，Pro 会员用另一版。
 *
 * 为什么必须在原生层做：Android 不允许改「已安装应用」的图标资源，
 * 官方给的唯一正路是**声明两个 activity-alias**（各自带一套 icon），
 * 再通过 PackageManager.setComponentEnabledSetting 启用其中一个、
 * 禁用另一个。JS 碰不到 PackageManager，所以只能走原生模块。
 *
 * 对应 Manifest 里的 .IconFree（普通）与 .IconPro（Pro）两个 alias。
 *
 * 两个实际踩过的注意点写在 setPro 里：
 *   1) 必须先启用目标、再禁用当前，否则中间会有一个"一个都没启用"的瞬间；
 *   2) 状态没变时直接返回，不要白调一次 —— 某些启动器收到组件变更通知会
 *      重建图标，用户会看到桌面图标闪一下。
 */
class AppIconModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "AppIcon"

    private fun aliasName(pro: Boolean): String =
        ctx.packageName + if (pro) ".IconPro" else ".IconFree"

    private fun component(pro: Boolean): ComponentName =
        ComponentName(ctx.packageName, aliasName(pro))

    /** 当前用的是不是 Pro 图标。 */
    @ReactMethod
    fun isProIcon(promise: Promise) {
        try {
            val state = ctx.packageManager.getComponentSettingCompat(component(true))
            // Manifest 里 IconPro 默认 enabled="false"，所以"不是明确启用"
            // 就等于在用普通图标。这样无需再查一遍 free 的状态。
            promise.resolve(state == PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
        } catch (e: Exception) {
            promise.reject("E_ICON_QUERY", e.message, e)
        }
    }

    /**
     * 切换图标。isPro 为 true 用深色版，否则用白色版。
     *
     * 幂等：已是目标状态就直接返回 changed=false，不触碰组件状态。
     * 这不是优化 —— 每次 setComponentEnabledSetting 都会让启动器重建快捷方式，
     * 而本方法的调用点在「每次启动同步完会员档位」之后，不挡掉的话用户
     * 每次打开 App 都会看到桌面图标闪一下。
     */
    @ReactMethod
    fun setPro(isPro: Boolean, promise: Promise) {
        try {
            val pm = ctx.packageManager
            val want = component(isPro)
            val other = component(!isPro)

            val current = pm.getComponentSettingCompat(want)
            if (current == PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {
                // 注意这里必须用 Arguments.createMap()，不能写 mapOf(...)：
                // Kotlin 的 Map 不是 bridge 认识的结构，RN 只接受
                // WritableMap / WritableArray 与基本类型。传 Map 不会编译报错，
                // 但运行时会抛 "Malformed calls from JS"，而且因为调用点
                // 一律 catch 掉（见 js 侧 appicon.js），它会**静默失效** ——
                // 表现就是"图标怎么都不换，也没有任何报错"。
                promise.resolve(result(false, isPro))
                return
            }

            // 顺序刻意如此：先启用目标，再禁用当前。
            // 反过来的话，两条语句之间会存在「两个 alias 都被禁用」的窗口 ——
            // 那一刻应用在桌面上没有入口，启动器可能直接把图标删掉再重建。
            pm.setComponentEnabledSetting(
                want,
                PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                PackageManager.DONT_KILL_APP
            )
            pm.setComponentEnabledSetting(
                other,
                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                PackageManager.DONT_KILL_APP
            )

            promise.resolve(result(true, isPro))
        } catch (e: Exception) {
            promise.reject("E_ICON_SWITCH", e.message, e)
        }
    }

    /** 构造 { changed, pro } —— 见上面关于 Arguments.createMap 的说明。 */
    private fun result(changed: Boolean, pro: Boolean): com.facebook.react.bridge.WritableMap {
        val m = Arguments.createMap()
        m.putBoolean("changed", changed)
        m.putBoolean("pro", pro)
        return m
    }

    /**
     * 读组件状态。
     *
     * 单独包一层是因为 getComponentEnabledSetting 在「从未被显式设置过」时
     * 返回 COMPONENT_ENABLED_STATE_DEFAULT，此时真实状态要去 Manifest 里查 ——
     * 而那一层 API（getApplicationInfo + 遍历 activity-alias）又长又容易写错。
     * 这里简化为：DEFAULT 一律当作 DISABLED，与 Manifest 的初始值一致
     * （IconFree 才是默认启用的那个）。若将来改了初始值，这里要跟着改。
     */
    private fun PackageManager.getComponentSettingCompat(c: ComponentName): Int {
        val s = getComponentEnabledSetting(c)
        return if (s == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT) {
            PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        } else {
            s
        }
    }
}

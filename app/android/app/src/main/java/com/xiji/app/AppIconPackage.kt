package com.xiji.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * 把 AppIconModule 注册进 RN。
 *
 * 项目没走 autolinking（这是个自己写的模块，没有 npm 包），所以在
 * MainApplication.getPackages() 里手动 add 一份 —— 见那里的注释。
 */
class AppIconPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(AppIconModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}

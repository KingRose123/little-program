/**
 * App 端调起微信支付（微信开放平台 App 支付 APIv3）。
 *
 * 服务端（server/src/wxpay.js）负责下单与签名，这里只做一件事：
 * 把那串参数交给手机上的微信 SDK。参数一个字都不能改 —— sign 是按它们算出来的。
 *
 * ⚠️ 原生 SDK 必须用「运行时注入」，不能在这里静态 require
 * ---------------------------------------------------------------
 * 曾经写的是 `try { sdk = require('react-native-wechat-lib') } catch (e) { sdk = null }`，
 * 想着「模块没装就降级成一句说明」。这个想法是错的，而且错得很隐蔽：
 *
 *   Metro 在**打包时**解析字面量的 require。模块没装时，它不会让构建失败，
 *   而是把这次调用编译成一个「一执行就抛 unknownModuleError」的桩。
 *   问题在于这个错误不是普通的 JS 异常 —— 它会先经 RN 的 ExceptionsManager
 *   上报，然后直接崩掉 native 层。**try/catch 接不住它。**
 *
 * 实测堆栈（release 包，hermes）：
 *   unknownModuleError → loadModuleImplementation → guardedLoadModule
 *   → metroRequire → wechatSdk → available → onBuy → onPress
 * 可以看到 available 和 onBuy 都在栈上 —— 也就是说 catch 完全没生效，
 * 用户侧的表现是：**在会员页点「立即开通」直接闪退**。
 *
 * 所以改成注入式：装了这个 SDK 的构建在启动时把它注册进来（见 register），
 * 没装的构建 available() 就是 false，onBuy 会引导用户走兑换码 ——
 * 这才是原本想要的降级效果。
 */

let sdk = null

/**
 * 由「装了微信 SDK 的构建」在启动时调用一次，把原生模块交进来。
 *
 * 目前**没有任何地方调用它** —— 这是有意为之：接微信支付需要商户号、
 * 证书和公网 HTTPS 回调（见 server-go/.env.example 的 WXPAY_* 一节），
 * 这些都还没到位。等真要接的时候，在 App 启动处加：
 *
 *   wxpay.register(require('react-native-wechat-lib'))
 *
 * 放在**启动处**而不是本文件里，是因为那时模块一定存在（否则构建会失败），
 * 错误当场就能发现，不会拖到用户点击时才崩。
 */
function register(moduleOrNull) {
  sdk = moduleOrNull || null
  return sdk
}

// 取已注册的 SDK。没有就是没有 —— 这里绝不主动 require 任何东西。
function wechatSdk() {
  return sdk
}

function available() {
  const s = wechatSdk()
  return !!(s && typeof s.pay === 'function')
}

// 缺失时给一句能照着做的说明。措辞对齐服务端的口径（notReady 时同样是引导兑换码）
function reason() {
  if (available()) return ''
  return '在线支付尚未开通，可以先用兑换码开通会员。'
}

// 调起支付前要先向微信注册 AppID（开放平台「移动应用」的 AppID）
function registerApp(appid) {
  const s = wechatSdk()
  if (!s || typeof s.registerApp !== 'function') return Promise.resolve(false)
  // 第二个参数是 iOS 的 universal link，Android 传空串即可
  return Promise.resolve(s.registerApp(String(appid || '').trim(), '')).then(() => true)
}

/**
 * 调起微信支付。
 * params 来自服务端（appid / partnerid / prepayid / package / noncestr / timestamp / sign），
 * 这里只是把字段换成 SDK 要求的驼峰命名 —— 值一律不动。
 */
function pay(params) {
  if (!available()) return Promise.reject({ code: -1, msg: reason() || '微信 SDK 不可用' })

  const p = params || {}
  return registerApp(p.appid)
    .then(
      () =>
        wechatSdk().pay({
          appId: p.appid,
          partnerId: p.partnerid,
          prepayId: p.prepayid,
          nonceStr: p.noncestr,
          timeStamp: p.timestamp,
          package: p.package,
          sign: p.sign
        })
    )
    .then(() => true)
}

module.exports = { register, available, reason, registerApp, pay }

/**
 * 服务端调用封装（React Native 版）。
 *
 * 与小程序那份的唯一区别是**身份来源**：
 *   小程序：云托管自动注入 X-WX-OPENID，客户端根本不用管登录；
 *   App：用户名 + 密码换 token，之后每个请求带 Authorization: Bearer。
 *
 * 请求形状和错误约定（resolve 服务端 JSON / reject { code, msg }）与原来**完全一致**，
 * 所以 utils/api.js 那一整套业务逻辑一行都不用改。
 */
const { API_BASE, DEFAULT_TIMEOUT, UPLOAD_TIMEOUT } = require('../config.js')
const storage = require('../compat/storage.js')

const TOKEN_KEY = 'authToken'
const UID_KEY = 'authUid'

// 401 时通知上层（App 会清登录态并跳登录页）
const listeners = new Set()

function onUnauthorized(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function notifyUnauthorized(msg) {
  listeners.forEach((fn) => {
    try {
      fn(msg)
    } catch (e) {
      console.warn('[cloud] 401 回调出错', e && e.message)
    }
  })
}

function token() {
  return String(storage.get(TOKEN_KEY) || '')
}

function uid() {
  return String(storage.get(UID_KEY) || '')
}

function saveLogin(t, u) {
  storage.set(TOKEN_KEY, t)
  if (u) storage.set(UID_KEY, u)
}

function clearLogin() {
  storage.remove(TOKEN_KEY)
  storage.remove(UID_KEY)
}

function isLoggedIn() {
  return !!token()
}

/**
 * 就绪判断。小程序那份是「wx.cloud 能不能用」；
 * App 端没有这种不确定性 —— 本地数据读进内存就算就绪（见 index.js 的启动顺序）。
 */
function init() {
  return storage.isLoaded()
}

function enabled() {
  return init()
}

/**
 * 统一请求：成功 resolve 服务端 JSON，失败 reject 成 { code, msg }，
 * 与项目里 api.fail 的形状保持一致（页面上的 util.onError 靠这个判断）。
 */
function request(path, method, data, timeout) {
  const t = token()
  const headers = { 'content-type': 'application/json' }
  if (t) headers.authorization = 'Bearer ' + t
  const m = String(method || 'GET').toUpperCase()

  return fetch(API_BASE + path, {
    method: m,
    headers: headers,
    body: m === 'GET' || m === 'HEAD' ? undefined : JSON.stringify(data || {}),
    signal:
      typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? AbortSignal.timeout(timeout || DEFAULT_TIMEOUT)
        : undefined
  })
    .then((res) =>
      res.text().then((text) => {
        let body = null
        try {
          body = text ? JSON.parse(text) : null
        } catch (e) {
          // 网关偶尔会回一段 HTML（比如服务没起来），交给下面统一报错
          body = null
        }

        const okStatus = res.status >= 200 && res.status < 300
        if (okStatus && body && body.ok !== false) return body

        const msg = (body && body.msg) || '服务异常（' + res.status + '）'

        // token 过期/失效：清掉本地登录态并通知上层，避免后面每个请求都白跑
        if (res.status === 401 && token()) {
          clearLogin()
          notifyUnauthorized(msg)
        }

        throw { code: res.status, msg: msg }
      })
    )
    .catch((e) => {
      // 上面主动抛的业务错误保持原样；这里只兜网络层
      if (e && e.code !== undefined) throw e
      throw { code: -1, msg: '网络异常，请检查网络后重试' }
    })
}

/* ---------------- 登录态 ----------------
 * 用户名 + 密码（注册时直接登录）。
 * 服务端只存 scrypt 哈希，密码本身不落库、也不会回传。
 */

// 注册：成功即登录，返回 token
function register(username, password) {
  return request('/api/auth/register', 'POST', { username: username, password: password })
}

// 登录：换 token
function loginByPassword(username, password) {
  return request('/api/auth/login', 'POST', { username: username, password: password })
}

// 冷启动校验 token 是否还有效
function me() {
  return request('/api/auth/me', 'GET')
}

function logout() {
  // 先请求再清本地：服务端删 token 需要带着它
  return request('/api/auth/logout', 'POST', {}).catch(() => null).then(() => {
    clearLogin()
    return true
  })
}

/**
 * 注销账号：服务端删账号 + 全部业务数据（本机那份由 api.destroyAccount 清）。
 * 注意它和 logout 不是一回事：logout 只让凭证失效、数据留着。
 */
function destroyAccount() {
  return request('/api/auth/account', 'DELETE')
}

/* ---------------- 用户数据快照 ---------------- */

function getState() {
  return request('/api/state', 'GET')
}

function saveState(payload) {
  return request('/api/state', 'PUT', { payload: payload }, UPLOAD_TIMEOUT)
}

function clearState() {
  return request('/api/state', 'DELETE')
}

/* ---------------- 会员 ---------------- */

function getMembership() {
  return request('/api/membership', 'GET')
}

function redeemMembership(code) {
  return request('/api/membership/redeem', 'POST', { code: code })
}

// 支付方式与「去哪买兑换码」的说明。文案在服务端，改渠道不用发版。
function getPayChannels() {
  return request('/api/membership/pay/channels', 'GET')
}

/**
 * 会员支付：App 端走微信支付 APIv3 的 APP 支付通道
 * （小程序那套虚拟支付在 App 里没有对应的接口，服务端的 vpay 只留给小程序用）。
 * 服务端完成 RSA 签名，这里只把方案 key 传过去，拿回「调起支付参数」。
 */
function appayPrepay(plan) {
  return request('/api/membership/appay/prepay', 'POST', { plan: plan })
}

/**
 * 订单状态：支付完成回到 App 后要回来查一次 ——
 * 微信的支付结果回调可能丢失，以服务端有没有发货为准。
 */
function getOrderStatus(outTradeNo) {
  return request('/api/membership/vpay/order?outTradeNo=' + encodeURIComponent(outTradeNo || ''), 'GET')
}

module.exports = {
  API_BASE,
  onUnauthorized,
  init,
  enabled,
  request,
  token,
  uid,
  isLoggedIn,
  saveLogin,
  clearLogin,
  register,
  loginByPassword,
  me,
  logout,
  destroyAccount,
  getState,
  saveState,
  clearState,
  getMembership,
  redeemMembership,
  getPayChannels,
  appayPrepay,
  getOrderStatus
}

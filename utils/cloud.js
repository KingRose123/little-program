/**
 * 微信云托管调用封装
 *
 * 云托管的好处在这里体现得最直接：
 *   1. 不需要配置 request 合法域名、不需要备案自己的域名；
 *   2. 不需要自己维护登录态 —— 平台会把调用者 openid 通过 X-WX-OPENID 头透传给容器，
 *      服务端拿到这个头就等于拿到了身份。
 *
 * SERVICE 要和云托管控制台里创建的服务名一致（服务设置 → 服务名）。
 * ENV 一般留空；如果同时用了云开发（CloudBase），填上环境 ID 即可指定环境。
 */
// 云托管环境 ID（控制台 → 环境 → 环境 ID）。
// callContainer 的 config.env 是必填项，换环境 / 换小程序时记得同步改这里，
// 留空会静默退化成「客户端直连东财」——那条路又依赖 request 合法域名，
// 最终表现是「有网但没有数据」，很难排查。
const ENV = 'prod-4gs3xo1i76ca14b6'
const SERVICE = 'xiji-api'

const DEFAULT_TIMEOUT = 10000

let ready = false

/**
 * 初始化 wx.cloud。基础库太低或初始化失败时返回 false，
 * 上层据此降级为「纯本地模式」——也就是后端还没部署时 App 依然能正常跑。
 */
function init() {
  if (ready) return true
  if (!wx.cloud || typeof wx.cloud.callContainer !== 'function') return false

  try {
    const opts = { traceUser: true }
    if (ENV) opts.env = ENV
    wx.cloud.init(opts)
    if (!ENV) console.warn('[cloud] 未配置云托管环境 ID（utils/cloud.js 的 ENV），真机上调用可能失败')
    ready = true
  } catch (e) {
    // 初始化失败不抛错：调用方会退化为纯本地，不该因此白屏
    console.warn('[cloud] init 失败，降级为纯本地模式', e)
    ready = false
  }
  return ready
}

function enabled() {
  return ready
}

/**
 * 统一请求：resolve 服务端返回的 JSON（约定 { ok: true, ... }），
 * 否则 reject 成 { code, msg }，与项目里 api.fail 的形状保持一致。
 */
function request(path, method, data, timeout) {
  if (!init()) return Promise.reject({ code: -1, msg: '云托管未启用' })

  return new Promise((resolve, reject) => {
    wx.cloud.callContainer({
      config: ENV ? { env: ENV } : {},
      path: path,
      method: method || 'GET',
      header: {
        'X-WX-SERVICE': SERVICE,
        'content-type': 'application/json'
      },
      data: data || {},
      timeout: timeout || DEFAULT_TIMEOUT,
      success: (res) => {
        const body = res.data
        const okStatus = res.statusCode >= 200 && res.statusCode < 300
        if (okStatus && body && body.ok !== false) {
          resolve(body)
          return
        }
        reject({ code: res.statusCode, msg: (body && body.msg) || '服务异常' })
      },
      fail: (e) => {
        reject({ code: -1, msg: (e && e.errMsg) || '网络异常' })
      }
    })
  })
}

// 拉当前用户的数据快照
function getState() {
  return request('/api/state', 'GET')
}

// 整份覆盖写入
function saveState(payload) {
  return request('/api/state', 'PUT', { payload }, 15000)
}

// 注销账号时清掉服务端这份数据
function clearState() {
  return request('/api/state', 'DELETE')
}

/* ---------------- 登录 ----------------
 * 手机号必须由服务端换（要用 AppSecret），客户端只把授权 code 递上去，
 * 换到之后服务端会顺手写进 users 表，这里把号码返回给页面存进 userInfo。
 */

function phoneLogin(code) {
  return request('/api/login', 'POST', { code: code })
}

/* ---------------- 会员 ----------------
 * 会员档位的权威值在服务端（兑换码 / 订单都在那边记账），
 * 客户端本地那份只是缓存，启动时用它对齐。
 */

function getMembership() {
  return request('/api/membership', 'GET')
}

function redeemMembership(code) {
  return request('/api/membership/redeem', 'POST', { code: code })
}

// 虚拟支付下单前签名：signData / paySig / signature 都由服务端算好下发
// （用户态签名要用 session_key，只有服务端拿得到，所以 code 也一起传过去）
function vpayPrepay(plan, code) {
  return request('/api/membership/vpay/prepay', 'POST', { plan: plan, code: code })
}

// 订单状态：支付成功后轮询它，以服务端的发货结果为准
function getOrderStatus(outTradeNo) {
  return request('/api/membership/vpay/order?outTradeNo=' + encodeURIComponent(outTradeNo), 'GET')
}

/**
 * 账号关联：小程序这边生成配对码。
 * 小程序的身份是云托管注入的 openid，App 那边是用户名密码，本来是两套账号。
 * 这里生成一个 6 位一次性码，交给 App 输入，服务端就会把两边并成一个 ——
 * 不需要短信，也就没有短信费用。
 */
function createLinkCode() {
  return request('/api/auth/link/code', 'POST', {})
}

/**
 * 关联状态：问服务端「我这个账号关联过 App 那边没有」。
 *
 * 为什么不能只看本机的记号：记号存在 storage 里，卸载重装 / 换手机就没了，
 * 而「账号已关联」是服务端上的事实。两端显示与同步时机都以这个为准。
 */
function linkStatus() {
  return request('/api/auth/link/status', 'GET')
}

module.exports = {
  init,
  enabled,
  request,
  getState,
  saveState,
  clearState,
  createLinkCode,
  linkStatus,
  phoneLogin,
  getMembership,
  redeemMembership,
  vpayPrepay,
  getOrderStatus
}

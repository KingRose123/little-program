/**
 * 微信开放接口：用 getPhoneNumber 的 code 换真实手机号。
 *
 * 走经典链路（不依赖云托管的云调用）：
 *   appid + appsecret → access_token（缓存复用）→ /wxa/business/getuserphonenumber
 *
 * 为什么不用云托管的「云调用」：
 *   新版「开放接口服务」的调用格式官方文档没给全，旧版 cloudbase_access_token
 *   在 2022-07 之后创建的环境上已下线。而这条链路只依赖两个环境变量，
 *   且和 vpay.js 用的是同一组（WX_APPID / WX_APPSECRET）——
 *   配过虚拟支付的环境不用重复配。
 *
 * 环境变量：
 *   WX_APPID      小程序 AppID（不填用下面项目里的默认值）
 *   WX_APPSECRET  小程序 AppSecret（公众平台 → 开发管理 → 开发设置）
 */

// 本项目的小程序 AppID（不是敏感信息，客户端代码里也可见；换小程序时记得改）
const DEFAULT_APPID = 'wx1c70462371d75c08'

const TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/token'
const PHONE_URL = 'https://api.weixin.qq.com/wxa/business/getuserphonenumber'

// access_token 有效期 7200s：缓存复用，并发只取一次 —— 频繁获取会被限流（45009）
const TOKEN_SAFE_GAP = 5 * 60 * 1000
let tokenCache = { value: '', exp: 0 }
let tokenInflight = null

function env(key) {
  return String(process.env[key] || '').trim()
}

function config() {
  return { appid: env('WX_APPID') || DEFAULT_APPID, secret: env('WX_APPSECRET') }
}

// 微信错误码 → 一句能直接看的话（不然只有 errcode，排查得翻文档）
const WX_ERRORS = {
  '-1': '微信服务繁忙，请稍后重试',
  '40001': 'AppSecret 不正确，请检查环境变量 WX_APPSECRET',
  '40013': 'AppID 不正确，请检查环境变量 WX_APPID',
  '40125': 'AppSecret 无效，请在公众平台重置后更新环境变量',
  '40029': '手机号授权凭证已失效，请重新点击登录',
  '45009': '微信接口调用频率超限，请稍后重试'
}

function wxError(d) {
  const code = d && d.errcode !== undefined ? String(d.errcode) : ''
  return WX_ERRORS[code] || '微信返回 errcode=' + code + ' errmsg=' + ((d && d.errmsg) || '')
}

// 配没配 AppSecret：路由据此提前给一句明确的 503，而不是等微信报错
function configured() {
  return !!config().secret
}

async function accessToken() {
  const c = config()
  if (!c.secret) {
    throw { msg: '服务端未配置 WX_APPSECRET，无法获取微信手机号' }
  }
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value
  if (tokenInflight) return tokenInflight

  const task = (async () => {
    const url =
      TOKEN_URL +
      '?grant_type=client_credential&appid=' +
      encodeURIComponent(c.appid) +
      '&secret=' +
      encodeURIComponent(c.secret)

    const res = await fetch(url)
    const data = await res.json()
    if (!data || !data.access_token) throw { msg: '获取微信 access_token 失败：' + wxError(data) }

    tokenCache = {
      value: data.access_token,
      exp: Date.now() + (Number(data.expires_in) || 7200) * 1000 - TOKEN_SAFE_GAP
    }
    return tokenCache.value
  })()

  tokenInflight = task
  try {
    return await task
  } finally {
    if (tokenInflight === task) tokenInflight = null
  }
}

/**
 * 用授权回调里的 code 换手机号。
 * 返回 { phone, purePhone, countryCode }：
 *   phone     带区号，如 +86 13800138000
 *   purePhone 纯号码，如 13800138000
 */
async function phoneByCode(code) {
  const c = String(code || '').trim()
  if (!c) throw { msg: '缺少手机号授权凭证 code' }

  const token = await accessToken()
  const res = await fetch(PHONE_URL + '?access_token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: c })
  })
  const data = await res.json()

  if (data && data.errcode) {
    // 42001 = token 已过期：清掉缓存，下次请求会重新取
    if (String(data.errcode) === '42001') tokenCache = { value: '', exp: 0 }
    throw { msg: '获取手机号失败：' + wxError(data) }
  }

  const info = (data && data.phone_info) || {}
  return {
    phone: String(info.phoneNumber || ''),
    purePhone: String(info.purePhoneNumber || ''),
    countryCode: String(info.countryCode || '')
  }
}

module.exports = {
  DEFAULT_APPID,
  configured,
  accessToken,
  phoneByCode
}

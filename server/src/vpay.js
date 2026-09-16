const crypto = require('crypto')
const db = require('./db.js')
const membership = require('./membership.js')

/**
 * 小程序虚拟支付（会员属于虚拟商品，必须走这条通道，不能用普通微信支付）
 *
 * 两把签名，都是 HMAC-SHA256：
 *   paySig    = hex(hmac_sha256(appKey,     'requestVirtualPayment&' + signData))
 *   signature = hex(hmac_sha256(sessionKey, signData))
 * appKey 来自「MP → 虚拟支付 → 基础配置」（沙箱 / 现网两把，按 env 选）；
 * sessionKey 是每个用户各自的登录态，所以每次下单都用客户端新拿的 code 现换一次，
 * 不做缓存 —— 顺带避开 session_key 过期（-15007）。
 *
 * 所有密钥只从环境变量读，代码里不出现任何凭据。
 */

const TAG = '[vpay]'

function env(name) {
  return String(process.env[name] || '').trim()
}

// env=0 现网、env=1 沙箱，对应两把不同的 AppKey
function envNo() {
  return env('VPAY_ENV') === '1' ? 1 : 0
}

// 方案 -> 道具 ID：在小程序后台「道具管理」发布道具后，把 productId 填进这个 JSON
// 例：VPAY_PRODUCTS={"lite-1m":"pid_xxx","pro-3y":"pid_yyy"}
function products() {
  const raw = env('VPAY_PRODUCTS')
  if (!raw) return {}
  try {
    const map = JSON.parse(raw)
    return map && typeof map === 'object' ? map : {}
  } catch (e) {
    console.error(TAG, 'VPAY_PRODUCTS 不是合法 JSON，已忽略')
    return {}
  }
}

function config() {
  return {
    appid: env('WX_APPID'),
    appsecret: env('WX_APPSECRET'),
    offerId: env('VPAY_OFFER_ID'),
    appKey: envNo() === 1 ? env('VPAY_APPKEY_SANDBOX') : env('VPAY_APPKEY'),
    products: products()
  }
}

// 还缺哪些配置（缺了就让客户端退回「兑换码」那条路，而不是报一堆技术错误）
function missing() {
  const c = config()
  const lack = []
  if (!c.appid) lack.push('WX_APPID')
  if (!c.appsecret) lack.push('WX_APPSECRET')
  if (!c.offerId) lack.push('VPAY_OFFER_ID')
  if (!c.appKey) lack.push(envNo() === 1 ? 'VPAY_APPKEY_SANDBOX' : 'VPAY_APPKEY')
  return lack
}

function ready() {
  return missing().length === 0
}

/* ---------------- 签名 ---------------- */

function hmacHex(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex')
}

// 支付签名。基础库调用时 uri 固定是 requestVirtualPayment（不带 query）
function paySigOf(signData, key) {
  return hmacHex(key || config().appKey, 'requestVirtualPayment&' + signData)
}

// 用户态签名，密钥是当前用户的 session_key
function signatureOf(sessionKey, signData) {
  return hmacHex(sessionKey, signData)
}

/* ---------------- 登录态 ---------------- */

// wx.login 的 code 换 session_key
async function exchangeCode(code) {
  const c = config()
  const url =
    'https://api.weixin.qq.com/sns/jscode2session?appid=' +
    c.appid +
    '&secret=' +
    c.appsecret +
    '&js_code=' +
    encodeURIComponent(code) +
    '&grant_type=authorization_code'

  const res = await fetch(url)
  const data = await res.json()

  if (!data || !data.session_key) {
    const e = new Error('code2Session 失败：' + ((data && data.errmsg) || '未知错误'))
    e.msg = '微信登录态获取失败，请重进小程序再试'
    throw e
  }
  return data
}

/* ---------------- 下单 ---------------- */

function outTradeNoOf() {
  // 官方约束：8-32 字符，只能数字 / 大小写字母 / _ - | * @，且不能以下划线开头
  return 'M' + Date.now() + Math.floor(Math.random() * 900 + 100)
}

async function prepay(planKey, code, openid) {
  const lack = missing()
  if (lack.length) {
    return {
      ok: false,
      notReady: true,
      msg: '支付通道正在开通中，可以先用兑换码开通'
    }
  }

  const plan = membership.PLANS[planKey]
  if (!plan) return { ok: false, msg: '方案不存在' }

  const productId = String(config().products[planKey] || '').trim()
  if (!productId) return { ok: false, msg: '方案「' + plan.name + '」还没配置道具' }

  const jsCode = String(code || '').trim()
  if (!jsCode) return { ok: false, msg: '缺少微信登录凭证，请重进小程序再试' }

  const session = await exchangeCode(jsCode)

  // code2Session 也会返回 openid，顺手核对一下，避免登录态串号
  if (openid && session.openid && session.openid !== openid) {
    return { ok: false, msg: '登录态与当前账号不一致，请重进小程序再试' }
  }

  const outTradeNo = outTradeNoOf()
  const signData = JSON.stringify({
    offerId: config().offerId,
    buyQuantity: 1,
    env: envNo(),
    currencyType: 'CNY',
    productId: productId,
    // 单位是「分」，必须和后台道具价格一致，否则会命中 -15013
    goodsPrice: Math.round(Number(plan.price) * 100),
    outTradeNo: outTradeNo,
    attach: planKey
  })

  // 先落单再支付：发货推送进来时靠这个单号才找得到人和方案
  const pool = await db.ensureReady()
  await pool.query(
    `INSERT INTO membership_order (order_id, openid, plan, tier, months, amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
    [outTradeNo, openid, planKey, plan.tier, plan.months, plan.price]
  )

  return {
    ok: true,
    outTradeNo: outTradeNo,
    mode: 'short_series_goods',
    signData: signData,
    paySig: paySigOf(signData),
    signature: signatureOf(session.session_key, signData)
  }
}

/* ---------------- 订单状态（客户端轮询用） ---------------- */

async function orderStatus(outTradeNo, openid) {
  const pool = await db.ensureReady()
  const [rows] = await pool.query(
    'SELECT order_id, openid, plan, status, amount FROM membership_order WHERE order_id = ? LIMIT 1',
    [outTradeNo]
  )

  const row = rows[0]
  if (!row) return { ok: false, msg: '订单不存在' }
  if (openid && row.openid !== openid) return { ok: false, msg: '无权查看该订单' }

  return {
    ok: true,
    outTradeNo: row.order_id,
    plan: row.plan,
    amount: row.amount,
    status: row.status,
    membership: await membership.statusOf(row.openid)
  }
}

/* ---------------- 发货推送 ---------------- */

// 推送报文可能是 XML 也可能是 JSON，只取我们关心的几个字段
function parseXml(xml) {
  const out = {}
  const src = String(xml || '')

  ;['Event', 'OutTradeNo', 'OpenId', 'ProductId', 'Env', 'OrderId', 'GoodsInfo'].forEach(function (k) {
    const m = src.match(new RegExp('<' + k + '>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</' + k + '>'))
    if (m) out[k] = String(m[1]).trim()
  })

  return out
}

/**
 * 处理发货推送。
 * 官方要求「发货推送」与「发货轮询」至少实现一个：我们以推送为主，
 * 另外给客户端留了订单状态查询做兜底，避免出现「付了钱没开通」。
 * 推送失败微信会重试（最多 15 次），因此这里必须幂等。
 */
async function deliver(body, isXml) {
  const d = isXml ? parseXml(body) : body || {}
  const event = d.Event || d.event || ''

  if (event !== 'xpay_goods_deliver_notify') {
    // 代币、退款、投诉等推送先只留痕，回成功以免微信反复重推
    console.log(TAG, '收到其它推送：' + event)
    return { ok: true, skip: true }
  }

  const outTradeNo = String(d.OutTradeNo || d.outTradeNo || '').trim()
  if (!outTradeNo) return { ok: false, msg: '推送里没有 OutTradeNo' }

  const r = await membership.markPaidAndGrant(outTradeNo)
  if (!r.ok) {
    // 找不到订单就回失败，让微信重试（可能是下单与支付的时序问题）
    console.error(TAG, '发货失败：' + r.msg + '，outTradeNo=' + outTradeNo)
    return r
  }

  console.log(TAG, '发货成功 outTradeNo=' + outTradeNo + (r.repeated ? '（重复推送）' : ''))
  return { ok: true, repeated: !!r.repeated }
}

module.exports = {
  ready,
  missing,
  config,
  envNo,
  prepay,
  orderStatus,
  deliver,
  parseXml,
  paySigOf,
  signatureOf
}

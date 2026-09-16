const db = require('./db.js')

/**
 * 会员：档位 / 兑换码 / 订单
 *
 * 价格与时长只在这里定义 —— 小程序端下单只传方案 key，
 * 金额和时长一律由服务端自己算，客户端传来的数字一概不信。
 *
 * 支付通道（微信支付或小程序虚拟支付）接入后：
 *   支付成功回调 → 找到 order_id → 把 status 改成 paid → 调 apply() 开通。
 * 在那之前，会员统一用兑换码开通（线下收款后发码）。
 */

const PLANS = {
  'lite-1m': { name: 'Lite 月卡', tier: 'lite', months: 1, price: 5.5 },
  'pro-1y': { name: 'Pro · 1年', tier: 'pro', months: 12, price: 98 },
  'pro-2y': { name: 'Pro · 2年', tier: 'pro', months: 24, price: 168 },
  'pro-3y': { name: 'Pro · 3年', tier: 'pro', months: 36, price: 198 },
  'pro-5y': { name: 'Pro · 5年', tier: 'pro', months: 60, price: 298 }
}

const RANK = { free: 0, lite: 1, pro: 2 }

// 兑换码字符集去掉了 0/O/1/I/L，避免用户抄错
const CODE_CHARS = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

function todayKey() {
  const d = new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 'yyyy-MM-dd' 往后加 N 个自然月，月底自动收敛（1-31 + 1 月 = 2-28/29）
function plusMonths(dateKey, months) {
  const parts = String(dateKey || todayKey()).split('-').map(Number)
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1)
  const day = d.getDate()

  d.setDate(1)
  d.setMonth(d.getMonth() + (Number(months) || 0))

  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  d.setDate(Math.min(day, last))

  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

// 叠加开通：还没过期就从原到期日接着往后加，过期了从今天重新起算
function extendFrom(expiresAt, months) {
  const today = todayKey()
  const base = expiresAt && String(expiresAt) >= today ? String(expiresAt) : today
  return plusMonths(base, months)
}

function dateOf(v) {
  return v ? String(v).slice(0, 10) : ''
}

async function statusOf(openid) {
  const pool = await db.ensureReady()
  const [rows] = await pool.query(
    'SELECT tier, expires_at, source FROM membership WHERE openid = ? LIMIT 1',
    [openid]
  )

  const row = rows[0]
  if (!row) return { tier: 'free', paidTier: 'free', expiresAt: '', source: '', expired: false }

  const expiresAt = dateOf(row.expires_at)
  const expired = !!(expiresAt && expiresAt < todayKey())

  return {
    tier: expired ? 'free' : row.tier,
    paidTier: row.tier,
    expiresAt,
    source: row.source || '',
    expired
  }
}

// 在事务里给某个 openid 开通 / 续期
async function apply(conn, openid, tier, months, source) {
  const [rows] = await conn.query(
    'SELECT tier, expires_at FROM membership WHERE openid = ? FOR UPDATE',
    [openid]
  )

  const cur = rows[0] || null
  const today = todayKey()
  const curExpires = cur ? dateOf(cur.expires_at) : ''
  const active = !!curExpires && curExpires >= today
  const effective = active ? cur.tier : 'free'

  // 档位只升不降：Lite 用户买 Pro 直接升到 Pro，剩余时长照旧顺延
  const nextTier = RANK[tier] > RANK[effective] ? tier : effective
  const expiresAt = extendFrom(active ? curExpires : '', months)

  await conn.query(
    `INSERT INTO membership (openid, tier, expires_at, source, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       tier = VALUES(tier), expires_at = VALUES(expires_at),
       source = VALUES(source), updated_at = NOW()`,
    [openid, nextTier, expiresAt, source]
  )

  return { tier: nextTier, paidTier: nextTier, expiresAt, source, expired: false }
}

/**
 * 兑换码换会员。
 * 用事务 + FOR UPDATE 锁住这张码，保证一码只能用一次
 * （两个人同时提交同一张码时，后者会看到 used_by 已被写入）。
 */
async function redeem(code, openid) {
  const pool = await db.ensureReady()
  const conn = await pool.getConnection()

  try {
    await conn.beginTransaction()

    const [rows] = await conn.query(
      'SELECT code, tier, months, used_by FROM redeem_code WHERE code = ? FOR UPDATE',
      [code]
    )

    const row = rows[0]
    if (!row) {
      await conn.rollback()
      return { ok: false, msg: '兑换码不存在' }
    }
    if (row.used_by) {
      await conn.rollback()
      return { ok: false, msg: '该兑换码已被使用' }
    }

    const next = await apply(conn, openid, row.tier, row.months, '兑换码')
    await conn.query('UPDATE redeem_code SET used_by = ?, used_at = NOW() WHERE code = ?', [
      openid,
      code
    ])
    await conn.commit()

    return { ok: true, months: row.months, membership: next }
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

// 下单：只落库建档，等支付接入后由回调开通
async function createOrder(planKey, openid) {
  const plan = PLANS[planKey]
  if (!plan) return { ok: false, msg: '方案不存在' }

  const pool = await db.ensureReady()
  const orderId = 'M' + Date.now() + Math.floor(Math.random() * 900 + 100)

  await pool.query(
    `INSERT INTO membership_order (order_id, openid, plan, tier, months, amount, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
    [orderId, openid, planKey, plan.tier, plan.months, plan.price]
  )

  return {
    ok: true,
    orderId,
    plan: planKey,
    planName: plan.name,
    amount: plan.price,
    months: plan.months,
    // 支付通道接好后，这里返回 wx.requestPayment 需要的参数
    payParams: null,
    todo: '微信支付 / 虚拟支付尚未接入，订单已落库'
  }
}

function randomCode() {
  let s = ''
  for (let i = 0; i < 10; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
  return 'SXL' + s
}

// 生成兑换码：给管理员用（线下收款后发码），仅内部接口可调
async function genCodes(tier, months, count) {
  const pool = await db.ensureReady()
  const list = []

  for (let i = 0; i < count; i++) {
    const code = randomCode()
    await pool.query(
      'INSERT INTO redeem_code (code, tier, months, created_at) VALUES (?, ?, ?, NOW())',
      [code, tier, months]
    )
    list.push(code)
  }

  return { tier, months, count: list.length, codes: list }
}

/**
 * 发货：把订单标记为已支付并开通会员。
 * 微信的发货推送会重试（最多 15 次），所以这里必须幂等 ——
 * 已支付的订单直接返回，绝不能再叠一次会员时长。
 */
async function markPaidAndGrant(outTradeNo) {
  const pool = await db.ensureReady()
  const conn = await pool.getConnection()

  try {
    await conn.beginTransaction()

    const [rows] = await conn.query(
      'SELECT order_id, openid, tier, months, status FROM membership_order WHERE order_id = ? FOR UPDATE',
      [outTradeNo]
    )
    const order = rows[0]

    if (!order) {
      await conn.rollback()
      return { ok: false, msg: '订单不存在' }
    }
    if (order.status === 'paid') {
      await conn.rollback()
      return { ok: true, repeated: true }
    }

    await apply(conn, order.openid, order.tier, order.months, '订单')
    await conn.query(
      "UPDATE membership_order SET status = 'paid', paid_at = NOW() WHERE order_id = ?",
      [outTradeNo]
    )
    await conn.commit()

    return { ok: true }
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

module.exports = {
  PLANS,
  todayKey,
  plusMonths,
  extendFrom,
  statusOf,
  redeem,
  createOrder,
  genCodes,
  markPaidAndGrant
}

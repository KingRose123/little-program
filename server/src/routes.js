const express = require('express')
const db = require('./db.js')
const quote = require('./quote.js')
const jobs = require('./jobs.js')
const membership = require('./membership.js')
const vpay = require('./vpay.js')
const shadow = require('./shadow.js')
const wxauth = require('./wxauth.js')
const BUILD = require('./build.js')

const router = express.Router()

/**
 * 单份快照上限。
 * 原来定 1MB，但粗算一下重度用户：100 只持仓约 30KB，若每只还带 30 条
 * 交易/分红记录就要再加 ~600KB —— 一旦超限，用户的云端写入会直接失败，
 * 而客户端表现只是「一直 dirty、一直重试」，属于很隐蔽的数据丢失。
 * 所以放宽到 5MB；同时 shadow 会按 payload_size 告警（超 800KB 点名到人）。
 */
const MAX_PAYLOAD = 5 * 1024 * 1024

/**
 * 云托管会把调用者身份放在请求头里透传给容器：
 *   X-WX-OPENID —— 小程序用户 openid
 * 所以服务端不需要自己实现登录态，拿到这个头就等于拿到了身份。
 */
function openidOf(req) {
  return String(req.header('x-wx-openid') || '').trim()
}

function fail(res, status, msg) {
  return res.status(status).json({ ok: false, msg })
}

/* ---------------- 健康检查（云托管健康检查探针用） ---------------- */
router.get('/health', (req, res) => {
  res.json({ ok: true, service: 'xiji-api', build: BUILD, time: new Date().toISOString() })
})

/* ---------------- 读：拉取当前用户的数据快照 ---------------- */
router.get('/state', async (req, res) => {
  const openid = openidOf(req)
  // 本地调试（微信开发者工具直连或 curl）没有这个头，给一条明确提示
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  // 记一次活跃：内部按 10 分钟节流，不会每次读都写库；新用户顺手把行建出来
  shadow.touch(openid).catch((e) => console.warn('[shadow] 记录活跃失败', e && e.message))

  try {
    const pool = await db.ensureReady()
    const [rows] = await pool.query(
      'SELECT payload, rev, updated_at FROM user_state WHERE openid = ? LIMIT 1',
      [openid]
    )

    // 新用户：payload 返回 null，由客户端把本地那份推上来当初始数据
    if (!rows.length) return res.json({ ok: true, openid, rev: 0, payload: null })

    const row = rows[0]
    let payload = null
    try {
      payload = JSON.parse(row.payload)
    } catch (e) {
      console.error('[state] payload 解析失败, openid =', openid, e)
      return fail(res, 500, '云端数据已损坏')
    }

    return res.json({ ok: true, openid, rev: row.rev, updatedAt: row.updated_at, payload })
  } catch (e) {
    console.error('[state] 读取失败', e)
    return fail(res, 500, '读取失败，请稍后重试')
  }
})

/* ---------------- 写：整份覆盖（最后一次写入为准） ---------------- */
router.put('/state', async (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  const payload = req.body && req.body.payload
  if (!payload || typeof payload !== 'object' || payload instanceof Array) {
    return fail(res, 400, 'payload 必须是对象')
  }

  const text = JSON.stringify(payload)
  if (text.length > MAX_PAYLOAD) return fail(res, 413, '数据过大')

  try {
    const pool = await db.ensureReady()
    await pool.query(
      `INSERT INTO user_state (openid, payload, rev, updated_at)
       VALUES (?, ?, 1, NOW())
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), rev = rev + 1, updated_at = NOW()`,
      [openid, text]
    )

    const [rows] = await pool.query('SELECT rev, updated_at FROM user_state WHERE openid = ? LIMIT 1', [
      openid
    ])

    const rev = rows.length ? rows[0].rev : 1

    // 影子双写：把这份快照解析后另存关系表（后台按用户 / 标的 / 日期查询用）。
    // 它不阻塞本次保存，失败也只记日志 —— 影子表是可重建的派生数据。
    shadow.queueSync(openid, payload, rev, text.length)

    return res.json({
      ok: true,
      openid,
      rev: rev,
      updatedAt: rows.length ? rows[0].updated_at : null,
      bytes: text.length
    })
  } catch (e) {
    console.error('[state] 写入失败', e)
    return fail(res, 500, '保存失败，请稍后重试')
  }
})

/* ---------------- 行情代理 ----------------
 * 这几个是公开市场数据，不校验 openid（方便 curl 排查），
 * 对上游的保护交给 quote.js 里的缓存与并发合并。
 */

// 统一的取参加工
function stockOf(req) {
  return {
    code: String(req.query.code || '').trim(),
    market: String(req.query.market || '').trim(),
    secid: String(req.query.secid || '').trim()
  }
}

function handle(res, promise) {
  return promise
    .then((data) => res.json({ ok: true, data }))
    .catch((e) => {
      // 带 msg 的是我们自己抛的（上游超时、上游返回异常等）→ 502，属于「数据没取到」；
      // 其余（比如 MySQL 连不上）是服务端故障 → 500。
      // 客户端两种都按失败处理并回退直连，分开主要是为了日志与定时任务里一眼看出故障源。
      const upstream = !!(e && e.msg)
      const status = upstream ? 502 : 500
      res.status(status).json({
        ok: false,
        msg: (e && (e.msg || e.message)) || '请求失败'
      })
    })
}

// 关键字搜索：代码 / 名称 / 拼音首字母
router.get('/quote/search', (req, res) => {
  handle(res, quote.search(req.query.kw || req.query.keyword || ''))
})

// 单个标的实时行情
router.get('/quote', (req, res) => {
  const stock = stockOf(req)
  if (!stock.code) return fail(res, 400, '缺少 code')
  handle(res, quote.fetchQuote(stock))
})

// 场外基金：净值 + 分红一次取齐
router.get('/fund', (req, res) => {
  const code = String(req.query.code || '').trim()
  if (!code) return fail(res, 400, '缺少 code')
  handle(res, quote.fetchFund(code))
})

// 分红档案
router.get('/dividend', (req, res) => {
  const stock = stockOf(req)
  if (!stock.code) return fail(res, 400, '缺少 code')
  handle(res, quote.fetchDividend(stock, { size: Number(req.query.size) || 10 }))
})

// 行情 + 分红一次取齐（持仓详情 / 添加持仓页用）
router.get('/detail', (req, res) => {
  const stock = stockOf(req)
  if (!stock.code) return fail(res, 400, '缺少 code')
  handle(res, quote.fetchDetail(stock))
})

/* ---------------- 批量 ---------------- */

// 批量入参统一校验：这里显式拒绝超限，而不是静默截断，
// 客户端能立刻发现「漏传/超量」而不是拿到一份缺项的 map
function batchItems(req, res) {
  const items = req.body && req.body.items
  if (!(items instanceof Array) || !items.length) {
    fail(res, 400, '缺少 items')
    return null
  }
  if (items.length > quote.MAX_BATCH) {
    fail(res, 400, '单次最多 ' + quote.MAX_BATCH + ' 只标的')
    return null
  }
  return items
}

// 批量实时行情：POST { items: [{ code, market, secid }] }
// 返回 { '市场:代码': quote|null }，顺序无关，缺项也能对上
router.post('/quotes', (req, res) => {
  const items = batchItems(req, res)
  if (!items) return
  handle(res, quote.fetchQuotes(items))
})

// 批量「行情 + 分红」：持仓页 / 榜单页一次拿齐
router.post('/details', (req, res) => {
  const items = batchItems(req, res)
  if (!items) return
  handle(res, quote.fetchDetails(items))
})

// 缓存状况，方便排查「为什么数据没更新」
router.get('/stats', (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    cache: quote.cacheStats()
  })
})

/* ---------------- 登录：用授权 code 换手机号 ----------------
 * 手机号必须由服务端换（要用 AppSecret），客户端只负责把 code 递上来。
 * 换到之后写进 users 表 —— 那是后台能看到的那份，也是这条链路唯一的权威记录。
 */
router.post('/login', (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  const body = req.body || {}
  if (!body.code) return fail(res, 400, '缺少手机号授权凭证')

  // 没配 AppSecret 就别去撞微信，直接给一句能立刻照做的说明
  if (!wxauth.configured()) {
    return fail(res, 503, '服务端未配置 WX_APPSECRET，暂时无法获取微信手机号')
  }

  wxauth
    .phoneByCode(body.code)
    .then((info) =>
      // 落库失败不影响登录本身（只是后台少一条记录，日志里能看到）
      shadow
        .savePhone(openid, info.purePhone || info.phone)
        .catch((e) => console.warn('[login] 手机号落库失败', (e && e.message) || e))
        .then(() => info)
    )
    .then((info) => res.json({ ok: true, data: info }))
    .catch((e) => {
      console.error('[login] 换取手机号失败', e)
      res.status(502).json({ ok: false, msg: (e && e.msg) || '获取微信手机号失败' })
    })
})

/* ---------------- 会员 ----------------
 * 会员档位的权威值在这里：小程序端本地那份只是缓存，
 * 启动时会用 GET /api/membership 的结果覆盖，所以改本地缓存撑不过一次重启。
 */

// 查当前档位（过期即降级为 free，但不抹掉到期日，续费时还能看到）
router.get('/membership', (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')
  handle(res, membership.statusOf(openid))
})

// 兑换码换会员：一码一用由事务 + FOR UPDATE 保证
router.post('/membership/redeem', (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  const code = String((req.body && req.body.code) || '')
    .trim()
    .toUpperCase()
  if (!code) return fail(res, 400, '请输入兑换码')

  membership
    .redeem(code, openid)
    .then((r) => (r.ok ? res.json({ ok: true, data: r }) : fail(res, 400, r.msg)))
    .catch((e) => {
      console.error('[membership] 兑换失败', e)
      fail(res, 500, '兑换失败，请稍后重试')
    })
})

// 下单：客户端只传方案 key，金额与时长由服务端算
router.post('/membership/order', (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  const plan = String((req.body && req.body.plan) || '').trim()

  membership
    .createOrder(plan, openid)
    .then((r) => (r.ok ? res.json({ ok: true, data: r }) : fail(res, 400, r.msg)))
    .catch((e) => {
      console.error('[membership] 下单失败', e)
      fail(res, 500, '下单失败，请稍后重试')
    })
})

// 生成兑换码：线下收款后发码用，令牌与定时任务共用 CRON_TOKEN
router.post('/admin/codes', (req, res) => {
  if (!cronAllowed(req, res)) return

  const body = req.body || {}
  const tier = String(body.tier || 'pro').trim()
  if (['lite', 'pro'].indexOf(tier) < 0) return fail(res, 400, 'tier 只能是 lite 或 pro')

  const months = Number(body.months) || 12
  const count = Math.min(Math.max(Number(body.count) || 1, 1), 200)

  handle(res, membership.genCodes(tier, months, count))
})

/* ---------------- 虚拟支付 ----------------
 * 会员是虚拟商品，只能走小程序虚拟支付（普通微信支付卖虚拟商品属违规）。
 * 三个接口：下单前签名 / 订单状态（客户端轮询）/ 发货推送（微信回调）。
 */

// 下单前签名：客户端拿 signData + paySig + signature 去调 wx.requestVirtualPayment
router.post('/membership/vpay/prepay', (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  const body = req.body || {}
  const plan = String(body.plan || '').trim()
  const code = String(body.code || '').trim()

  vpay
    .prepay(plan, code, openid)
    .then((r) => {
      // 下单失败（含「支付通道还没配好」）一律回 ok:false + 说明，
      // 客户端拿到它会直接弹「去兑换」引导，而不是当成成功再去取支付参数
      if (!r.ok) return res.json({ ok: false, msg: r.msg, notReady: !!r.notReady })
      res.json({ ok: true, data: r })
    })
    .catch((e) => {
      console.error('[vpay] 下单失败', e)
      res.json({ ok: false, msg: (e && (e.msg || e.message)) || '下单失败，请稍后重试' })
    })
})

// 订单状态：官方明确说 requestVirtualPayment 的 success 回调可能丢失，
// 所以客户端支付成功后要回来轮询这里，以服务端的发货结果为准
router.get('/membership/vpay/order', (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  const outTradeNo = String((req.query && req.query.outTradeNo) || '').trim()
  if (!outTradeNo) return fail(res, 400, '缺少订单号')

  vpay
    .orderStatus(outTradeNo, openid)
    .then((r) => (r.ok ? res.json({ ok: true, data: r }) : fail(res, 400, r.msg)))
    .catch((e) => {
      console.error('[vpay] 查询订单失败', e)
      fail(res, 500, '查询订单失败，请稍后重试')
    })
})

/**
 * 发货推送（微信回调，不带用户身份）。
 * 报文可能是 XML 也可能是 JSON，应答格式要与之一致；
 * 失败时微信会重试，所以处理逻辑必须幂等（见 membership.markPaidAndGrant）。
 */
router.post('/membership/vpay/notify', (req, res) => {
  const isXml = typeof req.body === 'string'
  const reply = (ok, msg) => {
    if (isXml) {
      res.type('application/xml').send(
        '<xml><ErrCode>' + (ok ? 0 : 1) + '</ErrCode><ErrMsg><![CDATA[' + (ok ? 'success' : msg || 'fail') + ']]></ErrMsg></xml>'
      )
      return
    }
    res.json({ ErrCode: ok ? 0 : 1, ErrMsg: ok ? 'success' : msg || 'fail' })
  }

  if (!isXml) console.log('[vpay] 发货推送（JSON）:', JSON.stringify(req.body || {}).slice(0, 500))
  else console.log('[vpay] 发货推送（XML）:', String(req.body || '').slice(0, 500))

  vpay
    .deliver(req.body, isXml)
    .then((r) => reply(!!r.ok, r.msg))
    .catch((e) => {
      console.error('[vpay] 发货处理异常', e)
      reply(false, 'exception')
    })
})

/* ---------------- 后台管理 ----------------
 * 令牌与定时任务共用 CRON_TOKEN。
 * 这两个接口就是回答「后台看不到用户」的：一个直接给出运营总览，
 * 一个把历史数据补进影子表（新数据在每次保存快照时已自动同步）。
 */

// 运营总览：用户数 / 活跃 / 付费 / 持仓分布 / 快照体积排行
router.get('/admin/overview', (req, res) => {
  if (!cronAllowed(req, res)) return
  handle(res, shadow.overview())
})

// 回填影子表：上线后跑一次即可（limit 默认 200，最大 1000；配合 offset 分页）
router.post('/admin/backfill', (req, res) => {
  if (!cronAllowed(req, res)) return

  const body = req.body || {}
  handle(res, shadow.backfill(body.limit, body.offset))
})

/* ---------------- 定时任务 ----------------
 * 容器内的 crond 到点用 curl 打这两个接口（见 docker-entrypoint.sh）。
 * 走 HTTP 是为了让预热发生在「正在服务的这个进程」里 —— 另起一个进程写的是
 * 它自己的内存缓存，对线上没有任何帮助。
 *
 * 令牌取自环境变量 CRON_TOKEN，由启动脚本在生成 crontab 时注入：
 * 没配就拒绝执行（fail closed），避免被外部反复触发白刷上游。
 */
function cronAllowed(req, res) {
  const token = String(process.env.CRON_TOKEN || '')
  if (!token) {
    fail(res, 503, '未配置 CRON_TOKEN，定时任务已拒绝执行')
    return false
  }

  const got = String(
    (req.body && req.body.token) || (req.query && req.query.token) || req.header('x-cron-token') || ''
  )
  if (got !== token) {
    fail(res, 401, '定时任务令牌不正确')
    return false
  }
  return true
}

// 预热：把全部用户持仓涉及的标的刷进缓存
router.post('/cron/warm', (req, res) => {
  if (!cronAllowed(req, res)) return
  handle(res, jobs.warmQuotes())
})

// 清理：回收过期缓存条目
router.post('/cron/clean', (req, res) => {
  if (!cronAllowed(req, res)) return
  res.json({ ok: true, data: quote.cleanCache() })
})

/* ---------------- 删：注销账号，清掉服务端这份数据 ---------------- */
router.delete('/state', async (req, res) => {
  const openid = openidOf(req)
  if (!openid) return fail(res, 401, '缺少微信身份，请从小程序内调用')

  try {
    const pool = await db.ensureReady()
    await pool.query('DELETE FROM user_state WHERE openid = ?', [openid])
    // 影子表也一起清：注销就是「个人信息删除」，不能留副本
    await shadow.removeUser(openid)
    return res.json({ ok: true, openid })
  } catch (e) {
    console.error('[state] 删除失败', e)
    return fail(res, 500, '删除失败，请稍后重试')
  }
})

module.exports = router

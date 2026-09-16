const db = require('./db.js')

/**
 * 影子双写：把「整份 JSON 快照」解析一份写成关系表，专供后台查询与运营统计。
 *
 * 为什么要影子表，而不是直接改客户端：
 *   客户端 store.js 是「本地同步读镜像 + 异步推整份快照」的结构，改成增量 API
 *   要动数据层，风险大、收益晚。所以服务端在收到快照时顺手解析并存一份关系表：
 *   客户端一行都不用改，后台已经能按用户 / 标的 / 日期直接 SQL 查询。
 *
 * 三条纪律：
 *   1. 不阻塞、不抛错 —— 影子表是可重建的派生数据（重跑 backfill 就能补回来），
 *      它出问题绝不能影响用户真实数据的写入，所以全程 best-effort，失败只记日志。
 *   2. 增改之外还要删 —— 否则用户删掉的持仓会一直留在表里。做法是每次同步带一个
 *      递增的 batch_id，写到的行打上本轮号，收尾删掉 batch_id 落后于本轮的行。
 *      用批次号而不是时间戳，是为了不依赖容器与数据库的时钟/时区是否一致。
 *   3. 同一用户串行 —— 并发批次会互相把对方的行当成「已删除」，所以按 openid 排队。
 */

// 单条 SQL 的行数上限：控制在 MySQL 占位符与数据包限制之内
const ROWS_PER_STMT = 200

// 快照体积告警线：超过就在日志里点名，提前发现「快撑爆上限」的用户
const SIZE_WARN = 800 * 1024

/* ---------------- 值归一 ---------------- */

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

function text(v, max) {
  const s = String(v === null || v === undefined ? '' : v).trim()
  return s.length > max ? s.slice(0, max) : s
}

// DATE 列不认空字符串：'yyyy-MM-dd' 之外的都当 null
function dateOrNull(v) {
  const s = String(v || '').trim()
  return /^\d{4}-\d{1,2}-\d{1,2}$/.test(s) ? s : null
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// mysql2 会把 SUM / COUNT 这类聚合结果给成字符串或 BigInt，统一成数字
function toNums(row) {
  const out = {}
  Object.keys(row || {}).forEach((k) => {
    const v = row[k]
    if (typeof v === 'bigint') out[k] = Number(v)
    else if (typeof v === 'string' && /^-?\d+$/.test(v)) out[k] = Number(v)
    else out[k] = v
  })
  return out
}

/* ---------------- 解析快照 ---------------- */

/**
 * 快照 -> 关系行。结构见客户端 utils/store.js：
 *   { profile: { nickName, avatar, phone }, settings: {...}, holdings: [...], records: {...} }
 */
function parse(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : {}
  const settings = s.settings && typeof s.settings === 'object' ? s.settings : {}
  const profile = s.profile && typeof s.profile === 'object' ? s.profile : {}
  const holdings = s.holdings instanceof Array ? s.holdings : []
  const records = s.records && typeof s.records === 'object' ? s.records : {}
  const accounts = settings.accounts instanceof Array ? settings.accounts : []
  const expenses = settings.lifeExpenses instanceof Array ? settings.lifeExpenses : []

  const holdingRows = holdings
    .filter((h) => h && h.id)
    .map((h) => ({
      id: text(h.id, 64),
      code: text(h.code, 24).toUpperCase(),
      market: text(h.market, 16),
      name: text(h.name, 64),
      shares: num(h.shares),
      cost: num(h.cost),
      dps: num(h.dps),
      price: num(h.price),
      taxRate: num(h.taxRate),
      buyDate: dateOrNull(h.buyDate),
      received: num(h.received)
    }))

  // 记录挂在持仓下面：{ [holdingId]: { trade: [], dividend: [] } }
  const recordRows = []
  Object.keys(records).forEach((holdingId) => {
    const bag = records[holdingId] || {}
    ;['trade', 'dividend'].forEach((kind) => {
      const list = bag[kind] instanceof Array ? bag[kind] : []
      list.forEach((r) => {
        if (!r || !r.id) return
        recordRows.push({
          id: text(r.id, 64),
          holdingId: text(holdingId, 64),
          kind: kind,
          date: dateOrNull(r.date),
          type: text(r.type || (kind === 'dividend' ? '分红' : ''), 16),
          shares: num(r.shares),
          price: num(r.price),
          fee: num(r.fee),
          amount: num(r.amount),
          note: text(r.note || r.plan, 255)
        })
      })
    })
  })

  return {
    profile: {
      nickName: text(profile.nickName, 64),
      avatar: text(profile.avatar, 16),
      phone: text(profile.phone, 32),
      holdings: holdingRows.length,
      accounts: accounts.length,
      records: recordRows.length,
      expenses: expenses.length
    },
    holdings: holdingRows,
    records: recordRows
  }
}

/* ---------------- 批次号 ---------------- */

// 严格递增：同毫秒内的两次同步也不会拿到同一个批次号（否则收尾清理会漏删）
let BATCH_SEQ = Date.now()

function nextBatch() {
  BATCH_SEQ++
  return BATCH_SEQ
}

/* ---------------- 批量 upsert ---------------- */

// 一行 14 列（updated_at 用 NOW() 不占占位符）→ 13 个 ?
const HOLDING_TUPLE = '(?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())'

async function upsertHoldings(pool, openid, rows, batchId) {
  for (const part of chunk(rows, ROWS_PER_STMT)) {
    const values = part.map(() => HOLDING_TUPLE).join(',')
    const args = []

    part.forEach((r) => {
      args.push(
        openid, r.id, r.code, r.market, r.name,
        r.shares, r.cost, r.dps, r.price, r.taxRate,
        r.buyDate, r.received, batchId
      )
    })

    await pool.query(
      `INSERT INTO holdings
         (openid, id, code, market, name, shares, cost, dps, price, tax_rate, buy_date, received, batch_id, updated_at)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
         code = VALUES(code), market = VALUES(market), name = VALUES(name),
         shares = VALUES(shares), cost = VALUES(cost), dps = VALUES(dps), price = VALUES(price),
         tax_rate = VALUES(tax_rate), buy_date = VALUES(buy_date), received = VALUES(received),
         batch_id = VALUES(batch_id), updated_at = NOW()`,
      args
    )
  }
}

// 一行 13 列 → 12 个 ?
const RECORD_TUPLE = '(?,?,?,?,?,?,?,?,?,?,?,?,NOW())'

async function upsertRecords(pool, openid, rows, batchId) {
  for (const part of chunk(rows, ROWS_PER_STMT)) {
    const values = part.map(() => RECORD_TUPLE).join(',')
    const args = []

    part.forEach((r) => {
      args.push(
        openid, r.id, r.holdingId, r.kind, r.date, r.type,
        r.shares, r.price, r.fee, r.amount, r.note, batchId
      )
    })

    await pool.query(
      `INSERT INTO holding_records
         (openid, id, holding_id, kind, date, type, shares, price, fee, amount, note, batch_id, updated_at)
       VALUES ${values}
       ON DUPLICATE KEY UPDATE
         holding_id = VALUES(holding_id), kind = VALUES(kind), date = VALUES(date),
         type = VALUES(type), shares = VALUES(shares), price = VALUES(price),
         fee = VALUES(fee), amount = VALUES(amount), note = VALUES(note),
         batch_id = VALUES(batch_id), updated_at = NOW()`,
      args
    )
  }
}

/* ---------------- 单次同步 ---------------- */

async function syncUser(openid, snapshot, rev, byteSize) {
  const parsed = parse(snapshot)
  const pool = await db.ensureReady()
  const batchId = nextBatch()

  // 会员档位以 membership 表为准：快照里那份只是客户端缓存，可能过期、也可能被人改过
  const [mrows] = await pool.query(
    'SELECT tier, expires_at FROM membership WHERE openid = ? LIMIT 1',
    [openid]
  )
  const member = mrows[0] || null
  const p = parsed.profile

  await pool.query(
    `INSERT INTO users
       (openid, nick_name, avatar, phone, tier, tier_expire, holdings, accounts, records, expenses,
        payload_size, rev, created_at, last_seen_at, last_sync_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NOW(),NOW(),NOW())
     ON DUPLICATE KEY UPDATE
       nick_name = VALUES(nick_name), avatar = VALUES(avatar),
       /* 快照里没有手机号时（换设备还没登录）保留已存的那份：
          微信验证过的号由 savePhone 单独写入，不能被空值覆盖掉 */
       phone = IF(VALUES(phone) <> '', VALUES(phone), phone),
       tier = VALUES(tier), tier_expire = VALUES(tier_expire),
       holdings = VALUES(holdings), accounts = VALUES(accounts), records = VALUES(records),
       expenses = VALUES(expenses), payload_size = VALUES(payload_size), rev = VALUES(rev),
       last_seen_at = NOW(), last_sync_at = NOW()`,
    [
      openid,
      p.nickName,
      p.avatar,
      p.phone,
      member ? member.tier : 'free',
      member && member.expires_at ? String(member.expires_at).slice(0, 10) : null,
      p.holdings,
      p.accounts,
      p.records,
      p.expenses,
      num(byteSize),
      num(rev)
    ]
  )

  await upsertHoldings(pool, openid, parsed.holdings, batchId)
  await upsertRecords(pool, openid, parsed.records, batchId)

  // 收尾：本轮没写到的行 = 用户已经删掉的持仓 / 记录
  await pool.query('DELETE FROM holdings WHERE openid = ? AND batch_id < ?', [openid, batchId])
  await pool.query('DELETE FROM holding_records WHERE openid = ? AND batch_id < ?', [openid, batchId])

  if (byteSize > SIZE_WARN) {
    console.warn(
      '[shadow] 快照偏大 ' + Math.round(byteSize / 1024) + 'KB，openid=' + openid +
        '（持仓 ' + p.holdings + ' 只 / 记录 ' + p.records + ' 条）'
    )
  }

  return { holdings: parsed.holdings.length, records: parsed.records.length, batchId: batchId }
}

/* ---------------- 串行队列 ---------------- */

// openid -> 该用户最后排进去的那个 Promise
const queue = new Map()
// openid -> 最近一次失败原因（排查用）
const lastError = new Map()

/**
 * 排队做一次影子同步（不阻塞调用方）。
 * 影子数据是派生的：失败只记日志，重跑一次 backfill 就能补回来，
 * 绝不能因为它出错而影响用户真实数据的写入。
 */
function queueSync(openid, snapshot, rev, byteSize) {
  const prev = queue.get(openid) || Promise.resolve()

  const next = prev
    .catch(() => null)
    .then(() => syncUser(openid, snapshot, rev, byteSize))
    .then((r) => {
      lastError.delete(openid)
      return r
    })
    .catch((e) => {
      lastError.set(openid, (e && e.message) || String(e))
      console.error('[shadow] 同步失败 openid=' + openid, e)
      return null
    })
    .then(() => {
      // 队列跑空就放掉槽位，避免 Map 无限增长
      if (queue.get(openid) === next) queue.delete(openid)
      return null
    })

  queue.set(openid, next)
  return next
}

/**
 * 写入微信验证过的手机号（登录时调用）。
 * 这是「服务端亲眼换到的权威值」：快照里的 profile.phone 只是客户端那份，
 * 换设备 / 清缓存后可能是空的，所以这里单独写一次，
 * 保证后台看到的号码一定是验证过的。
 */
async function savePhone(openid, phone) {
  const pool = await db.ensureReady()
  await pool.query(
    `INSERT INTO users (openid, phone, created_at, last_seen_at)
     VALUES (?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE phone = VALUES(phone)`,
    [openid, text(phone, 32)]
  )
  return true
}

/**
 * 记一次活跃（读快照时调用）。
 * 只在超过 10 分钟没更新时才写，避免每次 GET 都产生一次真实写入 ——
 * 但新用户第一次进来会顺手把行建出来。
 */
async function touch(openid) {
  const pool = await db.ensureReady()
  await pool.query(
    `INSERT INTO users (openid, created_at, last_seen_at)
     VALUES (?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       last_seen_at = IF(last_seen_at < DATE_SUB(NOW(), INTERVAL 10 MINUTE), NOW(), last_seen_at)`,
    [openid]
  )
}

// 注销：影子表也要一起清（个人信息删除要彻底）
async function removeUser(openid) {
  queue.delete(openid)
  lastError.delete(openid)

  const pool = await db.ensureReady()
  await pool.query('DELETE FROM holdings WHERE openid = ?', [openid])
  await pool.query('DELETE FROM holding_records WHERE openid = ?', [openid])
  await pool.query('DELETE FROM users WHERE openid = ?', [openid])
}

/**
 * 回填：把已有的 user_state 全部补一份进影子表。
 * 上线后跑一次即可，之后每次写入都会自动同步。
 */
async function backfill(limit, offset) {
  const pool = await db.ensureReady()
  const n = Math.min(Math.max(num(limit) || 200, 1), 1000)
  const off = Math.max(num(offset) || 0, 0)

  // LIMIT / OFFSET 不能用占位符（部分 MySQL 版本会报参数错误），这里已校验为整数
  const [rows] = await pool.query(
    `SELECT openid, payload, rev FROM user_state ORDER BY updated_at DESC LIMIT ${n} OFFSET ${off}`
  )

  let synced = 0
  let failed = 0

  for (const row of rows) {
    try {
      await syncUser(row.openid, JSON.parse(row.payload), row.rev, String(row.payload || '').length)
      synced++
    } catch (e) {
      failed++
      console.error('[shadow] 回填失败 openid=' + row.openid, e)
    }
  }

  return { scanned: rows.length, synced: synced, failed: failed, limit: n, offset: off }
}

/**
 * 运营总览：一次拿到「有多少人 / 多少活跃 / 多少付费 / 谁的快照快撑爆了 / 大家在持有什么」。
 * 这几条也就是后台最常问的问题，直接给出省得每次现写 SQL。
 */
async function overview() {
  const pool = await db.ensureReady()

  const [uRows] = await pool.query(
    `SELECT COUNT(*) total,
            SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)) active1,
            SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)) active7,
            SUM(last_seen_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) active30,
            SUM(tier <> 'free') paid,
            SUM(tier = 'pro') pro,
            SUM(holdings) holdings,
            SUM(records) records,
            ROUND(AVG(holdings), 2) avgHoldings,
            MAX(payload_size) maxPayloadSize
       FROM users`
  )

  const [sRows] = await pool.query(
    'SELECT COUNT(*) states, SUM(LENGTH(payload)) bytes FROM user_state'
  )

  const [topRows] = await pool.query(
    // ROUND 到整数：SUM(DECIMAL) 回来是 '12000.0000' 这种字符串，
    // 取整后就是 '12000'，下面的 toNums 能把它转成数字，返回给后台更好读
    `SELECT market, code, COUNT(*) holders, ROUND(SUM(shares), 0) shares
       FROM holdings GROUP BY market, code
       ORDER BY holders DESC, shares DESC LIMIT 15`
  )

  const [recentRows] = await pool.query(
    `SELECT openid, nick_name, tier, holdings, records, ROUND(payload_size/1024) kb, last_seen_at
       FROM users ORDER BY last_seen_at DESC LIMIT 20`
  )

  const [bigRows] = await pool.query(
    `SELECT openid, nick_name, holdings, records, ROUND(payload_size/1024) kb
       FROM users ORDER BY payload_size DESC LIMIT 10`
  )

  const [codeRows] = await pool.query(
    'SELECT COUNT(*) total, SUM(used_by IS NOT NULL) used FROM redeem_code'
  )

  const [orderRows] = await pool.query(
    "SELECT COUNT(*) total, SUM(status = 'paid') paid, SUM(amount) amount FROM membership_order"
  )

  return {
    users: toNums(uRows[0]),
    snapshots: toNums(sRows[0]),
    topHoldings: topRows.map(toNums),
    recentUsers: recentRows,
    biggestSnapshots: bigRows,
    redeemCodes: toNums(codeRows[0]),
    membershipOrders: toNums(orderRows[0])
  }
}

module.exports = {
  parse,
  syncUser,
  queueSync,
  savePhone,
  touch,
  removeUser,
  backfill,
  overview,
  SIZE_WARN
}

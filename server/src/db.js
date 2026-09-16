const mysql = require('mysql2/promise')

/**
 * MySQL 连接。连接信息由云托管通过环境变量注入
 * （控制台 → 服务设置 → 环境变量）：
 *   MYSQL_ADDRESS   host:port
 *   MYSQL_USERNAME
 *   MYSQL_PASSWORD
 *   MYSQL_DATABASE  可选，默认 xiji
 */
const DB_NAME = process.env.MYSQL_DATABASE || 'xiji'
const ADDRESS = String(process.env.MYSQL_ADDRESS || '')
const [HOST, PORT] = ADDRESS.split(':')

const conn = {
  host: HOST || '127.0.0.1',
  port: Number(PORT) || 3306,
  user: process.env.MYSQL_USERNAME || 'root',
  password: process.env.MYSQL_PASSWORD || ''
}

let pool = null
let booting = null

/**
 * 只做一次：建库 → 建池 → 建表。
 * 租户的库/表都由代码自己创建，部署完不用再手动执行 SQL。
 */
/**
 * 建连接。云托管 MySQL 是 Serverless，连续 10 分钟没请求会「自动暂停」，
 * 暂停后第一个请求会撞上 CYNOSDB SERVERLESS INSTANCE IS RESUMING…，
 * 隔一下重试就能连上 —— 否则用户会看到一次莫名其妙的失败。
 */
async function connectWithRetry() {
  let last = null

  for (let i = 0; i < 3; i++) {
    try {
      return await mysql.createConnection(conn)
    } catch (e) {
      last = e
      if (!/resuming/i.test(String((e && e.message) || ''))) throw e
      console.warn('[db] 实例正在唤醒，第 ' + (i + 1) + ' 次重试…')
      await new Promise((r) => setTimeout(r, 800 * (i + 1)))
    }
  }

  throw last
}

function ensureReady() {
  if (booting) return booting

  booting = (async () => {
    // 1. 先不指定库连上去，把库建出来（已经存在就跳过）
    const boot = await connectWithRetry()
    await boot.query(
      'CREATE DATABASE IF NOT EXISTS `' + DB_NAME + '` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci'
    )
    await boot.end()

    // 2. 再按库建连接池
    pool = mysql.createPool(
      Object.assign({}, conn, {
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 5,
        charset: 'utf8mb4',
        // DATE / DATETIME 直接给字符串：会员到期日要跟 'yyyy-MM-dd' 比大小，
        // 转成 JS Date 会被时区来回折腾
        dateStrings: true
      })
    )

    // 3. 建表：每个用户一行，payload 直接存整份 JSON 快照
    await pool.query(
      `CREATE TABLE IF NOT EXISTS user_state (
         openid     VARCHAR(64)  NOT NULL COMMENT '微信 openid',
         payload    LONGTEXT     NOT NULL COMMENT '整份用户数据的 JSON',
         rev        INT          NOT NULL DEFAULT 0 COMMENT '写入版本号，每次覆盖 +1',
         updated_at DATETIME     NOT NULL COMMENT '最后一次写入时间',
         PRIMARY KEY (openid)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    // 4. 会员：当前档位与到期时间（权威值，客户端那份只是缓存）
    await pool.query(
      `CREATE TABLE IF NOT EXISTS membership (
         openid     VARCHAR(64) NOT NULL COMMENT '微信 openid',
         tier       VARCHAR(16) NOT NULL DEFAULT 'free' COMMENT 'free / lite / pro',
         expires_at DATE        NULL COMMENT '到期日，空表示未开通',
         source     VARCHAR(32) NOT NULL DEFAULT '' COMMENT '开通来源：兑换码 / 订单',
         updated_at DATETIME    NOT NULL COMMENT '最后变更时间',
         PRIMARY KEY (openid)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    // 5. 兑换码：一次性，used_by 非空即已使用
    await pool.query(
      `CREATE TABLE IF NOT EXISTS redeem_code (
         code       VARCHAR(32) NOT NULL,
         tier       VARCHAR(16) NOT NULL,
         months     INT         NOT NULL,
         used_by    VARCHAR(64) NULL COMMENT '使用者的 openid',
         used_at    DATETIME    NULL,
         created_at DATETIME    NOT NULL,
         PRIMARY KEY (code),
         KEY idx_used_by (used_by)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    // 6. 会员订单：支付通道接入后，由支付回调把 status 改成 paid 并开通
    await pool.query(
      `CREATE TABLE IF NOT EXISTS membership_order (
         order_id   VARCHAR(40)   NOT NULL,
         openid     VARCHAR(64)   NOT NULL,
         plan       VARCHAR(24)   NOT NULL,
         tier       VARCHAR(16)   NOT NULL,
         months     INT           NOT NULL,
         amount     DECIMAL(10,2) NOT NULL,
         status     VARCHAR(16)   NOT NULL DEFAULT 'pending' COMMENT 'pending / paid / closed',
         created_at DATETIME      NOT NULL,
         paid_at    DATETIME      NULL,
         PRIMARY KEY (order_id),
         KEY idx_openid (openid)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    /**
     * 7. 用户主表 —— 后台能直接看到「人」的表。
     * 由 shadow.js 在每次快照写入时影子双写维护（客户端不改一行代码），
     * 里面有昵称、持仓数、会员档位、快照体积、最后活跃时间，正好是运营要看的那些。
     */
    await pool.query(
      `CREATE TABLE IF NOT EXISTS users (
         openid       VARCHAR(64) NOT NULL COMMENT '微信 openid',
         nick_name    VARCHAR(64) NOT NULL DEFAULT '',
         avatar       VARCHAR(16) NOT NULL DEFAULT '',
         phone        VARCHAR(32) NOT NULL DEFAULT '',
         tier         VARCHAR(16) NOT NULL DEFAULT 'free' COMMENT '会员档位，权威值在 membership 表',
         tier_expire  DATE        NULL COMMENT '会员到期日',
         holdings     INT NOT NULL DEFAULT 0 COMMENT '持仓数',
         accounts     INT NOT NULL DEFAULT 0 COMMENT '投资账户数',
         records      INT NOT NULL DEFAULT 0 COMMENT '交易 + 分红记录数',
         expenses     INT NOT NULL DEFAULT 0 COMMENT '生活支出项数',
         payload_size INT NOT NULL DEFAULT 0 COMMENT '快照字节数，用来发现快撑爆上限的用户',
         rev          BIGINT NOT NULL DEFAULT 0 COMMENT '快照版本号',
         created_at   DATETIME NOT NULL,
         last_seen_at DATETIME NOT NULL,
         last_sync_at DATETIME NULL COMMENT '最后一次写入快照的时间',
         PRIMARY KEY (openid),
         KEY idx_last_seen (last_seen_at),
         KEY idx_holdings (holdings),
         KEY idx_tier (tier)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    // 8. 持仓影子表：后台可按标的、按持仓数查（「谁持有 600398」这类问题）
    //    batch_id 是「本轮同步的批次号」：收尾时删掉落后于本批次的行，
    //    也就顺手清掉了用户已经删掉的持仓。用批次号而不是时间戳，是为了
    //    不依赖容器与数据库的时钟/时区是否一致（不一致会误删刚写的行）。
    await pool.query(
      `CREATE TABLE IF NOT EXISTS holdings (
         openid     VARCHAR(64)   NOT NULL,
         id         VARCHAR(64)   NOT NULL COMMENT '客户端生成的持仓 id',
         code       VARCHAR(24)   NOT NULL,
         market     VARCHAR(16)   NOT NULL,
         name       VARCHAR(64)   NOT NULL DEFAULT '',
         shares     DECIMAL(18,4) NOT NULL DEFAULT 0,
         cost       DECIMAL(18,6) NOT NULL DEFAULT 0,
         dps        DECIMAL(18,6) NOT NULL DEFAULT 0,
         price      DECIMAL(18,4) NOT NULL DEFAULT 0,
         tax_rate   DECIMAL(6,2)  NOT NULL DEFAULT 0,
         buy_date   DATE          NULL,
         received   DECIMAL(18,2) NOT NULL DEFAULT 0,
         batch_id   BIGINT        NOT NULL COMMENT '本轮同步批次号',
         updated_at DATETIME      NOT NULL,
         PRIMARY KEY (openid, id),
         KEY idx_code (market, code),
         KEY idx_batch (openid, batch_id)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    // 9. 交易 / 分红记录影子表（同上）
    await pool.query(
      `CREATE TABLE IF NOT EXISTS holding_records (
         openid     VARCHAR(64)   NOT NULL,
         id         VARCHAR(64)   NOT NULL COMMENT '记录 id',
         holding_id VARCHAR(64)   NOT NULL,
         kind       VARCHAR(16)   NOT NULL COMMENT 'trade / dividend',
         date       DATE          NULL,
         type       VARCHAR(16)   NOT NULL DEFAULT '' COMMENT '买入 / 卖出 / 送股 / 分红复投',
         shares     DECIMAL(18,4) NOT NULL DEFAULT 0,
         price      DECIMAL(18,6) NOT NULL DEFAULT 0,
         fee        DECIMAL(18,2) NOT NULL DEFAULT 0,
         amount     DECIMAL(18,2) NOT NULL DEFAULT 0,
         note       VARCHAR(255)  NOT NULL DEFAULT '',
         batch_id   BIGINT        NOT NULL COMMENT '本轮同步批次号',
         updated_at DATETIME      NOT NULL,
         PRIMARY KEY (openid, id),
         KEY idx_holding (openid, holding_id),
         KEY idx_batch (openid, batch_id),
         KEY idx_date (openid, date)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
    )

    console.log('[db] ready, database =', DB_NAME)
    return pool
  })().catch((e) => {
    // 启动失败要允许下次请求重试，否则一次网络抖动会永久卡死
    booting = null
    throw e
  })

  return booting
}

module.exports = { ensureReady, DB_NAME }

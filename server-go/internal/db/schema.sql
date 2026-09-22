-- 收息佬 · App 专用后端 · 表结构
--
-- 与旧版（Node + 腾讯云托管、同时服务小程序与 App）的区别，逐条说明：
--
-- 1) 只服务 App，删掉三张「双端身份」相关的表：
--      link_code    配对码（App ↔ 小程序账号合并；该功能已下线）
--      sms_code     短信验证码（短信通道从未接入，小程序冻结后更用不到）
--      sms_log      短信发送流水
--    并删掉 account.wx_openid 列 —— uid 从此只有一个来源：App 注册时生成的 u_xxx。
--    少了 openid，「uid 既是 openid 又是账号 id」那种历史包袱就彻底没有了，
--    所有业务表的 uid 语义完全统一。
--
-- 2) 登录凭证改为**只存哈希**。
--    旧版 login_token.token 直接存明文，一旦库被拖走，攻击者拿着 token 就能
--    冒充任意用户（有效期 30 天）。现在存 sha256(token) 的 hex，
--    校验时按哈希查表 —— 客户端行为完全不变（它照样发原始 token）。
--    代价：老 token 不可迁移，切库后各端需要重新登录一次。
--
-- 3) 订单表补齐了做支付必然要用、旧版却漏掉的列：
--    channel / transaction_id / prepay_id / closed_at / updated_at。
--    没有 transaction_id 就没法跟微信对账，出了问题只能靠时间猜。
--
-- 4) 影子表（users / holdings / holding_records）列名归一：
--    holdings / accounts / records / expenses 这四个名字在 users 表里是**计数**，
--    却和下面真实的 holdings 表同名，查日志时极易看串，
--    统一改成 *_count；holdings.id 改成 holding_id，明确它是「客户端的持仓 id」。
--
-- 5) 加了 schema_version 表。旧版靠 db.js 里一堆
--    renameColumnIfExists / ensureColumnIfExists 试探性补列，
--    打过的补丁自己都说不清执行过几遍。现在每次结构变更都是一个带版本号的记录。
--
-- 6) 金额与数量的精度保持不变（DECIMAL 18,4 / 18,6），因为快照里存的
--    是客户端算好的浮点数，服务端只做展示与统计，不做二次运算。
--
-- 注意：本文件由 internal/db 内嵌并在启动时执行。
-- 切分语句时会先剥掉整行注释、再按分号切，所以注释里出现分号也不会出问题；
-- 但仍然建议避免，省得以后有人调整解析顺序时又踩一次。

CREATE TABLE IF NOT EXISTS schema_version (
  version     INT          NOT NULL COMMENT '版本号，递增',
  description VARCHAR(128) NOT NULL DEFAULT '' COMMENT '这次改了什么',
  applied_at  DATETIME     NOT NULL COMMENT '执行时间',
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='表结构版本记录';

-- ---------------------------------------------------------------------------
-- 账号
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account (
  uid           VARCHAR(64)  NOT NULL COMMENT '账号主键，App 注册时生成的 u_ + 24 位 hex',
  username      VARCHAR(32)      NULL COMMENT '登录用户名，统一小写，唯一',
  password_hash VARCHAR(255)     NULL COMMENT 'scrypt$salt$hash，见 internal/auth/password.go',
  phone         VARCHAR(32)      NULL COMMENT '手机号，唯一，可空（App 端不强制收集）',
  email         VARCHAR(128)     NULL COMMENT '邮箱，唯一，可空；多端化预留，当前没有登录入口',
  nick_name     VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '昵称',
  status        TINYINT      NOT NULL DEFAULT 1 COMMENT '1 正常 / 0 停用（后台封禁用）',
  created_at    DATETIME     NOT NULL COMMENT '注册时间',
  updated_at    DATETIME     NOT NULL COMMENT '最后资料变更时间',
  last_login_at DATETIME         NULL COMMENT '最后登录时间',
  PRIMARY KEY (uid),
  UNIQUE KEY uk_username (username),
  UNIQUE KEY uk_phone (phone),
  UNIQUE KEY uk_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='账号主表';

-- ---------------------------------------------------------------------------
-- 登录凭证（只存哈希）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_token (
  token_hash   CHAR(64)     NOT NULL COMMENT 'sha256(原始 token) 的 hex；原始 token 是 base64url(24B)=32 字符',
  uid          VARCHAR(64)  NOT NULL COMMENT '所属账号',
  device       VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '设备标识：取 User-Agent 前 64 字符，多端登录时用于识别与踢下线',
  created_at   DATETIME     NOT NULL COMMENT '签发时间',
  expires_at   DATETIME     NOT NULL COMMENT '过期时间',
  last_used_at DATETIME         NULL COMMENT '最后一次使用时间，用于识别长期不活跃的凭证',
  PRIMARY KEY (token_hash),
  KEY idx_uid (uid),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='App 登录凭证';

-- ---------------------------------------------------------------------------
-- 登录失败限流
-- ---------------------------------------------------------------------------
-- 窗口与阈值由 internal/store 的常量决定（15 分钟 / 10 次），
-- 表里只记状态；窗口是否过期一律交给 SQL 的 NOW() 判断，
-- 不用应用进程的时钟 —— 容器时钟与数据库时钟不一致时会算错。
CREATE TABLE IF NOT EXISTS login_attempt (
  username     VARCHAR(32) NOT NULL COMMENT '被尝试的用户名',
  fail_count   INT         NOT NULL DEFAULT 0 COMMENT '窗口内失败次数',
  window_start DATETIME    NOT NULL COMMENT '本窗口起点',
  last_ip      VARCHAR(64) NOT NULL DEFAULT '' COMMENT '最后一次失败的来源 IP，排查撞库用',
  PRIMARY KEY (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='登录失败计数';

-- ---------------------------------------------------------------------------
-- 用户数据快照
-- ---------------------------------------------------------------------------
-- payload 刻意保留 LONGTEXT 而不是改成 MySQL 的 JSON 类型：
--   1) 这份数据最大 5MB，每只持仓还带几十条流水，JSON 类型的解析与存储开销明显更差；
--   2) 服务端对内容**不做任何加工**（不建索引、不按字段查询，要按字段查的都在影子表里），
--      存成 JSON 类型换不到任何查询收益；
--   3) JSON 类型会重排键序、规整空白，而我们希望原样存原样取，
--      客户端拿到的就是它推上来的那一份。
CREATE TABLE IF NOT EXISTS user_state (
  uid          VARCHAR(64) NOT NULL COMMENT '账号 uid',
  payload      LONGTEXT    NOT NULL COMMENT '整份用户数据的 JSON：settings / profile / holdings / records',
  rev          INT         NOT NULL DEFAULT 0 COMMENT '写入版本号，每次覆盖加一',
  payload_size INT         NOT NULL DEFAULT 0 COMMENT '快照字节数，直接用于发现快撑爆上限的用户，不必每次 LENGTH()',
  updated_at   DATETIME    NOT NULL COMMENT '最后一次写入时间',
  PRIMARY KEY (uid),
  KEY idx_updated (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='用户数据快照';

-- ---------------------------------------------------------------------------
-- 会员
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership (
  uid        VARCHAR(64) NOT NULL COMMENT '账号 uid',
  tier       VARCHAR(16) NOT NULL DEFAULT 'free' COMMENT 'free / lite / pro',
  expires_at DATE            NULL COMMENT '到期日，空表示未开通；过期的行**保留不删**，续费时要能看到历史',
  source     VARCHAR(32) NOT NULL DEFAULT '' COMMENT '开通来源：兑换码 / 订单 / 后台',
  started_at DATE            NULL COMMENT '首次开通日期，运营统计用',
  updated_at DATETIME    NOT NULL COMMENT '最后变更时间',
  PRIMARY KEY (uid),
  KEY idx_tier (tier),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='会员档位';

-- ---------------------------------------------------------------------------
-- 兑换码
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS redeem_code (
  code       VARCHAR(32) NOT NULL COMMENT '兑换码：SXL + 10 位随机字符',
  tier       VARCHAR(16) NOT NULL COMMENT '开通档位',
  months     INT         NOT NULL COMMENT '开通月数',
  batch_no   VARCHAR(32) NOT NULL DEFAULT '' COMMENT '生成批次号，按批次查发放与核销情况',
  note       VARCHAR(128) NOT NULL DEFAULT '' COMMENT '备注，例如渠道来源',
  used_by    VARCHAR(64)     NULL COMMENT '使用者的 uid，非空即已核销',
  used_at    DATETIME        NULL COMMENT '核销时间',
  created_at DATETIME    NOT NULL COMMENT '生成时间',
  PRIMARY KEY (code),
  KEY idx_used_by (used_by),
  KEY idx_batch (batch_no),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='会员兑换码';

-- ---------------------------------------------------------------------------
-- 会员订单
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS membership_order (
  order_id       VARCHAR(40)   NOT NULL COMMENT '订单号，同时作为微信支付的 out_trade_no',
  uid            VARCHAR(64)   NOT NULL COMMENT '下单账号',
  plan           VARCHAR(24)   NOT NULL COMMENT '方案 key，如 pro-1y',
  tier           VARCHAR(16)   NOT NULL COMMENT '该方案对应的档位',
  months         INT           NOT NULL COMMENT '开通月数',
  amount         DECIMAL(10,2) NOT NULL COMMENT '金额，单位：元（微信要求的分在下单时乘 100 换算）',
  status         VARCHAR(16)   NOT NULL DEFAULT 'pending' COMMENT 'pending / paid / closed',
  channel        VARCHAR(16)   NOT NULL DEFAULT '' COMMENT '支付渠道：wxpay / redeem / manual，对账时按渠道分组',
  prepay_id      VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '微信预支付单号',
  transaction_id VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '微信支付订单号，与微信对账的唯一凭据',
  created_at     DATETIME      NOT NULL COMMENT '下单时间',
  paid_at        DATETIME          NULL COMMENT '支付成功时间',
  closed_at      DATETIME          NULL COMMENT '关单时间',
  updated_at     DATETIME      NOT NULL COMMENT '最后变更时间',
  PRIMARY KEY (order_id),
  KEY idx_uid_created (uid, created_at),
  KEY idx_status (status),
  KEY idx_channel (channel)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='会员订单';

-- ---------------------------------------------------------------------------
-- 影子表：运营看板用
-- ---------------------------------------------------------------------------
-- 这三张表是**派生数据**，全部可由 user_state 重建，
-- 客户端完全不依赖它们。它们的唯一用途是让后台能直接用人话查：
-- 「谁持有 600398」「最近 7 天活跃多少人」「谁快把快照撑爆了」——
-- 这些用 5MB 的 JSON 快照是查不动的。
--
-- 维护方式：每次 PUT /api/state 后异步双写；
-- 删除用 batch_id 兜底（本轮没写到的旧行即用户已删掉的持仓）。
-- 用批次号而不是时间戳，是为了不依赖容器与数据库的时钟是否一致。
-- 双写失败不影响用户保存（它只是派生数据），补一遍 backfill 即可。
CREATE TABLE IF NOT EXISTS users (
  uid             VARCHAR(64) NOT NULL COMMENT '账号 uid',
  nick_name       VARCHAR(64) NOT NULL DEFAULT '' COMMENT '昵称',
  avatar          VARCHAR(16) NOT NULL DEFAULT '' COMMENT '头像 emoji',
  phone           VARCHAR(32) NOT NULL DEFAULT '' COMMENT '手机号',
  tier            VARCHAR(16) NOT NULL DEFAULT 'free' COMMENT '会员档位，权威值在 membership 表',
  tier_expire     DATE            NULL COMMENT '会员到期日',
  holdings_count  INT NOT NULL DEFAULT 0 COMMENT '持仓数',
  accounts_count  INT NOT NULL DEFAULT 0 COMMENT '投资账户数',
  records_count   INT NOT NULL DEFAULT 0 COMMENT '交易 + 分红记录数',
  expenses_count  INT NOT NULL DEFAULT 0 COMMENT '生活支出项数',
  payload_size    INT NOT NULL DEFAULT 0 COMMENT '快照字节数',
  rev             BIGINT NOT NULL DEFAULT 0 COMMENT '快照版本号',
  created_at      DATETIME NOT NULL COMMENT '首次出现时间',
  last_seen_at    DATETIME NOT NULL COMMENT '最后活跃时间（读取快照时按 10 分钟节流更新）',
  last_sync_at    DATETIME     NULL COMMENT '最后一次写入快照的时间',
  PRIMARY KEY (uid),
  KEY idx_last_seen (last_seen_at),
  KEY idx_holdings (holdings_count),
  KEY idx_tier (tier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='用户主表（影子，后台用）';

CREATE TABLE IF NOT EXISTS holdings (
  uid        VARCHAR(64)   NOT NULL COMMENT '账号 uid',
  holding_id VARCHAR(64)   NOT NULL COMMENT '客户端生成的持仓 id',
  code       VARCHAR(24)   NOT NULL COMMENT '标的代码',
  market     VARCHAR(16)   NOT NULL COMMENT 'A / HK / US / ETF / FUND',
  name       VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '标的名称',
  shares     DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT '持股数',
  cost       DECIMAL(18,6) NOT NULL DEFAULT 0 COMMENT '每股成本（人民币口径）',
  dps        DECIMAL(18,6) NOT NULL DEFAULT 0 COMMENT '每股股息（人民币口径）',
  price      DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT '现价（人民币口径）',
  tax_rate   DECIMAL(6,2)  NOT NULL DEFAULT 0 COMMENT '分红税率 %',
  buy_date   DATE              NULL COMMENT '首次买入日',
  received   DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '累计已收股息',
  batch_id   BIGINT        NOT NULL COMMENT '本轮同步批次号',
  updated_at DATETIME      NOT NULL COMMENT '最后同步时间',
  PRIMARY KEY (uid, holding_id),
  KEY idx_code (market, code),
  KEY idx_batch (uid, batch_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='持仓影子表';

CREATE TABLE IF NOT EXISTS holding_records (
  uid        VARCHAR(64)   NOT NULL COMMENT '账号 uid',
  record_id  VARCHAR(64)   NOT NULL COMMENT '记录 id',
  holding_id VARCHAR(64)   NOT NULL COMMENT '所属持仓 id',
  kind       VARCHAR(16)   NOT NULL COMMENT 'trade / dividend',
  date       DATE              NULL COMMENT '发生日期',
  type       VARCHAR(16)   NOT NULL DEFAULT '' COMMENT '买入 / 卖出 / 送股 / 分红复投',
  shares     DECIMAL(18,4) NOT NULL DEFAULT 0 COMMENT '股数',
  price      DECIMAL(18,6) NOT NULL DEFAULT 0 COMMENT '成交价',
  fee        DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '手续费',
  amount     DECIMAL(18,2) NOT NULL DEFAULT 0 COMMENT '金额',
  note       VARCHAR(255)  NOT NULL DEFAULT '' COMMENT '备注 / 分红方案',
  batch_id   BIGINT        NOT NULL COMMENT '本轮同步批次号',
  updated_at DATETIME      NOT NULL COMMENT '最后同步时间',
  PRIMARY KEY (uid, record_id),
  KEY idx_holding (uid, holding_id),
  KEY idx_batch (uid, batch_id),
  KEY idx_date (uid, date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci COMMENT='交易分红影子表';

-- 版本记录：第一次跑就是结构基线。
-- 以后每次改结构，都往这里加一条并同步改上面的 DDL。
INSERT IGNORE INTO schema_version (version, description, applied_at)
VALUES (1, 'App 专用后端的初始结构基线', NOW());

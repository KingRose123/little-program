-- ===========================================================================
-- 数据迁移：旧库（Node 版，双端）→ 新库（Go 版，App 专用）
-- ===========================================================================
--
-- 用法：
--   1. 先把新库建出来（启动一次服务即可，它会自己 CREATE DATABASE + 建表）；
--   2. 把旧库整库备份到你自己的机器上（这一步不能省，迁移出问题就靠它回滚）：
--        mysqldump -h 旧地址 -u 用户 -p 旧库名 > backup.sql
--   3. 把旧库导入到这台服务器的 MySQL（或者让新库能访问到旧库）；
--   4. 把下面的 xiji_old 换成旧库名，逐段执行。
--
-- 每段都是幂等的（ON DUPLICATE KEY UPDATE），跑重了不会产生重复数据。
--
-- 迁移范围的取舍（这一段比上面的 SQL 更重要）：
--   ✔ account       —— 只迁「有用户名」的账号
--   ✔ user_state    —— 用户数据快照，一个字节都不改
--   ✔ membership    —— 会员档位与到期日
--   ✔ redeem_code   —— 已发出的兑换码（核销状态一起带过来）
--   ✔ membership_order —— 历史订单
--   ✘ login_token   —— **不迁**，见文末说明
--   ✘ login_attempt —— 不迁（登录失败计数，几分钟的临时状态）
--   ✘ users / holdings / holding_records —— 不迁，用回填接口重建（见文末）
--   ✘ 小程序专属行（只有 openid、没有用户名的账号）—— 不迁

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------------
-- 1. 账号
-- ---------------------------------------------------------------------------
-- 只取有用户名的行：新后端是 App 专用，登录只有「用户名 + 密码」这一条路，
-- 那些纯 openid 的小程序账号在新系统里没有身份可以登录，迁过来只会变成
-- 永远登不进去的空号。它们的数据快照也一并留在旧库（需要时可以人工处理）。
INSERT INTO account
  (uid, username, password_hash, phone, email, nick_name, status, created_at, updated_at, last_login_at)
SELECT a.uid,
       a.username,
       a.password_hash,
       a.phone,
       NULL,
       COALESCE(a.nick_name, ''),
       1,
       a.created_at,
       NOW(),
       a.last_login_at
  FROM xiji_old.account a
 WHERE a.username IS NOT NULL
   AND a.username <> ''
ON DUPLICATE KEY UPDATE
  username      = VALUES(username),
  password_hash = VALUES(password_hash),
  phone         = VALUES(phone),
  nick_name     = VALUES(nick_name),
  updated_at    = NOW();

-- ---------------------------------------------------------------------------
-- 2. 用户数据快照
-- ---------------------------------------------------------------------------
-- payload 原样搬运。rev 一起带过来，客户端那边记着的 rev 才对得上，
-- 不会因为「服务端说 rev=1、本地记着 rev=57」而重复拉一次全量。
-- payload_size 是新加的列，这里用 LENGTH() 补齐。
INSERT INTO user_state (uid, payload, rev, payload_size, updated_at)
SELECT s.uid, s.payload, s.rev, LENGTH(s.payload), s.updated_at
  FROM xiji_old.user_state s
  JOIN account a ON a.uid = s.uid
ON DUPLICATE KEY UPDATE
  payload      = VALUES(payload),
  rev          = VALUES(rev),
  payload_size = VALUES(payload_size),
  updated_at   = VALUES(updated_at);

-- ---------------------------------------------------------------------------
-- 3. 会员
-- ---------------------------------------------------------------------------
-- 过期的记录照样迁：新结构刻意保留了 expires_at 与 tier 原值，
-- 「过期」只在查询时表现为 free，用户续费时还能看到自己原来买过什么。
-- started_at 是新加的列，老数据没有这个信息，用 expires_at 兜一个值 ——
-- 它只用于运营统计，偏差几天不影响任何判断。
INSERT INTO membership (uid, tier, expires_at, source, started_at, updated_at)
SELECT m.uid, m.tier, m.expires_at, COALESCE(m.source, ''), m.expires_at, m.updated_at
  FROM xiji_old.membership m
  JOIN account a ON a.uid = m.uid
ON DUPLICATE KEY UPDATE
  tier       = VALUES(tier),
  expires_at = VALUES(expires_at),
  source     = VALUES(source),
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 4. 兑换码
-- ---------------------------------------------------------------------------
-- used_by 一起迁：已经用掉的码在新系统里必须仍然是「已用」，
-- 否则同一个人（或拿到同一个码的人）可以在新后端再兑换一次。
INSERT INTO redeem_code (code, tier, months, batch_no, note, used_by, used_at, created_at)
SELECT r.code, r.tier, r.months, '', '迁移自旧库',
       CASE WHEN r.used_by IN (SELECT uid FROM account) THEN r.used_by ELSE NULL END,
       r.used_at,
       r.created_at
  FROM xiji_old.redeem_code r
ON DUPLICATE KEY UPDATE
  tier    = VALUES(tier),
  months  = VALUES(months),
  used_by = VALUES(used_by),
  used_at = VALUES(used_at);

-- ---------------------------------------------------------------------------
-- 5. 订单
-- ---------------------------------------------------------------------------
-- 老订单没有 channel / transaction_id（旧表的列就在那儿缺着，补不出来），
-- 所以 channel 统一标成 migrated 并在备注里说明来源 ——
-- 这样以后按渠道对账时，这批历史数据不会混进真实渠道的数字里。
INSERT INTO membership_order
  (order_id, uid, plan, tier, months, amount, status, channel,
   prepay_id, transaction_id, created_at, paid_at, closed_at, updated_at)
SELECT o.order_id, o.uid, o.plan, o.tier, o.months, o.amount, o.status, 'migrated',
       '', '',
       o.created_at,
       o.paid_at,
       NULL,
       COALESCE(o.paid_at, o.created_at)
  FROM xiji_old.membership_order o
  JOIN account a ON a.uid = o.uid
ON DUPLICATE KEY UPDATE
  status     = VALUES(status),
  paid_at    = VALUES(paid_at),
  updated_at = NOW();

-- ---------------------------------------------------------------------------
-- 6. 自检
-- ---------------------------------------------------------------------------
-- 跑完对着这两组数字看一眼，比读十遍迁移脚本都管用。
SELECT 'account'     AS 表, COUNT(*) AS 新库行数 FROM account
UNION ALL SELECT 'user_state',      COUNT(*) FROM user_state
UNION ALL SELECT 'membership',      COUNT(*) FROM membership
UNION ALL SELECT 'redeem_code',     COUNT(*) FROM redeem_code
UNION ALL SELECT 'membership_order',COUNT(*) FROM membership_order;

SELECT 'old_account' AS 表, COUNT(*) AS 旧库总行数 FROM xiji_old.account
UNION ALL SELECT 'old_account_app',     COUNT(*) FROM xiji_old.account WHERE username IS NOT NULL AND username <> ''
UNION ALL SELECT 'old_user_state',      COUNT(*) FROM xiji_old.user_state;

-- ---------------------------------------------------------------------------
-- 为什么 login_token 不迁
-- ---------------------------------------------------------------------------
-- 新结构把凭证改成了**只存哈希**（login_token.token_hash），
-- 旧库里存的是明文 token，两者对不上，没法直接搬。
--
-- 理论上可以为每一行算出 sha256 再插进去，那样所有设备都不用重新登录。
-- 没有这么做，是因为：这次切换同时换了域名和后端，本来就是一个
-- 「请重新登录一次」的时机 —— 而换来的收益是实打实的：
-- 以后就算数据库被拖走，攻击者也没法拿着哈希去冒充任何人。
--
-- 用户侧的表现：打开 App 时会被提示「登录已过期」，重新输一次用户名密码即可，
-- 数据一条都不会少（快照、会员、订单都已经迁过来了）。
--
-- ---------------------------------------------------------------------------
-- 影子表怎么重建
-- ---------------------------------------------------------------------------
-- users / holdings / holding_records 三张表全是**派生数据**，
-- 可以由 user_state 完整重建，所以不写迁移 SQL —— 直接调一次回填接口：
--
--   curl -X POST https://api.你的域名.com/api/admin/backfill \
--        -H 'X-Cron-Token: <CRON_TOKEN>' \
--        -H 'Content-Type: application/json' \
--        -d '{"limit":1000,"offset":0}'
--
-- 返回里的 synced 应该等于上面的 user_state 行数。之后再看运营总览：
--
--   curl -H 'X-Cron-Token: <CRON_TOKEN>' https://api.你的域名.com/api/admin/overview

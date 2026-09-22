-- 结构变更（带版本号，按序执行且**只执行一次**）。
--
-- 与 schema.sql 的分工：
--   schema.sql     —— 幂等语句（CREATE TABLE IF NOT EXISTS / INSERT IGNORE），
--                     每次启动重跑一遍，有新表时会自动补建；
--   migrations.sql —— **不幂等**的语句（ALTER TABLE 之类）。
--                     MySQL 没有 ADD COLUMN IF NOT EXISTS（那是 MariaDB 的语法），
--                     重复执行会直接报 Duplicate column name 让服务起不来，
--                     所以它们必须按版本号精确执行。
--
-- 写法：一条标记行，紧接着写它的 SQL。一条标记下可以放多条语句。
--
--   -- @version N : 一句话说明
--   ALTER TABLE some_table ADD COLUMN some_col ...;
--
-- 两条规矩：
--   1) 版本号只增不减，**不要复用已经发布过的号**。已经发出去的版本如果被改写，
--      服务器上那份不会重新执行 —— 版本号是「执行没有」的唯一凭据，它本身就是凭据。
--   2) v1 是 schema.sql 里的结构基线，从这里（v2）开始。
--
-- 执行失败会记日志并中断启动，不会静默跳过：宁可服务起不来让人看见，
-- 也不要带着一半改过的结构对外服务。

-- 兑换码可以作废。
--
-- 用途：码发错了人、买家退款、某一批码泄漏了。
-- 只允许作废**未使用**的 —— 已经核销的码意味着用户已经开通了会员，
-- 把它标成作废等于把人家买到的权益收回去，那是退款，得单独处理。
--
-- @version 2 : 兑换码支持作废
ALTER TABLE redeem_code ADD COLUMN voided_at DATETIME NULL COMMENT '作废时间，非空即已作废';

-- 列表与统计要按它筛（「这批还剩哪些没发出去」是最常用的查询）
ALTER TABLE redeem_code ADD INDEX idx_voided (voided_at);

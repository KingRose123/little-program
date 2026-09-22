# 收息佬 · App 专用后端（Go）

用 Go 从零重写的后端，只服务 React Native App。
原 Node 版（`../server/`，同时服务小程序与 App、跑在微信云托管上）保留不动，可随时对照或回滚。

**App 前端一行都不用改** —— 接口路径、字段名、错误约定全部沿用，只改一个 `API_BASE`。

---

## 一、它和旧版有什么不同

### 1. 面向 App 独有的一套身份

旧版的身份有两个来源：小程序靠云托管注入的 `X-WX-OPENID`，App 靠 `Authorization: Bearer`。
现在只剩后者，于是可以删掉一批东西：

| 删除项 | 原因 |
|---|---|
| `account.wx_openid` 列 | uid 只有一个来源了，不再需要「uid 可能等于 openid」这种兼容逻辑 |
| `link_code` 表 | 账号关联（App ↔ 小程序合并）功能已下线 |
| `sms_code` / `sms_log` 表 | 短信通道从未接入，小程序冻结后更无用处 |
| `X-WX-OPENID` 鉴权分支 | 少一条身份来源，就少一处可能绕过鉴权的入口 |

### 2. 表结构上真正改掉的东西

| 改动 | 为什么 |
|---|---|
| 登录凭证**只存哈希**（`token_hash`） | 旧版明文存 token，库被拖走等于所有人的登录态被接管。代价是老 token 不可迁移，切库后各端重登一次 |
| 订单表补 `channel` / `transaction_id` / `prepay_id` / `closed_at` / `updated_at` | 没有 `transaction_id` 就没法跟微信对账，出了问题时只能靠时间猜 |
| 影子表列名归一（`holdings_count`、`holding_id`、`record_id`） | 旧表里 `users.holdings` 是**计数**，和下面真实的 `holdings` 表同名，查日志时极易看串 |
| `user_state.payload_size` 冗余一列 | 「谁的快照快撑爆 5MB 上限」是每天要看一眼的指标，不必每次 `LENGTH()` 扫一遍几 MB 的文本 |
| 新增 `schema_version` 表 | 旧版靠一堆 `renameColumnIfExists` / `ensureColumnIfExists` 试探性补列，打过的补丁自己都说不清执行过几遍 |
| `payload` 仍是 `LONGTEXT`（没改成 JSON 类型） | 服务端对内容零加工、不建索引、不按字段查，改成 JSON 类型换不到任何收益，反而会重排键序、规整空白 |

### 3. 支付渠道做成了接口

`wxpay.Channel` 是一个接口，微信支付只是其中一种实现。
这不是过度设计 —— iOS 上架要求虚拟商品走 Apple 内购，多端化几乎必然会再接第二个渠道，
到那时只需再写一个实现，`store` 与 `api` 两层不用动。

---

## 二、目录

```
server-go/
├── cmd/api/main.go              进程入口：读配置 → 装配依赖 → 监听 → 优雅退出
├── internal/
│   ├── config/                  环境变量读取与校验
│   ├── db/                      连接池、建库建表（schema.sql 内嵌进二进制）
│   │   └── schema.sql           ★ 全部表结构，单独成文件方便 review
│   ├── auth/                    scrypt 密码哈希、凭证生成（参数与旧版逐位兼容）
│   ├── apperr/                  「能告诉用户」与「只能记日志」的错误之分
│   ├── store/                   唯一写 SQL 的地方（account / token / state / membership）
│   ├── shadow/                  影子表：快照 → 关系行，供后台查询与统计
│   ├── wxpay/                   支付渠道抽象（微信支付实现待补）
│   └── api/                     HTTP 层：路由、鉴权、响应封装
├── Dockerfile                   多阶段构建，静态二进制 + 非 root 运行
├── docker-compose.yml           api + mysql + caddy
├── Caddyfile                    自动 HTTPS 反代
├── migrate.sql                  ★ 旧库 → 新库的数据迁移
└── .env.example                 环境变量样例（每项都有说明）
```

分层规矩很简单：**`api` 不写 SQL，`store` 不碰 HTTP**。
`store` 里的函数都能在测试里直接调用，不必起 HTTP 服务。

---

## 三、本地跑起来

```bash
cd server-go
cp .env.example .env          # 填数据库连接
go mod tidy                   # 首次需要联网拉两个依赖
go run ./cmd/api
curl http://127.0.0.1:8080/api/health
```

### Windows 上中文日志是乱码？

那是**控制台编码**问题，不是程序问题：Go 往 stdout 写的是 UTF-8，
而中文版 Windows 的控制台默认按 GBK 解码，于是「微信支付未配置」会显示成「寰俊鏀粯鏈厤缃」。
Linux / Docker 里不存在这个现象（那里就是 UTF-8）。

想让本地也看清，跑之前先执行一次：

```powershell
chcp 65001        # 把当前控制台切成 UTF-8
```

### 依赖走国内代理

`go mod tidy` 默认连 proxy.golang.org，国内会卡住。设一次即可（Go 会记住）：

```bash
go env -w GOPROXY=https://goproxy.cn,direct
```

`/api/health` 会告诉你服务活没活、数据库通不通、支付配没配：

```json
{
  "ok": true, "service": "xiji-api", "build": "2026-09-19-go-initial",
  "config": { "mysql": true, "cron": true, "timezone": "Asia/Shanghai", "db": "xiji" },
  "wxpay": { "ready": false, "lack": ["WXPAY_APPID", "WXPAY_MCHID", "..."] }
}
```

**建库建表不用手工执行 SQL** —— 服务启动时自己会做（`CREATE DATABASE IF NOT EXISTS` + 建表）。
全新服务器上直接跑就行。

---

## 四、部署到自己的服务器

```bash
# 1. 把代码传到服务器
scp -r server-go/ user@你的服务器:/opt/xiji/

# 2. 配置
cd /opt/xiji/server-go
cp .env.example .env
vi .env                          # 至少改：CRON_TOKEN、MYSQL_*、BUILD

# 3. 起服务（含 MySQL 与 Caddy）
docker compose up -d --build

# 4. 确认
docker compose logs -f api
curl https://api.你的域名.com/api/health
```

服务器上已有 MySQL 的话，把 `docker-compose.yml` 里的 `mysql` 段删掉，
在 `.env` 里把 `MYSQL_ADDRESS` 指向它即可。

**HTTPS 由 Caddy 自动搞定**：改 `Caddyfile` 里的域名为你自己的，
它自己申请证书、自己续期，不需要 certbot，也不需要写续期定时任务。

### 定时任务

行情缓存预热与清理靠服务器上的 cron 打接口（**不是**在容器里跑 crond —— 预热必须发生在正在服务请求的那个进程里，另起进程写的是它自己的内存缓存）：

```cron
# 工作日开盘前 / 收盘后各预热一次，凌晨回收过期缓存
0 9  * * 1-5 curl -s -o /dev/null -X POST -H 'X-Cron-Token: <你的令牌>' http://127.0.0.1:8080/api/cron/warm
5 16 * * 1-5 curl -s -o /dev/null -X POST -H 'X-Cron-Token: <你的令牌>' http://127.0.0.1:8080/api/cron/warm
30 4 * * *   curl -s -o /dev/null -X POST -H 'X-Cron-Token: <你的令牌>' http://127.0.0.1:8080/api/cron/clean
```

`/api/cron/warm` 会扫一遍所有用户的持仓，把涉及的标的刷进缓存（同一只票只刷一次），
返回 `{users, codes, warmed, failedCount, elapsedMs, cache}` —— 部署后跑一次看 `warmed` 是不是接近 `codes`，
就知道上游通不通。

### 备份

用户数据都在 MySQL 里，一条命令够用：

```cron
# 每天凌晨 3 点全量备份，保留 14 天
0 3 * * * docker exec xiji-mysql mysqldump -uroot -p$MYSQL_ROOT_PASSWORD --single-transaction xiji | gzip > /backup/xiji-$(date +\%F).sql.gz
0 4 * * * find /backup -name 'xiji-*.sql.gz' -mtime +14 -delete
```

`--single-transaction` 不能省：不加它 `mysqldump` 会锁表，
而用户数据快照的写入是随时可能发生的，锁表期间所有保存都会失败。

---

## 五、数据迁移（旧库 → 新库）

**先备份，再动手。** 详见 `migrate.sql`，里面每个取舍都写了原因。要点：

1. **只迁有用户名的账号**。纯 openid 的小程序账号在新系统里没有身份可登录，迁过来只是永远登不进去的空号。
2. **快照、会员、兑换码、订单全部原样搬**，`rev` 一起带过来（否则客户端会因为 rev 对不上而重复拉一次全量）。
3. **凭证不迁** → 用户重登一次。这是「只存哈希」这个安全改进的代价，切换域名本来也是个合适的时机。
4. **影子表不迁**，调一次回填接口重建：

```bash
curl -X POST https://api.你的域名.com/api/admin/backfill \
     -H 'X-Cron-Token: <你的令牌>' -H 'Content-Type: application/json' \
     -d '{"limit":1000,"offset":0}'
```

之后看运营总览确认：

```bash
curl -H 'X-Cron-Token: <你的令牌>' https://api.你的域名.com/api/admin/overview
```

---

## 六、接口清单（App 契约，字段名不可改）

### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | → `data: { token, expiresInDays, uid, username, isNew }` |
| POST | `/api/auth/login` | 同上 |
| GET | `/api/auth/me` | → `data: { uid, via, username, phone }` |
| POST | `/api/auth/logout` | → `{ ok: true }` |
| DELETE | `/api/auth/account` | 注销：删账号 + 快照 + 影子表 → `data: { deleted: true }` |

### 数据快照

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | → `{ uid, rev, updatedAt, payload }`；新用户 `payload: null` |
| PUT | `/api/state` | body `{ payload }` → `{ uid, rev, updatedAt, bytes }`；上限 5MB |
| DELETE | `/api/state` | 清快照保留账号 |

### 会员与支付

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/membership` | → `data: { tier, paidTier, expiresAt, source, expired }` |
| POST | `/api/membership/redeem` | body `{ code }` → `data: { months, membership }` |
| POST | `/api/membership/appay/prepay` | body `{ plan }` → 调起支付参数；未配置时回 `{ ok:false, notReady:true }` |
| GET | `/api/membership/order` | 订单状态（`?outTradeNo=`） |
| GET | `/api/membership/vpay/order` | **同上，别名** —— App 现行版本写死了这个路径 |
| POST | `/api/membership/appay/notify` | 微信支付回调（验签 + 幂等发货） |

### 后台（`X-Cron-Token` 头，也接受 `?token=` 查询串）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/admin/codes` | 批量生成兑换码 |
| GET | `/api/admin/codes` | 查兑换码：按批次/状态筛选，附带统计与批次概览 |
| GET | `/api/admin/codes/export` | 导出 CSV（带 UTF-8 BOM，Excel 直接打开不乱码） |
| POST | `/api/admin/reset-password` | 重置密码（用户忘了密码时的唯一通道） |
| POST | `/api/admin/backfill` | 回填影子表 |
| GET | `/api/admin/overview` | 运营总览 |

### 卖码的日常操作

没有营业执照也能收钱的路子：在第三方平台卖码，用户拿到码在 App 里兑换。
（微信/支付宝的商户号要求营业执照，Apple 内购要 Apple Developer 账号 ——
兑换码是这三条路里唯一零门槛的。）

```bash
T=<你的 CRON_TOKEN>
API=https://api.你的域名.com

# 1) 生成一批（一次最多 200 个，自动带上批次号）—— 记下返回里的 batch
curl -s -X POST "$API/api/admin/codes" -H "X-Cron-Token: $T" \
  -H 'Content-Type: application/json' \
  -d '{"tier":"pro","months":12,"count":100,"note":"闲鱼首批"}'

# 2) 发码前先看这批还剩哪些没用
curl -s -H "X-Cron-Token: $T" \
  "$API/api/admin/codes?batch=<批次>&status=unused"

# 3) 导出这批未使用的码，倒进发货系统。
#    令牌能放查询串，所以浏览器直接打开就能下载，不用装 curl：
#    $API/api/admin/codes/export?token=$T&batch=<批次>&status=unused
```

**最要紧的一条：每次发码前都查一遍 `status=unused`。**
不要照着最初生成时的那份列表发 —— 那份列表不会变，
而已经发出去的码也不会从里面消失，照它发迟早会把同一个码发给两个人。

### 错误约定

```json
{ "ok": false, "msg": "给用户看的一句话" }
```

状态码有意义，不是一律 500：`401` 未登录（**客户端据此清登录态跳登录页，是唯一会触发退出的信号**）、
`400` 参数或业务错、`404`、`413` 数据过大、`429` 登录失败次数过多。

---

## 七、App 端要改的（仅一处）

`app/src/config.js`：

```js
// 旧：云托管默认域名
const API_BASE = 'https://xiji-api-1778556-1301166984.ap-shanghai.run.tcloudbase.com'
// 新：你自己的域名
const API_BASE = 'https://api.你的域名.com'
```

改完重新打包。除此之外 App 不需要任何改动 —— 这也是这套后端从设计到实现一直守的约束。

---

## 八、行情代理（`internal/quote`）

向上游（东方财富）取数并归一化，字段名与旧 Node 版逐字一致。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/quote/search?kw=` | 代码 / 名称 / 拼音搜索 |
| GET | `/api/quote?code=&market=&secid=` | 单只实时行情 |
| GET | `/api/fund?code=` | 场外基金净值 + 分红 |
| GET | `/api/dividend?code=&market=&size=` | 分红档案（美股返回 `null`） |
| GET | `/api/detail?code=&market=&secid=` | 行情 + 分红一次取齐 |
| POST | `/api/quotes` | 批量行情，body `{items:[{code,market,secid}]}` |
| POST | `/api/details` | 批量行情 + 分红 |

几个刻意的设计：

- **进程内缓存 + 单飞**。同一 key 的并发请求合并成一次上游调用。
  一个用户打开持仓页是十几个请求，十个用户同时刷新就是上百个，而其中大量是同一只票 —— 没有单飞，上游很快会按出口 IP 限流，所有用户一起受影响。
- **空结果不写缓存**。上游限流或临时故障时返回的空值如果能被缓存，用户会连着几分钟看不到数据，而我们连重试的机会都没有。
- **批量并发上限 6**，单次最多 60 只（与旧版一致）。超量显式回 400 而不是静默截断 —— 截断会让客户端拿到一份缺项的 map，表现为「有几只持仓没有价格」，而它并不知道自己少传了。
- **上游客外**。上游失败回 502（不是 500），日志里一眼能分开「数据没取到」和「我们自己坏了」。
- **缓存 TTL**：行情 15 秒 / 搜索 60 秒 / 基金 30 秒 / **分红 12 小时**（公告类数据，一天最多变一两次，而单只标的的档案有几十上百条）。

## 九、微信支付（`internal/wxpay`）

APIv3 · App 支付。配置齐全时启动日志会打印「微信支付已启用」，否则退回兑换码通道。

签名只有三处，但**每处的换行位置都不同**，这是最容易写错的地方：

| 用途 | 签名串 |
|---|---|
| 调微信接口 | `方法\nURL\n时间戳\n随机串\n报文\n` |
| 调起支付（给 SDK） | `appid\n时间戳\n随机串\nprepayid\n` |
| 回调验签 | `时间戳\n随机串\n原始报文\n` |

三处**末尾都带换行**，少一个就全是「签名错误」，而微信不会告诉你少了什么。

另外两点：

- **回调必须用未解析的原始报文验签**。JSON 解析再序列化会改变键顺序与空白，签名立刻对不上 —— 所以 handler 是用 `io.ReadAll` 直接读 body 的。
- **AES-256-GCM 解密时不要把最后 16 字节手工切出来**。微信的密文是「密文 || 认证标签」，而这正好就是 Go `cipher.AEAD.Open` 期望的格式，直接整段传进去即可。

平台证书从 `/v3/certificates` 动态拉取（缓存 12 小时）：微信会轮换证书，写死会在某天突然全部验签失败。

发货是**幂等**的（`SELECT ... FOR UPDATE` + 状态判断）：微信收不到成功应答会一直重推，重复发货会让用户白得几个月。

## 十、容量与限流

### 架构现状

单进程 + 单 MySQL。行情缓存在**进程内存**里（TTL 15 秒，带单飞合并同一只票的并发请求），
影子表异步双写。能撑多少，取决于三个环节里**最先到顶**的那个：

| 环节 | 现状 | 什么时候成为瓶颈 |
|---|---|---|
| MySQL 连接池 | 25 条（**每实例**） | 同时有 25 个请求在占用连接 |
| 影子表并发 | 8 个任务，且**与用户请求共用同一个池** | 批量导入、或大批用户同时改数据 |
| 行情上游 | 东财免费接口，按**我们的出口 IP** 限流 | 缓存未命中的请求变多：用户变多，或有人刷 |

### 两个观察点

```bash
curl -s http://127.0.0.1:18080/api/health
```

看 `pool.waitCount`：**长期大于 0 就说明真的有人在排队等连接**，那是「池该调大」的直接证据，
不用猜。（池被占满时外部表现只是「变慢」，日志里什么都没有，这是最难查的一类问题 ——
所以把它摆到健康检查里。）

再盯两条日志：

```
[limit] 公开接口限流命中 ip=… GET /api/quote     ← 要么额度定小了在误伤，要么真有人在刷
[slow]  GET /api/state 3.2s                      ← 慢请求，配合 waitCount 一起看
```

### 分级的应对

| 用户量 | 主要风险 | 该做什么 |
|---|---|---|
| < 1000 | 基本没有 | 什么都不用改，默认配置够用 |
| 1000 ~ 1 万 | 行情上游被刷；连接池排队 | 按日志调 `PUBLIC_RATE_LIMIT`；池调到 50 |
| > 1 万 | 单实例扛不住；缓存无法共享 | 需要多实例 + Redis，见下 |

### 上多实例之前必须先改的三件事

现在这套是**按单实例设计**的，直接起两个实例会出问题：

1. **行情缓存搬进 Redis**。缓存现在是进程内的，多实例各存一份 ——
   上游请求量直接 ×实例数，等于自己把自己限流了。
2. **限流搬进 Redis**。同理，进程内令牌桶在多实例下真实额度会翻倍。
   （`internal/ratelimit` 的接口是照着「将来换成 Redis 实现」设计的，调用方不用动。）
3. **`/api/cron/warm` 只能打一个实例**（或改成分布式任务）。
   它的语义是「把数据放进**正在服务请求的那个进程**的缓存」，N 个实例各扫一遍
   等于把上游请求量翻 N 倍。

另外要注意：连接池是**每实例** 25 条，实例数 × 25 不能超过 MySQL 的
`max_connections`（默认 151）。真要开到 6 个实例以上，得同时调大 MySQL 那边。

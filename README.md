# 收息佬

一个追踪「股息收入」的工具：记录持仓、算清每年能收多少分红、把分红日历铺开看哪个月现金流最厚。

这个仓库同时包含**小程序**、**App** 和 **Go 后端**三部分。

---

## 目录结构

```
.
├── pages/ utils/ components/ custom-tab-bar/     微信小程序
│   app.js  app.json  app.wxss  project.config.json
│
├── app/                                          React Native App（Expo）
│   ├── App.js                                    入口：导航栈 + Tab 栏装配
│   ├── src/
│   │   ├── screens/                              20 个页面
│   │   ├── components/                           通用组件（导航栏、Tab 图标、登录守卫…）
│   │   ├── compat/                               ★ 小程序 API 兼容层（见下）
│   │   ├── utils/                                接口封装、状态、主题、会员
│   │   └── theme.js  config.js                   ★ config.js 里的 API_BASE 决定连哪个后端
│   └── android/                                  原生工程（含签名密钥，不入库）
│
└── server-go/                                    Go 后端（线上跑的就是这个）
    ├── cmd/api/                                  进程入口
    ├── internal/                                 config / db / auth / store / shadow / wxpay / quote / api
    ├── docker-compose.yml                        api + mysql + caddy
    └── README.md                                 ★ 后端的完整文档（部署、接口、迁移、调优）
```

---

## 架构：一套业务逻辑，两端运行

这是这个仓库最值得先理解的一点。

App 不是把小程序重写了一遍，而是**复用同一套业务代码**，中间垫了一层 `app/src/compat/`：

| 文件 | 作用 |
|---|---|
| `wx.js` | 把 `wx.showToast` / `wx.request` / `wx.showLoading` 这类调用桥到 RN 实现 |
| `page.js` | 模拟小程序的 `Page({ data, setData })` 生命周期 |
| `nav.js` | `wx.navigateTo` 之类的跳转 → React Navigation |
| `storage.js` | `wx.getStorageSync` → AsyncStorage |
| `ui.js` | 统一的 loading / toast / modal 宿主（对应 `components/UiHost.js`） |

所以你会看到两边的页面和 `utils/` 几乎一一对应（小程序 19 页 ↔ App 20 个 screen）。
**改业务逻辑时，两边通常要同步改** —— 这是复用的代价，也是它省下大量重复劳动的原因。

> 小程序目前已冻结（不再迭代），代码保留在仓库里；App 是当前主推的端。

---

## 快速开始

### App

```bash
cd app
npm install
npm run android          # expo run:android，调试包
npm run android:release  # 正式包（需要 android/app/release.keystore）
```

技术栈：**Expo 53 · React Native 0.79.5 · React 19**（导航用 `@react-navigation`，无 Redux，状态在 `src/utils/store.js`）。

连哪个后端由 `app/src/config.js` 的 `API_BASE` 决定，改完要重新打包：

```js
const API_BASE = 'http://shouxilao.cosiw.cn'   // 改这里
```

### 后端

```bash
cd server-go
cp .env.example .env      # 至少填数据库连接与 CRON_TOKEN
go mod tidy
go run ./cmd/api
curl http://127.0.0.1:8080/api/health
```

**建库建表不用手工执行 SQL** —— 服务启动时自己会做（`schema.sql` 已内嵌进二进制）。

部署、接口清单、数据迁移、容量调优等都在 **[`server-go/README.md`](server-go/README.md)**，那里写得比我这里细。

### 小程序

用微信开发者工具打开仓库根目录（`project.config.json` 在这里）。业务代码在 `pages/` + `utils/`，`app.js` 负责启动时的云端对齐。

---

## 会员与支付

会员档位只有 `free` / `lite` / `pro`，有效期就是 `expires_at` 一个日期（**没有「永久」字段**，「永久」= 一个很远的到期日）。

### 一个总闸控制两件事

`app/src/utils/membership.js`：

```js
const FREE_FOR_ALL = false
```

它同时管**卖不卖**和**限不限**，两者是刻意联动的：

- `true`（免费开放期）→ 购买与兑换码入口隐藏，所有人不受档位限制
- `false`（当前）→ 入口出现，免费用户按档位受限（A股/ETF 限 6 只、不支持港股美股、多账户限 1 个…）

只开入口不恢复限制，用户会看到「卖的是我现在本来就免费在用的功能」，那比不卖更伤信任 —— 所以这两件事必须一起翻。

### 三条收款路径的现状

| 通道 | 状态 | 门槛 |
|---|---|---|
| **兑换码** | ✅ 可用 | 零门槛，第三方平台卖码 → 用户在 App 里兑换 |
| 微信支付（App 支付） | ⛔ 未启用 | 需营业执照开商户号 + 公网 HTTPS 回调 |
| Apple 内购 | ⛔ 未做 | 上架 iOS 时虚拟商品必须走这条 |

**微信支付的 6 个 `WXPAY_*` 变量当前一个都没配**，所以 `POST /api/membership/appay/prepay` 会回 `{ ok: false, notReady: true }`，前端据此引导用户去兑换码 —— 这是设计好的降级路径，不是故障。

配齐环境变量后重启容器即可启用，**代码一行都不用改**（`/api/health` 里能直接看到 `wxpay.ready` 的状态）。

生成兑换码：

```bash
curl -X POST "$API/api/admin/codes" \
  -H "X-Cron-Token: $CRON_TOKEN" -H 'Content-Type: application/json' \
  -d '{"tier":"pro","months":12,"count":100,"note":"首批"}'
```

> ⚠️ **每次发码前查一遍 `status=unused`**，不要照最初生成的那份列表发 —— 已发出去的码不会从里面消失，照它发迟早会把同一个码发给两个人。

---

## 仓库约定

### 这些不进版本库

构建产物（`build/`、`.gradle/`、`.cxx/`、`dist/`）、依赖（`node_modules/`）、日志、APK、以及**所有密钥**，都已在 `.gitignore` 中忽略 —— 判据是「能不能由源码重新生成」。

### 🔑 两个绝对不能提交的文件

| 文件 | 后果 |
|---|---|
| `app/android/app/release.keystore` | **泄漏** → 任何人都能签出与你同签名的包；**丢失** → 已上架的 App 再也无法更新。请单独备份 |
| `server-go/.env` | 含数据库密码、`CRON_TOKEN`、微信支付密钥 |

两者都已被 `.gitignore` 忽略，但它们**只存在于本机**，换机器时要单独带过去。

---

## 相关文档

- **[`server-go/README.md`](server-go/README.md)** —— 后端全部细节：目录分层、接口契约、微信支付签名要点、行情代理设计、容量与限流、数据迁移
- `server-go/.env.example` —— 每个环境变量都有说明
- `server-go/migrate.sql` —— 旧库迁移，每处取舍都写了原因

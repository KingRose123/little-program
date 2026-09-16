/**
 * 构建标记 —— 用来确认「线上到底跑的是哪一份代码」。
 *
 * 排查「我明明改了代码，怎么没生效」这类问题时，先看这里：
 *   启动日志： [xiji-api] build=xxx listening on 80
 *   健康检查： GET /api/health 里的 build 字段
 *
 * 每次改了服务端要发布的东西，就把它改一下（加日期或序号都行）。
 */
module.exports = '2026-09-16-phone'

/**
 * App 端配置。
 *
 * API_BASE 指向自建后端（Go，见 server-go/），已与微信云托管解耦。
 *
 * ⚠️ 目前走 HTTP，因此 AndroidManifest 里必须开着明文流量
 *    （android:usesCleartextTraffic="true"）—— Android 9 起默认禁止，
 *    release 包不开的话是「连不上」，而不是一个能看出原因的报错。
 *
 *    三处代价都是延后的：微信支付回调必须是 HTTPS（现阶段只能走兑换码）、
 *    部分运营商会对 HTTP 注入广告、应用商店上架要求 HTTPS。
 *    证书配好后把这里改回 https，并去掉 manifest 里那一行即可。
 *
 * 另：无论 HTTP 还是 HTTPS，国内节点都要求域名完成 ICP 备案 ——
 *    未备案域名访问 80/443 会被云厂商直接拦截，这与用哪种协议无关。
 */
const API_BASE = 'http://shouxilao.cosiw.cn'

// 请求默认超时：和云托管那份保持一致
const DEFAULT_TIMEOUT = 10000

// 快照整份上传的超时（数据大的用户会慢一些）
const UPLOAD_TIMEOUT = 15000

module.exports = {
  API_BASE,
  DEFAULT_TIMEOUT,
  UPLOAD_TIMEOUT
}

function money(n, d) {
  d = d === undefined ? 2 : d
  if (n === null || n === undefined || n === '') return '0.00'
  return Number(n).toFixed(d)
}

// 千分位
function group(n, d) {
  d = d === undefined ? 2 : d
  const s = money(n, d).split('.')
  s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return s.join('.')
}

// 万为单位，去掉多余的 0
function wan(n, d) {
  d = d === undefined ? 2 : d
  const v = Number(n) / 10000
  let s = v.toFixed(d)
  if (s.indexOf('.') > -1) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s + '万'
}

function pad(n) {
  return n < 10 ? '0' + n : '' + n
}

/**
 * 金额自适应展示：绝对值 ≥ 1 万时用「数字 + 万」，否则用千分位完整数字
 * 例：106600 -> 10.66万 ；5830 -> 5,830.00 ；100000 -> 10万
 */
function amount(n, threshold) {
  const t = threshold === undefined ? 10000 : threshold
  if (n === null || n === undefined || n === '') return '0.00'
  if (Math.abs(Number(n)) >= t) return wan(n, 2)
  return group(n, 2)
}

function percent(n, d) {
  d = d === undefined ? 2 : d
  return money(n, d) + '%'
}

// 200股 -> 200股 / 10000股 -> 1万股
function shares(n) {
  if (n >= 10000) return wan(n, 2).replace('万', '万股')
  return n + '股'
}

/* ---------------- 交互态工具：统一 loading / 防重复提交 / 错误兜底 ---------------- */

/**
 * 会员门禁提示：弹一句说明，主按钮直接带去会员中心。
 * 门禁统一在 api 层用 code 402 抛出（见 utils/membership.js），
 * 所以任何页面只要走到 util.onError 就能自动获得这个引导。
 */
function paywall(msg) {
  wx.showModal({
    title: '需要会员权限',
    content: msg || '该功能需要会员权限。',
    confirmText: '去看看',
    cancelText: '暂不',
    success: (res) => {
      if (res.confirm) wx.navigateTo({ url: '/pages/membership/membership' })
    }
  })
}

// 统一异常提示
function onError(e) {
  wx.hideLoading()

  // 402 = 需要会员：不只是提示，直接把用户带到会员中心
  if (e && e.code === 402) {
    paywall(e.msg)
    return
  }

  const msg = (e && (e.msg || e.errMsg)) || '网络异常，请稍后重试'
  wx.showToast({ title: msg, icon: 'none' })
}

// 取锁：已在提交中则返回 false
function lock(page, key) {
  const k = key || 'submitting'
  if (page.data[k]) return false
  const patch = {}
  patch[k] = true
  page.setData(patch)
  return true
}

// 放锁
function unlock(page, key) {
  const k = key || 'submitting'
  const patch = {}
  patch[k] = false
  page.setData(patch)
}

// 带 loading 的异步执行封装：自动 showLoading / hideLoading / 异常兜底 / 释放锁
// 用法：util.submit(this, api.savePlan(plan), { success: '已保存' })
function submit(page, promise, options) {
  const opt = options || {}
  const key = opt.key || 'submitting'
  if (!lock(page, key)) return Promise.resolve(null)

  if (opt.loading !== false) wx.showLoading({ title: opt.loadingText || '处理中', mask: true })

  return promise
    .then((res) => {
      wx.hideLoading()
      unlock(page, key)
      if (opt.success) wx.showToast({ title: opt.success, icon: 'success' })
      return res
    })
    .catch((e) => {
      unlock(page, key)
      onError(e)
      return null
    })
}

// 只读请求：带 loading，不做防重复锁
function fetch(promise, loadingText) {
  wx.showLoading({ title: loadingText || '加载中', mask: true })
  return promise
    .then((res) => {
      wx.hideLoading()
      return res
    })
    .catch((e) => {
      onError(e)
      return null
    })
}

/* ---------------- 返回上一页 ---------------- */

// 返回上一页；若本页就是栈底（如开发者工具指定了编译入口），兜底回首页
function back(fallbackUrl) {
  const pages = getCurrentPages()
  if (pages.length > 1) {
    wx.navigateBack({ delta: 1 })
    return
  }
  wx.switchTab({ url: fallbackUrl || '/pages/holdings/holdings' })
}

// 延时返回，让成功提示先被看到；页面 onUnload 时应调用 cancelBack 取消
function backLater(page, delay) {
  cancelBack(page)
  page.backTimer = setTimeout(() => {
    page.backTimer = null
    back()
  }, delay === undefined ? 600 : delay)
}

function cancelBack(page) {
  if (page.backTimer) {
    clearTimeout(page.backTimer)
    page.backTimer = null
  }
}

module.exports = {
  money,
  group,
  wan,
  amount,
  pad,
  percent,
  shares,
  paywall,
  onError,
  lock,
  unlock,
  submit,
  fetch,
  back,
  backLater,
  cancelBack
}

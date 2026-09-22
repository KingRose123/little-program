/**
 * wx.showToast / showLoading / showModal 的宿主无关实现。
 *
 * 业务逻辑里这些调用是「发出去就不管」的（41 处 showToast、24 处 showModal），
 * 所以这里做成「事件 + 订阅」：兼容层只负责 emit，真正的 UI 由 <UiHost/> 渲染。
 * 好处是 utils/ 那一整套逻辑（util.submit / util.onError…）完全不用知道 React 存在，
 * 也能在 Node 里直接跑测试。
 */

let state = {
  toast: null, // { id, title, icon, duration }
  loading: null, // { title }
  modal: null // { id, title, content, confirmText, cancelText, editable, placeholderText, resolve }
}

const listeners = new Set()
let seq = 0

function getState() {
  return state
}

function subscribe(fn) {
  listeners.add(fn)
  fn(state)
  return () => listeners.delete(fn)
}

function emit(patch) {
  state = Object.assign({}, state, patch)
  listeners.forEach((fn) => {
    try {
      fn(state)
    } catch (e) {
      console.warn('[ui] 渲染回调出错', e && e.message)
    }
  })
}

/* ---------------- Toast ---------------- */

function toast(opts) {
  const o = typeof opts === 'string' ? { title: opts } : opts || {}
  const id = ++seq
  emit({ toast: { id: id, title: String(o.title || ''), icon: o.icon || 'none', duration: o.duration || 1500 } })

  // 自动消失；期间又来了新 toast 就由新的接管（id 不同即视为已过期）
  setTimeout(() => {
    if (state.toast && state.toast.id === id) emit({ toast: null })
  }, o.duration || 1500)
}

/* ---------------- Loading ---------------- */

function loading(title) {
  emit({ loading: { title: String(title || '加载中') } })
}

function hideLoading() {
  if (state.loading) emit({ loading: null })
}

/* ---------------- Modal ---------------- */

/**
 * 支持 wx.showModal 的两种用法：success 回调 和 await 返回值。
 *
 * editable 时多一个输入框，三个配套参数：
 *   placeholderText 提示语；
 *   maxLength       字数上限（默认 50，兑换码那种短输入用得上）；
 *   multiline       多行。写心得体悟这类长文本必须开，单行框只能看见一行，
 *                   写的人不知道自己写了多少；
 *   initialContent  预填值（编辑已有心得时用）。
 *
 * 注意 success 回调拿到的 content 是**用户实际输入的原文**；文字净化
 * 由渲染层（UiHost）按 maxLength 做，业务侧不必再截一次。
 */
function modal(opts) {
  const o = opts || {}
  const id = ++seq

  return new Promise((resolve) => {
    emit({
      modal: {
        id: id,
        title: String(o.title || '提示'),
        content: String(o.content || ''),
        confirmText: String(o.confirmText || '确定'),
        cancelText: o.showCancel === false ? '' : String(o.cancelText || '取消'),
        editable: !!o.editable,
        multiline: !!o.multiline,
        maxLength: Number(o.maxLength) > 0 ? Number(o.maxLength) : 50,
        initialContent: String(o.initialContent || ''),
        placeholderText: String(o.placeholderText || ''),
        resolve: (result) => {
          emit({ modal: null })
          if (typeof o.success === 'function') o.success(result)
          resolve(result)
        }
      }
    })
  })
}

/** 关闭当前 modal（组件卸载等场景，避免它一直挂着）*/
function closeModal() {
  if (state.modal) {
    const m = state.modal
    emit({ modal: null })
    if (m.resolve) m.resolve({ confirm: false, cancel: true })
  }
}

module.exports = {
  getState,
  subscribe,
  toast,
  loading,
  hideLoading,
  modal,
  closeModal
}

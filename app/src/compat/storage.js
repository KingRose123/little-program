/**
 * 同步读写的存储层。
 *
 * 为什么要有这一层：
 *   小程序那边 wx.getStorageSync 是**同步**的，而 React Native 的 AsyncStorage
 *   是异步的。store.js / membership.js / api.js 里有 30 多处同步读取
 *   （比如 getProfile 是同步函数），全改成异步会把上百个调用点一起搅乱。
 *   所以这里启动时把整份数据读进内存，之后：同步读内存、异步落磁盘。
 *
 * 退出前调用 flush() 保证最后一次写入落盘（App 切后台时也调一次）。
 *
 * 纯 JS 环境（Node 里跑测试）没有 AsyncStorage，自动退化成纯内存 ——
 * 这样同一份业务逻辑可以在 Node 里直接验证，不用起模拟器。
 */

const PREFIX = 'xiji:'

let backend = null
try {
  // 只在 React Native 里能解析到；Node 下会抛错，下面兜住
  backend = require('@react-native-async-storage/async-storage').default
} catch (e) {
  backend = null
}

const cache = new Map()
let loaded = false

function hasAsync() {
  return !!(backend && typeof backend.multiGet === 'function')
}

// 值可能是对象 / 数组 / 数字 / 布尔，统一包一层再存，读回来还是原类型
function encode(value) {
  return JSON.stringify({ v: value === undefined ? null : value })
}

function decode(raw) {
  if (raw === null || raw === undefined) return ''
  try {
    const box = JSON.parse(raw)
    return box && Object.prototype.hasOwnProperty.call(box, 'v') ? box.v : ''
  } catch (e) {
    // 手工改坏过的数据就当没有，不要让整个 App 起不来
    return ''
  }
}

function isLoaded() {
  return loaded
}

/** 启动时调用一次；失败也不拦启动，最多是读到空数据 */
async function loadAll() {
  if (loaded) return
  if (!hasAsync()) {
    loaded = true
    return
  }

  try {
    const keys = await backend.getAllKeys()
    const mine = keys.filter((k) => k.indexOf(PREFIX) === 0)
    if (mine.length) {
      const pairs = await backend.multiGet(mine)
      pairs.forEach((pair) => {
        if (pair && pair[0]) cache.set(pair[0].slice(PREFIX.length), decode(pair[1]))
      })
    }
  } catch (e) {
    console.warn('[storage] 读取失败，按空数据启动', e && e.message)
  }

  loaded = true
}

/* ---------------- 同步读写（业务逻辑用的就是这几个）---------------- */

// 与 wx.getStorageSync 一致：没有这个键时返回空字符串，而不是 undefined
function get(key) {
  const k = String(key)
  return cache.has(k) ? cache.get(k) : ''
}

function set(key, value) {
  const k = String(key)
  cache.set(k, value === undefined ? null : value)
  persist(k)
}

function remove(key) {
  const k = String(key)
  cache.delete(k)
  if (hasAsync()) backend.removeItem(PREFIX + k).catch(() => {})
}

function clear() {
  cache.clear()
  if (hasAsync()) backend.clear().catch(() => {})
}

function persist(key) {
  if (!hasAsync()) return
  backend.setItem(PREFIX + key, encode(cache.get(key))).catch((e) => {
    console.warn('[storage] 写入失败 ' + key, e && e.message)
  })
}

/** 把内存里全部数据重新写一遍（切后台 / 退出前调用，兜住那些异步写失败的情况） */
async function flush() {
  if (!hasAsync()) return
  const pairs = []
  cache.forEach((v, k) => pairs.push([PREFIX + k, encode(v)]))
  if (!pairs.length) return
  try {
    await backend.multiSet(pairs)
  } catch (e) {
    console.warn('[storage] 落盘失败', e && e.message)
  }
}

/** 全部键值（调试用；也方便以后做「导出我的数据」） */
function dump() {
  const out = {}
  cache.forEach((v, k) => {
    out[k] = v
  })
  return out
}

module.exports = {
  PREFIX,
  isLoaded,
  loadAll,
  get,
  set,
  remove,
  clear,
  flush,
  dump,
  hasAsync
}

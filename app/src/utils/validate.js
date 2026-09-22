/**
 * 输入净化与校验。
 *
 * 为什么不能只靠 keyboardType：它只决定弹哪个软键盘，中文输入法、粘贴、
 * 外接键盘都能绕过去 —— 用户完全可能在「数量」里打出「一千」或「1,000」。
 * 所以每个输入框在 onChangeText 里先过一道净化，非法字符根本进不了 state。
 *
 * 分工：
 *   净化（以下 decimal / integer / code / plain）—— 只管「允许哪些字符」，
 *     在输入过程中执行，保证存进 state 的永远是可解析的值；
 *   校验（checkNum / checkText）—— 管「范围合不合理」（必填、>0、上限），
 *     在提交前执行，这样用户打字打到一半不会被突然清空或弹错。
 */

/* ---------------- 净化 ---------------- */

/**
 * 全角转半角，并把中文输入法下极易误输入的同形字符归一：
 * 全角数字「１２３」、中文句号「。」、各种破折号「—–−」。
 * 不做这一步的话，用户看着明明填了 100，程序解析出来却是 NaN。
 */
function halfWidth(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 65248))
    .replace(/[．。]/g, '.')
    .replace(/[－—–−]/g, '-')
}

/**
 * 数字输入净化。
 *
 * @param {string} input 原始输入
 * @param {object} [opt]
 *   opt.decimals       最多保留几位小数（默认 4；传 0 表示只允许整数）
 *   opt.allowNegative  是否允许负号（成本可以为负，数量不行）
 * @returns {string} 净化后的字符串
 *
 * 返回字符串而不是数字：用户正在输「6.」时若转成数字会变成 6，
 * 那个小数点会被吞掉，光标位置也跟着跳。
 */
function decimal(input, opt) {
  const o = opt || {}
  const maxDec = o.decimals === undefined ? 4 : Math.max(0, Number(o.decimals) || 0)
  const allowNeg = !!o.allowNegative

  let t = halfWidth(input)

  // 负号只认开头那一个，且必须允许负值
  const neg = allowNeg && t.charAt(0) === '-'

  // 去掉除数字和小数点之外的一切（含负号、逗号、字母、汉字）
  t = t.replace(/[^0-9.]/g, '')

  // 多个小数点只留第一个（「1.2.3」→「1.23」）
  const first = t.indexOf('.')
  if (first >= 0) t = t.slice(0, first + 1) + t.slice(first + 1).replace(/\./g, '')

  // 限制小数位
  const dot = t.indexOf('.')
  if (dot >= 0) {
    if (maxDec > 0) t = t.slice(0, dot + 1 + maxDec)
    else t = t.slice(0, dot)
  }

  // 「.5」补成「0.5」，既好读，也避免出现「-.5」这种半截状态
  if (t.charAt(0) === '.') t = '0' + t

  return (neg ? '-' : '') + t
}

/** 整数净化（股数、张数这类）：在 decimal 上把小数位锁成 0 */
function integer(input, opt) {
  return decimal(input, Object.assign({ decimals: 0 }, opt || {}))
}

/**
 * 代码类输入：股票代码、自定义标的代码、兑换码。
 * 只允许字母、数字，以及代码里真实存在的 . - _ （如 BRK.B、600519.SH）。
 *
 * @param {object} [opt]
 *   opt.max    最大长度（默认 20）
 *   opt.upper  是否转大写（默认是；自定义标的代码想保留小写可传 false）
 */
function code(input, opt) {
  const o = opt || {}
  const max = o.max || 20
  let t = halfWidth(input).replace(/[^0-9a-zA-Z._-]/g, '')
  if (o.upper !== false) t = t.toUpperCase()
  return t.slice(0, max)
}

/**
 * 按**码点**截断，而不是 UTF-16 码元。
 *
 * String.prototype.slice 数的是码元，一个 emoji 占两个 —— 在奇数位切断会
 * 留下一个孤立代理项，存下来就是乱码（「👨」变成「�」）。而这份文本会进快照、
 * 同步到云端、再在别的设备上显示，那个乱码会一直跟着用户。
 */
function clip(input, max) {
  const s = String(input === undefined || input === null ? '' : input)
  return Array.from(s).slice(0, max).join('')
}

/**
 * 「夹在正常字符之间、自己却看不见」的那类字符。
 *
 * 它们过得了控制字符那道网（码位都在 \u00a0 以上），但会实实在在影响显示：
 *   U+202A–U+202E  双向嵌入 / 覆盖 —— 能把后面一段的**显示顺序整个颠倒**，
 *                  看起来像乱码。这是最常被用来伪装文本的一类，必须去掉；
 *   U+200B / U+FEFF  零宽空格与 BOM —— 可以塞进内容里而不留任何痕迹；
 *   U+200E / U+200F  左右到右 / 右到左标记；
 *   U+2060–U+2064 / U+2066–U+2069  单词连接符与双向隔离符，同上；
 *   U+00AD  软连字符，不可见。
 *
 * 刻意**保留** U+200C（ZWNJ）与 U+200D（ZWJ）：前者是部分语言的连写规则，
 * 后者是组合 emoji（👨‍👩‍👧）的粘合剂 —— 一并删掉会把它们拆散。
 */
// eslint-disable-next-line no-control-regex
const INVISIBLE = /[\u00ad\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/**
 * 纯文本：去掉控制字符与不可见的格式字符，限长。
 *
 * 刻意不去空格 —— 账户名、标的名称里本来就可能有空格（如「A股 主账户」）。
 *
 * @param {object} [opt]
 *   opt.max        最大长度（默认 30）
 *   opt.multiline  保留换行（默认否）。写心得体悟那种多行框必须开 ——
 *                  否则用户分的段会被悄悄压成一整行，而且他看不出来。
 */
function plain(input, opt) {
  const o = opt || {}
  const ctrl = o.multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g
  // eslint-disable-next-line no-control-regex
  let s = String(input === undefined || input === null ? '' : input)
    .replace(ctrl, '')
    .replace(INVISIBLE, '')

  // 连着敲的空行只留一个：上限内塞满换行会把卡片撑得没边，
  // 而分段本来也只需要一个空行
  if (o.multiline) s = s.replace(/\n{3,}/g, '\n\n')

  return clip(s, o.max || 30)
}

/* ---------------- 校验（提交前用） ---------------- */

/**
 * 把输入解析成数字。空、只有符号、非法值一律返回 null。
 *
 * 关键：**不返回 0**。`Number('')` 是 0，会让「没填」被当成「填了 0」，
 * 于是「数量」留空能提交、「现价」留空被当成免费送股 —— 都是这么来的。
 */
function num(input) {
  const t = String(input === undefined || input === null ? '' : input).trim()
  if (t === '' || t === '-' || t === '.' || t === '-.') return null
  const n = Number(t)
  return isNaN(n) ? null : n
}

/**
 * 数值校验。返回错误文案，空字符串表示通过。
 *
 * @param {*} input 待校验的原始输入
 * @param {object} [rule]
 *   rule.optional  允许留空（留空视为通过，调用方自行用 0 兜底）
 *   rule.min / rule.max  闭区间上下限
 *   rule.positive  必须 > 0
 *   rule.integer   必须是整数
 * @param {string} [label] 错误文案里的字段名
 */
function checkNum(input, rule, label) {
  const r = rule || {}
  const name = label || '该字段'
  const v = num(input)

  if (v === null) return r.optional ? '' : '请填写' + name
  if (r.integer && !Number.isInteger(v)) return name + '必须是整数'
  if (r.positive && !(v > 0)) return name + '必须大于 0'
  if (r.min !== undefined && v < r.min) return name + '不能小于 ' + r.min
  if (r.max !== undefined && v > r.max) return name + '不能大于 ' + r.max
  return ''
}

/** 文本校验：必填与长度区间。返回错误文案，空字符串表示通过 */
function checkText(input, rule, label) {
  const r = rule || {}
  const name = label || '该字段'
  const v = String(input === undefined || input === null ? '' : input).trim()
  const len = Array.from(v).length

  if (!v) return r.optional ? '' : '请填写' + name
  if (r.min && len < r.min) return name + '至少 ' + r.min + ' 个字'
  if (r.max && len > r.max) return name + '最多 ' + r.max + ' 个字'
  return ''
}

module.exports = {
  halfWidth: halfWidth,
  decimal: decimal,
  integer: integer,
  code: code,
  plain: plain,
  clip: clip,
  num: num,
  checkNum: checkNum,
  checkText: checkText
}

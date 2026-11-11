// 面板各页共用的小工具：建元素、排版数字和时间、发请求、提示条、按键值对照着更新一串元素。
// 所有来自服务器的文字都用 textContent 放进页面，不拼 HTML。

export const $ = (selector, root = document) => root.querySelector(selector)

/** 建一个元素。attrs 里 class/text 特殊处理，on* 是事件，data-* / aria-* 当属性设，其余优先当属性（property）设。 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'for' || key === 'list' || key === 'form') el.setAttribute(key, value === true ? '' : String(value))
    else if (key in el) el[key] = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

// ── 时间和数字 ──

const pad = (n) => String(n).padStart(2, '0')
export const clock = (ms) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
export const clockShort = (ms) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const dateTime = (ms) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock(ms)}`
}
export const sameDay = (a, b) => {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}
/** 钟点；不是今天的带上日期。 */
export const when = (ms) => (sameDay(ms, Date.now()) ? clock(ms) : dateTime(ms))
export const dayLabel = (ms) => {
  const d = new Date(ms)
  if (sameDay(ms, Date.now())) return '今天'
  if (sameDay(ms, Date.now() - 86400000)) return '昨天'
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
export const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('zh-CN') : '–')
/** 大数写短：181204 → 181k，1234567 → 1.23M。小于一万的原样。 */
export function compact(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–'
  if (n < 10000) return String(Math.round(n))
  if (n < 1e6) return `${n < 100000 ? (n / 1000).toFixed(1) : Math.round(n / 1000)}k`
  return `${(n / 1e6).toFixed(2)}M`
}
/** 一段时间：0.4 秒、11.8 秒、2 分 05 秒、1 小时 12 分。 */
export function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '–'
  if (ms < 950) return `${Math.max(1, Math.round(ms))} 毫秒`
  const s = ms / 1000
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${pad(Math.floor(s % 60))} 秒`
  return `${Math.floor(m / 60)} 小时 ${pad(m % 60)} 分`
}
/** 从 since 到现在过了多久（会跳的那种，不带小数）。 */
export function elapsed(since, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - since) / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${pad(s % 60)} 秒`
  return `${Math.floor(m / 60)} 小时 ${pad(m % 60)} 分`
}
export const fileSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${Number((bytes / 1024 / 1024).toFixed(1))} MiB`)

// ── 游戏里的词 ──

const DIM_NAMES = { 0: '主世界', '-1': '下界', 1: '末地' }
export const dimName = (dim) => (dim === undefined || dim === null ? '未知维度' : (DIM_NAMES[dim] ?? `维度 ${dim}`))
export const pos = (p) => (p ? `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}` : '未知')
export const TASK_STATES = { running: '进行中', queued: '排队中', done: '完成', failed: '失败', canceled: '已取消' }
/** 身体的任务类型给人看的叫法；没列的原样显示。 */
const TASK_TYPES = {
  goto: '走过去',
  goto_player: '走到玩家身边',
  follow: '跟着玩家',
  home: '回家（/home）',
  flatten: '平整地面',
  clear: '清空一块地方',
  fill: '填方块',
  dig: '挖方块',
  place: '放方块',
  deposit: '存东西',
  withdraw: '取东西',
  haul: '搬运',
  collect: '捡掉落物',
  give: '递东西',
  craft: '合成',
  process: '机器加工',
  build: '照图纸盖',
  use: '使用物品',
  sleep: '睡觉',
  eat: '吃东西',
}
export const taskName = (type) => TASK_TYPES[type] ?? type ?? '任务'
/** 朝向：原版的 yaw，0 朝南（+z），90 朝西，±180 朝北，-90 朝东。 */
export function facing(yaw) {
  if (typeof yaw !== 'number') return ''
  const a = ((yaw % 360) + 360) % 360
  return ['南', '西南', '西', '西北', '北', '东北', '东', '东南'][Math.round(a / 45) % 8]
}
/** 从 (0,0) 看 (dx,dz) 在哪个方向。 */
export function bearing(dx, dz) {
  if (!dx && !dz) return ''
  // 北是 -z，东是 +x
  const a = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360
  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(a / 45) % 8]
}
/** 一天里的时刻：dayTime 0 是早上 6 点，一天 24000 刻。 */
export function gameClock(dayTime) {
  if (typeof dayTime !== 'number') return ''
  const minutes = Math.floor((((dayTime + 6000) % 24000) / 24000) * 1440)
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

// ── 提示条 ──

let toastTimer
export function toast(message, bad = false) {
  const el = $('#toast')
  el.textContent = message
  el.className = bad ? 'toast bad' : 'toast'
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 2500)
}

// ── 请求 ──

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

const listeners = new Map()
/** 很小的事件总线：登录失效、数据更新这类跨模块的通知。 */
export const bus = {
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, new Set())
    listeners.get(name).add(fn)
    return () => listeners.get(name)?.delete(fn)
  },
  emit(name, payload) {
    for (const fn of listeners.get(name) ?? []) {
      try {
        fn(payload)
      } catch (e) {
        console.error(e)
      }
    }
  },
}

export async function api(method, path, body) {
  let res
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'network', '连不上大脑进程（它可能没在运行）')
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* 没有正文 */
  }
  if (res.status === 401 && path !== '/login') {
    bus.emit('auth-lost')
    throw new ApiError(401, 'unauthorized', '登录已失效，请重新登录')
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `请求失败（${res.status}）`)
  return data
}

/** 点按钮时执行一个异步动作：期间禁用按钮，成功弹 okMessage，失败弹原因。失败返回 undefined。 */
export async function act(button, fn, okMessage) {
  if (button) button.disabled = true
  try {
    const result = await fn()
    if (okMessage) toast(okMessage)
    return result
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401)) toast(e instanceof Error ? e.message : String(e), true)
    return undefined
  } finally {
    if (button) button.disabled = false
  }
}

// ── 常用的小块 ──

export function button(text, attrs = {}, onClick) {
  const el = h('button', { type: 'button', ...attrs, text })
  if (onClick) el.addEventListener('click', (ev) => onClick(el, ev))
  return el
}

export function badge(text, tone = '') {
  return h('span', { class: tone ? `badge ${tone}` : 'badge', text })
}

export function kv(pairs) {
  return h(
    'dl',
    { class: 'kv' },
    pairs.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]),
  )
}

export function field(text, input, hint) {
  return h('div', { class: 'field' }, h('label', { for: input.id, text }), input, hint ? h('p', { class: 'hint', text: hint }) : null)
}

/** 空着的时候的说明：标题一句，下面一句怎么办。 */
export function empty(title, hint) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title', text: title }), hint ? h('p', { class: 'hint', text: hint }) : null)
}

/** 某一块没拿到数据：原因留在页面上，带一个重试。 */
export function loadError(message, retry) {
  return h('div', { class: 'empty bad' }, h('p', { class: 'empty-title', text: message }), retry ? button('重试', { class: 'small' }, retry) : null)
}

/** 进度条。ratio 0–1；null 是不知道进度（画成来回动的）。 */
export function progressBar(ratio, tone = '') {
  const bar = h('div', { class: `progress ${tone}${ratio === null ? ' unknown' : ''}`, role: 'progressbar' }, h('div'))
  if (ratio !== null) {
    bar.firstChild.style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`
    bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)))
  }
  return bar
}

/**
 * 按键值对照着更新 parent 的孩子：键和版本都没变的元素原样留着（开着的折叠、滚到的位置都不动），
 * 变了的重画，没了的拿掉，顺序照 items。render(item, old) 返回新元素（old 是这个键原来的元素，没有就是 undefined）。
 */
export function reconcile(parent, items, { key, rev, render }) {
  const old = new Map()
  for (const el of [...parent.children]) if (el.dataset.key !== undefined) old.set(el.dataset.key, el)
  let cursor = parent.firstElementChild
  for (const item of items) {
    const k = String(key(item))
    const r = String(rev(item))
    let el = old.get(k)
    old.delete(k)
    if (!el || el.dataset.rev !== r) {
      const fresh = render(item, el)
      fresh.dataset.key = k
      fresh.dataset.rev = r
      if (el) {
        if (cursor === el) cursor = el.nextElementSibling
        el.replaceWith(fresh)
      }
      el = fresh
    }
    if (el !== cursor) parent.insertBefore(el, cursor)
    else cursor = cursor.nextElementSibling
  }
  for (const el of old.values()) el.remove()
}

/** 把选中的文件读成 base64（不带 data: 前缀）。 */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve(url.slice(url.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('读不了这个文件'))
    reader.readAsDataURL(file)
  })
}

/** 一组互斥的按钮（分段选择）。options: [{ value, label, title? }]；返回 { el, set(value) }。 */
export function segmented(options, value, onChange, label) {
  const el = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label })
  const buttons = options.map((opt) => {
    const b = h('button', { type: 'button', role: 'radio', title: opt.title, text: opt.label, 'aria-checked': String(opt.value === value) })
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-checked') === 'true') return
      set(opt.value)
      onChange(opt.value)
    })
    return b
  })
  const set = (next) => buttons.forEach((b, n) => b.setAttribute('aria-checked', String(options[n].value === next)))
  el.append(...buttons)
  return { el, set }
}

/** 页内的二级标签（知识、建造、设置里的几块）。tabs: [{ id, label, count? }]。 */
export function subTabs(tabs, current, onPick) {
  return h(
    'div',
    { class: 'subtabs', role: 'tablist' },
    tabs.map((t) => {
      const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(t.id === current), 'data-id': t.id }, t.label, t.count ? h('span', { class: 'count', text: String(t.count) }) : null)
      b.addEventListener('click', () => onPick(t.id))
      return b
    }),
  )
}

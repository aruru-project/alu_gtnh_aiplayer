// 活动日志在浏览器里的那一份：实时的（SSE /api/events）接在后面，往上翻的（/api/log?before=）接在前面。
// 同一个 id 再来一次是原地更新（模型调用结束了、程序运行的汇总变了），换掉原来那条。
// 条目怎么变成界面上的东西在 logmodel.js；这里只管拿、存、通知。

import { buildTimeline } from './logmodel.js'
import { api, bus } from './ui.js'

/** 浏览器里最多留这么多条；再多就把最早的丢掉（还能往上翻回来）。 */
const MAX_ENTRIES = 6000
const PAGE = 300

const byId = new Map()
let sorted = []
let dirty = false
let seq = 0
let timeline = { items: [], turns: new Map() }
let timelineSeq = -1
let stream = null
let retryTimer
let notifyQueued = false

export const logState = {
  /** connecting 正在连；live 实时更新中；retrying 断了在重连；off 没开。 */
  stream: 'off',
  /** 更早的还有没有（还没翻过时是 undefined）。 */
  more: undefined,
  /** 后端会不会往上翻（旧的后端不会）。 */
  canPage: undefined,
  loadingOlder: false,
  /** 最近一次往上翻没成的原因。 */
  olderError: null,
}

function notify() {
  if (notifyQueued) return
  notifyQueued = true
  requestAnimationFrame(() => {
    notifyQueued = false
    bus.emit('log')
  })
}

function upsert(entry) {
  if (!entry || typeof entry.id !== 'number' || typeof entry.kind !== 'string') return
  entry._seq = ++seq
  if (!byId.has(entry.id)) dirty = true
  else {
    const at = sorted.findIndex((e) => e.id === entry.id)
    if (at >= 0) sorted[at] = entry
  }
  byId.set(entry.id, entry)
}

function entries() {
  if (dirty) {
    sorted = [...byId.values()].sort((a, b) => a.id - b.id)
    if (sorted.length > MAX_ENTRIES) {
      for (const e of sorted.splice(0, sorted.length - MAX_ENTRIES)) byId.delete(e.id)
      if (logState.canPage) logState.more = true
    }
    dirty = false
  }
  return sorted
}

/** 现在的时间线（条目没变就不重算）。 */
export function getTimeline() {
  if (timelineSeq !== seq) {
    timeline = buildTimeline(entries())
    timelineSeq = seq
  }
  return timeline
}

export const entryCount = () => byId.size
export const firstId = () => entries()[0]?.id
export const lastId = () => {
  const list = entries()
  return list[list.length - 1]?.id ?? 0
}

export function startLog() {
  if (stream) return
  logState.stream = 'connecting'
  stream = new EventSource(`/api/events?after=${lastId()}`)
  stream.onopen = () => {
    const wasBroken = logState.stream === 'retrying'
    logState.stream = 'live'
    bus.emit('log-stream')
    // 断过又连上：断着的那一阵里，已有的条目可能原地变过（在想的那一步回来了、程序运行的汇总更新了），
    // 重连只补新条目，所以把最近的一批重新拿一遍
    if (wasBroken) refetchTail()
  }
  stream.onmessage = (ev) => {
    try {
      upsert(JSON.parse(ev.data))
      notify()
    } catch {
      /* 忽略坏数据 */
    }
  }
  stream.onerror = () => {
    logState.stream = 'retrying'
    bus.emit('log-stream')
    if (stream && stream.readyState === EventSource.CLOSED) {
      // 浏览器放弃重连了（多半是登录失效或大脑进程重启）：过一会儿自己再连
      stopLog()
      logState.stream = 'retrying'
      clearTimeout(retryTimer)
      retryTimer = setTimeout(() => {
        api('GET', '/session').then(
          (s) => (s.authenticated ? startLog() : bus.emit('auth-lost')),
          () => startLog(),
        )
      }, 3000)
    }
  }
}

async function refetchTail() {
  try {
    const res = await api('GET', `/log?limit=${PAGE}`)
    for (const e of res.entries ?? []) upsert(e)
    notify()
  } catch {
    /* 下一次重连再说 */
  }
}

export function stopLog() {
  clearTimeout(retryTimer)
  if (stream) stream.close()
  stream = null
  logState.stream = 'off'
}

/** 往上翻一页。返回加了几条。 */
export async function loadOlder() {
  const before = firstId()
  if (logState.loadingOlder || before === undefined || logState.more === false || logState.canPage === false) return 0
  logState.loadingOlder = true
  logState.olderError = null
  bus.emit('log-stream')
  try {
    const res = await api('GET', `/log?before=${before}&limit=${PAGE}`)
    // 旧的后端不认 before：回的是最新的那些，也没有 more
    if (typeof res.more !== 'boolean') {
      logState.canPage = false
      logState.more = false
      return 0
    }
    logState.canPage = true
    logState.more = res.more
    let added = 0
    for (const e of res.entries ?? []) {
      if (e.id < before && !byId.has(e.id)) {
        upsert(e)
        added++
      }
    }
    if (added === 0) logState.more = false
    notify()
    return added
  } catch (e) {
    if (e.status !== 401) logState.olderError = e.message
    return 0
  } finally {
    logState.loadingOlder = false
    bus.emit('log-stream')
  }
}

/** 退出登录时清掉。 */
export function clearLog() {
  stopLog()
  byId.clear()
  sorted = []
  dirty = false
  seq++
  logState.more = undefined
  logState.canPage = undefined
}

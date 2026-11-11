// 面板的实时数据：定时去问大脑，整理成各页直接用的样子，变了就通知。
//   status   它现在在干什么：每条线（对话 / 干活；现在后端只有一条）各自的模型状态、例程、身体的任务。一秒一问。
//   overview 连接、服务商和模型的清单、今日用量、意见簿没看的条数、提醒、历史。四秒一问。
//   live     游戏里的它：血量位置、身上的东西、开着的界面、附近的人。“现在”页开着时两秒一问，别的页五秒；页面在后台时都不问。
// 后端的 /api/status 还没有时（404），从 /api/overview 里凑一个出来：只分得出“忙 / 闲 / 故障”，不知道第几步。

import { api, bus } from './ui.js'

export const state = {
  /** 整理过的状态：{ time, agents: [...], source: 'status' | 'overview' }；还没问到是 null。 */
  status: null,
  overview: null,
  live: null,
  /** 最近一次没问到的原因（连不上大脑进程）；问到了就清掉。 */
  error: null,
  /** 从什么时候起问不到了（大脑那边的钟）；问得到时是 null。问不到的时候页面上留着的都是断开前的样子。 */
  lostAt: null,
  /** 浏览器和大脑的钟差多少（毫秒）：算“已经几秒”时用大脑的钟。 */
  skew: 0,
}

/** 大脑那边现在几点（用来算“已经想了几秒”，不受浏览器的钟不准影响）。 */
export const serverNow = () => Date.now() + state.skew

const AGENT_LABELS = { talk: '对话', work: '干活', main: '大脑' }
const AGENT_HINTS = {
  talk: '听人说话、回话、查资料；不操作身体',
  work: '操作身体的那条线：任务和例程归它',
  main: '说话和干活现在是同一条线',
}
/** 一条线给人看的名字：后端给了 title（“对话线”“干活线”）就用它的。 */
export const agentLabel = (a) => (typeof a === 'object' && a?.title) || AGENT_LABELS[a?.agent ?? a] || a?.name || String(a?.agent ?? a)
export const agentHint = (a) => AGENT_HINTS[a?.agent ?? a] ?? ''
/** 哪条线管着身体（例程和任务挂在它下面）：带 body 的那条；都没带就是最后一条。 */
export function bodyAgent(status) {
  const agents = status?.agents ?? []
  return agents.find((a) => a.body !== undefined && a.body !== null) ?? agents[agents.length - 1]
}

function routineFromLegacy(r) {
  if (!r) return null
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    calls: r.calls ?? 0,
    tasks: r.actions ?? 0,
    errors: (r.recent ?? []).filter((c) => !c.ok).length,
    waiting: r.current ? `${r.current.tool} ${r.current.input ?? ''}`.trim() : undefined,
    waitingSince: r.current?.since,
    ending: r.ending,
    recent: r.recent ?? [],
    logs: r.logs ?? [],
  }
}

/** 没有 /api/status 的后端：从概览里凑。 */
function statusFromOverview(o) {
  const a = o.agent ?? {}
  const routine = routineFromLegacy(a.routine)
  const running = routine?.status === 'running'
  const model = { state: a.outage ? 'outage' : a.busy ? 'thinking' : 'idle', provider: o.provider?.label ?? null, model: o.provider?.modelLabel ?? null }
  if (a.outage) model.outage = a.outage
  if (a.lastCall) model.lastCall = a.lastCall
  const connected = o.bridge?.state === 'connected'
  const online = o.bot?.status?.online === true
  return {
    time: o.time,
    source: 'overview',
    agents: [
      {
        agent: 'main',
        name: o.bot?.name ?? '',
        model,
        turn: null,
        pending: a.pending ?? 0,
        routine: running ? routine : null,
        lastRoutine: running ? null : routine,
        body: {
          online,
          task: o.tasks?.active ?? null,
          queue: o.tasks?.queue ?? [],
          ...(connected ? (online ? {} : { error: o.bot?.error ?? '它不在线' }) : { error: '没连上游戏' }),
        },
      },
    ],
  }
}

function normalizeStatus(raw) {
  return {
    time: raw.time,
    source: 'status',
    agents: (raw.agents ?? []).map((a) => ({
      ...a,
      model: a.model ?? { state: 'idle' },
      turn: a.turn ?? null,
      pending: a.pending ?? 0,
    })),
  }
}

function reached() {
  const was = state.lostAt
  state.error = null
  state.lostAt = null
  if (was !== null) bus.emit('status-error', null)
}

function failed(e) {
  if (e.status === 401) return
  state.error = e.message
  if (state.lostAt === null) state.lostAt = serverNow()
  bus.emit('status-error', e.message)
}

let statusSupported = true
let timers = []
let running = false

async function pollStatus() {
  if (!running) return
  try {
    if (statusSupported) {
      try {
        const raw = await api('GET', '/status')
        state.skew = typeof raw.time === 'number' ? raw.time - Date.now() : state.skew
        state.status = normalizeStatus(raw)
        reached()
        bus.emit('status', state.status)
        return
      } catch (e) {
        if (e.status !== 404) throw e
        // 这个后端还没有 /api/status：以后都从概览里凑
        statusSupported = false
      }
    }
    if (state.overview) {
      state.status = statusFromOverview(state.overview)
      bus.emit('status', state.status)
    }
  } catch (e) {
    failed(e)
  }
}

async function pollOverview() {
  if (!running) return
  try {
    const o = await api('GET', '/overview')
    state.overview = o
    if (!statusSupported || state.status === null) {
      state.skew = typeof o.time === 'number' ? o.time - Date.now() : state.skew
    }
    reached()
    bus.emit('overview', o)
    if (!statusSupported) {
      state.status = statusFromOverview(o)
      bus.emit('status', state.status)
    }
  } catch (e) {
    failed(e)
  }
}

async function pollLive() {
  if (!running || document.hidden) return
  lastLiveAt = Date.now()
  try {
    state.live = await api('GET', '/live')
    bus.emit('live', state.live)
  } catch (e) {
    if (e.status === 401) return
    bus.emit('live-error', e.message)
  }
}

/** 做了会改状态的事以后马上再问一遍，不等下一个钟点。 */
export async function refresh() {
  await Promise.all([pollOverview(), pollLive()])
  await pollStatus()
}

/** “现在”页开着时游戏里的样子两秒问一次；别的页只有状态区的血量位置要用，五秒一次就够（每问一次都要去问身体）。 */
let liveEveryMs = 5000
let lastLiveAt = 0

export function watchLiveClosely(on) {
  liveEveryMs = on ? 2000 : 5000
  if (on && running) pollLive()
}

export function startPolling() {
  if (running) return
  running = true
  refresh()
  timers = [
    setInterval(() => !document.hidden && pollStatus(), 1000),
    setInterval(() => !document.hidden && pollOverview(), 4000),
    setInterval(() => Date.now() - lastLiveAt >= liveEveryMs - 100 && pollLive(), 1000),
  ]
}

export function stopPolling() {
  running = false
  for (const t of timers) clearInterval(t)
  timers = []
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && running) refresh()
})

// ── 插手：停例程、取消任务、全部停下、上线下线、换模型 ──

export const actions = {
  stopRoutine: () => api('POST', '/routine/stop', {}),
  cancelTask: (id) => api('POST', '/tasks/cancel', id ? { id } : {}),
  /**
   * 全部停下：打断干活线正在想的那一步，停掉例程，取消身体正在做的和排着队的任务。
   * 返回 { turn, routine, tasks }：打断了一轮没有、停了哪个例程、取消了几个任务。
   * 还没有总停止接口的后端（404）：分别停例程、取消任务（打断不了正在想的那一步）。
   */
  async stopAll() {
    try {
      const res = await api('POST', '/work/stop', { reason: '主人在面板上点了“全部停下”' })
      return { turn: res.turn === true, routine: res.routine || null, tasks: res.tasks ?? 0, whole: true }
    } catch (e) {
      if (e.status !== 404) throw e
    }
    const routine = await api('POST', '/routine/stop', {})
    const tasks = await api('POST', '/tasks/cancel', {})
    return { turn: false, routine: routine?.stopped === true ? '例程' : null, tasks: tasks?.canceled ?? 0, whole: false }
  },
  spawn: () => api('POST', '/bot/spawn', {}),
  despawn: () => api('POST', '/bot/despawn', {}),
  /** 换某条线用的模型：line 是 talk 或 work；不带是全部一起换（只有一条线的后端也是这样）。 */
  useModel: (agent, providerId, modelId) => api('POST', '/models/use', { providerId, modelId, ...(agent === 'talk' || agent === 'work' ? { line: agent } : {}) }),
  command: (text) => api('POST', '/command', { text }),
}

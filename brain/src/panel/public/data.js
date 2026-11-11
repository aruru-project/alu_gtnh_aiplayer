// 面板的实时数据：定时去问大脑，整理成各页直接用的样子，变了就通知。
//   status   它现在在干什么：每条线（对话 / 干活；现在后端只有一条）各自的模型状态、例程、身体的任务。一秒一问。
//   overview 连接、服务商和模型的清单、今日用量、意见簿没看的条数、提醒、历史。三秒一问。
//   live     游戏里的它：血量位置、身上的东西、开着的界面、附近的人。两秒一问（页面在后台时不问）。
// 后端的 /api/status 还没有时（404），从 /api/overview 里凑一个出来：只分得出“忙 / 闲 / 故障”，不知道第几步。

import { api, bus } from './ui.js'

export const state = {
  /** 整理过的状态：{ time, agents: [...], source: 'status' | 'overview' }；还没问到是 null。 */
  status: null,
  overview: null,
  live: null,
  /** 最近一次没问到的原因（连不上大脑进程）；问到了就清掉。 */
  error: null,
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
/** 一条线给人看的名字。 */
export const agentLabel = (a) => AGENT_LABELS[a?.agent ?? a] ?? a?.name ?? String(a?.agent ?? a)
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
        state.error = null
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
    if (e.status === 401) return
    state.error = e.message
    bus.emit('status-error', e.message)
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
    state.error = null
    bus.emit('overview', o)
    if (!statusSupported) {
      state.status = statusFromOverview(o)
      bus.emit('status', state.status)
    }
  } catch (e) {
    if (e.status === 401) return
    state.error = e.message
    bus.emit('status-error', e.message)
  }
}

async function pollLive() {
  if (!running || document.hidden) return
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

export function startPolling() {
  if (running) return
  running = true
  refresh()
  timers = [
    setInterval(() => !document.hidden && pollStatus(), 1000),
    setInterval(() => !document.hidden && pollOverview(), 3000),
    setInterval(pollLive, 2000),
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
  /** 全部停下：停掉例程，取消身体正在做的和排着队的任务。 */
  async stopAll() {
    const routine = await api('POST', '/routine/stop', {})
    const tasks = await api('POST', '/tasks/cancel', {})
    return { routineStopped: routine?.stopped === true, canceled: tasks?.canceled ?? 0 }
  },
  spawn: () => api('POST', '/bot/spawn', {}),
  despawn: () => api('POST', '/bot/despawn', {}),
  /** 换某条线用的模型。现在的后端只有一个“当前模型”，agent 先带着，后端分了线以后用得上。 */
  useModel: (agent, providerId, modelId) => api('POST', '/models/use', { agent, providerId, modelId }),
  command: (text) => api('POST', '/command', { text }),
}

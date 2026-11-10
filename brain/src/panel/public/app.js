// 面板前端。手写的原生 JS，没有框架和构建步骤。
// 所有来自服务器的文字都用 textContent 放进页面，不拼 HTML。

// ── 小工具 ──

const $ = (selector, root = document) => root.querySelector(selector)

/** 建一个元素。attrs 里 class/text 特殊处理，on* 是事件，其余优先当属性（property）设。 */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') el.className = value
    else if (key === 'text') el.textContent = value
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
    else if (key in el && key !== 'list' && key !== 'form') el[key] = value
    else el.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

const pad = (n) => String(n).padStart(2, '0')
const clock = (ms) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
const dateTime = (ms) => {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock(ms)}`
}
const num = (n) => (typeof n === 'number' ? n.toLocaleString('zh-CN') : '–')
// 页面只在数据变化时重画，“几秒前”这种相对时间会过期，所以一律显示钟点；不是今天的带上日期。
const when = (ms) => {
  const d = new Date(ms)
  const now = new Date()
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? clock(ms) : dateTime(ms)
}

let toastTimer
function toast(message, bad = false) {
  const el = $('#toast')
  el.textContent = message
  el.className = bad ? 'toast bad' : 'toast'
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 2500)
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function api(method, path, body) {
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
    showLogin()
    throw new ApiError(401, 'unauthorized', '登录已失效，请重新登录')
  }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? `请求失败（${res.status}）`)
  return data
}

/** 点按钮时执行一个异步动作：期间禁用按钮，失败弹提示。 */
async function act(button, fn, okMessage) {
  if (button) button.disabled = true
  try {
    const result = await fn()
    if (okMessage) toast(okMessage)
    return result
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true)
    return undefined
  } finally {
    if (button) button.disabled = false
  }
}

const DIM_NAMES = { 0: '主世界', '-1': '下界', 1: '末地' }
const dimName = (dim) => (dim === undefined || dim === null ? '未知维度' : (DIM_NAMES[dim] ?? `维度 ${dim}`))
const TASK_STATES = { running: '进行中', queued: '排队中', done: '完成', failed: '失败', canceled: '已取消' }
const pos = (p) => (p ? `${Math.floor(p.x)}, ${Math.floor(p.y)}, ${Math.floor(p.z)}` : '未知')

function mergeItems(items) {
  const map = new Map()
  for (const it of items ?? []) {
    if (!it || !it.id) continue
    const key = it.meta ? `${it.id}/${it.meta}` : it.id
    const entry = map.get(key) ?? { key, name: it.name, count: 0 }
    entry.count += it.count ?? 1
    map.set(key, entry)
  }
  return [...map.values()].sort((a, b) => b.count - a.count)
}

// ── 登录 ──

function showLogin() {
  stopStream()
  $('#app').hidden = true
  $('#login').hidden = false
  $('#login-password').focus()
}

function showApp() {
  $('#login').hidden = true
  $('#app').hidden = false
  showTab(location.hash.slice(1) in TABS ? location.hash.slice(1) : 'overview')
  refreshOverview()
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault()
  const error = $('#login-error')
  error.hidden = true
  try {
    await api('POST', '/login', { password: $('#login-password').value })
    $('#login-password').value = ''
    showApp()
  } catch (e) {
    error.textContent = e.message
    error.hidden = false
  }
})

$('#logout').addEventListener('click', async () => {
  await act(null, () => api('POST', '/logout', {}))
  showLogin()
})

// ── 标签页 ──

let currentTab = 'overview'

function showTab(name) {
  currentTab = name
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name))
  }
  for (const key of Object.keys(TABS)) $(`#tab-${key}`).hidden = key !== name
  history.replaceState(null, '', `#${name}`)
  TABS[name].enter()
}

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => showTab(button.dataset.tab))
}

// 地址栏里的 #名字 变了（前进后退、手改、点了别处的链接）也跟着切换
window.addEventListener('hashchange', () => {
  const name = location.hash.slice(1)
  if (name in TABS && name !== currentTab && !$('#app').hidden) showTab(name)
})

// ── 概览（也负责顶上的三个状态标签）──

let overview = null
let overviewKey = ''

function setBadge(id, text, tone) {
  const el = $(id)
  el.textContent = text
  el.className = tone ? `badge ${tone}` : 'badge'
}

function renderBadges(o) {
  const b = o.bridge
  if (b.state === 'connected') setBadge('#badge-bridge', '游戏：已连接', 'ok')
  else if (b.state === 'connecting') setBadge('#badge-bridge', '游戏：连接中', 'warn')
  else if (b.state === 'unconfigured') setBadge('#badge-bridge', '游戏：还没配置', 'bad')
  else setBadge('#badge-bridge', '游戏：未连接', 'bad')

  const st = o.bot.status
  if (st?.online) setBadge('#badge-bot', `${o.bot.name}：在线`, 'ok')
  else if (b.state === 'connected') setBadge('#badge-bot', `${o.bot.name}：不在线`, 'warn')
  else setBadge('#badge-bot', `${o.bot.name}：未知`, '')

  const a = o.agent
  if (!o.provider) setBadge('#badge-agent', '大脑：没配模型', 'bad')
  else if (a.outage) setBadge('#badge-agent', '大脑：模型接口故障', 'bad')
  else if (a.busy) setBadge('#badge-agent', '大脑：思考中', 'warn')
  else setBadge('#badge-agent', '大脑：空闲', 'ok')
}

function kv(pairs) {
  return h(
    'dl',
    { class: 'kv' },
    pairs.filter(Boolean).map(([k, v]) => [h('dt', { text: k }), h('dd', null, v)]),
  )
}

function taskLine(task) {
  const p = task.progress
  const progress = p && typeof p.done === 'number' && typeof p.total === 'number' ? ` ${p.done}/${p.total}` : ''
  const phase = p?.phase ? ` ${p.phase}` : ''
  return `${task.id} ${task.type}${progress}${phase}`
}

function renderOverview(o) {
  const root = $('#tab-overview')
  const b = o.bridge
  const st = o.bot.status
  const connected = b.state === 'connected'

  // 连接
  const bridgeCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '游戏连接（bridge）' }),
    b.state === 'unconfigured'
      ? h('p', { class: 'error' }, '还没配置 bridge 口令文件，所以没有去连游戏。到“设置”页填上口令文件的路径。')
      : null,
    kv([
      ['状态', connected ? '已连接' : b.state === 'connecting' ? '连接中' : b.state === 'unconfigured' ? '没有连接（还没配置）' : '未连接，自动重连中'],
      ['地址', b.address || '–'],
      connected && b.hello ? ['身体版本', `mod ${b.hello.modVersion ?? '?'} / MC ${b.hello.mcVersion ?? '?'} / 协议 ${b.hello.protocol}`] : null,
      connected && b.connectedAt ? ['连上于', when(b.connectedAt)] : null,
      !connected && b.lastError ? ['原因', h('span', { class: 'error', text: b.lastError })] : null,
      o.server ? ['服务器', `TPS ${o.server.tps ?? '?'}，${o.server.isDay === false ? '夜晚' : '白天'}${o.server.raining ? '，下雨' : ''}`] : null,
      o.server ? ['在线玩家', (o.server.players ?? []).map((p) => (p.isBot ? `${p.name}（bot）` : p.name)).join('、') || '没有人'] : null,
    ]),
  )

  // bot
  const spawnBtn = h('button', { type: 'button', class: 'small', text: '上线', disabled: !connected || st?.online === true })
  spawnBtn.addEventListener('click', () => act(spawnBtn, () => api('POST', '/bot/spawn', {}), '已让它上线').then(refreshOverview))
  const despawnBtn = h('button', { type: 'button', class: 'small', text: '下线', disabled: !connected || !st?.online })
  despawnBtn.addEventListener('click', () => act(despawnBtn, () => api('POST', '/bot/despawn', {}), '已让它下线').then(refreshOverview))
  const botCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, h('h2', { text: `AI 玩家：${o.bot.name}` }), h('span', { class: 'spacer' }), spawnBtn, despawnBtn),
    !connected
      ? h('p', { class: 'muted', text: '没连上游戏，不知道它的状态。' })
      : st?.online
        ? kv([
            ['位置', `${pos(st.block ?? st.pos)}（${dimName(st.dim)}）`],
            ['血量', `${st.health ?? '?'} / ${st.maxHealth ?? '?'}`],
            ['饥饿', String(st.food ?? '?')],
            ['手持', st.held ? `${st.held.name ?? st.held.id}` : '空手'],
            ['设置', Object.entries(st.settings ?? {}).map(([k, v]) => `${k}=${v}`).join('，') || '–'],
          ])
        : h('p', { class: 'muted', text: o.bot.error ? `它不在线（${o.bot.error}）。` : '它不在线。点“上线”让它进入游戏。' }),
  )

  // 任务
  const tasks = o.tasks
  const cancelAll = h('button', { type: 'button', class: 'small danger', text: '全部取消', disabled: !tasks?.active && !(tasks?.queue?.length > 0) })
  cancelAll.addEventListener('click', () => act(cancelAll, () => api('POST', '/tasks/cancel', {}), '已取消').then(refreshOverview))
  const cancelOne = (id) => {
    const btn = h('button', { type: 'button', class: 'small danger', text: '取消' })
    btn.addEventListener('click', () => act(btn, () => api('POST', '/tasks/cancel', { id }), `已取消 ${id}`).then(refreshOverview))
    return btn
  }
  const active = tasks?.active
  const ratio = active?.progress && active.progress.total > 0 ? Math.min(1, active.progress.done / active.progress.total) : null
  const bar = h('div', { class: 'progress' }, h('div'))
  if (ratio !== null) bar.firstChild.style.width = `${Math.round(ratio * 100)}%`
  const taskCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, h('h2', { text: '任务' }), h('span', { class: 'spacer' }), cancelAll),
    !tasks
      ? h('p', { class: 'muted', text: '拿不到任务列表。' })
      : [
          active
            ? h('div', null, h('div', { class: 'row' }, h('span', { class: 'grow mono', text: `正在做：${taskLine(active)}` }), h('span', { class: 'spacer' }), cancelOne(active.id)), ratio !== null ? bar : null)
            : h('p', { class: 'muted', text: '现在没有在做的任务。' }),
          (tasks.queue ?? []).length > 0
            ? [h('h3', { text: `排队中（${tasks.queue.length}）` }), h('ul', { class: 'plain' }, tasks.queue.map((t) => h('li', null, h('span', { class: 'grow mono', text: taskLine(t) }), cancelOne(t.id))))]
            : null,
          (tasks.recent ?? []).length > 0
            ? [
                h('h3', { text: '最近结束' }),
                h(
                  'ul',
                  { class: 'plain' },
                  [...tasks.recent]
                    .sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0))
                    .slice(0, 6)
                    .map((t) =>
                      h(
                        'li',
                        null,
                        h('span', { class: `badge ${t.state === 'done' ? 'ok' : t.state === 'failed' ? 'bad' : ''}`, text: TASK_STATES[t.state] ?? t.state }),
                        h('span', { class: 'grow mono', text: `${t.id} ${t.type}${t.error ? ` — ${t.error.code}${t.error.message ? `：${t.error.message}` : ''}` : ''}` }),
                        t.finishedAt ? h('span', { class: 'muted', text: when(t.finishedAt) }) : null,
                      ),
                    ),
                ),
              ]
            : null,
        ],
  )

  // 背包
  const merged = mergeItems(st?.inventory)
  const invCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: `背包${st?.online ? `（空位 ${st.freeSlots ?? '?'}）` : ''}` }),
    !st?.online
      ? h('p', { class: 'muted', text: '它不在线。' })
      : merged.length === 0
        ? h('p', { class: 'muted', text: '背包是空的。' })
        : h('div', { class: 'items' }, merged.map((m) => h('span', { class: 'item', title: m.key, text: `${m.name ?? m.key} ×${m.count}` }))),
  )

  // 模型
  const a = o.agent
  const lc = a.lastCall
  const modelCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '模型' }),
    kv([
      ['当前使用', o.provider ? `${o.provider.label}（${o.provider.model}）` : h('span', { class: 'error', text: '还没配置。去“模型”页添加。' })],
      ['大脑状态', a.outage ? h('span', { class: 'error', text: `模型接口故障，已连续失败 ${a.outage.failures} 次，${when(a.outage.nextRetryAt)} 再试` }) : a.busy ? '正在思考' : '空闲'],
      a.outage ? ['失败原因', h('span', { class: 'error', text: a.outage.lastError })] : null,
      a.pending > 0 ? ['等待处理', `${a.pending} 件事`] : null,
      ['最近一次调用', !lc ? '还没调用过' : lc.ok ? `${when(lc.time)}，成功，${(lc.durationMs / 1000).toFixed(1)} 秒，输入 ${num(lc.inputTokens)} / 输出 ${num(lc.outputTokens)} token` : h('span', { class: 'error', text: `${when(lc.time)}，失败（${lc.errorKind}）：${lc.error}` })],
    ]),
  )

  // 用量
  const u = o.usage.today
  const limit = o.usage.dailyTokenLimit
  const used = u.inputTokens + u.outputTokens
  const usageCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: '今日用量' }),
    kv([
      ['调用次数', num(u.calls)],
      ['输入 token', `${num(u.inputTokens)}${u.cacheReadTokens > 0 ? `（其中 ${num(u.cacheReadTokens)} 走缓存）` : ''}`],
      ['输出 token', num(u.outputTokens)],
      ['每日上限', limit > 0 ? `${num(used)} / ${num(limit)}` : '不限'],
    ]),
  )

  // 历史和提醒
  const clearBtn = h('button', { type: 'button', class: 'small danger', text: '清空对话历史' })
  clearBtn.addEventListener('click', () => {
    if (!confirm('清空它的对话历史？记忆不受影响。清空后它不记得之前聊过什么、做到哪一步。')) return
    act(clearBtn, () => api('POST', '/history/clear', {}), '已清空').then(refreshOverview)
  })
  const miscCard = h(
    'div',
    { class: 'card' },
    h('div', { class: 'row' }, h('h2', { text: '对话历史和提醒' }), h('span', { class: 'spacer' }), clearBtn),
    kv([
      ['历史', `${o.history.turns} 轮，约 ${num(o.history.estimatedTokens)} token${o.history.hasSummary ? '，更早的已压成摘要' : ''}`],
      ['提醒', o.reminders.length === 0 ? '没有' : h('ul', { class: 'plain' }, o.reminders.map((r) => h('li', null, h('span', { class: 'grow', text: `${when(r.dueAt)}：${r.note}` }))))],
    ]),
  )

  root.replaceChildren(h('div', { class: 'grid' }, bridgeCard, botCard, taskCard, invCard, modelCard, usageCard, miscCard))
}

async function refreshOverview() {
  if ($('#app').hidden) return
  try {
    const o = await api('GET', '/overview')
    overview = o
    renderBadges(o)
    // 内容没变就不重画，免得正要点的按钮被换掉
    const key = JSON.stringify({ ...o, time: 0 })
    if (currentTab === 'overview' && key !== overviewKey) {
      overviewKey = key
      renderOverview(o)
    }
  } catch (e) {
    if (e.status !== 401) {
      setBadge('#badge-bridge', '游戏：？', '')
      setBadge('#badge-agent', '大脑：连不上', 'bad')
    }
  }
}

setInterval(() => {
  if (!document.hidden) refreshOverview()
}, 3000)

// ── 对话 ──

const KIND_LABELS = {
  chat: '聊天',
  whisper: '私聊',
  say: '它说',
  command: '面板',
  event: '事件',
  turn: '决策',
  model_text: '模型',
  tool_call: '调工具',
  tool_result: '结果',
  error: '错误',
  info: '信息',
}

let stream = null
let lastEntryId = 0
const MAX_ENTRIES = 1500

function renderEntry(e) {
  const body = h('div', { class: 'body' })
  if (e.who) body.append(h('span', { class: 'who', text: e.kind === 'tool_call' || e.kind === 'tool_result' ? e.who : `${e.who}：` }))
  body.append(document.createTextNode(e.text))
  if (e.detail) {
    body.append(h('details', null, h('summary', { text: e.kind === 'turn' ? '给模型看的内容' : '详情' }), h('pre', { text: e.detail })))
  }
  return h(
    'div',
    { class: `entry kind-${e.kind}${e.isError ? ' is-error' : ''}` },
    h('span', { class: 'time', title: dateTime(e.time), text: clock(e.time) }),
    h('span', { class: 'tag', text: KIND_LABELS[e.kind] ?? e.kind }),
    body,
  )
}

function appendEntry(e) {
  if (e.id <= lastEntryId) return
  lastEntryId = e.id
  const log = $('#chat-log')
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80
  log.append(renderEntry(e))
  while (log.childElementCount > MAX_ENTRIES) log.firstElementChild.remove()
  if (atBottom) log.scrollTop = log.scrollHeight
}

function startStream() {
  if (stream) return
  const state = $('#chat-stream-state')
  stream = new EventSource(`/api/events?after=${lastEntryId}`)
  stream.onopen = () => (state.textContent = '实时更新中')
  stream.onmessage = (ev) => {
    try {
      appendEntry(JSON.parse(ev.data))
    } catch {
      /* 忽略坏数据 */
    }
  }
  stream.onerror = () => {
    state.textContent = '实时更新断了，正在重连…'
    if (stream && stream.readyState === EventSource.CLOSED) {
      // 浏览器放弃重连了（多半是登录失效或大脑进程重启）：过一会儿自己再连
      stopStream()
      setTimeout(() => {
        if (!$('#app').hidden) api('GET', '/session').then((s) => (s.authenticated ? startStream() : showLogin()), () => startStream())
      }, 3000)
    }
  }
}

function stopStream() {
  if (stream) stream.close()
  stream = null
}

$('#chat-show-tools').addEventListener('change', (ev) => $('#chat-log').classList.toggle('hide-tools', !ev.target.checked))
$('#chat-show-events').addEventListener('change', (ev) => $('#chat-log').classList.toggle('hide-events', !ev.target.checked))

async function sendCommand() {
  const input = $('#chat-input')
  const text = input.value.trim()
  if (!text) return
  const button = $('#chat-form button')
  const ok = await act(button, () => api('POST', '/command', { text }))
  if (ok) {
    input.value = ''
    const log = $('#chat-log')
    log.scrollTop = log.scrollHeight
  }
  input.focus()
}

$('#chat-form').addEventListener('submit', (ev) => {
  ev.preventDefault()
  sendCommand()
})
$('#chat-input').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault()
    sendCommand()
  }
})

// ── 模型 ──

let providerState = { providers: [], activeProviderId: '', adapters: [] }
let editingProvider = null // 正在编辑的服务商 id；'new' 表示新增
const testResults = new Map()

function parseJsonField(text, label) {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  let value
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new Error(`${label} 不是合法的 JSON`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象，例如 {"a": 1}`)
  return value
}

function providerForm(provider) {
  const isNew = !provider
  const adapters = providerState.adapters
  const p = provider ?? { kind: adapters[0]?.kind, label: '', baseUrl: '', model: '', options: {} }
  const form = h('form', { class: 'stack' })
  const fields = h('div', { class: 'fields' })
  const kind = h('select', { id: 'pf-kind' }, adapters.map((a) => h('option', { value: a.kind, text: a.label, selected: a.kind === p.kind })))
  const label = h('input', { id: 'pf-label', type: 'text', value: p.label ?? '', placeholder: '给自己看的名字，例如“主力”' })
  const baseUrl = h('input', { id: 'pf-url', type: 'url', value: p.baseUrl ?? '', required: true })
  const apiKey = h('input', { id: 'pf-key', type: 'password', autocomplete: 'off', placeholder: p.apiKeySet ? `已设置（${p.apiKeyMasked}），留空表示不修改` : '还没设置' })
  const model = h('input', { id: 'pf-model', type: 'text', value: p.model ?? '', required: true, placeholder: '模型名，照服务商文档填' })
  const maxOut = h('input', { id: 'pf-max', type: 'number', min: 1, value: p.maxOutputTokens ?? '', placeholder: '留空用接口默认值' })
  const temp = h('input', { id: 'pf-temp', type: 'number', min: 0, max: 2, step: 0.1, value: p.temperature ?? '', placeholder: '留空用接口默认值' })
  const timeout = h('input', { id: 'pf-timeout', type: 'number', min: 1, value: p.timeoutMs ? Math.round(p.timeoutMs / 1000) : '', placeholder: '默认 120' })
  const headers = h('textarea', { id: 'pf-headers', class: 'mono', rows: 2, placeholder: '{"anthropic-beta": "…"}', value: p.extraHeaders ? JSON.stringify(p.extraHeaders, null, 2) : '' })
  const extraBody = h('textarea', { id: 'pf-body', class: 'mono', rows: 3, placeholder: '{"reasoning_effort": "low"}', value: p.extraBody ? JSON.stringify(p.extraBody, null, 2) : '' })
  const optionsBox = h('div', { class: 'fields field-wide' })
  const optionInputs = new Map()

  const renderOptions = () => {
    const adapter = adapters.find((a) => a.kind === kind.value)
    baseUrl.placeholder = adapter ? `例如 ${adapter.baseUrlExample}` : ''
    optionInputs.clear()
    optionsBox.replaceChildren(
      ...(adapter?.options ?? []).map((opt) => {
        const current = kind.value === p.kind && p.options && opt.key in p.options ? p.options[opt.key] : opt.default
        if (opt.type === 'boolean') {
          const input = h('input', { type: 'checkbox', checked: current === true })
          optionInputs.set(opt.key, () => input.checked)
          return h('div', null, h('label', { class: 'check' }, input, ` ${opt.key}`), h('p', { class: 'hint', text: opt.description }))
        }
        const input = h('select', null, (opt.values ?? []).map((v) => h('option', { value: v, text: v, selected: v === current })))
        optionInputs.set(opt.key, () => input.value)
        return h('div', null, h('label', { text: opt.key }), input, h('p', { class: 'hint', text: opt.description }))
      }),
    )
  }
  kind.addEventListener('change', renderOptions)
  renderOptions()

  const collect = () => {
    const out = {
      kind: kind.value,
      label: label.value.trim(),
      baseUrl: baseUrl.value.trim(),
      apiKey: apiKey.value, // 留空 = 不修改
      model: model.value.trim(),
      options: Object.fromEntries([...optionInputs.entries()].map(([key, read]) => [key, read()])),
    }
    if (maxOut.value !== '') out.maxOutputTokens = Number(maxOut.value)
    if (temp.value !== '') out.temperature = Number(temp.value)
    if (timeout.value !== '') out.timeoutMs = Number(timeout.value) * 1000
    const eh = parseJsonField(headers.value, '额外请求头')
    if (eh) out.extraHeaders = eh
    const eb = parseJsonField(extraBody.value, '额外请求参数')
    if (eb) out.extraBody = eb
    return out
  }

  const result = h('div')
  const testBtn = h('button', { type: 'button', text: '测试连接' })
  testBtn.addEventListener('click', async () => {
    result.replaceChildren(h('p', { class: 'muted', text: '正在测试…' }))
    const res = await act(testBtn, () => api('POST', '/providers/test', { ...collect(), ...(isNew ? {} : { id: provider.id }) }))
    result.replaceChildren(res ? testResultBox(res) : '')
  })
  const saveBtn = h('button', { type: 'submit', class: 'primary', text: isNew ? '添加' : '保存' })
  const cancelBtn = h('button', { type: 'button', text: '取消' })
  cancelBtn.addEventListener('click', () => {
    editingProvider = null
    renderProviders()
  })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(saveBtn, () => (isNew ? api('POST', '/providers', collect()) : api('PUT', `/providers/${provider.id}`, collect())), '已保存')
    if (saved) {
      providerState = saved
      editingProvider = null
      renderProviders()
      refreshOverview()
    }
  })

  const field = (text, input, hint) => h('div', null, h('label', { for: input.id, text }), input, hint ? h('p', { class: 'hint', text: hint }) : null)
  fields.append(
    field('接口类型', kind),
    field('显示名', label),
    h('div', { class: 'field-wide' }, h('label', { for: 'pf-url', text: '服务地址' }), baseUrl),
    field('API key', apiKey, '只写不读：保存后这里只显示掩码。'),
    field('模型名', model),
    field('输出上限（token）', maxOut),
    field('温度', temp),
    field('超时（秒）', timeout),
    optionsBox,
    h('div', { class: 'field-wide' }, h('label', { for: 'pf-headers', text: '额外请求头（JSON 对象，可留空）' }), headers),
    h('div', { class: 'field-wide' }, h('label', { for: 'pf-body', text: '额外请求参数（JSON 对象，浅合并进请求体，可留空）' }), extraBody),
  )
  form.append(fields, h('div', { class: 'row' }, saveBtn, testBtn, cancelBtn), result)
  return form
}

function testResultBox(res) {
  return res.ok
    ? h('div', { class: 'test-result ok', text: `连接正常：${(res.durationMs / 1000).toFixed(1)} 秒，模型 ${res.model}，回复“${res.reply}”` })
    : h('div', { class: 'test-result bad', text: `连接失败（${res.error.kind}${res.error.status ? `，HTTP ${res.error.status}` : ''}）：${res.error.message}` })
}

function renderProviders() {
  const root = $('#tab-models')
  const { providers, activeProviderId, adapters } = providerState
  const kindLabel = (kind) => adapters.find((a) => a.kind === kind)?.label ?? kind
  const addBtn = h('button', { type: 'button', class: 'primary', text: '添加服务商', disabled: editingProvider !== null })
  addBtn.addEventListener('click', () => {
    editingProvider = 'new'
    renderProviders()
  })

  const cards = providers.map((p) => {
    if (editingProvider === p.id) return h('div', { class: 'card' }, h('h2', { text: `编辑：${p.label}` }), providerForm(p))
    const isActive = p.id === activeProviderId
    const result = h('div')
    if (testResults.has(p.id)) result.append(testResultBox(testResults.get(p.id)))
    const useBtn = h('button', { type: 'button', class: 'small', text: '设为当前', disabled: isActive })
    useBtn.addEventListener('click', async () => {
      const next = await act(useBtn, () => api('POST', `/providers/${p.id}/activate`, {}), `现在用 ${p.label}`)
      if (next) {
        providerState = next
        renderProviders()
        refreshOverview()
      }
    })
    const testBtn = h('button', { type: 'button', class: 'small', text: '测试连接' })
    testBtn.addEventListener('click', async () => {
      result.replaceChildren(h('p', { class: 'muted', text: '正在测试…' }))
      const { apiKeySet, apiKeyMasked, ...rest } = p
      const res = await act(testBtn, () => api('POST', '/providers/test', { ...rest, apiKey: '' }))
      if (res) testResults.set(p.id, res)
      result.replaceChildren(res ? testResultBox(res) : '')
    })
    const editBtn = h('button', { type: 'button', class: 'small', text: '编辑', disabled: editingProvider !== null })
    editBtn.addEventListener('click', () => {
      editingProvider = p.id
      renderProviders()
    })
    const delBtn = h('button', { type: 'button', class: 'small danger', text: '删除' })
    delBtn.addEventListener('click', async () => {
      if (!confirm(`删除服务商“${p.label}”？它的 API key 也会一起删掉。`)) return
      const next = await act(delBtn, () => api('DELETE', `/providers/${p.id}`, {}), '已删除')
      if (next) {
        providerState = next
        testResults.delete(p.id)
        renderProviders()
        refreshOverview()
      }
    })
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'provider-head' }, h('span', { class: 'name', text: p.label }), isActive ? h('span', { class: 'badge ok', text: '当前使用' }) : null, h('span', { class: 'spacer' }), useBtn, testBtn, editBtn, delBtn),
      kv([
        ['接口类型', kindLabel(p.kind)],
        ['服务地址', h('span', { class: 'mono', text: p.baseUrl })],
        ['模型名', h('span', { class: 'mono', text: p.model })],
        ['API key', p.apiKeySet ? h('span', { class: 'mono', text: `已设置 ${p.apiKeyMasked}` }) : h('span', { class: 'error', text: '没设置' })],
      ]),
      result,
    )
  })

  root.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'row' }, h('p', { class: 'muted', text: '可以存多条，选一条为当前使用。改完当前这条会立刻生效，不用重启。' }), h('span', { class: 'spacer' }), addBtn),
      editingProvider === 'new' ? h('div', { class: 'card' }, h('h2', { text: '添加服务商' }), providerForm(null)) : null,
      providers.length === 0 && editingProvider !== 'new' ? h('div', { class: 'card' }, h('p', { text: '还没有模型服务。它现在没法思考。' })) : null,
      cards,
    ),
  )
}

async function enterModels() {
  if (editingProvider !== null) return // 正在填表，别把表单冲掉
  const data = await act(null, () => api('GET', '/providers'))
  if (data) {
    providerState = data
    renderProviders()
  }
}

// ── AI 玩家 ──

let botDirty = false

async function enterBot() {
  if (botDirty) return
  const [data] = await Promise.all([act(null, () => api('GET', '/bot')), refreshOverview()])
  if (data) renderBot(data)
}

function renderBot(data) {
  const root = $('#tab-bot')
  const bot = data.bot
  const st = overview?.bot?.status
  const connected = overview?.bridge?.state === 'connected'
  const dirty = () => (botDirty = true)

  const name = h('input', { id: 'bf-name', type: 'text', value: bot.name, maxLength: 16, required: true })
  const aliases = h('input', { id: 'bf-aliases', type: 'text', value: bot.aliases.join(' '), placeholder: '用空格隔开，例如：阿鲁 小鲁' })
  const owners = h('input', { id: 'bf-owners', type: 'text', value: bot.owners.join(' '), placeholder: '留空 = 谁都可以叫它干活' })
  const mode = h('select', { id: 'bf-mode' }, h('option', { value: 'mention', text: '叫到名字，或刚和它说过话', selected: bot.wake.mode === 'mention' }), h('option', { value: 'all', text: '所有聊天都触发（费 token）', selected: bot.wake.mode === 'all' }))
  const windowSec = h('input', { id: 'bf-window', type: 'number', min: 0, max: 3600, value: bot.wake.conversationWindowSec })
  const maxSteps = h('input', { id: 'bf-steps', type: 'number', min: 1, max: 64, value: bot.limits.maxSteps })
  const daily = h('input', { id: 'bf-daily', type: 'number', min: 0, value: bot.limits.dailyTokenLimit })
  const historyMax = h('input', { id: 'bf-history', type: 'number', min: 2000, value: bot.limits.historyTokenThreshold })
  const memoryMax = h('input', { id: 'bf-memory', type: 'number', min: 200, value: bot.limits.memoryMaxChars })
  const resultMax = h('input', { id: 'bf-result', type: 'number', min: 500, value: bot.limits.toolResultMaxChars })
  const usingDefault = bot.systemPrompt.trim() === ''
  const persona = h('textarea', { id: 'bf-persona', class: 'tall', value: usingDefault ? data.defaultPersona : bot.systemPrompt })
  const personaState = h('span', { class: 'muted', text: usingDefault ? '现在用的是默认提示词' : '现在用的是自定义提示词' })
  const resetBtn = h('button', { type: 'button', class: 'small', text: '恢复默认' })
  resetBtn.addEventListener('click', () => {
    persona.value = data.defaultPersona
    personaState.textContent = '已填回默认提示词，保存后生效'
    dirty()
  })

  const saveBtn = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const form = h('form', { class: 'card' })
  form.addEventListener('input', dirty)
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(
      saveBtn,
      () =>
        api('PUT', '/bot', {
          name: name.value.trim(),
          aliases: aliases.value,
          owners: owners.value,
          systemPrompt: persona.value,
          wake: { mode: mode.value, conversationWindowSec: Number(windowSec.value) },
          limits: {
            maxSteps: Number(maxSteps.value),
            dailyTokenLimit: Number(daily.value),
            historyTokenThreshold: Number(historyMax.value),
            memoryMaxChars: Number(memoryMax.value),
            toolResultMaxChars: Number(resultMax.value),
          },
        }),
      '已保存，立刻生效',
    )
    if (saved) {
      botDirty = false
      await refreshOverview()
      renderBot(saved)
    }
  })
  const field = (text, input, hint) => h('div', null, h('label', { for: input.id, text }), input, hint ? h('p', { class: 'hint', text: hint }) : null)
  form.append(
    h('h2', { text: '身份和听谁的' }),
    h(
      'div',
      { class: 'fields' },
      field('名字（游戏里的玩家名）', name, '改名等于换一个玩家：旧名字的那个还留在游戏里，要先让它下线。'),
      field('别名', aliases, '聊天里提到这些词也算在叫它。'),
      field('主人名单', owners, '非空时只有名单里的玩家能指挥它，其他人的话它只当背景。'),
      field('什么时候回应聊天', mode),
      field('对话窗口（秒）', windowSec, '和它说过话之后，这段时间内不用再叫名字。'),
    ),
    h('h2', { text: '上限' }),
    h(
      'div',
      { class: 'fields' },
      field('每轮最多调几次模型', maxSteps, '它被叫醒一次算一轮，到了这个次数这一轮就被截断。查配方、找材料这类多步的目标常要 20 次以上。默认 30。'),
      field('每日 token 上限', daily, '输入加输出。0 表示不限。'),
      field('历史超过多少 token 就压缩', historyMax),
      field('记忆总长度上限（字符）', memoryMax),
      field('单个工具结果上限（字符）', resultMax),
    ),
    h('h2', { text: '人设提示词' }),
    h('div', { class: 'row' }, personaState, h('span', { class: 'spacer' }), resetBtn),
    persona,
    h('p', { class: 'hint', text: '这里只写任何时候都用得上的东西：它是谁、怎么说话、底线。各类活具体怎么做写在“手册”页，它要干那类事时才去翻。提示词里的 {{name}} 会换成它的名字；手册目录、名字、别名、主人名单和记忆由程序自动附在后面，不用写在这里。' }),
    h('div', { class: 'row' }, saveBtn),
  )

  // 上线、下线、无敌、饥饿：直接作用于游戏里的它
  const spawnBtn = h('button', { type: 'button', text: '上线', disabled: !connected || st?.online === true })
  spawnBtn.addEventListener('click', async () => {
    await act(spawnBtn, () => api('POST', '/bot/spawn', {}), '已让它上线')
    await refreshOverview()
    if (!botDirty) renderBot(data)
  })
  const despawnBtn = h('button', { type: 'button', text: '下线', disabled: !connected || !st?.online })
  despawnBtn.addEventListener('click', async () => {
    await act(despawnBtn, () => api('POST', '/bot/despawn', {}), '已让它下线')
    await refreshOverview()
    if (!botDirty) renderBot(data)
  })
  const toggle = (key, text) => {
    const input = h('input', { type: 'checkbox', checked: st?.settings?.[key] === true, disabled: !st?.online })
    input.addEventListener('change', async () => {
      const ok = await act(input, () => api('POST', '/bot/configure', { [key]: input.checked }), '已设置')
      if (!ok) input.checked = !input.checked
      refreshOverview()
    })
    return h('label', { class: 'check' }, input, ` ${text}`)
  }
  const liveCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: `游戏里的 ${bot.name}` }),
    h('p', { class: connected ? '' : 'error', text: !connected ? '没连上游戏，下面的按钮暂时用不了。' : st?.online ? `在线，位置 ${pos(st.block ?? st.pos)}（${dimName(st.dim)}）` : '不在线' }),
    h('div', { class: 'row' }, spawnBtn, despawnBtn, toggle('invulnerable', '无敌'), toggle('hunger', '会饿')),
    h('p', { class: 'error', text: '“会饿”打开后要小心：它现在不会吃东西，饱食度掉光以后会饿死。没有特别的理由就关着。' }),
    h('p', { class: 'hint', text: '上线、下线会被记住：大脑重连游戏时，会按最后一次的选择把它叫出来或不叫。它被踢下线也算“下线”，要回来得在这里点“上线”。' }),
  )

  root.replaceChildren(h('div', { class: 'stack' }, liveCard, form))
}

// ── 记忆 ──

async function enterMemory() {
  const data = await act(null, () => api('GET', '/memory'))
  if (data) renderMemory(data)
}

function renderMemory(data) {
  const root = $('#tab-memory')
  const row = (note) => {
    const key = h('input', { type: 'text', value: note?.key ?? '', maxLength: 64, placeholder: '键，例如 home:base', 'aria-label': '键' })
    const text = h('textarea', { rows: 2, value: note?.text ?? '', maxLength: 1000, placeholder: '内容', 'aria-label': '内容' })
    const saveBtn = h('button', { type: 'button', class: 'small', text: note ? '保存' : '添加' })
    saveBtn.addEventListener('click', async () => {
      const next = await act(saveBtn, () => api('PUT', '/memory', { key: key.value, text: text.value, ...(note ? { previousKey: note.key } : {}) }), '已保存')
      if (next) renderMemory(next)
    })
    const delBtn = note ? h('button', { type: 'button', class: 'small danger', text: '删除' }) : null
    delBtn?.addEventListener('click', async () => {
      if (!confirm(`删除记忆“${note.key}”？`)) return
      const next = await act(delBtn, () => api('DELETE', '/memory', { key: note.key }), '已删除')
      if (next) renderMemory(next)
    })
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'fields' }, h('div', null, h('label', { text: '键' }), key, note ? h('p', { class: 'hint', text: `更新于 ${dateTime(note.updatedAt)}` }) : null), h('div', null, h('label', { text: '内容' }), text)),
      h('div', { class: 'row end' }, saveBtn, delBtn),
    )
  }
  root.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h('p', { class: 'muted', text: `这是它自己记的笔记，每一轮都会给它看。你也可以直接改。已用 ${num(data.totalChars)} / ${num(data.maxChars)} 字符。` }),
      h('h2', { text: '新增一条' }),
      row(null),
      data.notes.length > 0 ? h('h2', { text: `已有的（${data.notes.length}）` }) : h('p', { class: 'muted', text: '它还没记下任何东西。' }),
      data.notes.map(row),
    ),
  )
}

// ── 手册 ──

let manualState = null
let editingManual = null // 正在编辑的手册名；'' 表示新写一本；null 表示没在编辑

async function enterManuals() {
  if (editingManual !== null) return // 正在写，别把内容冲掉
  const data = await act(null, () => api('GET', '/manuals'))
  if (data) {
    manualState = data
    renderManuals()
  }
}

function manualBadge(m) {
  if (m.source === 'default') return h('span', { class: 'badge', text: '默认' })
  return m.overridesDefault ? h('span', { class: 'badge warn', text: '你改过的' }) : h('span', { class: 'badge ok', text: '你写的' })
}

/** 编辑一本手册。manual 为 null 是新写一本；是默认手册时，保存出来的是你的一份，默认的那份还在。 */
function manualForm(manual) {
  const limits = manualState.limits
  const isNew = manual === null
  const fixedName = !isNew && (manual.source === 'default' || manual.overridesDefault) // 默认手册的名字不能改，改了就不是盖住它了
  const name = h('input', { id: 'mf-name', type: 'text', value: manual?.name ?? '', maxLength: limits.nameMaxChars, required: true, disabled: fixedName, placeholder: '例如：基地布局', spellcheck: false })
  const summary = h('input', { id: 'mf-summary', type: 'text', value: manual?.summary ?? '', maxLength: limits.summaryMaxChars, required: true, placeholder: '例如：要在基地里找仓库、机器、工作台的位置时看。' })
  const body = h('textarea', { id: 'mf-body', class: 'tall', value: manual?.body ?? '', required: true, placeholder: '正文，写给它看。可以用 Markdown。' })
  const counter = h('span', { class: 'muted' })
  const count = () => {
    counter.textContent = `${num(body.value.trim().length)} / ${num(limits.bodyMaxChars)} 字符`
    counter.className = body.value.trim().length > limits.bodyMaxChars ? 'error' : 'muted'
  }
  body.addEventListener('input', count)
  count()
  const saveBtn = h('button', { type: 'submit', class: 'primary', text: '保存' })
  const cancelBtn = h('button', { type: 'button', text: '取消' })
  cancelBtn.addEventListener('click', () => {
    editingManual = null
    renderManuals()
  })
  const form = h('form', { class: 'stack' })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const payload = { name: name.value.trim(), summary: summary.value, body: body.value }
    // 给一本你写的手册改名：新名字存好后删掉旧的
    if (!isNew && !fixedName && manual.name !== payload.name) payload.previousName = manual.name
    const next = await act(saveBtn, () => api('PUT', '/manuals', payload), '已保存，它下次要用时读到的就是新的')
    if (next) {
      manualState = next
      editingManual = null
      renderManuals()
    }
  })
  const field = (text, input, hint) => h('div', null, h('label', { for: input.id, text }), input, hint ? h('p', { class: 'hint', text: hint }) : null)
  // append 会把 null 写成字：用不上的部分先滤掉
  const parts = [
    h(
      'div',
      { class: 'fields' },
      field('名字', name, fixedName ? '默认手册的名字不能改。' : '它用这个名字来读这本手册。字母、数字、汉字、下划线和连字符，不能有空格。'),
      h('div', { class: 'field-wide' }, h('label', { for: 'mf-summary', text: '什么时候看这本（一句话）' }), summary, h('p', { class: 'hint', text: '这一句每次都会出现在给它的手册目录里，它靠这句话决定要不要翻这本。' })),
    ),
    h('div', null, h('label', { for: 'mf-body', text: '正文' }), body, h('div', { class: 'row' }, counter)),
    !isNew && manual.source === 'default' ? h('p', { class: 'hint', text: '这是随程序发布的默认手册。保存后它用的是你改的这一份；想换回来，点这本手册上的“恢复默认”。' }) : null,
    !isNew && manual.default
      ? h('details', null, h('summary', { text: '看默认的内容' }), h('p', { class: 'muted', text: manual.default.summary }), h('pre', { class: 'manual-text', text: manual.default.body }))
      : null,
    h('div', { class: 'row' }, saveBtn, cancelBtn),
  ]
  form.append(...parts.filter((part) => part !== null))
  return form
}

function renderManuals() {
  const root = $('#tab-manuals')
  const list = manualState.manuals ?? []
  const addBtn = h('button', { type: 'button', class: 'primary', text: '新写一本', disabled: editingManual !== null })
  addBtn.addEventListener('click', () => {
    editingManual = ''
    renderManuals()
  })
  const cards = list.map((m) => {
    if (editingManual === m.name) return h('div', { class: 'card' }, h('h2', { text: `手册：${m.name}` }), manualForm(m))
    const editBtn = h('button', { type: 'button', class: 'small', text: m.source === 'default' ? '查看 / 修改' : '编辑', disabled: editingManual !== null })
    editBtn.addEventListener('click', () => {
      editingManual = m.name
      renderManuals()
    })
    // 你改过的默认手册：删掉你的那份就是恢复默认；你自己写的：删除
    const removeBtn =
      m.source === 'user' ? h('button', { type: 'button', class: 'small danger', text: m.overridesDefault ? '恢复默认' : '删除', disabled: editingManual !== null }) : null
    removeBtn?.addEventListener('click', async () => {
      const question = m.overridesDefault ? `把手册“${m.name}”恢复成默认的？你改的内容会丢掉。` : `删除手册“${m.name}”？`
      if (!confirm(question)) return
      const next = await act(removeBtn, () => api('DELETE', '/manuals', { name: m.name }), m.overridesDefault ? '已恢复默认' : '已删除')
      if (next) {
        manualState = next
        renderManuals()
      }
    })
    return h(
      'div',
      { class: 'card' },
      h('div', { class: 'provider-head' }, h('span', { class: 'name mono', text: m.name }), manualBadge(m), h('span', { class: 'spacer' }), editBtn, removeBtn),
      h('p', { text: m.summary }),
      h('details', null, h('summary', { text: `看正文（${num(m.body.length)} 字符）` }), h('pre', { class: 'manual-text', text: m.body })),
    )
  })
  root.replaceChildren(
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'row' },
        h('p', { class: 'muted fill', text: '手册是它要干某一类活时才去翻的说明，不是每次都塞给模型的；提示词里只列每本的名字和“什么时候看”那一句。默认手册随程序发布，你可以改（改完用你的，随时能恢复默认），也可以自己新写，比如“基地布局”“材料仓库在哪”。' }),
        addBtn,
      ),
      editingManual === '' ? h('div', { class: 'card' }, h('h2', { text: '新写一本手册' }), manualForm(null)) : null,
      cards,
    ),
  )
}

// ── 图纸 ──

/** 把选中的文件读成 base64（不带 data: 前缀）。 */
function fileToBase64(file) {
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

const fileSize = (bytes) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KiB` : `${Number((bytes / 1024 / 1024).toFixed(1))} MiB`)
const blueprintSize = (b) => (b.size ? `${b.size.x}×${b.size.y}×${b.size.z}` : '')

async function enterBlueprints() {
  const root = $('#tab-blueprints')
  try {
    renderBlueprints(await api('GET', '/blueprints'))
  } catch (e) {
    // 图纸存在游戏服务器上，没连上游戏就看不到：把原因留在页面上，而不是一闪而过
    if (e.status === 401) return
    const retry = h('button', { type: 'button', text: '重试' })
    retry.addEventListener('click', enterBlueprints)
    root.replaceChildren(
      h('div', { class: 'card' }, h('h2', { text: '图纸' }), h('p', { class: 'error', text: `拿不到图纸列表：${e.message}` }), h('p', { class: 'hint', text: '图纸存在游戏服务器上，要先连上游戏才能看和上传。' }), h('div', { class: 'row' }, retry)),
    )
  }
}

function renderBlueprints(data) {
  const root = $('#tab-blueprints')
  const list = data.blueprints ?? []
  const maxBytes = data.maxBytes ?? 2 * 1024 * 1024

  // 上传
  const file = h('input', { id: 'bp-file', type: 'file', accept: '.schematic' })
  const name = h('input', { id: 'bp-name', type: 'text', maxLength: 80, placeholder: '选好文件后自动填上，可以改', spellcheck: false })
  const note = h('p', { class: 'hint', text: '还没选文件。' })
  const uploadBtn = h('button', { type: 'submit', class: 'primary', text: '上传', disabled: true })
  file.addEventListener('change', () => {
    const chosen = file.files?.[0]
    if (!chosen) {
      note.className = 'hint'
      note.textContent = '还没选文件。'
      uploadBtn.disabled = true
      return
    }
    name.value = chosen.name.replace(/\.schematic$/i, '')
    const problem = chosen.size === 0 ? '这个文件是空的。' : chosen.size > maxBytes ? `这个文件有 ${fileSize(chosen.size)}，图纸最大 ${fileSize(maxBytes)}。` : ''
    note.className = problem ? 'error' : 'hint'
    note.textContent = problem || `${chosen.name}，${fileSize(chosen.size)}。`
    uploadBtn.disabled = problem !== ''
  })
  const form = h('form', { class: 'card' })
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const chosen = file.files?.[0]
    const wanted = name.value.trim()
    if (!chosen || !wanted) {
      toast('先选一个 .schematic 文件，并给它一个名字', true)
      return
    }
    if (list.some((b) => b.name === wanted) && !confirm(`服务器上已经有一张叫“${wanted}”的图纸，用这个文件覆盖它？`)) return
    uploadBtn.disabled = true
    try {
      const next = await api('POST', '/blueprints', { name: wanted, data: await fileToBase64(chosen) })
      const saved = next.saved ?? {}
      toast(`已上传 ${saved.name ?? wanted}${saved.size ? `（${blueprintSize(saved)}，${num(saved.blocks)} 个方块）` : ''}`)
      renderBlueprints(next)
    } catch (e) {
      // 文件不是能用的图纸时，原因留在表单上，而不是一闪而过的提示
      note.className = 'error'
      note.textContent = `没传上去：${e.message}`
      uploadBtn.disabled = false
    }
  })
  form.append(
    h('h2', { text: '上传图纸' }),
    h('p', { class: 'muted', text: `Schematica 导出的 .schematic 文件，最大 ${fileSize(maxBytes)}。传上去以后它就能照着盖；和已有的图纸同名会覆盖。` }),
    h(
      'div',
      { class: 'fields' },
      h('div', null, h('label', { for: 'bp-file', text: '文件' }), file, note),
      h('div', null, h('label', { for: 'bp-name', text: '图纸名字' }), name, h('p', { class: 'hint', text: '它和你都用这个名字指这张图纸。' })),
    ),
    h('div', { class: 'row' }, uploadBtn),
  )

  // 已有的
  const row = (b) => {
    const delBtn = h('button', { type: 'button', class: 'small danger', text: '删除' })
    delBtn.addEventListener('click', async () => {
      if (!confirm(`从游戏服务器上删除图纸“${b.name}”？`)) return
      const next = await act(delBtn, () => api('DELETE', '/blueprints', { name: b.name }), `已删除 ${b.name}`)
      if (next) renderBlueprints(next)
    })
    const usable = b.error === undefined && b.size
    return h(
      'li',
      null,
      h('div', { class: 'grow' }, h('span', { class: 'mono', text: b.name }), usable ? null : h('div', { class: 'error', text: `读不了：${b.error ?? '游戏那边没给出尺寸'}` })),
      usable ? h('span', { class: 'muted', title: '东西向（x）× 高（y）× 南北向（z）', text: `${blueprintSize(b)}，${num(b.blocks)} 个方块` }) : h('span', { class: 'badge bad', text: '读不了' }),
      delBtn,
    )
  }
  const listCard = h(
    'div',
    { class: 'card' },
    h('h2', { text: `服务器上的图纸（${list.length}）` }),
    list.length === 0 ? h('p', { class: 'muted', text: '还没有图纸。' }) : h('ul', { class: 'plain' }, list.map(row)),
    h('p', { class: 'hint', text: `尺寸是 东西向（x）× 高（y）× 南北向（z）。${data.folder ? `文件在游戏服务器的 ${data.folder} 里，直接放进去也行，不用重启。` : ''}盖的时候不旋转、不镜像。` }),
  )

  root.replaceChildren(h('div', { class: 'stack' }, form, listCard))
}

// ── 设置 ──

let settingsDirty = false

async function enterSettings() {
  if (settingsDirty) return
  const data = await act(null, () => api('GET', '/settings'))
  if (data) renderSettings(data)
}

function renderSettings(data) {
  const root = $('#tab-settings')
  const ov = data.overridden
  const eff = data.effective
  const st = data.status
  const stateText =
    st.state === 'connected'
      ? `已连接 ${st.address}`
      : st.state === 'unconfigured'
        ? '还没配置口令文件，没有去连'
        : st.state === 'connecting'
          ? `正在连接 ${st.address}`
          : `没连上 ${st.address}，自动重试中${st.lastError ? `：${st.lastError}` : ''}`

  // bridge
  const port = h('input', { id: 'sf-port', type: 'number', min: 1, max: 65535, value: data.bridge.port, required: true })
  const tokenFile = h('input', { id: 'sf-token-file', type: 'text', value: data.bridge.tokenFile, placeholder: '例如 /srv/gtnh/config/aiplayer/bridge-token.txt', spellcheck: false })
  const saveBridge = h('button', { type: 'submit', class: 'primary', text: '保存并重连' })
  const bridgeForm = h('form', { class: 'card' })
  bridgeForm.addEventListener('input', () => (settingsDirty = true))
  bridgeForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const saved = await act(saveBridge, () => api('PUT', '/settings/bridge', { port: Number(port.value), tokenFile: tokenFile.value }), '已保存，正在按新的设置连接')
    if (saved) {
      settingsDirty = false
      // 给它一点时间去连，再把结果显示出来
      setTimeout(async () => {
        const fresh = await act(null, () => api('GET', '/settings'))
        if (fresh && !settingsDirty) renderSettings(fresh)
        refreshOverview()
      }, 1200)
    }
  })
  const overrideNote = (on, envName, value) =>
    on ? h('p', { class: 'error', text: `现在实际用的是环境变量 ${envName} 给的值：${value}。这里改的值要等去掉那个环境变量后才生效。` }) : null
  bridgeForm.append(
    h('h2', { text: '游戏连接（bridge）' }),
    h('p', { class: st.state === 'connected' ? '' : 'error', text: `现在：${stateText}` }),
    h(
      'div',
      { class: 'fields' },
      h('div', null, h('label', { for: 'sf-port', text: '端口' }), port, h('p', { class: 'hint', text: '身体（mod）监听的端口，在游戏服务器的 config/aiplayer/aiplayer.json 里（bridgePort）。正式服默认 25590。' }), overrideNote(ov.bridgePort, 'AIPLAYER_BRIDGE_PORT', eff.port)),
      h(
        'div',
        { class: 'field-wide' },
        h('label', { for: 'sf-token-file', text: '口令文件路径' }),
        tokenFile,
        h('p', { class: 'hint', text: '游戏服务器目录下的 config/aiplayer/bridge-token.txt，mod 首次启动时生成。写绝对路径；相对路径相对 brain/ 目录。留空就不连游戏。' }),
        overrideNote(ov.bridgeTokenFile, 'AIPLAYER_BRIDGE_TOKEN_FILE', eff.tokenFile),
        ov.bridgeToken ? h('p', { class: 'error', text: '现在口令是环境变量 AIPLAYER_BRIDGE_TOKEN 直接给的，口令文件没有被用到。' }) : null,
      ),
    ),
    h('p', { class: 'hint', text: `连接的主机是 ${eff.host}，只能在 config.json 或环境变量里改。` }),
    h('div', { class: 'row' }, saveBridge),
  )

  // 面板口令
  const current = h('input', { id: 'sf-pw-current', type: 'password', autocomplete: 'current-password', required: true })
  const next = h('input', { id: 'sf-pw-next', type: 'password', autocomplete: 'new-password', required: true, minLength: 8 })
  const repeat = h('input', { id: 'sf-pw-repeat', type: 'password', autocomplete: 'new-password', required: true, minLength: 8 })
  const savePw = h('button', { type: 'submit', class: 'primary', text: '修改口令' })
  const pwForm = h('form', { class: 'card' })
  pwForm.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    if (next.value !== repeat.value) {
      toast('两次输入的新口令不一样', true)
      return
    }
    const ok = await act(savePw, () => api('PUT', '/settings/password', { current: current.value, next: next.value }), '口令已修改，别处的登录都已失效')
    if (ok) pwForm.reset()
  })
  pwForm.append(
    h('h2', { text: '面板口令' }),
    h('input', { type: 'text', name: 'username', autocomplete: 'username', value: 'owner', hidden: true }),
    h(
      'div',
      { class: 'fields' },
      h('div', null, h('label', { for: 'sf-pw-current', text: '当前口令' }), current),
      h('div', null, h('label', { for: 'sf-pw-next', text: '新口令（至少 8 个字符）' }), next),
      h('div', null, h('label', { for: 'sf-pw-repeat', text: '再输一遍新口令' }), repeat),
    ),
    h('p', { class: 'hint', text: '口令保存在数据目录的 config.json 里。忘了可以直接改那个文件的 panel.password 再重启大脑。' }),
    h('div', { class: 'row' }, savePw),
  )

  root.replaceChildren(h('div', { class: 'stack' }, bridgeForm, pwForm))
}

// ── 启动 ──

const TABS = {
  overview: { enter: () => ((overviewKey = ''), refreshOverview()) },
  chat: {
    enter: () => {
      startStream()
      const log = $('#chat-log')
      log.scrollTop = log.scrollHeight
    },
  },
  models: { enter: enterModels },
  bot: { enter: enterBot },
  memory: { enter: enterMemory },
  manuals: { enter: enterManuals },
  blueprints: { enter: enterBlueprints },
  settings: { enter: enterSettings },
}

api('GET', '/session').then(
  (s) => (s.authenticated ? showApp() : showLogin()),
  () => showLogin(),
)

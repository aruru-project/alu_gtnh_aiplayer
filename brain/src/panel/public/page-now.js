// “现在”页：一眼看出它此刻在干什么、是不是卡住了，和游戏里的它是什么样子。
//   左边：一句话的现状；每条线的细节（模型想到第几步、例程调到哪了、身体的任务和排队的）；最近几步；最近说的话，可以直接回它一句。
//   右边：游戏里的样子——血量和饥饿、位置朝向、物品栏（和游戏里一样的格子）、开着的界面、附近的人、脚下的俯视图。

import { actions, agentLabel, bodyAgent, refresh, serverNow, state } from './data.js'
import { foodBar, hearts, inventoryPanel, screenPanel, slotDetail } from './items.js'
import { recentActivity } from './logmodel.js'
import { getTimeline } from './logstore.js'
import { STALE_TASK_MS, modelState, taskProgress, taskStaleMs } from './side.js'
import { TASK_STATES, act, api, badge, bearing, bus, button, clock, compact, dimName, duration, empty, facing, gameClock, h, kv, num, pos, progressBar, taskName, when } from './ui.js'

let root = null
let unsubscribe = []
let workKey = ''
let liveKey = ''
let feedKey = ''
let picked = null
let mapTimer
let mapData = null

const RUN_STATES = { running: '在跑', done: '跑完了', failed: '出错停了', stopped: '被停掉了', limit: '到上限停了' }

// ── 左边：它在干什么 ──

/** 一句话的现状。最要紧的在前：故障 > 在想 > 在执行工具 > 例程 > 身体 > 空闲。 */
function headline() {
  const agents = state.status?.agents ?? []
  if (agents.length === 0) return { tone: 'idle', text: state.error ? '连不上大脑进程' : '正在问大脑…', sub: state.error ?? '' }
  const owner = bodyAgent(state.status)
  const many = agents.length > 1
  const name = (a) => (many ? `${agentLabel(a)}线` : '')
  for (const a of agents) {
    const m = a.model ?? {}
    if (m.state === 'outage') return { tone: 'bad', text: `${name(a)}模型接口故障`, sub: m.outage ? `连着失败 ${m.outage.failures} 次，${clock(m.outage.nextRetryAt)} 再试：${m.outage.lastError}` : '' }
  }
  for (const a of [...agents].reverse()) {
    const s = modelState(a)
    if (a.model?.state === 'thinking') return { tone: s.slow ? 'warn' : 'think', text: `${name(a)}${s.text}`, since: s.since, sub: s.slow ? '这一步比平时久（接口默认 120 秒超时）' : a.turn ? `第 ${a.turn.id} 轮` : '' }
    if (a.model?.state === 'tools') return { tone: 'tools', text: `${name(a)}${s.text}`, sub: a.turn ? `第 ${a.turn.id} 轮` : '' }
  }
  const r = owner?.routine
  if (r) return { tone: 'routine', text: `例程 ${r.id} 在后台跑`, since: r.startedAt, sub: `${r.name || '（没有名字）'}：调了 ${num(r.calls)} 次工具` }
  const task = owner?.body?.task
  if (task) {
    const stale = taskStaleMs(task)
    return { tone: stale > STALE_TASK_MS ? 'warn' : 'body', text: `身体在${taskName(task.type)}`, sub: stale > STALE_TASK_MS ? `进度 ${duration(stale)}没动，可能卡住了` : (task.progress?.phase ?? '模型没在想，等任务做完再叫醒它') }
  }
  const last = agents.map((a) => a.model?.lastCall?.time).filter((t) => typeof t === 'number').sort((x, y) => y - x)[0]
  if (!state.overview?.provider && state.overview) return { tone: 'bad', text: '还没配模型', sub: '到“设置 → 模型服务商”添加一个，它才能思考。' }
  return { tone: 'idle', text: '空闲', sub: last ? `上一次调模型是 ${when(last)}` : '还没调用过模型' }
}

function lastCallText(lc) {
  if (!lc) return '还没调用过'
  if (lc.ok === false) return h('span', { class: 'bad', text: `${when(lc.time)} 失败（${lc.errorKind ?? '?'}）：${lc.error ?? ''}` })
  return `${when(lc.time)} · ${duration(lc.durationMs)} · 入 ${compact(lc.inputTokens)}${lc.cacheReadTokens ? `（缓存 ${compact(lc.cacheReadTokens)}）` : ''} / 出 ${compact(lc.outputTokens)}`
}

function modelBlock(agent, many) {
  const m = agent.model ?? {}
  const s = modelState(agent)
  const turn = agent.turn
  const timeline = getTimeline()
  // 这一轮是被什么叫醒的：从日志里那一轮的开头拿
  const trigger = turn ? timeline.turns.get(turn.id)?.trigger : undefined
  return h(
    'div',
    { class: 'now-lane' },
    h('div', { class: 'now-lane-head' }, h('span', { class: 'tag model', text: many ? `${agentLabel(agent)} · 模型` : '模型' }), h('span', { class: `state ${s.tone}`, ...(s.since !== undefined ? { 'data-since': s.since, 'data-label': s.text } : {}), text: s.since !== undefined ? `${s.text} ${duration(Math.max(0, serverNow() - s.since))}` : s.text })),
    kv([
      ['用的模型', m.provider || m.model ? `${m.provider ?? '?'} / ${m.model ?? '?'}` : h('span', { class: 'bad', text: '还没配置' })],
      turn ? ['这一轮', `第 ${turn.id} 轮，已经 ${turn.steps ?? 0}${turn.maxSteps ? ` / ${turn.maxSteps}` : ''} 步${turn.startedAt ? `，开始于 ${clock(turn.startedAt)}` : ''}`] : null,
      trigger ? ['在处理', trigger] : null,
      m.state === 'outage' && m.outage ? ['故障', h('span', { class: 'bad', text: `从 ${when(m.outage.since)} 起连着失败 ${m.outage.failures} 次，${clock(m.outage.nextRetryAt)} 再试。${m.outage.lastError}` })] : null,
      agent.pending > 0 ? ['排着队', `${agent.pending} 件事等它处理`] : null,
      ['上一次调用', lastCallText(m.lastCall)],
    ]),
  )
}

function routineBlock(agent) {
  const r = agent.routine ?? agent.lastRoutine
  const running = agent.routine !== null && agent.routine !== undefined
  const head = h('div', { class: 'now-lane-head' }, h('span', { class: 'tag routine', text: '例程' }))
  if (!r) return h('div', { class: 'now-lane' }, head, h('p', { class: 'muted', text: '没有在跑的例程。例程是它自己写的后台脚本：一步步调工具，不用每一步都问模型。' }))
  const now = serverNow()
  head.append(
    h('span', { class: `state ${running ? 'routine' : r.status === 'done' ? 'ok' : 'warn'}`, ...(running ? { 'data-since': r.startedAt, 'data-label': '在跑' } : {}), text: running ? `在跑 ${duration(Math.max(0, now - r.startedAt))}` : `上一个：${RUN_STATES[r.status] ?? r.status}` }),
    running ? button('停止例程', { class: 'small danger', title: '停掉它；它正在做的任务也取消，模型会被叫醒看结果' }, (btn) => act(btn, actions.stopRoutine, '已停止例程').then(refresh)) : null,
  )
  const recent = (r.recent ?? []).slice(-6)
  const logs = (r.logs ?? []).slice(-8)
  return h(
    'div',
    { class: 'now-lane' },
    head,
    kv([
      ['哪一个', h('span', null, h('span', { class: 'mono', text: `${r.id} ` }), r.name || '（没有名字）')],
      ['做了多少', `调了 ${num(r.calls)} 次工具，开了 ${num(r.tasks)} 个任务${r.errors > 0 ? `，${r.errors} 次出错` : ''}${typeof r.limitMs === 'number' ? `；最多跑 ${duration(r.limitMs)}` : ''}`],
      running && r.waiting ? ['正在等', h('span', { class: 'mono', text: r.waiting })] : null,
      !running && r.ending ? ['怎么结束的', r.ending] : null,
      !running && r.endedAt ? ['结束于', when(r.endedAt)] : null,
    ]),
    recent.length > 0
      ? h(
          'details',
          { class: 'fold' },
          h('summary', { text: `最近 ${recent.length} 步${logs.length > 0 ? `和 ${logs.length} 行日志` : ''}` }),
          h('pre', { class: 'code', text: [...recent.map((c) => `#${c.n} ${c.tool} ${c.input} → ${c.ok ? '' : '失败：'}${c.result}`), ...logs.map((l) => `log: ${l}`)].join('\n') }),
        )
      : null,
    h('p', { class: 'hint' }, '每一步的参数和结果在 ', h('a', { href: '#chat', text: '对话页' }), ' 这次运行的那一块里。'),
  )
}

function taskLine(t) {
  const p = t.progress
  const progress = p && typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0 ? ` ${p.done}/${p.total}` : ''
  return `${taskName(t.type)}${progress}`
}

function bodyBlock(agent) {
  const body = agent.body ?? {}
  const task = body.task
  const queue = body.queue ?? []
  const recent = [...(state.overview?.tasks?.recent ?? [])].sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0)).slice(0, 5)
  const cancel = (id, label = '取消') => button(label, { class: 'small danger' }, (btn) => act(btn, () => actions.cancelTask(id), id ? '已取消' : '已全部取消').then(refresh))
  const head = h('div', { class: 'now-lane-head' }, h('span', { class: 'tag body', text: '身体' }))
  if (body.error && !task) {
    head.append(h('span', { class: 'state warn', text: '看不到' }))
    return h('div', { class: 'now-lane' }, head, h('p', { class: 'muted', text: `${body.error}。身体的任务存在游戏那边，连上、上线以后才看得到。` }))
  }
  const stale = taskStaleMs(task)
  head.append(
    h('span', { class: `state ${task ? (stale > STALE_TASK_MS ? 'warn' : 'body') : 'idle'}`, text: task ? (stale > STALE_TASK_MS ? `进度 ${duration(stale)}没动` : '在做任务') : '没有任务' }),
    task || queue.length > 0 ? cancel(undefined, queue.length > 0 ? '全部取消' : '取消') : null,
  )
  const p = task?.progress
  return h(
    'div',
    { class: 'now-lane' },
    head,
    task
      ? h(
          'div',
          { class: 'task-now' },
          h('div', { class: 'task-title' }, h('strong', { text: taskLine(task) }), h('span', { class: 'mono muted', text: ` ${task.type} · ${task.id}` }), task.startedAt ? h('span', { class: 'muted', text: ` · 开始于 ${clock(task.startedAt)}` }) : null),
          progressBar(taskProgress(task), stale > STALE_TASK_MS ? 'warn' : 'body'),
          p?.phase || p?.note ? h('p', { class: 'muted', text: [p.phase, p.note].filter(Boolean).join(' · ') }) : null,
        )
      : h('p', { class: 'muted', text: '身体现在没有在做的任务。任务（走、挖、放、存取、合成……）下达后由身体自己做完，期间不调模型。' }),
    queue.length > 0
      ? [h('h4', { text: `排着队（${queue.length}）` }), h('ul', { class: 'plain' }, queue.map((t) => h('li', null, h('span', { class: 'grow' }, taskLine(t), h('span', { class: 'mono muted', text: `  ${t.type} · ${t.id}` })), cancel(t.id))))]
      : null,
    recent.length > 0
      ? h(
          'details',
          { class: 'fold' },
          h('summary', { text: `最近结束的 ${recent.length} 个任务` }),
          h(
            'ul',
            { class: 'plain' },
            recent.map((t) =>
              h(
                'li',
                null,
                badge(TASK_STATES[t.state] ?? t.state, t.state === 'done' ? 'ok' : t.state === 'failed' ? 'bad' : ''),
                h('span', { class: 'grow' }, taskName(t.type), h('span', { class: 'mono muted', text: `  ${t.type} · ${t.id}` }), t.error ? h('span', { class: 'bad', text: ` — ${t.error.code}${t.error.message ? `：${t.error.message}` : ''}` }) : null),
                t.finishedAt ? h('span', { class: 'muted', text: when(t.finishedAt) }) : null,
              ),
            ),
          ),
        )
      : null,
  )
}

function renderWork(el) {
  const agents = state.status?.agents ?? []
  const owner = bodyAgent(state.status)
  const head = headline()
  const many = agents.length > 1
  el.replaceChildren(
    h(
      'div',
      { class: `now-head ${head.tone}` },
      h('div', { class: 'now-headline' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('span', { class: 'now-text', text: head.text }), head.since !== undefined ? h('span', { class: 'now-since', 'data-since': head.since, 'data-label': '已经', text: `已经 ${duration(Math.max(0, serverNow() - head.since))}` }) : null),
      head.sub ? h('div', { class: 'now-sub', text: head.sub }) : null,
    ),
    agents.length === 0 ? null : h('div', { class: 'card now-lanes' }, agents.map((a) => modelBlock(a, many)), owner ? [routineBlock(owner), bodyBlock(owner)] : null),
  )
}

// ── 左边：最近几步、最近说的话 ──

const FEED_TAGS = { say: ['它说', 'say'], heard: ['', 'heard'], step: ['模型', 'model'], tool: ['', 'model'], run: ['', 'routine'], error: ['出错', 'bad'] }

function renderFeed(el) {
  const { items } = getTimeline()
  const rows = recentActivity(items, 14)
  el.replaceChildren(
    h('div', { class: 'card-head' }, h('h3', { text: '最近几步' }), h('a', { class: 'more', href: '#chat', text: '去对话页看全部' })),
    rows.length === 0
      ? empty('还没有活动', '跟它说句话，或者在游戏里叫它的名字。')
      : h(
          'ol',
          { class: 'feed' },
          rows.map((r) => {
            const [label, tone] = FEED_TAGS[r.kind] ?? ['', '']
            return h(
              'li',
              { class: `feed-row ${r.kind}${r.isError ? ' is-error' : ''}${r.pending ? ' pending' : ''}` },
              h('time', { class: 'time', text: clock(r.time) }),
              h('span', { class: `tag ${tone}`, text: label || r.label }),
              h('span', { class: 'feed-text' }, r.kind === 'tool' && r.args ? h('span', { class: 'mono muted', text: `${r.args.slice(0, 60)}${r.args.length > 60 ? '…' : ''} ` }) : null, r.kind === 'heard' || r.kind === 'say' || r.kind === 'step' || r.kind === 'error' || r.kind === 'run' ? r.text : r.pending ? '（还没回来）' : `→ ${r.text}`),
            )
          }),
        ),
  )
}

function renderSay(el) {
  if (el.childElementCount > 0) return
  const input = h('input', { type: 'text', maxLength: 2000, placeholder: '跟它说一句（只有它看得到，不进游戏聊天）', 'aria-label': '给它下指令' })
  const send = h('button', { type: 'submit', class: 'primary', text: '发送' })
  const form = h('form', { class: 'quick-say' }, input, send)
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const text = input.value.trim()
    if (!text) return
    const ok = await act(send, () => actions.command(text), '已交给它')
    if (ok) input.value = ''
    input.focus()
  })
  el.append(form)
}

// ── 右边：游戏里的样子 ──

function hud(live) {
  const world = live.world
  const facts = []
  if (live.onGround === false && !live.inWater) facts.push('悬空')
  if (live.inWater) facts.push('在水里')
  return h(
    'div',
    { class: 'hud' },
    h('div', { class: 'hud-bars' }, hearts(live.health, live.maxHealth), foodBar(live.food)),
    h(
      'div',
      { class: 'hud-facts' },
      h('span', { title: '血量', text: `血 ${live.health === null ? '?' : Math.ceil(live.health)}/${live.maxHealth ?? 20}` }),
      h('span', { title: '饱食度', text: `饱食 ${live.food ?? '?'}/20` }),
      live.xpLevel !== null ? h('span', { class: 'xp', title: '经验等级', text: `等级 ${live.xpLevel}` }) : null,
      live.settings?.invulnerable ? h('span', { class: 'chip', title: '不受伤害。在“设置 → 玩家”里改', text: '无敌' }) : h('span', { class: 'chip warn', title: '会受伤、会死。在“设置 → 玩家”里改', text: '会受伤' }),
      live.settings?.hunger ? h('span', { class: 'chip warn', title: '饱食度会掉。在“设置 → 玩家”里改', text: '会饿' }) : null,
    ),
    kv([
      ['位置', h('span', null, h('span', { class: 'mono', text: pos(live.block ?? live.pos) }), ` · ${dimName(live.dim)}`)],
      ['朝向', `${facing(live.yaw) || '?'}${typeof live.pitch === 'number' && Math.abs(live.pitch) > 30 ? (live.pitch > 0 ? '，低着头' : '，抬着头') : ''}${facts.length > 0 ? ` · ${facts.join('、')}` : ''}`],
      world ? ['世界', `${world.isDay === false ? '夜晚' : '白天'} ${gameClock(world.dayTime)}${world.raining ? ' · 下雨' : ''}${world.tps !== null ? ` · TPS ${world.tps}` : ''}`] : null,
    ]),
  )
}

function playersBlock(live) {
  const players = live.players ?? []
  return h(
    'div',
    { class: 'card near' },
    h('div', { class: 'card-head' }, h('h3', { text: '别的玩家' }), h('span', { class: 'muted', text: players.length === 0 ? '' : `${players.length} 人在线` })),
    players.length === 0
      ? h('p', { class: 'muted', text: '服务器里现在没有别人。' })
      : h(
          'ul',
          { class: 'plain' },
          players.map((p) =>
            h(
              'li',
              null,
              h('span', { class: 'grow' }, p.name, p.isBot ? h('span', { class: 'chip', text: 'bot' }) : null),
              h('span', { class: 'muted', text: p.dist !== null ? `${p.dist < 10 ? p.dist : Math.round(p.dist)} 格 · ${bearing(p.dx, p.dz) || '同一格'}${Math.abs(p.dy ?? 0) >= 3 ? (p.dy > 0 ? `，高 ${p.dy}` : `，低 ${-p.dy}`) : ''}` : live.online ? dimName(p.dim) : '' }),
            ),
          ),
        ),
  )
}

function drawMap(canvas, data) {
  const scale = Math.max(2, Math.floor(344 / Math.max(data.width, data.depth)))
  canvas.width = data.width * scale
  canvas.height = data.depth * scale
  canvas.style.width = `${canvas.width}px`
  canvas.style.height = `${canvas.height}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#17191c'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (let z = 0; z < data.depth; z++) {
    for (let x = 0; x < data.width; x++) {
      const i = z * data.width + x
      const top = data.tops[i]
      const y = data.heights[i]
      const kind = data.palette[top]
      if (!kind || y < 0) continue
      // 和游戏里的地图一个画法：比北边那一格高的亮一点，低的暗一点
      const north = z > 0 ? data.heights[i - data.width] : y
      const shade = kind.liquid ? 1 : y > north ? 1.14 : y < north ? 0.8 : 1
      const [r, g, b] = kind.color
      ctx.fillStyle = `rgb(${Math.min(255, Math.round(r * shade))},${Math.min(255, Math.round(g * shade))},${Math.min(255, Math.round(b * shade))})`
      ctx.fillRect(x * scale, z * scale, scale, scale)
    }
  }
  const mark = (px, pz, color, size) => {
    ctx.fillStyle = '#000'
    ctx.fillRect(px - size / 2 - 1, pz - size / 2 - 1, size + 2, size + 2)
    ctx.fillStyle = color
    ctx.fillRect(px - size / 2, pz - size / 2, size, size)
  }
  ctx.font = '11px system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  for (const p of data.players) {
    const px = (p.x - data.x1) * scale
    const pz = (p.z - data.z1) * scale
    mark(px, pz, p.isBot ? '#9aa4ad' : '#ffd84a', 6)
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    ctx.fillRect(px + 6, pz - 7, ctx.measureText(p.name).width + 6, 14)
    ctx.fillStyle = '#fff'
    ctx.fillText(p.name, px + 9, pz)
  }
  // 它自己：一个朝着它面对的方向的箭头
  const sx = (data.self.x - data.x1) * scale
  const sz = (data.self.z - data.z1) * scale
  ctx.save()
  ctx.translate(sx, sz)
  // yaw 0 朝南（画布的下方），90 朝西
  ctx.rotate(((data.self.yaw ?? 180) * Math.PI) / 180)
  ctx.beginPath()
  ctx.moveTo(0, 8)
  ctx.lineTo(-6, -6)
  ctx.lineTo(0, -2)
  ctx.lineTo(6, -6)
  ctx.closePath()
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#000'
  ctx.lineWidth = 2
  ctx.stroke()
  ctx.fill()
  ctx.restore()
  canvas.dataset.scale = String(scale)
}

function mapBlock() {
  const el = h('div', { class: 'card map' })
  const paint = () => {
    const data = mapData
    const head = h('div', { class: 'card-head' }, h('h3', { text: '脚下的俯视图' }), h('span', { class: 'muted', text: data?.available ? `${data.width}×${data.depth} 格，上北` : '' }))
    if (!data) return el.replaceChildren(head, h('p', { class: 'muted', text: '正在看…' }))
    if (!data.available) return el.replaceChildren(head, h('p', { class: 'muted', text: `看不到：${data.reason}` }))
    const canvas = h('canvas', { class: 'map-canvas', role: 'img', 'aria-label': '它周围地表的俯视图' })
    const note = h('p', { class: 'hint map-note', text: '白色箭头是它（朝着箭头的方向），黄点是玩家。鼠标移上去看是什么方块。' })
    drawMap(canvas, data)
    canvas.addEventListener('mousemove', (ev) => {
      const scale = Number(canvas.dataset.scale)
      const rect = canvas.getBoundingClientRect()
      const x = Math.floor((ev.clientX - rect.left) / scale)
      const z = Math.floor((ev.clientY - rect.top) / scale)
      const i = z * data.width + x
      const kind = data.palette[data.tops[i]]
      note.textContent = kind ? `${kind.name ?? kind.id}（${data.x1 + x}, ${data.heights[i]}, ${data.z1 + z}）${kind.known ? '' : ' · 颜色表里没有它，颜色只是用来区分'}` : `（${data.x1 + x}, ${data.z1 + z}）没有地表，或者区块没加载`
    })
    el.replaceChildren(head, canvas, note, data.unloaded > 0 ? h('p', { class: 'hint', text: `有 ${data.unloaded} 列在没加载的区块里，画成了暗色。` }) : null)
  }
  el.paint = paint
  paint()
  return el
}

async function pollMap() {
  if (!root || root.hidden || document.hidden) return
  try {
    mapData = await api('GET', '/minimap')
  } catch (e) {
    if (e.status === 401) return
    mapData = { available: false, reason: e.message }
  }
  root.querySelector('.card.map')?.paint?.()
}

function renderLive(el) {
  const live = state.live
  if (!live) return el.replaceChildren(h('div', { class: 'card' }, h('p', { class: 'muted', text: '正在看游戏里的它…' })))
  if (!live.online) {
    const connected = live.connected
    el.replaceChildren(
      h(
        'div',
        { class: 'card' },
        empty(connected ? `${live.name} 不在线` : '没连上游戏', connected ? '它不在游戏里，所以看不到血量、位置和背包。点左上角的“上线”让它进入游戏。' : `${live.reason ?? ''}。连接在“设置 → 游戏连接”里配。`),
        connected ? h('div', { class: 'row center' }, button('上线', { class: 'primary' }, (btn) => act(btn, actions.spawn, '已让它上线').then(refresh))) : h('div', { class: 'row center' }, h('a', { class: 'button', href: '#settings/game', text: '去设置' })),
      ),
      connected && (live.players ?? []).length > 0 ? playersBlock(live) : null,
    )
    return
  }
  const pickedSlot = picked ? ((live.inventory ?? []).find((s) => s.slot === picked.slot && picked.where === 'inv') ?? (live.screen?.slots ?? []).find((s) => s.slot === picked.slot && picked.where === 'screen')) : null
  const detail = h('div', { class: 'slot-detail-box' }, slotDetail(pickedSlot ?? null))
  const pick = (where) => (slot) => {
    picked = slot.slot !== undefined ? { where, slot: slot.slot } : null
    detail.replaceChildren(slotDetail(slot))
  }
  const map = el.querySelector('.card.map') ?? mapBlock()
  el.replaceChildren(
    h('div', { class: 'card game' }, hud(live)),
    h('div', { class: 'mc-wrap' }, inventoryPanel(live, pick('inv')), live.screen ? screenPanel(live.screen, live.looks, pick('screen')) : null, detail),
    playersBlock(live),
    map,
  )
}

// ── 进出这一页 ──

function paint(force = false) {
  if (!root || root.hidden) return
  const s = state.status
  const owner = bodyAgent(s)
  const stale = taskStaleMs(owner?.body?.task) > STALE_TASK_MS
  const slow = (s?.agents ?? []).some((a) => modelState(a).slow)
  const timeline = getTimeline()
  const turnOfNow = (s?.agents ?? []).map((a) => timeline.turns.get(a.turn?.id)?.trigger ?? '')
  const nextWork = JSON.stringify([s?.agents, state.overview?.tasks?.recent, state.overview?.provider, state.error, stale, slow, turnOfNow])
  if (force || nextWork !== workKey) {
    workKey = nextWork
    renderWork(root.querySelector('.now-work'))
  }
  const live = state.live
  const nextLive = JSON.stringify(live ? { ...live, time: 0 } : null)
  if (force || nextLive !== liveKey) {
    liveKey = nextLive
    renderLive(root.querySelector('.now-game'))
  }
}

function paintFeed() {
  if (!root || root.hidden) return
  const { items } = getTimeline()
  const last = items[items.length - 1]
  const next = `${items.length}:${last?.key}:${last?.rev}`
  if (next === feedKey) return
  feedKey = next
  renderFeed(root.querySelector('.now-feed'))
}

export function enter(el) {
  root = el
  if (el.childElementCount === 0) {
    el.append(
      h('div', { class: 'now-left' }, h('div', { class: 'now-work' }), h('div', { class: 'card now-feed' }), h('div', { class: 'card now-say' })),
      h('div', { class: 'now-game', 'aria-label': '游戏里的它' }),
    )
  }
  renderSay(el.querySelector('.now-say'))
  workKey = liveKey = feedKey = ''
  paint(true)
  paintFeed()
  unsubscribe = [bus.on('status', () => paint()), bus.on('overview', () => paint()), bus.on('live', () => paint()), bus.on('status-error', () => paint()), bus.on('log', () => (paintFeed(), paint()))]
  pollMap()
  clearInterval(mapTimer)
  mapTimer = setInterval(pollMap, 5000)
}

export function leave() {
  for (const off of unsubscribe) off()
  unsubscribe = []
  clearInterval(mapTimer)
}

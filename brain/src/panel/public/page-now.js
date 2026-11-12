// “现在”页：一眼看出它此刻在干什么、是不是卡住了，和游戏里的它是什么样子。
//   左边：一句话的现状；每条线的细节（模型想到第几步、例程调到哪了、身体的任务和排队的）；最近几步；最近说的话，可以直接回它一句。
//   右边：游戏里的样子——血量和饥饿、位置朝向、物品栏（和游戏里一样的格子）、开着的界面、附近的人、脚下的俯视图。

import { actions, agentLabel, bodyAgent, presenceOf, refresh, serverNow, state, watchLiveClosely } from './data.js'
import { foodBar, hearts, inventoryPanel, screenPanel, slotDetail } from './items.js'
import { addForm, keepFocus, todoRow, todoUi } from './todo.js'
import { renderHelpers } from './helpers.js'
import { CLOSING_HINT, closingNow, describeArgs, recentActivity } from './logmodel.js'
import { itemName } from './names.js'
import { getTimeline } from './logstore.js'
import { STALE_TASK_MS, modelState, taskProgress, taskStaleMs } from './side.js'
import { act, api, badge, bearing, bus, button, clock, compact, dimName, duration, empty, facing, gameClock, h, kv, num, pos, progressBar, put, TASK_STATES, taskName, when } from './ui.js'

let root = null
let unsubscribe = []
let workKey = ''
let liveKey = ''
let feedKey = ''
let helpersKey = ''
let picked = null
let mapTimer
let mapData = null

const RUN_STATES = { running: '在跑', done: '跑完了', failed: '出错停了', stopped: '被停掉了', limit: '到上限停了' }

// ── 左边：它在干什么 ──
// 左边常驻的状态卡是摘要；这里只放那边放不下的：这一轮的起因和已经用的时间、上一步调了什么、等回答的全文、
// 例程的实时计数和正在等的那一步、身体任务的进度和排队。模型名、上一次调用这类不常看的收在最下面的折叠里。

/** 一句话的现状。最要紧的在前：故障 > 等回答 > 在想 > 在执行工具 > 例程 > 身体 > 空闲。 */
function headline() {
  const agents = state.status?.agents ?? []
  if (state.lostAt !== null) return { tone: 'bad', text: '连不上大脑进程', since: state.lostAt, sub: '它可能没在运行。下面是断开前最后看到的样子；连上以后这里会自己恢复。' }
  if (agents.length === 0) return { tone: 'idle', text: '正在问大脑…', sub: '' }
  const owner = bodyAgent(state.status)
  const many = agents.length > 1
  const name = (a) => (many ? agentLabel(a) : '')
  for (const a of agents) {
    const m = a.model ?? {}
    if (m.state === 'outage') return { tone: 'bad', text: `${name(a)}模型接口故障`, sub: m.outage ? `连着失败 ${m.outage.failures} 次，${clock(m.outage.nextRetryAt)} 再试：${m.outage.lastError}` : '' }
  }
  for (const a of agents) {
    // 干活线提了问还没人回答：整件事停在这里
    if (a.waitingAnswer) return { tone: 'warn', text: `${agentLabel(a)}在等回答`, since: a.waitingAnswer.since, sub: '它提了个问题，没人回答它就不往下干。问题在下面。' }
  }
  for (const a of [...agents].reverse()) {
    const s = modelState(a)
    if (a.model?.state === 'thinking') return { tone: s.slow ? 'warn' : 'think', text: `${name(a)}${s.text}`, since: s.since, sub: s.slow ? s.hint : '' }
    if (a.model?.state === 'tools') return { tone: 'tools', text: `${name(a)}${s.text}`, sub: '' }
  }
  const r = owner?.routine
  if (r) return { tone: 'routine', text: `例程 ${r.id} 在后台跑`, since: r.startedAt, sub: r.name || '' }
  const task = owner?.body?.task
  if (task) {
    const stale = taskStaleMs(task)
    return { tone: stale > STALE_TASK_MS ? 'warn' : 'body', text: `身体在${taskName(task.type)}`, sub: stale > STALE_TASK_MS ? `任务进度已经 ${duration(stale)}没动，可能卡住了。` : '模型没在想：任务由身体自己做完，做完再叫醒它。' }
  }
  // 两条线都闲着、子思维还在想：它想完了会叫醒对话线
  const thinking = state.status?.helpers?.running ?? []
  if (thinking.length > 0) return { tone: 'think', text: `子思维在想（${thinking.length} 个）`, since: Math.min(...thinking.map((r) => r.startedAt)), sub: '对话线派出去查东西、想事的那部分心思。想完了交回的话会叫醒对话线。' }
  const last = agents.map((a) => a.model?.lastCall?.time).filter((t) => typeof t === 'number').sort((x, y) => y - x)[0]
  if (!state.overview?.provider && state.overview) return { tone: 'bad', text: '还没配模型', sub: '到“设置 → 模型”添加一个，它才能思考。' }
  // 两轮之间的那一小会儿：有事排着，它马上就开始下一轮
  const queued = agents.reduce((n, a) => n + (a.pending > 0 ? a.pending : 0), 0)
  if (queued > 0) return { tone: 'think', text: '马上开始下一轮', sub: `有 ${queued} 件事排着等它。` }
  return { tone: 'idle', text: '空闲', sub: last ? `上一次调模型是 ${when(last)}。` : '还没调用过模型。' }
}

/** 干活线送给对话线的几种话。 */
const REPORT_TYPES = { report: '汇报', question: '提问', result: '停下来时留的话', progress: '还在干、中途留的话', trouble: '出了状况' }

function lastCallText(lc) {
  if (!lc) return '还没调用过'
  if (lc.ok === false) return h('span', { class: 'bad', text: `${when(lc.time)} 失败（${lc.errorKind ?? '?'}）：${lc.error ?? ''}` })
  return `${when(lc.time)} · ${duration(lc.durationMs)} · 入 ${compact(lc.inputTokens)}${lc.cacheReadTokens ? `（缓存 ${compact(lc.cacheReadTokens)}）` : ''} / 出 ${compact(lc.outputTokens)}`
}

/** 一步里调的工具，一行一个：名字、读得懂的参数、结果的头一行。 */
function toolLines(step) {
  return step.tools.map((t) =>
    h(
      'div',
      { class: `now-tool${t.isError ? ' is-error' : ''}${t.pending ? ' pending' : ''}` },
      h('span', { class: 'feed-tool', text: t.name }),
      h('span', { class: 'now-tool-args', text: describeArgs(t.argsDetail ?? t.args, itemName) ?? t.args ?? '' }),
      h('span', { class: 'now-tool-result', text: t.pending ? '（还没回来）' : `→ ${t.result ?? ''}` }),
    ),
  )
}

/** 正在跑的一轮：起因、用了多久、上一步调了什么、现在这一步。 */
function turnCard(agent, many) {
  const turn = agent.turn
  const m = agent.model ?? {}
  const s = modelState(agent)
  const seen = getTimeline().turns.get(turn.id)
  const about = turn.about ?? seen?.trigger
  const steps = (seen?.parts ?? []).flatMap((p) => p.steps)
  const nowStep = steps.find((x) => x.n === m.step)
  const done = steps.filter((x) => x !== nowStep && x.tools.length > 0)
  const prev = done[done.length - 1]
  return h(
    'div',
    { class: 'card now-card' },
    h(
      'div',
      { class: 'now-card-head' },
      h('span', { class: `tag ${agent.agent === 'talk' ? 'talk' : 'model'}`, text: many ? agentLabel(agent) : '模型' }),
      h('strong', { text: `第 ${turn.id} 轮` }),
      h('span', { class: 'muted', text: `已经 ${turn.steps ?? 0}${turn.maxSteps ? ` / ${turn.maxSteps}` : ''} 步` }),
      closingNow(turn) ? h('span', { class: 'chip warn', title: CLOSING_HINT, text: '到了上限，在收尾' }) : null,
      turn.startedAt ? h('span', { class: 'muted', 'data-since': turn.startedAt, 'data-label': '这一轮已经', text: `这一轮已经 ${duration(Math.max(0, serverNow() - turn.startedAt))}` }) : null,
    ),
    about ? h('div', { class: 'now-row' }, h('span', { class: 'now-key', text: '起因' }), h('span', { class: 'now-val', text: about })) : null,
    prev
      ? h('div', { class: 'now-row' }, h('span', { class: 'now-key', text: prev.n !== undefined ? `第 ${prev.n} 步` : '上一步' }), h('div', { class: 'now-val' }, toolLines(prev)))
      : null,
    h(
      'div',
      { class: 'now-row' },
      h('span', { class: 'now-key', text: '现在' }),
      h(
        'div',
        { class: 'now-val' },
        h('span', { class: `state ${s.tone}`, title: s.hint ?? '', ...(s.since !== undefined ? { 'data-since': s.since, 'data-label': s.text } : {}), text: s.since !== undefined ? `${s.text} ${duration(Math.max(0, serverNow() - s.since))}` : s.text }),
        m.state === 'tools' && nowStep ? toolLines(nowStep) : null,
      ),
    ),
    agent.pending > 0 ? h('div', { class: 'now-row' }, h('span', { class: 'now-key', text: '排着队' }), h('span', { class: 'now-val', text: `还有 ${agent.pending} 件事等它处理（这一步完了就看到）` })) : null,
  )
}

/** 干活线提了问、还没人回答。 */
function waitingCard(agent) {
  const w = agent.waitingAnswer
  return h(
    'div',
    { class: 'card now-card waiting-card', role: 'status' },
    h('div', { class: 'now-card-head' }, h('span', { class: 'tag work', text: agentLabel(agent) }), h('strong', { text: '它在问' }), h('span', { class: 'state warn', 'data-since': w.since, 'data-label': '已经等了', text: `已经等了 ${duration(Math.max(0, serverNow() - w.since))}` })),
    h('p', { class: 'waiting-question', text: w.text }),
    h(
      'div',
      { class: 'row' },
      button('去回答', { class: 'primary' }, () => {
        location.hash = '#chat'
        setTimeout(() => document.querySelector('.composer textarea')?.focus(), 80)
      }),
      h('span', { class: 'hint', text: '在对话页（或者下面那行输入框）回它一句，对话线会带话过去。' }),
    ),
  )
}

/** “withdraw_items {…}” → 工具名和读得懂的参数。 */
function waitingText(waiting) {
  const at = waiting.indexOf(' ')
  const tool = at > 0 ? waiting.slice(0, at) : waiting
  const raw = at > 0 ? waiting.slice(at + 1) : ''
  return [h('span', { class: 'feed-tool', text: tool }), h('span', { class: 'now-tool-args', text: describeArgs(raw, itemName) ?? raw })]
}

function routineCard(agent) {
  const r = agent.routine
  const now = serverNow()
  const stuck = typeof r.waitingSince === 'number' && now - r.waitingSince > STALE_TASK_MS
  return h(
    'div',
    { class: 'card now-card' },
    h(
      'div',
      { class: 'now-card-head' },
      h('span', { class: 'tag routine', text: '例程' }),
      h('strong', null, h('span', { class: 'mono', text: `${r.id} ` }), r.name || '（没有名字）'),
      h('span', { class: 'state routine', 'data-since': r.startedAt, 'data-label': '在跑', text: `在跑 ${duration(Math.max(0, now - r.startedAt))}` }),
      typeof r.limitMs === 'number' ? h('span', { class: 'muted', text: `最多 ${duration(r.limitMs)}` }) : null,
      h('span', { class: 'spacer' }),
      button('停止例程', { class: 'small danger', title: '停掉它；它正在做的任务也取消，模型会被叫醒看结果' }, (btn) => act(btn, actions.stopRoutine, '已停止例程').then(refresh)),
    ),
    h('div', { class: 'counters' }, counter(num(r.calls), '次工具调用'), counter(num(r.tasks), '个任务'), counter(num(r.errors ?? 0), '次出错', (r.errors ?? 0) > 0 ? 'bad' : '')),
    r.waiting
      ? h(
          'div',
          { class: 'now-row' },
          h('span', { class: 'now-key', text: '正在等' }),
          h('div', { class: 'now-val now-tool' }, waitingText(r.waiting), typeof r.waitingSince === 'number' ? h('span', { class: stuck ? 'state warn' : 'muted', title: stuck ? '这一步已经等了很久，可能卡住了' : '', 'data-since': r.waitingSince, 'data-label': '已经', text: `已经 ${duration(Math.max(0, now - r.waitingSince))}` }) : null),
        )
      : null,
    h('p', { class: 'hint' }, '每一步的参数和结果在', h('a', { href: '#chat', text: '对话页' }), '这次运行的那一块里（点开“每一步”）。'),
  )
}

function counter(value, label, tone = '') {
  return h('div', { class: `counter ${tone}` }, h('span', { class: 'counter-n', text: value }), h('span', { class: 'counter-label', text: label }))
}

function taskLine(t) {
  const p = t.progress
  const progress = p && typeof p.done === 'number' && typeof p.total === 'number' && p.total > 0 ? ` ${p.done}/${p.total}` : ''
  return `${taskName(t.type)}${progress}`
}

const cancelButton = (id, label = '取消') => button(label, { class: 'small danger' }, (btn) => act(btn, () => actions.cancelTask(id), id ? '已取消' : '已全部取消').then(refresh))

function bodyCard(agent) {
  const body = agent.body ?? {}
  const task = body.task
  const queue = body.queue ?? []
  const stale = taskStaleMs(task)
  const p = task?.progress
  return h(
    'div',
    { class: 'card now-card' },
    h(
      'div',
      { class: 'now-card-head' },
      h('span', { class: 'tag body', text: '身体' }),
      task ? h('strong', { text: taskLine(task) }) : h('strong', { text: `排着 ${queue.length} 个任务` }),
      task ? h('span', { class: 'mono muted', text: `${task.type} · ${task.id}` }) : null,
      task?.startedAt ? h('span', { class: 'muted', 'data-since': task.startedAt, 'data-label': '已经', text: `已经 ${duration(Math.max(0, serverNow() - task.startedAt))}` }) : null,
      h('span', { class: 'spacer' }),
      cancelButton(undefined, queue.length > 0 ? '全部取消' : '取消'),
    ),
    task ? progressBar(taskProgress(task), stale > STALE_TASK_MS ? 'warn' : 'body') : null,
    task && (stale > STALE_TASK_MS || p?.phase || p?.note)
      ? h('p', { class: stale > STALE_TASK_MS ? 'warn' : 'muted', title: stale > STALE_TASK_MS ? '身体报的进度一直是同一个数' : '', text: stale > STALE_TASK_MS ? `任务进度已经 ${duration(stale)}没动，可能卡住了。${p?.phase ?? ''}` : [p.phase, p.note].filter(Boolean).join(' · ') })
      : null,
    queue.length > 0 ? [h('h4', { text: `后面排着（${queue.length}）` }), h('ul', { class: 'plain' }, queue.map((t) => h('li', null, h('span', { class: 'grow' }, taskLine(t), h('span', { class: 'mono muted', text: `  ${t.type} · ${t.id}` })), cancelButton(t.id))))] : null,
  )
}

/** 不常看的：每条线用的模型、上一次调用、记得多少；上一个例程；最近结束的任务。 */
function detailsFold(agents, owner) {
  const many = agents.length > 1
  const recent = [...(state.overview?.tasks?.recent ?? [])].sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0)).slice(0, 6)
  const last = owner?.lastRoutine
  const el = h(
    'details',
    { class: 'card fold now-more', open: moreOpen },
    h('summary', { text: '模型、上一个例程、最近结束的任务' }),
    agents.map((a) => {
      const m = a.model ?? {}
      const hist = a.history
      return [
        many ? h('h4', { text: agentLabel(a) }) : null,
        kv([
          ['用的模型', m.provider || m.model ? `${m.provider ?? '?'} / ${m.model ?? '?'}` : h('span', { class: 'bad', text: '还没配置' })],
          ['上一次调用', lastCallText(m.lastCall)],
          m.state === 'outage' && m.outage ? ['故障', h('span', { class: 'bad', text: `从 ${when(m.outage.since)} 起连着失败 ${m.outage.failures} 次，${clock(m.outage.nextRetryAt)} 再试。${m.outage.lastError}` })] : null,
          hist ? ['它记得的', `${hist.turns} 轮，约 ${compact(hist.estimatedTokens)} token${hist.threshold ? `（到 ${compact(hist.threshold)} 就压缩）` : ''}${hist.hasSummary ? '，更早的已压成摘要' : ''}`] : null,
          a.lastReport ? ['上一次送给对话线的', `${when(a.lastReport.time)}，${REPORT_TYPES[a.lastReport.type] ?? a.lastReport.type}：${a.lastReport.text}`] : null,
        ]),
      ]
    }),
    last
      ? [
          h('h4', { text: '上一个例程' }),
          kv([
            ['哪一个', h('span', null, h('span', { class: 'mono', text: `${last.id} ` }), last.name || '（没有名字）')],
            ['结果', `${RUN_STATES[last.status] ?? last.status}${last.endedAt ? `，${when(last.endedAt)}` : ''}：调了 ${num(last.calls)} 次工具，开了 ${num(last.tasks)} 个任务${last.waits > 0 ? `，等了 ${last.waits} 次共 ${Math.round((Number(last.waitedMs) || 0) / 100) / 10} 秒` : ''}${last.errors > 0 ? `，${last.errors} 次出错` : ''}`],
            last.endingText || last.ending ? ['怎么结束的', last.endingText ?? last.ending] : null,
          ]),
        ]
      : null,
    recent.length > 0
      ? [
          h('h4', { text: '最近结束的任务' }),
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
        ]
      : null,
  )
  el.addEventListener('toggle', () => (moreOpen = el.open))
  return el
}

let moreOpen = false

function renderWork(el) {
  const agents = state.status?.agents ?? []
  const owner = bodyAgent(state.status)
  const head = headline()
  const many = agents.length > 1
  const body = owner?.body ?? {}
  const quiet = []
  if (owner && !owner.routine) quiet.push('没有在跑的例程')
  if (owner && !body.task && (body.queue ?? []).length === 0) quiet.push(body.error ? `身体看不到（${body.error}）` : '身体没有任务')
  put(
    el,
    h(
      'div',
      { class: `now-head ${head.tone}` },
      h('div', { class: 'now-headline' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), h('span', { class: 'now-text', text: head.text }), head.since !== undefined ? h('span', { class: 'now-since', 'data-since': head.since, 'data-label': '已经', text: `已经 ${duration(Math.max(0, serverNow() - head.since))}` }) : null),
      head.sub ? h('div', { class: 'now-sub', text: head.sub }) : null,
    ),
    agents.filter((a) => a.waitingAnswer).map(waitingCard),
    agents.filter((a) => a.turn).map((a) => turnCard(a, many)),
    owner?.routine ? routineCard(owner) : null,
    owner && (body.task || (body.queue ?? []).length > 0) ? bodyCard(owner) : null,
    quiet.length > 0 && agents.length > 0 ? h('p', { class: 'now-quiet muted', text: `${quiet.join('；')}。` }) : null,
    agents.length > 0 ? detailsFold(agents, owner) : null,
  )
}

// ── 左边：工作清单上还没做完的 ──

/** 最多列几条（再多的去清单页看）。 */
const TODO_SHOWN = 8

function renderTodo(el) {
  const data = state.todo
  if (!data || !data.available) return put(el)
  const pending = (data.items ?? []).filter((i) => i.state !== 'done')
  const c = data.counts ?? {}
  keepFocus(el, () =>
    put(
      el,
      h(
        'div',
        { class: 'card now-todo' },
        h('div', { class: 'card-head' }, h('h3', null, '工作清单', h('span', { class: 'muted count-note', text: pending.length > 0 ? ` 没做 ${c.open ?? 0} · 在等人 ${c.waiting ?? 0}` : '' })), h('a', { class: 'more', href: '#todo', text: (c.done ?? 0) > 0 ? `去清单页（还有做完的 ${c.done} 条）` : '去清单页' })),
        pending.length === 0 ? h('p', { class: 'muted', text: '清单上没有要做的事。' }) : h('ul', { class: 'todo-list' }, pending.slice(0, TODO_SHOWN).map((i) => todoRow(i, { compact: true }))),
        pending.length > TODO_SHOWN ? h('p', { class: 'hint' }, `还有 ${pending.length - TODO_SHOWN} 条，`, h('a', { href: '#todo', text: '去清单页看' })) : null,
        addForm(),
      ),
    ),
  )
}

// ── 左边：最近几步、最近说的话 ──

const FEED_TAGS = { say: ['', 'say'], heard: ['', 'heard'], step: ['模型', 'model'], tool: ['', 'model'], run: ['', 'routine'], relay: ['', 'relay'], error: ['出错', 'bad'] }

function renderFeed(el) {
  const { items } = getTimeline()
  const live = new Set((state.status?.agents ?? []).map((a) => a.turn?.id ?? a.model?.turn).filter((id) => id !== undefined))
  // 在想的子思维：它那一段的编号是 h:h3
  for (const r of state.status?.helpers?.running ?? []) live.add(`h:${r.id}`)
  const rows = recentActivity(items, 14, live)
  put(el, 
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
              { class: `feed-row k-${r.kind}${r.isError ? ' is-error' : ''}${r.pending && (r.kind !== 'tool' || live.has(r.turn)) ? ' pending' : ''}` },
              h('time', { class: 'time', text: clock(r.time) }),
              r.kind === 'tool' ? h('span', { class: 'feed-tool', text: r.label }) : h('span', { class: `tag ${tone}${r.channel ? ` at-${r.channel}` : ''}`, title: r.program ? '程序替它说的，不是模型写的' : '', text: `${label || r.label}${r.program ? '·代说' : ''}` }),
              h('span', { class: 'feed-text' }, r.kind === 'tool' && r.args ? h('span', { class: 'feed-args', text: `${describeArgs(r.argsFull ?? r.args, itemName) ?? r.args.slice(0, 48)} ` }) : null, r.kind !== 'tool' ? r.text : r.pending ? (live.has(r.turn) ? '（还没回来）' : '（没有结果的记录）') : `→ ${r.text}`),
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
    if (!data) return put(el, head, h('p', { class: 'muted', text: '正在看…' }))
    if (!data.available) return put(el, head, h('p', { class: 'muted', text: `看不到：${data.reason}` }))
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
    put(el, head, canvas, note, data.unloaded > 0 ? h('p', { class: 'hint', text: `有 ${data.unloaded} 列在没加载的区块里，画成了暗色。` }) : null)
  }
  el.paint = paint
  paint()
  return el
}

/** 俯视图那张卡在不在视口里（不在就不去问身体）。 */
let mapVisible = false
let mapSeen
let lastMapAt = 0
/** 俯视图多久重取一次。 */
const MAP_EVERY_MS = 10_000

async function pollMap() {
  if (!root || root.hidden || document.hidden || !mapVisible) return
  lastMapAt = Date.now()
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
  if (!live) return put(el, h('div', { class: 'card' }, h('p', { class: 'muted', text: '正在看游戏里的它…' })))
  if (!live.online) {
    const connected = live.connected
    put(el, 
      h(
        'div',
        { class: 'card' },
        connected && presenceOf().why === 'idle'
          ? empty('没人在，它自己下线了', '“自动上下线”开着：服务器上没有真人、它手上也没事，它就下线了。有真人进服、你在这里发指令、它定的提醒到点时会自己回来；也可以现在点“上线”。')
          : empty(connected ? `${live.name} 不在线` : '没连上游戏', connected ? '它不在游戏里，所以看不到血量、位置和背包。点左上角的“上线”让它进入游戏。' : `${live.reason ?? ''}。连接在“设置 → 游戏连接”里配。`),
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
    put(detail, slotDetail(slot))
  }
  let map = el.querySelector('.card.map')
  if (!map) {
    map = mapBlock()
    // 滚到看得见它的时候才去取（world.scan 一次要看两千多列），看不见就停
    mapSeen?.disconnect()
    mapSeen = new IntersectionObserver((entries) => {
      mapVisible = entries.some((e) => e.isIntersecting)
      if (mapVisible && Date.now() - lastMapAt > MAP_EVERY_MS) pollMap()
    })
    mapSeen.observe(map)
  }
  put(el, 
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
  const turnOfNow = (s?.agents ?? []).map((a) => timeline.turns.get(a.turn?.id)?.rev ?? '')
  const nextWork = JSON.stringify([s?.agents, state.overview?.tasks?.recent, state.overview?.provider, state.error, state.lostAt, stale, slow, turnOfNow])
  if (force || nextWork !== workKey) {
    workKey = nextWork
    renderWork(root.querySelector('.now-work'))
  }
  const live = state.live
  const nextLive = JSON.stringify([live ? { ...live, time: 0 } : null, live?.online ? null : presenceOf().why])
  if (force || nextLive !== liveKey) {
    liveKey = nextLive
    renderLive(root.querySelector('.now-game'))
  }
}

/** 子思维那一块：列表变了（多走了一步、结束了）才重画，免得展开着的过程一秒重画一次。 */
function paintHelpers(force = false) {
  if (!root || root.hidden) return
  const next = JSON.stringify(state.status?.helpers ?? null)
  if (!force && next === helpersKey) return
  helpersKey = next
  renderHelpers(root.querySelector('.now-helpers'), () => paintHelpers(true))
}

function paintFeed() {
  if (!root || root.hidden) return
  const { items } = getTimeline()
  const last = items[items.length - 1]
  const next = `${items.length}:${last?.key}:${last?.rev}:${(state.status?.agents ?? []).map((a) => a.turn?.id ?? '').join(',')}`
  if (next === feedKey) return
  feedKey = next
  renderFeed(root.querySelector('.now-feed'))
}

export function enter(el) {
  root = el
  // 同一页里换一块也会再进来一次：先把上一次接的通知退掉
  for (const off of unsubscribe) off()
  unsubscribe = []
  if (el.childElementCount === 0) {
    el.append(
      h('div', { class: 'now-left' }, h('div', { class: 'now-work' }), h('div', { class: 'now-helpers' }), h('div', { class: 'now-todo-wrap' }), h('div', { class: 'card now-feed' }), h('div', { class: 'card now-say' })),
      h('div', { class: 'now-game', 'aria-label': '游戏里的它' }),
    )
  }
  renderSay(el.querySelector('.now-say'))
  // 这一页没有地方改一条（只能勾掉），清单变了整块重画
  todoUi.onChange = () => renderTodo(el.querySelector('.now-todo-wrap'))
  todoUi.onChange()
  workKey = liveKey = feedKey = helpersKey = ''
  paint(true)
  paintFeed()
  paintHelpers(true)
  unsubscribe = [
    bus.on('status', () => (paint(), paintFeed(), paintHelpers())),
    bus.on('overview', () => paint()),
    bus.on('live', () => paint()),
    bus.on('status-error', () => paint()),
    bus.on('log', () => (paintFeed(), paint())),
    bus.on('todo', () => todoUi.onChange()),
    bus.on('names', () => {
      feedKey = ''
      paintFeed()
      paint(true)
    }),
  ]
  watchLiveClosely(true)
  if (Date.now() - lastMapAt > MAP_EVERY_MS) pollMap()
  clearInterval(mapTimer)
  mapTimer = setInterval(pollMap, MAP_EVERY_MS)
}

export function leave() {
  for (const off of unsubscribe) off()
  unsubscribe = []
  clearInterval(mapTimer)
  watchLiveClosely(false)
}

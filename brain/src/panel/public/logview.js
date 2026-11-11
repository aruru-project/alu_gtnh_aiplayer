// 把时间线（logmodel.js）画到页面上：左边是对话那条线，右边是干活那条线，一行一行对齐；窄屏时两条线叠成一列。
// 一轮决策默认收成一行汇总，点开看模型的每一步，再点开看每个工具的参数和结果；最新的那一轮自己开着。
// 开合的状态记在这个模块里（按键），所以重画、切页都不丢。

import { actions, agentLabel, serverNow, state } from './data.js'
import { LEVEL, layoutRows, toolHistogram } from './logmodel.js'
import { act, api, button, clock, compact, dateTime, dayLabel, duration, h, reconcile, sameDay } from './ui.js'
import { playerHead } from './items.js'
import { createViewer } from './viewer3d.js'

/** 开合的状态：键 → 开着没有。没记过的用默认值。 */
const openState = new Map()
const isOpen = (key, fallback) => openState.get(key) ?? fallback

const RUN_STATES = { running: '在跑', done: '跑完了', failed: '出错停了', stopped: '被停掉了', limit: '到上限停了' }
const RUN_TONES = { running: 'live', done: 'ok', failed: 'bad', stopped: 'warn', limit: 'warn' }
const STOP_REASONS = { tool_calls: '要调工具', end: '说完了', truncated: '被输出上限截断', other: '别的原因停下', error: '出错' }

/** 玩家名字的颜色：由名字定，同一个人总是同一种。 */
function nameHue(name) {
  let x = 7
  for (const ch of String(name)) x = (x * 31 + ch.codePointAt(0)) >>> 0
  return x % 360
}

const time = (ms) => h('time', { class: 'time', title: dateTime(ms), text: clock(ms) })

function tokensText(input, output, cache) {
  if (typeof input !== 'number') return ''
  return `入 ${compact(input)}${cache ? `（缓存 ${compact(cache)}）` : ''} · 出 ${compact(output ?? 0)}`
}

/** 可折叠的一块长文字。 */
function fold(title, text, key, cls = '') {
  const pre = h('pre', { class: `code ${cls}` })
  const el = h('details', { class: 'fold', open: isOpen(key, false) }, h('summary', { text: title }), pre)
  const fill = () => {
    if (el.open && pre.textContent === '') pre.textContent = text
  }
  el.addEventListener('toggle', () => {
    openState.set(key, el.open)
    fill()
  })
  fill()
  return el
}

// ── 对话：一句话 ──

function renderMsg(item, prev) {
  const grouped = prev && prev.type === 'msg' && prev.role === item.role && prev.who === item.who && item.time - prev.time < 120000
  const who = item.role === 'owner' ? '你（面板）' : item.who
  const el = h('div', { class: `msg ${item.role}${item.whisper ? ' whisper' : ''}${grouped ? ' grouped' : ''}${item.role === 'player' && item.note ? ' unheard' : ''}` })
  if (!grouped) {
    const name = h('span', { class: 'who', text: who })
    if (item.role === 'player') name.style.color = `hsl(${nameHue(item.who)}, 55%, 70%)`
    el.append(h('div', { class: 'msg-meta' }, item.role === 'bot' ? playerHead(item.who, 2) : null, name, item.whisper ? h('span', { class: 'chip', text: '私聊' }) : null, time(item.time)))
  }
  const bubble = h('div', { class: 'bubble', text: item.text })
  if (grouped) bubble.title = dateTime(item.time)
  el.append(bubble)
  if (item.note) el.append(h('div', { class: 'msg-note', text: item.note }))
  return el
}

// ── 干活：工具、步、一轮 ──

/** 对话日志里同时只开一个三维预览（浏览器能开的 WebGL 画布有限）：开新的就把旧的收起来。 */
let logViewer = null
function closeLogViewer() {
  if (!logViewer) return
  logViewer.viewer?.destroy()
  logViewer.holder.replaceChildren()
  logViewer.button.textContent = '三维预览'
  logViewer = null
}
async function toggleLogViewer(id, holder, btn) {
  const wasOpen = logViewer?.id === id
  closeLogViewer()
  if (wasOpen) return
  const scene = await act(btn, () => api('GET', `/pictures/model?id=${encodeURIComponent(id)}`))
  if (!scene) return
  closeLogViewer()
  btn.textContent = '收起三维预览'
  logViewer = { id, holder, button: btn, viewer: createViewer(holder, scene) }
}

function pictures(tool) {
  return tool.pictures.map((id) => {
    const src = `/api/pictures/file?id=${encodeURIComponent(id)}`
    const img = h('img', { class: 'log-picture', src, alt: '工具结果带的图', loading: 'lazy' })
    const link = h('a', { href: src, target: '_blank', rel: 'noopener', title: '点开看原图' }, img)
    img.addEventListener('error', () => link.replaceWith(h('span', { class: 'muted', text: '（这张图已经清理掉了）' })))
    const box = h('div', { class: 'log-picture-box' }, link)
    // 简图还存着画它用的方块数据：可以打开一个能拖着转的三维预览
    if (tool.scenes.includes(id)) {
      const holder = h('div', { class: 'log-viewer' })
      box.append(h('div', { class: 'row' }, button('三维预览', { class: 'small' }, (btn) => toggleLogViewer(id, holder, btn))), holder)
    }
    return box
  })
}

function prettyArgs(tool) {
  const raw = tool.argsDetail ?? tool.args ?? ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function renderTool(tool) {
  if (tool.cross) return renderCross(tool)
  const key = `tool:${tool.key}`
  const tone = tool.pending ? 'pending' : tool.isError ? 'bad' : 'ok'
  const summary = h(
    'summary',
    null,
    h('span', { class: `dot ${tone}`, title: tool.pending ? '还没回来' : tool.isError ? '出错了' : '成功' }),
    h('span', { class: 'tool-name', text: tool.name }),
    tool.args !== undefined ? h('span', { class: 'tool-args', text: tool.args }) : null,
    h('span', { class: `tool-result${tool.isError ? ' bad' : ''}`, text: tool.pending ? '…' : `→ ${tool.result ?? ''}` }),
    typeof tool.ms === 'number' && !tool.pending ? h('span', { class: 'ms', text: duration(tool.ms) }) : null,
  )
  const body = h('div', { class: 'tool-body' })
  const el = h('details', { class: `tool ${tone}`, open: isOpen(key, false) }, summary, body)
  const fill = () => {
    if (!el.open || body.childElementCount > 0) return
    if (tool.args !== undefined) body.append(h('div', { class: 'label', text: '参数' }), h('pre', { class: 'code', text: prettyArgs(tool) }))
    if (!tool.pending) body.append(h('div', { class: 'label', text: tool.isError ? '结果（出错）' : '结果' }), h('pre', { class: `code${tool.isError ? ' bad' : ''}`, text: tool.resultDetail ?? tool.result ?? '' }))
  }
  el.addEventListener('toggle', () => {
    openState.set(key, el.open)
    fill()
  })
  fill()
  const out = [el]
  // 图不用点开就看得到：它看的就是这张
  if (tool.pictures.length > 0) out.push(h('div', { class: 'tool-pictures' }, pictures(tool)))
  if (tool.run) out.push(renderRun(tool.run, true))
  return out
}

/** 两条线之间的往来：画成一句带方向的话，不是一次工具调用。 */
function renderCross(tool) {
  const labels = { handoff: '交给干活线', report: tool.question ? '问对话线' : '向对话线汇报', stop: '叫停干活线' }
  return h(
    'div',
    { class: `cross ${tool.cross}${tool.question ? ' question' : ''}` },
    h('span', { class: 'cross-arrow', 'aria-hidden': 'true', text: tool.cross === 'report' ? '←' : tool.cross === 'stop' ? '■' : '→' }),
    h('span', { class: 'cross-label', text: labels[tool.cross] }),
    tool.crossText ? h('span', { class: 'cross-text', text: tool.crossText }) : null,
    time(tool.time),
  )
}

function stepHead(step, live) {
  const call = step.call
  const parts = []
  if (call) {
    if (call.state === 'thinking') {
      parts.push(live ? h('span', { class: 'thinking', 'data-since': call.startedAt ?? step.time, 'data-label': '正在想', text: '正在想…' }) : h('span', { class: 'muted', text: '想到一半就没有下文了' }))
    } else {
      if (typeof call.ms === 'number') parts.push(h('span', { text: duration(call.ms) }))
      const tokens = tokensText(call.inputTokens, call.outputTokens, call.cacheReadTokens)
      if (tokens) parts.push(h('span', { text: tokens }))
      if (call.state === 'failed') parts.push(h('span', { class: 'bad', text: `失败${call.errorKind ? `（${call.errorKind}）` : ''}：${call.error ?? ''}` }))
      else if (call.stop && call.stop !== 'tool_calls') parts.push(h('span', { class: call.stop === 'truncated' ? 'warn' : '', text: STOP_REASONS[call.stop] ?? call.stop }))
    }
  }
  return h('div', { class: 'step-head' }, h('span', { class: 'step-n', text: step.n !== undefined ? `第 ${step.n} 步` : '这一轮里' }), parts.flatMap((p, i) => (i === 0 ? [p] : [h('span', { class: 'sep', text: '·' }), p])))
}

function renderStep(step, live) {
  return h(
    'div',
    { class: `step${step.call?.state === 'failed' ? ' failed' : ''}` },
    // 旧日志没有每一步的账：不画步头，工具直接排
    step.call || step.n !== undefined ? stepHead(step, live) : null,
    step.texts.map((t) => h('div', { class: 'model-text', title: '模型写的文字。只有它用 say 说的才进游戏聊天' }, h('span', { class: 'label', text: '它写道' }), h('span', { text: t.text }))),
    step.tools.flatMap(renderTool),
    step.notes.map(renderInlineNote),
  )
}

function renderInlineNote(note) {
  return h('div', { class: `inline-note ${note.tone}` }, h('span', { class: 'chip', text: note.tone === 'error' ? '出错' : '说明' }), h('span', { text: note.text }), note.detail ? fold('详情', note.detail, `note:${note.id}`) : null)
}

/** 一轮收起来时的那行汇总：依次调了哪些工具（连着重复的并成 ×N），出错的标红。 */
function toolChips(turn) {
  const chips = []
  for (const part of turn.parts) {
    for (const step of part.steps) {
      for (const tool of step.tools) {
        const last = chips[chips.length - 1]
        if (last && last.name === tool.name && last.bad === tool.isError) last.n++
        else chips.push({ name: tool.name, n: 1, bad: tool.isError, cross: tool.cross })
      }
    }
  }
  return chips
}

function lastText(turn) {
  for (let p = turn.parts.length - 1; p >= 0; p--) {
    const steps = turn.parts[p].steps
    for (let s = steps.length - 1; s >= 0; s--) {
      const texts = steps[s].texts
      if (texts.length > 0) return texts[texts.length - 1].text
    }
  }
  return ''
}

function turnStats(turn, live) {
  const bits = []
  if (turn.calls !== undefined) bits.push(`${turn.calls} 步`)
  if (turn.tools > 0) bits.push(`${turn.tools} 次工具`)
  if (turn.startedAt !== undefined && turn.endedAt !== undefined) bits.push(duration(turn.endedAt - turn.startedAt))
  if (turn.hasTokens) bits.push(tokensText(turn.inputTokens, turn.outputTokens, turn.cacheReadTokens))
  const out = [h('span', { class: 'stats', text: bits.join(' · ') })]
  if (turn.errors > 0) out.push(h('span', { class: 'chip bad', text: `${turn.errors} 处出错` }))
  if (turn.open) out.push(live ? h('span', { class: 'chip live', 'data-since': turn.startedAt ?? turn.firstTime, 'data-label': '进行中', text: '进行中' }) : h('span', { class: 'chip', title: '没有这一轮结束的记录：多半是大脑重启时被打断了', text: '没有结束记录' }))
  return out
}

function renderWork(item, ctx) {
  const turn = item.turn
  const live = ctx.liveTurns.has(turn.id) && turn.open
  const open = isOpen(`turn:${turn.key}`, ctx.latestTurns.has(turn.key))
  const el = h('div', { class: `work${open ? ' open' : ''}${live ? ' live' : ''}${turn.errors > 0 ? ' has-error' : ''}` })
  if (item.index === 0) {
    const head = h(
      'button',
      { type: 'button', class: 'turn-head', 'aria-expanded': String(open), title: open ? '收起这一轮' : '展开看每一步' },
      h('span', { class: 'caret', 'aria-hidden': 'true' }),
      h('span', { class: 'tag model', text: state.status?.agents?.length > 1 ? agentLabel(item.agent ?? 'main') : '模型' }),
      h('span', { class: 'turn-title' }, h('span', { class: 'turn-n', text: `第 ${turn.id} 轮` }), turn.hasStart ? h('span', { class: 'turn-trigger', text: turn.trigger || '（没写是被什么叫醒的）' }) : h('span', { class: 'turn-trigger muted', text: '（开头在更早的记录里）' })),
      h('span', { class: 'turn-meta' }, time(turn.startedAt ?? turn.firstTime), turnStats(turn, live)),
    )
    head.addEventListener('click', () => {
      openState.set(`turn:${turn.key}`, !open)
      ctx.rerender()
    })
    el.append(head)
    if (!open) {
      const chips = toolChips(turn)
      const text = lastText(turn)
      if (chips.length > 0 || text) {
        el.append(
          h(
            'div',
            { class: 'turn-brief' },
            chips.length > 0 ? h('div', { class: 'tool-chips' }, chips.map((c) => h('span', { class: `tchip${c.bad ? ' bad' : ''}${c.cross ? ' cross' : ''}`, text: c.n > 1 ? `${c.name} ×${c.n}` : c.name }))) : null,
            text ? h('div', { class: 'turn-said', title: '这一轮最后模型写的文字', text }) : null,
          ),
        )
      }
    }
  }
  if (open) {
    const body = h('div', { class: 'work-body' })
    if (item.index === 0) {
      if (turn.model) body.append(h('div', { class: 'turn-model muted', text: `用的模型：${turn.model}` }))
      if (turn.seen) body.append(fold('这一轮开始时给模型看的内容', turn.seen, `seen:${turn.key}`))
    }
    body.append(...item.notes.map(renderInlineNote), ...item.steps.map((s) => renderStep(s, live)))
    if (body.childElementCount > 0) el.append(body)
  } else if (item.index > 0) {
    // 收起来的一轮：后面几段只留两条线之间的往来（它是连接两边的线索）
    const cross = item.steps.flatMap((s) => s.tools.filter((t) => t.cross))
    if (cross.length === 0) el.classList.add('blank')
    else el.append(h('div', { class: 'work-body' }, cross.map(renderCross)))
  } else {
    const cross = item.steps.flatMap((s) => s.tools.filter((t) => t.cross))
    if (cross.length > 0) el.append(h('div', { class: 'work-body' }, cross.map(renderCross)))
  }
  return el
}

// ── 它写的程序的一次运行 ──

const RECORDS_PAGE = 200
/** 新日志：一次运行的明细在后端（/api/runs/records）。这里记着每次运行已经读到哪了。 */
const runRecords = new Map()

function recordRow(rec) {
  if (rec.t === 'call') {
    const input = typeof rec.input === 'string' ? rec.input : JSON.stringify(rec.input ?? {})
    const first = String(rec.text ?? '').split('\n', 1)[0]
    const full = String(rec.text ?? '')
    const el = h(
      'details',
      { class: `tool ${rec.ok ? 'ok' : 'bad'}` },
      h('summary', null, h('span', { class: `dot ${rec.ok ? 'ok' : 'bad'}` }), h('span', { class: 'ms', text: `#${rec.n}` }), h('span', { class: 'tool-name', text: rec.tool }), h('span', { class: 'tool-args', text: input }), h('span', { class: `tool-result${rec.ok ? '' : ' bad'}`, text: `→ ${first}` }), h('span', { class: 'ms', text: duration(rec.ms) })),
    )
    el.addEventListener('toggle', () => {
      if (el.open && el.childElementCount === 1) {
        let pretty = input
        try {
          pretty = JSON.stringify(typeof rec.input === 'string' ? JSON.parse(rec.input) : rec.input, null, 2)
        } catch {
          /* 原样 */
        }
        el.append(h('div', { class: 'tool-body' }, h('div', { class: 'label', text: '参数' }), h('pre', { class: 'code', text: pretty }), h('div', { class: 'label', text: `结果${rec.task ? `（任务 ${rec.task}）` : ''}` }), h('pre', { class: `code${rec.ok ? '' : ' bad'}`, text: full })))
      }
    })
    return el
  }
  if (rec.t === 'log') return h('div', { class: 'run-log' }, h('span', { class: 'chip', text: 'log' }), h('span', { text: rec.text }))
  if (rec.t === 'end') return h('div', { class: 'run-log' }, h('span', { class: 'chip', text: '结束' }), h('span', { text: `${RUN_STATES[rec.status] ?? rec.status}：${rec.ending ?? ''}${rec.value !== undefined ? `；返回 ${rec.value}` : ''}` }))
  return null
}

/** 新日志的明细：点开时去取，一页一页往后读；还在跑的，读到头以后可以接着读新的。 */
function remoteCalls(item) {
  const run = item.run
  const id = run.file ?? run.id
  const box = h('div', { class: 'run-calls' })
  const more = h('div', { class: 'row' })
  const data = runRecords.get(id) ?? { next: 0, total: undefined, rows: [], error: null }
  runRecords.set(id, data)
  const paint = () => {
    box.replaceChildren(...data.rows.map(recordRow).filter(Boolean))
    const left = data.total !== undefined ? data.total - data.next : undefined
    more.replaceChildren()
    if (data.error) more.append(h('span', { class: 'bad', text: `明细没取到：${data.error}` }))
    if (left === undefined || left > 0 || run.status === 'running') {
      more.append(button(left ? `接着读（还有 ${left} 行）` : data.total === undefined ? '读明细' : '看看有没有新的', { class: 'small' }, (btn) => act(btn, load)))
    } else if (data.rows.length === 0) {
      more.append(h('span', { class: 'muted', text: '没有记录。' }))
    }
  }
  const load = async () => {
    data.error = null
    try {
      const q = run.file !== undefined ? `file=${encodeURIComponent(run.file)}` : `id=${encodeURIComponent(run.id)}`
      const res = await api('GET', `/runs/records?${q}&after=${data.next}&limit=${RECORDS_PAGE}`)
      data.rows.push(...(res.records ?? []))
      data.next = res.next ?? data.next + (res.records ?? []).length
      data.total = res.total
    } catch (e) {
      data.error = e.status === 404 ? '这个版本的大脑还没有程序运行的明细' : e.message
    }
    paint()
  }
  paint()
  if (data.total === undefined) load()
  return [box, more]
}

/** 旧日志的明细：每一步都在日志里。只画最后 60 步，再往前的点了才画。 */
function localCalls(item) {
  const SHOWN = 60
  const box = h('div', { class: 'run-calls' })
  let shown = SHOWN
  const paint = () => {
    const from = Math.max(0, item.calls.length - shown)
    box.replaceChildren(
      from > 0
        ? button(`前面还有 ${from} 步，再看 ${Math.min(from, 200)} 步`, { class: 'small quiet' }, () => {
            shown += 200
            paint()
          })
        : '',
      ...item.calls.slice(from).flatMap(renderTool),
    )
  }
  paint()
  return [box]
}

function renderRun(item, nested = false) {
  const run = item.run
  const key = `run:${item.key}`
  const now = serverNow()
  const routine = run.kind !== 'program'
  const current = state.status?.agents?.some((a) => a.routine && a.routine.id === run.id && a.routine.status === 'running' && (a.routine.file === undefined || run.file === undefined || a.routine.file === run.file))
  // 旧日志里“在跑”是从条目里猜的：现在的状态说没有这个例程在跑，那它就是没有结束记录
  const running = run.status === 'running' && (!item.legacy || current)
  const status = run.status === 'running' && !running ? 'unknown' : run.status
  const bits = [`${run.calls} 次调用`]
  if (routine) bits.push(`开了 ${run.tasks} 个任务`)
  bits.push(run.errors > 0 ? `${run.errors} 次出错` : '没有出错')
  const span = run.endedAt !== undefined ? duration(run.endedAt - run.startedAt) : undefined
  const el = h('div', { class: `run ${status}${nested ? ' nested' : ''}` })
  el.append(
    h(
      'div',
      { class: 'run-head' },
      h('span', { class: `tag ${routine ? 'routine' : 'program'}`, text: routine ? '例程' : '程序' }),
      h('span', { class: 'run-name' }, routine ? h('span', { class: 'mono', text: `${run.id} ` }) : null, run.name || (routine ? '（没有名字）' : 'run_program 里调的工具')),
      h(
        'span',
        { class: 'turn-meta' },
        nested ? null : time(run.startedAt),
        h('span', { class: `chip ${RUN_TONES[status] ?? ''}`, ...(running ? { 'data-since': run.startedAt, 'data-label': '在跑' } : {}), text: status === 'unknown' ? '没有结束记录' : running ? `在跑 ${duration(now - run.startedAt)}` : `${RUN_STATES[run.status] ?? run.status}${span ? ` · ${span}` : ''}` }),
        h('span', { class: 'stats', text: bits.join(' · ') }),
        running && current ? button('停止', { class: 'small danger' }, (btn) => act(btn, actions.stopRoutine, '已停止例程')) : null,
      ),
    ),
  )
  if (running && run.waiting) el.append(h('div', { class: 'run-wait' }, h('span', { class: 'label', text: '正在等' }), h('span', { class: 'mono', text: run.waiting })))
  if (item.ending && !nested) el.append(h('div', { class: 'run-ending muted', text: item.ending }))
  if (item.legacy && item.calls.length > 0 && routine) {
    el.append(h('div', { class: 'tool-chips' }, toolHistogram(item.calls).map((t) => h('span', { class: 'tchip', text: `${t.name} ×${t.count}` }))))
  }
  if (item.summary) el.append(fold('结束时给模型看的总结', item.summary, `${key}:summary`))
  if (item.code) el.append(fold('它写的程序', item.code, `${key}:code`))
  if (item.failed.length > 0) {
    const failed = h('details', { class: 'fold', open: isOpen(`${key}:failed`, false) }, h('summary', { class: 'bad', text: `出错的 ${item.failed.length} 步` }), h('div', { class: 'run-calls' }, item.failed.flatMap(renderTool)))
    failed.addEventListener('toggle', () => openState.set(`${key}:failed`, failed.open))
    el.append(failed)
  }
  if (item.calls.length > 0 || !item.legacy) {
    const holder = h('div')
    const all = h('details', { class: 'fold', open: isOpen(`${key}:calls`, false) }, h('summary', { text: `每一步（${run.calls} 次调用）` }), holder)
    const fill = () => {
      if (all.open && holder.childElementCount === 0) holder.append(...(item.legacy ? localCalls(item) : remoteCalls(item)))
    }
    all.addEventListener('toggle', () => {
      openState.set(`${key}:calls`, all.open)
      fill()
    })
    fill()
    el.append(all)
  }
  return el
}

// ── 说明、报错、游戏事件 ──

function renderNote(item) {
  return h(
    'div',
    { class: `note ${item.tone}` },
    time(item.time),
    h('span', { class: `chip${item.tone === 'error' ? ' bad' : ''}`, text: item.label }),
    h('span', { class: 'note-text', text: item.text }),
    item.detail ? fold('详情', item.detail, `note:${item.id}`) : null,
  )
}

function renderEvents(item) {
  const line = (l) => h('div', { class: 'event' }, time(l.time), l.system ? h('span', { class: 'chip', text: '系统消息' }) : null, h('span', { class: 'event-text', text: l.text }), l.detail ? h('span', { class: 'muted', text: `（${l.detail}）` }) : null)
  if (item.lines.length <= 3) return h('div', { class: 'events' }, item.lines.map(line))
  const key = `events:${item.key}`
  const system = item.lines.filter((l) => l.system).length
  const others = item.lines.filter((l) => !l.system)
  const title = `${item.lines.length} 条游戏事件${system > 0 ? `，其中 ${system} 条系统消息` : ''}${others.length > 0 ? `：${others.slice(0, 2).map((l) => l.text.slice(0, 24)).join('；')}${others.length > 2 ? '……' : ''}` : ''}`
  const body = h('div')
  const el = h('details', { class: 'events fold', open: isOpen(key, false) }, h('summary', null, time(item.time), h('span', { text: title })), body)
  const fill = () => {
    if (el.open && body.childElementCount === 0) body.append(...item.lines.map(line))
  }
  el.addEventListener('toggle', () => {
    openState.set(key, el.open)
    fill()
  })
  fill()
  return el
}

function renderItem(item, prev, ctx) {
  if (item.type === 'msg') return renderMsg(item, prev)
  if (item.type === 'work') return renderWork(item, ctx)
  if (item.type === 'run') return renderRun(item)
  if (item.type === 'note') return renderNote(item)
  return renderEvents(item)
}

/** 一样东西重画不重画，看这个：内容的版本，加上它的开合、是不是“正在进行”。 */
function itemRev(item, ctx) {
  if (item.type === 'work') {
    const key = item.turn.key
    return `${item.rev}:${isOpen(`turn:${key}`, ctx.latestTurns.has(key)) ? 1 : 0}:${ctx.liveTurns.has(item.turn.id) ? 1 : 0}`
  }
  if (item.type === 'run') return `${item.rev}:${ctx.runningRoutine}`
  return String(item.rev)
}

/**
 * 在 container 里画时间线。返回 { update(timeline), setLevel(level) }。
 * level：1 只看对话，2 加上模型的决策，3 全部。
 */
export function createLogView(container, opts = {}) {
  let level = opts.level ?? LEVEL.work
  let timeline = { items: [], turns: new Map() }
  container.classList.add('timeline')

  const context = () => {
    const agents = state.status?.agents ?? []
    const liveTurns = new Set()
    for (const a of agents) {
      if (a.turn?.id !== undefined) liveTurns.add(a.turn.id)
      else if (a.model?.turn !== undefined) liveTurns.add(a.model.turn)
    }
    // 不知道是哪一轮在跑（旧的后端）：忙着的时候，最后一轮没结束的就是它
    const busy = agents.some((a) => a.model?.state === 'thinking' || a.model?.state === 'tools')
    const latestTurns = new Set()
    const seenLanes = new Set()
    for (let i = timeline.items.length - 1; i >= 0 && seenLanes.size < 2; i--) {
      const item = timeline.items[i]
      if (item.type !== 'work' || seenLanes.has(item.lane)) continue
      seenLanes.add(item.lane)
      latestTurns.add(item.turn.key)
      if (busy && liveTurns.size === 0 && item.turn.open) liveTurns.add(item.turn.id)
    }
    const routine = agents.map((a) => a.routine).find((r) => r && r.status === 'running')
    return { liveTurns, latestTurns, runningRoutine: routine ? `${routine.id}/${routine.file ?? ''}` : '', rerender: paint }
  }

  function paint() {
    const ctx = context()
    const rows = layoutRows(timeline.items, level)
    let prevTime
    for (const row of rows) {
      const first = row.left[0] ?? row.right[0]
      row.day = prevTime === undefined || !sameDay(prevTime, first.time) ? first.time : undefined
      prevTime = first.time
      row.rev = `${row.day ?? ''}|${level}|${[...row.left, ...row.right].map((i) => `${i.key}=${itemRev(i, ctx)}`).join(',')}`
    }
    container.classList.toggle('talk-only', level === LEVEL.talk)
    reconcile(container, rows, {
      key: (row) => row.key,
      rev: (row) => row.rev,
      render: (row) => {
        const cell = (items, lane) => {
          const el = h('div', { class: `lane ${lane}` })
          let prev
          for (const item of items) {
            const child = renderItem(item, prev, ctx)
            if (child) el.append(child)
            prev = item
          }
          return el
        }
        return h('div', { class: `trow${row.left.length === 0 ? ' no-talk' : ''}${row.right.length === 0 ? ' no-work' : ''}` }, row.day !== undefined ? h('div', { class: 'day', text: dayLabel(row.day) }) : null, cell(row.left, 'talk'), cell(row.right, 'work'))
      },
    })
    opts.onPaint?.(rows.length)
  }

  return {
    update(next) {
      timeline = next
      paint()
    },
    setLevel(next) {
      level = next
      paint()
    },
    repaint: paint,
    get level() {
      return level
    },
  }
}

/** “进行中”“在跑 12 秒”这类会跳的字：每秒按 data-since 重写一遍，不用为了改一个数重画整块。 */
export function tickClocks(root = document) {
  const now = serverNow()
  for (const el of root.querySelectorAll('[data-since]')) {
    const since = Number(el.dataset.since)
    if (Number.isFinite(since)) el.textContent = `${el.dataset.label ?? ''} ${duration(Math.max(0, now - since))}`.trim()
  }
}

// “现在”页的一块：对话线派出去的子思维。在想的（任务、第几步、多久，可停）和最近结束的（怎么结束的、交回的话），
// 点“看过程”展开它的每一步：写的字、调的工具（参数读得懂的一句，点开是参数和结果全文）、最后交回的话。
// 数据：/api/status 的 helpers（列表，不带过程，一秒一次）；展开的那一个取 /api/helpers/view?id=（在想的，它多走一步就再取一次）。

import { actions, refresh, serverNow, state } from './data.js'
import { describeArgs } from './logmodel.js'
import { itemName } from './names.js'
import { act, api, badge, button, compact, duration, h, put, when } from './ui.js'

/** 结束的几种：给人看的词和颜色。 */
export const HELPER_ENDS = {
  running: ['在想', 'live'],
  done: ['想完了', 'ok'],
  limit: ['到了步数上限', 'warn'],
  stopped: ['被停下了', 'warn'],
  failed: ['出错停了', 'bad'],
  context: ['上下文太长，停了', 'bad'],
  budget: ['今天的用量到上限，停了', 'bad'],
  interrupted: ['大脑重启，没想完', 'warn'],
}

/** 展开着的那几个：id → { record, error, rev }。rev 是取它时的步数和状态，变了再取。 */
const open = new Map()
let rerender = () => {}

const firstLine = (text, max = 80) => {
  const line = String(text ?? '').split('\n', 1)[0]
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function revOf(summary) {
  return `${summary.status}:${summary.steps}:${summary.thinkingSince ?? ''}:${summary.lastTool ?? ''}`
}

async function load(id, rev) {
  try {
    const record = await api('GET', `/helpers/view?id=${encodeURIComponent(id)}`)
    if (open.has(id)) open.set(id, { record, rev })
  } catch (e) {
    if (open.has(id)) open.set(id, { error: e.message, rev })
  }
  rerender()
}

function toggle(summary) {
  if (open.has(summary.id)) open.delete(summary.id)
  else {
    open.set(summary.id, { rev: revOf(summary) })
    void load(summary.id, revOf(summary))
  }
  rerender()
}

/** 一步里调的一个工具：收着是一行（名字、读得懂的参数、结果的头一行），点开是参数和结果全文。 */
function callRow(c) {
  const args = describeArgs(c.input, itemName) ?? c.input
  const head = h(
    'summary',
    { class: `now-tool${c.isError ? ' is-error' : ''}` },
    h('span', { class: 'feed-tool', text: c.name }),
    h('span', { class: 'now-tool-args', text: args }),
    h('span', { class: 'now-tool-result', text: c.result === undefined ? '（还没回来）' : `→ ${firstLine(c.result, 160)}` }),
  )
  return h('details', { class: 'fold helper-call' }, head, h('pre', { class: 'code', text: `参数：${c.input}` }), c.result !== undefined ? h('pre', { class: `code${c.isError ? ' bad' : ''}`, text: c.result }) : null)
}

function stepBlock(step) {
  const bits = []
  if (typeof step.ms === 'number') bits.push(duration(step.ms))
  if (typeof step.inputTokens === 'number') bits.push(`入 ${compact(step.inputTokens)} / 出 ${compact(step.outputTokens ?? 0)}`)
  return h(
    'div',
    { class: `helper-step${step.error ? ' failed' : ''}` },
    h(
      'div',
      { class: 'step-head' },
      h('span', { class: 'step-n', text: `第 ${step.n} 步` }),
      step.final ? h('span', { class: 'chip warn', title: '到了步数上限，这一步不能调工具，写交回的话', text: '最后一步' }) : null,
      typeof step.ms !== 'number' && !step.error ? h('span', { class: 'thinking', text: '正在想…' }) : null,
      ...bits.map((b) => h('span', { class: 'muted', text: b })),
      step.error ? h('span', { class: 'bad', text: step.error }) : null,
    ),
    step.text ? h('div', { class: 'model-text' }, h('span', { class: 'label', text: '它写道' }), h('span', { text: step.text })) : null,
    (step.calls ?? []).map(callRow),
  )
}

/** 展开的那一个：任务全文、每一步、交回的话。 */
function processBox(summary) {
  const got = open.get(summary.id)
  if (!got?.record && !got?.error) return h('div', { class: 'helper-process muted', text: '正在取…' })
  if (got.error) return h('div', { class: 'helper-process bad', text: `没取到：${got.error}` })
  const r = got.record
  return h(
    'div',
    { class: 'helper-process' },
    h('div', { class: 'now-row' }, h('span', { class: 'now-key', text: '任务' }), h('div', { class: 'now-val helper-task', text: r.task })),
    r.model ? h('div', { class: 'now-row' }, h('span', { class: 'now-key', text: '模型' }), h('span', { class: 'now-val muted', text: r.model })) : null,
    r.transcript.length === 0 ? h('p', { class: 'muted', text: r.status === 'running' ? '还没走完第一步。' : '一步都没走成。' }) : r.transcript.map(stepBlock),
    r.note ? h('div', { class: 'now-row' }, h('span', { class: 'now-key', text: '怎么结束的' }), h('span', { class: 'now-val', text: r.note })) : null,
    r.status !== 'running' ? h('div', { class: 'helper-final' }, h('div', { class: 'now-key', text: '交回对话线的话' }), r.final ? h('div', { class: 'helper-final-text', text: r.final }) : h('p', { class: 'muted', text: '它没有留下话。' })) : null,
    h('p', { class: 'hint', text: `每一步也在对话页里（标着“子思维 ${r.id}”）。` }),
  )
}

function runningRow(r) {
  const now = serverNow()
  const opened = open.has(r.id)
  const doing = r.thinkingSince !== undefined ? `在想第 ${r.steps + 1} 步` : r.steps === 0 ? '刚派出去' : `走完 ${r.steps} 步，在查${r.lastTool ? `（${r.lastTool}）` : ''}`
  return h(
    'li',
    { class: 'helper-row' },
    h(
      'div',
      { class: 'helper-line' },
      h('span', { class: 'mono helper-id', text: r.id }),
      h('span', { class: 'helper-what', title: r.task, text: firstLine(r.task) }),
      button(opened ? '收起' : '看过程', { class: 'small', 'aria-expanded': String(opened) }, () => toggle(r)),
      button('停下', { class: 'small danger', title: '停掉它：它到现在想到的照样交回对话线，写明是你停的' }, (btn) => act(btn, () => actions.stopHelper(r.id), `已经叫 ${r.id} 停下`).then(refresh)),
    ),
    h(
      'div',
      { class: 'helper-sub' },
      h('span', { class: 'state think', 'data-since': r.startedAt, 'data-label': `${doing} · 已经`, text: `${doing} · 已经 ${duration(Math.max(0, now - r.startedAt))}` }),
      h('span', { class: 'muted', text: `最多 ${r.maxSteps} 步` }),
    ),
    opened ? processBox(r) : null,
  )
}

function endedRow(r) {
  const [word, tone] = HELPER_ENDS[r.status] ?? [r.status, '']
  const opened = open.has(r.id)
  const spent = r.endedAt !== undefined ? duration(Math.max(0, r.endedAt - r.startedAt)) : ''
  return h(
    'li',
    { class: 'helper-row' },
    h(
      'div',
      { class: 'helper-line' },
      h('span', { class: 'mono helper-id', text: r.id }),
      badge(word, tone),
      h('span', { class: 'helper-what', title: r.task, text: firstLine(r.task) }),
      button(opened ? '收起' : '看过程', { class: 'small', 'aria-expanded': String(opened) }, () => toggle(r)),
    ),
    h(
      'div',
      { class: 'helper-sub' },
      h('span', { class: 'helper-result', title: r.final ?? '', text: r.final ? `→ ${firstLine(r.final, 120)}` : '（没有留下话）' }),
      h('span', { class: 'muted', text: [`${r.steps} 步`, spent, r.endedAt ? when(r.endedAt) : ''].filter(Boolean).join(' · ') }),
    ),
    opened ? processBox(r) : null,
  )
}

/** 子思维用的模型：主人单独选的，或者“和对话线一样”。 */
function modelText(helpers) {
  const m = helpers.model
  if (!m) return '还没有可用的模型'
  return m.own ? `${m.provider} / ${m.model}` : `和对话线一样（${m.provider} / ${m.model}）`
}

/** 画这一块。helpers 是 /api/status 的 helpers；没有（老的后端）就什么都不画。 */
export function renderHelpers(el, onChange) {
  rerender = onChange
  const helpers = state.status?.helpers
  if (!helpers) return put(el)
  const running = helpers.running ?? []
  const recent = helpers.recent ?? []
  // 展开着的在想的那个多走了一步：再取一次它的过程
  for (const r of running) {
    const got = open.get(r.id)
    if (got && got.rev !== revOf(r) && got.record) {
      open.set(r.id, { ...got, rev: revOf(r) })
      void load(r.id, revOf(r))
    }
  }
  // 刚结束的那个：过程定稿了，也再取一次
  for (const r of recent) {
    const got = open.get(r.id)
    if (got && got.record && got.record.status === 'running') {
      open.set(r.id, { ...got, rev: revOf(r) })
      void load(r.id, revOf(r))
    }
  }
  put(
    el,
    h(
      'div',
      { class: 'card now-card helpers-card' },
      h(
        'div',
        { class: 'now-card-head' },
        h('span', { class: 'tag model', text: '子思维' }),
        h('strong', { text: running.length > 0 ? `在想 ${running.length} 个` : '没有在想的' }),
        h('span', { class: 'muted', text: `最多 ${helpers.max} 个同时 · 每个最多 ${helpers.maxSteps} 步` }),
        h('span', { class: 'spacer' }),
        h('a', { class: 'muted helper-model', href: '#settings/models', title: '在“设置 → 模型”里换', text: `模型：${modelText(helpers)}` }),
      ),
      running.length > 0 ? h('ul', { class: 'plain helper-list' }, running.map(runningRow)) : null,
      recent.length > 0
        ? [h('h4', { text: '最近结束的' }), h('ul', { class: 'plain helper-list' }, recent.map(endedRow))]
        : running.length === 0
          ? h('p', { class: 'muted', text: '对话线还没派过子思维。它要查很多步的事、设计建筑时可以派一部分心思出去想，想完了交回的话会叫醒它。' })
          : null,
    ),
  )
}

/** 测试和截图用：展开某一个。 */
export function openHelper(id) {
  const summary = [...(state.status?.helpers?.running ?? []), ...(state.status?.helpers?.recent ?? [])].find((r) => r.id === id)
  if (summary && !open.has(id)) toggle(summary)
}

// “对话”页：左边是说了什么（玩家的话、它的话、你在面板上说的），右边是干活的那一层（一轮 → 模型的每一步 → 每个工具）。
// 两边一行行对齐，从上到下是时间顺序；最新的在最下面。往上翻到头自动取更早的；不在底部时有“回到最新”。
// 上面那排选“看多少”：只看对话 / 加上模型的决策 / 全部（再加上游戏事件和说明）。底下的输入框直接跟它说话。

import { actions, state } from './data.js'
import { LEVEL } from './logmodel.js'
import { entryCount, getTimeline, loadOlder, logState } from './logstore.js'
import { createLogView } from './logview.js'
import { act, bus, button, h, segmented } from './ui.js'

const LEVEL_KEY = 'aiplayer.chat.level'

let root = null
let view = null
let scroller = null
let unsubscribe = []
let pinned = true
let unseen = 0
let lastRows = 0

const savedLevel = () => {
  const v = Number(localStorage.getItem(LEVEL_KEY))
  return v === LEVEL.talk || v === LEVEL.work || v === LEVEL.all ? v : LEVEL.work
}

const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60

function toBottom() {
  scroller.scrollTop = scroller.scrollHeight
  pinned = true
  unseen = 0
  paintJump()
}

function paintJump() {
  const jump = root.querySelector('.jump')
  jump.hidden = pinned
  jump.textContent = unseen > 0 ? `回到最新（有 ${unseen} 处新的）` : '回到最新'
}

function paintState() {
  const el = root.querySelector('.stream-state')
  const text = { connecting: '正在连接…', live: '实时更新中', retrying: '实时更新断了，正在重连…', off: '' }[logState.stream] ?? ''
  el.textContent = text
  el.className = `stream-state ${logState.stream === 'retrying' ? 'bad' : 'muted'}`
  const top = root.querySelector('.older')
  if (logState.loadingOlder) top.replaceChildren(h('span', { class: 'muted', text: '正在取更早的记录…' }))
  else if (logState.olderError) top.replaceChildren(h('span', { class: 'bad', text: `更早的记录没取到：${logState.olderError}` }), button('再试', { class: 'small' }, older))
  else if (logState.canPage === false) top.replaceChildren(h('span', { class: 'muted', text: '这里是大脑内存里留着的最早一条；这个版本的大脑不会往回翻文件里的。' }))
  else if (logState.more === false) top.replaceChildren(h('span', { class: 'muted', text: '到头了：更早的记录已经过期删掉了（留 14 天）。' }))
  else if (entryCount() > 0) top.replaceChildren(button('看更早的', { class: 'small quiet' }, older))
  else top.replaceChildren()
}

async function older() {
  const before = scroller.scrollHeight
  const added = await loadOlder()
  if (added > 0) {
    // 等这一批画上去，再把视口挪回原来看的那一条上
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        scroller.scrollTop += scroller.scrollHeight - before
      }),
    )
  }
}

function update() {
  if (!root || root.hidden) return
  const stick = pinned
  const top = scroller.scrollTop
  view.update(getTimeline())
  if (stick) scroller.scrollTop = scroller.scrollHeight
  else scroller.scrollTop = top
  root.querySelector('.log-empty').hidden = entryCount() > 0
  paintState()
}

async function send(form) {
  const input = form.querySelector('textarea')
  const text = input.value.trim()
  if (!text) return
  const ok = await act(form.querySelector('button[type="submit"]'), () => actions.command(text))
  if (ok) {
    input.value = ''
    toBottom()
  }
  input.focus()
}

function build(el) {
  const level = savedLevel()
  const filter = segmented(
    [
      { value: LEVEL.talk, label: '只看对话', title: '玩家的话、它说的话、你在面板上说的' },
      { value: LEVEL.work, label: '加上模型的决策', title: '再加上每一轮：模型的每一步、调的工具、它写的程序的运行、报错' },
      { value: LEVEL.all, label: '全部', title: '再加上游戏事件（系统消息、任务开始……）和各种说明' },
    ],
    level,
    (next) => {
      localStorage.setItem(LEVEL_KEY, String(next))
      const stick = pinned
      view.setLevel(next)
      if (stick) toBottom()
    },
    '看多少',
  )
  const timelineEl = h('div', { 'aria-live': 'polite' })
  scroller = h('div', { class: 'log-scroll', tabIndex: 0, 'aria-label': '对话和活动记录' }, h('div', { class: 'older' }), timelineEl, h('div', { class: 'log-empty', hidden: true }, h('p', { class: 'empty-title', text: '还没有记录' }), h('p', { class: 'hint', text: '在下面跟它说句话，或者在游戏里叫它的名字。' })))
  const input = h('textarea', { rows: 2, maxLength: 2000, placeholder: '以主人的身份直接跟它说。回车发送，Shift+回车换行', 'aria-label': '给它下指令' })
  const form = h('form', { class: 'composer' }, input, h('button', { type: 'submit', class: 'primary', text: '发送' }))
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    send(form)
  })
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault()
      send(form)
    }
  })
  const lanes = h('div', { class: 'lane-heads', 'aria-hidden': 'true' }, h('span', { class: 'lane-head talk', text: '说了什么' }), h('span', { class: 'lane-head work', text: '干了什么' }))
  el.append(
    h('div', { class: 'chat-bar' }, filter.el, h('span', { class: 'stream-state muted' }), h('span', { class: 'spacer' }), button('全部收起', { class: 'small quiet', title: '把点开的每一轮都收起来' }, () => collapseAll())),
    lanes,
    h('div', { class: 'log-wrap' }, scroller, button('回到最新', { class: 'jump', hidden: true }, toBottom)),
    form,
    h('p', { class: 'hint composer-hint', text: '这里发的话只有它看得到，不会出现在游戏聊天里。它在游戏里说的话会出现在上面。' }),
  )
  view = createLogView(timelineEl, {
    level,
    onPaint: (rows) => {
      if (!pinned && rows > lastRows) unseen += rows - lastRows
      lastRows = rows
      paintJump()
    },
  })
  scroller.addEventListener('scroll', () => {
    pinned = atBottom()
    if (pinned) unseen = 0
    paintJump()
    // 翻到顶：自己去取更早的
    if (scroller.scrollTop < 40 && logState.more !== false && logState.canPage !== false && !logState.loadingOlder && entryCount() > 0) older()
  })
}

function collapseAll() {
  for (const head of root.querySelectorAll('.turn-head[aria-expanded="true"]')) head.click()
}

export function enter(el) {
  root = el
  if (el.childElementCount === 0) build(el)
  unsubscribe = [bus.on('log', update), bus.on('log-stream', paintState), bus.on('status', () => view.repaint())]
  pinned = true
  update()
  toBottom()
  if (state.overview) el.querySelector('textarea').placeholder = `以主人的身份直接跟 ${state.overview.bot?.name ?? '它'} 说。回车发送，Shift+回车换行`
}

export function leave() {
  for (const off of unsubscribe) off()
  unsubscribe = []
}

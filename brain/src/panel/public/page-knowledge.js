// “知识”页：它记着的、照着做的、想对你说的。
//   记忆     它自己记的笔记（键 → 一段话），每一轮都给它看；你可以直接改
//   手册     它要干某一类活时才去翻的说明：默认的随程序发布，你可以改、可以新写，它自己也会写
//   意见簿   它干活时觉得哪里有问题，自己记下的反馈；你看过、处理过可以标一下

import { state } from './data.js'
import { act, api, badge, bus, button, dateTime, empty, field, h, kv, loadError, num, progressBar, put, subTabs, TASK_STATES, when } from './ui.js'

const TABS = [
  { id: 'memory', label: '记忆' },
  { id: 'manuals', label: '手册' },
  { id: 'feedback', label: '意见簿' },
]

let root = null
let current = 'memory'
let unsubscribe = []

const pane = (id) => root?.querySelector(`[data-tab="${id}"]`)

// ════════ 记忆 ════════

async function loadMemory() {
  const el = pane('memory')
  try {
    renderMemory(await api('GET', '/memory'))
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`记忆没取到：${e.message}`, loadMemory))
  }
}

function renderMemory(data) {
  const el = pane('memory')
  if (!el) return
  const row = (note) => {
    const key = h('input', { type: 'text', value: note?.key ?? '', maxLength: 64, placeholder: '键，例如 home:base', 'aria-label': '键', spellcheck: false })
    const text = h('textarea', { rows: 2, value: note?.text ?? '', maxLength: 1000, placeholder: '内容', 'aria-label': '内容' })
    const saveBtn = button(note ? '保存' : '添加', { class: note ? 'small' : 'small primary' }, async () => {
      const next = await act(saveBtn, () => api('PUT', '/memory', { key: key.value, text: text.value, ...(note ? { previousKey: note.key } : {}) }), '已保存')
      if (next) renderMemory(next)
    })
    const delBtn = note
      ? button('删除', { class: 'small danger' }, async () => {
          if (!confirm(`删除记忆“${note.key}”？`)) return
          const next = await act(delBtn, () => api('DELETE', '/memory', { key: note.key }), '已删除')
          if (next) renderMemory(next)
        })
      : null
    return h('div', { class: 'memo' }, h('div', { class: 'memo-key' }, key, note ? h('p', { class: 'hint', text: `更新于 ${dateTime(note.updatedAt)}` }) : null), h('div', { class: 'memo-text' }, text), h('div', { class: 'memo-actions' }, saveBtn, delBtn))
  }
  const ratio = data.maxChars > 0 ? data.totalChars / data.maxChars : 0
  put(el, 
    h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', { text: `它记着的 ${data.notes.length} 条` }), h('span', { class: ratio > 0.9 ? 'warn' : 'muted', text: `已用 ${num(data.totalChars)} / ${num(data.maxChars)} 字符` })),
        progressBar(ratio, ratio > 0.9 ? 'warn' : ''),
        h('p', { class: 'muted', text: '这是它自己记的笔记，每一轮都会给它看（所以有总长度上限，在“设置 → 上限”里改）。你也可以直接改；改键名就是改名。' }),
        data.notes.length === 0 ? empty('它还没记下任何东西', '它会自己记（比如 home 的名字和用途），你也可以在下面替它记一条。') : h('div', { class: 'memos' }, data.notes.map(row)),
      ),
      h('div', { class: 'card' }, h('h2', { text: '新增一条' }), h('div', { class: 'memos' }, row(null))),
    ),
  )
}

// ════════ 手册 ════════

let manualState = null
/** 正在看的手册名；正在编辑的手册名（'' 是新写一本，null 是没在编辑）。 */
let openManual = null
let editingManual = null

async function loadManuals() {
  if (editingManual !== null) return // 正在写，别把内容冲掉
  const el = pane('manuals')
  try {
    manualState = await api('GET', '/manuals')
    renderManuals()
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`手册没取到：${e.message}`, loadManuals))
  }
}

function manualBadge(m) {
  if (m.source === 'default') return badge('默认')
  if (m.self) return badge('它自己写的', 'warn')
  return m.overridesDefault ? badge('你改过的', 'warn') : badge('你写的', 'ok')
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
  const cancelBtn = button('取消', {}, () => {
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
      openManual = next.saved?.name ?? payload.name
      renderManuals()
    }
  })
  const parts = [
    h(
      'div',
      { class: 'fields' },
      field('名字', name, fixedName ? '默认手册的名字不能改。' : '它用这个名字来读这本手册。字母、数字、汉字、下划线和连字符，不能有空格。'),
      h('div', { class: 'field-wide' }, h('label', { for: 'mf-summary', text: '什么时候看这本（一句话）' }), summary, h('p', { class: 'hint', text: '这一句每次都会出现在给它的手册目录里，它靠这句话决定要不要翻这本。' })),
    ),
    h('div', null, h('label', { for: 'mf-body', text: '正文' }), body, h('div', { class: 'row' }, counter)),
    !isNew && manual.source === 'default' ? h('p', { class: 'hint', text: '这是随程序发布的默认手册。保存后它用的是你改的这一份；想换回来，点这本手册上的“恢复默认”。' }) : null,
    !isNew && manual.default ? h('details', { class: 'fold' }, h('summary', { text: '看默认的内容' }), h('p', { class: 'muted', text: manual.default.summary }), h('pre', { class: 'manual-text', text: manual.default.body })) : null,
    h('div', { class: 'row' }, saveBtn, cancelBtn),
  ]
  form.append(...parts.filter((part) => part !== null))
  return form
}

function manualDetail(m) {
  const editing = editingManual !== null
  const editBtn = button(m.source === 'default' ? '修改' : '编辑', { class: 'small', disabled: editing }, () => {
    editingManual = m.name
    renderManuals()
  })
  // 你改过的默认手册：删掉你的那份就是恢复默认；你自己写的（和它自己写的）：删除
  const removeBtn =
    m.source === 'user'
      ? button(m.overridesDefault ? '恢复默认' : '删除', { class: 'small danger', disabled: editing }, async () => {
          const question = m.overridesDefault ? `把手册“${m.name}”恢复成默认的？你改的内容会丢掉。` : `删除手册“${m.name}”？`
          if (!confirm(question)) return
          const next = await act(removeBtn, () => api('DELETE', '/manuals', { name: m.name }), m.overridesDefault ? '已恢复默认' : '已删除')
          if (next) {
            manualState = next
            renderManuals()
          }
        })
      : null
  return h(
    'div',
    { class: 'card detail' },
    h('div', { class: 'provider-head' }, h('span', { class: 'name mono', text: m.name }), manualBadge(m), h('span', { class: 'spacer' }), editBtn, removeBtn),
    h('p', null, h('span', { class: 'muted', text: '什么时候看：' }), m.summary),
    h('pre', { class: 'manual-text', text: m.body }),
    h('p', { class: 'hint', text: `正文 ${num(m.body.length)} 字符。` }),
    m.default ? h('details', { class: 'fold' }, h('summary', { text: '看默认的内容（你改之前的）' }), h('p', { class: 'muted', text: m.default.summary }), h('pre', { class: 'manual-text', text: m.default.body })) : null,
  )
}

function renderManuals() {
  const el = pane('manuals')
  if (!el || !manualState) return
  const list = manualState.manuals ?? []
  if (openManual === null || !list.some((m) => m.name === openManual)) openManual = list[0]?.name ?? null
  const shown = list.find((m) => m.name === openManual)
  const editing = editingManual !== null
  const addBtn = button('新写一本', { class: 'primary', disabled: editing }, () => {
    editingManual = ''
    renderManuals()
  })
  const items = list.map((m) => {
    const b = h('button', { type: 'button', class: 'pick', 'aria-current': String(m.name === openManual && editingManual !== ''), disabled: editing && editingManual !== m.name }, h('span', { class: 'pick-title' }, h('span', { class: 'mono', text: m.name }), manualBadge(m)), h('span', { class: 'pick-sub', text: m.summary }))
    b.addEventListener('click', () => {
      openManual = m.name
      renderManuals()
    })
    return h('li', null, b)
  })
  const right = editingManual === '' ? h('div', { class: 'card detail' }, h('h2', { text: '新写一本手册' }), manualForm(null)) : shown && editingManual === shown.name ? h('div', { class: 'card detail' }, h('h2', { text: `手册：${shown.name}` }), manualForm(shown)) : shown ? manualDetail(shown) : h('div', { class: 'card detail' }, empty('还没有手册'))
  put(el, 
    h('div', { class: 'row' }, h('p', { class: 'muted fill', text: '手册是它要干某一类活时才去翻的说明，不是每次都塞给模型的；提示词里只列每本的名字和“什么时候看”那一句。默认手册随程序发布，你可以改（改完用你的，随时能恢复默认），也可以自己新写，比如“基地布局”“材料仓库在哪”；它自己学会的成套做法也会写成手册。' }), addBtn),
    h('div', { class: 'split' }, h('ul', { class: 'picks', 'aria-label': '手册' }, items), right),
  )
}

// ════════ 意见簿 ════════

const FEEDBACK_CATEGORY_LABELS = { missing_tool: '缺工具', tool_problem: '工具有问题', data_or_manual: '资料或手册有问题', cannot_do: '做不到', other: '其他' }
const FEEDBACK_STATUS_LABELS = { new: '没看过', seen: '看过，没处理', handled: '已处理' }
const FEEDBACK_STATUS_TONES = { new: 'warn', seen: '', handled: 'ok' }
/** 列表现在按什么筛、正在看哪一条。 */
const feedbackView = { category: '', status: 'open', openId: null, report: null }

const feedbackQuery = () => {
  const q = new URLSearchParams()
  if (feedbackView.category) q.set('category', feedbackView.category)
  if (feedbackView.status) q.set('status', feedbackView.status)
  const text = q.toString()
  return text ? `?${text}` : ''
}

async function loadFeedback() {
  const el = pane('feedback')
  try {
    renderFeedback(await api('GET', `/feedback${feedbackQuery()}`))
  } catch (e) {
    if (e.status !== 401) put(el, loadError(`意见簿没取到：${e.message}`, loadFeedback))
  }
}

async function openFeedback(id) {
  let report = await api('GET', `/feedback/view?id=${encodeURIComponent(id)}`)
  // 点开就算看过了
  if (report.status === 'new') report = (await api('POST', '/feedback/status', { id, status: 'seen' })).report
  feedbackView.openId = id
  feedbackView.report = report
  await loadFeedback()
}

function feedbackDetail(r) {
  const c = r.context ?? {}
  const handled = r.status === 'handled'
  const toggle = button(handled ? '改回没处理' : '标成已处理', { class: handled ? '' : 'primary' }, async () => {
    const res = await act(toggle, () => api('POST', '/feedback/status', { id: r.id, status: handled ? 'seen' : 'handled' }), handled ? '已改回没处理' : '已标成处理过')
    if (!res) return
    feedbackView.report = res.report
    await loadFeedback()
  })
  const part = (title, text) => (text ? [h('h4', { text: title }), h('p', { class: 'pre', text })] : null)
  const tools = c.recentTools ?? []
  const tasks = c.tasks ?? []
  return h(
    'div',
    { class: 'card detail' },
    h('div', { class: 'row' }, h('h2', { class: 'fill', text: r.title }), toggle),
    h('p', { class: 'muted' }, `${r.id} · ${FEEDBACK_CATEGORY_LABELS[r.category] ?? r.category} · ${FEEDBACK_STATUS_LABELS[r.status] ?? r.status} · ${dateTime(r.time)} 记的`, r.count > 1 ? `，一共记了 ${r.count} 次，最近一次 ${dateTime(r.lastTime)}` : ''),
    part('它当时想做什么', r.goal),
    part('遇到了什么', r.problem),
    part('它希望有什么', r.wish),
    h('h4', { text: '当时的现场（大脑自动附上的）' }),
    kv([
      ['谁', c.bot],
      ['版本', `大脑 ${c.brainVersion ?? '?'}，mod ${c.modVersion ?? '?'}`],
      ['第几轮', c.turn === undefined ? '–' : String(c.turn)],
      ['相关任务', tasks.length === 0 ? '–' : tasks.map((t) => `${t.id}${t.type ? `（${t.type}）` : ''}${t.state ? ` ${TASK_STATES[t.state] ?? t.state}` : ''}${t.error ? `：${t.error}` : ''}`).join('；')],
    ]),
    part('这一轮是被什么叫醒的', c.instruction),
    tools.length === 0 ? null : h('details', { class: 'fold', open: true }, h('summary', { text: `记这条之前最近的 ${tools.length} 次工具调用` }), tools.map((t) => h('pre', { class: 'code', text: `${t.tool} ${t.input}\n→ ${t.isError ? '[出错] ' : ''}${t.result}` }))),
  )
}

function renderFeedback(data) {
  const el = pane('feedback')
  if (!el) return
  const list = data.reports ?? []
  const category = h('select', { 'aria-label': '按类别筛' }, h('option', { value: '', text: '全部类别' }), Object.entries(FEEDBACK_CATEGORY_LABELS).map(([value, text]) => h('option', { value, text, selected: value === feedbackView.category })))
  const status = h(
    'select',
    { 'aria-label': '按状态筛' },
    [
      ['open', '还没处理的'],
      ['new', '没看过的'],
      ['handled', '已处理的'],
      ['', '全部'],
    ].map(([value, text]) => h('option', { value, text, selected: value === feedbackView.status })),
  )
  category.addEventListener('change', () => {
    feedbackView.category = category.value
    loadFeedback()
  })
  status.addEventListener('change', () => {
    feedbackView.status = status.value
    loadFeedback()
  })
  // 导出的就是现在筛出来的这些，连同每条附带的现场
  const exportLink = h('a', { class: 'button', href: `/api/feedback/export${feedbackQuery()}`, download: '', text: `导出这 ${list.length + (data.more ?? 0)} 条` })
  const items = list.map((r) => {
    const b = h(
      'button',
      { type: 'button', class: 'pick', 'aria-current': String(r.id === feedbackView.openId) },
      h('span', { class: 'pick-title' }, h('span', { text: r.title }), r.count > 1 ? h('span', { class: 'muted', text: `×${r.count}` }) : null),
      h('span', { class: 'pick-sub' }, badge(FEEDBACK_STATUS_LABELS[r.status] ?? r.status, FEEDBACK_STATUS_TONES[r.status] ?? ''), badge(FEEDBACK_CATEGORY_LABELS[r.category] ?? r.category), h('span', { text: ` ${when(r.lastTime)}` })),
    )
    b.addEventListener('click', () => act(b, () => openFeedback(r.id)))
    return h('li', null, b)
  })
  const shown = feedbackView.report && feedbackView.openId === feedbackView.report.id ? feedbackView.report : null
  put(el, 
    h('p', { class: 'muted', text: `它干活时觉得哪里有问题——没有合适的工具、工具的结果不对、手册和实际对不上、你让做的它做不到——自己记在这里的。同一个问题一天之内再记，只加次数。共 ${num(data.total)} 条，${num(data.unread)} 条没看过。` }),
    h('div', { class: 'row filters' }, category, status, h('span', { class: 'spacer' }), list.length > 0 ? exportLink : null),
    h(
      'div',
      { class: 'split' },
      h('div', null, list.length === 0 ? empty(data.total === 0 ? '还没有记录' : '这个筛选下没有记录', data.total === 0 ? '它遇到问题会自己记。' : '换一个筛选条件看看。') : h('ul', { class: 'picks', 'aria-label': '意见' }, items), data.more > 0 ? h('p', { class: 'hint', text: `还有更早的 ${data.more} 条没列出来；导出的文件里有全部。` }) : null),
      shown ? feedbackDetail(shown) : h('div', { class: 'card detail' }, empty(list.length > 0 ? '点左边的一条看详情' : '', list.length > 0 ? '点开就算看过了；导航上的数字是还没看过的条数。' : '')),
    ),
  )
  setCount(data.unread)
}

/** 二级标签“意见簿”旁边的数字：还没看过的条数。 */
function setCount(n) {
  const tab = root?.querySelector('.subtabs button[data-id="feedback"]')
  if (!tab) return
  tab.querySelector('.count')?.remove()
  if (n > 0) tab.append(h('span', { class: 'count', title: '还没看过的条数', text: String(n) }))
}

// ════════ 进出这一页 ════════

function show(tab) {
  current = tab
  // 头一次进这一块：数据到之前先写一句，不留白
  const target = root.querySelector(`[data-tab="${tab}"]`)
  if (target && target.childElementCount === 0) put(target, h('p', { class: 'muted loading', text: '正在取…' }))
  for (const p of root.querySelectorAll('[data-tab]')) p.hidden = p.dataset.tab !== tab
  for (const b of root.querySelectorAll('.subtabs button')) b.setAttribute('aria-selected', String(b.dataset.id === tab))
  if (tab === 'memory') loadMemory()
  else if (tab === 'manuals') loadManuals()
  else loadFeedback()
}

export function enter(el, sub) {
  root = el
  // 同一页里换一块也会再进来一次：先把上一次接的通知退掉
  for (const off of unsubscribe) off()
  unsubscribe = []
  if (el.childElementCount === 0) {
    el.append(h('h1', { class: 'page-title', text: '知识' }), subTabs(TABS, current, (id) => (location.hash = `#knowledge/${id}`)), ...TABS.map((t) => h('div', { 'data-tab': t.id, hidden: true })))
  }
  setCount(state.overview?.feedback?.unread ?? 0)
  // 导航上那个数字是意见簿里没看过的条数：有的话，点“知识”先落在意见簿
  show(TABS.some((t) => t.id === sub) ? sub : (state.overview?.feedback?.unread ?? 0) > 0 ? 'feedback' : current)
  unsubscribe = [bus.on('overview', (o) => setCount(o.feedback?.unread ?? 0))]
}

export function leave() {
  for (const off of unsubscribe) off()
  unsubscribe = []
}

// “清单”页：工作清单（GET/POST/DELETE /api/todo）。交代下来的事还剩哪些——两条线和主人共用这一张：
// 对话线、干活线都会往上写、改、勾掉，主人在这里也能加、改、勾掉、标成在等人、重新打开、删。
// 没做完的（没做、在等人）照编号排在前面；做完的在后面，可以收起来。

import { state } from './data.js'
import { addForm, keepFocus, orphanErrors, todoRow, todoUi } from './todo.js'
import { bus, empty, h, put } from './ui.js'

let root = null
let unsubscribe = []
/** 做完的那一块收着没有。 */
let doneOpen = false

function render(force = false) {
  if (!root) return
  // 正在改一条的时候，轮询回来的新清单先不画（填了一半的字会被冲掉）；改完、取消时会再画
  if (!force && todoUi.editing) return
  keepFocus(root, () => paint())
}

function paint() {
  const data = state.todo
  const intro = h('p', { class: 'muted', text: '交代下来的事还剩哪些。两条线和你共用这一张：对话线、干活线都会往上写、改、勾掉，你也可以。加了没做的、而干活线停着时，它会被叫醒去做。在这里改的都算你改的。' })
  if (!data) return put(root, h('h1', { class: 'page-title', text: '工作清单' }), intro, h('p', { class: 'muted loading', text: '正在取…' }))
  if (!data.available) return put(root, h('h1', { class: 'page-title', text: '工作清单' }), empty('这个大脑上没有工作清单', '后端没提供这份存储。'))
  const items = data.items ?? []
  const pending = items.filter((i) => i.state !== 'done')
  const done = items.filter((i) => i.state === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.id - a.id)
  const c = data.counts ?? {}
  const doneBlock = h(
    'details',
    { class: 'card todo-done', open: doneOpen },
    h('summary', null, h('h2', { text: `做完的 ${done.length} 条` }), h('span', { class: 'muted', text: '（最近做完的在前；只留最近 20 条）' })),
    done.length === 0 ? h('p', { class: 'muted', text: '还没有做完的。' }) : h('ul', { class: 'todo-list' }, done.map((i) => todoRow(i))),
  )
  doneBlock.addEventListener('toggle', () => (doneOpen = doneBlock.open))
  put(
    root,
    h('div', { class: 'row todo-head' }, h('h1', { class: 'page-title fill', text: '工作清单' }), h('span', { class: 'muted', text: `没做 ${c.open ?? 0} · 在等人 ${c.waiting ?? 0} · 做完 ${c.done ?? 0}` })),
    intro,
    h(
      'div',
      { class: 'card' },
      h('h2', { text: `还要做的 ${pending.length} 条` }),
      addForm({ full: true }),
      orphanErrors(items),
      pending.length === 0 ? empty('清单上没有要做的事', '在上面加一条，或者在聊天里交代给它，它会自己记上。') : h('ul', { class: 'todo-list' }, pending.map((i) => todoRow(i))),
    ),
    doneBlock,
  )
}

export function enter(el) {
  root = el
  for (const off of unsubscribe) off()
  todoUi.onChange = () => render(true)
  render(true)
  unsubscribe = [bus.on('todo', () => render())]
}

export function leave() {
  for (const off of unsubscribe) off()
  unsubscribe = []
  todoUi.editing = null
}

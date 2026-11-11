// 工作清单的一条怎么画、怎么改：“现在”页那一块和“清单”页共用。
// 一条：编号、内容、状态（没做 / 在等人 / 做完）、备注、谁写的、什么时候；在等人的写着等什么。
// 改动都走 POST /api/todo（算主人改的）；被拒时后端的原话（英文）照样写在那一条下面。

import { editTodo, refreshTodo, removeTodo } from './data.js'
import { ApiError, button, dateTime, h } from './ui.js'

export const TODO_BY = { talk: '对话线', work: '干活线', owner: '你' }
const STATE_LABELS = { open: '没做', waiting: '在等人', done: '做完了' }

/**
 * 这一块正在改哪一条、改什么（{ id, mode: 'edit' | 'wait' }），和每一条上次被拒的原话。
 * 正在改的时候清单页不随着轮询重画，免得填了一半的字被冲掉。
 */
export const todoUi = { editing: null, errors: new Map(), onChange: () => {} }

const rerender = () => todoUi.onChange()

/** 改一条（或几条），被拒时把原话记到 id 上；成功返回 true。 */
async function change(id, edits, btn) {
  if (btn) btn.disabled = true
  try {
    await editTodo({ change: edits })
    todoUi.errors.delete(id)
    if (todoUi.editing?.id === id) todoUi.editing = null
    rerender()
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return false
    todoUi.errors.set(id, e.message)
    rerender()
    // 多半是清单在别处刚变过（两条线也在改）：再取一遍，看到的才是现在的样子
    if (e instanceof ApiError && e.status === 400) refreshTodo()
    return false
  } finally {
    if (btn) btn.disabled = false
  }
}

/** 被拒的那几条已经不在清单上了（别处刚删掉）：原话放在清单顶上，点“知道了”收掉。 */
export function orphanErrors(items) {
  const gone = [...todoUi.errors].filter(([id]) => !items.some((i) => i.id === id))
  if (gone.length === 0) return null
  return h(
    'div',
    { class: 'todo-orphans', role: 'alert' },
    gone.map(([id, message]) => h('p', { class: 'error' }, `没改成第 ${id} 条（它已经不在清单上了，可能刚被删掉）：${message} `, button('知道了', { class: 'small' }, () => {
      todoUi.errors.delete(id)
      rerender()
    }))),
  )
}

/** 几点几分；不是今天的带上日子（秒数在鼠标移上去的说明里）。 */
function shortWhen(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 谁写的、什么时候；改过的再写谁改的；做完的写什么时候做完。 */
function metaLine(item) {
  const who = (by) => TODO_BY[by] ?? by
  const bits = [h('span', null, h('span', { class: `todo-by by-${item.by}`, text: who(item.by) }), h('span', { title: dateTime(item.at), text: ` ${shortWhen(item.at)} 写的` }))]
  if (item.state === 'done' && item.doneAt) bits.push(h('span', { title: dateTime(item.doneAt) }, item.changedBy ? h('span', { class: `todo-by by-${item.changedBy}`, text: who(item.changedBy) }) : null, ` ${shortWhen(item.doneAt)} 勾掉的`))
  else if (item.changedBy && item.changedAt) bits.push(h('span', { title: dateTime(item.changedAt) }, h('span', { class: `todo-by by-${item.changedBy}`, text: who(item.changedBy) }), ` ${shortWhen(item.changedAt)} 改过`))
  return h('div', { class: 'todo-meta' }, bits.flatMap((b, n) => (n === 0 ? [b] : [h('span', { class: 'faint', text: '·' }), b])))
}

/**
 * 一条。compact：“现在”页那一块用的，只有勾掉它这一个动作，不能改。
 */
export function todoRow(item, { compact = false } = {}) {
  const done = item.state === 'done'
  const editing = todoUi.editing?.id === item.id ? todoUi.editing.mode : null
  const check = button(done ? '↺' : '✓', { class: `todo-check${done ? ' done' : ''}`, title: done ? '重新打开：还没做完' : '标成做完了', 'aria-label': done ? `重新打开第 ${item.id} 条` : `第 ${item.id} 条标成做完了` }, (btn) => change(item.id, [{ id: item.id, state: done ? 'open' : 'done' }], btn))
  const error = todoUi.errors.get(item.id)
  const actions = compact
    ? null
    : h(
        'div',
        { class: 'todo-actions' },
        button('改', { class: 'small', disabled: editing !== null }, () => {
          todoUi.editing = { id: item.id, mode: 'edit' }
          rerender()
        }),
        item.state === 'open'
          ? button('在等人…', { class: 'small', disabled: editing !== null, title: '这件事卡在等谁、等什么上' }, () => {
              todoUi.editing = { id: item.id, mode: 'wait' }
              rerender()
            })
          : item.state === 'waiting'
            ? button('不等了', { class: 'small', title: '重新打开：不再等，接着做' }, (btn) => change(item.id, [{ id: item.id, state: 'open' }], btn))
            : null,
        button('删', { class: 'small danger', title: '从清单上删掉（不是做完）' }, async (btn) => {
          if (!confirm(`从清单上删掉第 ${item.id} 条？\n${item.text}\n（做完了的话点 ✓，不用删。）`)) return
          btn.disabled = true
          try {
            await removeTodo(item.id)
            todoUi.errors.delete(item.id)
            rerender()
          } catch (e) {
            if (!(e instanceof ApiError && e.status === 401)) {
              todoUi.errors.set(item.id, e.message)
              rerender()
            }
          } finally {
            btn.disabled = false
          }
        }),
      )
  return h(
    'li',
    { class: `todo s-${item.state}${compact ? ' compact' : ''}` },
    check,
    h(
      'div',
      { class: 'todo-body' },
      editing === 'edit'
        ? editForm(item)
        : [
            h('div', { class: 'todo-text' }, h('span', { class: 'todo-id', text: `#${item.id}` }), h('span', { text: item.text }), item.state === 'waiting' ? h('span', { class: 'chip warn', text: '在等人' }) : null),
            item.state === 'waiting' ? h('div', { class: 'todo-waiting' }, h('span', { class: 'muted', text: '在等：' }), item.waitingFor ?? '（没写等什么）') : null,
            item.note ? h('div', { class: 'todo-note' }, h('span', { class: 'muted', text: '备注：' }), item.note) : null,
            editing === 'wait' ? waitForm(item) : null,
            compact ? null : metaLine(item),
          ],
      error ? h('p', { class: 'error', role: 'alert', text: `没改成：${error}` }) : null,
    ),
    editing === 'edit' ? null : actions,
  )
}

/** 改内容和备注（在等人的还能改等什么）。只把改了的那几样发出去。 */
function editForm(item) {
  const text = h('textarea', { rows: 2, maxLength: 500, value: item.text, required: true, 'aria-label': '要做的事' })
  const note = h('input', { type: 'text', maxLength: 300, value: item.note ?? '', placeholder: '备注（可以不写；清空就是去掉）', 'aria-label': '备注' })
  const waiting = item.state === 'waiting' ? h('input', { type: 'text', maxLength: 200, value: item.waitingFor ?? '', placeholder: '在等谁、等什么', 'aria-label': '在等什么' }) : null
  const save = h('button', { type: 'submit', class: 'small primary', text: '保存' })
  const cancel = button('取消', { class: 'small' }, () => {
    todoUi.editing = null
    todoUi.errors.delete(item.id)
    rerender()
  })
  const form = h('form', { class: 'todo-form' }, text, note, waiting, h('div', { class: 'row' }, save, cancel))
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    const edit = { id: item.id }
    if (text.value.trim() !== item.text) edit.text = text.value.trim()
    if (note.value.trim() !== (item.note ?? '')) edit.note = note.value.trim()
    if (waiting && waiting.value.trim() !== (item.waitingFor ?? '')) edit.waitingFor = waiting.value.trim()
    if (Object.keys(edit).length === 1) {
      todoUi.editing = null
      return rerender()
    }
    change(item.id, [edit], save)
  })
  setTimeout(() => text.focus(), 0)
  return form
}

/** 标成在等人：要写等什么。 */
function waitForm(item) {
  const input = h('input', { type: 'text', maxLength: 200, required: true, placeholder: '在等谁、等什么，比如：Steve 把高炉的料送来', 'aria-label': '在等什么' })
  const ok = h('button', { type: 'submit', class: 'small primary', text: '标成在等人' })
  const cancel = button('取消', { class: 'small' }, () => {
    todoUi.editing = null
    todoUi.errors.delete(item.id)
    rerender()
  })
  const form = h('form', { class: 'todo-form row' }, input, ok, cancel)
  form.addEventListener('submit', (ev) => {
    ev.preventDefault()
    change(item.id, [{ id: item.id, waitingFor: input.value.trim() }], ok)
  })
  setTimeout(() => input.focus(), 0)
  return form
}

/** 加一条的表单里还没交出去的字（清单一变整块会重画，字要留着）。 */
const drafts = { text: '', note: '' }

/** 加一条的表单。full：带备注那一栏（清单页）；不带的是“现在”页那一块上的一行。 */
export function addForm({ full = false } = {}) {
  const text = h('input', { type: 'text', maxLength: 500, required: true, value: drafts.text, placeholder: '加一件要做的事', 'aria-label': '要做的事', 'data-focus': 'todo-add-text' })
  const note = full ? h('input', { type: 'text', maxLength: 300, value: drafts.note, placeholder: '备注（可以不写）', 'aria-label': '备注', 'data-focus': 'todo-add-note' }) : null
  text.addEventListener('input', () => (drafts.text = text.value))
  note?.addEventListener('input', () => (drafts.note = note.value))
  const add = h('button', { type: 'submit', class: full ? 'primary' : 'small', text: '加上' })
  const error = h('p', { class: 'error', role: 'alert', hidden: true })
  const form = h('form', { class: `todo-add${full ? ' full' : ''}` }, h('div', { class: 'todo-add-row' }, text, note, add), error)
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    add.disabled = true
    try {
      await editTodo({ add: [{ text: text.value.trim(), ...(note && note.value.trim() ? { note: note.value.trim() } : {}) }] })
      text.value = drafts.text = ''
      if (note) note.value = drafts.note = ''
      error.hidden = true
      rerender()
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return
      error.textContent = `没加上：${e.message}`
      error.hidden = false
    } finally {
      add.disabled = false
    }
  })
  return form
}

export const stateLabel = (s) => STATE_LABELS[s] ?? s

/** 重画一块之前记下焦点在哪个输入框、光标在哪；画完放回去。 */
export function keepFocus(rootEl, paint) {
  const active = document.activeElement
  const key = rootEl.contains(active) ? active?.dataset?.focus : undefined
  const at = key ? [active.selectionStart, active.selectionEnd] : null
  paint()
  if (!key) return
  const again = rootEl.querySelector(`[data-focus="${key}"]`)
  again?.focus()
  if (at && again?.setSelectionRange) again.setSelectionRange(at[0], at[1])
}

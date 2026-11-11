// 工作清单（store/todo.ts）给模型的那一面：工具 todo（两条线都有），和每一轮“当前状态”里那几行。
// 只陈述清单上有什么、改了什么；做不做、先做哪件由模型定。

import { TodoRefused } from '../store/todo.ts'
import type { TodoApplied, TodoBy, TodoEdit, TodoItem } from '../store/todo.ts'
import { arr, bool, int, obj, str } from './schema.ts'
import { fail } from './types.ts'
import type { Tool } from './types.ts'

export interface TodoAccess {
  list(): TodoItem[]
  /** 有一处不对整次不做，抛 TodoRefused。 */
  apply(edit: TodoEdit, by: TodoBy, now: number): TodoApplied
}

const WHO: Record<TodoBy, string> = { talk: 'the talk line', work: 'the work line', owner: 'your owner on the panel' }

/** 今天的写几点几分，别的日子带上月日。 */
function when(t: number, now: number): string {
  const d = new Date(t)
  const today = new Date(now)
  const pad = (x: number) => String(x).padStart(2, '0')
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  return sameDay ? clock : `${d.getMonth() + 1}-${d.getDate()} ${clock}`
}

/** 一条写成一行：编号、状态、内容、谁什么时候写的、备注。 */
export function todoLine(i: TodoItem, now: number): string {
  const note = i.note ? ` — note: ${i.note}` : ''
  if (i.state === 'done') return `- #${i.id} done ${when(i.doneAt ?? i.changedAt ?? i.at, now)}: ${i.text}${note}`
  const state = i.state === 'waiting' ? `waiting for ${i.waitingFor ?? '?'}` : 'not done'
  return `- #${i.id} ${state}: ${i.text} (${WHO[i.by]}, ${when(i.at, now)})${note}`
}

const counts = (items: readonly TodoItem[]) => ({
  open: items.filter((i) => i.state === 'open').length,
  waiting: items.filter((i) => i.state === 'waiting').length,
  done: items.filter((i) => i.state === 'done').length,
})

/** 做完的照做完的先后（最近的在前）。 */
const doneLatest = (items: readonly TodoItem[]): TodoItem[] =>
  items.filter((i) => i.state === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.id - a.id)

/** 每一轮“当前状态”里列的几条最近做完的。 */
export const TODO_DONE_IN_STATE = 3

/**
 * “当前状态”里的清单：没做的、在等人的全列，再加最近做完的几条。清单上什么都没有时不写。
 */
export function todoStateText(items: readonly TodoItem[], now: number): string {
  if (items.length === 0) return ''
  const c = counts(items)
  const notDone = items.filter((i) => i.state !== 'done')
  const done = doneLatest(items).slice(0, TODO_DONE_IN_STATE)
  const lines = [`To-do list (todo; the same list for both lines and your owner): ${c.open} not done, ${c.waiting} waiting, ${c.done} done`]
  for (const i of notDone) lines.push(todoLine(i, now))
  if (done.length > 0) lines.push(`Latest done:`, ...done.map((i) => todoLine(i, now)))
  return lines.join('\n')
}

/** 整张清单（工具的结果）。 */
export function todoListText(items: readonly TodoItem[], now: number): string {
  if (items.length === 0) return 'The to-do list is empty.'
  const c = counts(items)
  const lines = [`To-do list: ${c.open} not done, ${c.waiting} waiting, ${c.done} done.`]
  for (const i of items) if (i.state !== 'done') lines.push(todoLine(i, now))
  const done = doneLatest(items)
  if (done.length > 0) lines.push('Done (latest first):', ...done.map((i) => todoLine(i, now)))
  return lines.join('\n')
}

const ids = (list: readonly number[]): string => list.map((id) => `#${id}`).join(', ')

/** 这一次改了什么，一句话。 */
function changedText(res: TodoApplied, before: readonly TodoItem[]): string {
  const parts: string[] = []
  if (res.added.length > 0) parts.push(`added ${ids(res.added)}`)
  for (const id of res.changed) {
    const now = res.items.find((i) => i.id === id)
    const was = before.find((i) => i.id === id)
    if (!now) continue
    const what = now.state !== was?.state ? (now.state === 'done' ? 'marked done' : now.state === 'waiting' ? 'marked waiting' : 'reopened') : 'changed'
    parts.push(`#${id} ${what}`)
  }
  if (res.removed.length > 0) parts.push(`removed ${ids(res.removed)}`)
  if (res.cleared.length > 0) parts.push(`cleared ${ids(res.cleared)} (only the latest done ones are kept)`)
  return parts.length > 0 ? `Changed: ${parts.join('; ')}.` : ''
}

interface TodoInput {
  add?: { text: string; note?: string }[]
  change?: { id: number; text?: string; note?: string; state?: 'open' | 'waiting' | 'done'; waitingFor?: string; remove?: boolean }[]
}

// 长度不写进 schema（每一轮都发）：太长的由 store/todo.ts 拒绝并说明上限。备注可以是空串（去掉备注）。
const note = { type: 'string' as const }

export const todo: Tool = {
  name: 'todo',
  description:
    'The to-do list, kept apart from your history: both lines and your owner (on the panel) see and change the same one; it outlasts restarts. Without input it returns the list. ' +
    'add: new items (not done). change, by id: text, note ("" removes it), state ("open" = not done, also to reopen; "waiting" with waitingFor = who or what it waits for; "done"), or remove: true. Returns the whole list.',
  inputSchema: obj({
    add: arr(undefined, obj({ text: str(), note }, ['text'])),
    change: arr(undefined, obj({ id: int(), text: str(), note, state: str(undefined, { enum: ['open', 'waiting', 'done'] }), waitingFor: str(), remove: bool() }, ['id'])),
  }),
  async run(ctx, input: TodoInput) {
    if (!ctx.todo) return fail('There is no to-do list on this brain.')
    const before = ctx.todo.list()
    if ((input.add ?? []).length === 0 && (input.change ?? []).length === 0) {
      return { content: todoListText(before, ctx.now()), data: { items: before, added: [], changed: [], removed: [], cleared: [] } }
    }
    let res: TodoApplied
    try {
      res = ctx.todo.apply(input, ctx.line ?? 'work', ctx.now())
    } catch (e) {
      if (e instanceof TodoRefused) return fail(`Nothing was changed: ${e.problems.join(' ')}`)
      return fail(e instanceof Error ? e.message : String(e))
    }
    const head = changedText(res, before)
    return { content: [head, todoListText(res.items, ctx.now())].filter(Boolean).join('\n'), data: res }
  },
}

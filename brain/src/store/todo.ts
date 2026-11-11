// 工作清单：主人一次交代了一串事时，“还要做什么”记在这里，不只留在对话历史里。
// 两条线都能看、都能改（工具 todo），主人在面板上也能改。单独一个文件（todo.json），重启不丢，和历史压缩无关。
//
// 每一条：编号、内容、状态（没做 / 在等人 / 做完）、谁写的（对话线 / 干活线 / 主人）、什么时候、可选的一句备注。
// 在等人的写着等谁、等什么。做完的只留最近 TODO_DONE_KEPT 条，更早的清掉（改动的结果里照实列出清掉了哪几条）。
//
// 一次改动里的几处要么全做、要么一处都不做：有一处不对（编号不在清单上、标成在等人却没写等什么……）整次拒绝，说清哪几处。

import path from 'node:path'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export type TodoState = 'open' | 'waiting' | 'done'
/** 谁写的：对话线、干活线、主人（面板）。 */
export type TodoBy = 'talk' | 'work' | 'owner'

export interface TodoItem {
  id: number
  text: string
  state: TodoState
  /** 在等谁、等什么（在等人时才有）。 */
  waitingFor?: string
  /** 一句备注。 */
  note?: string
  /** 谁写下的、什么时候（epoch ms）。 */
  by: TodoBy
  at: number
  /** 最近一次谁改的、什么时候（写下以后没改过就没有）。 */
  changedBy?: TodoBy
  changedAt?: number
  /** 什么时候标成做完的。 */
  doneAt?: number
}

/** 改一条：给了哪几样改哪几样。state open 是“没做”（做完的、在等人的重新打开）；remove 是删掉。 */
export interface TodoChange {
  id: number
  text?: string
  /** 空字符串是去掉备注。 */
  note?: string
  state?: TodoState
  /** 等谁、等什么。给了而没给 state，就是标成在等人。 */
  waitingFor?: string
  remove?: boolean
}

export interface TodoEdit {
  add?: { text: string; note?: string }[]
  change?: TodoChange[]
}

export interface TodoApplied {
  /** 改完以后的整张清单。 */
  items: TodoItem[]
  added: number[]
  changed: number[]
  removed: number[]
  /** 做完的超过了 TODO_DONE_KEPT 条，清掉的那几条（最早做完的）。 */
  cleared: number[]
}

/** 没做完的（没做 + 在等人）最多这么多条。 */
export const TODO_OPEN_MAX = 100
/** 做完的留最近这么多条。 */
export const TODO_DONE_KEPT = 20
export const TODO_TEXT_MAX_CHARS = 500
export const TODO_NOTE_MAX_CHARS = 300
export const TODO_WAITING_MAX_CHARS = 200

/** 改动不对：problems 是给模型、给面板看的那几句（英文）。 */
export class TodoRefused extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(problems.join(' '))
    this.problems = problems
  }
}

const BY: readonly TodoBy[] = ['talk', 'work', 'owner']
const STATES: readonly TodoState[] = ['open', 'waiting', 'done']

function parse(raw: unknown): TodoItem | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'number' || typeof raw.text !== 'string' || !STATES.includes(raw.state as TodoState)) return undefined
  const by = BY.includes(raw.by as TodoBy) ? (raw.by as TodoBy) : 'owner'
  const state = raw.state as TodoState
  return {
    id: raw.id,
    text: raw.text,
    state,
    ...(state === 'waiting' && typeof raw.waitingFor === 'string' ? { waitingFor: raw.waitingFor } : {}),
    ...(typeof raw.note === 'string' && raw.note ? { note: raw.note } : {}),
    by,
    at: typeof raw.at === 'number' ? raw.at : 0,
    ...(BY.includes(raw.changedBy as TodoBy) ? { changedBy: raw.changedBy as TodoBy } : {}),
    ...(typeof raw.changedAt === 'number' ? { changedAt: raw.changedAt } : {}),
    ...(state === 'done' && typeof raw.doneAt === 'number' ? { doneAt: raw.doneAt } : {}),
  }
}

/** 压成一行、去掉首尾空白。 */
const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim()

export class TodoStore {
  private readonly file: string
  private items: TodoItem[] = []
  private nextId = 1
  /** 改过几次（不落盘）：清单变没变就看它。 */
  private rev = 0
  private readonly listeners: (() => void)[] = []

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'todo.json')
    const raw = readJson(this.file)
    if (isRecord(raw) && Array.isArray(raw.items)) {
      for (const r of raw.items) {
        const item = parse(r)
        if (item && !this.items.some((i) => i.id === item.id)) this.items.push(item)
      }
      this.items.sort((a, b) => a.id - b.id)
    }
    const top = this.items.reduce((max, i) => Math.max(max, i.id), 0)
    this.nextId = Math.max(top + 1, isRecord(raw) && typeof raw.nextId === 'number' ? raw.nextId : 1)
  }

  /** 整张清单，照编号排。 */
  list(): TodoItem[] {
    return this.items.map((i) => ({ ...i }))
  }

  revision(): number {
    return this.rev
  }

  /** 清单一变就调（两条线、面板，谁改的都算）。 */
  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  /** 加几条、改几条。有一处不对整次不做，抛 TodoRefused。 */
  apply(edit: TodoEdit, by: TodoBy, now: number): TodoApplied {
    const problems: string[] = []
    const adds = (edit.add ?? []).map((a) => ({ text: oneLine(a.text ?? ''), note: oneLine(a.note ?? '') }))
    adds.forEach((a, i) => {
      if (a.text.length === 0) problems.push(`add[${i}]: the text is empty.`)
      else if (a.text.length > TODO_TEXT_MAX_CHARS) problems.push(`add[${i}]: the text is ${a.text.length} characters (at most ${TODO_TEXT_MAX_CHARS}).`)
      if (a.note.length > TODO_NOTE_MAX_CHARS) problems.push(`add[${i}]: the note is ${a.note.length} characters (at most ${TODO_NOTE_MAX_CHARS}).`)
    })
    const next = this.items.map((i) => ({ ...i }))
    const seen = new Set<number>()
    const changed: number[] = []
    const removed: number[] = []
    for (const c of edit.change ?? []) {
      const at = `#${c.id}`
      if (seen.has(c.id)) {
        problems.push(`${at} is changed twice in one call: put everything for it in one change.`)
        continue
      }
      seen.add(c.id)
      const index = next.findIndex((i) => i.id === c.id)
      if (index < 0) {
        problems.push(`${at} is not on the list.`)
        continue
      }
      if (c.remove === true) {
        removed.push(c.id)
        continue
      }
      const item = next[index]!
      const text = c.text !== undefined ? oneLine(c.text) : undefined
      const note = c.note !== undefined ? oneLine(c.note) : undefined
      const waitingFor = c.waitingFor !== undefined ? oneLine(c.waitingFor) : undefined
      const state = c.state ?? (waitingFor !== undefined ? 'waiting' : undefined)
      if (text !== undefined && text.length === 0) problems.push(`${at}: the text is empty.`)
      if (text !== undefined && text.length > TODO_TEXT_MAX_CHARS) problems.push(`${at}: the text is ${text.length} characters (at most ${TODO_TEXT_MAX_CHARS}).`)
      if (note !== undefined && note.length > TODO_NOTE_MAX_CHARS) problems.push(`${at}: the note is ${note.length} characters (at most ${TODO_NOTE_MAX_CHARS}).`)
      if (waitingFor !== undefined && state !== 'waiting') problems.push(`${at}: waitingFor goes with state "waiting" (it was given with state "${state}").`)
      if (waitingFor !== undefined && waitingFor.length > TODO_WAITING_MAX_CHARS) problems.push(`${at}: waitingFor is ${waitingFor.length} characters (at most ${TODO_WAITING_MAX_CHARS}).`)
      if (state === 'waiting' && (waitingFor ?? (item.state === 'waiting' ? item.waitingFor : undefined) ?? '').length === 0) problems.push(`${at}: "waiting" needs waitingFor: who or what it waits for.`)
      if (text === undefined && note === undefined && state === undefined) problems.push(`${at}: nothing to change (give text, note, state, waitingFor, or remove).`)
      const updated: TodoItem = { ...item }
      if (text !== undefined) updated.text = text
      if (note !== undefined) {
        if (note.length > 0) updated.note = note
        else delete updated.note
      }
      if (state !== undefined && state !== item.state) {
        updated.state = state
        if (state === 'done') updated.doneAt = now
        else delete updated.doneAt
      }
      if (updated.state === 'waiting') updated.waitingFor = waitingFor ?? item.waitingFor ?? ''
      else delete updated.waitingFor
      updated.changedBy = by
      updated.changedAt = now
      next[index] = updated
      changed.push(c.id)
    }
    const left = next.filter((i) => !removed.includes(i.id))
    const stillOpen = left.filter((i) => i.state !== 'done').length + adds.length
    if (stillOpen > TODO_OPEN_MAX) problems.push(`The list would have ${stillOpen} items not done; it holds at most ${TODO_OPEN_MAX}: mark some done or remove some first.`)
    if (problems.length > 0) throw new TodoRefused(problems)

    const added: number[] = []
    for (const a of adds) {
      const id = this.nextId++
      added.push(id)
      left.push({ id, text: a.text, state: 'open', ...(a.note ? { note: a.note } : {}), by, at: now })
    }
    // 做完的只留最近 TODO_DONE_KEPT 条
    const done = left.filter((i) => i.state === 'done').sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0) || b.id - a.id)
    const cleared = done.slice(TODO_DONE_KEPT).map((i) => i.id)
    this.items = left.filter((i) => !cleared.includes(i.id)).sort((a, b) => a.id - b.id)
    if (added.length + changed.length + removed.length + cleared.length > 0) {
      this.rev++
      this.save()
      for (const fn of this.listeners) fn()
    }
    return { items: this.list(), added, changed, removed, cleared: cleared.sort((a, b) => a - b) }
  }

  private save(): void {
    writeJsonAtomic(this.file, { version: 1, nextId: this.nextId, items: this.items })
  }
}

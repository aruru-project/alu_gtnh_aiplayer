// 提醒的落盘。到点触发由 agent/reminders.ts 负责。

import path from 'node:path'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export interface Reminder {
  id: string
  dueAt: number
  note: string
  createdAt: number
  /** 哪条线定的：到点叫醒的是它。没有这一项的是对话线定的（两条线都能定之前留下的）。 */
  line?: 'talk' | 'work'
}

export const MAX_REMINDERS = 50

export class ReminderStore {
  private readonly file: string
  private items: Reminder[] = []
  private nextId = 1

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'reminders.json')
    const raw = readJson(this.file)
    if (isRecord(raw) && Array.isArray(raw.reminders)) {
      for (const r of raw.reminders) {
        if (isRecord(r) && typeof r.id === 'string' && typeof r.dueAt === 'number' && typeof r.note === 'string') {
          this.items.push({
            id: r.id,
            dueAt: r.dueAt,
            note: r.note,
            createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
            ...(r.line === 'work' || r.line === 'talk' ? { line: r.line } : {}),
          })
        }
      }
      if (typeof raw.nextId === 'number') this.nextId = raw.nextId
    }
  }

  list(): Reminder[] {
    return [...this.items].sort((a, b) => a.dueAt - b.dueAt)
  }

  add(dueAt: number, note: string, now: number = Date.now(), line?: 'talk' | 'work'): Reminder {
    if (this.items.length >= MAX_REMINDERS) throw new Error(`too many pending reminders (max ${MAX_REMINDERS})`)
    const reminder: Reminder = { id: `r${this.nextId++}`, dueAt, note, createdAt: now, ...(line !== undefined ? { line } : {}) }
    this.items.push(reminder)
    this.save()
    return reminder
  }

  remove(id: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((r) => r.id !== id)
    if (this.items.length !== before) {
      this.save()
      return true
    }
    return false
  }

  private save(): void {
    writeJsonAtomic(this.file, { nextId: this.nextId, reminders: this.list() })
  }
}

// 提醒的定时：到点把提醒交给 agent。提醒本身落在 ReminderStore 里，进程重启不丢；
// 重启时已经过点的会立刻触发。

import type { Reminder, ReminderStore } from '../store/reminders.ts'

const MAX_TIMER_MS = 2_000_000_000 // setTimeout 的上限约 24.8 天

export class ReminderScheduler {
  private readonly store: ReminderStore
  private readonly fire: (reminder: Reminder) => void
  private readonly now: () => number
  private timer: NodeJS.Timeout | undefined
  private started = false

  constructor(store: ReminderStore, fire: (reminder: Reminder) => void, now: () => number = Date.now) {
    this.store = store
    this.fire = fire
    this.now = now
  }

  start(): void {
    this.started = true
    this.arm()
  }

  stop(): void {
    this.started = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  add(dueAt: number, note: string): Reminder {
    const r = this.store.add(dueAt, note, this.now())
    if (this.started) this.arm()
    return r
  }

  list(): Reminder[] {
    return this.store.list()
  }

  remove(id: string): boolean {
    const removed = this.store.remove(id)
    if (removed && this.started) this.arm()
    return removed
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    const next = this.store.list()[0]
    if (!next) return
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next.dueAt - this.now()))
    this.timer = setTimeout(() => this.tick(), delay)
    this.timer.unref()
  }

  private tick(): void {
    this.timer = undefined
    const now = this.now()
    for (const r of this.store.list()) {
      if (r.dueAt > now) break
      // 先交出去再删：中途崩溃的话重启后会再触发一次，不会丢。
      try {
        this.fire(r)
      } finally {
        this.store.remove(r.id)
      }
    }
    if (this.started) this.arm()
  }
}

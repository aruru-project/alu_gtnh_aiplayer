// 用量记账：按本地日期累计。

import path from 'node:path'
import type { Usage } from '../llm/index.ts'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export interface DayUsage {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

const KEEP_DAYS = 90

export function localDateKey(now: number): string {
  const d = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function emptyDay(): DayUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

export class UsageStore {
  private readonly file: string
  private days = new Map<string, DayUsage>()

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'usage.json')
    const raw = readJson(this.file)
    if (isRecord(raw) && isRecord(raw.days)) {
      for (const [key, v] of Object.entries(raw.days)) {
        if (!isRecord(v)) continue
        const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
        this.days.set(key, {
          calls: num(v.calls),
          inputTokens: num(v.inputTokens),
          outputTokens: num(v.outputTokens),
          cacheReadTokens: num(v.cacheReadTokens),
          cacheWriteTokens: num(v.cacheWriteTokens),
        })
      }
    }
  }

  add(usage: Usage, now: number = Date.now()): void {
    const key = localDateKey(now)
    const day = this.days.get(key) ?? emptyDay()
    day.calls += 1
    day.inputTokens += usage.inputTokens
    day.outputTokens += usage.outputTokens
    day.cacheReadTokens += usage.cacheReadTokens ?? 0
    day.cacheWriteTokens += usage.cacheWriteTokens ?? 0
    this.days.set(key, day)
    const keys = [...this.days.keys()].sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) this.days.delete(old)
    writeJsonAtomic(this.file, { days: Object.fromEntries([...this.days.entries()].sort()) })
  }

  today(now: number = Date.now()): DayUsage {
    return { ...(this.days.get(localDateKey(now)) ?? emptyDay()) }
  }

  /** 今天已用的 token（输入+输出），和每日上限比较用。 */
  todayTokens(now: number = Date.now()): number {
    const d = this.today(now)
    return d.inputTokens + d.outputTokens
  }
}

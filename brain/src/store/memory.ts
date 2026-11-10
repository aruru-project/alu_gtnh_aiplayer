// 记忆：模型通过工具读写的持久笔记（键 → 文本）。地点（home 名字和用途）也记在这里。

import path from 'node:path'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export interface MemoryNote {
  key: string
  text: string
  updatedAt: number
}

export const MEMORY_KEY_MAX = 64
export const MEMORY_TEXT_MAX = 1000

export class MemoryStore {
  private readonly file: string
  private readonly getMaxChars: () => number
  private notes = new Map<string, { text: string; updatedAt: number }>()

  constructor(dataDir: string, getMaxChars: () => number) {
    this.file = path.join(dataDir, 'memory.json')
    this.getMaxChars = getMaxChars
    const raw = readJson(this.file)
    if (isRecord(raw) && isRecord(raw.notes)) {
      for (const [key, value] of Object.entries(raw.notes)) {
        if (isRecord(value) && typeof value.text === 'string') {
          this.notes.set(key, { text: value.text, updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0 })
        }
      }
    }
  }

  list(): MemoryNote[] {
    return [...this.notes.entries()]
      .map(([key, v]) => ({ key, text: v.text, updatedAt: v.updatedAt }))
      .sort((a, b) => a.key.localeCompare(b.key))
  }

  get(key: string): MemoryNote | undefined {
    const v = this.notes.get(key)
    return v ? { key, text: v.text, updatedAt: v.updatedAt } : undefined
  }

  totalChars(): number {
    let n = 0
    for (const [key, v] of this.notes) n += key.length + v.text.length
    return n
  }

  /** 写一条笔记。键或文本不合法、或总长度会超上限时抛 Error，消息可以直接给模型或人看。 */
  set(key: string, text: string, now: number = Date.now()): void {
    const k = key.trim()
    const t = text.trim()
    if (k.length === 0 || k.length > MEMORY_KEY_MAX) throw new Error(`key must be 1-${MEMORY_KEY_MAX} characters`)
    if (/[\r\n]/.test(k)) throw new Error('key must be a single line')
    if (t.length === 0) throw new Error('text is empty; use forget to delete a note')
    if (t.length > MEMORY_TEXT_MAX) throw new Error(`text is too long (${t.length} > ${MEMORY_TEXT_MAX} characters)`)
    const old = this.notes.get(k)
    const total = this.totalChars() - (old ? k.length + old.text.length : 0) + k.length + t.length
    const max = this.getMaxChars()
    if (total > max) {
      throw new Error(`memory is full (${total} > ${max} characters); forget or shorten other notes first`)
    }
    this.notes.set(k, { text: t, updatedAt: now })
    this.save()
  }

  delete(key: string): boolean {
    const existed = this.notes.delete(key.trim())
    if (existed) this.save()
    return existed
  }

  /** 放进提示词的文本；没有笔记时返回空字符串。 */
  render(): string {
    return this.list()
      .map((n) => `- ${n.key}: ${n.text.replace(/\s*\n\s*/g, ' / ')}`)
      .join('\n')
  }

  private save(): void {
    const notes: Record<string, { text: string; updatedAt: number }> = {}
    for (const n of this.list()) notes[n.key] = { text: n.text, updatedAt: n.updatedAt }
    writeJsonAtomic(this.file, { notes })
  }
}

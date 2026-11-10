// 活动日志：聊天、模型文本、工具调用和结果、错误。
// 内存里留最近一段给面板实时看（SSE），同时按天追加到 logs/activity-YYYY-MM-DD.jsonl。

import fs from 'node:fs'
import path from 'node:path'
import { appendLine, ensureDir, isRecord } from './files.ts'
import { localDateKey } from './usage.ts'

export type ActivityKind =
  | 'chat' // 游戏里别人说的话
  | 'whisper' // 别人私聊 bot
  | 'say' // bot 说的话（公共或私聊）
  | 'command' // 面板发来的指令
  | 'event' // 其他游戏事件（任务结束、受伤、进出……）
  | 'turn' // 一轮决策开始/结束
  | 'model_text' // 模型的文本输出（不进聊天）
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'info'

export interface ActivityEntry {
  id: number
  time: number
  kind: ActivityKind
  /** 一行能看完的正文。 */
  text: string
  /** 说话的人、工具名等。 */
  who?: string
  /** 可折叠的详细内容（工具参数、工具结果全文）。 */
  detail?: string
  isError?: boolean
  /** 属于哪一轮决策。 */
  turn?: number
  /** 这条工具结果带的图（store/pictures.ts 里的编号）。面板在这一条下面显示出来。 */
  pictures?: string[]
  /** pictures 里哪几张还存着画它用的盒子：面板给这几张加一个“三维预览”。 */
  scenes?: string[]
}

export type ActivityInput = Omit<ActivityEntry, 'id' | 'time'> & { time?: number }

const DETAIL_MAX = 8000
const KEEP_FILES = 14

export class ActivityLog {
  private readonly dir: string | undefined
  private readonly memoryLimit: number
  private entries: ActivityEntry[] = []
  private nextId = 1
  private readonly listeners = new Set<(entry: ActivityEntry) => void>()

  /** dataDir 不给则只留在内存里（测试用）。 */
  constructor(dataDir?: string, opts: { memoryLimit?: number } = {}) {
    this.memoryLimit = opts.memoryLimit ?? 500
    if (dataDir) {
      this.dir = path.join(dataDir, 'logs')
      ensureDir(this.dir)
      this.loadTail()
      this.prune()
    }
  }

  add(input: ActivityInput): ActivityEntry {
    const entry: ActivityEntry = { ...input, id: this.nextId++, time: input.time ?? Date.now() }
    if (entry.detail !== undefined && entry.detail.length > DETAIL_MAX) {
      entry.detail = `${entry.detail.slice(0, DETAIL_MAX)}\n…（已截断，原长 ${entry.detail.length} 字符）`
    }
    this.entries.push(entry)
    if (this.entries.length > this.memoryLimit) this.entries.splice(0, this.entries.length - this.memoryLimit)
    if (this.dir) {
      try {
        appendLine(path.join(this.dir, `activity-${localDateKey(entry.time)}.jsonl`), JSON.stringify(entry))
      } catch (e) {
        console.error('[log] 写活动日志失败：', e instanceof Error ? e.message : e)
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(entry)
      } catch {
        /* 某个订阅者坏了不影响其他 */
      }
    }
    return entry
  }

  /** id 大于 afterId 的最近若干条，按时间顺序。 */
  recent(afterId = 0, limit = 200): ActivityEntry[] {
    const list = this.entries.filter((e) => e.id > afterId)
    return list.slice(Math.max(0, list.length - limit))
  }

  subscribe(fn: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private files(): string[] {
    if (!this.dir) return []
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^activity-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort()
  }

  /** 启动时把最近一个文件的末尾读回来，这样重启大脑后面板上还能看到之前的日志。 */
  private loadTail(): void {
    const files = this.files()
    const last = files[files.length - 1]
    if (!this.dir || !last) return
    try {
      const lines = fs.readFileSync(path.join(this.dir, last), 'utf8').split('\n')
      for (const line of lines.slice(-this.memoryLimit - 1)) {
        if (line.trim().length === 0) continue
        try {
          const e: unknown = JSON.parse(line)
          if (isRecord(e) && typeof e.id === 'number' && typeof e.kind === 'string' && typeof e.text === 'string') {
            this.entries.push(e as unknown as ActivityEntry)
          }
        } catch {
          /* 跳过坏行 */
        }
      }
      this.nextId = this.entries.reduce((m, e) => Math.max(m, e.id), 0) + 1
    } catch {
      /* 读不了就从空开始 */
    }
  }

  private prune(): void {
    if (!this.dir) return
    const files = this.files()
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      fs.rmSync(path.join(this.dir, f), { force: true })
    }
  }
}

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
  | 'run' // 它写的程序（例程、run_program）的一次运行：一条滚动更新的汇总，明细在 logs/runs/ 里
  | 'model_call' // 一次模型调用：第几步、用时、token、怎么结束的。开始想时就出现，结束时原地更新

/** 一次程序运行（后台的例程，或者 run_program 当场跑的程序）现在的样子。 */
export interface ActivityRun {
  /** r3（例程）、p12（run_program 的程序）。 */
  id: string
  kind: 'routine' | 'program'
  name: string
  status: 'running' | 'done' | 'failed' | 'stopped' | 'limit'
  startedAt: number
  endedAt?: number
  calls: number
  tasks: number
  errors: number
  /** 正等着的那一步（工具名和参数，截短了的）。 */
  waiting?: string
  /** 全量记录在 logs/runs/ 下的哪个文件里；没有落盘时没有这一项。 */
  file?: string
}

/** 一次模型调用的账：第几步、用了多久、多少 token、怎么结束的。 */
export interface ActivityModelCall {
  /** thinking：还在想（只有 step、startedAt、purpose）；done：回来了；failed：出错了。 */
  state: 'thinking' | 'done' | 'failed'
  /** turn：一轮里的一步；compact：压缩历史的那次调用（没有 step）。 */
  purpose: 'turn' | 'compact'
  /** 这一轮的第几次模型调用（从 1 起）。 */
  step?: number
  startedAt: number
  ms?: number
  /** 接口回的模型名。 */
  model?: string
  /** 输入 token 总数，已含缓存读写的部分。 */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 怎么结束的：要调工具 / 说完了 / 被输出上限截断 / 别的 / 出错。 */
  stop?: 'tool_calls' | 'end' | 'truncated' | 'other' | 'error'
  /** 这一步模型要调几个工具。 */
  toolCalls?: number
  errorKind?: string
  error?: string
}

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
  /** 哪个代理的；不带就是主代理（以后它开的帮手各有各的名字）。 */
  agent?: string
  /** 这一轮的第几次模型调用（从 1 起）：model_call、model_text 和模型直接调的工具都带，面板把工具挂在那一步下面。 */
  step?: number
  /** 工具调用和结果是谁发起的：模型自己、run_program 的程序、后台的例程。 */
  source?: 'model' | 'program' | 'routine'
  /** 属于哪次程序运行（r3、p12）。每次大脑重启从 1 重新数，唯一的是 run.file。 */
  runId?: string
  /** kind 是 run 时：这次运行现在的样子（这一条会原地更新）。例程开始、结束的那两条也带着当时的样子。 */
  run?: ActivityRun
  /** kind 是 model_call 时：这次模型调用的账（这一条在调用结束时原地更新）。 */
  call?: ActivityModelCall
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

  /**
   * 原地改一条（程序运行的汇总跑着的时候不断更新）。订阅者（面板的实时日志）收到的是同一个 id 的新样子。
   * persist：把新样子也追加进当天的文件（读回来时同一个 id 以最后一行为准）。跑着的时候不落盘，结束时落一次。
   * 这一条已经滚出内存时返回 undefined。
   */
  update(id: number, patch: Partial<Omit<ActivityEntry, 'id'>>, opts: { persist?: boolean } = {}): ActivityEntry | undefined {
    const at = this.entries.findIndex((e) => e.id === id)
    if (at < 0) return undefined
    const entry: ActivityEntry = { ...this.entries[at]!, ...patch }
    this.entries[at] = entry
    if (opts.persist && this.dir) {
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

  /** id 大于 afterId 的一共有多少条还在内存里（recent 只给最新的那些时，用它知道中间有没有漏）。 */
  countAfter(afterId: number): number {
    return this.entries.reduce((n, e) => n + (e.id > afterId ? 1 : 0), 0)
  }

  /**
   * 往回翻：紧挨在 beforeId 之前的 limit 条，按时间顺序。内存里的不够就去读按天存的文件（新的日子在前，一天天往回）。
   * more：更早的还有没有。id 跨重启单调递增，所以可以一直拿这一页的第一条的 id 接着往回翻。
   */
  before(beforeId: number, limit = 200): { entries: ActivityEntry[]; more: boolean } {
    const want = Math.max(1, limit)
    const inMemory = this.entries.filter((e) => e.id < beforeId)
    const oldest = this.entries[0]?.id
    // 内存里够，而且内存里最老的那条比要的这一页还老：直接给
    if (inMemory.length > want) return { entries: inMemory.slice(inMemory.length - want), more: true }
    if (!this.dir) return { entries: inMemory, more: false }
    // 从文件里补：只要 id 比内存里最老的还小的（内存里有的以内存为准，它可能被原地改过）
    const ceiling = Math.min(beforeId, oldest ?? Infinity)
    const older: ActivityEntry[] = []
    let more = false
    for (const file of this.files().reverse()) {
      if (older.length + inMemory.length > want) {
        more = true
        break
      }
      const day = this.readFile(file).filter((e) => e.id < ceiling)
      older.unshift(...day)
    }
    const all = [...older, ...inMemory]
    if (all.length > want) return { entries: all.slice(all.length - want), more: true }
    return { entries: all, more }
  }

  /** 一天的文件里的全部条目，按 id 排好；同一个 id 出现两次（原地改过的）以后一行为准。 */
  private readFile(file: string): ActivityEntry[] {
    if (!this.dir) return []
    const byId = new Map<number, ActivityEntry>()
    let content: string
    try {
      content = fs.readFileSync(path.join(this.dir, file), 'utf8')
    } catch {
      return []
    }
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const e: unknown = JSON.parse(line)
        if (isRecord(e) && typeof e.id === 'number' && typeof e.kind === 'string' && typeof e.text === 'string') byId.set(e.id, e as unknown as ActivityEntry)
      } catch {
        /* 跳过坏行 */
      }
    }
    return [...byId.values()].sort((a, b) => a.id - b.id)
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
            // 同一个 id 出现两次是“原地改过的一条”（update）：以后一行为准，位置不变
            const at = this.entries.findIndex((old) => old.id === e.id)
            if (at >= 0) this.entries[at] = e as unknown as ActivityEntry
            else this.entries.push(e as unknown as ActivityEntry)
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

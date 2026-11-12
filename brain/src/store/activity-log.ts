// 活动日志：聊天、模型文本、工具调用和结果、错误。
// 内存里留最近一段给面板实时看（SSE），同时按天追加到 logs/activity-YYYY-MM-DD.jsonl。

import fs from 'node:fs'
import path from 'node:path'
import { appendLine, ensureDir } from './files.ts'
import { isRecord, localDateKey } from '../util.ts'

export type ActivityKind =
  | 'chat' // 游戏里别人说的话
  | 'whisper' // 别人私聊 bot
  | 'say' // bot 在游戏里说的话（公共聊天或私聊）
  | 'reply' // 对话线写的字：不进游戏，只给主人在面板上看（主人从面板说话，这就是回他的话）
  | 'command' // 面板发来的指令
  | 'event' // 其他游戏事件（任务结束、受伤、进出……）
  | 'turn' // 一轮决策开始/结束
  | 'model_text' // 干活线写的字（不进聊天，也不给对话线看；一轮结束时留下的那段另外送给对话线）
  | 'tool_call'
  | 'tool_result'
  | 'error'
  | 'info'
  | 'run' // 它写的程序（例程、run_program）的一次运行：一条滚动更新的汇总，明细在 logs/runs/ 里
  | 'model_call' // 一次模型调用：第几步、用时、token、怎么结束的。开始想时就出现，结束时原地更新
  | 'relay' // 两条线之间的一次往来：对话线交事或带话、干活线汇报或提问或做完留下的话、叫停。发的那一刻记一条

/** 两条线之间的一次往来（docs/TALK_WORK.md）。 */
export interface ActivityRelay {
  /**
   * tell：对话线交事或带话；report：干活线中途汇报；question：干活线提问、在等回答；
   * result：干活线停下来了，这是它留下的文字（叫醒对话线）；progress：干活线一轮结束留了文字，但它开的任务或例程还在跑、
   * 它的事还没完（只作背景，不叫醒对话线）；trouble：干活线出了状况（模型接口故障、到步数上限……程序替它报的）；stop：叫停。
   * helper：对话线派出去的子思维结束了（想完、到上限、被停、出错），它最后写的话交回对话线（叫醒它）；条目带 helper 字段。
   */
  type: 'tell' | 'report' | 'question' | 'result' | 'progress' | 'trouble' | 'stop' | 'helper'
  from: 'talk' | 'work' | 'panel' | 'helper'
  to: 'talk' | 'work'
  /** tell、stop：程序原样附了几句原话。 */
  quotes?: number
  /** progress：干活线还在等什么（它开的哪个任务、哪个例程；那几样结束时它自己会被叫醒接着做）。 */
  waiting?: string
}

/** 对话线说一段话时身体回的发送结果（有不寻常的才记）。 */
export interface ActivitySent {
  lines?: number
  cutChars?: number
  droppedLines?: number
}

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
  /** 正等着的那一步（工具名和参数，截短了的；例程自己在等时是 "wait 5 s"）。 */
  waiting?: string
  /** 例程自己等了几次（wait、setTimeout）、一共等了多久（毫秒）；没等过的没有这两项。 */
  waits?: number
  waitedMs?: number
  /** 全量记录在 logs/runs/ 下的哪个文件里；没有落盘时没有这一项。 */
  file?: string
}

/** 一次模型调用的账：第几步、用了多久、多少 token、怎么结束的。 */
export interface ActivityModelCall {
  /** thinking：还在想（只有 step、startedAt、purpose）；done：回来了；failed：出错了；halted：想到一半被叫停了（全部停下打断的，不是出错）。 */
  state: 'thinking' | 'done' | 'failed' | 'halted'
  /** turn：一轮里的一步；compact：压缩历史的那次调用（没有 step）；helper：子思维的一步（条目带 helper，没有 turn）。 */
  purpose: 'turn' | 'compact' | 'helper'
  /** 这一轮的第几次模型调用（从 1 起）。 */
  step?: number
  /**
   * 到了步数上限以后多给的那一步（收尾）：对话线在这一步里只有 say、whisper 会执行，干活线和子思维不能调工具；
   * 这一步之后这一轮（子思维）就结束了。
   */
  final?: true
  startedAt: number
  ms?: number
  /** 接口回的模型名。 */
  model?: string
  /** 输入 token 总数，已含缓存读写的部分。 */
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  /** 怎么结束的：要调工具 / 说完了 / 被输出上限截断 / 别的 / 出错 / 被叫停。 */
  stop?: 'tool_calls' | 'end' | 'truncated' | 'other' | 'error' | 'halted'
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
  /**
   * 哪条线的：talk（对话线）、work（干活线）、helper（对话线派出去的子思维，哪一个看 helper）。
   * 不带的是系统的事（连上、断开、面板上的操作）和分成两条线之前的旧条目。
   */
  agent?: string
  /** 子思维的编号（h3）：它的每一步都带着（和 step 一起定位；它不占轮的编号，没有 turn）。跨重启不重号。 */
  helper?: string
  /** kind 是 relay 时：这次往来是什么、从谁到谁。 */
  relay?: ActivityRelay
  /** kind 是 say 时：说在哪——public 公共聊天（所有人都看到）、whisper 悄悄话（只有 to 看到）。 */
  channel?: 'public' | 'whisper'
  /** kind 是 say、channel 是 whisper 时：悄悄话发给谁（text 只放原话）。 */
  to?: string
  /** kind 是 say、channel 是 public 时：身体回的发送结果里有不寻常的（分了几行、截掉多少字、丢了几行）才带。 */
  sent?: ActivitySent
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

/** 在日志里找什么（read_log 用）。几个条件同时给就是都要满足。 */
export interface LogQuery {
  /** 时间段（毫秒时间戳），含两端。 */
  since?: number
  until?: number
  /** 第几轮到第几轮，含两端。 */
  turnFrom?: number
  turnTo?: number
  /** 只要这几类。 */
  kinds?: readonly ActivityKind[]
  /** 只要这条线的，加上不分线的（系统的事、聊天、分成两条线之前的旧条目）。不给就是全部。 */
  agent?: string
  /** 只要这个子思维（h3）的条目。 */
  helper?: string
  /** 这些词都要出现（不分大小写）：在正文、详细内容、who 里找。 */
  words?: readonly string[]
  /** 只要这一条。 */
  id?: number
  /** 翻页：只要 id 比它大的 / 比它小的。 */
  afterId?: number
  beforeId?: number
  /** 一页最多几条。 */
  limit: number
  /** 这一页从哪头取：earliest 最早的那些（往后翻用 afterId）；latest 最晚的那些（往前翻用 beforeId）。 */
  from: 'earliest' | 'latest'
}

export interface LogPage {
  /** 这一页，按时间顺序。 */
  entries: ActivityEntry[]
  /** 符合条件的一共多少条（翻页的 afterId / beforeId 不算条件）。 */
  matched: number
  /** 符合条件的里面，比这一页早的、晚的各还有多少条。 */
  earlier: number
  later: number
  /** 日志里现在最早的一条是什么时候的（更早的已经删掉了）；日志是空的就没有。 */
  oldestTime?: number
}

/** 一条的详细内容最多留这么多字符，超出的截掉并在末尾写明原长。 */
export const DETAIL_MAX = 8000
/** 按天存的文件留最近这么多个（有记录的日子才有文件）。 */
export const LOG_KEEP_DAYS = 14

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

  /**
   * 在整份日志里找（内存里的和按天存的文件）。给了时间段就只读那几天的文件。
   * 内存里有的以内存为准（它可能被原地改过、还没落盘）。
   */
  search(query: LogQuery): LogPage {
    const byId = new Map<number, ActivityEntry>()
    const files = this.files()
    const day = (time: number): string => `activity-${localDateKey(time)}.jsonl`
    for (const file of files) {
      if (query.since !== undefined && file < day(query.since)) continue
      if (query.until !== undefined && file > day(query.until)) continue
      for (const e of this.readFile(file)) byId.set(e.id, e)
    }
    for (const e of this.entries) byId.set(e.id, e)
    const all = [...byId.values()].sort((a, b) => a.id - b.id)
    // 最早的一条：没按时间筛文件时就是读到的第一条；筛了就去看最老的那个文件
    let oldestTime = all[0]?.time
    if (query.since !== undefined && files.length > 0 && files[0]! < day(query.since)) oldestTime = this.readFile(files[0]!)[0]?.time ?? oldestTime
    const words = (query.words ?? []).map((w) => w.toLowerCase()).filter((w) => w.length > 0)
    const kinds = query.kinds && query.kinds.length > 0 ? new Set<string>(query.kinds) : undefined
    const matches = all.filter((e) => {
      if (query.id !== undefined) return e.id === query.id
      if (query.since !== undefined && e.time < query.since) return false
      if (query.until !== undefined && e.time > query.until) return false
      if (query.turnFrom !== undefined && (e.turn === undefined || e.turn < query.turnFrom)) return false
      if (query.turnTo !== undefined && (e.turn === undefined || e.turn > query.turnTo)) return false
      if (kinds && !kinds.has(e.kind)) return false
      if (query.agent !== undefined && e.agent !== undefined && e.agent !== query.agent) return false
      if (query.helper !== undefined && e.helper !== query.helper) return false
      if (words.length > 0) {
        const hay = `${e.who ?? ''}\n${e.text}\n${e.detail ?? ''}`.toLowerCase()
        if (!words.every((w) => hay.includes(w))) return false
      }
      return true
    })
    const inWindow = matches.filter((e) => (query.afterId === undefined || e.id > query.afterId) && (query.beforeId === undefined || e.id < query.beforeId))
    const limit = Math.max(1, query.limit)
    const entries = query.from === 'earliest' ? inWindow.slice(0, limit) : inWindow.slice(Math.max(0, inWindow.length - limit))
    const first = entries[0]?.id
    const last = entries[entries.length - 1]?.id
    return {
      entries,
      matched: matches.length,
      earlier: first === undefined ? (query.beforeId !== undefined ? matches.filter((e) => e.id < query.beforeId!).length : 0) : matches.filter((e) => e.id < first).length,
      later: last === undefined ? (query.afterId !== undefined ? matches.filter((e) => e.id > query.afterId!).length : 0) : matches.filter((e) => e.id > last).length,
      ...(oldestTime !== undefined ? { oldestTime } : {}),
    }
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
    for (const f of files.slice(0, Math.max(0, files.length - LOG_KEEP_DAYS))) {
      fs.rmSync(path.join(this.dir, f), { force: true })
    }
  }
}

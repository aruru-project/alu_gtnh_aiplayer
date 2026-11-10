// 意见簿：模型在干活时觉得哪里有问题（缺工具、工具结果不对、手册和实际不符、主人让做却做不到……），自己记下的反馈。
// 上线跑一段时间后，主人在面板上看、导出，拿去改进。
//
// 存在数据目录的 feedback.jsonl 里，只追加、不改写：一行是一件事——新记了一条、同一个问题又来了一次、状态改了。
// 启动时把这些事从头放一遍，就是现在的样子。这样写坏一行最多丢一行，旧的记录不会因为一次改写出错而没了。

import fs from 'node:fs'
import path from 'node:path'
import { appendLine, isRecord } from './files.ts'

export const FEEDBACK_CATEGORIES = ['missing_tool', 'tool_problem', 'data_or_manual', 'cannot_do', 'other'] as const
/** 缺工具 / 工具有问题 / 资料或手册有问题 / 做不到 / 其他。 */
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
/** new 主人还没看过；seen 看过了、还没处理；handled 已处理。 */
export type FeedbackStatus = 'new' | 'seen' | 'handled'

/** 模型自己填的部分。 */
export interface FeedbackInput {
  /** 一句话。 */
  title: string
  category: FeedbackCategory
  /** 它当时想做什么。 */
  goal: string
  /** 遇到了什么。 */
  problem: string
  /** 它希望有什么。 */
  wish?: string
}

export interface FeedbackToolCall {
  tool: string
  input: string
  result: string
  isError?: boolean
}

export interface FeedbackTask {
  id: string
  type?: string
  state?: string
  /** 失败码。 */
  error?: string
}

/** 大脑自动附上的部分：提交那一刻的现场。 */
export interface FeedbackContext {
  bot: string
  brainVersion: string
  modVersion?: string
  /** 第几轮决策。 */
  turn?: number
  /** 这一轮是被什么叫醒的（主人的话、任务结束……）的原文。 */
  instruction: string
  /** 这一轮里提交之前最近的几次工具调用和结果。 */
  recentTools: FeedbackToolCall[]
  /** 相关的任务和它们的失败码。 */
  tasks: FeedbackTask[]
}

export interface FeedbackReport extends FeedbackInput {
  id: string
  /** 第一次提交的时间。 */
  time: number
  /** 最近一次提交的时间。 */
  lastTime: number
  /** 一共提交了几次（短时间内重复提交的合在一起算）。 */
  count: number
  status: FeedbackStatus
  context: FeedbackContext
}

export const FEEDBACK_LIMITS = {
  title: 120,
  goal: 600,
  problem: 1000,
  wish: 600,
  instruction: 1500,
  /** 最近的工具调用留几次。 */
  tools: 6,
  toolInput: 300,
  toolResult: 500,
  tasks: 10,
  /** 同一个问题（类别和标题都一样）在这么久之内再提交，算在同一条上。 */
  mergeWindowMs: 24 * 60 * 60 * 1000,
  /** 24 小时里最多新记这么多条：防一个坏掉的循环把意见簿刷满。 */
  perDay: 50,
} as const

const FILE = 'feedback.jsonl'
const REDACTED = '[redacted]'
/** 长得像密钥的东西：sk-… 这类前缀的 key，和 Bearer 后面的那一串。 */
const KEY_LIKE = /\b(?:sk|pk|rk|key|api)-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[${text.length - max} more characters]`
}

function mergeKey(input: Pick<FeedbackInput, 'title' | 'category'>): string {
  return `${input.category}\n${input.title.toLowerCase().replace(/\s+/g, ' ').trim()}`
}

function isCategory(v: unknown): v is FeedbackCategory {
  return typeof v === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(v)
}

function isStatus(v: unknown): v is FeedbackStatus {
  return v === 'new' || v === 'seen' || v === 'handled'
}

export class FeedbackStore {
  private readonly file: string | undefined
  private readonly now: () => number
  private readonly secrets: () => readonly string[]
  private readonly reports = new Map<string, FeedbackReport>()
  private nextNumber = 1

  /**
   * dataDir 不给则只留在内存里（测试用）。
   * secrets：这台大脑上真正的密钥（API key、面板口令、bridge 口令）。附带的现场里万一出现了它们，存之前抹掉。
   */
  constructor(dataDir?: string, opts: { now?: () => number; secrets?: () => readonly string[] } = {}) {
    this.now = opts.now ?? Date.now
    this.secrets = opts.secrets ?? (() => [])
    if (dataDir) {
      this.file = path.join(dataDir, FILE)
      this.load()
    }
  }

  private load(): void {
    let text: string
    try {
      text = fs.readFileSync(this.file!, 'utf8')
    } catch {
      return // 还没有这个文件
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        this.apply(JSON.parse(line))
      } catch {
        /* 坏掉的一行：跳过，别的照常 */
      }
    }
  }

  /** 把文件里的一件事放到内存里的状态上。 */
  private apply(event: unknown): void {
    if (!isRecord(event) || typeof event.id !== 'string') return
    if (event.t === 'report' && isRecord(event.report)) {
      const r = event.report as unknown as FeedbackReport
      if (typeof r.title !== 'string' || !isCategory(r.category) || typeof r.time !== 'number' || !isRecord(r.context)) return
      if (typeof r.goal !== 'string' || typeof r.problem !== 'string' || !Array.isArray(r.context.recentTools) || !Array.isArray(r.context.tasks)) return
      this.reports.set(event.id, { ...r, id: event.id, lastTime: r.time, count: 1, status: 'new' })
      const n = Number(/^f(\d+)$/.exec(event.id)?.[1])
      if (Number.isFinite(n)) this.nextNumber = Math.max(this.nextNumber, n + 1)
      return
    }
    const report = this.reports.get(event.id)
    if (!report) return
    if (event.t === 'again' && typeof event.time === 'number') {
      report.count++
      report.lastTime = event.time
    } else if (event.t === 'status' && isStatus(event.status)) {
      report.status = event.status
    }
  }

  private append(event: Record<string, unknown>): void {
    if (!this.file) return
    try {
      appendLine(this.file, JSON.stringify(event))
    } catch (e) {
      console.error('[feedback] 写意见簿失败：', e instanceof Error ? e.message : e)
    }
  }

  /** 抹掉密钥：这台大脑上已知的那些原样比对，另外抹掉长得像 key 的串。 */
  private scrub(text: string): string {
    let out = text
    for (const secret of this.secrets()) {
      if (secret.length >= 6) out = out.split(secret).join(REDACTED)
    }
    return out.replace(KEY_LIKE, REDACTED)
  }

  /**
   * 记一条。同一个问题（类别和标题都一样、还没处理）一天之内又提交的，合到原来那条上只加次数。
   * 返回 full 表示这一天记得太多了，这条没记。
   */
  submit(input: FeedbackInput, context: FeedbackContext): { report: FeedbackReport; merged: boolean } | { full: true } {
    const now = this.now()
    const L = FEEDBACK_LIMITS
    // 先抹密钥再截短：反过来的话，正好被截成两半的密钥就认不出来了
    const text = (v: string, max: number): string => clip(this.scrub(v.trim()), max)
    const clean: FeedbackInput = {
      title: text(input.title.replace(/\s+/g, ' '), L.title),
      category: input.category,
      goal: text(input.goal, L.goal),
      problem: text(input.problem, L.problem),
    }
    if (input.wish !== undefined && input.wish.trim().length > 0) clean.wish = text(input.wish, L.wish)

    const key = mergeKey(clean)
    for (const existing of this.reports.values()) {
      if (existing.status !== 'handled' && now - existing.lastTime < L.mergeWindowMs && mergeKey(existing) === key) {
        existing.count++
        existing.lastTime = now
        this.append({ t: 'again', id: existing.id, time: now })
        return { report: existing, merged: true }
      }
    }
    let recent = 0
    for (const r of this.reports.values()) if (now - r.time < 24 * 60 * 60 * 1000) recent++
    if (recent >= L.perDay) return { full: true }

    const attached: FeedbackContext = {
      bot: context.bot,
      brainVersion: context.brainVersion,
      instruction: text(context.instruction, L.instruction),
      // 留最近的几次：离出问题最近的最有用
      recentTools: context.recentTools.slice(-L.tools).map((c) => ({
        tool: c.tool,
        input: text(c.input, L.toolInput),
        result: text(c.result, L.toolResult),
        ...(c.isError ? { isError: true } : {}),
      })),
      tasks: context.tasks.slice(-L.tasks),
    }
    if (context.modVersion !== undefined) attached.modVersion = context.modVersion
    if (context.turn !== undefined) attached.turn = context.turn

    const id = `f${this.nextNumber++}`
    const stored = { ...clean, time: now, context: attached }
    this.append({ t: 'report', id, report: stored })
    const report: FeedbackReport = { ...stored, id, lastTime: now, count: 1, status: 'new' }
    this.reports.set(id, report)
    return { report, merged: false }
  }

  /** 新的在前（按最近一次提交的时间）。status 给 open 是还没处理的（没看过的和看过的）。 */
  list(filter: { category?: FeedbackCategory; status?: FeedbackStatus | 'open' } = {}): FeedbackReport[] {
    return [...this.reports.values()]
      .filter((r) => filter.category === undefined || r.category === filter.category)
      .filter((r) => filter.status === undefined || (filter.status === 'open' ? r.status !== 'handled' : r.status === filter.status))
      .sort((a, b) => b.lastTime - a.lastTime || b.time - a.time)
  }

  get(id: string): FeedbackReport | undefined {
    return this.reports.get(id)
  }

  /** 主人还没看过的条数。 */
  unread(): number {
    let n = 0
    for (const r of this.reports.values()) if (r.status === 'new') n++
    return n
  }

  setStatus(id: string, status: FeedbackStatus): FeedbackReport | undefined {
    const report = this.reports.get(id)
    if (!report) return undefined
    if (report.status !== status) {
      report.status = status
      this.append({ t: 'status', id, time: this.now(), status })
    }
    return report
  }
}

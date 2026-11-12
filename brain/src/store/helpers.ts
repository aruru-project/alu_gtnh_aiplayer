// 子思维（agent/helpers.ts）落盘的两样东西：
//   - helpers-state.json：下一个编号、现在在想的那几个（编号、任务、什么时候开始、几步了）。大脑重启时在想的那些就没了，
//     启动后凭它告诉对话线哪几个没想完。很小，每一步写一次。
//   - helpers/h12.json：想完了（或者没想完就结束了）的一个的完整过程，给面板看、给对话线的 helper_status 翻。留最近 KEEP 个。

import fs from 'node:fs'
import path from 'node:path'
import type { HelperEnd } from '../agent/events.ts'
import { ensureDir, readJson, writeJsonAtomic } from './files.ts'
import { isRecord } from '../util.ts'

/** 在想的一个（落盘的那几项）。 */
export interface HelperRunning {
  id: string
  task: string
  startedAt: number
  steps: number
  /** 最近一步是什么时候（重启后说“它想了多久”用）。 */
  updatedAt?: number
}

export interface HelperState {
  /** 下一个编号（h 后面的数）。跨重启接着数：日志里的 helper 字段不重号。 */
  nextId: number
  running: HelperRunning[]
}

/** 一步里调的一个工具。 */
export interface HelperCall {
  name: string
  /** 参数（JSON，长的截短并写明）。 */
  input: string
  /** 结果（长的截短并写明原来多长）；还没回来没有这一项。 */
  result?: string
  isError?: boolean
  ms?: number
  /** 结果带的图（store/pictures.ts 的编号）。 */
  pictures?: string[]
}

/** 一步：一次模型调用，和它要调的工具。 */
export interface HelperStep {
  n: number
  /** 开始想的时间。 */
  at: number
  /** 模型想了多久；还在想没有这一项。 */
  ms?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  /** 它这一步写的字。 */
  text?: string
  calls: HelperCall[]
  /** 这一步模型调用出错了（原话）。 */
  error?: string
  /** 到上限以后那一步：不能调工具，写交回的话。 */
  final?: true
}

/** 一个子思维的完整记录。 */
export interface HelperRecord {
  id: string
  /** 对话线写的任务（全文）。 */
  task: string
  status: 'running' | HelperEnd
  startedAt: number
  endedAt?: number
  /** 调了几次模型。 */
  steps: number
  maxSteps: number
  /** 用的模型（给人看的名字）。 */
  model?: string
  /** 交回给对话线的那段话（全文）；没结束、或者什么都没写时没有。 */
  final?: string
  /** 程序写的一句：它为什么在这里结束。 */
  note?: string
  /** 这些步一共多少 token。 */
  usage: { inputTokens: number; outputTokens: number }
  transcript: HelperStep[]
}

/** 列表里的一项：记录去掉过程。 */
export type HelperSummary = Omit<HelperRecord, 'transcript'>

/** 想完了的留最近这么多个。 */
const KEEP = 60
const FILE_RE = /^h(\d+)\.json$/

function parseState(raw: unknown): HelperState {
  if (!isRecord(raw)) return { nextId: 1, running: [] }
  const running = Array.isArray(raw.running)
    ? raw.running.filter((r): r is HelperRunning => isRecord(r) && typeof r.id === 'string' && /^h\d+$/.test(r.id) && typeof r.task === 'string' && typeof r.startedAt === 'number' && typeof r.steps === 'number')
    : []
  return { nextId: typeof raw.nextId === 'number' && raw.nextId >= 1 ? Math.floor(raw.nextId) : 1, running }
}

function summaryOf(r: HelperRecord): HelperSummary {
  const { transcript: _t, ...rest } = r
  return rest
}

export class HelperStore {
  private readonly stateFile: string
  private readonly dir: string
  /** 想完了的那些的摘要，新的在前（启动时从目录里读一遍）。 */
  private summaries: HelperSummary[] = []

  constructor(dataDir: string) {
    this.stateFile = path.join(dataDir, 'helpers-state.json')
    this.dir = path.join(dataDir, 'helpers')
    ensureDir(this.dir)
    for (const file of this.files()) {
      const r = this.read(file)
      if (r) this.summaries.push(summaryOf(r))
    }
    this.summaries.sort((a, b) => b.startedAt - a.startedAt)
    // 编号至少要比留着的记录大：状态文件丢了也不覆盖它们
    const state = this.state()
    const highest = this.files().reduce((m, f) => Math.max(m, Number(FILE_RE.exec(f)?.[1] ?? 0)), 0)
    if (state.nextId <= highest) this.saveState({ ...state, nextId: highest + 1 })
  }

  state(): HelperState {
    return parseState(readJson(this.stateFile))
  }

  saveState(state: HelperState): void {
    writeJsonAtomic(this.stateFile, state)
  }

  /** 存一个结束了的（同一个编号再存是覆盖）。 */
  saveRecord(record: HelperRecord): void {
    writeJsonAtomic(path.join(this.dir, `${record.id}.json`), record)
    this.summaries = [summaryOf(record), ...this.summaries.filter((s) => s.id !== record.id)]
    const files = this.files()
    for (const f of files.slice(0, Math.max(0, files.length - KEEP))) {
      fs.rmSync(path.join(this.dir, f), { force: true })
      const id = f.replace(/\.json$/, '')
      this.summaries = this.summaries.filter((s) => s.id !== id)
    }
  }

  /** 最近结束的（不带过程），新的在前。 */
  list(limit = 20): HelperSummary[] {
    return this.summaries.slice(0, Math.max(0, limit))
  }

  get(id: string): HelperRecord | undefined {
    return /^h\d+$/.test(id) ? this.read(`${id}.json`) : undefined
  }

  /** 记录文件，按编号从小到大。 */
  private files(): string[] {
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => FILE_RE.test(f))
        .sort((a, b) => Number(FILE_RE.exec(a)![1]) - Number(FILE_RE.exec(b)![1]))
    } catch {
      return []
    }
  }

  private read(file: string): HelperRecord | undefined {
    const raw = readJson(path.join(this.dir, file))
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.task !== 'string' || !Array.isArray(raw.transcript)) return undefined
    return raw as unknown as HelperRecord
  }
}

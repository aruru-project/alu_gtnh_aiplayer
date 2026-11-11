// 对话历史。按“轮”存：一轮从一条事件消息开始，包含这一轮里所有的模型回复和工具结果。
// 压缩只整轮整轮地切，所以工具调用和结果永远成对。

import path from 'node:path'
import { withoutImages } from '../llm/index.ts'
import type { Message } from '../llm/index.ts'
import { readJson, writeJsonAtomic } from './files.ts'
import { isRecord } from '../util.ts'

export interface Turn {
  id: number
  startedAt: number
  messages: Message[]
}

/** 摘要是哪几轮压成的。 */
export interface SummaryRange {
  /** 第一轮和最后一轮的编号。两条线共用一个计数器，所以中间的编号不一定都是这条线的。 */
  from: number
  to: number
  /** 一共多少轮。 */
  turns: number
  /** 这之前还有更早的轮也在摘要里，但当时没有记下是哪几轮（加这项记录之前留下的老摘要）。 */
  unknownBefore?: boolean
}

export interface HistoryState {
  /** 更早的轮换成的交接记录（字段名是它还叫“摘要”时留下的）；没有则为空字符串。 */
  summary: string
  /** 摘要是哪几轮压成的；老数据里没有这一项（那时没记）。 */
  summaryOf?: SummaryRange
  turns: Turn[]
  nextTurnId: number
}

function parseRange(v: unknown): SummaryRange | undefined {
  if (!isRecord(v) || typeof v.from !== 'number' || typeof v.to !== 'number' || typeof v.turns !== 'number') return undefined
  return { from: v.from, to: v.to, turns: v.turns, ...(v.unknownBefore === true ? { unknownBefore: true } : {}) }
}

function isMessage(v: unknown): v is Message {
  return isRecord(v) && (v.role === 'user' || v.role === 'assistant') && Array.isArray(v.content)
}

/**
 * 轮的编号从哪来。两条线（对话线、干活线）各有一份历史，但共用一个计数器：日志里的 turn 不会重号，
 * 单看编号就知道是哪一轮。
 */
export class TurnIds {
  private nextId = 1

  /** 至少从这个数起（各份历史启动时把自己存着的下一个编号报上来）。 */
  atLeast(next: number): void {
    this.nextId = Math.max(this.nextId, next)
  }

  next(): number {
    return this.nextId++
  }
}

export class HistoryStore {
  private readonly file: string
  private readonly ids: TurnIds | undefined
  private state: HistoryState = { summary: '', turns: [], nextTurnId: 1 }

  /**
   * file：历史落在数据目录的哪个文件（默认 history.json，干活线的；对话线是 talk-history.json）。
   * ids：和别的历史共用的编号计数器；不给就自己数。
   */
  constructor(dataDir: string, opts: { file?: string; ids?: TurnIds } = {}) {
    this.file = path.join(dataDir, opts.file ?? 'history.json')
    this.ids = opts.ids
    const raw = readJson(this.file)
    if (isRecord(raw)) {
      const turns: Turn[] = []
      if (Array.isArray(raw.turns)) {
        for (const t of raw.turns) {
          if (!isRecord(t) || !Array.isArray(t.messages)) continue
          turns.push({
            id: typeof t.id === 'number' ? t.id : turns.length + 1,
            startedAt: typeof t.startedAt === 'number' ? t.startedAt : 0,
            messages: t.messages.filter(isMessage),
          })
        }
      }
      const maxId = turns.reduce((m, t) => Math.max(m, t.id), 0)
      const summary = typeof raw.summary === 'string' ? raw.summary : ''
      const summaryOf = summary.length > 0 ? parseRange(raw.summaryOf) : undefined
      this.state = {
        summary,
        ...(summaryOf ? { summaryOf } : {}),
        turns,
        nextTurnId: Math.max(maxId + 1, typeof raw.nextTurnId === 'number' ? raw.nextTurnId : 1),
      }
    }
    this.ids?.atLeast(this.state.nextTurnId)
  }

  get(): HistoryState {
    return this.state
  }

  newTurnId(): number {
    if (!this.ids) return this.state.nextTurnId++
    const id = this.ids.next()
    this.state.nextTurnId = id + 1
    return id
  }

  /**
   * 一轮结束，记进历史。这一轮里给模型看过的图不存：换成一句占位文字。
   * 图很贵，留在历史里的话之后每一轮都要为同一张图再付一次钱；要再看，它会重新要。
   */
  appendTurn(turn: Turn): void {
    this.state.turns.push({ ...turn, messages: withoutImages(turn.messages) })
    this.save()
  }

  /**
   * 压缩后整体替换。folded：这次折进摘要里的是哪几轮——和以前记着的并起来，摘要开头据此写明“这是第几轮到第几轮压成的”。
   * 原来就有摘要、却没有记着范围的（老数据）：并起来的范围带 unknownBefore。
   */
  replace(summary: string, turns: Turn[], folded?: SummaryRange): void {
    const before = this.state.summaryOf
    const hadSummary = this.state.summary.trim().length > 0
    let summaryOf: SummaryRange | undefined
    if (summary.trim().length === 0) summaryOf = undefined
    else if (!folded) summaryOf = before
    else if (before) summaryOf = { from: before.from, to: folded.to, turns: before.turns + folded.turns, ...(before.unknownBefore ? { unknownBefore: true } : {}) }
    else summaryOf = { ...folded, ...(hadSummary ? { unknownBefore: true } : {}) }
    this.state = { summary, ...(summaryOf ? { summaryOf } : {}), turns, nextTurnId: this.state.nextTurnId }
    this.save()
  }

  clear(): void {
    this.state = { summary: '', turns: [], nextTurnId: this.state.nextTurnId }
    this.save()
  }

  private save(): void {
    writeJsonAtomic(this.file, this.state)
  }
}

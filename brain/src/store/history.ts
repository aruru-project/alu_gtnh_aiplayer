// 对话历史。按“轮”存：一轮从一条事件消息开始，包含这一轮里所有的模型回复和工具结果。
// 压缩只整轮整轮地切，所以工具调用和结果永远成对。

import path from 'node:path'
import { withoutImages } from '../llm/index.ts'
import type { Message } from '../llm/index.ts'
import { isRecord, readJson, writeJsonAtomic } from './files.ts'

export interface Turn {
  id: number
  startedAt: number
  messages: Message[]
}

export interface HistoryState {
  /** 更早的轮被压成的摘要；没有则为空字符串。 */
  summary: string
  turns: Turn[]
  nextTurnId: number
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
      this.state = {
        summary: typeof raw.summary === 'string' ? raw.summary : '',
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

  /** 压缩后整体替换。 */
  replace(summary: string, turns: Turn[]): void {
    this.state = { summary, turns, nextTurnId: this.state.nextTurnId }
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

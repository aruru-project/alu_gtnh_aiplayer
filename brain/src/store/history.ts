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

export class HistoryStore {
  private readonly file: string
  private state: HistoryState = { summary: '', turns: [], nextTurnId: 1 }

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'history.json')
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
  }

  get(): HistoryState {
    return this.state
  }

  newTurnId(): number {
    return this.state.nextTurnId++
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

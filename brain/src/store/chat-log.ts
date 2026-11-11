// 最近的聊天记录：别人说的话（公共聊天、悄悄话、面板上发来的）、它自己说出去的话、它在面板上回主人的字，连同说话的人当时站在哪、指着什么。
// 干活线不直接听人说话，靠这份记录自己核对原话（库函数 recent_chat，只读）；对话线的历史被压缩以后也能回头查。
// 活动日志里也有聊天，但那里没有站位和指向，而且和别的条目混在一起滚动。这里只留最近的若干句，落在 chat-log.json。

import path from 'node:path'
import type { PlayerView } from '../bridge/protocol.ts'
import { isRecord } from './files.ts'
import { JsonFile } from './json-file.ts'

export interface ChatLine {
  time: number
  /**
   * chat 公共聊天；whisper 别人对它的悄悄话；panel 主人在面板上发来的；said 它在公共聊天里说的；whispered 它发出去的悄悄话；
   * replied 对话线写的字（不进游戏，只给主人在面板上看：主人从面板说话时就是回他）。
   */
  kind: 'chat' | 'whisper' | 'panel' | 'said' | 'whispered' | 'replied'
  /** 说话的人（它自己说的是它的名字；面板上发来的是“owner (panel)”）。 */
  who: string
  text: string
  /** whispered：发给谁。 */
  to?: string
  /** 说话的人当时站在哪、朝哪、指着什么（身体给的才有）。 */
  speaker?: PlayerView
}

export const CHAT_LOG_KEEP = 300

function parse(raw: unknown): ChatLine[] {
  if (!Array.isArray(raw)) return []
  const out: ChatLine[] = []
  for (const l of raw) {
    if (!isRecord(l) || typeof l.time !== 'number' || typeof l.who !== 'string' || typeof l.text !== 'string') continue
    if (l.kind !== 'chat' && l.kind !== 'whisper' && l.kind !== 'panel' && l.kind !== 'said' && l.kind !== 'whispered' && l.kind !== 'replied') continue
    out.push(l as unknown as ChatLine)
  }
  return out.slice(-CHAT_LOG_KEEP)
}

export class ChatLog {
  private readonly file: JsonFile<ChatLine[]> | undefined
  private lines: ChatLine[] = []

  /** dataDir 不给则只留在内存里（测试用）。 */
  constructor(dataDir?: string) {
    if (dataDir) {
      this.file = new JsonFile<ChatLine[]>(path.join(dataDir, 'chat-log.json'), parse, { throttleMs: 500 })
      this.lines = [...this.file.get()]
    }
  }

  add(line: ChatLine): void {
    this.lines.push(line)
    if (this.lines.length > CHAT_LOG_KEEP) this.lines.splice(0, this.lines.length - CHAT_LOG_KEEP)
    this.file?.set([...this.lines])
  }

  /**
   * 最近的若干句，按时间顺序。since：只要这个时刻之后的；player：只要这个人说的（不分大小写）。
   * matched 是符合条件的一共多少句（只给了最近 limit 句时，调用的人据此写明还有多少没给）。
   */
  recent(opts: { since?: number; limit?: number; player?: string } = {}): { lines: ChatLine[]; matched: number; kept: number } {
    const who = opts.player?.toLowerCase()
    const all = this.lines.filter((l) => (opts.since === undefined || l.time >= opts.since) && (who === undefined || l.who.toLowerCase() === who))
    const limit = Math.max(1, opts.limit ?? 30)
    return { lines: all.slice(Math.max(0, all.length - limit)), matched: all.length, kept: this.lines.length }
  }

  /** 退出前把还没写的落盘。 */
  flush(): void {
    this.file?.flush()
  }
}

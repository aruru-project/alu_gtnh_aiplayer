// 任务书的进度（一个玩家做完了哪些任务）要问服务器：quest.progress。
// 问到的结果留一小会儿：模型一轮里常常连着列章节、搜任务、看详情，没必要每次都问。

import type { BridgeApi } from '../bridge/api.ts'
import { normalizeQuestId } from '../packdata/index.ts'

/** 进度留多久。玩家刚交完任务，最多这么久之后它就能看到。 */
export const QUEST_PROGRESS_TTL_MS = 20_000

export interface PlayerQuestProgress {
  /** false：服务器从没见过这个玩家（没上过线），所以没有进度可言。 */
  known: boolean
  /** 做完的任务的 id。 */
  done: ReadonlySet<string>
  /** 做完了、有奖励还没领的任务的 id。 */
  unclaimed: ReadonlySet<string>
}

export class QuestProgressCache {
  private readonly bridge: BridgeApi
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly kept = new Map<string, { at: number; value: PlayerQuestProgress }>()

  constructor(bridge: BridgeApi, now: () => number = Date.now, ttlMs = QUEST_PROGRESS_TTL_MS) {
    this.bridge = bridge
    this.now = now
    this.ttlMs = ttlMs
  }

  /** 忘掉留着的这个玩家的进度：bot 刚按了任务书上的按钮，下一次要现问。 */
  forget(player: string): void {
    this.kept.delete(player.toLowerCase())
  }

  /** 问不到时抛 BridgeError（不缓存失败）。 */
  async get(player: string): Promise<PlayerQuestProgress> {
    const key = player.toLowerCase()
    const now = this.now()
    for (const [k, entry] of this.kept) if (now - entry.at >= this.ttlMs) this.kept.delete(k)
    const hit = this.kept.get(key)
    if (hit) return hit.value
    const res = await this.bridge.questProgress(player)
    const idSet = (v: unknown): Set<string> => new Set(Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string').map(normalizeQuestId) : [])
    const value: PlayerQuestProgress = { known: res.known !== false, done: idSet(res.completed), unclaimed: idSet(res.unclaimed) }
    if (this.ttlMs > 0) this.kept.set(key, { at: now, value })
    return value
  }
}

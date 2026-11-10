// 组装每一轮给模型的 user 消息：待处理事件 + 背景 + 当前状态快照。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BotStatus } from '../bridge/protocol.ts'
import { formatServerInfo, formatStatus } from '../tools/format.ts'
import { eventLine } from './events.ts'
import type { AgentEvent } from './events.ts'

export interface Snapshot {
  text: string
  /** bot 是否在线；bridge 不通时为 undefined。 */
  online: boolean | undefined
}

export interface PendingReminder {
  dueAt: number
  note: string
}

function realTime(now: number): string {
  const d = new Date(now)
  const pad = (x: number) => String(x).padStart(2, '0')
  const week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（周${week}）`
}

/** 当前状态快照：位置、血量、背包摘要、当前任务和队列、在线玩家、游戏内时间。拿不到的部分如实说明。 */
export async function buildSnapshot(
  bridge: BridgeApi,
  botName: string,
  reminders: readonly PendingReminder[],
  now: number,
): Promise<Snapshot> {
  const lines: string[] = []
  let online: boolean | undefined
  const [status, info] = await Promise.allSettled([bridge.botStatus(botName), bridge.serverInfo()])

  if (status.status === 'fulfilled') {
    const st: BotStatus = status.value
    online = st.online === true
    lines.push(formatStatus({ ...st, name: st.name ?? botName }, { itemLimit: 15 }))
  } else {
    const e: unknown = status.reason
    if (e instanceof BridgeError && e.code === 'disconnected') {
      lines.push('大脑现在没连上游戏服务器（bridge 断开）。游戏里的任何事都做不了，也说不了话，等重新连上再说。')
    } else if (e instanceof BridgeError && (e.code === 'not_found' || e.code === 'offline')) {
      online = false
      lines.push(`${botName}: OFFLINE (not in the game world; nothing can be done until it is brought online)`)
    } else {
      lines.push(`拿不到自己的状态：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (info.status === 'fulfilled') {
    const dim = status.status === 'fulfilled' ? status.value.dim : undefined
    const text = formatServerInfo(info.value, botName, dim)
    if (text.length > 0) lines.push(text)
  }

  if (reminders.length > 0) {
    const shown = reminders.slice(0, 5).map((r) => `${Math.max(0, Math.round((r.dueAt - now) / 60_000))} 分钟后「${r.note}」`)
    lines.push(`Pending reminders: ${shown.join('；')}${reminders.length > 5 ? ` 等 ${reminders.length} 个` : ''}`)
  }
  lines.push(`Real time: ${realTime(now)}`)
  return { text: lines.join('\n'), online }
}

/** 背景事件太多时只留最近的这么多条。 */
export const BACKGROUND_SHOWN = 30

export function composeTurnMessage(
  triggers: readonly AgentEvent[],
  background: readonly AgentEvent[],
  snapshot: string,
  now: number,
): string {
  const parts: string[] = []
  parts.push(`[需要你处理的事]\n${triggers.map((e) => eventLine(e, now)).join('\n')}`)
  if (background.length > 0) {
    const shown = background.slice(-BACKGROUND_SHOWN)
    const skipped = background.length - shown.length
    parts.push(
      `[最近发生的事（只是背景，不需要回应）]\n${skipped > 0 ? `（更早的 ${skipped} 条略）\n` : ''}${shown.map((e) => eventLine(e, now)).join('\n')}`,
    )
  }
  parts.push(`[当前状态]\n${snapshot}`)
  return parts.join('\n\n')
}

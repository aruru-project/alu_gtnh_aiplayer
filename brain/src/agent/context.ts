// 组装每一轮给模型的 user 消息：待处理事件 + 背景 + 当前状态快照。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BotStatus } from '../bridge/protocol.ts'
import type { Message } from '../llm/index.ts'
import { manualInText, manualVersion } from '../store/manuals.ts'
import type { Manual } from '../store/manuals.ts'
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

/**
 * 一轮进行到一半时新到的事（有人说话、任务结束、例程有结果……本来会另开一轮的那些）：接在刚凑齐的工具结果后面，
 * 这一轮就让模型看到。格式和开头的“需要你处理的事”一样（说话的带着他站在哪、指着什么）。
 */
export function composeArrivals(events: readonly AgentEvent[], now: number): string {
  return `[需要你处理的事（你做上一步的时候新到的）]\n${events.map((e) => eventLine(e, now)).join('\n')}`
}

/**
 * 哪几本手册的原文现在还完整地留在这段对话里。
 * 只认 read_manual 的工具结果里完整的那种：被历史压缩截短了的不算，主人后来改过的（版本对不上）也不算——
 * 这两种情况模型手里都没有能用的原文，要用时得重新读。
 */
export function manualsInContext(messages: readonly Message[], manuals: readonly Manual[]): string[] {
  const current = new Map(manuals.map((m) => [m.name, manualVersion(m)]))
  const found = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'user') continue
    for (const part of m.content) {
      if (part.type !== 'tool_result' || part.isError) continue
      const seen = manualInText(part.content)
      if (seen && current.get(seen.name) === seen.version) found.add(seen.name)
    }
  }
  return manuals.filter((m) => found.has(m.name)).map((m) => m.name)
}

/**
 * “当前状态”里讲手册的那一行。没有手册时返回空字符串。
 * 对话线不动手，不用“做事之前先看”：只在它读过的还留着时说一声。
 */
export function manualStatusLine(manuals: readonly Manual[], inContext: readonly string[], line: 'talk' | 'work' = 'work'): string {
  if (manuals.length === 0) return ''
  if (line === 'talk') return inContext.length > 0 ? `手册：${inContext.join('、')} 的内容还在这段对话里。` : ''
  if (inContext.length === 0) return '手册：这段对话里现在没有任何一本手册的内容，要做某类事之前先 read_manual。'
  if (inContext.length === manuals.length) return '手册：每一本的内容都还在这段对话里，不用重看。'
  return `手册：${inContext.join('、')} 的内容还在这段对话里，不用重看；其余的要用之前先 read_manual。`
}

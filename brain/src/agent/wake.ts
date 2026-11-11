// 唤醒策略：一个事件要不要触发一轮决策。纯函数，不碰任何外部状态。
// 不触发的事件由调用方放进“最近发生的事”，下一轮一并给模型看。

import type { AgentEvent } from './events.ts'

export interface WakePolicy {
  botName: string
  aliases: string[]
  /** 主人名单。非空时只有名单里的玩家能指挥，其他人的话只作为背景。 */
  owners: string[]
  /** mention：提到名字或刚对话过才触发；all：所有聊天都触发。 */
  mode: 'mention' | 'all'
  /** 玩家和 bot 对话后，这么久之内的话不用再叫名字。 */
  conversationWindowMs: number
  /** 聊天和私聊超过这么久（断线后补发的旧消息）就只当背景。 */
  staleChatMs: number
  /** 受伤后血量不高于这个值才触发。 */
  hurtWakeHealth: number
  /** 两次因受伤触发之间的最短间隔。 */
  hurtCooldownMs: number
  /** 没有人介入的情况下，任务连续失败超过这么多次就不再自动触发。 */
  maxFailureStreak: number
}

export const DEFAULT_WAKE_TUNING = {
  staleChatMs: 10 * 60_000,
  hurtWakeHealth: 6,
  hurtCooldownMs: 60_000,
  maxFailureStreak: 5,
} as const

export interface WakeState {
  now: number
  /** 玩家名（小写）→ 上次和 bot 对话的时间。 */
  lastExchange: ReadonlyMap<string, number>
  /** 上次因受伤触发的时间；没有则为 0。 */
  lastHurtWake: number
  /** 这个事件是不是 bot 自己（或面板）取消任务造成的。只对“任务被取消”有意义。 */
  canceledBySelf: boolean
  /** 到这个事件为止，任务连续失败了几次（含本次）。 */
  failureStreak: number
  /** bot 是否在线；不知道时为 undefined。 */
  botOnline: boolean | undefined
}

export interface WakeDecision {
  wake: boolean
  /** 给日志和测试看的原因。 */
  reason:
    | 'mention'
    | 'conversation'
    | 'all_chat'
    | 'whisper'
    | 'task_ended'
    | 'panel'
    | 'reminder'
    | 'death'
    | 'low_health'
    | 'notice'
    | 'told'
    | 'worker'
    | 'todo'
    | 'not_owner'
    | 'not_addressed'
    | 'other_bot'
    | 'stale'
    | 'bot_offline'
    | 'self_canceled'
    | 'failure_streak'
    | 'background'
}

const yes = (reason: WakeDecision['reason']): WakeDecision => ({ wake: true, reason })
const no = (reason: WakeDecision['reason']): WakeDecision => ({ wake: false, reason })

/** 主人名单为空时人人都算；否则按名字（不分大小写）匹配。 */
export function isOwner(player: string, owners: readonly string[]): boolean {
  if (owners.length === 0) return true
  const p = player.toLowerCase()
  return owners.some((o) => o.toLowerCase() === p)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 这句话有没有提到 bot。英文数字的名字要求是完整的词（"Alu" 不匹配 "value"），
 * 中文等其他名字按子串匹配。都不分大小写。
 */
export function mentions(message: string, names: readonly string[]): boolean {
  for (const raw of names) {
    const name = raw.trim()
    if (name.length === 0) continue
    if (/^[A-Za-z0-9_]+$/.test(name)) {
      if (new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, 'i').test(message)) return true
    } else if (message.toLowerCase().includes(name.toLowerCase())) {
      return true
    }
  }
  return false
}

export function decideWake(ev: AgentEvent, policy: WakePolicy, state: WakeState): WakeDecision {
  switch (ev.type) {
    case 'chat': {
      if (ev.isBot) return no('other_bot')
      if (!isOwner(ev.player, policy.owners)) return no('not_owner')
      if (state.botOnline === false) return no('bot_offline')
      if (state.now - ev.time > policy.staleChatMs) return no('stale')
      if (policy.mode === 'all') return yes('all_chat')
      if (mentions(ev.message, [policy.botName, ...policy.aliases])) return yes('mention')
      const last = state.lastExchange.get(ev.player.toLowerCase())
      if (last !== undefined && state.now - last <= policy.conversationWindowMs) return yes('conversation')
      return no('not_addressed')
    }
    case 'whisper': {
      if (!isOwner(ev.from, policy.owners)) return no('not_owner')
      if (state.botOnline === false) return no('bot_offline')
      if (state.now - ev.time > policy.staleChatMs) return no('stale')
      return yes('whisper')
    }
    case 'task_ended': {
      if (ev.task.state === 'canceled' && state.canceledBySelf) return no('self_canceled')
      if (ev.task.state === 'failed' && state.failureStreak > policy.maxFailureStreak) return no('failure_streak')
      return yes('task_ended')
    }
    case 'panel_command':
      return yes('panel')
    case 'reminder':
      return yes('reminder')
    case 'death':
      return yes('death')
    case 'hurt': {
      if (ev.health > policy.hurtWakeHealth) return no('background')
      if (state.now - state.lastHurtWake < policy.hurtCooldownMs) return no('background')
      return yes('low_health')
    }
    case 'notice':
      return ev.wake ? yes('notice') : no('background')
    // 两条线之间的往来：交来的事、汇报和提问都要处理；“被叫停了”只是让它知道，不为它另想一轮
    case 'told':
      return yes('told')
    // 干活线还在等自己的任务或例程时留下的话只作背景：任务结束时它自己会接着做，不用对话线为这句话想一轮
    case 'worker':
      return ev.kind === 'progress' ? no('background') : yes('worker')
    case 'halted':
      return no('background')
    // 工作清单上还有没做的：程序叫醒干活线（只在它停下来时才发）
    case 'todo':
      return yes('todo')
    case 'task_started':
    case 'bot_message':
    case 'spawned':
    case 'despawned':
    case 'player_join':
    case 'player_leave':
    case 'server_stopping':
      return no('background')
  }
}

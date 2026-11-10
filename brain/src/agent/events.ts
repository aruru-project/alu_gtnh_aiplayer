// agent 的输入事件：来自 bridge 的游戏事件，加上大脑自己产生的（面板指令、提醒、内部通知）。

import type { BridgeEvent, TaskInfo } from '../bridge/protocol.ts'
import { compactJson, taskLines, trimTaskResult } from '../tools/format.ts'

export type AgentEvent =
  | { type: 'chat'; time: number; player: string; message: string; isBot: boolean }
  | { type: 'whisper'; time: number; from: string; message: string }
  | { type: 'bot_message'; time: number; text: string }
  | { type: 'task_started'; time: number; task: TaskInfo }
  | { type: 'task_ended'; time: number; task: TaskInfo }
  | { type: 'hurt'; time: number; source: string; amount: number; health: number }
  | { type: 'death'; time: number; cause: string }
  | { type: 'spawned'; time: number }
  | { type: 'despawned'; time: number; reason: string }
  | { type: 'player_join'; time: number; player: string }
  | { type: 'player_leave'; time: number; player: string }
  | { type: 'server_stopping'; time: number }
  | { type: 'panel_command'; time: number; text: string }
  | { type: 'reminder'; time: number; note: string }
  /** 大脑自己产生的通知（重连、上一轮中断等）。wake 决定它是否触发一轮决策。 */
  | { type: 'notice'; time: number; text: string; wake: boolean }

function s(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function sameName(a: unknown, b: string): boolean {
  return typeof a === 'string' && a.toLowerCase() === b.toLowerCase()
}

function isTaskInfo(v: unknown): v is TaskInfo {
  if (v === null || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return typeof t.id === 'string' && typeof t.type === 'string' && typeof t.state === 'string'
}

/**
 * 把 bridge 事件翻译成 agent 事件。
 * 返回 undefined 表示这件事和这个 bot 无关（别的 bot 的事、bot 自己说的话、不认识的事件）。
 */
export function fromBridgeEvent(e: BridgeEvent, botName: string, now: number): AgentEvent | undefined {
  const d = e.data
  const time = typeof e.time === 'number' ? e.time : now
  const mine = sameName(d.bot, botName)
  switch (e.event) {
    case 'chat': {
      const player = s(d.player)
      const message = s(d.message)
      if (player.length === 0 || message.length === 0) return undefined
      if (sameName(player, botName)) return undefined // 自己说的话已经在历史里了
      return { type: 'chat', time, player, message, isBot: d.isBot === true }
    }
    case 'whisper': {
      const from = s(d.from)
      const message = s(d.message)
      if (!mine || from.length === 0 || message.length === 0) return undefined
      return { type: 'whisper', time, from, message }
    }
    case 'bot.message':
      return mine && s(d.text).length > 0 ? { type: 'bot_message', time, text: s(d.text) } : undefined
    case 'task.update': {
      if (!mine || !isTaskInfo(d.task)) return undefined
      const state = d.task.state
      if (state === 'running') return { type: 'task_started', time, task: d.task }
      if (state === 'done' || state === 'failed' || state === 'canceled') return { type: 'task_ended', time, task: d.task }
      return undefined
    }
    case 'bot.spawned':
      return mine ? { type: 'spawned', time } : undefined
    case 'bot.despawned':
      return mine ? { type: 'despawned', time, reason: s(d.reason, 'unknown') } : undefined
    case 'bot.hurt':
      return mine ? { type: 'hurt', time, source: s(d.source, 'unknown'), amount: n(d.amount), health: n(d.health) } : undefined
    case 'bot.death':
      return mine ? { type: 'death', time, cause: s(d.cause, 'unknown') } : undefined
    case 'player.join':
      return s(d.player).length > 0 && !sameName(d.player, botName) ? { type: 'player_join', time, player: s(d.player) } : undefined
    case 'player.leave':
      return s(d.player).length > 0 && !sameName(d.player, botName) ? { type: 'player_leave', time, player: s(d.player) } : undefined
    case 'server.stopping':
      return { type: 'server_stopping', time }
    default:
      return undefined
  }
}

/**
 * 任务结束时给模型看的一段话。结果和错误详情一般是紧凑 JSON；
 * 照图纸建、合成这类任务的结果或缺料清单是几张表，由 taskLines 排成几行短文本（字段名照协议），不然截断了模型看不到后半截。
 */
function describeTaskEnd(task: TaskInfo): string {
  const head = `任务 ${task.id}（${task.type}）`
  const lines = taskLines(task)
  // 整理过的文字：只有一行就接在后面，多行则每行缩进另起
  const block = (ls: string[]) => (ls.length === 1 ? ls[0]! : ls.map((l) => `\n  ${l}`).join(''))
  const hasResult = task.result !== undefined && Object.keys(task.result).length > 0
  const result = !hasResult ? '' : lines.result ? block(lines.result) : compactJson(trimTaskResult(task.result!), 700)
  if (task.state === 'done') return `${head}完成了。${result ? ` 结果：${result}` : ''}`
  if (task.state === 'canceled') return `${head}被取消了。${result ? ` 已完成的部分：${result}` : ''}`
  const e = task.error
  let text = `${head}失败了：${e?.code ?? 'unknown'}`
  if (e?.message) text += ` — ${e.message}`
  if (e?.detail && Object.keys(e.detail).length > 0) {
    text += lines.error ? lines.error.map((l) => `\n  ${l}`).join('') : ` detail=${compactJson(e.detail, 500)}`
  }
  if (result) text += `${lines.error || (lines.result?.length ?? 0) > 1 ? '\n  ' : ' '}已完成的部分：${result}`
  return text
}

/** 一句话说明一个事件。给模型看，也用于面板日志。 */
export function describeEvent(ev: AgentEvent): string {
  switch (ev.type) {
    case 'chat':
      return `${ev.player}${ev.isBot ? '（另一个 bot）' : ''} 说：${ev.message}`
    case 'whisper':
      return `${ev.from} 私聊你：${ev.message}`
    case 'bot_message':
      return `系统消息：${ev.text}`
    case 'task_started':
      return `任务 ${ev.task.id}（${ev.task.type}）开始执行`
    case 'task_ended':
      return describeTaskEnd(ev.task)
    case 'hurt':
      return `你受到 ${ev.amount} 点伤害（来源：${ev.source}），剩余血量 ${ev.health}`
    case 'death':
      return `你死了（${ev.cause}）。背包里的东西可能掉在了死亡地点。`
    case 'spawned':
      return '你上线了'
    case 'despawned':
      return `你下线了（${ev.reason}）`
    case 'player_join':
      return `${ev.player} 进入了服务器`
    case 'player_leave':
      return `${ev.player} 离开了服务器`
    case 'server_stopping':
      return '服务器正在关闭'
    case 'panel_command':
      return `主人通过控制面板对你说：${ev.text}`
    case 'reminder':
      return `你给自己定的提醒到点了：${ev.note}`
    case 'notice':
      return ev.text
  }
}

export function clockTime(time: number): string {
  const d = new Date(time)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 带时间的一行；不是今天的事再带上日期。 */
export function eventLine(ev: AgentEvent, now: number): string {
  const d = new Date(ev.time)
  const today = new Date(now)
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate()
  const date = sameDay ? '' : `${d.getMonth() + 1}月${d.getDate()}日 `
  return `[${date}${clockTime(ev.time)}] ${describeEvent(ev)}`
}

/** 是不是“有人在跟 bot 说话”这一类事件。兜底说话、对话窗口都只看这一类。 */
export function isHumanInput(ev: AgentEvent): boolean {
  return ev.type === 'chat' || ev.type === 'whisper' || ev.type === 'panel_command'
}

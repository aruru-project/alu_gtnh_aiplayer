// agent 的输入事件：来自 bridge 的游戏事件，加上大脑自己产生的（面板指令、提醒、内部通知）。

import type { BridgeEvent, PlayerView, SeenBlock, TaskInfo } from '../bridge/protocol.ts'
import { compactJson, nameOf, taskLines, trimTaskResult, withLocalNames } from '../tools/format.ts'

export type AgentEvent =
  /** speaker：他说这句话时站在哪、朝哪看、指着什么（身体给的；老的身体不给）。 */
  | { type: 'chat'; time: number; player: string; message: string; isBot: boolean; speaker?: PlayerView }
  | { type: 'whisper'; time: number; from: string; message: string; speaker?: PlayerView }
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

/** 事件里的 speaker：是个对象、至少有位置才认。 */
function speakerOf(v: unknown): PlayerView | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const view = v as PlayerView
  return view.block !== undefined || view.pos !== undefined ? view : undefined
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
      const speaker = speakerOf(d.speaker)
      return { type: 'chat', time, player, message, isBot: d.isBot === true, ...(speaker ? { speaker } : {}) }
    }
    case 'whisper': {
      const from = s(d.from)
      const message = s(d.message)
      if (!mine || from.length === 0 || message.length === 0) return undefined
      const speaker = speakerOf(d.speaker)
      return { type: 'whisper', time, from, message, ...(speaker ? { speaker } : {}) }
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
  const result = !hasResult ? '' : lines.result ? block(lines.result) : compactJson(withLocalNames(trimTaskResult(task.result!)), 700)
  if (task.state === 'done') return `${head}完成了。${result ? ` 结果：${result}` : ''}`
  if (task.state === 'canceled') return `${head}被取消了。${result ? ` 已完成的部分：${result}` : ''}`
  const e = task.error
  let text = `${head}失败了：${e?.code ?? 'unknown'}`
  if (e?.message) text += ` — ${e.message}`
  if (e?.detail && Object.keys(e.detail).length > 0) {
    text += lines.error ? lines.error.map((l) => `\n  ${l}`).join('') : ` detail=${compactJson(withLocalNames(e.detail), 500)}`
  }
  if (result) text += `${lines.error || (lines.result?.length ?? 0) > 1 ? '\n  ' : ' '}已完成的部分：${result}`
  return text
}

const FACING: Record<string, string> = { north: '北', south: '南', east: '东', west: '西', up: '上', down: '下' }
const SEEN_KIND: Record<string, string> = { container: '容器', drawers: '抽屉', drawer_controller: '抽屉管理器', machine: '机器' }

function seenText(b: SeenBlock): string {
  const name = nameOf(b, { block: true }) ?? b.id ?? '一个方块'
  const kind = b.kind ? SEEN_KIND[b.kind] : undefined
  // 旁边接着漏斗、管道的：是自动化的一环，提一句
  const auto = (b.attached ?? []).map((a) => nameOf(a, { block: true }) ?? a.kind ?? '管道')
  return `${name} (${Math.floor(b.x)},${Math.floor(b.y)},${Math.floor(b.z)})${kind && !name.includes(kind) ? `［${kind}］` : ''}${auto.length > 0 ? `（接着${auto.join('、')}）` : ''}`
}

/**
 * 说话的人当时站在哪、朝哪、准星指着什么、面前有哪些容器，整理成一行。
 * 人说“这个”“我面前的”时，模型靠它知道指的是哪个，不用再问。
 */
export function speakerLine(name: string, view: PlayerView): string {
  const at = view.block ?? view.pos
  const where = at ? `站在 (${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)})` : ''
  const facing = view.facing && FACING[view.facing] ? `面朝${FACING[view.facing]}` : ''
  const looking = view.lookingAt
  const pointed = looking ? `指着 ${seenText(looking)}` : '没有指着什么方块'
  const ahead = (view.ahead ?? []).filter((b) => !(looking && b.x === looking.x && b.y === looking.y && b.z === looking.z))
  const more = ahead.length > 0 ? `；面前${looking ? '还' : ''}有：${ahead.map(seenText).join('、')}` : ''
  return `${name} ${[where, facing].filter(Boolean).join(' ')}，${pointed}${more}`
}

/** 一句话说明一个事件。给模型看，也用于面板日志。 */
export function describeEvent(ev: AgentEvent): string {
  switch (ev.type) {
    case 'chat':
      return `${ev.player}${ev.isBot ? '（另一个 bot）' : ''} 说：${ev.message}${ev.speaker ? `\n  （${speakerLine(ev.player, ev.speaker)}）` : ''}`
    case 'whisper':
      return `${ev.from} 私聊你：${ev.message}${ev.speaker ? `\n  （${speakerLine(ev.from, ev.speaker)}）` : ''}`
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

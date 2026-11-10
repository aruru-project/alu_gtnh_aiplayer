// agent 循环：事件驱动。收事件 → 唤醒策略 → 一轮决策（组上下文、调模型、执行工具，直到模型不再调用工具）。
// 这一层不直接发 HTTP（走 LlmClient），不直接读写 socket（走 BridgeApi）。一个 bot 一个 Agent 实例。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BridgeEvent } from '../bridge/protocol.ts'
import { LlmError, textOf } from '../llm/index.ts'
import type { GenerateRequest, GenerateResult, LlmClient, Message, UserPart } from '../llm/index.ts'
import type { ActivityLog } from '../store/activity-log.ts'
import type { HistoryStore } from '../store/history.ts'
import { cleanChatText } from '../tools/chat.ts'
import { clip, compactJson } from '../tools/format.ts'
import { runTool, toToolSpecs } from '../tools/index.ts'
import type { MemoryAccess, ReminderAccess, Tool, ToolContext, ToolResult } from '../tools/index.ts'
import { compactHistory, historyMessages } from './compaction.ts'
import { buildSnapshot, composeTurnMessage } from './context.ts'
import type { PendingReminder } from './context.ts'
import { describeEvent, fromBridgeEvent, isHumanInput } from './events.ts'
import type { AgentEvent } from './events.ts'
import { buildSystemPrompt } from './prompt.ts'
import { DEFAULT_WAKE_TUNING, decideWake } from './wake.ts'
import type { WakeDecision, WakePolicy } from './wake.ts'

export interface AgentSettings {
  botName: string
  aliases: string[]
  owners: string[]
  /** 自定义人设；空字符串用默认。 */
  persona: string
  wakeMode: 'mention' | 'all'
  conversationWindowSec: number
  maxSteps: number
  /** 0 为不限。 */
  dailyTokenLimit: number
  historyTokenThreshold: number
  toolResultMaxChars: number
}

export interface AgentTiming {
  /** 事件到达后等这么久再开始一轮，好把挨得很近的事件并在一起。 */
  debounceMs: number
  /** 模型接口失败后，第 1、2、3… 次重试前各等多久；用完后一直用最后一个。 */
  retryDelaysMs: number[]
  /** 重试也没用的错误（鉴权、请求不合法）等多久再试；改了配置会立刻重试。 */
  nonRetryableDelayMs: number
  /** 接口故障期间有人跟它说话时，离上次失败至少这么久才提前重试。 */
  humanRetryGapMs: number
  /** 同一种“我现在不行”的话，多久之内只在聊天里说一次。 */
  announceIntervalMs: number
  /** 死亡后等这么久再开始决策：身体约 1.5 秒后自动重生，等它重生了再看状态。 */
  afterDeathDelayMs: number
}

export const DEFAULT_TIMING: AgentTiming = {
  debounceMs: 400,
  retryDelaysMs: [5000, 20_000, 60_000, 120_000, 300_000, 600_000],
  nonRetryableDelayMs: 600_000,
  humanRetryGapMs: 15_000,
  announceIntervalMs: 600_000,
  afterDeathDelayMs: 2500,
}

export interface PersistedAgentState {
  /** bot 启动后还没看到结束的任务 id。 */
  tracked: string[]
  /** 已经处理过的“任务结束”，用来去重。 */
  endedSeen: string[]
  /** 已经决定要处理、但还没处理完的事件（进程重启后接着处理）。 */
  queue: AgentEvent[]
}

export interface AgentDeps {
  settings(): AgentSettings
  /** 当前的模型客户端；没配置时返回 undefined。 */
  llm(): LlmClient | undefined
  bridge: BridgeApi
  tools: readonly Tool[]
  memory: MemoryAccess & { render(): string }
  reminders: ReminderAccess & { list(): PendingReminder[] }
  history: HistoryStore
  log: ActivityLog
  /** 今天已经用掉的 token（输入+输出）。 */
  todayTokens(): number
  persist?: { load(): PersistedAgentState | undefined; save(state: PersistedAgentState): void }
  timing?: Partial<AgentTiming>
  now?(): number
}

export interface LastCall {
  time: number
  ok: boolean
  durationMs: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  errorKind?: string
  error?: string
}

export interface AgentStatus {
  busy: boolean
  pending: number
  background: number
  botOnline: boolean | undefined
  trackedTasks: string[]
  lastCall?: LastCall
  /** 模型接口故障期间才有。 */
  outage?: { failures: number; since: number; nextRetryAt: number; lastError: string }
}

const BACKGROUND_MAX = 60
const BOT_MESSAGES_KEPT = 50
/** “最近发生的事”里最多留这么多条系统消息，免得被刷屏的消息挤满。 */
const BACKGROUND_BOT_MESSAGES_MAX = 10
/** 上线时服务器会刷一串欢迎语；上线事件之前这么久以内的系统消息都当成欢迎语丢掉。 */
const JOIN_SPAM_WINDOW_MS = 5000
const SELF_CANCELED_KEPT = 200
const ENDED_SEEN_MAX = 200
const FALLBACK_SAY_CHARS = 200

const NOT_WOKEN_NOTES: Partial<Record<WakeDecision['reason'], string>> = {
  not_addressed: '没有叫醒模型：没提到它的名字，说话的人也不在对话窗口内。',
  not_owner: '没有叫醒模型：说话的人不在主人名单里。',
  other_bot: '没有叫醒模型：这是另一个 bot 说的。',
  stale: '没有叫醒模型：这是断线期间的旧消息。',
  bot_offline: '没有叫醒模型：它现在不在线。',
  self_canceled: '没有叫醒模型：这是它自己（或主人在面板上）取消的任务。',
  failure_streak: '没有叫醒模型：任务已经接连失败太多次，等人介入。',
}

const STEP_LIMIT_NOTE =
  '[系统] 这一轮已经到了步数上限，到此为止。没做完的事等下次被叫醒再继续；不要指望这一轮里还能再调用工具。'
const BUDGET_NOTE = '[系统] 今天的模型用量到上限了，这一轮到此为止。'

/**
 * 一个任务只会结束一次，所以按 id 去重就够了。
 * 重复的来源：断线续传和实时流重叠、重连后对账、以及身体在任务“一开始就失败”时连发两次 failed。
 */
function taskEndKey(ev: Extract<AgentEvent, { type: 'task_ended' }>): string {
  return ev.task.id
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export class Agent {
  private readonly deps: AgentDeps
  private readonly timing: AgentTiming

  private pending: AgentEvent[] = []
  private inFlight: AgentEvent[] = []
  private background: AgentEvent[] = []
  private running = false
  private stopped = false
  private timer: NodeJS.Timeout | undefined
  private abort: AbortController | undefined
  private idleWaiters: (() => void)[] = []

  private lastExchange = new Map<string, number>()
  private lastHurtWake = 0
  /** 自己发出的、会取消任务的请求还有几个没回来。 */
  private cancelsInFlight = 0
  /** 身体在响应里说“被这次请求取消了”的任务 id。 */
  private selfCanceled: string[] = []
  /** 自己发出的 bot.command 还有几个没回来（期间的系统消息是指令回显）。 */
  private commandsInFlight = 0
  private failureStreak = 0
  private botOnline: boolean | undefined
  private tracked = new Set<string>()
  private endedSeen: string[] = []
  private turnSpoke = false
  /** 最近收到的系统消息和到达时间，给“指令回显晚一步才到”的工具用。 */
  private botMessages: { at: number; text: string }[] = []

  private llmFailures = 0
  private outageSince = 0
  private nextRetryAt = 0
  private lastFailureAt = 0
  private lastFailureText = ''
  private outageAnnounced = false
  private lastAnnounce = new Map<string, number>()
  private lastCall: LastCall | undefined

  constructor(deps: AgentDeps) {
    this.deps = deps
    this.timing = { ...DEFAULT_TIMING, ...(deps.timing ?? {}) }
    const saved = deps.persist?.load()
    if (saved) {
      this.tracked = new Set(saved.tracked)
      this.endedSeen = saved.endedSeen.slice(-ENDED_SEEN_MAX)
      if (saved.queue.length > 0) {
        this.pending = [
          {
            type: 'notice',
            time: this.now(),
            wake: true,
            text: '大脑刚重启过。下面这些事是重启前收到的，可能已经处理了一部分；先看当前状态，再决定还要不要做。',
          },
          ...saved.queue,
        ]
      }
    }
  }

  // ── 对外 ──

  /** 开始工作。重启前没处理完的事会在这里接着处理。 */
  start(): void {
    this.stopped = false
    this.schedule()
  }

  /** 停下：打断正在进行的一轮，等它收尾。没处理完的事件已经落盘，下次启动接着来。 */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.abort?.abort()
    this.persist()
    if (this.running) await new Promise<void>((resolve) => this.idleWaiters.push(resolve))
  }

  /** bridge 推来的事件。和这个 bot 无关的会被忽略。 */
  handleBridgeEvent(e: BridgeEvent): void {
    const ev = fromBridgeEvent(e, this.deps.settings().botName, this.now())
    if (ev) this.handleEvent(ev)
  }

  /** 所有事件的入口：记日志 → 唤醒策略 → 排队或进背景。 */
  handleEvent(ev: AgentEvent): void {
    const now = this.now()
    if (ev.type === 'task_ended') {
      const key = taskEndKey(ev)
      if (this.endedSeen.includes(key)) return // 续传或对账时重复收到
      this.endedSeen.push(key)
      if (this.endedSeen.length > ENDED_SEEN_MAX) this.endedSeen.splice(0, this.endedSeen.length - ENDED_SEEN_MAX)
      this.tracked.delete(ev.task.id)
      if (ev.task.state === 'failed') this.failureStreak++
      else if (ev.task.state === 'done') this.failureStreak = 0
    } else if (ev.type === 'spawned') {
      this.botOnline = true
      // 上线时服务器发的一串欢迎语对模型没用，从背景里拿掉。
      // 按事件自己的时间比（不是按现在）：断线后补发的事件是一口气到的，可能已经是几十秒前的事。
      this.background = this.background.filter(
        (e) => !(e.type === 'bot_message' && e.time <= ev.time && ev.time - e.time <= JOIN_SPAM_WINDOW_MS),
      )
    } else if (ev.type === 'despawned') {
      this.botOnline = false
    } else if (ev.type === 'bot_message') {
      this.botMessages.push({ at: now, text: ev.text })
      if (this.botMessages.length > BOT_MESSAGES_KEPT) this.botMessages.splice(0, this.botMessages.length - BOT_MESSAGES_KEPT)
      // 自己执行指令时的回显：工具结果里已经有了，不用再进日志和背景
      if (this.commandsInFlight > 0) return
    }

    const decision = decideWake(ev, this.wakePolicy(), {
      now,
      lastExchange: this.lastExchange,
      lastHurtWake: this.lastHurtWake,
      canceledBySelf:
        ev.type === 'task_ended' && ev.task.state === 'canceled' && (this.cancelsInFlight > 0 || this.selfCanceled.includes(ev.task.id)),
      failureStreak: this.failureStreak,
      botOnline: this.botOnline,
    })
    this.logEvent(ev, decision)

    if (!decision.wake) {
      this.pushBackground(ev)
      if (decision.reason === 'failure_streak') {
        void this.announce('failure_streak', '我这边任务连着失败好几次了，先停下，等人来看看。')
      }
      if (ev.type === 'task_ended') this.persist()
      return
    }

    if (isHumanInput(ev)) {
      this.failureStreak = 0
      if (ev.type === 'chat') this.lastExchange.set(ev.player.toLowerCase(), now)
      else if (ev.type === 'whisper') this.lastExchange.set(ev.from.toLowerCase(), now)
      // 接口故障期间有人说话：不用等完整的退避时间，但也别比上次失败后 humanRetryGapMs 更早
      if (this.llmFailures > 0) {
        const earliest = this.lastFailureAt + this.timing.humanRetryGapMs
        if (earliest < this.nextRetryAt) {
          this.nextRetryAt = earliest
          this.reschedule()
        }
      }
    }
    if (ev.type === 'hurt') this.lastHurtWake = now
    this.pending.push(ev)
    this.persist()
    this.schedule()
  }

  /** bridge 每次握手成功后调用：确认 bot 在不在线，核对断线期间结束的任务。 */
  async onBridgeReady(info: { epochChanged: boolean; firstContact?: boolean }): Promise<void> {
    const botName = this.deps.settings().botName
    if (info.epochChanged && !info.firstContact) {
      this.pushBackground({
        type: 'notice',
        time: this.now(),
        wake: false,
        text: '游戏服务器重启过，大脑已经重新连上。重启前没做完的任务，身体会自己从头重新开始：区域任务只是接着做，但 withdraw 会再取一份、haul 手上的那趟货会留在你身上。',
      })
    }
    try {
      const status = await this.deps.bridge.botStatus(botName)
      this.botOnline = status.online === true
    } catch (e) {
      if (e instanceof BridgeError && (e.code === 'not_found' || e.code === 'offline')) this.botOnline = false
      else return
    }
    if (this.tracked.size === 0) return
    try {
      const list = await this.deps.bridge.taskList(botName)
      const live = new Set<string>()
      if (list.active) live.add(list.active.id)
      for (const t of list.queue ?? []) live.add(t.id)
      for (const id of [...this.tracked]) {
        if (live.has(id)) continue
        const ended = (list.recent ?? []).find((t) => t.id === id)
        if (ended && (ended.state === 'done' || ended.state === 'failed' || ended.state === 'canceled')) {
          this.handleEvent({ type: 'task_ended', time: ended.finishedAt ?? this.now(), task: ended })
        } else {
          this.tracked.delete(id)
          this.handleEvent({
            type: 'notice',
            time: this.now(),
            wake: true,
            text: `任务 ${id} 已经不在任务列表里了，结果不清楚（可能是断线期间结束的）。先用 task_status 和 get_status 看看现在的情况。`,
          })
        }
      }
      this.persist()
    } catch {
      /* bot 不在线或 bridge 又断了：下次握手再对 */
    }
  }

  onBridgeDisconnected(): void {
    this.botOnline = undefined
  }

  /**
   * 执行一个会让身体取消任务的请求（bot 自己的工具，或主人在面板上点的取消）。
   * 身体先发“任务被取消”的事件、再回响应，所以 fn 执行期间收到的取消都算有意为之，不为它叫醒模型；
   * 响应里列出的被取消的 id 也记下来，之后（比如断线续传时）再收到同样不算。
   */
  async ownCancel<T extends { ids?: string[]; replaced?: string[] }>(fn: () => Promise<T>): Promise<T> {
    this.cancelStart()
    let ids: readonly string[] = []
    try {
      const result = await fn()
      ids = [...(result.ids ?? []), ...(result.replaced ?? [])]
      return result
    } finally {
      this.cancelEnd(ids)
    }
  }

  private cancelStart(): void {
    this.cancelsInFlight++
  }

  private cancelEnd(ids: readonly string[]): void {
    this.cancelsInFlight = Math.max(0, this.cancelsInFlight - 1)
    this.selfCanceled.push(...ids)
    if (this.selfCanceled.length > SELF_CANCELED_KEPT) this.selfCanceled.splice(0, this.selfCanceled.length - SELF_CANCELED_KEPT)
  }

  /** 模型配置改了：接口故障的退避清零，马上再试。 */
  notifyConfigChanged(): void {
    if (this.llmFailures > 0) {
      this.nextRetryAt = 0
      this.reschedule()
    }
  }

  status(): AgentStatus {
    const s: AgentStatus = {
      busy: this.running,
      pending: this.pending.length,
      background: this.background.length,
      botOnline: this.botOnline,
      trackedTasks: [...this.tracked],
    }
    if (this.lastCall) s.lastCall = this.lastCall
    if (this.llmFailures > 0) {
      s.outage = {
        failures: this.llmFailures,
        since: this.outageSince,
        nextRetryAt: this.nextRetryAt,
        lastError: this.lastFailureText,
      }
    }
    return s
  }

  /** 没有正在跑的一轮、也没有排着队的事时兑现。测试用。 */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  // ── 调度 ──

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private isIdle(): boolean {
    return !this.running && this.timer === undefined && (this.pending.length === 0 || this.stopped)
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }

  private schedule(): void {
    if (this.stopped || this.running || this.timer !== undefined || this.pending.length === 0) return
    const now = this.now()
    let wait = Math.max(this.timing.debounceMs, this.nextRetryAt - now)
    // 刚死：等身体重生了再决策，这样状态快照里是重生后的位置和血量
    for (const ev of this.pending) {
      if (ev.type === 'death') wait = Math.max(wait, ev.time + this.timing.afterDeathDelayMs - now)
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.startTurn()
    }, wait)
  }

  private reschedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.schedule()
  }

  private async startTurn(): Promise<void> {
    if (this.running || this.stopped) return
    if (this.pending.length === 0) {
      this.notifyIdle()
      return
    }
    this.running = true
    try {
      await this.runTurn()
    } catch (e) {
      // 走到这里是程序自己的毛病，不是模型或游戏的。记下来，别让一轮的失败把进程带走。
      this.deps.log.add({ kind: 'error', text: `这一轮内部出错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}` })
      this.background = [...this.inFlight, ...this.background].slice(-BACKGROUND_MAX)
      this.inFlight = []
    } finally {
      this.running = false
      this.abort = undefined
      this.persist()
      this.schedule()
      this.notifyIdle()
    }
  }

  // ── 一轮决策 ──

  private async runTurn(): Promise<void> {
    const settings = this.deps.settings()
    const startedAt = this.now()
    const triggers = this.pending.splice(0)
    const background = this.background.splice(0)
    this.inFlight = triggers
    const humanTriggered = triggers.some(isHumanInput)

    // 这一轮跑不了：事件留作背景，下次有事时一并给模型看
    const giveBack = () => {
      this.background = [...background, ...triggers, ...this.background].slice(-BACKGROUND_MAX)
      this.inFlight = []
    }
    // 这一轮一步都没走成：原样放回去，之后重试
    const requeue = () => {
      this.pending = [...triggers, ...this.pending]
      this.background = [...background, ...this.background].slice(-BACKGROUND_MAX)
      this.inFlight = []
    }

    const llm = this.deps.llm()
    if (!llm) {
      this.deps.log.add({ kind: 'error', text: '还没有可用的模型服务，这些事没法处理。请到面板的“模型”页添加并选中一个。' })
      if (humanTriggered) await this.announce('no_model', '我还没接上模型，现在没法思考，得有人去面板配一下。')
      giveBack()
      return
    }
    if (this.overBudget(settings)) {
      this.deps.log.add({ kind: 'error', text: `今天的 token 用量已到上限（${settings.dailyTokenLimit}），这些事没有处理。` })
      if (humanTriggered) await this.announce('budget', '我今天的模型额度用完了，明天再说，或者让主人去面板调一下上限。')
      giveBack()
      return
    }

    this.abort = new AbortController()
    const signal = this.abort.signal
    const turnId = this.deps.history.newTurnId()
    const snapshot = await buildSnapshot(this.deps.bridge, settings.botName, this.deps.reminders.list(), startedAt)
    if (snapshot.online !== undefined) this.botOnline = snapshot.online
    const userText = composeTurnMessage(triggers, background, snapshot.text, startedAt)
    const turnMessages: Message[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
    this.deps.log.add({
      kind: 'turn',
      turn: turnId,
      text: `第 ${turnId} 轮开始：${triggers.map((e) => firstLine(describeEvent(e), 40)).join('；')}`,
      detail: userText,
    })

    const system = buildSystemPrompt({
      persona: settings.persona,
      botName: settings.botName,
      aliases: settings.aliases,
      owners: settings.owners,
      memory: this.deps.memory.render(),
    })
    const toolSpecs = toToolSpecs(this.deps.tools)
    const ctx = this.toolContext(settings.botName)
    let prior = this.priorMessages()
    this.turnSpoke = false
    let finalText = ''
    let steps = 0
    let compactedForContext = false

    const saveTurn = () => {
      this.deps.history.appendTurn({ id: turnId, startedAt, messages: turnMessages })
      this.inFlight = []
    }
    const appendNote = (note: string) => {
      const last = turnMessages[turnMessages.length - 1]
      if (last && last.role === 'user') last.content.push({ type: 'text', text: note })
    }

    for (;;) {
      if (steps > 0 && this.overBudget(settings)) {
        appendNote(BUDGET_NOTE)
        this.deps.log.add({ kind: 'error', turn: turnId, text: '今天的 token 用量到上限了，这一轮提前结束。' })
        break
      }

      let result: GenerateResult
      try {
        result = await this.callModel(llm, { system, messages: [...prior, ...turnMessages], tools: toolSpecs, signal })
      } catch (e) {
        if (!(e instanceof LlmError)) throw e
        if (e.kind === 'aborted') {
          // 进程要停。做过的事留在历史里；触发事件还在落盘的队列里，下次启动接着处理。
          if (steps > 0) this.deps.history.appendTurn({ id: turnId, startedAt, messages: turnMessages })
          return
        }
        if (e.kind === 'context_length' && !compactedForContext) {
          compactedForContext = true
          this.deps.log.add({ kind: 'info', turn: turnId, text: '模型说上下文太长，先压缩历史再试一次。' })
          await this.forceCompact(llm, signal)
          prior = this.priorMessages()
          continue
        }
        await this.onModelFailure(e)
        if (steps === 0) {
          requeue()
        } else if (e.kind === 'context_length') {
          // 这一轮自己就超长了，存下来只会让后面每一轮都失败
          giveBack()
          this.deps.log.add({ kind: 'error', turn: turnId, text: '这一轮的内容本身超出了模型的上下文，已放弃这一轮。' })
        } else {
          saveTurn()
          this.pending.unshift({
            type: 'notice',
            time: this.now(),
            wake: true,
            text: '上一轮做到一半时模型接口出错中断了。先看当前状态和任务情况，再决定要不要接着做。',
          })
        }
        return
      }
      steps++

      turnMessages.push(result.message)
      const text = textOf(result.message.content).trim()
      if (text.length > 0) this.deps.log.add({ kind: 'model_text', turn: turnId, text })
      const calls = result.message.content.filter((p) => p.type === 'tool_call')
      if (calls.length === 0) {
        finalText = text
        break
      }

      const results: UserPart[] = []
      for (const call of calls) {
        // 面板日志：一行放得下就不再附“详情”
        const argsLine = compactJson(call.invalid ? call.invalid.raw : call.input, 160)
        const callEntry: Parameters<ActivityLog['add']>[0] = { kind: 'tool_call', turn: turnId, who: call.name, text: argsLine }
        if (call.invalid) callEntry.detail = call.invalid.raw
        else if (argsLine.endsWith('…')) callEntry.detail = JSON.stringify(call.input, null, 2)
        this.deps.log.add(callEntry)
        let res: ToolResult
        if (signal.aborted) {
          res = { content: 'Not executed: the brain is shutting down.', isError: true }
        } else if (result.stopReason === 'max_tokens') {
          res = {
            content:
              'Not executed: your reply was cut off by the output length limit, so these arguments may be incomplete. Call the tool again with shorter arguments.',
            isError: true,
          }
        } else if (call.invalid) {
          res = {
            content: `Not executed: the arguments were not valid JSON (${call.invalid.reason}). You sent: ${clip(call.invalid.raw, 300)}\nCall the tool again with valid JSON arguments.`,
            isError: true,
          }
        } else {
          res = await runTool(this.deps.tools, ctx, call.name, call.input, { maxResultChars: settings.toolResultMaxChars })
        }
        const entry: Parameters<ActivityLog['add']>[0] = { kind: 'tool_result', turn: turnId, who: call.name, text: firstLine(res.content) }
        if (entry.text !== res.content) entry.detail = res.content
        if (res.isError) entry.isError = true
        this.deps.log.add(entry)
        results.push(
          res.isError
            ? { type: 'tool_result', toolCallId: call.id, content: res.content, isError: true }
            : { type: 'tool_result', toolCallId: call.id, content: res.content },
        )
      }
      turnMessages.push({ role: 'user', content: results })

      if (signal.aborted) {
        this.deps.history.appendTurn({ id: turnId, startedAt, messages: turnMessages })
        return
      }
      if (steps >= settings.maxSteps) {
        appendNote(STEP_LIMIT_NOTE)
        this.deps.log.add({ kind: 'error', turn: turnId, text: `到了每轮 ${settings.maxSteps} 步的上限，这一轮被截断。` })
        break
      }
    }

    saveTurn()

    // 兜底：有人跟它说话，它全程没用 say / whisper，却留了一段文字——替它说出去。
    if (humanTriggered && !this.turnSpoke && finalText.length > 0) {
      const text = cleanChatText(finalText, FALLBACK_SAY_CHARS)
      if (text.length > 0) {
        try {
          await this.deps.bridge.botChat(settings.botName, text)
          this.turnSpoke = true
          this.deps.log.add({ kind: 'say', turn: turnId, who: settings.botName, text, detail: '模型没有调用 say，这是把它最后的文字代为说出' })
        } catch (e) {
          this.deps.log.add({ kind: 'error', turn: turnId, text: `想替它把话说出去，但没成功：${e instanceof Error ? e.message : String(e)}` })
        }
      }
    }
    if (this.turnSpoke) {
      const now = this.now()
      for (const ev of triggers) {
        if (ev.type === 'chat') this.lastExchange.set(ev.player.toLowerCase(), now)
        else if (ev.type === 'whisper') this.lastExchange.set(ev.from.toLowerCase(), now)
      }
    }

    this.deps.log.add({ kind: 'turn', turn: turnId, text: `第 ${turnId} 轮结束（调了 ${steps} 次模型）` })
    await this.maybeCompact(llm, settings, signal)
  }

  private priorMessages(): Message[] {
    const h = this.deps.history.get()
    return historyMessages(h.summary, h.turns)
  }

  private overBudget(settings: AgentSettings): boolean {
    return settings.dailyTokenLimit > 0 && this.deps.todayTokens() >= settings.dailyTokenLimit
  }

  private async callModel(llm: LlmClient, req: GenerateRequest): Promise<GenerateResult> {
    const started = performance.now()
    try {
      const result = await llm.generate(req)
      this.lastCall = {
        time: this.now(),
        ok: true,
        durationMs: Math.round(performance.now() - started),
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      }
      if (this.llmFailures > 0) {
        this.deps.log.add({ kind: 'info', text: '模型接口恢复了，继续干活。' })
        this.llmFailures = 0
        this.nextRetryAt = 0
        this.outageAnnounced = false
      }
      return result
    } catch (e) {
      const kind = e instanceof LlmError ? e.kind : 'unknown'
      if (kind !== 'aborted') {
        this.lastCall = {
          time: this.now(),
          ok: false,
          durationMs: Math.round(performance.now() - started),
          errorKind: kind,
          error: e instanceof Error ? e.message : String(e),
        }
      }
      throw e
    }
  }

  /** 模型接口（在调用层自己的重试用尽之后）还是失败：停止硬试，过一阵再来；在聊天里说一次。 */
  private async onModelFailure(e: LlmError): Promise<void> {
    const now = this.now()
    this.llmFailures++
    if (this.llmFailures === 1) this.outageSince = now
    this.lastFailureAt = now
    this.lastFailureText = `${e.kind}${e.status !== undefined ? ` (HTTP ${e.status})` : ''}: ${e.message}`
    const delays = this.timing.retryDelaysMs
    const delay = e.retryable
      ? (delays[Math.min(this.llmFailures - 1, delays.length - 1)] ?? 60_000)
      : this.timing.nonRetryableDelayMs
    this.nextRetryAt = now + delay
    const advice =
      e.kind === 'auth'
        ? '检查面板里的 API key。'
        : e.kind === 'bad_request'
          ? '检查模型名和接口参数；如果换过服务商后一直这样，可以在面板清空对话历史。'
          : ''
    this.deps.log.add({
      kind: 'error',
      text: `模型调用失败：${this.lastFailureText}。${Math.round(delay / 1000)} 秒后再试，改了模型配置会立刻再试。${advice}`,
    })
    if (!this.outageAnnounced) {
      this.outageAnnounced = true
      await this.announce('model_down', e.retryable ? '我这边模型接口连不上了，先歇一会儿，好了再继续。' : '我的模型接口配置好像有问题，得有人去面板看看。')
    }
  }

  /** 在公共聊天里说一句“我现在不行”之类的话。同一种话限频；说不出去就算了。 */
  private async announce(key: string, text: string): Promise<void> {
    const now = this.now()
    const last = this.lastAnnounce.get(key)
    if (last !== undefined && now - last < this.timing.announceIntervalMs) return
    this.lastAnnounce.set(key, now)
    try {
      await this.deps.bridge.botChat(this.deps.settings().botName, text)
      this.deps.log.add({ kind: 'say', who: this.deps.settings().botName, text, detail: '这句话是程序替它说的，不是模型说的' })
    } catch {
      /* bot 不在线或 bridge 没连上 */
    }
  }

  // ── 历史压缩 ──

  private async maybeCompact(llm: LlmClient, settings: AgentSettings, signal: AbortSignal): Promise<void> {
    const h = this.deps.history.get()
    const res = await compactHistory(h.summary, h.turns, { threshold: settings.historyTokenThreshold, llm, signal })
    if (res.action !== 'nothing') this.deps.history.replace(res.summary, res.turns)
    if (res.action === 'summarized') {
      this.deps.log.add({ kind: 'info', text: `历史太长，把较早的 ${res.removedTurns} 轮压成了摘要。`, detail: res.summary })
    } else if (res.action === 'dropped') {
      this.deps.log.add({ kind: 'error', text: `历史太长且摘要没写成（${res.error ?? '未知原因'}），丢弃了较早的 ${res.removedTurns} 轮。` })
    } else if (res.error) {
      this.deps.log.add({ kind: 'error', text: `历史该压缩了，但摘要没写成：${res.error}。下一轮再试。` })
    }
  }

  /** 模型明确说上下文超长时用：不看阈值，把最近一轮之前的全部压掉；压不了就丢。 */
  private async forceCompact(llm: LlmClient, signal: AbortSignal): Promise<void> {
    const h = this.deps.history.get()
    if (h.turns.length === 0 && h.summary.length === 0) return
    const res = await compactHistory(h.summary, h.turns, { threshold: 1, llm, signal })
    if (res.action === 'summarized' || res.action === 'dropped') {
      this.deps.history.replace(res.summary, res.turns)
    } else {
      this.deps.history.replace(h.summary, [])
    }
  }

  // ── 杂项 ──

  private wakePolicy(): WakePolicy {
    const s = this.deps.settings()
    return {
      botName: s.botName,
      aliases: s.aliases,
      owners: s.owners,
      mode: s.wakeMode,
      conversationWindowMs: s.conversationWindowSec * 1000,
      ...DEFAULT_WAKE_TUNING,
    }
  }

  private toolContext(botName: string): ToolContext {
    return {
      botName,
      bridge: this.deps.bridge,
      memory: this.deps.memory,
      reminders: this.deps.reminders,
      now: () => this.now(),
      laterMessages: async (since, waitMs) => {
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        return this.botMessages.filter((m) => m.at >= since).map((m) => m.text)
      },
      hooks: {
        spoke: (info) => {
          this.turnSpoke = true
          this.deps.log.add({
            kind: 'say',
            who: botName,
            text: info.kind === 'whisper' ? `（私聊 ${info.to ?? '?'}）${info.text}` : info.text,
          })
        },
        taskStarted: (task) => {
          if (task.state === 'running' || task.state === 'queued') {
            this.tracked.add(task.id)
            this.persist()
          }
        },
        cancelStart: () => this.cancelStart(),
        cancelEnd: (ids) => this.cancelEnd(ids),
        commandStart: () => {
          this.commandsInFlight++
        },
        commandEnd: () => {
          this.commandsInFlight = Math.max(0, this.commandsInFlight - 1)
        },
      },
    }
  }

  private pushBackground(ev: AgentEvent): void {
    this.background.push(ev)
    if (ev.type === 'bot_message') {
      // 系统消息只留最近的几条
      let extra = this.background.filter((e) => e.type === 'bot_message').length - BACKGROUND_BOT_MESSAGES_MAX
      if (extra > 0) {
        this.background = this.background.filter((e) => {
          if (e.type !== 'bot_message' || extra <= 0) return true
          extra--
          return false
        })
      }
    }
    if (this.background.length > BACKGROUND_MAX) this.background.splice(0, this.background.length - BACKGROUND_MAX)
  }

  private logEvent(ev: AgentEvent, decision: WakeDecision): void {
    // 只有“本来可能要回应、但这次没叫醒模型”的情况才值得在面板上说明原因
    const note = decision.wake ? undefined : NOT_WOKEN_NOTES[decision.reason]
    const add = (entry: Parameters<ActivityLog['add']>[0]) => {
      if (note !== undefined) entry.detail = note
      this.deps.log.add(entry)
    }
    switch (ev.type) {
      case 'chat':
        add({ kind: 'chat', who: ev.player, text: ev.message, time: ev.time })
        break
      case 'whisper':
        add({ kind: 'whisper', who: ev.from, text: ev.message, time: ev.time })
        break
      case 'panel_command':
        add({ kind: 'command', who: '面板', text: ev.text, time: ev.time })
        break
      case 'task_ended':
        if (ev.task.state === 'failed') add({ kind: 'event', text: describeEvent(ev), time: ev.time, isError: true })
        else add({ kind: 'event', text: describeEvent(ev), time: ev.time })
        break
      default:
        add({ kind: 'event', text: describeEvent(ev), time: ev.time })
    }
  }

  private persist(): void {
    try {
      this.deps.persist?.save({
        tracked: [...this.tracked],
        endedSeen: this.endedSeen,
        queue: [...this.inFlight, ...this.pending],
      })
    } catch (e) {
      console.error('[agent] 保存状态失败：', e instanceof Error ? e.message : e)
    }
  }
}

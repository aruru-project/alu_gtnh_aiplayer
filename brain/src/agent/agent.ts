// agent 循环：事件驱动。收事件 → 唤醒策略 → 一轮决策（组上下文、调模型、执行工具，直到模型不再调用工具）。
// 这一层不直接发 HTTP（走 LlmClient），不直接读写 socket（走 BridgeApi）。一个 bot 一个 Agent 实例。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BridgeEvent } from '../bridge/protocol.ts'
import { LlmError, keepLatestImages, textOf } from '../llm/index.ts'
import type { GenerateRequest, GenerateResult, LlmClient, Message, TextPart, ToolResultPart, UserPart } from '../llm/index.ts'
import type { ActivityLog, ActivityModelCall } from '../store/activity-log.ts'
import type { FeedbackContext, FeedbackStore, FeedbackTask, FeedbackToolCall } from '../store/feedback.ts'
import type { HistoryStore } from '../store/history.ts'
import { cleanChatText } from '../tools/chat.ts'
import { clip, compactJson } from '../tools/format.ts'
import type { DesignWorkspace } from '../design/index.ts'
import type { PackData } from '../packdata/index.ts'
import { LEGACY_TOOLS, QUERY_TOOLS, QuestProgressCache, SurroundingsCache, modelToolSpecs, runTool } from '../tools/index.ts'
import type { ManualAccess, MemoryAccess, ProgramToolResult, ReminderAccess, Tool, ToolContext, ToolResult } from '../tools/index.ts'
import { compactHistory, historyMessages } from './compaction.ts'
import { buildSnapshot, composeArrivals, composeTurnMessage, manualStatusLine, manualsInContext } from './context.ts'
import type { PendingReminder } from './context.ts'
import { describeEvent, eventLine, fromBridgeEvent, isHumanInput } from './events.ts'
import type { AgentEvent } from './events.ts'
import { buildSystemPrompt } from './prompt.ts'
import { RoutineRunner, describeRoutine } from './routine.ts'
import type { RoutineLimits, RoutineView } from './routine.ts'
import { RunRecorder } from './run-log.ts'
import type { RunLogStore } from './run-log.ts'
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
  /** 例程没说跑多久时最多跑几分钟；它自己要求时最多给到几分钟。主人在面板的设置里定，不给用 routine.ts 里的默认。 */
  routineMinutes?: number
  routineMaxMinutes?: number
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
  /** 当前用的是哪个服务商的哪个模型（给人看的，如“官方接口 / gpt-x”）。每一轮记进日志，事后好对比。 */
  modelName?(): string | undefined
  /** 当前用的模型能不能看图（模型上的开关）。没提供就是不能：带图的工具只给文字说明。 */
  canSeeImages?(): boolean
  /** 工具结果带的图存一份给面板的对话日志显示；没提供就不存。 */
  pictures?: { save(png: Buffer, blocks?: unknown): string }
  bridge: BridgeApi
  tools: readonly Tool[]
  memory: MemoryAccess & { render(): string }
  /** 手册：提示词里列目录，模型用 read_manual 读。 */
  manuals: ManualAccess
  /** 本地资料（任务书、物品表）。没有时相关工具改问服务器。 */
  packdata?: PackData
  /** 自己出设计用的：跑程序的沙箱、图纸草稿、主人传的图片。 */
  design?: DesignWorkspace
  /** 例程的各项上限；不给用默认的（时长那两项以 settings 里的为准）。 */
  routineLimits?: Partial<RoutineLimits>
  /** 程序（例程、run_program）每次运行的全量记录落在哪；不给就不落盘。 */
  runLogs?: RunLogStore
  /** 意见簿：模型用 report_problem 记下的反馈存在这里。 */
  feedback?: FeedbackStore
  /** 大脑和身体（mod）的版本，附在意见簿的每一条上。 */
  versions?(): { brain: string; mod?: string }
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
  cacheReadTokens?: number
  errorKind?: string
  error?: string
}

/** model_call 那条日志的一行字。 */
export function modelCallText(call: ActivityModelCall): string {
  const what = call.purpose === 'compact' ? '压缩历史' : `第 ${call.step ?? '?'} 步`
  if (call.state === 'thinking') return `${what}：模型在想…`
  const seconds = `${((call.ms ?? 0) / 1000).toFixed(1)} 秒`
  if (call.state === 'failed') return `${what}：模型调用失败（${call.errorKind ?? 'unknown'}，${seconds}）：${call.error ?? ''}`
  const cache = call.cacheReadTokens !== undefined && call.cacheReadTokens > 0 ? `（缓存命中 ${call.cacheReadTokens}）` : ''
  const how =
    call.stop === 'tool_calls' ? `要调 ${call.toolCalls ?? 0} 个工具` : call.stop === 'truncated' ? '被输出上限截断了' : call.stop === 'end' ? '说完了' : '结束了'
  return `${what}：${seconds}，输入 ${call.inputTokens ?? '?'}${cache} / 输出 ${call.outputTokens ?? '?'} token，${how}`
}

/** 模型这一头现在在干什么（面板页头用）。 */
export interface ModelState {
  /** idle：没有在跑的一轮；thinking：模型调用进行中；tools：这一轮没完，正在执行它要的工具；outage：模型接口故障，过一阵再试。 */
  state: 'idle' | 'thinking' | 'tools' | 'outage'
  /** 正在跑的那一轮、它的第几次模型调用。 */
  turn?: number
  step?: number
  /** thinking 时：这一次是什么时候开始想的。 */
  since?: number
  /** thinking 时：这次调用是一轮里的一步，还是在压缩历史。 */
  purpose?: 'turn' | 'compact'
  outage?: { failures: number; since: number; nextRetryAt: number; lastError: string }
  lastCall?: LastCall
}

/** 一个代理现在的样子。以后它开的帮手各有一份（各有自己的模型、自己的一轮、自己的例程）。 */
export interface AgentState {
  /** 哪个代理：现在只有 main。日志条目的 agent 字段和它对得上（不带就是 main）。 */
  agent: string
  model: ModelState
  /** 正在跑的一轮；没有是 null。steps 是已经完成的模型调用次数。 */
  turn: { id: number; startedAt: number; steps: number; maxSteps: number } | null
  /** 排着队还没处理的事件数。 */
  pending: number
  botOnline: boolean | undefined
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
  /** 正在跑的例程（没有就是上一个跑完的）。 */
  routine?: RoutineView
}

const BACKGROUND_MAX = 60
/** 一轮的现场里留最近几次工具调用，每次的参数和结果各留多长（意见簿存的时候还会再裁）。 */
const TRACE_CALLS_KEPT = 8
const TRACE_INPUT_CHARS = 400
const TRACE_RESULT_CHARS = 1500
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
/**
 * 一轮里同时附带的图最多这么多张：再要新的，最早的那张换成占位文字。
 * 一轮结束后图一张都不留（见 HistoryStore.appendTurn），所以这只管一轮之内。
 */
export const LIVE_IMAGES_MAX = 4
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
  /** 最近一个跟它说话（并把它叫醒）的玩家。没有主人名单时，查任务书进度默认看他的。 */
  private lastSpeaker: string | undefined
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
  /** 任务书进度（谁做完了哪些）的短时缓存：一轮里连着查几次任务书，只问服务器一次。 */
  private readonly questProgress: QuestProgressCache
  /** 附近有哪些机器和工作台，记二十秒：连着查几样东西的做法时不用每次都问身体。 */
  private readonly surroundings: SurroundingsCache
  /** 后台例程（要有跑程序的沙箱才有）。 */
  private readonly routine: RoutineRunner | undefined
  /** 正在跑的一轮（面板状态用）。 */
  private turnNow: { id: number; startedAt: number; steps: number; maxSteps: number } | undefined
  /** 进行中的那次模型调用。 */
  private thinking: { turn?: number; step?: number; since: number; purpose: 'turn' | 'compact' } | undefined
  /** run_program 正在跑的那个程序的记录员（它调的工具归到一起记：一条汇总，全量在记录文件里）。 */
  private programRun: RunRecorder | undefined
  private programSeq = 1
  private programCalls = 0
  /** 正在跑的这一轮的现场：它是被什么叫醒的、到现在调了哪些工具、牵涉哪些任务。模型往意见簿里记一条时附上。 */
  private turnTrace: { turn: number; instruction: string; calls: FeedbackToolCall[]; tasks: Map<string, FeedbackTask> } | undefined

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
    this.questProgress = new QuestProgressCache(deps.bridge, () => this.now())
    this.surroundings = new SurroundingsCache(() => this.now())
    this.routine = deps.design
      ? new RoutineRunner({
          design: deps.design,
          bridge: deps.bridge,
          botName: () => this.deps.settings().botName,
          tools: deps.tools,
          context: (onTaskStarted) => {
            // 和模型调工具用同一个上下文；开了任务时多告诉例程一声，它好等这个任务结束
            const ctx = this.toolContext(this.deps.settings().botName)
            const tell = ctx.hooks.taskStarted
            ctx.hooks = {
              ...ctx.hooks,
              taskStarted: (task) => {
                tell?.(task)
                onTaskStarted(task)
              },
            }
            return ctx
          },
          log: deps.log,
          now: () => this.now(),
          ended: (view) => this.routineEnded(view),
          cancelTask: async (id) => {
            await this.ownCancel(() => this.deps.bridge.taskCancel(this.deps.settings().botName, id))
          },
          redeliver: (ev) => this.handleEvent(ev),
          // 每次启动例程时现问：时长的默认和最长是主人在面板上设的
          limits: () => {
            const s = this.deps.settings()
            return {
              ...(deps.routineLimits ?? {}),
              ...(s.routineMinutes !== undefined && deps.routineLimits?.wallMs === undefined ? { wallMs: s.routineMinutes * 60_000 } : {}),
              ...(s.routineMaxMinutes !== undefined && deps.routineLimits?.maxWallMs === undefined ? { maxWallMs: s.routineMaxMinutes * 60_000 } : {}),
            }
          },
          ...(deps.runLogs ? { runs: deps.runLogs } : {}),
          // 每次现问：主人在面板上改了“单个工具结果上限”，例程里的工具结果和程序的返回值跟着变
          maxResultChars: () => this.deps.settings().toolResultMaxChars,
        })
      : undefined
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
    // 正在跑的例程停下：它正等着的任务取消掉（等这次取消发出去，最多两秒），“它停在哪”排进下次启动要处理的事里
    if (this.routine?.stop('the brain was shut down or restarted')) {
      let giveUp: NodeJS.Timeout | undefined
      await Promise.race([this.routine.whenCanceled(), new Promise<void>((resolve) => (giveUp = setTimeout(resolve, 2000)))])
      clearTimeout(giveUp)
    }
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
    // 例程开的任务：开始、结束都交给例程，不叫醒模型（例程自己把每一步记进了日志，做完会一次叫醒）
    if ((ev.type === 'task_ended' || ev.type === 'task_started') && this.routine?.owns(ev.task.id)) {
      if (ev.type === 'task_ended') {
        const key = taskEndKey(ev)
        if (this.endedSeen.includes(key)) return
        this.endedSeen.push(key)
        if (this.endedSeen.length > ENDED_SEEN_MAX) this.endedSeen.splice(0, this.endedSeen.length - ENDED_SEEN_MAX)
        this.tracked.delete(ev.task.id)
        this.persist()
        this.routine.taskEnded(ev.task)
      }
      return
    }
    // 例程正调着工具时来的、谁也不认识的任务：多半是这次调用开的，只是“开了”的回话还没处理到。先交给例程扣着，
    // 它的调用回来以后，是它的归它，不是的再送回这里照常处理
    if ((ev.type === 'task_ended' || ev.type === 'task_started') && !this.tracked.has(ev.task.id) && !this.endedSeen.includes(ev.task.id) && this.routine?.hold(ev)) return
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
      if (ev.type === 'chat') {
        this.lastExchange.set(ev.player.toLowerCase(), now)
        this.lastSpeaker = ev.player
      } else if (ev.type === 'whisper') {
        this.lastExchange.set(ev.from.toLowerCase(), now)
        this.lastSpeaker = ev.from
      }
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

  /** 面板上主人点了“停止例程”。没有在跑的返回 false。 */
  stopRoutine(): boolean {
    return this.routine?.stop('your owner stopped it on the control panel') ?? false
  }

  /** 例程结束了：记一笔，叫醒模型，把它的情况和日志给模型看。 */
  private routineEnded(view: RoutineView): void {
    const text = describeRoutine(view, this.now())
    this.deps.log.add({ kind: view.status === 'done' ? 'info' : 'error', text: `例程 ${view.id}（${view.name}）${view.status === 'done' ? '跑完了' : '停了'}：${view.ending ?? ''}`, detail: text, source: 'routine', runId: view.id, ...(view.run ? { run: view.run } : {}) })
    if (this.stopped) {
      // 大脑在退出：这件事连同排着的事一起落盘，下次启动再告诉模型
      this.pending.push({ type: 'notice', time: this.now(), wake: true, text: `大脑重启的时候你的例程还没跑完，已经停下（它做了的事不会撤销，正在做的那个任务取消了）。看完日志和现场，再决定要不要重新开一个：\n${text}` })
      this.persist()
      return
    }
    this.handleEvent({ type: 'notice', time: this.now(), wake: true, text: `你启动的例程有结果了，看完决定下一步（它做了的事不会撤销）：\n${text}` })
  }

  /**
   * run_program 的程序里调一个工具：只许查询类的，走和模型调工具同一条路。
   * 每一次调用记进这个程序自己的运行记录（run-log.ts）：对话日志里是一条汇总加出错的那几次，不是每次两条。
   */
  private async queryFromProgram(name: string, input: unknown): Promise<ProgramToolResult> {
    const record = this.programRun
    const n = ++this.programCalls
    const since = this.now()
    record?.waiting(name, input)
    let out: ProgramToolResult
    if (!QUERY_TOOLS.includes(name)) {
      // 列出来的是现在的名字；合并掉的旧名字照样能调，只是不再提
      const lookups = QUERY_TOOLS.filter((query) => !LEGACY_TOOLS.some((old) => old.name === query))
      out = { ok: false, text: `${name} cannot be called from run_program: a program there can only look things up (${lookups.join(', ')}). To act, start the program with start_routine.` }
    } else {
      const res = await runTool(this.deps.tools, this.toolContext(this.deps.settings().botName), name, input, { maxResultChars: this.deps.settings().toolResultMaxChars })
      out = { ok: res.isError !== true, text: res.content, ...(res.data !== undefined ? { data: res.data } : {}) }
    }
    record?.call({ n, tool: name, input, ok: out.ok, text: out.text, ms: this.now() - since })
    return out
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
    const routine = this.routine?.view()
    if (routine) s.routine = routine
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

  /** 模型这一头、这一轮现在的样子（面板页头用；和 status 是同一份事实，按“谁在干什么”整理过）。 */
  state(): AgentState {
    const model: ModelState = { state: 'idle' }
    if (this.thinking) {
      model.state = 'thinking'
      model.since = this.thinking.since
      model.purpose = this.thinking.purpose
      if (this.thinking.turn !== undefined) model.turn = this.thinking.turn
      if (this.thinking.step !== undefined) model.step = this.thinking.step
    } else if (this.turnNow) {
      model.state = 'tools'
      model.turn = this.turnNow.id
      model.step = this.turnNow.steps
    } else if (this.llmFailures > 0) {
      model.state = 'outage'
    }
    if (this.llmFailures > 0) model.outage = { failures: this.llmFailures, since: this.outageSince, nextRetryAt: this.nextRetryAt, lastError: this.lastFailureText }
    if (this.lastCall) model.lastCall = this.lastCall
    return { agent: 'main', model, turn: this.turnNow ? { ...this.turnNow } : null, pending: this.pending.length, botOnline: this.botOnline }
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
      this.turnNow = undefined
      this.thinking = undefined
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
    // 这一轮里有没有人跟它说话（兜底代说用）：开头没有、中途有人说了也算
    let humanTriggered = triggers.some(isHumanInput)

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

    // 这一轮从头到尾用同一个模型：中途在面板上换了，下一轮才生效
    const llm = this.deps.llm()
    const modelName = this.deps.modelName?.()
    const canSee = this.deps.canSeeImages?.() === true
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
    // 哪几本手册的原文现在还在历史里：压缩截掉了的、主人改过了的都不算，模型要用时会重新读
    const manuals = this.deps.manuals.list()
    const manualLine = manualStatusLine(manuals, manualsInContext(this.priorMessages(), manuals))
    const userText = composeTurnMessage(triggers, background, manualLine ? `${snapshot.text}\n${manualLine}` : snapshot.text, startedAt)
    const turnMessages: Message[] = [{ role: 'user', content: [{ type: 'text', text: userText }] }]
    this.deps.log.add({
      kind: 'turn',
      turn: turnId,
      text: `第 ${turnId} 轮开始${modelName ? `（${modelName}）` : ''}：${triggers.map((e) => firstLine(describeEvent(e), 40)).join('；')}`,
      detail: userText,
    })
    this.turnTrace = { turn: turnId, instruction: triggers.map((e) => eventLine(e, startedAt)).join('\n'), calls: [], tasks: new Map() }
    this.turnNow = { id: turnId, startedAt, steps: 0, maxSteps: settings.maxSteps }
    for (const ev of triggers) if (ev.type === 'task_ended' || ev.type === 'task_started') this.traceTask(ev.task)

    const system = buildSystemPrompt({
      persona: settings.persona,
      botName: settings.botName,
      aliases: settings.aliases,
      owners: settings.owners,
      memory: this.deps.memory.render(),
      manuals,
    })
    // 清单按这一轮用的模型给：看图的工具只发给能看图的模型；库函数不在清单里，在 run_program 说明后面的索引里
    const toolSpecs = modelToolSpecs(this.deps.tools, { canSee })
    const ctx = this.toolContext(settings.botName, canSee)
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

    // 一步的工具结果凑齐之后、下一次调模型之前：把这期间新到的、本来会另开一轮的事接在工具结果后面。
    // 不然它干活的三五十秒里主人说的话只能排队，等这一轮完全结束才读到——总是慢一拍，还会把刚做过的事再做一遍。
    // 接进来的事算这一轮的（和开头那几件一样落盘：崩溃重启不丢，也不再为它另开一轮）。
    let unanswered: { events: AgentEvent[]; part: TextPart } | undefined
    const absorbArrivals = (): void => {
      const last = turnMessages[turnMessages.length - 1]
      if (this.pending.length === 0 || !last || last.role !== 'user') return
      const events = this.pending.splice(0)
      const part: TextPart = { type: 'text', text: composeArrivals(events, this.now()) }
      last.content.push(part)
      triggers.push(...events)
      unanswered = { events, part }
      if (events.some(isHumanInput)) humanTriggered = true
      if (this.turnTrace) this.turnTrace.instruction += `\n${events.map((e) => eventLine(e, this.now())).join('\n')}`
      for (const ev of events) if (ev.type === 'task_ended' || ev.type === 'task_started') this.traceTask(ev.task)
      this.deps.log.add({ kind: 'info', turn: turnId, text: `这一步期间新到的 ${events.length} 件事接在工具结果后面交给模型了（算在这一轮里，不另开一轮）。`, detail: part.text })
      this.persist()
    }
    // 接进来了、模型却没看到（这次调用失败、进程要停）：从这一轮里拿掉，原样放回队列最前面
    const returnUnanswered = (): void => {
      if (!unanswered) return
      const { events, part } = unanswered
      unanswered = undefined
      const last = turnMessages[turnMessages.length - 1]
      if (last && last.role === 'user') last.content = last.content.filter((p) => p !== part)
      for (const ev of events) {
        const at = triggers.indexOf(ev)
        if (at >= 0) triggers.splice(at, 1)
      }
      this.pending.unshift(...events)
      this.persist()
    }

    for (;;) {
      if (steps > 0 && this.overBudget(settings)) {
        appendNote(BUDGET_NOTE)
        this.deps.log.add({ kind: 'error', turn: turnId, text: '今天的 token 用量到上限了，这一轮提前结束。' })
        break
      }
      if (steps > 0) absorbArrivals()

      let result: GenerateResult
      try {
        result = await this.callModel(llm, { system, messages: [...prior, ...keepLatestImages(turnMessages, LIVE_IMAGES_MAX)], tools: toolSpecs, signal }, { purpose: 'turn', turn: turnId, step: steps + 1 })
      } catch (e) {
        returnUnanswered()
        if (!(e instanceof LlmError)) throw e
        if (e.kind === 'aborted') {
          // 进程要停。做过的事留在历史里；触发事件还在落盘的队列里，下次启动接着处理。
          if (steps > 0) this.deps.history.appendTurn({ id: turnId, startedAt, messages: turnMessages })
          return
        }
        if (e.kind === 'context_length' && !compactedForContext) {
          compactedForContext = true
          this.deps.log.add({ kind: 'info', turn: turnId, text: '模型说上下文太长，先压缩历史再试一次。' })
          await this.forceCompact(this.compactor(llm, turnId), signal)
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
      if (this.turnNow) this.turnNow.steps = steps
      unanswered = undefined

      turnMessages.push(result.message)
      const text = textOf(result.message.content).trim()
      if (text.length > 0) this.deps.log.add({ kind: 'model_text', turn: turnId, step: steps, text })
      const calls = result.message.content.filter((p) => p.type === 'tool_call')
      if (calls.length === 0) {
        finalText = text
        break
      }

      const results: UserPart[] = []
      for (const call of calls) {
        // 面板日志：一行放得下就不再附“详情”
        const argsLine = compactJson(call.invalid ? call.invalid.raw : call.input, 160)
        const callEntry: Parameters<ActivityLog['add']>[0] = { kind: 'tool_call', turn: turnId, step: steps, source: 'model', who: call.name, text: argsLine }
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
          // 不在清单里的名字（库函数、合并掉的旧名字、不能看图时的看图工具）runTool 一样找得到，照常执行
          res = await runTool(this.deps.tools, ctx, call.name, call.input, { maxResultChars: settings.toolResultMaxChars })
        }
        this.turnTrace.calls.push({
          tool: call.name,
          input: compactJson(call.invalid ? call.invalid.raw : call.input, TRACE_INPUT_CHARS),
          result: res.content.slice(0, TRACE_RESULT_CHARS),
          ...(res.isError ? { isError: true } : {}),
        })
        if (this.turnTrace.calls.length > TRACE_CALLS_KEPT) this.turnTrace.calls.shift()
        const entry: Parameters<ActivityLog['add']>[0] = { kind: 'tool_result', turn: turnId, step: steps, source: 'model', who: call.name, text: firstLine(res.content) }
        if (entry.text !== res.content) entry.detail = res.content
        if (res.isError) entry.isError = true
        const images = res.images ?? []
        // 图存一份给面板看（模型看不了图时主人照样看得到）
        if (images.length > 0 && this.deps.pictures) {
          try {
            entry.pictures = images.map((image) => this.deps.pictures!.save(image.data, image.blocks))
            const scenes = entry.pictures.filter((_, n) => images[n]!.blocks !== undefined)
            if (scenes.length > 0) entry.scenes = scenes
          } catch (e) {
            this.deps.log.add({ kind: 'error', turn: turnId, text: `工具结果带的图没存下来（面板上看不到这张图）：${e instanceof Error ? e.message : String(e)}` })
          }
        }
        this.deps.log.add(entry)
        const part: ToolResultPart = res.isError
          ? { type: 'tool_result', toolCallId: call.id, content: res.content, isError: true }
          : { type: 'tool_result', toolCallId: call.id, content: res.content }
        // 图只给能看图的模型；它只在这一轮里跟着，存进历史时换成一句占位文字
        if (canSee && images.length > 0) part.images = images.map((image) => ({ label: image.label, mediaType: image.mediaType, data: image.data.toString('base64') }))
        results.push(part)
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

    this.deps.log.add({ kind: 'turn', turn: turnId, text: `第 ${turnId} 轮结束（调了 ${steps} 次模型${modelName ? `，${modelName}` : ''}）` })
    this.turnNow = undefined
    await this.maybeCompact(this.compactor(llm, turnId), settings, signal)
  }

  /** 压缩历史用的模型：和一轮里的调用走同一条路，这样它也有一条 model_call 日志、也算进“正在想”。 */
  private compactor(llm: LlmClient, turn: number): LlmClient {
    return { generate: (req) => this.callModel(llm, req, { purpose: 'compact', turn }) }
  }

  private priorMessages(): Message[] {
    const h = this.deps.history.get()
    return historyMessages(h.summary, h.turns)
  }

  private overBudget(settings: AgentSettings): boolean {
    return settings.dailyTokenLimit > 0 && this.deps.todayTokens() >= settings.dailyTokenLimit
  }

  /**
   * 调一次模型。每一次在对话日志里是一条 model_call：开始想的时候就记下（面板上看得到“正在想第几步”），
   * 回来或者出错时原地改成结果（用时、token、缓存命中、怎么结束的）。
   */
  private async callModel(llm: LlmClient, req: GenerateRequest, at: { purpose: 'turn' | 'compact'; turn?: number; step?: number }): Promise<GenerateResult> {
    const started = performance.now()
    const startedAt = this.now()
    const where = { ...(at.turn !== undefined ? { turn: at.turn } : {}), ...(at.step !== undefined ? { step: at.step } : {}) }
    const begun: ActivityModelCall = { state: 'thinking', purpose: at.purpose, startedAt, ...(at.step !== undefined ? { step: at.step } : {}) }
    const entry = this.deps.log.add({ kind: 'model_call', ...where, text: modelCallText(begun), call: begun })
    this.thinking = { ...where, since: startedAt, purpose: at.purpose }
    const settle = (end: Partial<ActivityModelCall>): void => {
      this.thinking = undefined
      const call: ActivityModelCall = { ...begun, ...end, ms: Math.round(performance.now() - started) }
      const patch = { text: modelCallText(call), call, ...(call.state === 'failed' ? { isError: true } : {}) }
      // 那一条已经滚出内存（不大可能：一次调用就几十秒）就另记一条，结果不能丢
      if (!this.deps.log.update(entry.id, patch, { persist: true })) this.deps.log.add({ kind: 'model_call', ...where, ...patch })
    }
    try {
      const result = await llm.generate(req)
      const asked = result.message.content.filter((p) => p.type === 'tool_call').length
      settle({
        state: 'done',
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
        ...(result.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: result.usage.cacheWriteTokens } : {}),
        // 被截断的优先说（它要调的工具这时不会执行）；有工具调用就是要调工具，不管接口把结束原因叫什么
        stop: result.stopReason === 'max_tokens' ? 'truncated' : asked > 0 || result.stopReason === 'tool_use' ? 'tool_calls' : result.stopReason === 'end' ? 'end' : 'other',
        toolCalls: asked,
      })
      this.lastCall = {
        time: this.now(),
        ok: true,
        durationMs: Math.round(performance.now() - started),
        model: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cacheReadTokens !== undefined ? { cacheReadTokens: result.usage.cacheReadTokens } : {}),
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
      settle({ state: 'failed', stop: 'error', errorKind: kind, error: kind === 'aborted' ? '大脑在停，这次调用被中止了' : e instanceof Error ? e.message : String(e) })
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

  /** 意见簿里“相关的任务”：这一轮里结束的、开始的、它自己启动的。 */
  private traceTask(task: { id: string; type?: string; state?: string; error?: { code?: string } }): void {
    const entry: FeedbackTask = { id: task.id }
    if (task.type !== undefined) entry.type = task.type
    if (task.state !== undefined) entry.state = task.state
    if (task.error?.code !== undefined) entry.error = task.error.code
    this.turnTrace?.tasks.set(task.id, entry)
  }

  /** 模型往意见簿里记一条时附上的现场。密钥之类不在这里面；存之前意见簿还会再抹一遍。 */
  private feedbackContext(botName: string): FeedbackContext {
    const versions = this.deps.versions?.() ?? { brain: 'unknown' }
    const trace = this.turnTrace
    const context: FeedbackContext = {
      bot: botName,
      brainVersion: versions.brain,
      instruction: trace?.instruction ?? '',
      recentTools: trace ? [...trace.calls] : [],
      tasks: trace ? [...trace.tasks.values()] : [],
    }
    if (versions.mod !== undefined) context.modVersion = versions.mod
    if (trace) context.turn = trace.turn
    return context
  }

  /** 工具（start_routine 这几个）要的口子：文字都在这里拼好。 */
  private routineAccess(): NonNullable<ToolContext['routines']> {
    const routine = this.routine!
    return {
      start: (code, opts) => {
        const res = routine.start(code, opts)
        if ('error' in res) return res
        // 能跑多久照实说：它要的比主人设的最长还久时，写明给了多少
        const time = res.asked !== undefined ? `It may run for ${res.minutes} minutes, the longest your owner allows (you asked for ${res.asked}).` : `It may run for up to ${res.minutes} minutes.`
        return {
          started: `Routine ${res.view.id} ("${res.view.name}") started in the background. ${time} End your turn now: you will be woken when it finishes, fails or is stopped, with its log. routine_status shows how far it is; stop_routine stops it.`,
        }
      },
      status: () => {
        const view = routine.view()
        return view ? describeRoutine(view, this.now()) : undefined
      },
      stop: () => routine.stop('you stopped it with stop_routine'),
    }
  }

  private toolContext(botName: string, canSee = false): ToolContext {
    const feedback = this.deps.feedback
    return {
      botName,
      canSeeImages: () => canSee,
      maxResultChars: () => this.deps.settings().toolResultMaxChars,
      bridge: this.deps.bridge,
      memory: this.deps.memory,
      reminders: this.deps.reminders,
      manuals: this.deps.manuals,
      ...(this.deps.packdata ? { packdata: this.deps.packdata } : {}),
      ...(this.deps.design ? { design: this.deps.design } : {}),
      ...(feedback
        ? {
            feedback: {
              submit: (input) => {
                const res = feedback.submit(input, this.feedbackContext(botName))
                if ('full' in res) return res
                // 新记的一条在对话日志里说一声；同一个问题又来一次的不刷屏
                if (!res.merged) this.deps.log.add({ kind: 'info', text: `它在意见簿里记了一条（${res.report.id}）：${res.report.title}` })
                return { id: res.report.id, merged: res.merged, count: res.report.count }
              },
            },
          }
        : {}),
      questProgress: this.questProgress,
      surroundings: this.surroundings,
      ...(this.routine ? { routines: this.routineAccess(), queryFromProgram: (name: string, input: unknown) => this.queryFromProgram(name, input) } : {}),
      now: () => this.now(),
      // 查任务书进度默认看谁的：主人名单里的第一个；没有名单就是刚才跟它说话的人
      defaultPlayer: () => this.deps.settings().owners[0] ?? this.lastSpeaker,
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
          this.traceTask(task)
          // 任务一开就结束时，结束的事件可能抢在这里之前已经处理过了：那就不用再盯着它
          if ((task.state === 'running' || task.state === 'queued') && !this.endedSeen.includes(task.id)) {
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
        programStarted: (code) => {
          this.programCalls = 0
          this.programRun = new RunRecorder({ log: this.deps.log, now: () => this.now(), ...(this.deps.runLogs ? { store: this.deps.runLogs } : {}) }, { id: `p${this.programSeq++}`, kind: 'program', name: '', code })
        },
        programEnded: (how) => {
          this.programRun?.end(how.ok ? 'done' : 'failed', how.note)
          this.programRun = undefined
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

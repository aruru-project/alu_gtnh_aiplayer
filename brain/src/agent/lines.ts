// 一个玩家，两条线（docs/TALK_WORK.md）：对话线（talk）和干活线（work）是同一个进程里的两个 Agent，各有模型、历史、
// 事件队列和步数上限，互不等待。这里做三件事：
//   1. 分事件：谁说了话、面板指令、提醒 → 对话线；任务、例程、身体的事 → 干活线；死亡、上线下线两条线都知道
//      （干活线去处理，对话线得一份简报）。
//   2. 接上两条线之间的往来：对话线交事和带话（当时的人的原话原样附上）、看干活线在干什么、让一切停下；
//      干活线汇报、提问、一轮结束留下的话。每次往来在活动日志里是一条 kind: relay。
//   3. 对外（main、面板）像原来那一个 agent：收 bridge 事件、握手后对账、状态、停。
//   4. 工作清单（store/todo.ts）：干活线停下来了（身体上没有任务、没有例程、没有在等的回答），清单上却还有没做的，叫醒它一次。
//      它被叫醒以后什么都没改就又停了，不再叫：等清单变了，或者它为别的事走了一轮，才重新算。
//   5. 对话线派出去的子思维（agent/helpers.ts）：它们结束时交回的话送到对话线；对话线的状态里列着在想的那几个；有在想的就不自动下线。
// 共用的东西只有一份：身体（bridge）、记忆、手册、意见簿、设计工作区、每日 token 上限（两条线合计）。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BridgeEvent, TaskList } from '../bridge/protocol.ts'
import type { DesignWorkspace } from '../design/index.ts'
import type { LlmClient } from '../llm/index.ts'
import type { PackData } from '../packdata/index.ts'
import type { ActivityLog } from '../store/activity-log.ts'
import type { ChatLog } from '../store/chat-log.ts'
import type { FeedbackStore } from '../store/feedback.ts'
import type { MethodAccess } from '../tools/methods.ts'
import type { TodoAccess } from '../tools/todo.ts'
import type { HistoryStore } from '../store/history.ts'
import type { HelperRecord, HelperStore } from '../store/helpers.ts'
import { DEFAULT_LIMITS } from '../store/config.ts'
import { clip, formatTask } from '../tools/format.ts'
import { LINE_TOOLS, QuestProgressCache, SurroundingsCache } from '../tools/index.ts'
import type { LineName, ManualAccess, MemoryAccess, ReminderAccess } from '../tools/index.ts'
import { Agent, DEFAULT_TIMING, newLineShared } from './agent.ts'
import type { AgentSettings, AgentState, AgentStatus, AgentTiming, CompactNowResult, LinePeek, LineShared, PersistedAgentState, TurnAt } from './agent.ts'
import type { PendingReminder } from './context.ts'
import { describeEvent, fromBridgeEvent } from './events.ts'
import { Helpers } from './helpers.ts'
import type { HelperOverview } from './helpers.ts'
import type { AgentEvent, SaidEvent, WorkerNote } from './events.ts'
import { describeRoutine } from './routine.ts'
import type { RoutineLimits } from './routine.ts'
import type { RunLogStore } from './run-log.ts'
import { errorText, firstLine } from '../util.ts'

/** 一条线用的模型。 */
export interface LineModel {
  /** 当前的模型客户端；没配置时返回 undefined。 */
  llm(): LlmClient | undefined
  /** 给人看的名字（“官方接口 / gpt-x”），记进每一轮的日志。 */
  name?(): string | undefined
  /** 这个模型能不能看图。 */
  canSee?(): boolean
}

/** 两条线之间留着的事：干活线在等的回答、它最近一次送来的话。落盘，重启后对话线的状态里照样写着。 */
export interface LinkState {
  waiting?: { text: string; since: number }
  lastReport?: { type: WorkerNote; text: string; time: number }
  /** 干活线被叫停的时刻：之后清单不再叫醒它，直到它为叫停以后来的事走完一轮。存着，重启后照旧。 */
  haltedAt?: number
}

export interface LinesDeps {
  /** 每条线的设置：名字、主人这些是一样的，步数上限和历史压缩阈值各是各的。 */
  settings(line: LineName): AgentSettings
  /** 两条线各用的模型；helper 是主人给子思维单独选的，没给、或者它的 llm() 是 undefined（没选）时子思维用对话线的。 */
  models: Record<LineName, LineModel> & { helper?: LineModel }
  /** 每个子思维最多走几步（设置里的 helperMaxSteps）。不给用默认的。 */
  helperSteps?(): number
  /** 子思维的落盘（在想的和想完了的）；不给就只在内存里。 */
  helperStore?: HelperStore
  /** 工具结果带的图存一份给面板的对话日志显示；没提供就不存。 */
  pictures?: { save(png: Buffer, blocks?: unknown): string }
  bridge: BridgeApi
  memory: MemoryAccess & { render(): string }
  manuals: ManualAccess
  packdata?: PackData
  design?: DesignWorkspace
  routineLimits?: Partial<RoutineLimits>
  runLogs?: RunLogStore
  feedback?: FeedbackStore
  /** “基地的做法”：两条线用同一份。 */
  methods?: MethodAccess
  /** 工作清单（store/todo.ts 的 TodoStore）：两条线用同一份；清单一变（谁改的都算）这里要知道。 */
  todo?: TodoAccess & { revision(): number; onChange(fn: () => void): void }
  versions?(): { brain: string; mod?: string }
  reminders: ReminderAccess & { list(): PendingReminder[] }
  histories: Record<LineName, HistoryStore>
  log: ActivityLog
  /** 最近的聊天记录（带站位和指向）；不给就不留，recent_chat 用不了。 */
  chatLog?: ChatLog
  /** 今天已经用掉的 token（输入+输出），两条线合计。 */
  todayTokens(): number
  persist?: Partial<Record<LineName, { load(): PersistedAgentState | undefined; save(state: PersistedAgentState): void }>> & {
    links?: { load(): LinkState | undefined; save(state: LinkState): void }
  }
  timing?: Partial<AgentTiming>
  now?(): number
  /** 这次启动是从“只有一条线”的老数据升上来的：老历史归了干活线，告诉它一声那段历史是怎么来的。 */
  migrated?: boolean
}

/** 总停止的结果。 */
export interface StopResult {
  /** 打断了正在跑的一轮（它当时在第几步）。 */
  turn?: { id: number; step: number }
  /** 停掉的例程。 */
  routine?: string
  /** 取消了的身体任务。 */
  tasks: string[]
  /** 放下了几件干活线还没处理的事。 */
  dropped: number
  /** 身体的任务没取消成（没连上、不在线）时的原话。 */
  error?: string
}

/** 被叫停时干活线正有一个工具在执行：最多等这么久让它回来，再把任务取消一遍。 */
const HALT_SETTLE_MS = 3000
/**
 * 两条线互相叫醒：对话线带话叫醒干活线，干活线留下的话又叫醒对话线。两个模型客气起来（“收到”“不客气”……）就是一个没人参与、
 * 一直花 token 的循环。所以数着：中间没有任何外面的事（有人说话、面板指令、提醒、任务或例程结束、死亡），话头在两条线之间
 * 连着倒了这么多次以后，再往来的话照常送到，但只作背景、不再叫醒对方，并如实告诉发的那一方。有外面的事就从头数。
 */
export const VOLLEY_MAX = 12
const SPINNING = `The two lines have now woken each other ${VOLLEY_MAX} times in a row with no one speaking and nothing happening in the game (no task or routine ending), so the program has stopped waking them for each other. This message is there as background when something else wakes the other line; a player speaking, or a task ending, puts things back to normal.`
/**
 * 因为工作清单叫醒干活线：中间没有任何外面的事，连着叫了这么多次就不再叫（每次它都改了清单，却一直没有开任务、没有提问），
 * 在活动日志里记一条；有外面的事就从头数。
 */
export const TODO_NUDGE_MAX = 8
const NOTE_WORD: Record<WorkerNote, string> = { report: '汇报', question: '提问', result: '停下来了，留下的话', progress: '还在干，中途留下的话', trouble: '出了状况' }
/** 干活线自己会接着做：对话线交事的结果里、状态里都写着这个事实，它就不必回头去催。 */
const SELF_WAKE = 'When a task or routine it started ends, the worker is woken by itself and carries on; nothing has to remind it.'
const MIGRATION_NOTE =
  '大脑升级过：从现在起“跟人说话”和“操作身体干活”分成了两条线，你是干活线。这之前的历史是升级前留下的，那时只有一条线，所以里面有你用 say、whisper 直接对玩家说话的记录。现在对玩家说话的是对话线：你要让人知道的事用 report，或者留在一轮结束时的文字里。'

/**
 * 这件事该到哪条线。both：两条线都要知道的身体大事——干活线去处理，对话线得一份简报。
 */
export function lineOf(ev: AgentEvent): LineName | 'both' {
  switch (ev.type) {
    // 提醒：哪条线定的就叫醒哪条线
    case 'reminder':
      return ev.line ?? 'talk'
    case 'chat':
    case 'whisper':
    case 'panel_command':
    case 'player_join':
    case 'player_leave':
    case 'worker':
    case 'helper':
      return 'talk'
    case 'death':
    case 'spawned':
    case 'despawned':
    case 'server_stopping':
      return 'both'
    case 'task_started':
    case 'task_ended':
    case 'hurt':
    case 'bot_message':
    case 'told':
    case 'halted':
    case 'notice':
    case 'todo':
      return 'work'
  }
}

function ago(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  return s < 90 ? `${s} 秒前` : `${Math.round(s / 60)} 分钟前`
}

function agoEn(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  return s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`
}

/** 一段话太长时只给开头，并写明一共多长。 */
function shown(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字，这里只有开头）` : text
}

export class Lines {
  readonly talk: Agent
  readonly work: Agent
  /** 对话线派出去的子思维。 */
  readonly helpers: Helpers
  private readonly deps: LinesDeps
  private readonly shared: LineShared = newLineShared()
  private links: LinkState = {}
  /** 话头在两条线之间连着倒了几次（中间没有外面的事），和上一次是谁发的。 */
  private volley = 0
  private lastFrom: LineName | undefined
  // ── 工作清单叫醒干活线 ──
  private todoTimer: NodeJS.Timeout | undefined
  /** 上次因为清单叫醒它时，清单上没做的那几条的编号。 */
  private todoNudged: Set<number> | undefined
  /** 上一次叫醒以后，它有没有为别的事走过一轮。 */
  private todoFresh = true
  /** 被叫停了：在它为新的事走完一轮之前，不因为清单叫醒它。 */
  /** 中间没有外面的事，因为清单连着叫醒了几次；到了上限记过日志没有。 */
  private todoInRow = 0
  private todoCapLogged = false
  private closed = false

  constructor(deps: LinesDeps) {
    this.deps = deps
    this.links = { ...(deps.persist?.links?.load() ?? {}) }
    const caches = { questProgress: new QuestProgressCache(deps.bridge, () => this.now()), surroundings: new SurroundingsCache(() => this.now()) }
    const common = {
      shared: this.shared,
      caches,
      bridge: deps.bridge,
      memory: deps.memory,
      manuals: deps.manuals,
      reminders: deps.reminders,
      log: deps.log,
      todayTokens: deps.todayTokens,
      ...(deps.pictures ? { pictures: deps.pictures } : {}),
      ...(deps.packdata ? { packdata: deps.packdata } : {}),
      ...(deps.design ? { design: deps.design } : {}),
      ...(deps.routineLimits ? { routineLimits: deps.routineLimits } : {}),
      ...(deps.runLogs ? { runLogs: deps.runLogs } : {}),
      ...(deps.feedback ? { feedback: deps.feedback } : {}),
      ...(deps.methods ? { methods: deps.methods } : {}),
      ...(deps.todo ? { todo: deps.todo } : {}),
      ...(deps.versions ? { versions: deps.versions } : {}),
      ...(deps.chatLog ? { chatLog: deps.chatLog } : {}),
      ...(deps.timing ? { timing: deps.timing } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    }
    const model = (line: LineName) => {
      const m = deps.models[line]
      return { llm: () => m.llm(), modelName: () => m.name?.(), canSeeImages: () => m.canSee?.() === true }
    }
    const persist = (line: LineName) => (deps.persist?.[line] ? { persist: deps.persist[line]! } : {})
    // 子思维的模型：主人给它选了就用那个，没选就用对话线的（每次现问：面板上换了，下一个派出去的就用新的）
    const own = (): LineModel | undefined => (deps.models.helper?.llm() !== undefined ? deps.models.helper : undefined)
    this.helpers = new Helpers({
      settings: () => deps.settings('talk'),
      maxSteps: () => deps.helperSteps?.() ?? DEFAULT_LIMITS.helperMaxSteps,
      model: {
        llm: () => (own() ?? deps.models.talk).llm(),
        name: () => (own() ?? deps.models.talk).name?.(),
        canSee: () => (own() ?? deps.models.talk).canSee?.() === true,
      },
      bridge: deps.bridge,
      memory: deps.memory,
      manuals: deps.manuals,
      reminders: deps.reminders,
      log: deps.log,
      caches,
      todayTokens: deps.todayTokens,
      workerStatus: (detail) => this.workerStatus(detail),
      nextProgramId: () => `p${this.shared.programSeq++}`,
      // 交回的话在子思维那边已经记过一条（relay），对话线这头不再记
      deliver: (ev) => this.talk.handleEvent(ev, { logged: true }),
      defaultPlayer: () => deps.settings('talk').owners[0] ?? this.shared.lastSpeaker,
      ...(deps.helperStore ? { store: deps.helperStore } : {}),
      ...(deps.pictures ? { pictures: deps.pictures } : {}),
      ...(deps.packdata ? { packdata: deps.packdata } : {}),
      ...(deps.design ? { design: deps.design } : {}),
      ...(deps.runLogs ? { runLogs: deps.runLogs } : {}),
      ...(deps.feedback ? { feedback: deps.feedback } : {}),
      ...(deps.methods ? { methods: deps.methods } : {}),
      ...(deps.versions ? { versions: deps.versions } : {}),
      ...(deps.chatLog ? { chatLog: deps.chatLog } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    })
    this.work = new Agent({
      ...common,
      ...model('work'),
      ...persist('work'),
      line: 'work',
      settings: () => deps.settings('work'),
      tools: LINE_TOOLS.work,
      history: deps.histories.work,
      links: { toTalk: (kind, text, at, waiting) => this.toTalk(kind, text, at, waiting), outside: () => this.outside(), ended: (turn) => this.workEnded(turn.triggers) },
    })
    this.talk = new Agent({
      ...common,
      ...model('talk'),
      ...persist('talk'),
      line: 'talk',
      settings: () => deps.settings('talk'),
      tools: LINE_TOOLS.talk,
      history: deps.histories.talk,
      links: {
        tell: (text, said, saidBefore, at) => this.tell(text, said, saidBefore, at),
        workerStatus: (detail) => this.workerStatus(detail),
        stopWork: async (reason, said, at) => this.stopText(await this.stopWork(reason, 'talk', said, at)),
        workerLine: (now) => this.workerLine(now),
        helpers: this.helpers.access(),
      },
    })
    // 老数据：只有一条线的时候，“有人说话”“提醒到点”也排在那一个队列里。现在这些归对话线。
    this.talk.adoptPending(this.work.takePending((ev) => lineOf(ev) === 'talk'))
    if (deps.migrated) this.work.handleEvent({ type: 'notice', time: this.now(), wake: false, text: MIGRATION_NOTE }, { logged: true })
    deps.todo?.onChange(() => this.armTodo())
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ── 对外 ──

  /** 开始工作。两条线各自接上重启前没处理完的事。 */
  start(): void {
    this.talk.start()
    this.work.start()
    // 重启前没想完的子思维：告诉对话线（一起叫醒它一次）
    this.helpers.start()
    // 重启前清单上就有没做的、而干活线没有别的事接着做
    this.armTodo()
  }

  /** 停下：两条线各自打断正在进行的一轮并收尾；没处理完的事已经落盘，下次启动各自接着来。在想的子思维停掉，下次启动告诉对话线。 */
  async stop(): Promise<void> {
    this.closed = true
    if (this.todoTimer) clearTimeout(this.todoTimer)
    this.todoTimer = undefined
    await Promise.all([this.helpers.close(), this.talk.stop(), this.work.stop()])
  }

  /** bridge 推来的事件。和这个 bot 无关的会被忽略。 */
  handleBridgeEvent(e: BridgeEvent): void {
    const ev = fromBridgeEvent(e, this.deps.settings('work').botName, this.now())
    if (ev) this.handleEvent(ev)
  }

  /** 所有事件的入口：别人说的话留一份进聊天记录，然后分给该收的那条线。 */
  handleEvent(ev: AgentEvent): void {
    if (ev.type === 'chat') this.deps.chatLog?.add({ time: ev.time, kind: 'chat', who: ev.player, text: ev.message, ...(ev.speaker ? { speaker: ev.speaker } : {}) })
    else if (ev.type === 'whisper') this.deps.chatLog?.add({ time: ev.time, kind: 'whisper', who: ev.from, text: ev.message, ...(ev.speaker ? { speaker: ev.speaker } : {}) })
    else if (ev.type === 'panel_command') this.deps.chatLog?.add({ time: ev.time, kind: 'panel', who: 'owner (panel)', text: ev.text })
    // 外面的事：有人说话、提醒到点、任务结束、死了。两条线之间“连着往来了几次”从头数
    // 别的 bot 说的话不算：两个 bot 你一句我一句，不该一次次把防空转的数清零
    const fromBot = (ev.type === 'chat' || ev.type === 'whisper') && ev.isBot === true
    if (!fromBot && (ev.type === 'chat' || ev.type === 'whisper' || ev.type === 'panel_command' || ev.type === 'reminder' || ev.type === 'task_ended' || ev.type === 'death')) this.outside()
    const to = lineOf(ev)
    // 刚上线：下线期间清单上多出来的事，那时看过一眼就放下了（不在线叫醒它也没用），现在再看
    if (ev.type === 'spawned') queueMicrotask(() => this.armTodo())
    if (to === 'talk') this.talk.handleEvent(ev)
    else if (to === 'work') this.work.handleEvent(ev)
    else {
      // 干活线记日志、去处理；对话线只是知道（死亡会叫醒它，上线下线只作背景）
      this.work.handleEvent(ev)
      this.talk.handleEvent(ev, { logged: true })
    }
  }

  /** bridge 每次握手成功后调用：确认 bot 在不在线，核对断线期间结束的任务。 */
  async onBridgeReady(info: { epochChanged: boolean; firstContact?: boolean }): Promise<void> {
    try {
      const status = await this.deps.bridge.botStatus(this.deps.settings('work').botName)
      this.shared.online = status.online === true
    } catch (e) {
      if (e instanceof BridgeError && (e.code === 'not_found' || e.code === 'offline')) this.shared.online = false
      else return
    }
    await this.work.reconcileTasks(info)
    this.armTodo()
  }

  onBridgeDisconnected(): void {
    this.shared.online = undefined
  }

  /** 执行一个会让身体取消任务的请求（面板上点的取消）：对应的“任务被取消”不再叫醒干活线。 */
  ownCancel<T extends { ids?: string[]; replaced?: string[] }>(fn: () => Promise<T>): Promise<T> {
    return this.work.ownCancel(fn)
  }

  /** 面板上主人点了“停止例程”。没有在跑的返回 false。 */
  stopRoutine(): boolean {
    return this.work.stopRoutine()
  }

  /** 模型配置改了：两条线接口故障的退避都清零，马上再试。 */
  notifyConfigChanged(): void {
    this.talk.notifyConfigChanged()
    this.work.notifyConfigChanged()
  }

  /** 干活线的状态（例程、盯着的任务都在它那里）。 */
  status(): AgentStatus {
    return this.work.status()
  }

  statusOf(line: LineName): AgentStatus {
    return this[line].status()
  }

  /** 一条线的模型和这一轮现在的样子。 */
  state(line: LineName = 'work'): AgentState {
    return this[line].state()
  }

  /** 两条线之间留着的事：干活线在等的回答、它最近一次送来的话。 */
  linkState(): LinkState {
    return { ...this.links }
  }

  /** 子思维：在想的和最近结束的（面板的列表，不带过程）。 */
  helperOverview(limit?: number): HelperOverview {
    return this.helpers.overview(limit)
  }

  /** 一个子思维的完整记录（在想的是到现在为止的）。 */
  helperView(id: string): (HelperRecord & { thinkingSince?: number }) | undefined {
    return this.helpers.view(id)
  }

  /** 主人在面板上停掉一个子思维。不在想的返回 false。 */
  stopHelper(id: string): boolean {
    return this.helpers.stop(id, '主人在面板上停的')
  }

  /** 一条线下一次调模型时上下文大概多大（token）：和它的压缩阈值比的那个数。 */
  contextTokens(line: LineName): number {
    return this[line].contextTokens()
  }

  /** 现在就把一条线的历史写成交接记录（dryRun：只写不存）。 */
  compactNow(line: LineName, opts: { dryRun?: boolean } = {}): Promise<CompactNowResult> {
    return this[line].compactNow(opts)
  }

  /**
   * 大脑这边现在有没有事：哪条线在跑一轮或排着事，干活线盯着任务，例程在跑，工作清单上有没做的（在等人的不算），
   * 有子思维在想（它想完会叫醒对话线，和“清单上有没做的”一个道理）。自动下线（presence.ts）看的就是它。
   */
  busy(): boolean {
    const work = this.work.status()
    return !this.talk.idle() || !this.work.idle() || work.trackedTasks.length > 0 || work.routine?.status === 'running' || this.todoOpen().length > 0 || this.helpers.busy()
  }

  // ── 工作清单 ──

  private todoOpen(): { id: number; text: string }[] {
    return (this.deps.todo?.list() ?? []).filter((i) => i.state === 'open').map((i) => ({ id: i.id, text: i.text }))
  }

  /** 干活线走完了一轮：它为别的事（不只是清单的那句）走的，就算“来了别的事”，被叫停的也解开。过一小会儿看要不要叫醒它。 */
  private workEnded(triggers: readonly AgentEvent[]): void {
    if (triggers.some((ev) => ev.type !== 'todo')) this.todoFresh = true
    // 被叫停以后：只有为叫停之后才来的事走完的一轮才解开（叫停时正在收尾、写交接记录的那一轮不算）
    const halted = this.links.haltedAt
    if (halted !== undefined && triggers.some((ev) => ev.type !== 'todo' && ev.type !== 'halted' && ev.time > halted)) this.saveLinks({ ...this.links, haltedAt: undefined })
    this.armTodo()
  }

  private get todoHalted(): boolean {
    return this.links.haltedAt !== undefined
  }

  /** 过一小会儿看要不要因为清单叫醒干活线（再来一次就从头等）。清单上没有没做的就不用看。 */
  private armTodo(): void {
    if (!this.deps.todo || this.closed) return
    // 叫醒它时就在清单上的那几条，已经不是“没做”的（做完了、在等人、删掉了）就从里面去掉：以后被重新打开，算新多出来的
    if (this.todoNudged) {
      const open = new Set(this.todoOpen().map((i) => i.id))
      for (const id of [...this.todoNudged]) if (!open.has(id)) this.todoNudged.delete(id)
    }
    if (this.todoTimer) clearTimeout(this.todoTimer)
    this.todoTimer = undefined
    if (this.todoOpen().length === 0) return
    this.todoTimer = setTimeout(() => {
      this.todoTimer = undefined
      void this.checkTodo()
    }, this.deps.timing?.todoNudgeMs ?? DEFAULT_TIMING.todoNudgeMs)
    this.todoTimer.unref?.()
  }

  /** 干活线是不是停下来了：没有在跑的一轮、没有排着的事、没有盯着的任务、例程没在跑、没有在等的回答。 */
  private workStopped(): boolean {
    const s = this.work.status()
    return this.work.idle() && s.trackedTasks.length === 0 && s.routine?.status !== 'running' && this.links.waiting === undefined
  }

  private async checkTodo(): Promise<void> {
    const todo = this.deps.todo
    if (!todo || this.closed || this.todoHalted || this.todoOpen().length === 0) return
    // 上次叫醒以后清单上没有多出没做的（新加的、重新打开的），它也没为别的事走过一轮：它看过了，没动。
    // 勾掉、删掉、改字不算：主人在面板上收拾清单，不该把停着的它叫起来
    if (this.todoNudged !== undefined && !this.todoFresh && this.todoOpen().every((i) => this.todoNudged!.has(i.id))) return
    // 不在线（下线了、和游戏断着）：叫醒它也什么都做不了
    if (!this.workStopped() || this.shared.online === false) return
    // 对话线正在想：它可能马上就把事交过来（先记清单、再交事是常见的两步）。等它想完再看
    if (!this.talk.idle()) {
      this.armTodo()
      return
    }
    if (this.todoInRow >= TODO_NUDGE_MAX) {
      if (!this.todoCapLogged) {
        this.todoCapLogged = true
        this.deps.log.add({
          kind: 'error',
          text: `因为工作清单已经连着叫醒干活线 ${TODO_NUDGE_MAX} 次，中间没有人说话、游戏里也没有事发生（每次它都改了清单，却没有开任务、也没有提问）。为免空转，之后不再因为清单叫醒它，等外面有事再说。`,
        })
      }
      return
    }
    // 身体上排着的任务大脑不一定都盯着：问一次
    let tasks: TaskList
    try {
      tasks = await this.deps.bridge.taskList(this.deps.settings('work').botName)
    } catch {
      return
    }
    if (tasks.active || (tasks.queue ?? []).length > 0) return
    // 问的这一会儿可能来了事
    const open = this.todoOpen()
    if (this.closed || this.todoHalted || open.length === 0 || !this.workStopped()) return
    this.todoNudged = new Set(open.map((i) => i.id))
    this.todoFresh = false
    this.todoInRow++
    this.work.handleEvent({ type: 'todo', time: this.now(), open })
  }

  /** 两条线都没有在跑的一轮、也没有排着的事时兑现。测试用。 */
  async whenIdle(): Promise<void> {
    for (;;) {
      await Promise.all([this.talk.whenIdle(), this.work.whenIdle()])
      if (this.talk.idle() && this.work.idle()) return
    }
  }

  private outside(): void {
    this.volley = 0
    this.lastFrom = undefined
    this.todoInRow = 0
    this.todoCapLogged = false
  }

  /**
   * 一条线要给另一条线送话了：话头换了手就数一次。返回 true 表示已经连着倒了太多次，这一条只作背景送、不叫醒对方。
   * 同一条线连着发几条（干活线一轮里汇报了三次）不算换手。
   */
  private spinning(from: LineName): boolean {
    if (this.lastFrom !== from) {
      this.lastFrom = from
      this.volley++
      if (this.volley === VOLLEY_MAX + 1) {
        this.deps.log.add({
          kind: 'error',
          text: `两条线已经连着互相叫醒了 ${VOLLEY_MAX} 次，中间没有人说话、游戏里也没有事发生（没有任务或例程结束）。为免空转，之后它们之间的话照常送到，但只作背景、不再互相叫醒；有人说话或有任务结束后恢复。`,
        })
      }
    }
    return this.volley > VOLLEY_MAX
  }

  // ── 对话线 → 干活线 ──

  /** tell_worker：把一件事交给干活线，或者带一句话。当时的人的原话原样附上。 */
  private tell(text: string, said: SaidEvent[], saidBefore: boolean, at: TurnAt): string {
    const now = this.now()
    const ev: AgentEvent = { type: 'told', time: now, text, said, ...(saidBefore ? { saidBefore: true } : {}) }
    const spinning = this.spinning('talk')
    this.deps.log.add({
      kind: 'relay',
      agent: 'talk',
      ...at,
      text: `对话线 → 干活线${spinning ? '（只作背景，没有叫醒它）' : ''}：${firstLine(text, 120)}`,
      detail: describeEvent(ev),
      relay: { type: 'tell', from: 'talk', to: 'work', quotes: said.length },
    })
    const before = this.work.state()
    const beforePeek = this.work.peek()
    const waiting = this.links.waiting
    // 带的话到了：它不再是“在等回答”（是不是答了它的问题由它自己看）
    if (waiting) this.saveLinks({ ...this.links, waiting: undefined })
    this.work.handleEvent(ev, spinning ? { background: true } : {})
    if (spinning) return `Delivered, but it does not wake the worker. ${SPINNING}`
    const when = before.model.outage
      ? `The worker's model interface is failing (${before.model.outage.lastError}); it takes this up when the interface works again.`
      : before.turn
        ? `The worker is in the middle of turn ${before.turn.id} (${before.turn.steps} step(s) done); it sees this at its next step.`
        : beforePeek.trackedTasks.length > 0 || beforePeek.routine?.status === 'running'
          ? `The worker was not thinking (it is waiting for ${beforePeek.routine?.status === 'running' ? `its routine ${beforePeek.routine.id}` : `its task ${beforePeek.trackedTasks.join(', ')}`} to end) and takes this up now.`
          : 'The worker was idle and starts on it now.'
    const quotes =
      said.length > 0
        ? `Attached as they were said: ${said.length} line(s) from the people who woke you this turn, with where they stood and what they pointed at.`
        : saidBefore
          ? 'What was said to you this turn went with your earlier tell_worker; it was not attached again.'
          : 'Nothing was attached: no one spoke to you this turn.'
    return `Handed to the worker. ${when} ${quotes}${waiting ? ' It was waiting for an answer from you; this is what it gets.' : ''} ${SELF_WAKE} What it reports or asks, and what it leaves when it has stopped, come to you as events.`
  }

  /**
   * 让一切停下（对话线的 stop_work、面板上的总停止）：打断干活线正在想的那一步，放下它还没处理的事，停掉例程，取消身体的全部任务。
   * 不需要干活线配合。它随后在背景里看到一条“你被叫停了”（附原因和原话），不会因此自己接着干。
   */
  async stopWork(reason: string, by: 'talk' | 'panel', said: SaidEvent[] = [], at: TurnAt = {}): Promise<StopResult> {
    const botName = this.deps.settings('work').botName
    const note: Extract<AgentEvent, { type: 'halted' }> = { type: 'halted', time: this.now(), by, reason, said }
    const halt = this.work.halt(note)
    // 叫停了：不因为清单再把它叫起来，等有新的事交给它（存着，重启后照旧）
    this.saveLinks({ ...this.links, haltedAt: this.now() })
    if (this.todoTimer) clearTimeout(this.todoTimer)
    this.todoTimer = undefined
    const tasks: string[] = []
    let error: string | undefined
    const cancelAll = async (): Promise<void> => {
      const res = await this.work.ownCancel(() => this.deps.bridge.taskCancel(botName))
      for (const id of res.ids ?? []) if (!tasks.includes(id)) tasks.push(id)
    }
    try {
      // 例程停下时自己去取消它正等着的那个任务：等这次取消发完，再把剩下的全部取消
      await this.work.whenRoutineCanceled()
      await cancelAll()
      if (halt.routineTask !== undefined && !tasks.includes(halt.routineTask)) tasks.unshift(halt.routineTask)
    } catch (e) {
      error = e instanceof BridgeError ? `${e.code}: ${e.message}` : errorText(e)
    }
    // 被叫停的那一刻它正有一个工具在执行（比如“开始任务”的请求已经发出去了）：等它回来，再取消一遍，免得漏下刚开出来的任务
    if (halt.toolRunning && error === undefined) {
      let giveUp: NodeJS.Timeout | undefined
      await Promise.race([halt.settled, new Promise<void>((resolve) => (giveUp = setTimeout(resolve, HALT_SETTLE_MS)))])
      clearTimeout(giveUp)
      await cancelAll().catch(() => {})
    }
    if (this.links.waiting) this.saveLinks({ ...this.links, waiting: undefined })
    const result: StopResult = { ...(halt.turn ? { turn: halt.turn } : {}), ...(halt.routine !== undefined ? { routine: halt.routine } : {}), tasks, dropped: halt.dropped, ...(error !== undefined ? { error } : {}) }
    const what = [
      halt.turn ? `打断了干活线的第 ${halt.turn.id} 轮（第 ${halt.turn.step} 步）` : '干活线当时空闲',
      halt.routine !== undefined ? `停掉例程 ${halt.routine}` : undefined,
      error !== undefined ? `身体的任务没取消成（${error}）` : tasks.length > 0 ? `取消了 ${tasks.length} 个身体任务` : '身体没有在做的任务',
      halt.dropped > 0 ? `放下了 ${halt.dropped} 件它还没处理的事` : undefined,
    ].filter((part) => part !== undefined)
    this.deps.log.add({
      kind: 'relay',
      ...(by === 'talk' ? { agent: 'talk', ...at } : {}),
      text: `${by === 'panel' ? '面板' : '对话线'} → 干活线：停${reason ? `（${firstLine(reason, 80)}）` : ''}。${what.join('，')}。`,
      detail: describeEvent(note),
      relay: { type: 'stop', from: by, to: 'work', quotes: said.length },
      ...(error !== undefined ? { isError: true } : {}),
    })
    return result
  }

  /** stop_work 的结果写给对话线看。 */
  private stopText(res: StopResult): string {
    const parts = [
      res.turn ? `The worker was interrupted in turn ${res.turn.id} at step ${res.turn.step}; the tool calls it had not yet made were not made.` : 'The worker was idle (no turn was running).',
      res.routine !== undefined ? `Routine ${res.routine} was stopped.` : 'No routine was running.',
      res.error !== undefined
        ? `The body's tasks could NOT be canceled: ${res.error}. They may still be running.`
        : res.tasks.length > 0
          ? `${res.tasks.length} task(s) of the body were canceled (${res.tasks.join(', ')}); what they had already done stays done.`
          : 'The body had no running or queued task.',
      ...(res.dropped > 0 ? [`${res.dropped} event(s) the worker had not handled yet were set aside (it can still see them as background).`] : []),
      'The worker has been told it was stopped, with your reason and what was said to you this turn. It does nothing more until something new reaches it, such as a tell_worker.',
    ]
    return `${res.error !== undefined ? 'Stopped in part.' : 'Stopped.'} ${parts.join(' ')}`
  }

  // ── 干活线 → 对话线 ──

  /**
   * 干活线的汇报、提问、一轮结束留下的话、出了状况：记一条往来，交给对话线。
   * progress（它一轮结束留了话，但它开的任务或例程还在跑）只作背景，不叫醒对话线：那些任务结束时干活线自己会接着做，
   * 对话线为这句话醒一次只会以为它停在半路、回头来催。waiting 是它还在等什么。
   */
  private toTalk(kind: WorkerNote, text: string, at: TurnAt, waiting?: string): string {
    const now = this.now()
    const line = firstLine(text, 120)
    const progress = kind === 'progress'
    // 普通汇报和中途留的话一样只作背景：它们不等谁回话，对话线为它醒一次只会回一句“好，继续”
    const quiet = progress || kind === 'report'
    // 出了状况是程序替它报的（本来就限频）、只作背景的不叫醒谁：都不算两条线之间的你来我往
    const spinning = kind !== 'trouble' && !quiet && this.spinning('work')
    this.deps.log.add({
      kind: 'relay',
      agent: 'work',
      ...at,
      text: `干活线 → 对话线（${NOTE_WORD[kind]}${quiet || spinning ? '，只作背景，没有叫醒它' : ''}）：${line}`,
      ...(line !== text ? { detail: text } : {}),
      relay: { type: kind, from: 'work', to: 'talk', ...(progress && waiting !== undefined ? { waiting } : {}) },
      ...(kind === 'trouble' ? { isError: true } : {}),
    })
    this.saveLinks({ ...this.links, ...(kind === 'question' ? { waiting: { text, since: now } } : {}), lastReport: { type: kind, text, time: now } })
    this.talk.handleEvent({ type: 'worker', time: now, kind, text, ...(progress && waiting !== undefined ? { waiting } : {}) }, spinning ? { background: true } : {})
    if (spinning) return `Sent, but it does not wake the talk line. ${SPINNING}`
    if (kind === 'report') return 'Sent. It does not wake the talk line: it reads this the next time it is woken (someone speaks to it, you ask a question, you stop and leave a note). When you need an answer, send a question.'
    return kind === 'question'
      ? 'Sent to the talk line as a question. The answer comes back as a message from the talk line: at your next step if you are still working, or by waking you if your turn has ended. It can take a while when your owner has to be asked.'
      : 'Sent to the talk line.'
  }

  private saveLinks(next: LinkState): void {
    this.links = { ...(next.waiting ? { waiting: next.waiting } : {}), ...(next.lastReport ? { lastReport: next.lastReport } : {}), ...(next.haltedAt !== undefined ? { haltedAt: next.haltedAt } : {}) }
    try {
      this.deps.persist?.links?.save(this.links)
    } catch (e) {
      console.error('[lines] 保存两条线之间的状态失败：', e instanceof Error ? e.message : e)
    }
  }

  // ── 干活线现在在干什么 ──

  /**
   * 干活线开的、还没结束的任务现在各是什么样（一行一个）：在跑的带着进度和已经跑了多久，排队的写明还没开始。
   * 要问一次身体的任务列表；问不到时只有编号和类型。
   */
  private async ownTasks(peek: LinePeek, now: number): Promise<{ zh: string[]; en: string[] }> {
    if (peek.trackedTasks.length === 0) return { zh: [], en: [] }
    let list: TaskList | undefined
    try {
      list = await this.deps.bridge.taskList(this.deps.settings('work').botName)
    } catch {
      list = undefined
    }
    const zh: string[] = []
    const en: string[] = []
    for (const id of peek.trackedTasks) {
      const known = peek.taskTypes[id]
      const active = list?.active?.id === id ? list.active : undefined
      const queued = (list?.queue ?? []).find((t) => t.id === id)
      const type = active?.type ?? queued?.type ?? known
      const name = `${id}${type ? `（${type}）` : ''}`
      const nameEn = `${id}${type ? ` (${type})` : ''}`
      if (!list) {
        zh.push(`它开的任务 ${name}：还没结束（身体的任务列表现在读不到）。`)
        en.push(`its task ${nameEn}: not ended yet (the body's task list cannot be read right now)`)
      } else if (active) {
        const p = active.progress
        const done = p && typeof p.done === 'number' && typeof p.total === 'number' ? `${p.done}/${p.total}` : undefined
        const seconds = active.startedAt !== undefined ? Math.max(0, Math.round((now - active.startedAt) / 1000)) : undefined
        zh.push(`它开的任务 ${name}：在跑${done ? `，进度 ${done}` : ''}${p?.phase ? `（${p.phase}）` : ''}${seconds !== undefined ? `，已经跑了 ${seconds} 秒` : ''}。`)
        en.push(`its task ${nameEn}: running${done ? `, ${done}` : ''}${p?.phase ? ` (${p.phase})` : ''}${seconds !== undefined ? `, for ${seconds} s` : ''}`)
      } else if (queued) {
        zh.push(`它开的任务 ${name}：排着队，还没开始。`)
        en.push(`its task ${nameEn}: queued, not started yet`)
      } else {
        zh.push(`它开的任务 ${name}：还没看到结束，身体的任务列表里已经没有它（结束的消息多半马上就到）。`)
        en.push(`its task ${nameEn}: its end has not been seen yet, though the body no longer lists it (the event is probably about to arrive)`)
      }
    }
    return { zh, en }
  }

  /**
   * 对话线每一轮的“当前状态”里讲干活线的那几行：不用调工具就答得出“你在干嘛”，也不必去催——
   * 它在想、在等自己开的任务或例程（那些一结束它自己会被叫醒接着做）、还是真的停着，写得清清楚楚。
   */
  private async workerLine(now: number): Promise<string> {
    const peek = this.work.peek()
    const { state } = peek
    const routine = peek.routine?.status === 'running' ? peek.routine : undefined
    const own = (await this.ownTasks(peek, now)).zh
    const lines: string[] = []
    if (state.turn) {
      const doing = state.model.state === 'thinking' ? `正在想第 ${state.model.step ?? state.turn.steps + 1} 步` : `正在执行第 ${state.turn.steps} 步要的工具`
      lines.push(`干活线：在忙。第 ${state.turn.id} 轮（${ago(now, state.turn.startedAt)}开始，起因：${state.turn.about}），已经想完 ${state.turn.steps} 步，${doing}。`)
    } else if (state.model.outage) {
      lines.push(`干活线：模型接口故障（连着失败 ${state.model.outage.failures} 次：${firstLine(state.model.outage.lastError, 160)}），${state.pending > 0 ? `有 ${state.pending} 件事等着，` : ''}过一会儿自动再试。`)
    } else if (own.length > 0 || routine) {
      // 它没有在想，但它的事没完：在等自己开的任务或例程。那些一结束它自己会被叫醒，这是事实，写给对话线看
      lines.push(`干活线：还在干，这会儿没有在想——在等它自己开的${own.length > 0 ? '任务' : '例程'}结束。${own.length > 0 ? '任务' : '例程'}一结束（做完、失败或被取消）它自己会被叫醒接着做，不需要提醒。${state.pending > 0 ? `有 ${state.pending} 件事刚到，它马上开始想。` : ''}`)
    } else {
      const last = peek.lastTurn
      const how = last ? `上一轮（第 ${last.id} 轮）${ago(now, last.endedAt)}${last.how === 'halted' ? '被叫停' : last.how === 'limit' ? '到步数上限被截断' : last.how === 'failed' ? '因为模型接口出错中断' : '结束'}` : '大脑启动以后它还没有做过事'
      lines.push(`干活线：空闲，没有在想（${how}）；身体上没有它开的任务，也没有例程在跑。${state.pending > 0 ? `有 ${state.pending} 件事刚到，马上开始。` : ''}`)
    }
    if (state.turn && state.pending > 0) lines.push(`  还有 ${state.pending} 件新到的事它下一步会看到。`)
    for (const line of own) lines.push(`  ${line}`)
    if (routine) {
      lines.push(`  例程 ${routine.id}（${routine.name}）在后台跑：已调 ${routine.calls} 次工具，开了 ${routine.actions} 个任务，${ago(now, routine.startedAt)}开始。`)
    }
    if (this.links.waiting) lines.push(`  它在等你回答（${ago(now, this.links.waiting.since)}问的）：${shown(this.links.waiting.text, 300)}`)
    const report = this.links.lastReport
    if (report && !(this.links.waiting && report.type === 'question')) lines.push(`  它最近一次送来的（${NOTE_WORD[report.type]}，${ago(now, report.time)}）：${shown(report.text, 200)}`)
    // 对话线派出去的子思维：在想的那几个（没有就不写）
    const helpers = this.helpers.stateLines(now)
    if (helpers.length > 0) lines.push(helpers)
    return lines.join('\n')
  }

  /** worker_status：干活线现在在干什么，细到最近几步、身体的任务、例程。 */
  private async workerStatus(detail: boolean): Promise<string> {
    const now = this.now()
    const peek: LinePeek = this.work.peek()
    const { state } = peek
    const out: string[] = []
    if (state.turn) {
      const doing = state.model.state === 'thinking' ? `thinking about step ${state.model.step ?? state.turn.steps + 1}${state.model.since !== undefined ? ` for ${Math.round((now - state.model.since) / 1000)} s` : ''}` : `running the tools of step ${state.turn.steps}`
      out.push(`Worker: busy. Turn ${state.turn.id}, started ${agoEn(now, state.turn.startedAt)}; ${state.turn.steps} of at most ${state.turn.maxSteps} steps done, now ${doing}.`, `What started the turn: ${state.turn.about}`)
      if (peek.steps.length > 0) {
        out.push(`Its last ${peek.steps.length} tool call(s) this turn${detail ? '' : ' (first line of each result; detail: true gives more)'}:`)
        for (const s of peek.steps) out.push(`- step ${s.step}: ${s.tool} ${s.input} → ${s.isError ? 'FAILED: ' : ''}${detail ? s.result : firstLine(s.result, 160)}`)
      }
    } else {
      const last = peek.lastTurn
      const ended = last ? ` Its last turn (${last.id}) ${last.how === 'halted' ? 'was stopped' : last.how === 'limit' ? 'was cut at the step limit' : last.how === 'failed' ? 'broke off on a model interface error' : 'ended'} ${agoEn(now, last.endedAt)} after ${last.steps} step(s).` : ' It has not done anything since the brain started.'
      const going = peek.trackedTasks.length > 0 || peek.routine?.status === 'running'
      out.push(going ? `Worker: still at work, not thinking right now: it is waiting for ${peek.trackedTasks.length > 0 ? 'the task(s)' : 'the routine'} it started to end.${ended} ${SELF_WAKE}` : `Worker: idle, not thinking; no task of its own is on the body and no routine is running.${ended}`)
    }
    const own = (await this.ownTasks(peek, now)).en
    if (own.length > 0) out.push(`Started by the worker and not ended yet:\n${own.map((line) => `- ${line}`).join('\n')}`)
    if (state.model.outage) out.push(`Its model interface is failing (${state.model.outage.failures} failure(s) in a row, last: ${state.model.outage.lastError}); the next try is in ${Math.max(0, Math.round((state.model.outage.nextRetryAt - now) / 1000))} s.`)
    if (state.pending > 0) out.push(`${state.pending} event(s) are waiting for it${state.turn ? ' (it sees them at its next step)' : ''}.`)
    try {
      const list = await this.deps.bridge.taskList(this.deps.settings('work').botName)
      const queue = list.queue ?? []
      out.push(list.active ? `Body: on task ${formatTask(list.active, { params: detail })}.` : 'Body: no task running.')
      if (queue.length > 0) out.push(`Queued: ${queue.map((t) => `${t.id} ${t.type}`).join(', ')}.`)
    } catch (e) {
      out.push(`Body: the task list could not be read (${e instanceof BridgeError ? `${e.code}: ${e.message}` : errorText(e)}).`)
    }
    const routine = peek.routine
    if (routine) {
      if (detail || routine.status === 'running') out.push(detail ? describeRoutine(routine, now) : (describeRoutine(routine, now).split('\n').slice(0, 2).join('\n')))
      else out.push(`Routine: none running (the last one, ${routine.id} "${routine.name}", ${routine.status === 'done' ? 'finished' : 'stopped'} ${agoEn(now, routine.endedAt ?? routine.startedAt)}).`)
    } else {
      out.push('Routine: none.')
    }
    if (this.links.waiting) out.push(`It is waiting for your answer (asked ${agoEn(now, this.links.waiting.since)}): ${clip(this.links.waiting.text, detail ? 2000 : 400)}`)
    const report = this.links.lastReport
    if (report) out.push(`The last thing it sent you (${report.type}, ${agoEn(now, report.time)}): ${clip(report.text, detail ? 2000 : 400)}`)
    return out.join('\n')
  }
}

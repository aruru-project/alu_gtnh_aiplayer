// 一个玩家，两条线（docs/TALK_WORK.md）：对话线（talk）和干活线（work）是同一个进程里的两个 Agent，各有模型、历史、
// 事件队列和步数上限，互不等待。这里做三件事：
//   1. 分事件：谁说了话、面板指令、提醒 → 对话线；任务、例程、身体的事 → 干活线；死亡、上线下线两条线都知道
//      （干活线去处理，对话线得一份简报）。
//   2. 接上两条线之间的往来：对话线交事和带话（当时的人的原话原样附上）、看干活线在干什么、让一切停下；
//      干活线汇报、提问、一轮结束留下的话。每次往来在活动日志里是一条 kind: relay。
//   3. 对外（main、面板）像原来那一个 agent：收 bridge 事件、握手后对账、状态、停。
// 共用的东西只有一份：身体（bridge）、记忆、手册、意见簿、设计工作区、每日 token 上限（两条线合计）。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { BridgeEvent } from '../bridge/protocol.ts'
import type { DesignWorkspace } from '../design/index.ts'
import type { LlmClient } from '../llm/index.ts'
import type { PackData } from '../packdata/index.ts'
import type { ActivityLog } from '../store/activity-log.ts'
import type { ChatLog } from '../store/chat-log.ts'
import type { FeedbackStore } from '../store/feedback.ts'
import type { HistoryStore } from '../store/history.ts'
import { clip, formatTask } from '../tools/format.ts'
import { LINE_TOOLS } from '../tools/index.ts'
import type { LineName, ManualAccess, MemoryAccess, ReminderAccess } from '../tools/index.ts'
import { Agent, newLineShared } from './agent.ts'
import type { AgentSettings, AgentState, AgentStatus, AgentTiming, LinePeek, LineShared, PersistedAgentState, TurnAt } from './agent.ts'
import type { PendingReminder } from './context.ts'
import { describeEvent, fromBridgeEvent } from './events.ts'
import type { AgentEvent, SaidEvent, WorkerNote } from './events.ts'
import { describeRoutine } from './routine.ts'
import type { RoutineLimits } from './routine.ts'
import type { RunLogStore } from './run-log.ts'

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
}

export interface LinesDeps {
  /** 每条线的设置：名字、主人这些是一样的，步数上限和历史压缩阈值各是各的。 */
  settings(line: LineName): AgentSettings
  models: Record<LineName, LineModel>
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
const NOTE_WORD: Record<WorkerNote, string> = { report: '汇报', question: '提问', result: '做完留下的话', trouble: '出了状况' }
const MIGRATION_NOTE =
  '大脑升级过：从现在起“跟人说话”和“操作身体干活”分成了两条线，你是干活线。这之前的历史是升级前留下的，那时只有一条线，所以里面有你用 say、whisper 直接对玩家说话的记录。现在对玩家说话的是对话线：你要让人知道的事用 report，或者留在一轮结束时的文字里。'

/**
 * 这件事该到哪条线。both：两条线都要知道的身体大事——干活线去处理，对话线得一份简报。
 */
export function lineOf(ev: AgentEvent): LineName | 'both' {
  switch (ev.type) {
    case 'chat':
    case 'whisper':
    case 'panel_command':
    case 'reminder':
    case 'player_join':
    case 'player_leave':
    case 'worker':
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
      return 'work'
  }
}

function firstLine(text: string, max = 120): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
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
  private readonly deps: LinesDeps
  private readonly shared: LineShared = newLineShared()
  private links: LinkState = {}

  constructor(deps: LinesDeps) {
    this.deps = deps
    this.links = { ...(deps.persist?.links?.load() ?? {}) }
    const common = {
      shared: this.shared,
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
    this.work = new Agent({
      ...common,
      ...model('work'),
      ...persist('work'),
      line: 'work',
      settings: () => deps.settings('work'),
      tools: LINE_TOOLS.work,
      history: deps.histories.work,
      links: { toTalk: (kind, text, at) => this.toTalk(kind, text, at) },
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
      },
    })
    // 老数据：只有一条线的时候，“有人说话”“提醒到点”也排在那一个队列里。现在这些归对话线。
    this.talk.adoptPending(this.work.takePending((ev) => lineOf(ev) === 'talk'))
    if (deps.migrated) this.work.handleEvent({ type: 'notice', time: this.now(), wake: false, text: MIGRATION_NOTE }, { logged: true })
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ── 对外 ──

  /** 开始工作。两条线各自接上重启前没处理完的事。 */
  start(): void {
    this.talk.start()
    this.work.start()
  }

  /** 停下：两条线各自打断正在进行的一轮并收尾；没处理完的事已经落盘，下次启动各自接着来。 */
  async stop(): Promise<void> {
    await Promise.all([this.talk.stop(), this.work.stop()])
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
    const to = lineOf(ev)
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

  /** 两条线都没有在跑的一轮、也没有排着的事时兑现。测试用。 */
  async whenIdle(): Promise<void> {
    for (;;) {
      await Promise.all([this.talk.whenIdle(), this.work.whenIdle()])
      if (this.talk.idle() && this.work.idle()) return
    }
  }

  // ── 对话线 → 干活线 ──

  /** tell_worker：把一件事交给干活线，或者带一句话。当时的人的原话原样附上。 */
  private tell(text: string, said: SaidEvent[], saidBefore: boolean, at: TurnAt): string {
    const now = this.now()
    const ev: AgentEvent = { type: 'told', time: now, text, said, ...(saidBefore ? { saidBefore: true } : {}) }
    this.deps.log.add({
      kind: 'relay',
      agent: 'talk',
      ...at,
      text: `对话线 → 干活线：${firstLine(text)}`,
      detail: describeEvent(ev),
      relay: { type: 'tell', from: 'talk', to: 'work', quotes: said.length },
    })
    const before = this.work.state()
    const waiting = this.links.waiting
    // 带的话到了：它不再是“在等回答”（是不是答了它的问题由它自己看）
    if (waiting) this.saveLinks({ ...this.links, waiting: undefined })
    this.work.handleEvent(ev)
    const when = before.model.outage
      ? `The worker's model interface is failing (${before.model.outage.lastError}); it takes this up when the interface works again.`
      : before.turn
        ? `The worker is in the middle of turn ${before.turn.id} (${before.turn.steps} step(s) done); it sees this at its next step.`
        : 'The worker was idle and starts on it now.'
    const quotes =
      said.length > 0
        ? `Attached as they were said: ${said.length} line(s) from the people who woke you this turn, with where they stood and what they pointed at.`
        : saidBefore
          ? 'What was said to you this turn went with your earlier tell_worker; it was not attached again.'
          : 'Nothing was attached: no one spoke to you this turn.'
    return `Handed to the worker. ${when} ${quotes}${waiting ? ' It was waiting for an answer from you; this is what it gets.' : ''} What it reports, asks or leaves at the end of its turn comes to you as an event.`
  }

  /**
   * 让一切停下（对话线的 stop_work、面板上的总停止）：打断干活线正在想的那一步，放下它还没处理的事，停掉例程，取消身体的全部任务。
   * 不需要干活线配合。它随后在背景里看到一条“你被叫停了”（附原因和原话），不会因此自己接着干。
   */
  async stopWork(reason: string, by: 'talk' | 'panel', said: SaidEvent[] = [], at: TurnAt = {}): Promise<StopResult> {
    const botName = this.deps.settings('work').botName
    const note: Extract<AgentEvent, { type: 'halted' }> = { type: 'halted', time: this.now(), by, reason, said }
    const halt = this.work.halt(note)
    const tasks: string[] = []
    let error: string | undefined
    const cancelAll = async (): Promise<void> => {
      const res = await this.work.ownCancel(() => this.deps.bridge.taskCancel(botName))
      for (const id of res.ids ?? []) if (!tasks.includes(id)) tasks.push(id)
    }
    try {
      await cancelAll()
    } catch (e) {
      error = e instanceof BridgeError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)
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

  /** 干活线的汇报、提问、一轮结束留下的话、出了状况：记一条往来，交给对话线。 */
  private toTalk(kind: WorkerNote, text: string, at: TurnAt): string {
    const now = this.now()
    const line = firstLine(text)
    this.deps.log.add({
      kind: 'relay',
      agent: 'work',
      ...at,
      text: `干活线 → 对话线（${NOTE_WORD[kind]}）：${line}`,
      ...(line !== text ? { detail: text } : {}),
      relay: { type: kind, from: 'work', to: 'talk' },
      ...(kind === 'trouble' ? { isError: true } : {}),
    })
    this.saveLinks({ ...(kind === 'question' ? { waiting: { text, since: now } } : this.links.waiting ? { waiting: this.links.waiting } : {}), lastReport: { type: kind, text, time: now } })
    this.talk.handleEvent({ type: 'worker', time: now, kind, text })
    return kind === 'question'
      ? 'Sent to the talk line as a question. The answer comes back as a message from the talk line: at your next step if you are still working, or by waking you if your turn has ended. It can take a while when your owner has to be asked.'
      : 'Sent to the talk line.'
  }

  private saveLinks(next: LinkState): void {
    this.links = { ...(next.waiting ? { waiting: next.waiting } : {}), ...(next.lastReport ? { lastReport: next.lastReport } : {}) }
    try {
      this.deps.persist?.links?.save(this.links)
    } catch (e) {
      console.error('[lines] 保存两条线之间的状态失败：', e instanceof Error ? e.message : e)
    }
  }

  // ── 干活线现在在干什么 ──

  /** 对话线每一轮的“当前状态”里讲干活线的那几行：不用调工具就答得出“你在干嘛”。 */
  private workerLine(now: number): string {
    const peek = this.work.peek()
    const { state } = peek
    const lines: string[] = []
    if (state.turn) {
      const doing = state.model.state === 'thinking' ? `正在想第 ${state.model.step ?? state.turn.steps + 1} 步` : `正在执行第 ${state.turn.steps} 步要的工具`
      lines.push(`干活线：在忙。第 ${state.turn.id} 轮（${ago(now, state.turn.startedAt)}开始，起因：${state.turn.about}），已经想完 ${state.turn.steps} 步，${doing}。`)
    } else if (state.model.outage) {
      lines.push(`干活线：模型接口故障（连着失败 ${state.model.outage.failures} 次：${firstLine(state.model.outage.lastError, 160)}），${state.pending > 0 ? `有 ${state.pending} 件事等着，` : ''}过一会儿自动再试。`)
    } else {
      const last = peek.lastTurn
      const how = last ? `上一轮（第 ${last.id} 轮）${ago(now, last.endedAt)}${last.how === 'halted' ? '被叫停' : last.how === 'limit' ? '到步数上限被截断' : last.how === 'failed' ? '因为模型接口出错中断' : '结束'}` : '大脑启动以后它还没有做过事'
      lines.push(`干活线：空闲，没有在想（${how}）。${state.pending > 0 ? `有 ${state.pending} 件事刚到，马上开始。` : ''}`)
    }
    if (state.turn && state.pending > 0) lines.push(`  还有 ${state.pending} 件新到的事它下一步会看到。`)
    const routine = peek.routine
    if (routine?.status === 'running') {
      lines.push(`  例程 ${routine.id}（${routine.name}）在后台跑：已调 ${routine.calls} 次工具，开了 ${routine.actions} 个任务，${ago(now, routine.startedAt)}开始。`)
    }
    if (this.links.waiting) lines.push(`  它在等你回答（${ago(now, this.links.waiting.since)}问的）：${shown(this.links.waiting.text, 300)}`)
    const report = this.links.lastReport
    if (report && !(this.links.waiting && report.type === 'question')) lines.push(`  它最近一次送来的（${NOTE_WORD[report.type]}，${ago(now, report.time)}）：${shown(report.text, 200)}`)
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
      out.push(
        `Worker: idle, not thinking.${last ? ` Its last turn (${last.id}) ${last.how === 'halted' ? 'was stopped' : last.how === 'limit' ? 'was cut at the step limit' : last.how === 'failed' ? 'broke off on a model interface error' : 'ended'} ${agoEn(now, last.endedAt)} after ${last.steps} step(s).` : ' It has not done anything since the brain started.'}`,
      )
    }
    if (state.model.outage) out.push(`Its model interface is failing (${state.model.outage.failures} failure(s) in a row, last: ${state.model.outage.lastError}); the next try is in ${Math.max(0, Math.round((state.model.outage.nextRetryAt - now) / 1000))} s.`)
    if (state.pending > 0) out.push(`${state.pending} event(s) are waiting for it${state.turn ? ' (it sees them at its next step)' : ''}.`)
    try {
      const list = await this.deps.bridge.taskList(this.deps.settings('work').botName)
      const queue = list.queue ?? []
      out.push(list.active ? `Body: on task ${formatTask(list.active, { params: detail })}.` : 'Body: no task running.')
      if (queue.length > 0) out.push(`Queued: ${queue.map((t) => `${t.id} ${t.type}`).join(', ')}.`)
    } catch (e) {
      out.push(`Body: the task list could not be read (${e instanceof BridgeError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e)}).`)
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

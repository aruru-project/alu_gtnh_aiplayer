// 例程：模型写的程序在后台跑，程序里可以一个个调工具（查询的直接拿结果，会开任务的等任务做完再往下走）。
// 模型启动它以后这一轮就可以结束；例程做完、出错、被停掉或者碰到上限时，再把模型叫醒，带上它的日志。
//
// 例程里调的每个工具和模型自己调走的是同一条路（runTool）：同样的校验。每一步记进这次运行自己的记录（run-log.ts），
// 面板的对话日志里是一条滚动更新的汇总加上出错的那几步。
// 程序本身照旧跑在沙箱里（script/sandbox.ts），碰不到文件和网络，只多了“调工具”这一个口子。
// 管着它的：总时长（默认和最长由主人在面板上定）、连续失败的次数、程序自己的计算时间、每秒最多调几次工具（超了自动等，
// 不报错）；随时可停。调多少次工具、开多少个任务不设上限：一口气搬一万多个东西的活就该让它一口气做完。同一时间只跑一个。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { TaskInfo } from '../bridge/protocol.ts'
import type { DesignWorkspace, ProgramRun } from '../design/index.ts'
import type { ProgramCall, ProgramCallResult } from '../script/sandbox.ts'
import type { ActivityLog } from '../store/activity-log.ts'
import { clip, compactJson, dataWithLocalNames, formatTask } from '../tools/format.ts'
import type { ActivityRun } from '../store/activity-log.ts'
import { RunRecorder } from './run-log.ts'
import type { RunLogStore } from './run-log.ts'
import { DEFAULT_RESULT_MAX_CHARS, runTool } from '../tools/index.ts'
import type { Tool, ToolContext, ToolResult } from '../tools/index.ts'

export interface RoutineLimits {
  /** 没说跑多久时，从开始到结束最多多久（等任务的时间算在内）。 */
  wallMs: number
  /** 它自己要求的时长最多给到多久。 */
  maxWallMs: number
  /** 连着失败这么多次就停。 */
  failuresInARow: number
  /** 程序自己最多算多久（等工具结果的时间不算）。 */
  computeMs: number
  /** 每秒最多调几次工具：超了就自动等一下再调，不算错。免得一个不停的循环把游戏服务器打爆。 */
  callsPerSecond: number
}

/** 时长的两个数是没人配置时用的；平时由主人在面板的设置里定（agent 每次启动例程时现问）。 */
export const DEFAULT_ROUTINE_LIMITS: RoutineLimits = { wallMs: 120 * 60_000, maxWallMs: 12 * 60 * 60_000, failuresInARow: 3, computeMs: 20_000, callsPerSecond: 20 }
/** 例程里不能调的工具：不能自己再跑程序、再开例程。 */
export const ROUTINE_BLOCKED_TOOLS: readonly string[] = ['run_program', 'start_routine', 'stop_routine', 'routine_status']
const CALLS_KEPT = 12
const LOGS_KEPT = 40
const LOG_LINE_CHARS = 300
/** 等任务结束时隔这么久自己去问一次：万一任务结束的事件丢了（断线重连）。 */
const TASK_POLL_MS = 5000

export type RoutineStatus = 'running' | 'done' | 'failed' | 'stopped' | 'limit'

export interface RoutineCall {
  n: number
  tool: string
  /** 参数，截短了的。 */
  input: string
  ok: boolean
  /** 结果的第一行，截短了的。 */
  result: string
  ms: number
  taskId?: string
}

/** 一个任务开始或结束了（agent 的事件里的那两种）。 */
export interface RoutineTaskEvent {
  type: 'task_started' | 'task_ended'
  time: number
  task: TaskInfo
}

/** 例程现在（或者结束时）的样子：给 routine_status、面板和叫醒模型的那条消息用。 */
export interface RoutineView {
  id: string
  name: string
  status: RoutineStatus
  startedAt: number
  endedAt?: number
  /** 调了多少次工具，其中开了多少个任务。 */
  calls: number
  actions: number
  /** 正等着的那一步。 */
  current?: { tool: string; input: string; since: number; taskId?: string }
  /** 最近的几次调用。 */
  recent: RoutineCall[]
  /** 程序 log 出来的最近几行。 */
  logs: string[]
  /** 更早的日志行有多少条没留下（只留最近 LOGS_KEPT 行）。 */
  logsDropped?: number
  /** 程序的日志满了（一共只留这么多字符）：这以后 log 的都没留下，上面那几行不是最新的。数字是那个上限。 */
  logFull?: number
  /** 日志满了以后没留下（或者只留下开头）的有多少条；例程结束时才知道。 */
  logLost?: number
  /** 为什么结束（英文，给模型看）。 */
  ending?: string
  /** 为什么结束（中文，给主人看：活动日志和面板用）。 */
  endingText?: string
  /** 程序 return 的值（太长时只有开头，见 valueLength）。 */
  value?: string
  /** 程序 return 的值原来多长；只在它比 value 长（被截了）时有。 */
  valueLength?: number
  /** 它存下的图纸草稿。 */
  drafts?: string[]
  /** 这一次最多能跑多久（毫秒）。 */
  limitMs?: number
  /** 这次运行的结构化快照（面板用）：调了多少次、开了多少任务、出错多少次、全量记录在哪个文件。 */
  run?: ActivityRun
}

export interface RoutineDeps {
  design: DesignWorkspace
  bridge: BridgeApi
  botName(): string
  tools: readonly Tool[]
  /** 调工具用的上下文：和模型调工具用的是同一个，只是开了任务时多告诉这边一声。 */
  context(onTaskStarted: (task: TaskInfo) => void): ToolContext
  log: Pick<ActivityLog, 'add' | 'update'>
  now(): number
  /** 例程结束了。 */
  ended(view: RoutineView): void
  /** 停例程时取消它正在做的任务（经 agent，这样这次取消不会再把模型叫醒一遍）。 */
  cancelTask(id: string): Promise<void>
  /** 扣下的任务事件送回 agent 的事件入口（这时谁开的任务已经清楚了）。 */
  redeliver(ev: RoutineTaskEvent): void
  /** 各项上限。给函数的话每次启动例程时现问（主人在面板上改了时长，下一个例程就照新的来）。 */
  limits?: Partial<RoutineLimits> | (() => Partial<RoutineLimits>)
  /** 每次运行的全量记录落在哪；不给就不落盘。 */
  runs?: RunLogStore
  /** “单个工具结果上限”现在是多少：一个工具结果最多给程序这么多字符的文字（data 不受限制），程序 return 的值也照它截。 */
  maxResultChars?(): number
}

interface Running {
  view: RoutineView
  abort: AbortController
  limits: RoutineLimits
  failures: number
  timer: NodeJS.Timeout
  /** 例程开的、还没结束的任务：任务 id → 等它的那个 promise 的 resolve。 */
  waiters: Map<string, (task: TaskInfo) => void>
  owned: Set<string>
  /** 先于“开始等”就到了的任务结束。 */
  finished: Map<string, TaskInfo>
  /** 正在执行的工具调用有几个（还没回来）。 */
  calling: number
  /** 工具调用还没回来时到的、还不知道是谁开的任务的事件，见 hold。 */
  held: RoutineTaskEvent[]
  ended: boolean
  /** 这次运行的记录员：全量写文件，对话日志里一条汇总。 */
  record: RunRecorder
  /** 最近几次调用开始的时刻（毫秒，单调时钟）：限速用。 */
  stamps: number[]
}

export class RoutineRunner {
  private readonly deps: RoutineDeps
  private running: Running | undefined
  private last: RoutineView | undefined
  private seq = 1
  /** 停下时发出去的那次“取消任务”（成没成都算完）。 */
  private canceling: Promise<void> = Promise.resolve()

  constructor(deps: RoutineDeps) {
    this.deps = deps
  }

  /** 正在跑的例程；没有时是上一个跑完的（没有跑过就是 undefined）。 */
  view(): RoutineView | undefined {
    const view = this.running?.view ?? this.last
    if (!view) return undefined
    const run = this.running ? this.running.record.view() : view.run
    return { ...view, recent: [...view.recent], logs: [...view.logs], ...(run ? { run } : {}) }
  }

  isRunning(): boolean {
    return this.running !== undefined
  }

  /** 这个任务是不是正在跑的例程开的（是的话，它结束时不用叫醒模型）。 */
  owns(taskId: string): boolean {
    return this.running?.owned.has(taskId) === true
  }

  /**
   * 例程正调着一个工具的那一小会儿，来了一个谁也不认识的任务的事件：多半就是这次调用开的任务，
   * 只是“开了”的回话还没处理到（任务一开就结束、或者这边忙了一下，回话和事件会一起到）。
   * 这里先扣下并返回 true；等调用回来（这时已经知道哪个任务是它开的）再原样送回 agent（deps.redeliver）：
   * 是例程开的，agent 会转给 taskEnded；不是的照平常的办法处理。
   */
  hold(ev: RoutineTaskEvent): boolean {
    const run = this.running
    if (!run || run.calling === 0) return false
    run.held.push(ev)
    return true
  }

  /** 把扣下的事件送回 agent。 */
  private release(run: Running): void {
    for (const ev of run.held.splice(0)) this.deps.redeliver(ev)
  }

  /** agent 转过来的：例程开的一个任务结束了。 */
  taskEnded(task: TaskInfo): void {
    const run = this.running
    if (!run || !run.owned.has(task.id)) return
    const waiter = run.waiters.get(task.id)
    if (waiter) waiter(task)
    else run.finished.set(task.id, task)
  }

  /**
   * 启动一个例程。已经有一个在跑时返回 error。启动以后立刻返回；程序在后台跑。
   */
  start(code: string, opts: { name?: string; minutes?: number } = {}): { view: RoutineView; minutes: number; asked?: number } | { error: string } {
    if (this.running) return { error: `routine ${this.running.view.id} ("${this.running.view.name}") is still running: wait for it, or stop it with stop_routine` }
    const given = typeof this.deps.limits === 'function' ? this.deps.limits() : (this.deps.limits ?? {})
    const limits: RoutineLimits = { ...DEFAULT_ROUTINE_LIMITS, ...given }
    // 它要多久就给多久，到主人设的最长为止
    if (opts.minutes !== undefined) limits.wallMs = Math.min(limits.maxWallMs, Math.max(1, opts.minutes) * 60_000)
    const id = `r${this.seq++}`
    const view: RoutineView = { id, name: (opts.name ?? '').trim().slice(0, 60) || id, status: 'running', startedAt: this.deps.now(), calls: 0, actions: 0, recent: [], logs: [], limitMs: limits.wallMs }
    const run: Running = {
      view,
      abort: new AbortController(),
      limits,
      failures: 0,
      timer: setTimeout(() => this.finish(run, 'limit', `it ran for ${Math.round(limits.wallMs / 60_000)} minutes, the time it was given`, `跑满了给它的 ${Math.round(limits.wallMs / 60_000)} 分钟`), limits.wallMs),
      waiters: new Map(),
      owned: new Set(),
      finished: new Map(),
      calling: 0,
      held: [],
      ended: false,
      record: new RunRecorder({ log: this.deps.log, now: () => this.deps.now(), ...(this.deps.runs ? { store: this.deps.runs } : {}) }, { id, kind: 'routine', name: view.name, code }),
      stamps: [],
    }
    this.running = run
    view.run = run.record.view()
    this.deps.log.add({ kind: 'info', text: `例程 ${id}（${view.name}）开始在后台跑。`, detail: code, source: 'routine', runId: id, run: view.run })
    void this.deps.design
      .run(code, {
        timeoutMs: limits.computeMs,
        background: true,
        hooks: {
          signal: run.abort.signal,
          onCall: (call) => this.call(run, call),
          onLog: (text) => {
            run.record.logLine(text)
            view.logs.push(clip(text, LOG_LINE_CHARS))
            if (view.logs.length > LOGS_KEPT) {
              view.logsDropped = (view.logsDropped ?? 0) + view.logs.length - LOGS_KEPT
              view.logs.splice(0, view.logs.length - LOGS_KEPT)
            }
          },
          onLogFull: () => {
            view.logFull = this.deps.design.logChars
          },
        },
        valueChars: this.resultMax(),
      })
      .then(
        (result) => this.programEnded(run, result),
        (e: unknown) => this.finish(run, 'failed', `the program could not be run: ${e instanceof Error ? e.message : String(e)}`, `程序没能跑起来：${e instanceof Error ? e.message : String(e)}`),
      )
    const minutes = Math.round(limits.wallMs / 60_000)
    return { view: this.view()!, minutes, ...(opts.minutes !== undefined && opts.minutes > minutes ? { asked: opts.minutes } : {}) }
  }

  /** 例程停下时要取消的那个任务已经取消完了（或者没取消成）。大脑退出前等它一下，免得请求还没发出去连接就断了。 */
  whenCanceled(): Promise<void> {
    return this.canceling
  }

  /** 停掉正在跑的例程（模型或主人要求的）。reason 给模型看（英文），said 给主人看（中文）。没有在跑的返回 false。 */
  stop(reason: string, said: string): boolean {
    const run = this.running
    if (!run) return false
    this.finish(run, 'stopped', reason, said)
    return true
  }

  private resultMax(): number {
    return this.deps.maxResultChars?.() ?? DEFAULT_RESULT_MAX_CHARS
  }

  // ── 程序调工具 ──

  private async call(run: Running, call: ProgramCall): Promise<ProgramCallResult> {
    const { view, limits } = run
    if (run.ended) return { ok: false, text: 'the routine has been stopped' }
    // 限速：这一秒里已经调够了就等到下一次能调的时候（不算错，程序只是觉得这一步慢了一点）
    await this.pace(run)
    if (run.ended) return { ok: false, text: 'the routine has been stopped' }
    const n = ++view.calls
    const input = compactJson(call.input, 200)
    const since = this.deps.now()
    view.current = { tool: call.name, input, since }
    run.record.waiting(call.name, call.input)

    let started: TaskInfo | undefined
    const ctx = this.deps.context((task) => {
      started = task
      run.owned.add(task.id)
    })
    // 例程里不能再跑程序、再开例程；别的工具和模型自己调走同一条路
    let res: ToolResult
    run.calling++
    try {
      res = ROUTINE_BLOCKED_TOOLS.includes(call.name)
        ? { content: `${call.name} cannot be called from inside a routine`, isError: true }
        : await runTool(this.deps.tools, ctx, call.name, call.input, { maxResultChars: this.resultMax() })
    } finally {
      run.calling--
    }
    // 调用期间扣下的任务事件：这时已经知道哪个任务是它开的了
    if (run.calling === 0) this.release(run)
    let result: ProgramCallResult = { ok: res.isError !== true, text: res.content, ...('data' in res && res.data !== undefined ? { data: res.data } : {}) }
    let taskId: string | undefined
    const task = started as TaskInfo | undefined
    if (task && res.isError !== true) {
      // 开了一个任务：等它做完，把任务的结局当成这次调用的结果
      taskId = task.id
      view.actions++
      view.current.taskId = task.id
      const final = task.state === 'done' || task.state === 'failed' || task.state === 'canceled' ? task : await this.waitForTask(run, task.id)
      run.owned.delete(task.id)
      if (final) {
        result = { ok: final.state === 'done', text: formatTask(final), data: dataWithLocalNames({ task: final.id, state: final.state, ...(final.result ? { result: final.result } : {}), ...(final.error ? { error: final.error } : {}) }) }
        // 任务被别人取消了（主人在面板上、模型另开了任务）：这是叫例程停下
        if (final.state === 'canceled' && !run.ended) this.finish(run, 'stopped', `its task ${final.id} (${final.type}) was canceled by someone else`, `它开的任务 ${final.id}（${final.type}）被别人取消了`)
      } else {
        result = { ok: false, text: 'the routine was stopped while this task was running' }
      }
    }
    const line = result.text.split('\n')[0] ?? ''
    // 每一步的全量进这次运行的记录；对话日志里只有汇总和出错的
    run.record.call({ n, tool: call.name, input: call.input, ok: result.ok, text: result.text, ms: this.deps.now() - since, ...(taskId ? { task: taskId } : {}) })
    view.recent.push({ n, tool: call.name, input, ok: result.ok, result: clip(line, 200), ms: this.deps.now() - since, ...(taskId ? { taskId } : {}) })
    if (view.recent.length > CALLS_KEPT) view.recent.shift()
    delete view.current
    run.failures = result.ok ? 0 : run.failures + 1
    if (run.failures >= limits.failuresInARow && !run.ended) this.finish(run, 'limit', `${run.failures} tool calls failed in a row; the last: ${clip(line, 200)}`, `连着 ${run.failures} 次工具调用失败，最后一次：${clip(line, 200)}`)
    return result
  }

  /** 限速：最近一秒里调用已经到了上限，就等到最早那一次满一秒。 */
  private async pace(run: Running): Promise<void> {
    const perSecond = Math.max(1, Math.floor(run.limits.callsPerSecond))
    for (;;) {
      const now = performance.now()
      while (run.stamps.length > 0 && now - run.stamps[0]! >= 1000) run.stamps.shift()
      if (run.stamps.length < perSecond || run.ended) break
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, 1000 - (now - run.stamps[0]!))))
    }
    run.stamps.push(performance.now())
  }

  /** 等一个任务结束。例程被停掉时返回 undefined。 */
  private waitForTask(run: Running, id: string): Promise<TaskInfo | undefined> {
    const already = run.finished.get(id)
    if (already) {
      run.finished.delete(id)
      return Promise.resolve(already)
    }
    return new Promise((resolve) => {
      let poll: NodeJS.Timeout | undefined
      const done = (task: TaskInfo | undefined): void => {
        clearInterval(poll)
        run.waiters.delete(id)
        run.abort.signal.removeEventListener('abort', stopped)
        resolve(task)
      }
      const stopped = (): void => done(undefined)
      run.waiters.set(id, done)
      run.abort.signal.addEventListener('abort', stopped, { once: true })
      // 事件丢了也不至于一直等：隔一会儿自己问一次任务列表
      poll = setInterval(() => {
        this.deps.bridge.taskList(this.deps.botName()).then(
          (list) => {
            const ended = (list.recent ?? []).find((t) => t.id === id)
            if (ended && run.waiters.has(id)) done(ended)
          },
          () => {},
        )
      }, TASK_POLL_MS)
    })
  }

  // ── 结束 ──

  private programEnded(run: Running, result: ProgramRun): void {
    if (run.ended) return
    const o = result.outcome
    if (result.saved.length > 0) run.view.drafts = result.saved.map((d) => d.name)
    if (o.logDropped > 0) run.view.logLost = o.logDropped
    if (o.status === 'ok') {
      if (o.value !== undefined) run.view.value = o.value
      if (o.valueLength !== undefined) run.view.valueLength = o.valueLength
      return this.finish(run, 'done', 'the program finished', '程序跑到头了')
    }
    if (o.status === 'error') {
      const where = o.error.line !== undefined ? ` at line ${o.error.line}` : ''
      return this.finish(run, 'failed', `the program failed${where}: ${o.error.name}: ${o.error.message}`, `程序出错了${o.error.line !== undefined ? `（第 ${o.error.line} 行）` : ''}：${o.error.name}: ${o.error.message}`)
    }
    if (o.status === 'timeout') return this.finish(run, 'limit', `the program itself computed for more than ${run.limits.computeMs / 1000} s (waiting for tools is not counted): look for a loop that never ends`, `程序自己算了超过 ${run.limits.computeMs / 1000} 秒（等工具的时间不算）`)
    if (o.status === 'stopped') return this.finish(run, 'stopped', 'it was stopped', '被停掉了')
    if (o.status === 'memory') return this.finish(run, 'failed', 'the program used too much memory', '程序用的内存太多')
    if (o.status === 'output') return this.finish(run, 'failed', 'the program produced too much output', '程序输出的东西太多')
    this.finish(run, 'failed', o.detail ?? 'the sandbox process ended unexpectedly', o.detail !== undefined ? `沙箱出了状况：${o.detail}` : '跑程序的沙箱进程意外结束了')
  }

  private finish(run: Running, status: RoutineStatus, ending: string, said: string): void {
    if (run.ended) return
    run.ended = true
    clearTimeout(run.timer)
    const view = run.view
    view.status = status
    view.ending = ending
    view.endingText = said
    view.endedAt = this.deps.now()
    const task = view.current?.taskId
    delete view.current
    run.abort.abort()
    if (this.running === run) this.running = undefined
    this.last = view
    run.record.end(status === 'running' ? 'stopped' : status, ending, view.value)
    view.run = run.record.view()
    this.release(run)
    // 停下来时它开的任务还在游戏里跑：取消掉（程序自己跑完的不会走到这里还带着任务）
    if (task !== undefined && status !== 'done') {
      this.canceling = this.deps.cancelTask(task).catch((e: unknown) => {
        if (!(e instanceof BridgeError)) this.deps.log.add({ kind: 'error', text: `例程 ${view.id} 停下时没能取消它的任务 ${task}：${e instanceof Error ? e.message : String(e)}` })
      })
    }
    this.deps.ended({ ...view, recent: [...view.recent], logs: [...view.logs] })
  }
}

const STATUS_WORDS: Record<RoutineStatus, string> = { running: 'is running', done: 'finished', failed: 'FAILED', stopped: 'was STOPPED', limit: 'was STOPPED at a limit' }

/** 例程的情况写成一段话（英文，给模型看）：状态、做到哪了、最近几步、程序的日志。 */
export function describeRoutine(view: RoutineView, now: number): string {
  const lines: string[] = []
  const took = Math.max(0, Math.round(((view.endedAt ?? now) - view.startedAt) / 1000))
  lines.push(`Routine ${view.id} ("${view.name}") ${STATUS_WORDS[view.status]}${view.ending && view.status !== 'running' ? `: ${view.ending}` : ''}. ${view.calls} tool call(s), ${view.actions} task(s), ${took} s ${view.status === 'running' ? 'so far' : 'in all'}.`)
  if (view.current) lines.push(`Now waiting for: ${view.current.tool} ${view.current.input}${view.current.taskId ? ` (task ${view.current.taskId})` : ''}, for ${Math.round((now - view.current.since) / 1000)} s.`)
  if (view.value !== undefined) {
    // 返回值太长时只有开头：写明一共多少、给了多少、剩下的怎么拿
    lines.push(
      view.valueLength !== undefined && view.valueLength > view.value.length
        ? `It returned (CUT: this is only the first ${view.value.length} of ${view.valueLength} characters, the most a returned value holds. To get the rest, have the program return less: the fields it needs from r.data, or a summary): ${view.value}`
        : `It returned: ${view.value}`,
    )
  }
  if (view.drafts && view.drafts.length > 0) lines.push(`It saved draft(s): ${view.drafts.join(', ')}.`)
  if (view.recent.length > 0) {
    // 每次调用只留结果的第一行；调用多了只留最近的几次
    lines.push(`Last ${view.recent.length}${view.calls > view.recent.length ? ` of ${view.calls}` : ''} call(s), the first line of each result:`)
    for (const c of view.recent) lines.push(`- #${c.n} ${c.tool} ${c.input} → ${c.ok ? '' : 'FAILED: '}${c.result}`)
  }
  if (view.logs.length > 0) {
    const earlier = view.logsDropped ?? 0
    lines.push(`Its log (last ${view.logs.length}${earlier > 0 ? ` of ${view.logs.length + earlier}` : ''} line(s)${earlier > 0 ? '; the earlier ones are not kept' : ''}):`, ...view.logs.map((l) => `  ${l}`))
  }
  // 日志满了：上面的不是它最后说的话
  if (view.logFull !== undefined) {
    lines.push(`  … (its log is full: a program's log holds ${view.logFull} characters in all, so ${view.logLost !== undefined ? `${view.logLost} line(s)` : 'the lines'} it logged after this point were cut short or dropped)`)
  }
  return lines.join('\n')
}

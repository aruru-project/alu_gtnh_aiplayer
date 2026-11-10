// 例程：模型写的程序在后台跑，程序里可以一个个调工具（查询的直接拿结果，会开任务的等任务做完再往下走）。
// 模型启动它以后这一轮就可以结束；例程做完、出错、被停掉或者碰到上限时，再把模型叫醒，带上它的日志。
//
// 例程里调的每个工具和模型自己调走的是同一条路（runTool）：同样的校验，同样记进对话日志（面板上看得到）。
// 程序本身照旧跑在沙箱里（script/sandbox.ts），碰不到文件和网络，只多了“调工具”这一个口子。
// 上限：总时长、工具调用次数、开任务的次数、连续失败的次数、程序自己的计算时间。同一时间只跑一个。

import type { BridgeApi } from '../bridge/api.ts'
import { BridgeError } from '../bridge/protocol.ts'
import type { TaskInfo } from '../bridge/protocol.ts'
import type { DesignWorkspace, ProgramRun } from '../design/index.ts'
import type { ProgramCall, ProgramCallResult } from '../script/sandbox.ts'
import type { ActivityLog } from '../store/activity-log.ts'
import { clip, compactJson, formatTask } from '../tools/format.ts'
import { runTool } from '../tools/index.ts'
import type { Tool, ToolContext, ToolResult } from '../tools/index.ts'

export interface RoutineLimits {
  /** 从开始到结束最多多久（等任务的时间算在内）。 */
  wallMs: number
  /** 最多调多少次工具。 */
  calls: number
  /** 其中最多开多少个任务。 */
  actions: number
  /** 连着失败这么多次就停。 */
  failuresInARow: number
  /** 程序自己最多算多久（等工具结果的时间不算）。 */
  computeMs: number
}

export const DEFAULT_ROUTINE_LIMITS: RoutineLimits = { wallMs: 30 * 60_000, calls: 400, actions: 150, failuresInARow: 3, computeMs: 20_000 }
export const ROUTINE_MAX_MINUTES = 180
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
  /** 为什么结束（英文，给模型看）。 */
  ending?: string
  /** 程序 return 的值。 */
  value?: string
  /** 它存下的图纸草稿。 */
  drafts?: string[]
}

export interface RoutineDeps {
  design: DesignWorkspace
  bridge: BridgeApi
  botName(): string
  tools: readonly Tool[]
  /** 调工具用的上下文：和模型调工具用的是同一个，只是开了任务时多告诉这边一声。 */
  context(onTaskStarted: (task: TaskInfo) => void): ToolContext
  log: ActivityLog
  now(): number
  /** 例程结束了。 */
  ended(view: RoutineView): void
  /** 停例程时取消它正在做的任务（经 agent，这样这次取消不会再把模型叫醒一遍）。 */
  cancelTask(id: string): Promise<void>
  /** 扣下的任务事件送回 agent 的事件入口（这时谁开的任务已经清楚了）。 */
  redeliver(ev: RoutineTaskEvent): void
  limits?: Partial<RoutineLimits>
  /** 一个工具结果最多给程序多少字符的文字（data 不受这个限制）。 */
  maxResultChars?: number
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
    return view ? { ...view, recent: [...view.recent], logs: [...view.logs] } : undefined
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
  start(code: string, opts: { name?: string; minutes?: number } = {}): { view: RoutineView } | { error: string } {
    if (this.running) return { error: `routine ${this.running.view.id} ("${this.running.view.name}") is still running: wait for it, or stop it with stop_routine` }
    const limits: RoutineLimits = { ...DEFAULT_ROUTINE_LIMITS, ...(this.deps.limits ?? {}) }
    if (opts.minutes !== undefined) limits.wallMs = Math.min(ROUTINE_MAX_MINUTES, Math.max(1, opts.minutes)) * 60_000
    const id = `r${this.seq++}`
    const view: RoutineView = { id, name: (opts.name ?? '').trim().slice(0, 60) || id, status: 'running', startedAt: this.deps.now(), calls: 0, actions: 0, recent: [], logs: [] }
    const run: Running = {
      view,
      abort: new AbortController(),
      limits,
      failures: 0,
      timer: setTimeout(() => this.finish(run, 'limit', `it ran for ${Math.round(limits.wallMs / 60_000)} minutes, the time it was given`), limits.wallMs),
      waiters: new Map(),
      owned: new Set(),
      finished: new Map(),
      calling: 0,
      held: [],
      ended: false,
    }
    this.running = run
    this.deps.log.add({ kind: 'info', text: `例程 ${id}（${view.name}）开始在后台跑。`, detail: code })
    void this.deps.design
      .run(code, {
        timeoutMs: limits.computeMs,
        background: true,
        hooks: {
          signal: run.abort.signal,
          onCall: (call) => this.call(run, call),
          onLog: (text) => {
            view.logs.push(clip(text, LOG_LINE_CHARS))
            if (view.logs.length > LOGS_KEPT) view.logs.splice(0, view.logs.length - LOGS_KEPT)
          },
        },
      })
      .then(
        (result) => this.programEnded(run, result),
        (e: unknown) => this.finish(run, 'failed', `the program could not be run: ${e instanceof Error ? e.message : String(e)}`),
      )
    return { view: this.view()! }
  }

  /** 例程停下时要取消的那个任务已经取消完了（或者没取消成）。大脑退出前等它一下，免得请求还没发出去连接就断了。 */
  whenCanceled(): Promise<void> {
    return this.canceling
  }

  /** 停掉正在跑的例程（模型或主人要求的）。没有在跑的返回 false。 */
  stop(reason: string): boolean {
    const run = this.running
    if (!run) return false
    this.finish(run, 'stopped', reason)
    return true
  }

  // ── 程序调工具 ──

  private async call(run: Running, call: ProgramCall): Promise<ProgramCallResult> {
    const { view, limits } = run
    if (run.ended) return { ok: false, text: 'the routine has been stopped' }
    if (view.calls >= limits.calls) {
      this.finish(run, 'limit', `it made ${limits.calls} tool calls, the most a routine may make`)
      return { ok: false, text: 'the routine has reached its limit of tool calls' }
    }
    const n = ++view.calls
    const input = compactJson(call.input, 200)
    const since = this.deps.now()
    view.current = { tool: call.name, input, since }
    this.deps.log.add({ kind: 'tool_call', who: call.name, text: `[例程 ${view.id}] ${input}` })

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
        : await runTool(this.deps.tools, ctx, call.name, call.input, { maxResultChars: this.deps.maxResultChars ?? 6000 })
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
        result = { ok: final.state === 'done', text: formatTask(final), data: { task: final.id, state: final.state, ...(final.result ? { result: final.result } : {}), ...(final.error ? { error: final.error } : {}) } }
        // 任务被别人取消了（主人在面板上、模型另开了任务）：这是叫例程停下
        if (final.state === 'canceled' && !run.ended) this.finish(run, 'stopped', `its task ${final.id} (${final.type}) was canceled by someone else`)
      } else {
        result = { ok: false, text: 'the routine was stopped while this task was running' }
      }
      if (view.actions >= limits.actions && !run.ended) this.finish(run, 'limit', `it started ${limits.actions} tasks, the most a routine may start`)
    }
    const line = result.text.split('\n')[0] ?? ''
    const entry: Parameters<ActivityLog['add']>[0] = { kind: 'tool_result', who: call.name, text: `[例程 ${view.id}] ${clip(line, 300)}` }
    if (line !== result.text) entry.detail = result.text
    if (!result.ok) entry.isError = true
    this.deps.log.add(entry)
    view.recent.push({ n, tool: call.name, input, ok: result.ok, result: clip(line, 200), ms: this.deps.now() - since, ...(taskId ? { taskId } : {}) })
    if (view.recent.length > CALLS_KEPT) view.recent.shift()
    delete view.current
    run.failures = result.ok ? 0 : run.failures + 1
    if (run.failures >= limits.failuresInARow && !run.ended) this.finish(run, 'limit', `${run.failures} tool calls failed in a row; the last: ${clip(line, 200)}`)
    return result
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
    if (o.status === 'ok') {
      if (o.value !== undefined) run.view.value = o.value
      return this.finish(run, 'done', 'the program finished')
    }
    if (o.status === 'error') {
      const where = o.error.line !== undefined ? ` at line ${o.error.line}` : ''
      return this.finish(run, 'failed', `the program failed${where}: ${o.error.name}: ${o.error.message}`)
    }
    if (o.status === 'timeout') return this.finish(run, 'limit', `the program itself computed for more than ${run.limits.computeMs / 1000} s (waiting for tools is not counted): look for a loop that never ends`)
    if (o.status === 'stopped') return this.finish(run, 'stopped', 'it was stopped')
    this.finish(run, 'failed', o.status === 'memory' ? 'the program used too much memory' : o.status === 'output' ? 'the program produced too much output' : (o.detail ?? 'the sandbox process ended unexpectedly'))
  }

  private finish(run: Running, status: RoutineStatus, ending: string): void {
    if (run.ended) return
    run.ended = true
    clearTimeout(run.timer)
    const view = run.view
    view.status = status
    view.ending = ending
    view.endedAt = this.deps.now()
    const task = view.current?.taskId
    delete view.current
    run.abort.abort()
    if (this.running === run) this.running = undefined
    this.last = view
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
  if (view.value !== undefined) lines.push(`It returned: ${view.value}`)
  if (view.drafts && view.drafts.length > 0) lines.push(`It saved draft(s): ${view.drafts.join(', ')}.`)
  if (view.recent.length > 0) {
    lines.push(`Last ${view.recent.length} call(s):`)
    for (const c of view.recent) lines.push(`- #${c.n} ${c.tool} ${c.input} → ${c.ok ? '' : 'FAILED: '}${c.result}`)
  }
  if (view.logs.length > 0) lines.push(`Its log (last ${view.logs.length} line(s)):`, ...view.logs.map((l) => `  ${l}`))
  return lines.join('\n')
}

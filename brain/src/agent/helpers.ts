// 子思维（主人叫它“查询脑”）：对话线派出去专门想一件事的那部分心思。
//
// - 只有对话线能派（start_helper），干活线不派，子思维自己也不能再往下派：只有一层。同时最多 HELPERS_MAX（3）个。
// - 每个都是全新的上下文：自己的系统提示词（prompt.ts 的 HELPER_PROMPT，加上她的记忆、基地的做法、手册目录，都只读）、
//   子思维的工具清单（tools/index.ts 的 HELPER_TOOLS：只查不改，run_program 里也只能查，画草稿也在 run_program 里）、
//   对话线写的任务。不压缩历史（它短命）；上下文超长就结束并照实说。
// - 记不记交给对话线：记忆、清单、手册、基地的做法、提醒它都没有；说话、交事、动身体、发布或删草稿也没有。按名字硬调
//   这些不执行，照实告诉它（tools/index.ts 的 otherLine）。
// - 它不调工具、只写字的那一步就是最后一步：那段话连同任务、几步、多久原样交回对话线（一个 helper 事件，叫醒对话线）。
//   到了步数上限，再给它一次不能调工具的机会写交回的话；被停、出错、上下文超长、每日 token 用完时交回它最后写的话并写明怎么结束的。
//   这是内部的话，不进游戏聊天。
// - 每一步照两条线的格式记进活动日志（kind 一样，agent: 'helper'，helper: 'h3'，step；model_call 的 purpose 是 helper），
//   用量记在同一本账上（每日 token 上限两条线和子思维合计）。
// - 落盘（store/helpers.ts）：在想的那几个一步写一次，大脑重启时它们就没了，启动后告诉对话线哪几个没想完（叫醒一次）；
//   结束了的整个过程存一份，给面板看、给 helper_status 翻。
//
// 调模型、跑工具、记日志用的是两条线的同一套：runTool、modelToolSpecs、RunRecorder、modelCallText、日志条目的格式。
// 一轮的循环本身是这里的：两条线那一份（agent.ts）和历史、压缩、叫停、事件队列、例程缠在一起，子思维一样都不要。

import type { BridgeApi } from '../bridge/api.ts'
import type { DesignWorkspace } from '../design/index.ts'
import { LlmError, keepLatestImages, textOf } from '../llm/index.ts'
import type { GenerateRequest, GenerateResult, LlmClient, Message, ToolResultPart, UserPart } from '../llm/index.ts'
import type { PackData } from '../packdata/index.ts'
import type { ActivityInput, ActivityLog, ActivityModelCall } from '../store/activity-log.ts'
import type { FeedbackStore, FeedbackToolCall } from '../store/feedback.ts'
import type { HelperRecord, HelperState, HelperStep, HelperStore, HelperSummary } from '../store/helpers.ts'
import { clip, compactJson } from '../tools/format.ts'
import { HELPERS_MAX, HELPER_TOOLS, LEGACY_TOOLS, QUERY_TOOLS, modelToolSpecs, runTool } from '../tools/index.ts'
import type { ChatLogAccess, HelperAccess, ManualAccess, MemoryAccess, ProgramToolResult, QuestProgressCache, ReminderAccess, SurroundingsCache, ToolContext, ToolResult } from '../tools/index.ts'
import type { MethodAccess } from '../tools/methods.ts'
import { LIVE_IMAGES_MAX, modelCallText } from './agent.ts'
import type { AgentSettings } from './agent.ts'
import { buildSnapshot } from './context.ts'
import { HELPER_END_WORD, spentText } from './events.ts'
import type { AgentEvent, HelperEnd } from './events.ts'
import { buildHelperPrompt } from './prompt.ts'
import { RunRecorder } from './run-log.ts'
import type { RunLogStore } from './run-log.ts'
import { errorText, firstLine } from '../util.ts'

export { HELPERS_MAX }

/** 子思维结束的事件（交给对话线的那一个）。 */
export type HelperEvent = Extract<AgentEvent, { type: 'helper' }>

export interface HelpersDeps {
  /** 对话线的设置：名字、这个服务器、每日 token 上限、单个工具结果上限都照它。 */
  settings(): AgentSettings
  /** 每个子思维最多走几步（设置里的 helperMaxSteps）。 */
  maxSteps(): number
  /** 子思维用的模型。主人没单独给它选时，上层给的是对话线的。 */
  model: { llm(): LlmClient | undefined; name?(): string | undefined; canSee?(): boolean }
  bridge: BridgeApi
  memory: MemoryAccess & { render(): string }
  manuals: ManualAccess
  /** 工具上下文要的（它的清单里没有定提醒的工具，按名字调也不执行）。 */
  reminders: ReminderAccess
  packdata?: PackData
  design?: DesignWorkspace
  methods?: MethodAccess
  feedback?: FeedbackStore
  versions?(): { brain: string; mod?: string }
  chatLog?: ChatLogAccess
  log: ActivityLog
  runLogs?: RunLogStore
  pictures?: { save(png: Buffer, blocks?: unknown): string }
  /** 任务书进度、附近机器的短时缓存：和两条线共用一份。 */
  caches: { questProgress: QuestProgressCache; surroundings: SurroundingsCache }
  /** 今天已经用掉的 token（两条线和子思维合计）。 */
  todayTokens(): number
  /** worker_status 给的那段话（agent/lines.ts）。 */
  workerStatus?(detail: boolean): Promise<string>
  /** run_program 的程序编号（p12）：和两条线接着数，不重号。 */
  nextProgramId(): string
  /** 一个子思维结束了：交给对话线（叫醒它）。 */
  deliver(ev: HelperEvent): void
  /** 落盘；不给就只在内存里（测试、没有数据目录时）。 */
  store?: HelperStore
  /** 查任务书进度时默认看谁的。 */
  defaultPlayer?(): string | undefined
  now?(): number
}

/** 在想的一个。 */
interface Running {
  record: HelperRecord
  abort: AbortController
  /** 被谁停的（给人看的一句）；没被停是 undefined。 */
  stopping?: string
  /** 大脑要停：它没想完，不交回，留给下次启动告诉对话线。 */
  closing: boolean
  /** 正在想的那一步从什么时候开始。 */
  thinkingSince?: number
  /** 最近一步是什么时候（落盘，重启后说它想了多久）。 */
  updatedAt: number
  /** 这个子思维记的日志：每一条都带 agent: 'helper' 和它的编号。 */
  log: Pick<ActivityLog, 'add' | 'update'>
  ctx?: ToolContext
  programRun?: RunRecorder
  programCalls: number
  /** 最近几次工具调用（往意见簿里记一条时附上）。 */
  trace: FeedbackToolCall[]
  done: Promise<void>
}

/** 面板和对话线看到的在想的一个：记录（不带过程）加上它现在在干什么。 */
export interface HelperNow extends HelperSummary {
  /** 正在想的那一步从什么时候开始；在执行工具时没有。 */
  thinkingSince?: number
  /** 最近一次调的工具（名字）。 */
  lastTool?: string
}

export interface HelperOverview {
  max: number
  maxSteps: number
  running: HelperNow[]
  recent: HelperSummary[]
}

/** 结束了的记录在过程里每个工具结果、参数各留多长（面板看的；全文在活动日志里也有一份，同样有上限）。 */
const RESULT_KEPT = 8000
const INPUT_KEPT = 2000
const TRACE_KEPT = 8
/** 没有落盘时内存里留几个结束了的。 */
const RECENT_IN_MEMORY = 20
/** helper_status 不给 id 时列最近结束的几个。 */
const RECENT_LISTED = 5
/** 大脑要停时最多等它们收尾这么久。 */
const CLOSE_WAIT_MS = 3000

const END_EN: Record<HelperEnd, string> = {
  done: 'finished',
  limit: 'reached its step limit',
  stopped: 'was stopped',
  failed: 'stopped on a model error',
  context: 'ran out of context',
  budget: 'stopped: the daily token limit was reached',
  interrupted: 'was cut off by a brain restart',
}

const FINAL_NOTE = (steps: number): string =>
  `[系统] 到了 ${steps} 步的上限，这一步调不了工具了（调了也不会执行）。这一步写的话会原样交回给对话线：到现在为止查到的、想到的，和还没查完的。`

export class Helpers {
  private readonly deps: HelpersDeps
  private readonly running = new Map<string, Running>()
  private nextId: number
  /** 大脑重启前在想、没想完的（start 时告诉对话线）。 */
  private lost: HelperState['running']
  /** 没有落盘时，结束了的留在这里。 */
  private recent: HelperRecord[] = []
  private closed = false

  constructor(deps: HelpersDeps) {
    this.deps = deps
    const saved = deps.store?.state() ?? { nextId: 1, running: [] }
    this.nextId = saved.nextId
    this.lost = saved.running
    // 面板上看得到它们没想完：大脑正常停下时已经存过一份（带着想到的那几步），被强杀的只有落盘的那几项
    for (const r of this.lost) {
      const kept = deps.store?.get(r.id)
      if (kept && kept.status !== 'running') continue
      deps.store?.saveRecord({ id: r.id, task: r.task, status: 'interrupted', startedAt: r.startedAt, ...(r.updatedAt !== undefined ? { endedAt: r.updatedAt } : {}), steps: r.steps, maxSteps: deps.maxSteps(), note: '大脑重启时它还没想完，想到的都没了。', usage: { inputTokens: 0, outputTokens: 0 }, transcript: kept?.transcript ?? [] })
    }
    this.persist()
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  // ── 对外 ──

  /** 开始工作：重启前没想完的告诉对话线（一起叫醒它一次）。 */
  start(): void {
    const lost = this.lost.splice(0)
    for (const r of lost) {
      this.deps.deliver({
        type: 'helper',
        time: this.now(),
        id: r.id,
        task: r.task,
        status: 'interrupted',
        steps: r.steps,
        ms: Math.max(0, (r.updatedAt ?? r.startedAt) - r.startedAt),
        text: '',
        note: '要的话重新派一个。',
      })
    }
  }

  /** 大脑要停：停掉在想的（它们没想完，下次启动告诉对话线），等它们收尾。 */
  async close(): Promise<void> {
    this.closed = true
    const all = [...this.running.values()]
    for (const r of all) {
      r.closing = true
      r.abort.abort()
    }
    let giveUp: NodeJS.Timeout | undefined
    await Promise.race([Promise.all(all.map((r) => r.done)), new Promise<void>((resolve) => (giveUp = setTimeout(resolve, CLOSE_WAIT_MS)))])
    clearTimeout(giveUp)
    this.persist()
  }

  /** 有没有在想的（自动下线看它：有就不下线）。 */
  busy(): boolean {
    return this.running.size > 0
  }

  /** 对话线的工具要的口子。 */
  access(): HelperAccess {
    return { start: (task) => this.dispatch(task), status: (id, stop) => this.statusText(id, stop) }
  }

  /** 停掉一个。why 是给人看的一句（谁停的）。不在想的返回 false。 */
  stop(id: string, why: string): boolean {
    const r = this.running.get(id)
    if (!r || r.abort.signal.aborted) return false
    r.stopping = why
    r.abort.abort()
    return true
  }

  /** 在想的和最近结束的（面板的列表；不带过程）。 */
  overview(limit = 20): HelperOverview {
    return { max: HELPERS_MAX, maxSteps: this.deps.maxSteps(), running: [...this.running.values()].map((r) => this.nowView(r)), recent: this.ended(limit) }
  }

  /** 一个的完整记录（在想的是到现在为止的）。 */
  view(id: string): (HelperRecord & { thinkingSince?: number }) | undefined {
    const r = this.running.get(id)
    if (r) return { ...structuredClone(r.record), ...(r.thinkingSince !== undefined ? { thinkingSince: r.thinkingSince } : {}) }
    return this.deps.store?.get(id) ?? this.recent.find((x) => x.id === id)
  }

  /** 等在想的都结束（测试用）。 */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()].map((r) => r.done))
  }

  /** 对话线每一轮“当前状态”里讲子思维的那几行；没有在想的是空字符串。 */
  stateLines(now: number): string {
    if (this.running.size === 0) return ''
    const lines = [`子思维（你派出去想事的，最多 ${HELPERS_MAX} 个同时在想；想完了交回的话会叫醒你）：`]
    for (const r of this.running.values()) {
      const rec = r.record
      const doing = r.thinkingSince !== undefined ? `在想第 ${rec.steps + 1} 步` : rec.steps === 0 ? '刚派出去' : `走完 ${rec.steps} 步，在查`
      lines.push(`  ${rec.id}：${doing}（最多 ${rec.maxSteps} 步），已经 ${spentText(now - rec.startedAt)}——「${firstLine(rec.task, 60)}」`)
    }
    return lines.join('\n')
  }

  // ── 派出去 ──

  private dispatch(task: string): string {
    if (this.closed) return 'Not started: the brain is shutting down.'
    const now = this.now()
    if (this.running.size >= HELPERS_MAX) {
      const list = [...this.running.values()].map((r) => `- ${this.briefEn(r, now)}`)
      return `Not started: ${HELPERS_MAX} helpers are already thinking, the most there can be at once:\n${list.join('\n')}\nWhen one ends, what it found comes to you. helper_status with an id and stop: true stops one.`
    }
    const llm = this.deps.model.llm()
    if (!llm) return 'Not started: there is no model for helpers to think with (none is chosen for them, nor for the talk line).'
    const id = `h${this.nextId++}`
    const model = this.deps.model.name?.()
    const record: HelperRecord = { id, task, status: 'running', startedAt: now, steps: 0, maxSteps: this.deps.maxSteps(), ...(model ? { model } : {}), usage: { inputTokens: 0, outputTokens: 0 }, transcript: [] }
    const r: Running = {
      record,
      abort: new AbortController(),
      closing: false,
      updatedAt: now,
      log: {
        add: (entry) => this.deps.log.add({ ...entry, agent: 'helper', helper: id }),
        update: (entryId, patch, opts) => this.deps.log.update(entryId, patch, opts),
      },
      programCalls: 0,
      trace: [],
      done: Promise.resolve(),
    }
    this.running.set(id, r)
    this.persist()
    r.log.add({ kind: 'turn', text: `子思维 ${id} 开始${model ? `（${model}）` : ''}：${firstLine(task, 100)}`, detail: task })
    r.done = this.run(r, llm).catch((e: unknown) => {
      // 走到这里是程序自己的毛病：记下来，照样交回（它想到的不能悄悄丢）
      r.log.add({ kind: 'error', text: `子思维 ${id} 内部出错：${e instanceof Error ? (e.stack ?? e.message) : String(e)}` })
      if (this.running.get(id) === r && r.record.status === 'running') this.finish(r, 'failed', this.lastText(r), `程序内部出错：${errorText(e)}。${this.lastText(r) ? '下面是它出错前最后写的话。' : ''}`)
    })
    return `Helper ${id} is thinking about it now (at most ${record.maxSteps} steps). There is nothing to wait for: when it ends, what it wrote last comes to you whole, as an event that wakes you. ${this.running.size} of ${HELPERS_MAX} helpers are thinking now.`
  }

  // ── 一个子思维从头想到尾 ──

  private async run(r: Running, llm: LlmClient): Promise<void> {
    const settings = this.deps.settings()
    const rec = r.record
    const canSee = this.deps.model.canSee?.() === true
    const system = buildHelperPrompt({
      botName: settings.botName,
      steps: rec.maxSteps,
      memory: this.deps.memory.render(),
      manuals: this.deps.manuals.list(),
      ...(this.deps.packdata?.guide ? { guide: { pages: this.deps.packdata.guide.size } } : {}),
      ...(settings.environment ? { environment: settings.environment } : {}),
      ...(this.deps.methods ? { methods: this.deps.methods.list() } : {}),
    })
    const tools = modelToolSpecs(HELPER_TOOLS, { canSee, line: 'helper' })
    const ctx = this.toolContext(r, settings.botName, canSee)
    r.ctx = ctx
    // 派出去那一刻身体在哪、谁在线、几点：设计、找东西时用得上（拿不到的照实写在里面）
    const snapshot = await buildSnapshot(this.deps.bridge, settings.botName, [], this.now()).then(
      (s) => s.text,
      (e: unknown) => `拿不到：${errorText(e)}`,
    )
    const opening = `[交给你的事]（对话线写的）\n${rec.task}\n\n[当前状态]（派你出去的那一刻）\n${snapshot}`
    const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: opening }] }]
    const signal = r.abort.signal
    let lastText = ''

    for (;;) {
      if (signal.aborted) return this.finish(r, 'stopped', lastText)
      const limit = this.deps.settings().dailyTokenLimit
      if (limit > 0 && this.deps.todayTokens() >= limit) {
        return this.finish(r, 'budget', lastText, `今天的模型用量到了上限（${limit} token，两条线和子思维合计），它停在第 ${rec.steps} 步。${lastText ? '下面是它之前最后写的话。' : ''}`)
      }
      // 到了上限：再给它一次不能调工具的机会，把到现在为止的写成交回的话
      const final = rec.steps >= rec.maxSteps
      if (final) {
        const last = messages[messages.length - 1]
        if (last && last.role === 'user') last.content.push({ type: 'text', text: FINAL_NOTE(rec.maxSteps) })
      }
      let result: GenerateResult
      try {
        result = await this.callModel(r, llm, { system, messages: keepLatestImages(messages, LIVE_IMAGES_MAX), tools, signal, ...(final ? { toolChoice: 'none' as const } : {}) }, rec.steps + 1, final)
      } catch (e) {
        if (signal.aborted) return this.finish(r, 'stopped', lastText)
        if (final) return this.finish(r, 'limit', lastText, `到了每个子思维 ${rec.maxSteps} 步的上限；让它写交回的话的那一次模型调用出错了（${llmErrorText(e)}）。${lastText ? '下面是它之前最后写的话。' : ''}`)
        if (e instanceof LlmError && e.kind === 'context_length') {
          return this.finish(r, 'context', lastText, `模型接口说上下文太长了（它在第 ${rec.steps + 1} 步），子思维不压缩历史，就停在这里。${lastText ? '下面是它之前最后写的话。' : ''}`)
        }
        return this.finish(r, 'failed', lastText, `模型接口出错（${llmErrorText(e)}），它停在第 ${rec.steps + 1} 步。${lastText ? '下面是它出错前最后写的话。' : ''}`)
      }
      rec.steps++
      r.updatedAt = this.now()
      const step = rec.transcript[rec.transcript.length - 1]!
      messages.push(result.message)
      const text = textOf(result.message.content).trim()
      if (text.length > 0) {
        step.text = text
        lastText = text
        r.log.add({ kind: 'model_text', step: rec.steps, text })
      }
      const calls = result.message.content.filter((p) => p.type === 'tool_call')
      if (final) {
        const ignored = calls.length > 0 ? `它在这一步还要调 ${calls.length} 个工具，没有执行。` : ''
        return this.finish(r, 'limit', text.length > 0 ? text : lastText, `到了每个子思维 ${rec.maxSteps} 步的上限；${text.length > 0 ? '这段是它在上限时、不能再调工具的那一步写的' : '上限时那一步它没写字，下面是它之前最后写的话'}。${ignored}`)
      }
      if (calls.length === 0) return this.finish(r, 'done', text)

      const results: UserPart[] = []
      for (const call of calls) {
        const argsLine = compactJson(call.invalid ? call.invalid.raw : call.input, 160)
        const callEntry: ActivityInput = { kind: 'tool_call', step: rec.steps, source: 'model', who: call.name, text: argsLine }
        if (call.invalid) callEntry.detail = call.invalid.raw
        else if (argsLine.endsWith('…')) callEntry.detail = JSON.stringify(call.input, null, 2)
        r.log.add(callEntry)
        const started = performance.now()
        let res: ToolResult
        if (signal.aborted) {
          res = { content: 'Not executed: you were stopped before this call ran.', isError: true }
        } else if (result.stopReason === 'max_tokens') {
          res = { content: 'Not executed: your reply was cut off by the output length limit, so these arguments may be incomplete. Call the tool again with shorter arguments.', isError: true }
        } else if (call.invalid) {
          res = { content: `Not executed: the arguments were not valid JSON (${call.invalid.reason}). You sent: ${clip(call.invalid.raw, 300)}\nCall the tool again with valid JSON arguments.`, isError: true }
        } else {
          // 不在清单里的名字照常找；说话、交事、动身体、记东西的不执行，结果里照实说（otherLine）
          res = await runTool(HELPER_TOOLS, ctx, call.name, call.input, { maxResultChars: this.deps.settings().toolResultMaxChars })
        }
        const entry: ActivityInput = { kind: 'tool_result', step: rec.steps, source: 'model', who: call.name, text: firstLine(res.content, 160) }
        if (entry.text !== res.content) entry.detail = res.content
        if (res.isError) entry.isError = true
        const images = res.images ?? []
        if (images.length > 0 && this.deps.pictures) {
          try {
            entry.pictures = images.map((image) => this.deps.pictures!.save(image.data, image.blocks))
            const scenes = entry.pictures.filter((_, n) => images[n]!.blocks !== undefined)
            if (scenes.length > 0) entry.scenes = scenes
          } catch (e) {
            r.log.add({ kind: 'error', step: rec.steps, text: `工具结果带的图没存下来（面板上看不到这张图）：${errorText(e)}` })
          }
        }
        r.log.add(entry)
        step.calls.push({
          name: call.name,
          input: compactJson(call.invalid ? call.invalid.raw : call.input, INPUT_KEPT),
          result: clip(res.content, RESULT_KEPT),
          ...(res.isError ? { isError: true } : {}),
          ms: Math.round(performance.now() - started),
          ...(entry.pictures ? { pictures: entry.pictures } : {}),
        })
        r.trace.push({ tool: call.name, input: compactJson(call.invalid ? call.invalid.raw : call.input, 400), result: res.content.slice(0, 1500), ...(res.isError ? { isError: true } : {}) })
        if (r.trace.length > TRACE_KEPT) r.trace.shift()
        const part: ToolResultPart = res.isError ? { type: 'tool_result', toolCallId: call.id, content: res.content, isError: true } : { type: 'tool_result', toolCallId: call.id, content: res.content }
        if (canSee && images.length > 0) part.images = images.map((image) => ({ label: image.label, mediaType: image.mediaType, data: image.data.toString('base64') }))
        results.push(part)
      }
      messages.push({ role: 'user', content: results })
      r.updatedAt = this.now()
      this.persist()
    }
  }

  /**
   * 调一次模型：和两条线一样，在活动日志里是一条 model_call（开始想时就有，回来或出错时原地改成结果），purpose 是 helper。
   * 过程里多一步。
   */
  private async callModel(r: Running, llm: LlmClient, req: GenerateRequest, n: number, final: boolean): Promise<GenerateResult> {
    const started = performance.now()
    const startedAt = this.now()
    const begun: ActivityModelCall = { state: 'thinking', purpose: 'helper', step: n, startedAt }
    const entry = r.log.add({ kind: 'model_call', step: n, text: modelCallText(begun), call: begun })
    const step: HelperStep = { n, at: startedAt, calls: [], ...(final ? { final: true as const } : {}) }
    r.record.transcript.push(step)
    r.thinkingSince = startedAt
    const settle = (end: Partial<ActivityModelCall>): void => {
      r.thinkingSince = undefined
      const call: ActivityModelCall = { ...begun, ...end, ms: Math.round(performance.now() - started) }
      step.ms = call.ms
      const patch = { text: modelCallText(call), call, ...(call.state === 'failed' ? { isError: true } : {}) }
      if (!r.log.update(entry.id, patch, { persist: true })) r.log.add({ kind: 'model_call', step: n, ...patch })
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
        stop: result.stopReason === 'max_tokens' ? 'truncated' : asked > 0 || result.stopReason === 'tool_use' ? 'tool_calls' : result.stopReason === 'end' ? 'end' : 'other',
        toolCalls: asked,
      })
      step.inputTokens = result.usage.inputTokens
      step.outputTokens = result.usage.outputTokens
      if (result.usage.cacheReadTokens !== undefined) step.cacheReadTokens = result.usage.cacheReadTokens
      r.record.usage.inputTokens += result.usage.inputTokens
      r.record.usage.outputTokens += result.usage.outputTokens
      return result
    } catch (e) {
      const kind = e instanceof LlmError ? e.kind : 'unknown'
      // 被停下（对话线、主人）不是出错；大脑要停时中止的照旧记成中止
      if (kind === 'aborted' && r.stopping !== undefined && !r.closing) settle({ state: 'halted', stop: 'halted' })
      else settle({ state: 'failed', stop: 'error', errorKind: kind, error: kind === 'aborted' ? '大脑在停，这次调用被中止了' : errorText(e) })
      step.error = kind === 'aborted' ? (r.closing ? '大脑在停，这次调用被中止了' : '想到一半被停下了') : errorText(e)
      throw e
    }
  }

  /** 它最后写的那段字。 */
  private lastText(r: Running): string {
    for (let i = r.record.transcript.length - 1; i >= 0; i--) {
      const text = r.record.transcript[i]!.text
      if (text) return text
    }
    return ''
  }

  /** 结束了：记下、落盘、交回对话线。大脑要停时不交回（下次启动告诉对话线它没想完）。 */
  private finish(r: Running, status: HelperEnd, text: string, note?: string): void {
    const rec = r.record
    const now = this.now()
    r.programRun?.end('stopped', 'the helper ended')
    if (r.closing) {
      rec.status = 'interrupted'
      rec.endedAt = now
      rec.note = '大脑停了或者重启了，它还没想完。'
      this.saveRecord(rec)
      r.log.add({ kind: 'turn', text: `子思维 ${rec.id} 没想完：大脑要停了（调了 ${rec.steps} 次模型，${spentText(now - rec.startedAt)}）` })
      // 留在 running 里：close() 落盘时它还在“在想的”里，下次启动告诉对话线
      return
    }
    const why = note ?? (status === 'stopped' ? `${r.stopping ?? '被停下了'}（停在第 ${rec.steps} 步）。${text ? '下面是它被停下前最后写的话，不一定是结论。' : ''}` : undefined)
    rec.status = status
    rec.endedAt = now
    if (text.length > 0) rec.final = text
    if (why !== undefined) rec.note = why
    this.running.delete(rec.id)
    this.persist()
    this.saveRecord(rec)
    const ms = now - rec.startedAt
    r.log.add({ kind: 'turn', text: `子思维 ${rec.id} 结束（调了 ${rec.steps} 次模型，${spentText(ms)}）：${HELPER_END_WORD[status]}`, ...(why !== undefined ? { detail: why } : {}) })
    r.log.add({
      kind: 'relay',
      text: `子思维 ${rec.id} → 对话线（${HELPER_END_WORD[status]}）：${firstLine(text.length > 0 ? text : '（没有留下话）', 120)}`,
      detail: [why, text].filter((x): x is string => x !== undefined && x.length > 0).join('\n\n'),
      relay: { type: 'helper', from: 'helper', to: 'talk' },
      ...(status === 'failed' || status === 'context' || status === 'budget' ? { isError: true } : {}),
    })
    this.deps.deliver({ type: 'helper', time: now, id: rec.id, task: rec.task, status, steps: rec.steps, ms, text, ...(why !== undefined ? { note: why } : {}) })
  }

  private saveRecord(rec: HelperRecord): void {
    try {
      if (this.deps.store) this.deps.store.saveRecord(rec)
      else this.recent = [structuredClone(rec), ...this.recent.filter((x) => x.id !== rec.id)].slice(0, RECENT_IN_MEMORY)
    } catch (e) {
      console.error('[helpers] 保存子思维的记录失败：', errorText(e))
    }
  }

  private persist(): void {
    try {
      this.deps.store?.saveState({
        nextId: this.nextId,
        running: [...this.running.values()].map((r) => ({ id: r.record.id, task: r.record.task, startedAt: r.record.startedAt, steps: r.record.steps, updatedAt: r.updatedAt })),
      })
    } catch (e) {
      console.error('[helpers] 保存子思维的状态失败：', errorText(e))
    }
  }

  // ── 它调工具用的上下文 ──

  private toolContext(r: Running, botName: string, canSee: boolean): ToolContext {
    const deps = this.deps
    const id = r.record.id
    const notYours = 'There is no such thing for a helper.'
    const feedback = deps.feedback
    return {
      botName,
      helper: id,
      ...(deps.workerStatus ? { worker: { tell: () => notYours, status: (detail: boolean) => deps.workerStatus!(detail), stop: async () => notYours } } : {}),
      ...(deps.chatLog ? { chatLog: deps.chatLog } : {}),
      activityLog: deps.log,
      // 每个子思维的程序各占一个位子：和两条线、和别的子思维都不互相挡着
      programSlot: `helper:${id}`,
      canSeeImages: () => canSee,
      maxResultChars: () => deps.settings().toolResultMaxChars,
      bridge: deps.bridge,
      memory: deps.memory,
      reminders: deps.reminders,
      manuals: deps.manuals,
      ...(deps.packdata ? { packdata: deps.packdata } : {}),
      ...(deps.design ? { design: deps.design } : {}),
      ...(deps.methods ? { methods: deps.methods } : {}),
      ...(feedback
        ? {
            feedback: {
              submit: (input) => {
                const versions = deps.versions?.() ?? { brain: 'unknown' }
                const res = feedback.submit(input, {
                  bot: botName,
                  brainVersion: versions.brain,
                  ...(versions.mod !== undefined ? { modVersion: versions.mod } : {}),
                  instruction: `子思维 ${id} 的任务（对话线写的）：${r.record.task}`,
                  recentTools: [...r.trace],
                  tasks: [],
                })
                if ('full' in res) return res
                if (!res.merged) r.log.add({ kind: 'info', text: `子思维 ${id} 在意见簿里记了一条（${res.report.id}）：${res.report.title}` })
                return { id: res.report.id, merged: res.merged, count: res.report.count }
              },
            },
          }
        : {}),
      questProgress: deps.caches.questProgress,
      surroundings: deps.caches.surroundings,
      ...(deps.design ? { queryFromProgram: (name: string, input: unknown) => this.query(r, name, input) } : {}),
      now: () => this.now(),
      ...(deps.defaultPlayer ? { defaultPlayer: deps.defaultPlayer } : {}),
      hooks: {
        programStarted: (code) => {
          r.programCalls = 0
          r.programRun = new RunRecorder({ log: r.log, now: () => this.now(), ...(deps.runLogs ? { store: deps.runLogs } : {}) }, { id: deps.nextProgramId(), kind: 'program', name: '', code })
        },
        programEnded: (how) => {
          r.programRun?.end(how.ok ? 'done' : 'failed', how.note)
          r.programRun = undefined
        },
      },
    }
  }

  /** run_program 的程序里调一个工具：只许查询类的，走和它直接调工具同一条路；每一次记进这个程序的运行记录。 */
  private async query(r: Running, name: string, input: unknown): Promise<ProgramToolResult> {
    const record = r.programRun
    const n = ++r.programCalls
    const since = this.now()
    record?.waiting(name, input)
    let out: ProgramToolResult
    if (!QUERY_TOOLS.includes(name) || !r.ctx) {
      const lookups = QUERY_TOOLS.filter((q) => !LEGACY_TOOLS.some((old) => old.name === q))
      out = { ok: false, text: `${name} cannot be called from run_program: a program there can only look things up (${lookups.join(', ')}). Acting is the worker line's; say in what you hand back what should be done.` }
    } else {
      const res = await runTool(HELPER_TOOLS, r.ctx, name, input, { maxResultChars: this.deps.settings().toolResultMaxChars })
      out = { ok: res.isError !== true, text: res.content, ...(res.data !== undefined ? { data: res.data } : {}) }
    }
    record?.call({ n, tool: name, input, ok: out.ok, text: out.text, ms: this.now() - since })
    return out
  }

  // ── 给对话线（helper_status）和面板看的 ──

  private nowView(r: Running): HelperNow {
    const { transcript, ...rest } = r.record
    const lastTool = [...transcript].reverse().find((s) => s.calls.length > 0)?.calls.at(-1)?.name
    return { ...structuredClone(rest), ...(r.thinkingSince !== undefined ? { thinkingSince: r.thinkingSince } : {}), ...(lastTool !== undefined ? { lastTool } : {}) }
  }

  /** 结束了的（不带过程），新的在前。 */
  private ended(limit: number): HelperSummary[] {
    if (this.deps.store) return this.deps.store.list(limit)
    return this.recent.slice(0, limit).map(({ transcript: _t, ...rest }) => rest)
  }

  private briefEn(r: Running, now: number): string {
    const rec = r.record
    return `${rec.id}: "${firstLine(rec.task, 80)}" (thinking for ${Math.max(0, Math.round((now - rec.startedAt) / 1000))} s, ${rec.steps} of at most ${rec.maxSteps} steps)`
  }

  private statusText(id: string | undefined, stop: boolean): string {
    const now = this.now()
    if (id === undefined) {
      const running = [...this.running.values()]
      const ended = this.ended(RECENT_LISTED)
      const lines = [running.length === 0 ? `No helper is thinking now (at most ${HELPERS_MAX} at once).` : `Thinking now (${running.length} of at most ${HELPERS_MAX}):`]
      for (const r of running) lines.push(`- ${this.briefEn(r, now)}`)
      if (ended.length > 0) {
        lines.push('Ended most recently:')
        for (const s of ended) lines.push(`- ${s.id} ${endWord(s.status)} after ${s.steps} step(s): "${firstLine(s.task, 60)}"${s.final ? ` → ${firstLine(s.final, 100)}` : ''}`)
      }
      if (running.length + ended.length > 0) lines.push('With id: one of them in full.')
      return lines.join('\n')
    }
    const r = this.running.get(id)
    if (stop) {
      if (r && this.stop(id, '对话线用 helper_status 停的')) return `Stopping ${id}. What it has so far comes to you as an event once it has stopped.`
      if (r) return `${id} is already stopping; what it has so far comes to you as an event.`
      const rec = this.view(id)
      return rec ? `${id} is not thinking any more: it ${endWord(rec.status)}.` : `There is no helper ${id}.`
    }
    if (r) {
      const rec = r.record
      const lines = [
        `${id} is thinking: ${rec.steps} of at most ${rec.maxSteps} steps done, for ${Math.max(0, Math.round((now - rec.startedAt) / 1000))} s${r.thinkingSince !== undefined ? `; now thinking about step ${rec.steps + 1}` : ''}.`,
        `Task: ${rec.task}`,
      ]
      const calls = rec.transcript.flatMap((s) => s.calls.map((c) => ({ n: s.n, c }))).slice(-6)
      if (calls.length > 0) {
        lines.push(`Its last ${calls.length} tool call(s):`)
        for (const { n, c } of calls) lines.push(`- step ${n}: ${c.name} ${clip(c.input, 120)} → ${c.isError ? 'FAILED: ' : ''}${firstLine(c.result ?? '(not back yet)', 160)}`)
      }
      const last = this.lastText(r)
      if (last) lines.push(`The last thing it wrote: ${clip(last, 1500)}`)
      lines.push(`Its whole log: read_log with helper: "${id}".`)
      return lines.join('\n')
    }
    const rec = this.view(id)
    if (!rec) return `There is no helper ${id}.`
    const spent = rec.endedAt !== undefined ? ` in ${Math.max(0, Math.round((rec.endedAt - rec.startedAt) / 1000))} s` : ''
    return [
      `${id} ${endWord(rec.status)} after ${rec.steps} step(s)${spent}.${rec.note ? ` (${rec.note})` : ''}`,
      `Task: ${rec.task}`,
      rec.final ? `What it handed back:\n${rec.final}` : 'It left nothing written.',
      `Its whole log: read_log with helper: "${id}".`,
    ].join('\n')
  }
}

/** 模型接口的错写成一句：哪一类、HTTP 状态、原话。 */
function llmErrorText(e: unknown): string {
  return e instanceof LlmError ? `${e.kind}${e.status !== undefined ? ` (HTTP ${e.status})` : ''}: ${e.message}` : errorText(e)
}

function endWord(status: HelperRecord['status']): string {
  return status === 'running' ? 'is thinking' : END_EN[status]
}

// agent 测试用的装配：假的 bridge（内存里按方法名应答）、按脚本回应的假模型、真的 store 和工具。
// 这里只隔开两个外部边界：游戏（Requester）和模型（LlmClient）。
//
// 一个玩家两条线（docs/TALK_WORK.md）：h.agent 是两条线合起来的那个入口，事件照真实的规矩分——玩家说的话到对话线，
// 任务、例程、身体的事到干活线。两条线各有一个假模型：h.llm 是干活线的（大多数测试关心的是它怎么操作身体），
// h.talk 是对话线的。脚本用完的假模型回空文本，所以没给对话线写脚本时它听到什么都不出声、也不交事。
// 只想让干活线做一件事的测试用 told(...)：那就是对话线交给它的一件事（附着主人的原话）。

import path from 'node:path'
import type { AgentSettings, AgentTiming, PersistedAgentState } from '../src/agent/agent.ts'
import type { AgentEvent, SaidEvent } from '../src/agent/events.ts'
import { Lines } from '../src/agent/lines.ts'
import type { LinkState } from '../src/agent/lines.ts'
import type { RoutineLimits } from '../src/agent/routine.ts'
import { RunLogStore } from '../src/agent/run-log.ts'
import type { DesignWorkspace } from '../src/design/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import type { Requester } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { LlmError } from '../src/llm/index.ts'
import type { AssistantPart, GenerateRequest, GenerateResult, LlmClient, Message } from '../src/llm/index.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import type { ActivityEntry } from '../src/store/activity-log.ts'
import { ChatLog } from '../src/store/chat-log.ts'
import type { FeedbackStore } from '../src/store/feedback.ts'
import { HistoryStore, TurnIds } from '../src/store/history.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { MethodStore } from '../src/store/methods.ts'
import type { LineName } from '../src/tools/index.ts'
import { tmpDir, waitFor } from './helpers.ts'

type Json = Record<string, unknown>

/** 随代码发布的默认手册（brain/manuals）。 */
export const DEFAULT_MANUALS_DIR = path.resolve(import.meta.dirname, '../manuals')

/** 假的游戏侧：记录收到的请求，按方法名返回写死的应答。 */
export class FakeGame implements Requester {
  readonly calls: { method: string; params: Json }[] = []
  connected = true
  online = true
  private nextTask = 1
  readonly handlers: Record<string, (params: Json) => unknown> = {
    'bot.status': () =>
      this.online
        ? {
            name: 'Alu',
            online: true,
            dim: 0,
            pos: { x: 10.5, y: 64, z: -3.5 },
            block: { x: 10, y: 64, z: -4 },
            health: 20,
            maxHealth: 20,
            food: 20,
            inventory: [{ slot: 0, id: 'minecraft:dirt', meta: 0, count: 64, name: 'Dirt' }],
            freeSlots: 35,
            task: null,
            queue: [],
          }
        : { name: 'Alu', online: false },
    'server.info': () => ({ dayTime: 1000, isDay: true, raining: false, players: [{ name: 'Steve', dim: 0, pos: { x: 12, y: 64, z: 3 } }] }),
    'bot.chat': () => ({}),
    'bot.command': () => ({ output: [] }),
    // 和真实 mod 一样：响应里的任务总是 queued，params 里带着 type
    'task.start': (p) => {
      const spec = p.task as Json
      return { task: { id: `t${this.nextTask++}`, type: spec.type, state: 'queued', params: spec }, replaced: [] }
    },
    'task.cancel': () => ({ canceled: 0, ids: [] }),
    'task.list': () => ({ active: null, queue: [], recent: [] }),
  }

  async request(method: string, params: Json = {}): Promise<unknown> {
    if (!this.connected) throw new BridgeError('disconnected', 'bridge is not connected to the game server')
    this.calls.push({ method, params })
    const handler = this.handlers[method]
    if (!handler) throw new BridgeError('unknown_method', `fake game has no ${method}`)
    return handler(params)
  }

  callsOf(method: string): Json[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params)
  }

  /** bot 在公共聊天里说过的话。 */
  get said(): string[] {
    return this.callsOf('bot.chat').map((p) => String(p.message))
  }
}

export type Scripted = GenerateResult | Error | ((req: GenerateRequest) => GenerateResult | Error | Promise<GenerateResult>)

let callSeq = 1

export function reply(text: string, calls: { name: string; input?: unknown; id?: string }[] = [], extra: Partial<GenerateResult> = {}): GenerateResult {
  const content: AssistantPart[] = []
  if (text.length > 0) content.push({ type: 'text', text })
  for (const c of calls) content.push({ type: 'tool_call', id: c.id ?? `call_${callSeq++}`, name: c.name, input: c.input ?? {} })
  return {
    message: { role: 'assistant', content },
    stopReason: calls.length > 0 ? 'tool_use' : 'end',
    usage: { inputTokens: 1000, outputTokens: 50 },
    model: 'scripted',
    ...extra,
  }
}

/**
 * 按脚本回应的假模型。脚本用完后一律回空文本（结束这一轮）；给了 auto 的话脚本用完后由它按请求的内容回
 * （两条线来回几趟、谁先谁后不好写死顺序的场景用：看它这一步看到了什么，决定回什么）。
 */
export class ScriptedLlm implements LlmClient {
  readonly requests: GenerateRequest[] = []
  readonly script: Scripted[] = []
  /** 脚本用完后怎么回。seen 是这一步新看到的全部文字（最后一条 user 消息里的文字和工具结果）。 */
  auto: ((seen: string, req: GenerateRequest) => GenerateResult | undefined) | undefined
  /** 同时在途的 generate 调用数的最大值。 */
  maxConcurrent = 0
  private inFlight = 0

  enqueue(...items: Scripted[]): this {
    this.script.push(...items)
    return this
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // 存一份快照：agent 之后还会往同一个数组里追加消息
    this.requests.push({ ...req, messages: structuredClone(req.messages) })
    this.inFlight++
    this.maxConcurrent = Math.max(this.maxConcurrent, this.inFlight)
    try {
      const next = this.script.shift()
      const out = typeof next === 'function' ? await next(req) : next
      if (out instanceof Error) throw out
      return out ?? this.auto?.(this.lastUserText(this.requests.length - 1), req) ?? reply('')
    } finally {
      this.inFlight--
    }
  }

  /** 第 n 次请求（从 0 数）里最后一条 user 消息的全部文字。 */
  lastUserText(n: number): string {
    const messages = this.requests[n]?.messages ?? []
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'user') return ''
    return last.content.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? `[image: ${p.image.label}]` : p.content)).join('\n')
  }
}

export function llmDown(kind: 'server' | 'auth' | 'context_length' = 'server'): LlmError {
  return new LlmError(kind, `scripted ${kind} failure`, { status: kind === 'auth' ? 401 : kind === 'server' ? 500 : 400 })
}

export const BASE_SETTINGS: AgentSettings = {
  botName: 'Alu',
  aliases: ['阿鲁'],
  owners: [],
  persona: '',
  wakeMode: 'mention',
  conversationWindowSec: 60,
  maxSteps: 16,
  dailyTokenLimit: 0,
  historyTokenThreshold: 24_000,
  toolResultMaxChars: 6000,
}

export interface AgentHarness {
  /** 两条线合起来的入口：事件从这里进，照真实的规矩分给对话线和干活线。 */
  agent: Lines
  game: FakeGame
  /** 干活线的假模型。 */
  llm: ScriptedLlm
  /** 对话线的假模型。 */
  talk: ScriptedLlm
  /** 干活线的历史。 */
  history: HistoryStore
  /** 对话线的历史。 */
  talkHistory: HistoryStore
  memory: MemoryStore
  /** 基地的做法（临时目录的 methods.json）。 */
  methods: MethodStore
  /** 默认手册是随代码发布的那几本；主人写的放在这次测试的临时目录里。 */
  manuals: ManualStore
  log: ActivityLog
  /** 最近的聊天记录（带站位和指向）。 */
  chatLog: ChatLog
  /** 它写的程序每次运行的全量记录（临时目录的 logs/runs/）。 */
  runLogs: RunLogStore
  /** 干活线的设置（名字、主人这些两条线一样）。 */
  settings: AgentSettings
  /** 对话线的设置。 */
  talkSettings: AgentSettings
  reminders: { dueAt: number; note: string; line?: 'talk' | 'work' }[]
  /** 干活线落盘的状态。 */
  persisted: { state: PersistedAgentState | undefined }
  /** 对话线落盘的状态，和两条线之间留着的事。 */
  talkPersisted: { state: PersistedAgentState | undefined }
  links: { state: LinkState | undefined }
  usedTokens: { value: number }
  dir: string
  /** 用同一份落盘数据、同一个假游戏和假模型再造一个 agent（模拟进程重启）。 */
  restart(overrides?: MakeAgentOptions): AgentHarness
  cleanup(): void
}

export interface MakeAgentOptions {
  /** 两条线都用的设置。 */
  settings?: Partial<AgentSettings>
  /** 只给对话线的设置（它自己的步数上限、历史压缩阈值）。 */
  talkSettings?: Partial<AgentSettings>
  timing?: Partial<AgentTiming>
  /** 一次程序运行的记录写到多大以后结果只留开头（默认 20 MiB）。 */
  runLogFullTextBytes?: number
  /** 两条线都没有模型；或者只是其中一条没有。 */
  noModel?: boolean | LineName
  dir?: string
  persisted?: { state: PersistedAgentState | undefined }
  talkPersisted?: { state: PersistedAgentState | undefined }
  links?: { state: LinkState | undefined }
  game?: FakeGame
  llm?: ScriptedLlm
  talk?: ScriptedLlm
  /** 意见簿。给了，模型就能用 report_problem，版本号报的是 brain-under-test / mod-under-test。 */
  feedback?: FeedbackStore
  /** 现在用的模型能不能看图（模型上的那个开关）。默认不能。 */
  vision?: boolean
  /** 工具结果带的图存到哪（面板的对话日志从这里取）。 */
  pictures?: { save(png: Buffer): string }
  /** 跑程序的沙箱和草稿（给了才有 run_program、例程这些）。 */
  design?: DesignWorkspace
  /** 例程的上限（测试里调小）。 */
  routineLimits?: Partial<RoutineLimits>
  /** 本地资料（物品表、配方册……）。 */
  packdata?: PackData
  /** 这次启动是从只有一条线的老数据升上来的。 */
  migrated?: boolean
}

export function makeAgent(opts: MakeAgentOptions = {}): AgentHarness {
  const tmp = opts.dir ? { dir: opts.dir, cleanup: () => {} } : tmpDir()
  const settings: AgentSettings = { ...BASE_SETTINGS, ...(opts.settings ?? {}) }
  const talkSettings: AgentSettings = { ...settings, ...(opts.talkSettings ?? {}) }
  const game = opts.game ?? new FakeGame()
  const llm = opts.llm ?? new ScriptedLlm()
  const talk = opts.talk ?? new ScriptedLlm()
  // 和 main.ts 一样：干活线沿用原来的文件名，对话线另有一份；轮的编号两条线共用
  const turnIds = new TurnIds()
  const history = new HistoryStore(tmp.dir, { ids: turnIds })
  const talkHistory = new HistoryStore(tmp.dir, { file: 'talk-history.json', ids: turnIds })
  const memory = new MemoryStore(tmp.dir, () => 4000)
  const methods = new MethodStore(tmp.dir)
  const manuals = new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals'))
  const log = new ActivityLog()
  const chatLog = new ChatLog(tmp.dir)
  const runLogs = new RunLogStore(tmp.dir, opts.runLogFullTextBytes !== undefined ? { fullTextBytes: opts.runLogFullTextBytes } : {})
  const reminders: { dueAt: number; note: string; line?: 'talk' | 'work' }[] = []
  const persisted = opts.persisted ?? { state: undefined }
  const talkPersisted = opts.talkPersisted ?? { state: undefined }
  const links = opts.links ?? { state: undefined }
  const usedTokens = { value: 0 }
  const timing: Partial<AgentTiming> = {
    debounceMs: 0,
    retryDelaysMs: [30],
    nonRetryableDelayMs: 30,
    humanRetryGapMs: 0,
    announceIntervalMs: 60_000,
    afterDeathDelayMs: 0,
    ...(opts.timing ?? {}),
  }
  const has = (line: LineName): boolean => opts.noModel !== true && opts.noModel !== line
  const agent = new Lines({
    settings: (line) => (line === 'talk' ? talkSettings : settings),
    models: {
      talk: { llm: () => (has('talk') ? talk : undefined), canSee: () => opts.vision === true },
      work: { llm: () => (has('work') ? llm : undefined), canSee: () => opts.vision === true },
    },
    bridge: new BridgeApi(game),
    memory,
    methods,
    manuals,
    reminders: {
      add: (dueAt, note, line) => {
        reminders.push({ dueAt, note, ...(line !== undefined ? { line } : {}) })
        return { id: `r${reminders.length}`, dueAt }
      },
      list: () => reminders,
    },
    histories: { talk: talkHistory, work: history },
    log,
    chatLog,
    runLogs,
    todayTokens: () => usedTokens.value,
    persist: {
      work: { load: () => persisted.state, save: (s) => (persisted.state = structuredClone(s)) },
      talk: { load: () => talkPersisted.state, save: (s) => (talkPersisted.state = structuredClone(s)) },
      links: { load: () => links.state, save: (s) => (links.state = structuredClone(s)) },
    },
    timing,
    ...(opts.feedback ? { feedback: opts.feedback, versions: () => ({ brain: 'brain-under-test', mod: 'mod-under-test' }) } : {}),
    ...(opts.pictures ? { pictures: opts.pictures } : {}),
    ...(opts.design ? { design: opts.design } : {}),
    ...(opts.routineLimits ? { routineLimits: opts.routineLimits } : {}),
    ...(opts.packdata ? { packdata: opts.packdata } : {}),
    ...(opts.migrated ? { migrated: true } : {}),
  })
  agent.start()
  const harness: AgentHarness = {
    agent,
    game,
    llm,
    talk,
    history,
    talkHistory,
    memory,
    methods,
    manuals,
    log,
    chatLog,
    runLogs,
    settings,
    talkSettings,
    reminders,
    persisted,
    talkPersisted,
    links,
    usedTokens,
    dir: tmp.dir,
    restart: (overrides = {}) => makeAgent({ ...opts, migrated: false, ...overrides, dir: tmp.dir, persisted, talkPersisted, links, game, llm, talk }),
    cleanup: tmp.cleanup,
  }
  return harness
}

/**
 * 让干活线的模型在一轮里调一个工具（对话线交给它一件事 → 它调这个工具 → 看到结果 → 结束这一轮），返回它看到的那个结果。
 * 走的是 agent 的整条路：工具清单按当前模型给，调用经 runTool，结果照“单个工具结果上限”截。
 */
export async function modelCalls(h: AgentHarness, name: string, input: unknown = {}, said = 'Alu 干活'): Promise<{ content: string; isError: boolean }> {
  return lineCalls(h, 'work', name, input, said)
}

/** 同上，哪条线的模型来调由 line 定：对话线是被 Steve 的一句话叫醒的，干活线是对话线把这句话交过来的。 */
export async function lineCalls(h: AgentHarness, line: LineName, name: string, input: unknown = {}, said = 'Alu 干活'): Promise<{ content: string; isError: boolean }> {
  const llm = line === 'talk' ? h.talk : h.llm
  const before = llm.requests.length
  llm.enqueue(reply('', [{ id: `c${line}${before}`, name, input }]), reply(''))
  h.agent.handleEvent(line === 'talk' ? chat('Steve', said) : told(said))
  await waitFor(`the ${line} model saw the result of ${name}`, () => llm.requests.length >= before + 2)
  const messages = llm.requests[before + 1]!.messages
  const part = messages[messages.length - 1]!.content.find((p) => p.type === 'tool_result' && p.toolCallId === `c${line}${before}`)
  await h.agent.whenIdle()
  return part && part.type === 'tool_result' ? { content: part.content, isError: part.isError === true } : { content: '', isError: true }
}

/** 两条线之间的往来（活动日志里 kind: relay 的那些），可以只要某一种。 */
export function relays(h: AgentHarness, type?: NonNullable<ActivityEntry['relay']>['type']): ActivityEntry[] {
  return h.log.recent(0, 500).filter((e) => e.kind === 'relay' && (type === undefined || e.relay?.type === type))
}

/** 干活线送给对话线的话（汇报、提问、一轮结束留下的、出了状况），按先后。 */
export function sentToTalk(h: AgentHarness): string[] {
  return relays(h)
    .filter((e) => e.relay?.from === 'work')
    .map((e) => e.detail ?? e.text.replace(/^干活线 → 对话线（[^）]*）：/, ''))
}

/**
 * 对话线交给干活线的一件事（tell_worker 之后干活线收到的那个事件）。默认附着 Steve 的原话：就是这句 text。
 * said 给空数组就是“对话线自己的决定，没有人说话”。
 */
export function told(text: string, said: SaidEvent[] = [chat('Steve', text)], time = Date.now()): Extract<AgentEvent, { type: 'told' }> {
  return { type: 'told', time, text, said }
}

export function chat(player: string, message: string, time = Date.now()) {
  return { type: 'chat' as const, time, player, message, isBot: false }
}

export function taskEnded(id: string, state: 'done' | 'failed' | 'canceled', extra: Json = {}, time = Date.now()) {
  return { type: 'task_ended' as const, time, task: { id, type: 'flatten', state, finishedAt: time, ...extra } }
}

/**
 * 检查一份消息列表里工具调用和结果是否成对：
 * 每条带工具调用的 assistant 消息后面紧跟一条 user 消息，里面正好有这些调用的结果；没有多出来的结果。
 */
export function assertToolPairs(messages: readonly Message[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role === 'assistant') {
      const ids = m.content.filter((p) => p.type === 'tool_call').map((p) => p.id)
      if (ids.length === 0) continue
      const next = messages[i + 1]
      if (!next || next.role !== 'user') throw new Error(`tool calls ${ids.join(',')} at message ${i} are not followed by a user message`)
      const got = next.content.filter((p) => p.type === 'tool_result').map((p) => p.toolCallId)
      if (JSON.stringify([...got].sort()) !== JSON.stringify([...ids].sort())) {
        throw new Error(`tool calls ${ids.join(',')} at message ${i} got results ${got.join(',')}`)
      }
    } else {
      const results = m.content.filter((p) => p.type === 'tool_result')
      if (results.length === 0) continue
      const prev = messages[i - 1]
      const ids = prev && prev.role === 'assistant' ? prev.content.filter((p) => p.type === 'tool_call').map((p) => p.id) : []
      for (const r of results) {
        if (!ids.includes(r.toolCallId)) throw new Error(`tool result ${r.toolCallId} at message ${i} has no matching call before it`)
      }
    }
  }
}

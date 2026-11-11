// agent 测试用的装配：假的 bridge（内存里按方法名应答）、按脚本回应的假模型、真的 store 和工具。
// 这里只隔开两个外部边界：游戏（Requester）和模型（LlmClient）。

import path from 'node:path'
import { Agent } from '../src/agent/agent.ts'
import type { AgentSettings, AgentTiming, PersistedAgentState } from '../src/agent/agent.ts'
import type { RoutineLimits } from '../src/agent/routine.ts'
import type { DesignWorkspace } from '../src/design/index.ts'
import type { PackData } from '../src/packdata/index.ts'
import { BridgeApi } from '../src/bridge/api.ts'
import type { Requester } from '../src/bridge/api.ts'
import { BridgeError } from '../src/bridge/protocol.ts'
import { LlmError } from '../src/llm/index.ts'
import type { AssistantPart, GenerateRequest, GenerateResult, LlmClient, Message } from '../src/llm/index.ts'
import { ActivityLog } from '../src/store/activity-log.ts'
import type { FeedbackStore } from '../src/store/feedback.ts'
import { HistoryStore } from '../src/store/history.ts'
import { ManualStore } from '../src/store/manuals.ts'
import { MemoryStore } from '../src/store/memory.ts'
import { ALL_TOOLS } from '../src/tools/index.ts'
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

/** 按脚本回应的假模型。脚本用完后一律回空文本（结束这一轮）。 */
export class ScriptedLlm implements LlmClient {
  readonly requests: GenerateRequest[] = []
  readonly script: Scripted[] = []
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
      return out ?? reply('')
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
  agent: Agent
  game: FakeGame
  llm: ScriptedLlm
  history: HistoryStore
  memory: MemoryStore
  /** 默认手册是随代码发布的那几本；主人写的放在这次测试的临时目录里。 */
  manuals: ManualStore
  log: ActivityLog
  settings: AgentSettings
  reminders: { dueAt: number; note: string }[]
  persisted: { state: PersistedAgentState | undefined }
  usedTokens: { value: number }
  /** 用同一份落盘数据、同一个假游戏和假模型再造一个 agent（模拟进程重启）。 */
  restart(overrides?: MakeAgentOptions): AgentHarness
  cleanup(): void
}

export interface MakeAgentOptions {
  settings?: Partial<AgentSettings>
  timing?: Partial<AgentTiming>
  noModel?: boolean
  dir?: string
  persisted?: { state: PersistedAgentState | undefined }
  game?: FakeGame
  llm?: ScriptedLlm
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
}

export function makeAgent(opts: MakeAgentOptions = {}): AgentHarness {
  const tmp = opts.dir ? { dir: opts.dir, cleanup: () => {} } : tmpDir()
  const settings: AgentSettings = { ...BASE_SETTINGS, ...(opts.settings ?? {}) }
  const game = opts.game ?? new FakeGame()
  const llm = opts.llm ?? new ScriptedLlm()
  const history = new HistoryStore(tmp.dir)
  const memory = new MemoryStore(tmp.dir, () => 4000)
  const manuals = new ManualStore(DEFAULT_MANUALS_DIR, path.join(tmp.dir, 'manuals'))
  const log = new ActivityLog()
  const reminders: { dueAt: number; note: string }[] = []
  const persisted = opts.persisted ?? { state: undefined }
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
  const agent = new Agent({
    settings: () => settings,
    llm: () => (opts.noModel ? undefined : llm),
    bridge: new BridgeApi(game),
    tools: ALL_TOOLS,
    memory,
    manuals,
    reminders: {
      add: (dueAt, note) => {
        reminders.push({ dueAt, note })
        return { id: `r${reminders.length}`, dueAt }
      },
      list: () => reminders,
    },
    history,
    log,
    todayTokens: () => usedTokens.value,
    persist: { load: () => persisted.state, save: (s) => (persisted.state = structuredClone(s)) },
    timing,
    ...(opts.feedback ? { feedback: opts.feedback, versions: () => ({ brain: 'brain-under-test', mod: 'mod-under-test' }) } : {}),
    canSeeImages: () => opts.vision === true,
    ...(opts.pictures ? { pictures: opts.pictures } : {}),
    ...(opts.design ? { design: opts.design } : {}),
    ...(opts.routineLimits ? { routineLimits: opts.routineLimits } : {}),
    ...(opts.packdata ? { packdata: opts.packdata } : {}),
  })
  agent.start()
  const harness: AgentHarness = {
    agent,
    game,
    llm,
    history,
    memory,
    manuals,
    log,
    settings,
    reminders,
    persisted,
    usedTokens,
    restart: (overrides = {}) => makeAgent({ ...opts, ...overrides, dir: tmp.dir, persisted, game, llm }),
    cleanup: tmp.cleanup,
  }
  return harness
}

/**
 * 让模型在一轮里调一个工具（有人跟它说了句话 → 它调这个工具 → 看到结果 → 结束这一轮），返回它看到的那个结果。
 * 走的是 agent 的整条路：工具清单按当前模型给，调用经 runTool，结果照“单个工具结果上限”截。
 */
export async function modelCalls(h: AgentHarness, name: string, input: unknown = {}, said = 'Alu 干活'): Promise<{ content: string; isError: boolean }> {
  const before = h.llm.requests.length
  h.llm.enqueue(reply('', [{ id: `c${before}`, name, input }]), reply(''))
  h.agent.handleEvent(chat('Steve', said))
  await waitFor(`the model saw the result of ${name}`, () => h.llm.requests.length >= before + 2)
  const messages = h.llm.requests[before + 1]!.messages
  const part = messages[messages.length - 1]!.content.find((p) => p.type === 'tool_result' && p.toolCallId === `c${before}`)
  await h.agent.whenIdle()
  return part && part.type === 'tool_result' ? { content: part.content, isError: part.isError === true } : { content: '', isError: true }
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

// 模拟模型服务：同时会说 OpenAI chat completions 和 Anthropic messages 两种线格式，按脚本回应。
//   OpenAI 兼容：   baseUrl = http://127.0.0.1:<port>/v1   → POST /v1/chat/completions
//   Anthropic 兼容：baseUrl = http://127.0.0.1:<port>      → POST /v1/messages
// 也能独立运行（npm run mock-llm -- [--port 25601]），那时用一套很傻的固定规则回应，只为了手动看面板。

import http from 'node:http'
import { MOCK_LLM_DEFAULT_PORT, checkMockPort } from './ports.ts'

export interface MockToolCall {
  name: string
  input?: unknown
  id?: string
  /** OpenAI：把 function.arguments 原样设成这个字符串（用来模拟坏 JSON）。 */
  rawArguments?: string
}

export interface MockReply {
  text?: string
  toolCalls?: MockToolCall[]
  /** Anthropic：放在最前面的 thinking 块；OpenAI：变成 reasoning_content。 */
  thinking?: { thinking: string; signature: string }
  /** Anthropic：redacted_thinking 块的 data。 */
  redactedThinking?: string
  /** 覆盖结束原因（OpenAI 的 finish_reason / Anthropic 的 stop_reason）。 */
  stop?: string
  usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  /** 返回这个 HTTP 状态的错误。 */
  status?: number
  errorType?: string
  errorMessage?: string
  headers?: Record<string, string>
  delayMs?: number
  /** 一直不回应，直到对方断开。 */
  hang?: boolean
  /** 原样作为响应体（用来模拟不合规的服务）。 */
  rawBody?: string
}

export interface RecordedLlmRequest {
  api: 'openai' | 'anthropic'
  /** 收到请求的时刻（epoch ms）。 */
  at: number
  path: string
  headers: http.IncomingHttpHeaders
  /** 请求体，任意 JSON。 */
  body: any
}

export type Responder = (req: RecordedLlmRequest) => MockReply

/**
 * 像真实接口那样检查请求里的消息格式；不合规时返回原因（真实接口会回 400）。
 * 只查会让真实接口拒绝请求的那几条：角色顺序、工具调用和结果的配对、空内容。
 */
export function validateRequest(api: 'openai' | 'anthropic', body: any): string | undefined {
  const messages: any[] = Array.isArray(body?.messages) ? body.messages : []
  if (typeof body?.model !== 'string' || body.model.length === 0) return 'model is required'
  if (messages.length === 0) return 'messages must not be empty'

  if (api === 'anthropic') {
    if (typeof body.max_tokens !== 'number') return 'max_tokens is required'
    if (messages[0].role !== 'user') return 'first message must use the user role'
    let pending: string[] = []
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (i > 0 && messages[i - 1].role === m.role) return `messages.${i}: roles must alternate between user and assistant`
      const blocks: any[] = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
      if (blocks.length === 0) return `messages.${i}: content must not be empty`
      for (const b of blocks) if (b.type === 'text' && (typeof b.text !== 'string' || b.text.trim().length === 0)) return `messages.${i}: text content blocks must contain non-whitespace text`
      if (m.role === 'assistant') {
        if (pending.length > 0) return `messages.${i}: tool_use ids ${pending.join(', ')} were not followed by tool_result blocks`
        pending = blocks.filter((b) => b.type === 'tool_use').map((b) => b.id)
      } else {
        const results = blocks.filter((b) => b.type === 'tool_result')
        for (const r of results) if (!pending.includes(r.tool_use_id)) return `messages.${i}: unexpected tool_use_id ${r.tool_use_id} in tool_result; no matching tool_use in the previous message`
        const missing = pending.filter((id) => !results.some((r) => r.tool_use_id === id))
        if (missing.length > 0) return `messages.${i}: tool_use ids ${missing.join(', ')} were found without tool_result blocks immediately after`
        // tool_result 必须排在这条消息的最前面
        const firstOther = blocks.findIndex((b) => b.type !== 'tool_result')
        if (firstOther !== -1 && blocks.slice(firstOther).some((b) => b.type === 'tool_result')) return `messages.${i}: tool_result blocks must come first in the user message`
        pending = []
      }
    }
    return undefined
  }

  let pending: string[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'tool') {
      if (!pending.includes(m.tool_call_id)) return `messages.${i}: a tool message must follow an assistant message with a matching tool_call (${m.tool_call_id})`
      pending = pending.filter((id) => id !== m.tool_call_id)
      continue
    }
    if (pending.length > 0) return `messages.${i}: an assistant message with tool_calls must be followed by tool messages for ${pending.join(', ')}`
    if (m.role === 'assistant') {
      const calls: any[] = Array.isArray(m.tool_calls) ? m.tool_calls : []
      if (calls.length === 0 && (m.content === null || m.content === undefined || m.content === '')) return `messages.${i}: assistant message needs content or tool_calls`
      for (const c of calls) {
        if (typeof c.function?.arguments !== 'string') return `messages.${i}: tool call arguments must be a string`
        try {
          JSON.parse(c.function.arguments)
        } catch {
          return `messages.${i}: tool call arguments must be valid JSON`
        }
      }
      pending = calls.map((c) => c.id)
    } else if (m.role !== 'user' && m.role !== 'system' && m.role !== 'developer') {
      return `messages.${i}: unknown role ${String(m.role)}`
    }
  }
  if (pending.length > 0) return `tool_calls ${pending.join(', ')} were never answered by tool messages`
  return undefined
}

export class MockLlm {
  port = 0
  readonly requests: RecordedLlmRequest[] = []
  /** 脚本用完之后怎么回。默认回一句纯文本。 */
  fallback: Responder = () => ({ text: 'ok' })
  /** 像真实接口那样拒绝格式不对的请求（400，不消耗脚本）。默认开。 */
  strict = true
  /** 被拒绝的请求和原因。 */
  readonly rejected: { api: string; reason: string }[] = []
  private readonly script: (MockReply | Responder)[] = []
  private server: http.Server | undefined
  private callId = 1

  get openaiBaseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }

  get anthropicBaseUrl(): string {
    return `http://127.0.0.1:${this.port}`
  }

  /** 按顺序排入回应；每个请求消耗一个。 */
  enqueue(...replies: (MockReply | Responder)[]): this {
    this.script.push(...replies)
    return this
  }

  get remaining(): number {
    return this.script.length
  }

  /** 把还没用掉的脚本清掉，返回清掉了几条。 */
  clearScript(): number {
    return this.script.splice(0).length
  }

  start(port = 0): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        this.server = server
        this.port = (server.address() as { port: number }).port
        resolve(this.port)
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    return new Promise((resolve) => {
      if (!server) return resolve()
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const path = (req.url ?? '').split('?')[0] ?? ''
    const api = path.endsWith('/chat/completions') ? 'openai' : path.endsWith('/messages') ? 'anthropic' : undefined
    if (req.method !== 'POST' || !api) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: `mock llm: no route ${req.method} ${path}` } }))
      return
    }
    let body: unknown = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* 留空 */
    }
    const record: RecordedLlmRequest = { api, at: Date.now(), path, headers: req.headers, body }
    this.requests.push(record)

    if (this.strict) {
      const reason = validateRequest(api, body)
      if (reason) {
        this.rejected.push({ api, reason })
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(api === 'openai' ? { error: { message: reason, type: 'invalid_request_error', code: null } } : { type: 'error', error: { type: 'invalid_request_error', message: reason } }))
        return
      }
    }

    const next = this.script.shift() ?? this.fallback
    const reply = typeof next === 'function' ? next(record) : next
    if (reply.hang) return
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
    if (res.destroyed) return

    const headers = { 'content-type': 'application/json', ...(reply.headers ?? {}) }
    if (reply.rawBody !== undefined) {
      res.writeHead(reply.status ?? 200, headers)
      res.end(reply.rawBody)
      return
    }
    if (reply.status !== undefined && reply.status >= 300) {
      const message = reply.errorMessage ?? `mock error ${reply.status}`
      const payload =
        api === 'openai'
          ? { error: { message, type: reply.errorType ?? 'mock_error', code: reply.errorType ?? null } }
          : { type: 'error', error: { type: reply.errorType ?? 'api_error', message } }
      res.writeHead(reply.status, headers)
      res.end(JSON.stringify(payload))
      return
    }
    res.writeHead(200, headers)
    res.end(JSON.stringify(api === 'openai' ? this.openaiBody(record, reply) : this.anthropicBody(record, reply)))
  }

  private openaiBody(req: RecordedLlmRequest, reply: MockReply): unknown {
    const calls = (reply.toolCalls ?? []).map((c) => ({
      id: c.id ?? `call_${this.callId++}`,
      type: 'function',
      function: { name: c.name, arguments: c.rawArguments ?? JSON.stringify(c.input ?? {}) },
    }))
    const message: Record<string, unknown> = { role: 'assistant', content: reply.text ?? null }
    if (calls.length > 0) message.tool_calls = calls
    if (reply.thinking) message.reasoning_content = reply.thinking.thinking
    const u = reply.usage ?? {}
    return {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: req.body?.model ?? 'mock',
      choices: [{ index: 0, message, finish_reason: reply.stop ?? (calls.length > 0 ? 'tool_calls' : 'stop') }],
      usage: {
        prompt_tokens: u.input ?? 100,
        completion_tokens: u.output ?? 20,
        total_tokens: (u.input ?? 100) + (u.output ?? 20),
        ...(u.cacheRead !== undefined ? { prompt_tokens_details: { cached_tokens: u.cacheRead } } : {}),
      },
    }
  }

  private anthropicBody(req: RecordedLlmRequest, reply: MockReply): unknown {
    const content: unknown[] = []
    if (reply.thinking) content.push({ type: 'thinking', thinking: reply.thinking.thinking, signature: reply.thinking.signature })
    if (reply.redactedThinking !== undefined) content.push({ type: 'redacted_thinking', data: reply.redactedThinking })
    if (reply.text) content.push({ type: 'text', text: reply.text })
    for (const c of reply.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: c.id ?? `toolu_${this.callId++}`, name: c.name, input: c.input ?? {} })
    }
    const u = reply.usage ?? {}
    return {
      id: 'msg_mock',
      type: 'message',
      role: 'assistant',
      model: req.body?.model ?? 'mock',
      content,
      stop_reason: reply.stop ?? ((reply.toolCalls ?? []).length > 0 ? 'tool_use' : 'end_turn'),
      stop_sequence: null,
      usage: {
        input_tokens: u.input ?? 100,
        output_tokens: u.output ?? 20,
        ...(u.cacheRead !== undefined ? { cache_read_input_tokens: u.cacheRead } : {}),
        ...(u.cacheWrite !== undefined ? { cache_creation_input_tokens: u.cacheWrite } : {}),
      },
    }
  }
}

// ── 独立运行：一套固定规则，假装是个模型 ──

/** 取出请求里最后一条 user 消息的文字和“是不是刚拿到工具结果”，两种线格式都认。 */
function lastUserTurn(req: RecordedLlmRequest): { text: string; afterTool: boolean } {
  const messages: any[] = Array.isArray(req.body?.messages) ? req.body.messages : []
  const last = messages[messages.length - 1]
  if (!last) return { text: '', afterTool: false }
  if (req.api === 'openai') {
    return { text: typeof last.content === 'string' ? last.content : '', afterTool: last.role === 'tool' }
  }
  const blocks: any[] = Array.isArray(last.content) ? last.content : []
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    afterTool: blocks.some((b) => b.type === 'tool_result'),
  }
}

export const demoResponder: Responder = (req) => {
  const { text, afterTool } = lastUserTurn(req)
  if (afterTool) return { text: '' }
  if (!Array.isArray(req.body?.tools) || req.body.tools.length === 0) return { text: 'pong' }
  const todo = text.split('[最近发生的事')[0]?.split('[当前状态]')[0] ?? ''
  if (/完成了/.test(todo)) return { toolCalls: [{ name: 'say', input: { message: '搞定了。' } }] }
  if (/失败了/.test(todo)) return { toolCalls: [{ name: 'say', input: { message: '刚才那个活没干成，你来看看？' } }] }
  if (/平/.test(todo)) {
    return {
      toolCalls: [
        { name: 'say', input: { message: '好，我把脚下这块 8×8 平到 y=64。' } },
        { name: 'flatten_area', input: { x1: 6, z1: -8, x2: 13, z2: -1, y: 64 } },
      ],
    }
  }
  if (/跟/.test(todo)) return { toolCalls: [{ name: 'follow_player', input: { player: 'Steve' } }] }
  if (/停/.test(todo)) return { toolCalls: [{ name: 'cancel_task', input: {} }, { name: 'say', input: { message: '停了。' } }] }
  if (/看看|周围/.test(todo)) return { toolCalls: [{ name: 'look_around', input: {} }] }
  return { toolCalls: [{ name: 'say', input: { message: '我是模拟模型，只认得“平”“跟”“停”“看看”这几个字。' } }] }
}

if (import.meta.main) {
  const i = process.argv.indexOf('--port')
  const llm = new MockLlm()
  llm.fallback = demoResponder
  const wantPort = Number(i !== -1 ? process.argv[i + 1] : (process.env.MOCK_LLM_PORT ?? MOCK_LLM_DEFAULT_PORT))
  checkMockPort(wantPort, '模拟模型服务')
  const port = await llm.start(wantPort)
  console.log(`模拟模型服务在 127.0.0.1:${port} 监听。在面板的“模型”页添加：`)
  console.log(`  OpenAI 兼容：   服务地址 ${llm.openaiBaseUrl}   key 随便填，模型名随便填`)
  console.log(`  Anthropic 兼容：服务地址 ${llm.anthropicBaseUrl}        key 随便填，模型名随便填`)
  console.log('它不是模型，只按几条固定规则回应（平/跟/停/看看）。')
  let printed = 0
  setInterval(() => {
    while (printed < llm.requests.length) {
      const r = llm.requests[printed++]!
      console.log(`收到 ${r.api} 请求，model=${r.body?.model}，${Array.isArray(r.body?.messages) ? r.body.messages.length : 0} 条消息`)
    }
  }, 300)
}

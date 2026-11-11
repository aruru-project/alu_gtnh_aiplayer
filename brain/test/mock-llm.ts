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

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

/** 一张图的内容对不对：base64 能解、文件头和它声称的类型对得上。真实接口对不上时回 400（“Could not process image”）。 */
function checkImage(mediaType: unknown, data: unknown): string | undefined {
  if (typeof mediaType !== 'string' || !IMAGE_TYPES.includes(mediaType)) return `unsupported image media type ${String(mediaType)}`
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return 'image data is not valid base64'
  const bytes = Buffer.from(data, 'base64')
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8
  if ((mediaType === 'image/png' && !png) || (mediaType === 'image/jpeg' && !jpeg)) return 'Could not process image'
  return undefined
}

const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/s

/** OpenAI 的一条消息内容：字符串，或者一组分段（文字、图片）。图片只有 user 消息能带。 */
function checkOpenAiContent(m: any, i: number): string | undefined {
  if (!Array.isArray(m.content)) return undefined
  if (m.content.length === 0) return `messages.${i}: content must not be an empty array`
  for (const part of m.content) {
    if (part?.type === 'text') {
      if (typeof part.text !== 'string' || part.text.length === 0) return `messages.${i}: text content parts must not be empty`
    } else if (part?.type === 'image_url') {
      if (m.role !== 'user') return `messages.${i}: image_url content parts are only allowed in messages with the user role`
      const url = part.image_url?.url
      const data = typeof url === 'string' ? DATA_URL.exec(url) : null
      if (!data) return `messages.${i}: image_url.url must be a data URL (this mock does not fetch remote images)`
      const bad = checkImage(data[1], data[2])
      if (bad) return `messages.${i}: ${bad}`
    } else {
      return `messages.${i}: unknown content part type ${String(part?.type)}`
    }
  }
  return undefined
}

/** Anthropic 的一个图片块。 */
function checkAnthropicImage(block: any, where: string): string | undefined {
  const source = block.source
  if (source?.type !== 'base64') return `${where}: image.source.type must be base64 (this mock does not fetch remote images)`
  const bad = checkImage(source.media_type, source.data)
  return bad ? `${where}: ${bad}` : undefined
}

/** 一次请求里带的全部图片（两种线格式都认）：类型和文件内容。 */
export function imagesInRequest(req: RecordedLlmRequest): { mediaType: string; bytes: Buffer }[] {
  const out: { mediaType: string; bytes: Buffer }[] = []
  const messages: any[] = Array.isArray(req.body?.messages) ? req.body.messages : []
  const anthropic = (block: any): void => {
    if (block?.type === 'image' && block.source?.type === 'base64') out.push({ mediaType: block.source.media_type, bytes: Buffer.from(block.source.data, 'base64') })
    if (block?.type === 'tool_result' && Array.isArray(block.content)) block.content.forEach(anthropic)
  }
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (req.api === 'anthropic') anthropic(part)
      else if (part?.type === 'image_url') {
        const data = DATA_URL.exec(part.image_url?.url ?? '')
        if (data) out.push({ mediaType: data[1]!, bytes: Buffer.from(data[2]!, 'base64') })
      }
    }
  }
  return out
}

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
      for (const b of blocks) {
        if (b.type === 'image') {
          if (m.role !== 'user') return `messages.${i}: image blocks are only allowed in user messages`
          const bad = checkAnthropicImage(b, `messages.${i}`)
          if (bad) return bad
        }
        // tool_result 的内容：一个字符串，或者一组文字块和图片块
        if (b.type === 'tool_result' && Array.isArray(b.content)) {
          for (const inner of b.content) {
            if (inner?.type === 'text') {
              if (typeof inner.text !== 'string' || inner.text.trim().length === 0) return `messages.${i}: text blocks in a tool_result must contain non-whitespace text`
            } else if (inner?.type === 'image') {
              const bad = checkAnthropicImage(inner, `messages.${i}.tool_result`)
              if (bad) return bad
            } else {
              return `messages.${i}: a tool_result may only contain text and image blocks`
            }
          }
        }
      }
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
    const badContent = checkOpenAiContent(m, i)
    if (badContent) return badContent
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
  /**
   * “列出模型”接口（GET …/models）回什么：一个列表，或者一个错误。两种线格式共用这一份，
   * 按请求带没带 anthropic-version 头决定回哪家的形状。
   */
  modelList: { id: string; displayName?: string }[] | { status: number; message: string; rawBody?: string } = [{ id: 'gpt-mock' }, { id: 'claude-mock', displayName: 'Claude Mock' }]
  /** 收到的“列出模型”请求：路径、查询串和请求头。 */
  readonly modelListRequests: { path: string; query: string; headers: http.IncomingHttpHeaders }[] = []
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
    if (req.method === 'GET' && path.endsWith('/models')) {
      this.listModels(req, res, path)
      return
    }
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

  /** GET …/models：OpenAI 回 {object:'list', data:[{id}]}；Anthropic 回 {data:[{id, display_name}], has_more}。 */
  private listModels(req: http.IncomingMessage, res: http.ServerResponse, path: string): void {
    const anthropic = req.headers['anthropic-version'] !== undefined
    this.modelListRequests.push({ path, query: (req.url ?? '').split('?')[1] ?? '', headers: req.headers })
    const list = this.modelList
    if (!Array.isArray(list)) {
      res.writeHead(list.status, { 'content-type': 'application/json' })
      res.end(list.rawBody ?? JSON.stringify(anthropic ? { type: 'error', error: { type: 'not_found_error', message: list.message } } : { error: { message: list.message, type: 'invalid_request_error', code: null } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify(
        anthropic
          ? { data: list.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName ?? m.id, created_at: '2026-01-01T00:00:00Z' })), has_more: false, first_id: list[0]?.id ?? null, last_id: list.at(-1)?.id ?? null }
          : { object: 'list', data: list.map((m) => ({ id: m.id, object: 'model', created: 1_700_000_000, owned_by: 'mock' })) },
      ),
    )
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
    // 工具结果带图时，图在紧跟着的一条 user 消息里（内容是分段的）
    if (Array.isArray(last.content)) {
      const text = last.content.filter((part: any) => part?.type === 'text').map((part: any) => part.text).join('\n')
      return { text, afterTool: messages[messages.length - 2]?.role === 'tool' }
    }
    return { text: typeof last.content === 'string' ? last.content : '', afterTool: last.role === 'tool' }
  }
  const blocks: any[] = Array.isArray(last.content) ? last.content : []
  return {
    text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    afterTool: blocks.some((b) => b.type === 'tool_result'),
  }
}

/** 请求的系统提示词（两种线格式都认）。 */
function systemOf(req: RecordedLlmRequest): string {
  if (req.api === 'anthropic') return typeof req.body?.system === 'string' ? req.body.system : JSON.stringify(req.body?.system ?? '')
  const first = (Array.isArray(req.body?.messages) ? req.body.messages : [])[0]
  return first && (first.role === 'system' || first.role === 'developer') ? (typeof first.content === 'string' ? first.content : JSON.stringify(first.content)) : ''
}

/** 这次请求是对话线发的（它的系统提示词里写着“你是对话线”）。 */
export function isTalkLine(req: RecordedLlmRequest): boolean {
  return systemOf(req).includes('# 你是对话线')
}

/** “需要你处理的事”里的各件事（开头的、和做上一步时新到的），去掉时间。一件事可以有好几行。 */
function thingsToHandle(text: string): string[] {
  const out: string[] = []
  for (const section of text.split(/\n\n(?=\[)/)) {
    if (!section.startsWith('[需要你处理的事')) continue
    const body = section.slice(section.indexOf('\n') + 1)
    out.push(...body.split(/^\[(?:\d+月\d+日 )?\d\d:\d\d:\d\d\] /m).map((part) => part.trim()).filter((part) => part.length > 0))
  }
  return out
}

/**
 * 只会传话的对话线（两条线的端到端场景里，要证明的是干活线怎么干活时用它）：
 * 有人说话 → 原样交给干活线（tell_worker），自己不出声；干活线送来的话（汇报、提问、做完留下的、出了状况）→ 说给人听。
 * whisperTo 给了就用悄悄话说给这个玩家，不给就在公共聊天里说（对话线写的文字就是它说的话）。
 */
export function talkRelay(opts: { whisperTo?: string } = {}): Responder {
  return (req) => {
    if (!Array.isArray(req.body?.tools) || req.body.tools.length === 0) return { text: 'pong' }
    const { text } = lastUserTurn(req)
    const toolCalls: MockToolCall[] = []
    const say: string[] = []
    for (const thing of thingsToHandle(text)) {
      const fromWorker = /^干活线(?:汇报：|提问（[^）]*）：|停下来了（[^）]*），它留下的话：|出了状况（[^）]*）：)([\s\S]*)$/.exec(thing)
      const said = /^(?:\S+(?:（另一个 bot）)? 说：|\S+ 私聊你：|主人通过控制面板对你说：)([^\n]*)/.exec(thing)
      if (fromWorker) {
        if (opts.whisperTo !== undefined) toolCalls.push({ name: 'whisper', input: { player: opts.whisperTo, message: fromWorker[1]! } })
        else say.push(fromWorker[1]!)
      } else if (said) {
        toolCalls.push({ name: 'tell_worker', input: { text: said[1]! } })
      }
    }
    return { ...(say.length > 0 ? { text: say.join(' ') } : {}), ...(toolCalls.length > 0 ? { toolCalls } : {}) }
  }
}

/** 独立运行时的假模型：对话线只传话；干活线认得“平”“跟”“停”“看看”这几个字。 */
export const demoResponder: Responder = (req) => {
  if (isTalkLine(req)) return talkRelay()(req)
  const { text, afterTool } = lastUserTurn(req)
  if (afterTool) return { text: '' }
  if (!Array.isArray(req.body?.tools) || req.body.tools.length === 0) return { text: 'pong' }
  const todo = text.split('[最近发生的事')[0]?.split('[当前状态]')[0] ?? ''
  if (/完成了/.test(todo)) return { text: '搞定了。' }
  if (/失败了/.test(todo)) return { text: '刚才那个活没干成，你来看看？' }
  if (/平/.test(todo)) {
    return {
      toolCalls: [
        { name: 'report', input: { text: '好，我把脚下这块 8×8 平到 y=64。' } },
        { name: 'flatten_area', input: { x1: 6, z1: -8, x2: 13, z2: -1, y: 64 } },
      ],
    }
  }
  if (/跟/.test(todo)) return { toolCalls: [{ name: 'follow_player', input: { player: 'Steve' } }] }
  if (/停/.test(todo)) return { toolCalls: [{ name: 'cancel_task', input: {} }] }
  if (/看看|周围/.test(todo)) return { toolCalls: [{ name: 'look_around', input: {} }] }
  return { text: '我是模拟模型，只认得“平”“跟”“停”“看看”这几个字。' }
}

if (import.meta.main) {
  const i = process.argv.indexOf('--port')
  const llm = new MockLlm()
  llm.fallback = demoResponder
  const wantPort = Number(i !== -1 ? process.argv[i + 1] : (process.env.MOCK_LLM_PORT ?? MOCK_LLM_DEFAULT_PORT))
  checkMockPort(wantPort, '模拟模型服务')
  const port = await llm.start(wantPort)
  console.log(`模拟模型服务在 127.0.0.1:${port} 监听。在面板“设置”里的“模型”页添加：`)
  console.log(`  OpenAI 兼容：   服务地址 ${llm.openaiBaseUrl}   key 随便填，模型名随便填`)
  console.log(`  Anthropic 兼容：服务地址 ${llm.anthropicBaseUrl}        key 随便填，模型名随便填`)
  console.log('它不是模型，只按几条固定规则回应：对话线只传话，干活线认得 平/跟/停/看看。两条线可以都选它。')
  let printed = 0
  setInterval(() => {
    while (printed < llm.requests.length) {
      const r = llm.requests[printed++]!
      console.log(`收到 ${r.api} 请求，model=${r.body?.model}，${Array.isArray(r.body?.messages) ? r.body.messages.length : 0} 条消息`)
    }
  }, 300)
}

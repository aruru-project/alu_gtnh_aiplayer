// OpenAI 兼容的 Chat Completions 接口：POST {baseUrl}/chat/completions
//
// 开关（ProviderConfig.options）：
//   maxTokensField   'max_tokens'（默认）| 'max_completion_tokens'
//   systemRole       'system'（默认）| 'developer'
//   replayReasoning  false（默认）| true —— 是否把响应里的 reasoning_content 等字段在后续请求里带回去

import { LlmError } from './errors.ts'
import { asNumber, asRecord, joinUrl, postJson } from './http.ts'
import { normalizeMessages } from './messages.ts'
import type {
  Adapter,
  AdapterDeps,
  AssistantPart,
  GenerateRequest,
  GenerateResult,
  LlmClient,
  ProviderConfig,
  StopReason,
  Usage,
} from './types.ts'

export const OPENAI_CHAT_KIND = 'openai-chat'

/** 各家兼容接口放“思考过程”的字段名。原样存进 OpaquePart。 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'reasoning_details'] as const

interface OpenAiOptions {
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  systemRole: 'system' | 'developer'
  replayReasoning: boolean
}

function readOptions(config: ProviderConfig): OpenAiOptions {
  const o = config.options ?? {}
  return {
    maxTokensField: o.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
    systemRole: o.systemRole === 'developer' ? 'developer' : 'system',
    replayReasoning: o.replayReasoning === true,
  }
}

export function openAiEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : joinUrl(trimmed, '/chat/completions')
}

type WireMessage = Record<string, unknown>

export function buildOpenAiBody(config: ProviderConfig, req: GenerateRequest): Record<string, unknown> {
  const options = readOptions(config)
  const wire: WireMessage[] = []
  if (req.system.trim().length > 0) wire.push({ role: options.systemRole, content: req.system })

  const messages = normalizeMessages(req.messages, {
    keepOpaque: (p) => options.replayReasoning && p.provider === OPENAI_CHAT_KIND,
  })
  for (const m of messages) {
    if (m.role === 'assistant') {
      const out: WireMessage = { role: 'assistant' }
      const text = m.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      const calls = m.content
        .filter((p) => p.type === 'tool_call')
        .map((p) => ({
          id: p.id,
          type: 'function',
          function: {
            name: p.name,
            // 参数当初就不是合法 JSON 的调用，回放时给一个空对象，免得接口校验不过。
            arguments: p.invalid ? '{}' : JSON.stringify(p.input ?? {}),
          },
        }))
      out.content = text.length > 0 ? text : null
      if (calls.length > 0) out.tool_calls = calls
      for (const p of m.content) {
        if (p.type !== 'opaque') continue
        const data = asRecord(p.data)
        if (data) Object.assign(out, data)
      }
      if (out.content === null && calls.length === 0) continue
      wire.push(out)
    } else {
      // normalizeMessages 已保证工具结果在前
      const texts: string[] = []
      for (const p of m.content) {
        if (p.type === 'tool_result') {
          wire.push({
            role: 'tool',
            tool_call_id: p.toolCallId,
            content: p.isError ? `ERROR: ${p.content}` : p.content,
          })
        } else {
          texts.push(p.text)
        }
      }
      if (texts.length > 0) wire.push({ role: 'user', content: texts.join('\n\n') })
    }
  }

  const body: Record<string, unknown> = { model: config.model, messages: wire }
  if (req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }))
    if (req.toolChoice) body.tool_choice = req.toolChoice
  }
  const maxTokens = req.maxOutputTokens ?? config.maxOutputTokens
  if (maxTokens !== undefined) body[options.maxTokensField] = maxTokens
  const temperature = req.temperature ?? config.temperature
  if (temperature !== undefined) body.temperature = temperature
  return { ...body, ...(config.extraBody ?? {}) }
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = asRecord(part)
        return p && typeof p.text === 'string' ? p.text : ''
      })
      .join('')
  }
  return ''
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): StopReason {
  if (reason === 'length') return 'max_tokens'
  // 有些兼容服务在带工具调用时仍然报 stop，所以以“有没有工具调用”为准
  if (hasToolCalls) return 'tool_use'
  if (reason === 'stop') return 'end'
  return 'other'
}

export function parseOpenAiResponse(json: unknown, config: ProviderConfig): GenerateResult {
  const root = asRecord(json) ?? {}
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = asRecord(choices[0])
  const msg = asRecord(choice?.message)
  if (!choice || !msg) {
    // 有的网关用 200 包一个错误
    const err = asRecord(root.error)
    const detail = err && typeof err.message === 'string' ? err.message : JSON.stringify(json).slice(0, 300)
    throw new LlmError('server', `response has no choices: ${detail}`)
  }

  const content: AssistantPart[] = []
  const reasoning: Record<string, unknown> = {}
  for (const field of REASONING_FIELDS) {
    const v = msg[field]
    if (v !== undefined && v !== null && v !== '') reasoning[field] = v
  }
  if (Object.keys(reasoning).length > 0) content.push({ type: 'opaque', provider: OPENAI_CHAT_KIND, data: reasoning })

  const text = contentToText(msg.content)
  if (text.length > 0) content.push({ type: 'text', text })

  const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
  let callCount = 0
  rawCalls.forEach((raw, index) => {
    const call = asRecord(raw)
    const fn = asRecord(call?.function)
    if (!call || !fn || typeof fn.name !== 'string') return
    callCount++
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : `call_${index}_${Date.now().toString(36)}`
    const args = fn.arguments
    if (args !== undefined && args !== null && typeof args === 'object') {
      // 个别兼容服务直接给对象
      content.push({ type: 'tool_call', id, name: fn.name, input: args })
      return
    }
    const rawArgs = typeof args === 'string' ? args : ''
    if (rawArgs.trim().length === 0) {
      content.push({ type: 'tool_call', id, name: fn.name, input: {} })
      return
    }
    try {
      content.push({ type: 'tool_call', id, name: fn.name, input: JSON.parse(rawArgs) })
    } catch (e) {
      content.push({
        type: 'tool_call',
        id,
        name: fn.name,
        input: {},
        invalid: { reason: e instanceof Error ? e.message : String(e), raw: rawArgs },
      })
    }
  })

  const u = asRecord(root.usage) ?? {}
  const usage: Usage = { inputTokens: asNumber(u.prompt_tokens), outputTokens: asNumber(u.completion_tokens) }
  const details = asRecord(u.prompt_tokens_details)
  if (details && typeof details.cached_tokens === 'number') usage.cacheReadTokens = details.cached_tokens

  return {
    message: { role: 'assistant', content },
    stopReason: mapFinishReason(choice.finish_reason, callCount > 0),
    usage,
    model: typeof root.model === 'string' && root.model.length > 0 ? root.model : config.model,
  }
}

function createOpenAiClient(config: ProviderConfig, deps: AdapterDeps): LlmClient {
  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const { json } = await postJson({
        fetch: deps.fetch,
        url: openAiEndpoint(config.baseUrl),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
          ...(config.extraHeaders ?? {}),
        },
        body: buildOpenAiBody(config, req),
        timeoutMs: config.timeoutMs,
        signal: req.signal,
      })
      return parseOpenAiResponse(json, config)
    },
  }
}

export const openaiChat: Adapter = {
  label: 'OpenAI 兼容（Chat Completions）',
  baseUrlExample: 'https://api.openai.com/v1',
  options: [
    {
      key: 'maxTokensField',
      description: '输出上限用哪个字段名。较新的 OpenAI 模型要 max_completion_tokens',
      type: 'enum',
      values: ['max_tokens', 'max_completion_tokens'],
      default: 'max_tokens',
    },
    {
      key: 'systemRole',
      description: '系统提示词用哪个角色发送',
      type: 'enum',
      values: ['system', 'developer'],
      default: 'system',
    },
    {
      key: 'replayReasoning',
      description: '把响应里的 reasoning_content 在后续请求里带回去（个别服务要求）',
      type: 'boolean',
      default: false,
    },
  ],
  create: createOpenAiClient,
}

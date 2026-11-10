// Anthropic 兼容的 Messages 接口：POST {baseUrl}/v1/messages
//
// 开关（ProviderConfig.options）：
//   authStyle          'x-api-key'（默认）| 'bearer' —— 第三方网关常用 Authorization: Bearer
//   promptCaching      true（默认）| false —— 给 system 和最后一个工具定义加 cache_control
//   cacheConversation  false（默认）| true —— 额外给最后一条消息加 cache_control，
//                      一轮里多步工具调用时前面的对话走缓存价。需要 promptCaching 开着。
//
// 图片：工具结果里的图直接放在 tool_result 的内容里（文字块后面跟图片块）；user 消息里的图是普通的图片块。

import { LlmError } from './errors.ts'
import { asNumber, asRecord, getJson, joinUrl, postJson } from './http.ts'
import { normalizeMessages } from './messages.ts'
import type {
  Adapter,
  AdapterDeps,
  AssistantPart,
  GenerateRequest,
  GenerateResult,
  ImageAttachment,
  LlmClient,
  ProviderConfig,
  RemoteModel,
  StopReason,
  Usage,
} from './types.ts'

export const ANTHROPIC_KIND = 'anthropic-messages'
/** 拉模型列表不该等很久：这只是填表时的一个方便。 */
const LIST_MODELS_TIMEOUT_MS = 15_000
export const ANTHROPIC_VERSION = '2023-06-01'
/** 接口要求必须给 max_tokens；配置和请求都没给时用这个。 */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

interface AnthropicOptions {
  authStyle: 'x-api-key' | 'bearer'
  promptCaching: boolean
  cacheConversation: boolean
}

function readOptions(config: ProviderConfig): AnthropicOptions {
  const o = config.options ?? {}
  const promptCaching = o.promptCaching !== false
  return {
    authStyle: o.authStyle === 'bearer' ? 'bearer' : 'x-api-key',
    promptCaching,
    cacheConversation: promptCaching && o.cacheConversation === true,
  }
}

export function anthropicEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (trimmed.endsWith('/v1/messages')) return trimmed
  if (trimmed.endsWith('/v1')) return joinUrl(trimmed, '/messages')
  return joinUrl(trimmed, '/v1/messages')
}

const CACHE_CONTROL = { type: 'ephemeral' } as const
type Block = Record<string, unknown>

function imageBlock(image: ImageAttachment): Block {
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }
}

export function buildAnthropicBody(config: ProviderConfig, req: GenerateRequest): Record<string, unknown> {
  const options = readOptions(config)

  // 格式约束（角色交替、结果紧跟调用、结果排在文本前、无空块）由 normalizeMessages 保证。
  // thinking / redacted_thinking 等 OpaquePart 留在原位置，原样写回。
  const messages = normalizeMessages(req.messages, { keepOpaque: (p) => p.provider === ANTHROPIC_KIND })
  const wire: { role: 'user' | 'assistant'; content: Block[] }[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const content: Block[] = []
      for (const p of m.content) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text })
        else if (p.type === 'tool_call') {
          const input = p.invalid ? {} : (asRecord(p.input) ?? {})
          content.push({ type: 'tool_use', id: p.id, name: p.name, input })
        } else {
          const block = asRecord(p.data)
          if (block) content.push(block)
        }
      }
      if (content.length > 0) wire.push({ role: 'assistant', content })
    } else {
      const content: Block[] = []
      for (const p of m.content) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text })
        else if (p.type === 'image') content.push(imageBlock(p.image))
        else {
          const images = p.images ?? []
          const block: Block = {
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            // 没有图时内容还是一个字符串（和以前一样）；有图时是文字块加图片块（文字块不能是空的）
            content: images.length === 0 ? p.content : [...(p.content.trim().length > 0 ? [{ type: 'text', text: p.content }] : []), ...images.map(imageBlock)],
          }
          if (p.isError) block.is_error = true
          content.push(block)
        }
      }
      wire.push({ role: 'user', content })
    }
  }
  // 接口要求第一条是 user
  if (wire.length === 0 || wire[0]!.role !== 'user') {
    wire.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] })
  }
  if (options.cacheConversation) {
    const last = wire[wire.length - 1]!
    const block = last.content[last.content.length - 1]
    if (last.role === 'user' && block) last.content[last.content.length - 1] = { ...block, cache_control: CACHE_CONTROL }
  }

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: req.maxOutputTokens ?? config.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: wire,
  }
  if (req.system.trim().length > 0) {
    body.system = options.promptCaching
      ? [{ type: 'text', text: req.system, cache_control: CACHE_CONTROL }]
      : req.system
  }
  if (req.tools.length > 0) {
    const tools: Block[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }))
    if (options.promptCaching) tools[tools.length - 1]!.cache_control = CACHE_CONTROL
    body.tools = tools
    if (req.toolChoice === 'auto') body.tool_choice = { type: 'auto' }
    else if (req.toolChoice === 'required') body.tool_choice = { type: 'any' }
    else if (req.toolChoice === 'none') body.tool_choice = { type: 'none' }
  }
  const temperature = req.temperature ?? config.temperature
  if (temperature !== undefined) body.temperature = temperature
  return { ...body, ...(config.extraBody ?? {}) }
}

function mapStopReason(reason: unknown): StopReason {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end'
  if (reason === 'tool_use') return 'tool_use'
  if (reason === 'max_tokens') return 'max_tokens'
  return 'other'
}

export function parseAnthropicResponse(json: unknown, config: ProviderConfig): GenerateResult {
  const root = asRecord(json) ?? {}
  if (!Array.isArray(root.content)) {
    const err = asRecord(root.error)
    const detail = err && typeof err.message === 'string' ? err.message : JSON.stringify(json).slice(0, 300)
    throw new LlmError('server', `response has no content: ${detail}`)
  }
  const content: AssistantPart[] = []
  for (const raw of root.content) {
    const block = asRecord(raw)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.length > 0) content.push({ type: 'text', text: block.text })
    } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
      content.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input ?? {} })
    } else {
      // thinking、redacted_thinking，以及以后新增的块类型：原样留着，回放时放回原位置。
      content.push({ type: 'opaque', provider: ANTHROPIC_KIND, data: block })
    }
  }

  const u = asRecord(root.usage) ?? {}
  const cacheRead = asNumber(u.cache_read_input_tokens)
  const cacheWrite = asNumber(u.cache_creation_input_tokens)
  // Anthropic 的 input_tokens 不含缓存读写，统一口径里要加回去。
  const usage: Usage = {
    inputTokens: asNumber(u.input_tokens) + cacheRead + cacheWrite,
    outputTokens: asNumber(u.output_tokens),
  }
  if (typeof u.cache_read_input_tokens === 'number') usage.cacheReadTokens = cacheRead
  if (typeof u.cache_creation_input_tokens === 'number') usage.cacheWriteTokens = cacheWrite

  return {
    message: { role: 'assistant', content },
    stopReason: mapStopReason(root.stop_reason),
    usage,
    model: typeof root.model === 'string' && root.model.length > 0 ? root.model : config.model,
  }
}

function createAnthropicClient(config: ProviderConfig, deps: AdapterDeps): LlmClient {
  const options = readOptions(config)
  return {
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      const auth: Record<string, string> =
        options.authStyle === 'bearer' ? { authorization: `Bearer ${config.apiKey}` } : { 'x-api-key': config.apiKey }
      const { json } = await postJson({
        fetch: deps.fetch,
        url: anthropicEndpoint(config.baseUrl),
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          ...auth,
          ...(config.extraHeaders ?? {}),
        },
        body: buildAnthropicBody(config, req),
        timeoutMs: config.timeoutMs,
        signal: req.signal,
      })
      return parseAnthropicResponse(json, config)
    },
  }
}

/** GET {baseUrl}/v1/models：Anthropic 的模型列表，形状是 {data:[{id, display_name}]}。第三方网关不一定有这个接口。 */
async function listAnthropicModels(config: ProviderConfig, deps: AdapterDeps & { signal?: AbortSignal }): Promise<RemoteModel[]> {
  const options = readOptions(config)
  const auth: Record<string, string> = options.authStyle === 'bearer' ? { authorization: `Bearer ${config.apiKey}` } : { 'x-api-key': config.apiKey }
  const { json } = await getJson({
    fetch: deps.fetch,
    url: `${anthropicEndpoint(config.baseUrl).replace(/\/messages$/, '/models')}?limit=1000`,
    headers: { 'anthropic-version': ANTHROPIC_VERSION, ...auth, ...(config.extraHeaders ?? {}) },
    timeoutMs: LIST_MODELS_TIMEOUT_MS,
    signal: deps.signal,
  })
  const data = asRecord(json)?.data
  if (!Array.isArray(data)) throw new LlmError('server', 'the response has no list of models')
  const models: RemoteModel[] = []
  for (const item of data) {
    const m = asRecord(item)
    if (typeof m?.id !== 'string' || m.id.length === 0) continue
    models.push(typeof m.display_name === 'string' && m.display_name.length > 0 && m.display_name !== m.id ? { id: m.id, label: m.display_name } : { id: m.id })
  }
  return models
}

export const anthropicMessages: Adapter = {
  label: 'Anthropic 兼容（Messages）',
  baseUrlExample: 'https://api.anthropic.com',
  options: [
    {
      key: 'authStyle',
      description: 'API key 放在哪个请求头。第三方网关常用 bearer',
      type: 'enum',
      values: ['x-api-key', 'bearer'],
      default: 'x-api-key',
      scope: 'provider',
    },
    {
      key: 'promptCaching',
      description: '给系统提示词和工具定义加缓存标记（省钱）',
      type: 'boolean',
      default: true,
    },
    {
      key: 'cacheConversation',
      description: '同时缓存对话历史：一轮里多步工具调用时更省。需要上一项开着',
      type: 'boolean',
      default: false,
    },
  ],
  create: createAnthropicClient,
  listModels: listAnthropicModels,
}

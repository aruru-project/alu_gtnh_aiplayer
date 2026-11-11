// 模型调用层对外的统一类型。这一层不知道 Minecraft，也不知道 agent。

import type { ProviderKind } from './registry.ts'

export interface TextPart {
  type: 'text'
  text: string
}

export interface ToolCallPart {
  type: 'tool_call'
  id: string
  name: string
  input: unknown
  /**
   * 模型给出的参数不是合法 JSON 时由适配器填写。上层不应执行这次调用，
   * 而是回一个 isError 的工具结果让模型重试。
   */
  invalid?: { reason: string; raw: string }
}

/** 一张给模型看的图。 */
export interface ImageAttachment {
  /** 这是什么图（一句话，给模型看）。图不再附带以后，原处留下的占位文字里用它。 */
  label: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  /** 文件内容，base64。 */
  data: string
}

/** user 消息里直接放的一张图。 */
export interface ImagePart {
  type: 'image'
  image: ImageAttachment
}

export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  content: string
  isError?: boolean
  /**
   * 工具结果带的图（简图、主人传的图片、截图……）。只有模型能看图时上层才会放。
   * 图很贵：只在产生它的那一轮里附带，之后换成一句占位文字（见 messages.ts 的 withoutImages / keepLatestImages）。
   */
  images?: ImageAttachment[]
}

/**
 * 某一家特有、必须原样回传的内容（例如 Anthropic 的 thinking 块）。
 * 只回放给产生它的同一种适配器（provider 等于适配器的 kind），其他适配器丢弃。
 */
export interface OpaquePart {
  type: 'opaque'
  provider: string
  data: unknown
}

export type UserPart = TextPart | ToolResultPart | ImagePart
export type AssistantPart = TextPart | ToolCallPart | OpaquePart

export type UserMessage = { role: 'user'; content: UserPart[] }
export type AssistantMessage = { role: 'assistant'; content: AssistantPart[] }
export type Message = UserMessage | AssistantMessage

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema */
  inputSchema: object
}

export interface GenerateRequest {
  system: string
  messages: Message[]
  tools: ToolSpec[]
  toolChoice?: 'auto' | 'required' | 'none'
  maxOutputTokens?: number
  /** 这次调用的输出至少要给这么多 token：模型配置的上限比它小（或者没配）时用它，配置得更大的照配置。 */
  minOutputTokens?: number
  /** 这次调用至少等这么久（毫秒）：模型配置的超时比它短（或者没配）时用它，配置得更长的照配置。写很长的东西的调用用。 */
  minTimeoutMs?: number
  /** 这次调用超时了不重试：同样的输入、同样的超时，再试结果一样。别的可重试的错照常重试。 */
  noRetryOnTimeout?: boolean
  temperature?: number
  signal?: AbortSignal
}

export interface Usage {
  /** 输入 token 总数，已包含缓存读写的部分（各家口径在适配器里统一成这个含义）。 */
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'other'

export interface GenerateResult {
  message: AssistantMessage
  stopReason: StopReason
  usage: Usage
  model: string
}

export interface LlmClient {
  generate(req: GenerateRequest): Promise<GenerateResult>
}

export interface ProviderConfig {
  id: string
  label: string
  kind: ProviderKind
  /** openai-chat 例: https://api.openai.com/v1   anthropic-messages 例: https://api.anthropic.com */
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
  extraHeaders?: Record<string, string>
  /** 浅合并进请求体，用来传各家特有参数 */
  extraBody?: Record<string, unknown>
  /** 适配器自己的开关，见各适配器文件 */
  options?: Record<string, unknown>
  /** 这个模型能看图。不是适配器的事（适配器见到图就发），是上层决定要不要把图放进消息。 */
  vision?: boolean
}

/** 每次成功调用后交给上层记账的记录。 */
export interface UsageRecord {
  providerId: string
  kind: string
  model: string
  usage: Usage
  durationMs: number
}

/** 面板用来渲染“适配器开关”的说明。 */
export interface AdapterOptionInfo {
  key: string
  description: string
  type: 'boolean' | 'enum'
  values?: string[]
  default: string | boolean
  /**
   * 这个开关跟着谁走：provider 是这一家接口的事（比如 key 放在哪个请求头），同一家下面的模型都一样；
   * model 是这个模型的事（比如输出上限用哪个字段名）。不写就是 model。
   */
  scope?: 'provider' | 'model'
}

/** 从接口拉到的一个可用模型。 */
export interface RemoteModel {
  /** 模型名：发请求时填的就是它。 */
  id: string
  /** 接口给的显示名，可能没有。 */
  label?: string
}

export interface AdapterDeps {
  /** 可替换的 fetch，默认用内置的。 */
  fetch?: typeof fetch
}

/** 一家接口的适配器。新增一家 = 写一个这样的对象并在 registry.ts 登记。 */
export interface Adapter {
  label: string
  baseUrlExample: string
  options: AdapterOptionInfo[]
  create(config: ProviderConfig, deps: AdapterDeps): LlmClient
  /** 问这一家接口有哪些模型。不是每家都有这个接口，没有的不写；拉不到时抛 LlmError。config.model 用不上。 */
  listModels?(config: ProviderConfig, deps: AdapterDeps & { signal?: AbortSignal }): Promise<RemoteModel[]>
}

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

export interface ToolResultPart {
  type: 'tool_result'
  toolCallId: string
  content: string
  isError?: boolean
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

export type UserPart = TextPart | ToolResultPart
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
}

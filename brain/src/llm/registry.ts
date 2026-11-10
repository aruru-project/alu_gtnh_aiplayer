// 适配器注册表。新增一家接口：在 llm/ 下加一个导出 Adapter 的文件，然后在 ADAPTERS 里加一行。
// ProviderKind 类型、面板里的“接口类型”下拉框都从这张表来，别处不用改。

import { anthropicMessages } from './anthropic-messages.ts'
import { LlmError } from './errors.ts'
import { openaiChat } from './openai-chat.ts'
import { withRetry } from './retry.ts'
import type { RetryOptions } from './retry.ts'
import type { Adapter, AdapterOptionInfo, GenerateRequest, LlmClient, ProviderConfig, UsageRecord } from './types.ts'

export const ADAPTERS = {
  'openai-chat': openaiChat,
  'anthropic-messages': anthropicMessages,
} satisfies Record<string, Adapter>

export type ProviderKind = keyof typeof ADAPTERS

export function isProviderKind(kind: unknown): kind is ProviderKind {
  return typeof kind === 'string' && Object.hasOwn(ADAPTERS, kind)
}

export interface AdapterInfo {
  kind: ProviderKind
  label: string
  baseUrlExample: string
  options: AdapterOptionInfo[]
}

export function listAdapters(): AdapterInfo[] {
  return (Object.keys(ADAPTERS) as ProviderKind[]).map((kind) => {
    const a: Adapter = ADAPTERS[kind]
    return { kind, label: a.label, baseUrlExample: a.baseUrlExample, options: a.options }
  })
}

export interface CreateClientOptions {
  /** 每次成功调用后收到用量，由上层记账。 */
  onUsage?: (record: UsageRecord) => void
  /** 重试参数；传 false 关掉重试（测试连接时用）。 */
  retry?: RetryOptions | false
  fetch?: typeof fetch
}

/** 按配置造一个可用的客户端：适配器 → 用量回调 → 重试。 */
export function createClient(config: ProviderConfig, opts: CreateClientOptions = {}): LlmClient {
  if (!isProviderKind(config.kind)) {
    throw new LlmError('bad_request', `unknown provider kind: ${String(config.kind)}`)
  }
  const adapter: Adapter = ADAPTERS[config.kind]
  const raw = adapter.create(config, opts.fetch ? { fetch: opts.fetch } : {})
  const metered: LlmClient = {
    async generate(req: GenerateRequest) {
      const started = performance.now()
      const result = await raw.generate(req)
      opts.onUsage?.({
        providerId: config.id,
        kind: config.kind,
        model: result.model,
        usage: result.usage,
        durationMs: Math.round(performance.now() - started),
      })
      return result
    },
  }
  return opts.retry === false ? metered : withRetry(metered, opts.retry ?? {})
}

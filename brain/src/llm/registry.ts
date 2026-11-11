// 适配器注册表。新增一家接口：在 llm/ 下加一个导出 Adapter 的文件，然后在 ADAPTERS 里加一行。
// ProviderKind 类型、面板里的“接口类型”下拉框都从这张表来，别处不用改。

import { anthropicMessages } from './anthropic-messages.ts'
import { LlmError } from './errors.ts'
import { openaiChat } from './openai-chat.ts'
import { withRetry } from './retry.ts'
import type { RetryOptions } from './retry.ts'
import type { LlmErrorKind } from './errors.ts'
import type { Adapter, AdapterOptionInfo, GenerateRequest, LlmClient, ProviderConfig, RemoteModel, UsageRecord } from './types.ts'
import { errorText } from '../util.ts'

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

export interface RemoteModelsResult {
  ok: boolean
  /** 成功时：接口说它有的模型，按名字排好。 */
  models?: RemoteModel[]
  /** 失败时：原因。unsupported 是这种接口类型根本没有“列出模型”这回事。 */
  error?: { kind: LlmErrorKind | 'unsupported' | 'unknown'; status?: number; message: string }
}

/**
 * 问一家接口它有哪些模型，给面板填模型名时挑。不重试；拉不到不算故障——照样可以手填模型名。
 * config.model 用不上，可以是空的。
 */
export async function listRemoteModels(config: ProviderConfig, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<RemoteModelsResult> {
  if (!isProviderKind(config.kind)) return { ok: false, error: { kind: 'bad_request', message: `unknown provider kind: ${String(config.kind)}` } }
  const adapter: Adapter = ADAPTERS[config.kind]
  if (!adapter.listModels) return { ok: false, error: { kind: 'unsupported', message: 'this kind of interface has no way to list its models' } }
  try {
    const models = await adapter.listModels(config, { ...(opts.fetch ? { fetch: opts.fetch } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })
    const unique = [...new Map(models.map((m) => [m.id, m])).values()].sort((a, b) => a.id.localeCompare(b.id))
    return { ok: true, models: unique }
  } catch (e) {
    if (e instanceof LlmError) {
      const error: NonNullable<RemoteModelsResult['error']> = { kind: e.kind, message: e.message }
      if (e.status !== undefined) error.status = e.status
      return { ok: false, error }
    }
    return { ok: false, error: { kind: 'unknown', message: errorText(e) } }
  }
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

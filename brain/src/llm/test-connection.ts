import { LlmError } from './errors.ts'
import type { LlmErrorKind } from './errors.ts'
import { textOf } from './messages.ts'
import { createClient } from './registry.ts'
import type { ProviderConfig, UsageRecord } from './types.ts'

export interface TestConnectionResult {
  ok: boolean
  durationMs: number
  /** 成功时：服务端报告的模型名和回复开头。 */
  model?: string
  reply?: string
  /** 失败时：原因。 */
  error?: { kind: LlmErrorKind | 'unknown'; status?: number; message: string }
}

/**
 * 发一个最小请求，给面板的“测试连接”按钮用。不重试。
 * 输出上限、extraBody 等都沿用这条配置自己的设置，这样测到的就是实际会用的参数组合。
 */
export async function testConnection(
  config: ProviderConfig,
  opts: { fetch?: typeof fetch; signal?: AbortSignal; onUsage?: (record: UsageRecord) => void } = {},
): Promise<TestConnectionResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  try {
    const client = createClient(config, {
      retry: false,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
    })
    const result = await client.generate({
      system: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: pong' }] }],
      tools: [],
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return {
      ok: true,
      durationMs: elapsed(),
      model: result.model,
      reply: textOf(result.message.content).slice(0, 200),
    }
  } catch (e) {
    if (e instanceof LlmError) {
      const error: NonNullable<TestConnectionResult['error']> = { kind: e.kind, message: e.message }
      if (e.status !== undefined) error.status = e.status
      return { ok: false, durationMs: elapsed(), error }
    }
    return {
      ok: false,
      durationMs: elapsed(),
      error: { kind: 'unknown', message: e instanceof Error ? e.message : String(e) },
    }
  }
}

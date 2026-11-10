import { LlmError } from './errors.ts'
import type { LlmErrorKind } from './errors.ts'
import { textOf } from './messages.ts'
import { createClient } from './registry.ts'
import type { ProviderConfig, UsageRecord, UserPart } from './types.ts'

/** 一张 32×32 的小图（白底，中间一个红方块，PNG）：测“这个模型收不收图”用。 */
const TEST_PICTURE = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAMUlEQVR4nGP4T2PAMGrBqAVD2II7cnIkoVELRi0YtWDUglELhqcF1AKjFoxaMAQsAABNEQ+XVFsaWwAAAABJRU5ErkJggg=='

export interface TestConnectionResult {
  ok: boolean
  durationMs: number
  /** 成功时：服务端报告的模型名和回复开头。 */
  model?: string
  reply?: string
  /** 这次测试带了一张小图（这个模型标着“能看图”）。接口不收图的话测试会失败，原因里是接口的原话。 */
  withPicture?: boolean
  /** 失败时：原因。 */
  error?: { kind: LlmErrorKind | 'unknown'; status?: number; message: string }
}

/**
 * 发一个最小请求，给面板的“测试连接”按钮用。不重试。
 * 输出上限、extraBody 等都沿用这条配置自己的设置，这样测到的就是实际会用的参数组合。
 * 配置里标着“能看图”时，请求里带一张很小的图：模型其实收不了图的话，这里就能发现，不用等到它干活时才出错。
 */
export async function testConnection(
  config: ProviderConfig,
  opts: { fetch?: typeof fetch; signal?: AbortSignal; onUsage?: (record: UsageRecord) => void } = {},
): Promise<TestConnectionResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  const picture = config.vision === true ? { withPicture: true } : {}
  const content: UserPart[] = [{ type: 'text', text: 'Reply with the single word: pong' }]
  if (config.vision === true) content.push({ type: 'image', image: { label: 'a small test picture', mediaType: 'image/png', data: TEST_PICTURE } })
  try {
    const client = createClient(config, {
      retry: false,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.onUsage ? { onUsage: opts.onUsage } : {}),
    })
    const result = await client.generate({
      system: '',
      messages: [{ role: 'user', content }],
      tools: [],
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return {
      ok: true,
      durationMs: elapsed(),
      model: result.model,
      reply: textOf(result.message.content).slice(0, 200),
      ...picture,
    }
  } catch (e) {
    if (e instanceof LlmError) {
      const error: NonNullable<TestConnectionResult['error']> = { kind: e.kind, message: e.message }
      if (e.status !== undefined) error.status = e.status
      return { ok: false, durationMs: elapsed(), error, ...picture }
    }
    return {
      ok: false,
      durationMs: elapsed(),
      error: { kind: 'unknown', message: e instanceof Error ? e.message : String(e) },
      ...picture,
    }
  }
}
